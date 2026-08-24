/** 意图识别：预筛（trigger_keywords）→ LLM 结构化输出 → 规则兜底
 * 
 */
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

import { cosineSimilarity } from "./cache.js";
import { config } from "./config.js";
import { embedText } from "./embedding.js";
import { usage } from "./usage.js";
import { logger } from "./log.js";
import { SkillRegistry } from "./registry.js";
import type { GenericState, IntentResult, Skill } from "../types/index.js";

const BUILTIN_INTENTS: Record<string, string> = {
  new_request: "用户提出全新的需求/请求",
  fallback: "无法匹配任何技能的输入（闲聊、无关话题）",
};

// 通用业务字段抽取（技能无关，LLM 统一输出这些字段名）：
// name=业务对象名（商品名/店铺名等）、price/stock/quantity=常见数值字段、
// action_detail=补充动作描述（如"下架""恢复上架"）
const IntentSchema = z.object({
  intent: z.string(),
  params: z.object({
    name: z.string().optional(),       // 业务对象名（定位用，如旧商品名）
    new_name: z.string().optional(),   // 改名目标（如"X名称改为Y"的 Y）
    price: z.number().optional(),
    stock: z.number().optional(),
    quantity: z.number().optional(),
    action_detail: z.string().optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
  }).default({}),
  needs_input: z.boolean().optional(),
  questions: z.array(z.string()).optional(),
});

const DEFAULT_SYSTEM = `你是对话意图识别器。基于用户输入与对话历史，判断用户意图。
可选意图：
{intents}
规则：
1. 若输入承接上文（如"换黑色的""那预算呢"），必须结合历史判断，不要当作孤立的新需求
2. 若信息不足以执行意图，needs_input=true 并给出最多 2 个追问问题（中文）
3. 无法匹配任何意图时用 fallback
params 里放该意图需要的结构化参数（由技能自行解析）。`;

export class IntentRecognizer {
  constructor(private registry: SkillRegistry) {}

  async recognize(state: GenericState, newText: string): Promise<IntentResult> {
    // 附件表格兜底：无文字描述但带了表格 → 按"批量处理表格"路由（表格内容驱动，不依赖描述）
    const query = newText.trim() || (state.table_text ? "批量处理表格商品" : "");
    const candidates = await this.coarseCandidates(state, query);
    if (candidates.size === 0) {
      return { intent: "fallback", params: {}, raw: "粗筛零命中：无候选技能" };
    }
    const intentsDesc = Object.entries({ ...BUILTIN_INTENTS, ...this.skillIntentDesc(candidates) })
      .map(([k, v]) => `- ${k}：${v}`)
      .join("\n");
    const history = state.messages.length
      ? state.messages.map((m) => `${m.type}: ${m.content}`).join("\n")
      : "（无）";
    const hasTable = Boolean(state.table_text);

    if (!config.dryRun && config.llmApiKey) {
      try {
        const model = new ChatOpenAI({
          model: config.llmModel,
          apiKey: config.llmApiKey,
          configuration: { baseURL: config.llmBaseUrl },
          callbacks: [{
            handleLLMEnd: (output) => {
              // 记录 LLM 调用 token（供用量统计与缓存成本估算）
              const tu = (output as { llmOutput?: { tokenUsage?: { promptTokens?: number; completionTokens?: number } } }).llmOutput?.tokenUsage;
              if (tu?.promptTokens) {
                usage.record("-", "-", tu.promptTokens, tu.completionTokens ?? 0);
              }
            },
          }],
        }).withStructuredOutput(IntentSchema, { method: "functionCalling" });
        const system = this.buildSystem(candidates, intentsDesc);
        const userContent = `对话历史：\n${history}\n\n用户输入：${query}` +
          (hasTable ? "\n（用户附带了表格数据，表格与文字描述是分开的两部分，表格内容由技能接收）" : "");
        const res = (await model.invoke([
          { role: "system", content: system },
          { role: "user", content: userContent },
        ])) as { intent: string; params?: Record<string, unknown> };
        return { intent: res.intent, params: res.params ?? {} };
      } catch (e) {
        logger.warn(`intent 识别失败，回退规则: ${String(e)}`);
      }
    }
    return this.ruleFallback(query);
  }

  /** 粗筛：trigger_keywords 命中 + 多轮承接 → 候选技能集 */
  /** 技能代表向量缓存：description + trigger_keywords 的 embedding（惰性） */
  private skillVectors = new Map<string, number[] | null>();

  async coarseCandidates(state: GenericState, newText: string): Promise<Set<string>> {
    const candidates = new Set<string>();
    const skills = this.registry.list();
    // ① 关键词命中（确定性，零成本）
    for (const skill of skills) {
      const kws = skill.manifest.trigger_keywords ?? [];
      if (kws.length === 0 || kws.some((kw) => newText.includes(kw))) {
        candidates.add(skill.manifest.id);
      }
    }
    // ② 关键词零命中 → embedding 召回兜底（语义相似，防漏）
    if (candidates.size === 0 && skills.length > 0) {
      const queryVec = await embedText(newText);
      if (queryVec) {
        for (const skill of skills) {
          const vec = await this.skillVector(skill);
          if (vec && cosineSimilarity(queryVec, vec) >= config.recallThreshold) {
            candidates.add(skill.manifest.id);
          }
        }
      }
    }
    // 多轮承接：上一轮技能（multi 模式）保留
    if (state.last_skill && !this.lastSkillIsSingle(state)) {
      candidates.add(state.last_skill);
    }
    return candidates;
  }

  /** 技能代表向量（缓存）：description + trigger_keywords 拼接 embedding */
  private async skillVector(skill: Skill): Promise<number[] | null> {
    if (this.skillVectors.has(skill.manifest.id)) {
      return this.skillVectors.get(skill.manifest.id) ?? null;
    }
    // 代表向量：意图描述（语义最丰富）优先，回落 description + keywords
    const intentDesc = Object.values(skill.manifest.intent_descriptions ?? {}).join(" ");
    const seed = intentDesc || [skill.manifest.description, ...(skill.manifest.trigger_keywords ?? [])].join(" ");
    const vec = await embedText(seed);
    this.skillVectors.set(skill.manifest.id, vec);
    return vec;
  }

  private skillIntentDesc(candidates: Set<string>): Record<string, string> {
    const desc: Record<string, string> = {};
    for (const skill of this.registry.list()) {
      if (!candidates.has(skill.manifest.id)) continue;
      const perIntent = skill.manifest.intent_descriptions ?? {};
      for (const intent of skill.manifest.intents) {
        desc[intent] = `${perIntent[intent] ?? skill.manifest.description}（技能 ${skill.manifest.id}）`;
      }
    }
    return desc;
  }

  private buildSystem(candidates: Set<string>, intentsDesc: string): string {
    const extra = this.registry
      .list()
      .filter((s) => candidates.has(s.manifest.id) && s.manifest.system_prompt)
      .map((s) => s.manifest.system_prompt)
      .join("\n");
    return (
      DEFAULT_SYSTEM.replace("{intents}", intentsDesc) +
      (extra ? `\n\n技能附加指令：\n${extra}` : "")
    );
  }

  private lastSkillIsSingle(state: GenericState): boolean {
    if (!state.last_skill) return false;
    const skill = this.registry
      .list()
      .find((s) => s.manifest.id === state.last_skill);
    return skill?.manifest.session_mode === "single";
  }

  private ruleFallback(newText: string): IntentResult {
    const text = (newText || "").trim();
    if (!text) return { intent: "fallback", params: {}, raw: "规则兜底：空输入" };
    return { intent: "new_request", params: {}, raw: "规则兜底：默认新需求" };
  }
}
