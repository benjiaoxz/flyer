/**
 * catalog 技能：商家商品管理（上架/查询/改价/下架）
 *
 * 对接业务系统商品 API：X-Biz-Key（服务间鉴权）+ 透传用户 JWT（身份验证）。
 * 领域执行（业务 API 调用）在本技能；harness 负责路由/鉴权/反馈。
 */
import { config } from "../../core/config.js";
import { logger } from "../../core/log.js";
import type { GenericState, IntentResult, Skill, SkillManifest, SkillResult } from "../../types/index.js";

// ---------------------------------------------------------------- 业务 API 客户端
/** 调业务系统 API：X-Biz-Key + 透传用户 JWT */
async function callBizApi<T>(
  path: string,
  method: "GET" | "POST" | "PATCH",
  token: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${config.bizBaseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Biz-Key": config.bizApiKey,
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { detail?: string };
  if (!res.ok) {
    throw new Error(data.detail ?? `业务系统错误 ${res.status}`);
  }
  return data as T;
}

interface Product {
  id: number;
  shop_id: number;
  name: string;
  price: number;
  stock: number;
  status: string;
}

interface ProductCreate {
  shop_id: number;
  name: string;
  price: number;
  stock: number;
  description?: string;
}

// ---------------------------------------------------------------- 技能
const manifest: SkillManifest = {
  id: "catalog",
  name: "商品管理",
  description: "商家上架/查询/修改/下架商品（对接业务系统）",
  intents: ["new_request", "catalog_add", "catalog_add_batch", "catalog_query", "catalog_update", "catalog_off"],
  intent_descriptions: {
    catalog_add: "上架商品（用户说上架X时用；含创建或恢复）",
    catalog_add_batch: "批量上架商品（用户提供 Excel 文件或 CSV/表格文本，含多行商品数据，用于新增/上架商品）",
    catalog_query: "查询/查看商品信息（用户说'给我X信息''查X''看X''X的价格库存状态'时用——只读不改）",
    catalog_update: "修改/调整商品价格或库存（用户明确说改/调/修改时才用；含批量场景：'批量调整价格''批量改库存''用刚才的表格批量调整'；仅查信息不是修改）",
    catalog_off: "下架商品（用户说下架/删除X时用）",
  },
  cacheable_intents: ["catalog_query"],  // 写操作（上架/改/下架）不缓存
  trigger_keywords: ["上架", "商品", "下架", "改价", "库存", "价格", "信息", "详情", "查询", "查看", "给我", "名称", "改名", "修改", "调整", "批量", "Excel", "excel", "表格", "CSV", "csv"],
  session_mode: "single",
  max_turns_per_session: 1,
  auto_keywords: true,
  max_llm_calls_per_turn: 2,
  data_scopes: ["shop"],
};

/** 解析商品字段（按操作类型限定，避免误抓）
 * - off（下架）：只解析名称，剔除操作词
 * - add（上架）：名称 + 价格（需货币词）+ 库存
 * - update（改）：名称 + 价格/库存（价格需"价格/改为/元"等确认，防裸数字误抓）
 * - query（查询）：不解析
 */
function parseProduct(text: string, action: string): { name?: string; new_name?: string; price?: number; stock?: number } {
  const out: { name?: string; new_name?: string; price?: number; stock?: number } = {};
  // 引号包裹的名称（最明确）；清洗引号字符
  const quoted = text.match(/["'「」《](.+?)["'」》]/);
  if (quoted) {
    out.name = quoted[1].trim();
  } else if (action !== "query") {
    // 无引号：剔除操作指令词，取剩余部分的首个连续词作为名称
    const ops = action === "off"
      ? ["下架", "删除", "停用", "移除", "帮我", "请帮我", "把", "将", "的", "状态"]
      : action === "update"
        ? ["价格", "库存", "数量", "改为", "改成", "调成", "设为", "为", "到", "帮我", "请帮我", "把", "将", "的"]
        : action === "query"
          ? ["所有", "全部", "信息", "价格", "库存", "数量", "状态", "的", "给我", "查", "看", "资料", "详情"]
          : ["上架", "库存", "价格", "元", "块", "帮我", "请帮我", "把", "将", "的"];
    let cleaned = text;
    for (const op of ops) cleaned = cleaned.split(op).join(" ");
    const firstWord = cleaned.match(/[\u4e00-\u9fa5A-Za-z0-9]+/);
    out.name = (firstWord?.[0] ?? "").trim() || undefined;
  }
  if (action === "update" || action === "add") {
    // 价格：仅价格专属词确认（价格/单价/售价/定价/元/块），
    // 不用通用"改为/为"——否则"库存改成77"的 77 会被误当价格
    const priceMatch = text.match(
      /(?:价格|单价|售价|定价)(?:改为|改成|调成|设为|调整为|为|到)?\s*(\d+(?:\.\d+)?)\s*(?:元|块)?/,
    ) ?? text.match(/(\d+(?:\.\d+)?)\s*(?:元|块)/);
    if (priceMatch) out.price = Number(priceMatch[1]);
    // 库存：仅"库存/数量"词确认
    const stockMatch = text.match(/(?:库存|数量)(?:\s*|改成|改为|调成|设为|变成|调整为|为|到)\s*(\d+)/);
    if (stockMatch) out.stock = Number(stockMatch[1]);
  }
  // 改名目标："X名称改为Y" / "X改名为Y" / "重命名X为Y" → Y（引号或自然文本）
  const renameMatch = text.match(/(?:名称|名字|改名|重命名)(?:改为|改成|为|成|叫)?\s*["'「」《]?([^"'「」》\s，。,]+)["'「」》]?/);
  if (renameMatch && action === "update") out.new_name = renameMatch[1].trim();
  return out;
}

/** 解析批量商品数据：读上传文件（Excel）或解析粘贴文本（CSV）→ items */
/** 单元格数值：空/非法 → undefined；0 是合法值（不能当缺值） */
function cellNum(v: string | undefined): number | undefined {
  if (v === undefined || String(v).trim() === "") return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

/** 表格"状态"列 → 业务状态（上架/在售 → on_sale；下架/停售 → off_sale） */
function statusFromCell(v: string | undefined): string | undefined {
  if (!v) return undefined;
  if (/上架|在售|on\s*sale/i.test(v)) return "on_sale";
  if (/下架|停售|off\s*sale/i.test(v)) return "off_sale";
  return undefined;
}

async function parseBatchItems(
  newText: string,
  tableText: string,
  userId: string,
): Promise<{ items: Array<{ name?: string; price?: number; stock?: number; status?: string }>; error?: string }> {
  const { parseCsvText, parseExcelFile } = await import("../../tools/excel.js");
  try {
    let parsed: Awaited<ReturnType<typeof parseCsvText>>;
    if (/表格|文件|excel|xlsx|上传/i.test(newText) && !tableText.includes(",")) {
      // 读上传文件
      const { getLatestUpload, readUploadFile } = await import("../../api/server.js");
      const fileId = getLatestUpload(userId);
      const buf = fileId ? readUploadFile(fileId) : null;
      if (!buf) return { items: [], error: "未找到上传的文件（请先在页面上传 Excel）" };
      parsed = parseExcelFile(buf);
    } else {
      // 解析粘贴文本
      parsed = parseCsvText(tableText);
      if (!parsed.rows.length && tableText !== newText) {
        parsed = parseCsvText(newText);
      }
    }
    if (!parsed.rows.length) return { items: [], error: "未解析到商品数据（需要表格：名称,价格,库存 每行一个）" };
    const items = parsed.rows.map((r) => {
      const keys = Object.keys(r);
      const nameKey = keys.find((k) => /名称|商品|name/i.test(k)) ?? keys[0];
      const priceKey = keys.find((k) => /价格|单价|price/i.test(k));
      const stockKey = keys.find((k) => /库存|数量|stock/i.test(k));
      const statusKey = keys.find((k) => /状态|status/i.test(k));
      return {
        name: r[nameKey] || undefined,
        price: priceKey ? cellNum(r[priceKey]) : undefined,
        stock: stockKey ? cellNum(r[stockKey]) : undefined,
        status: statusKey ? statusFromCell(r[statusKey]) : undefined,
      };
    });
    return { items };
  } catch (e) {
    return { items: [], error: `批量数据解析失败：${(e as Error).message}` };
  }
}

/** 批量更新商品（"用刚才的表格批量调整价格/库存/改名"）：
 * 读上传文件或粘贴 CSV，逐行按名称定位商品，只更新表格中出现的列（价格/库存），
 * 不强制改状态（表格驱动调整语义，避免把下架商品意外上架） */
async function batchUpdateProducts(
  token: string,
  shopId: number,
  newText: string,
  intent: IntentResult,
  state: GenericState,
): Promise<SkillResult> {
  const extra = (intent.params?.extra ?? {}) as Record<string, unknown>;
  const tableText = state.table_text   // 网关打包注入的表格（文件+文字一次提交）优先
    || ((extra.table as string | undefined)
      ?? (intent.params?.action_detail as string | undefined)
      ?? newText);
  const { items, error } = await parseBatchItems(
    newText,
    tableText,
    String(state.user_ctx?.user_id ?? ""),
  );
  if (error) {
    return { status: "error", output: error, reason: "解析失败", data: {} };
  }
  // 列护栏：用户明确说要改的字段，表格缺该列 → 报错而非改错列
  const detail = `${(intent.params?.action_detail as string | undefined) ?? ""} ${newText}`;
  const wantsStock = /库存|数量/.test(detail);
  const wantsPrice = /价格|单价|售价|定价/.test(detail);
  const hasPriceCol = items.some((i) => i.price !== undefined);
  const hasStockCol = items.some((i) => i.stock !== undefined);
  if (wantsStock && !hasStockCol) {
    return { status: "error", output: "表格中没有库存列——请确认表格列（名称/价格/库存）与要改的字段一致", reason: "列不匹配", data: {} };
  }
  if (wantsPrice && !hasPriceCol) {
    return { status: "error", output: "表格中没有价格列——请确认表格列（名称/价格/库存）与要改的字段一致", reason: "列不匹配", data: {} };
  }
  // 描述条件与表格一致性：预期数量校验 + 行级过滤（价格/库存/排除），不满足的行跳过
  const filters = (intent.params?.filters as RowFilters | undefined) ?? undefined;
  const countErr = checkExpectedCount(filters?.expected_count, items);
  if (countErr) {
    return { status: "error", output: countErr, reason: "数量不一致", data: {} };
  }
  const { kept, skipped } = applyRowFilters(items, filters);
  const failed: Array<{ name: string; reason: string }> = skipped.map((s) => ({ name: s.name, reason: `跳过: ${s.reason}` }));
  if (!kept.length) {
    return { status: "error", output: `没有符合条件的商品行（${skipped.length} 行被条件过滤）`, reason: "无符合行", data: { skipped_count: skipped.length } };
  }
  const products = await callBizApi<Product[]>("/api/products", "GET", token);
  const success: string[] = [];
  for (const item of kept) {
    if (!item.name) {
      failed.push({ name: "(无名)", reason: "缺名称" });
      continue;
    }
    // 只更新表格中实际出现的列（价格/库存）；无更新目标的行跳过
    const patch: Record<string, unknown> = {};
    if (item.price !== undefined) patch.price = item.price;
    if (item.stock !== undefined) patch.stock = item.stock;
    if (!Object.keys(patch).length) {
      failed.push({ name: item.name, reason: "该行没有价格/库存更新列" });
      continue;
    }
    // 按名称定位商品：精确匹配优先，退而求其次 includes（避免"调试鞋"误匹配"调试鞋2"）
    const target = products.find((p) => p.name === item.name)
      ?? products.find((p) => item.name && p.name.includes(item.name));
    if (!target) {
      failed.push({ name: item.name, reason: "未找到该商品" });
      continue;
    }
    if (filters?.status && target.status !== filters.status) {
      failed.push({ name: item.name, reason: `跳过: 状态${target.status}不符合条件${filters.status}` });
      continue;
    }
    try {
      await callBizApi<Product>(`/api/products/${target.id}`, "PATCH", token, patch);
      success.push(item.name);
    } catch (e) {
      failed.push({ name: item.name, reason: (e as Error).message });
    }
  }
  // 跳过（条件过滤）≠ 失败：只按真失败定 status
  const skippedRows = failed.filter((f) => f.reason.startsWith("跳过:"));
  const realFailed = failed.filter((f) => !f.reason.startsWith("跳过:"));
  return {
    status: realFailed.length ? "error" : "success",
    output: `✏️ 批量更新完成：成功 ${success.length} 条${skippedRows.length ? `，跳过 ${skippedRows.length} 条（${skippedRows.map((f) => `${f.name}:${f.reason.slice("跳过: ".length)}`).join("；")}）` : ""}${realFailed.length ? `，失败 ${realFailed.length} 条（${realFailed.map((f) => `${f.name}:${f.reason}`).join("；")}）` : ""}`,
    reason: realFailed.length ? `部分失败: ${realFailed.map((f) => f.name).join("、")}` : "",
    data: { success_count: success.length, failed_count: realFailed.length, skipped_count: skippedRows.length },
  };
}

/** 描述中的筛选/校验条件（LLM 从文字抽取，代码确定性应用） */
interface RowFilters {
  price_min?: number;
  price_max?: number;
  stock_min?: number;
  stock_max?: number;
  status?: string;
  exclude?: string[];
  expected_count?: number;
}

/** 批量数据行（解析自表格：名称/价格/库存/状态列） */
interface BatchItem {
  name?: string;
  price?: number;
  stock?: number;
  status?: string;
}

/** 行级条件过滤：描述条件（价格/库存上下限、排除名单）与表格行校验，不满足的行跳过 */
function applyRowFilters(
  items: BatchItem[],
  filters: RowFilters | undefined,
): { kept: BatchItem[]; skipped: Array<{ name: string; reason: string }> } {
  if (!filters) return { kept: items, skipped: [] };
  const kept: BatchItem[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const item of items) {
    const reasons: string[] = [];
    const label = item.name ?? "(无名)";
    if (filters.exclude?.length && item.name && filters.exclude.includes(item.name)) {
      reasons.push("在排除名单中");
    }
    if (filters.price_min != null && item.price !== undefined && item.price < filters.price_min) {
      reasons.push(`价格${item.price}低于下限${filters.price_min}`);
    }
    if (filters.price_max != null && item.price !== undefined && item.price > filters.price_max) {
      reasons.push(`价格${item.price}高于上限${filters.price_max}`);
    }
    if (filters.stock_min != null && item.stock !== undefined && item.stock < filters.stock_min) {
      reasons.push(`库存${item.stock}低于下限${filters.stock_min}`);
    }
    if (filters.stock_max != null && item.stock !== undefined && item.stock > filters.stock_max) {
      reasons.push(`库存${item.stock}高于上限${filters.stock_max}`);
    }
    if (reasons.length) skipped.push({ name: label, reason: reasons.join("；") });
    else kept.push(item);
  }
  return { kept, skipped };
}

/** 描述与表格数量一致性校验："这N个商品" 但表格行数不符 → 返回错误文案 */
function checkExpectedCount(expected: number | undefined, items: unknown[]): string | null {
  if (expected == null) return null;
  if (items.length !== expected) {
    return `你说的是 ${expected} 个商品，但表格里有 ${items.length} 行——数量不一致，请核对后再操作`;
  }
  return null;
}

const skill: Skill = {
  manifest,
  async handle(state: GenericState, intent: IntentResult, newText: string): Promise<SkillResult> {
    // JWT 用户上下文（业务系统验证身份；无 token 拒绝）
    const token = state.user_ctx?.token;
    const shopId = state.user_ctx?.shop_id;
    if (!token || !shopId) {
      return {
        status: "error",
        output: "需要业务系统登录态（JWT）才能操作商品",
        reason: "缺少用户 token/shop_id",
        data: {},
      };
    }

    try {
      // 动作解析：显式意图优先；new_request（规则兜底）按文本猜测
      let action = intent.intent.replace("catalog_", "");
      if (action === "new_request") {
        if (newText.includes("上架")) action = "add";
        else if (newText.includes("下架")) action = "off";
        else if (newText.includes("改") || newText.includes("价格")) action = "update";
        else if (newText.includes("查") || newText.includes("看")) action = "query";
        else action = "add";
      }
      // 意图护栏：LLM 偶尔把"表格批量调整价格/库存"误判为 add_batch；
      // 文本同时含改价动词+价格/库存字段时，确定性改回 update（批量上架不受影响）
      if (action === "add_batch"
        && /调整|修改|调价|降价|涨价|改成|改为|调成|变|改/.test(newText)
        && /价格|单价|售价|库存|数量|定价/.test(newText)) {
        action = "update";
      }
      // 字段来源：LLM params 优先（语义抽取），正则 parseProduct 兜底（无 LLM/漏抽时）
      const regex = parseProduct(newText, action);
      const p = intent.params ?? {};
      const product = {
        name: (p.name as string | undefined) ?? regex.name,
        new_name: (p.new_name as string | undefined) ?? regex.new_name,
        price: (p.price as number | undefined) ?? regex.price,
        stock: (p.stock as number | undefined) ?? regex.stock,
      };

      switch (action) {
        case "add_batch": {
          // 批量上架：从文本提取表格数据（CSV/表格），逐条复用 add 逻辑
          const extra = (intent.params?.extra ?? {}) as Record<string, unknown>;
          const tableText = state.table_text   // 网关打包注入的表格（文件+文字一次提交）优先
            || ((extra.table as string | undefined)
              ?? (intent.params?.action_detail as string | undefined)
              ?? newText);
          const { items, error } = await parseBatchItems(
            newText,
            tableText,
            String(state.user_ctx?.user_id ?? ""),
          );
          if (error) {
            return { status: "error", output: error, reason: "解析失败", data: {} };
          }
          // 是否明确"上架"意图（决定已存在商品是否恢复上架；表格驱动调整时不强制改状态）
          const restoreOnSale = /上架|恢复|重新上架/.test(newText);
          // 描述条件与表格一致性：预期数量校验 + 行级过滤（价格/库存/排除），不满足的行跳过
          const filters = (intent.params?.filters as RowFilters | undefined) ?? undefined;
          const countErr = checkExpectedCount(filters?.expected_count, items);
          if (countErr) {
            return { status: "error", output: countErr, reason: "数量不一致", data: {} };
          }
          const { kept, skipped } = applyRowFilters(items, filters);
          const failed: Array<{ name: string; reason: string }> = skipped.map((s) => ({ name: s.name, reason: `跳过: ${s.reason}` }));
          if (!kept.length) {
            return { status: "error", output: `没有符合条件的商品行（${skipped.length} 行被条件过滤）`, reason: "无符合行", data: { skipped_count: skipped.length } };
          }
          // 逐条上架（复用 add 逻辑，同名恢复/创建）
          const success: string[] = [];
          const existing = await callBizApi<Product[]>("/api/products", "GET", token);
          for (const item of kept) {
            if (!item.name || item.price === undefined) {
              failed.push({ name: item.name ?? "(无名)", reason: "缺名称或价格" });
              continue;
            }
            try {
              const target = existing.find((x) => x.name === item.name);
              if (filters?.status && target && target.status !== filters.status) {
                failed.push({ name: item.name, reason: `跳过: 状态${target.status}不符合条件${filters.status}` });
                continue;
              }
              if (target) {
                // 已存在：更新表格列；状态列（行级，优先）或明确"上架"驱动状态变更
                const patch: Record<string, unknown> = {};
                if (item.price !== undefined) patch.price = item.price;
                if (item.stock !== undefined) patch.stock = item.stock;
                if (item.status === "on_sale") patch.status = "on_sale";
                else if (item.status === "off_sale") patch.status = "off_sale";
                else if (restoreOnSale) patch.status = "on_sale";
                await callBizApi<Product>(`/api/products/${target.id}`, "PATCH", token, patch);
                success.push(item.name);
              } else {
                await callBizApi<Product>("/api/products", "POST", token,
                  { shop_id: shopId, name: item.name, price: item.price, stock: item.stock ?? 0, status: item.status === "off_sale" ? "off_sale" : "on_sale" });
                success.push(item.name);
              }
            } catch (e) {
              failed.push({ name: item.name, reason: (e as Error).message });
            }
          }
          // 跳过（条件过滤）≠ 失败：只按真失败定 status
          const skippedRows = failed.filter((f) => f.reason.startsWith("跳过:"));
          const realFailed = failed.filter((f) => !f.reason.startsWith("跳过:"));
          return {
            status: realFailed.length ? "error" : "success",
            output: `📊 批量上架完成：成功 ${success.length} 条${skippedRows.length ? `，跳过 ${skippedRows.length} 条（${skippedRows.map((f) => `${f.name}:${f.reason.slice("跳过: ".length)}`).join("；")}）` : ""}${realFailed.length ? `，失败 ${realFailed.length} 条（${realFailed.map((f) => `${f.name}:${f.reason}`).join("；")}）` : ""}`,
            reason: realFailed.length ? `部分失败: ${realFailed.map((f) => f.name).join("、")}` : "",
            data: { success_count: success.length, failed_count: realFailed.length, skipped_count: skippedRows.length },
          };
        }
        case "add": {
          if (!product.name) {
            return {
              status: "error",
              output: "上架需要商品名（如：上架\"Nike 鞋\" 299元 库存50）",
              reason: "缺少商品名",
              data: {},
            };
          }
          // 上架语义：同名商品已存在（如之前下架的）→ 恢复上架状态；不存在 → 创建新商品
          const existing = await callBizApi<Product[]>("/api/products", "GET", token);
          const target = existing.find((p) => p.name === product.name);
          if (target) {
            const restored = await callBizApi<Product>(
              `/api/products/${target.id}`,
              "PATCH",
              token,
              { status: "on_sale", ...(product.price ? { price: product.price } : {}), ...(product.stock !== undefined ? { stock: product.stock } : {}) },
            );
            return {
              status: "success",
              output: `✅ 已上架商品：${restored.name}（${restored.price}元，库存${restored.stock}，id=${restored.id}）`,
              data: { product_id: restored.id },
            };
          }
          if (!product.price) {
            return {
              status: "error",
              output: "新商品上架需要价格（如：上架\"Nike 鞋\" 299元 库存50）",
              reason: "缺少商品价格",
              data: {},
            };
          }
          const created = await callBizApi<Product>(
            "/api/products",
            "POST",
            token,
            { shop_id: shopId, name: product.name, price: product.price, stock: product.stock ?? 0, status: "on_sale" },
          );
          return {
            status: "success",
            output: `✅ 已上架商品：${created.name}（${created.price}元，库存${created.stock}，id=${created.id}）`,
            data: { product_id: created.id },
          };
        }
        case "query": {
          const products = await callBizApi<Product[]>("/api/products", "GET", token);
          if (!products.length) {
            return { status: "success", output: "暂无商品", data: {} };
          }
          // 指定了商品名 → 查单个商品；否则查全部
          if (product.name) {
            const target = products.find((p) => p.name === product.name)
              ?? products.find((p) => p.name.includes(product.name!));
            if (!target) {
              return { status: "error", output: `未找到商品「${product.name}」`, reason: "商品不存在", data: {} };
            }
            return {
              status: "success",
              output: `📦 ${target.name}：${target.price}元，库存${target.stock}，状态${target.status}（id=${target.id}）`,
              data: { product_id: target.id },
            };
          }
          const lines = products.map(
            (p) => `${p.name}（${p.price}元，库存${p.stock}，${p.status}）`,
          );
          return { status: "success", output: `📦 商品列表：\n${lines.join("\n")}`, data: { count: products.length } };
        }
        case "update": {
          // 批量更新（"用刚才的表格批量调整价格/库存"）→ 读上传文件逐条改；
          // 有表格附件（state.table_text）即按批量处理（网关一次打包场景）
          const isBatchUpdate = Boolean(state.table_text)
            || (intent.params?.action_detail as string | undefined)?.includes("批量")
            || /批量|表格|文件|excel|xlsx|上传/i.test(newText);
          if (isBatchUpdate) {
            return await batchUpdateProducts(token, shopId, newText, intent, state);
          }
          // 支持改名/改价/改库存任意组合；至少有一个更新目标才执行
          const hasUpdate = product.new_name !== undefined || product.price !== undefined || product.stock !== undefined;
          if (!product.name || !hasUpdate) {
            return {
              status: "error",
              output: "修改需要指定商品名和要改的内容（如：改\"Nike 鞋\"价格 259元 / 名称改为X / 库存改N）",
              reason: "缺少商品名或更新内容",
              data: {},
            };
          }
          const products = await callBizApi<Product[]>("/api/products", "GET", token);
          // 名称精确匹配优先，退而求其次 includes（避免"调试鞋"误匹配"调试鞋2"）
          const target = products.find((p) => p.name === product.name)
            ?? products.find((p) => p.name.includes(product.name!));
          if (!target) {
            return { status: "error", output: `未找到商品「${product.name}」`, reason: "商品不存在", data: {} };
          }
          // 部分更新：只传用户指定的字段（改名/改价/改库存任意组合）
          const patch: Record<string, unknown> = { status: "on_sale" };
          if (product.new_name !== undefined) patch.name = product.new_name;
          if (product.price !== undefined) patch.price = product.price;
          if (product.stock !== undefined) patch.stock = product.stock;
          const updated = await callBizApi<Product>(
            `/api/products/${target.id}`,
            "PATCH",
            token,
            patch,
          );
          return {
            status: "success",
            output: `✏️ 已更新「${updated.name}」：${updated.price}元，库存${updated.stock}`,
            data: { product_id: updated.id },
          };
        }
        case "off": {
          if (!product.name) {
            return { status: "error", output: "下架需要商品名（如：下架\"Nike 鞋\"）", reason: "缺少商品名", data: {} };
          }
          const products = await callBizApi<Product[]>("/api/products", "GET", token);
          const target = products.find((p) => p.name.includes(product.name!));
          if (!target) {
            return { status: "error", output: `未找到商品「${product.name}」`, reason: "商品不存在", data: {} };
          }
          const updated = await callBizApi<Product>(
            `/api/products/${target.id}`,
            "PATCH",
            token,
            { status: "off_sale" },
          );
          return { status: "success", output: `🛑 已下架「${updated.name}」`, data: { product_id: updated.id } };
        }
        default:
          return { status: "error", output: `未知操作: ${action}`, reason: "未知意图", data: {} };
      }
    } catch (e) {
      logger.warn(`catalog 执行失败: ${String(e)}`);
      return {
        status: "error",
        output: `商品操作失败：${(e as Error).message}`,
        reason: (e as Error).message,
        data: {},
      };
    }
  },
  /** P2 结果验证：上架/改价/下架后回读业务系统确认落库（执行后自证） */
  async verify(state: GenericState, result: SkillResult, newText: string): Promise<boolean> {
    // 查询类无需验证（只读）；验证写操作是否真实生效
    if (!result.data?.product_id) return true;
    const token = state.user_ctx?.token;
    if (!token) return false;
    try {
      const p = await callBizApi<Product>(
        `/api/products/${result.data.product_id}`,
        "GET",
        token,
      );
      // 回读确认：商品存在 + 关键字段与写入一致（上架=存在；改价=价格一致；下架=状态 off_sale）
      if (newText.includes("下架")) return p.status === "off_sale";
      if (newText.includes("改") || newText.includes("价格")) {
        const price = newText.match(/(\d+(?:\.\d+)?)\s*(?:元|块)/);
        return price ? Math.abs(p.price - Number(price[1])) < 0.01 : true;
      }
      return p.id === Number(result.data.product_id);
    } catch (e) {
      logger.warn(`catalog 回读验证失败: ${String(e)}`);
      return false;
    }
  },
};

export default skill;
