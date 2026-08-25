/**
 * report 技能：运营数据问答（ChatBI）
 *
 * 职责链（确定性归确定性）：
 * 1. LLM（网关意图层）抽结构化参数：dataset / group_by / metric / chart_type / summary
 * 2. 本技能确定性校验参数 + 图表类型-数据形态匹配
 * 3. 调业务系统 /api/stats（SQL 聚合）→ 只拿聚合结果（数据不经过网关）
 * 4. 生成 charts 数组（{title, type, series}）→ 前端渲染看板；报告模式追加 LLM 总结文字
 *
 * 不做 UI：ECharts option/颜色/布局归前端模板；网关只给数据+图表意图。
 */
import { config } from "../../core/config.js";
import { logger } from "../../core/log.js";
import type { GenericState, IntentResult, Skill, SkillManifest, SkillResult } from "../../types/index.js";

// ---------------------------------------------------------------- 常量（确定性边界）
const DATASET_GROUPS: Record<string, string[]> = {
  products: ["status", "name"],
  orders: ["status", "month", "product"],
};
const METRICS = ["count", "price", "stock", "amount", "quantity"];
const CHART_TYPES = ["bar", "pie", "line"];

const DATASET_LABEL: Record<string, string> = { products: "商品", orders: "订单" };
const GROUP_LABEL: Record<string, string> = { status: "状态分布", name: "对比", month: "月度趋势", product: "商品排行" };
const METRIC_LABEL: Record<string, string> = { count: "数量", price: "价格", stock: "库存", amount: "金额", quantity: "销量" };

interface StatsRow {
  label: string;
  value: number;
}

const manifest: SkillManifest = {
  id: "report",
  name: "数据看板",
  description: "运营数据问答：按描述取数生成图表看板/报告（对接业务系统统计）",
  intents: ["report_chart", "report_summary"],
  intent_descriptions: {
    report_chart: "生成图表看板（用户说'看看X对比/分布/排行/趋势'时用——只读查询并生成图表）",
    report_summary: "生成数据报告（用户说'总结一下''报告一下''这周怎么样'时用——总结文字+图表）",
  },
  cacheable_intents: [],  // 报表数据动态，不进语义缓存（缓存会返回过期报表）
  trigger_keywords: ["图表", "看板", "对比", "分布", "排行", "趋势", "统计", "报表", "报告", "汇总", "总结", "占比", "销量", "销售额", "走势", "比例", "订单", "情况"],
  system_prompt: `当识别 report 技能意图时，用 params.extra 输出结构化参数：
{ "dataset": "products|orders", "group_by": "status|name|month|product",
  "metric": "count|price|stock|amount|quantity", "chart_type": "bar|pie|line",
  "summary": true/false }
推断规则：
- 占比/比例/构成 → chart_type=pie；趋势/走势/每月/变化 → chart_type=line 且 group_by=month；对比/排行/分布 → bar
- dataset 缺省 orders；group_by 缺省按数据集（products→name，orders→status）
- 报告模式（report_summary 或"总结/报告"语气）summary=true`,
  session_mode: "single",
  max_turns_per_session: 1,
  max_llm_calls_per_turn: 2,
  data_scopes: ["shop"],
};

// ---------------------------------------------------------------- 取数（业务侧 SQL 聚合）
async function fetchStats(token: string, dataset: string, group: string, metric: string, limit: number): Promise<StatsRow[]> {
  const url = `${config.bizBaseUrl}/api/stats?dataset=${dataset}&group=${group}&metric=${metric}&limit=${limit}`;
  const res = await fetch(url, {
    headers: {
      "X-Biz-Key": config.bizApiKey,
      Authorization: `Bearer ${token}`,
    },
  });
  const data = (await res.json().catch(() => ({}))) as { detail?: string; rows?: StatsRow[] };
  if (!res.ok) throw new Error(data.detail ?? `业务系统错误 ${res.status}`);
  return data.rows ?? [];
}

// ---------------------------------------------------------------- 报告模式：总结文字（LLM 第二次调用）
async function genSummary(newText: string, charts: unknown[]): Promise<string | null> {
  if (config.dryRun || !config.llmApiKey) return null;  // 无 LLM（测试/降级）返回 null
  const { ChatOpenAI } = await import("@langchain/openai");
  const { z } = await import("zod");
  try {
    const model = new ChatOpenAI({
      model: config.llmModel,
      apiKey: config.llmApiKey,
      configuration: { baseURL: config.llmBaseUrl },
    }).withStructuredOutput(z.object({ summary: z.string() }), { method: "functionCalling" });
    const res = (await model.invoke([
      {
        role: "system",
        content: "你是电商运营数据分析师。基于图表数据写一段简洁的中文总结（3-5 句），指出关键发现（最高/最低/异常/趋势），不用重复列出全部数字。",
      },
      {
        role: "user",
        content: `用户问题：${newText}\n图表数据：${JSON.stringify(charts)}`,
      },
    ])) as { summary?: string };
    return res.summary?.trim() || null;
  } catch (e) {
    logger.warn(`report 总结生成失败: ${String(e)}`);
    return null;
  }
}

// ---------------------------------------------------------------- 技能
const skill: Skill = {
  manifest,
  async handle(state: GenericState, intent: IntentResult, newText: string): Promise<SkillResult> {
    const token = state.user_ctx?.token;
    const shopId = state.user_ctx?.shop_id;
    if (!token || !shopId) {
      return { status: "error", output: "需要业务系统登录态（JWT）才能查询数据", reason: "缺少用户 token/shop_id", data: {} };
    }

    // LLM 抽取（params.extra 结构化），代码确定性校验兜底
    const extra = (intent.params?.extra ?? {}) as Record<string, unknown>;
    const dataset = extra.dataset === "products" ? "products" : "orders";
    const allowedGroups = DATASET_GROUPS[dataset];
    const rawGroup = String(extra.group_by ?? (dataset === "products" ? "name" : "status"));
    const group = allowedGroups.includes(rawGroup) ? rawGroup : allowedGroups[0];
    const rawMetric = String(extra.metric ?? "count");
    const metric = METRICS.includes(rawMetric) ? rawMetric : "count";
    let chartType = String(extra.chart_type ?? "bar");
    if (!CHART_TYPES.includes(chartType)) chartType = "bar";
    const wantSummary = intent.intent === "report_summary" || extra.summary === true;

    // 图表类型-数据形态匹配（确定性）：折线需要时间轴；月份不适合饼图
    if (chartType === "line" && group !== "month") chartType = "bar";
    if (chartType === "pie" && group === "month") chartType = "bar";

    // 取数（业务侧 SQL 聚合，网关只拿聚合结果）
    const rows = await fetchStats(token, dataset, group, metric, 10);
    if (!rows.length) {
      return {
        status: "error",
        output: `该维度暂无数据（${DATASET_LABEL[dataset]} × ${GROUP_LABEL[group]} × ${METRIC_LABEL[metric]}）`,
        reason: "无数据",
        data: {},
      };
    }

    // 图表数据（前端按 type 套模板渲染，网关不做 UI）
    const title = `${DATASET_LABEL[dataset]}${GROUP_LABEL[group]}（${METRIC_LABEL[metric]}）${rows.length >= 10 ? "· 前10" : ""}`;
    const charts = [{ title, type: chartType, series: rows.map((r) => ({ name: r.label, value: r.value })) }];

    // 报告模式：总结文字
    const summary = wantSummary ? await genSummary(newText, charts) : null;

    return {
      status: "success",
      output: summary ? `📝 ${summary}` : `📊 已生成图表：${title}`,
      data: { charts, ...(summary ? { summary } : {}) },
    };
  },
};

export default skill;
