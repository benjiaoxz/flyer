/** 意图识别：预筛（trigger_keywords）→ LLM 结构化输出 → 规则兜底
 * 
 */
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

import { config } from "./config.js";
import { logger } from "./log.js";
import { SkillRegistry } from "./registry.js";
import type { GenericState, IntentResult } from "../types/index.js";

const BUILTIN_INTENTS: Record<string, string> = {
  new_request: "用户提出全新的需求/请求",
  fallback: "无法匹配任何技能的输入（闲聊、无关话题）",
};

const IntentSchema = z.object({
  intent: z.string(),
  params: z.record(z.string(), z.unknown()).default({}),
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
    const candidates = this.coarseCandidates(state, newText);
    if (candidates.size === 0) {
      return { intent: "fallback", params: {}, raw: "粗筛零命中：无候选技能" };
    }
    const intentsDesc = Object.entries({ ...BUILTIN_INTENTS, ...this.skillIntentDesc(candidates) })
      .map(([k, v]) => `- ${k}：${v}`)
      .join("\n");
    const history = state.messages.length
      ? state.messages.map((m) => `${m.type}: ${m.content}`).join("\n")
      : "（无）";

    if (!config.dryRun && config.llmApiKey) {
      try {
        const model = new ChatOpenAI({
          model: config.llmModel,
          apiKey: config.llmApiKey,
          configuration: { baseURL: config.llmBaseUrl },
        }).withStructuredOutput(IntentSchema);
        const system = this.buildSystem(candidates);
        const res = (await model.invoke([
          { role: "system", content: system },
          { role: "user", content: `对话历史：\n${history}\n\n用户输入：${newText}` },
        ])) as { intent: string; params?: Record<string, unknown> };
        return { intent: res.intent, params: res.params ?? {} };
      } catch (e) {
        logger.warn(`intent 识别失败，回退规则: ${String(e)}`);
      }
    }
    return this.ruleFallback(newText);
  }

  /** 粗筛：trigger_keywords 命中 + 多轮承接 → 候选技能集 */
  coarseCandidates(state: GenericState, newText: string): Set<string> {
    const candidates = new Set<string>();
    for (const skill of this.registry.list()) {
      const kws = skill.manifest.trigger_keywords ?? [];
      if (kws.length === 0 || kws.some((kw) => newText.includes(kw))) {
        candidates.add(skill.manifest.id);
      }
    }
    // 多轮承接：上一轮技能（multi 模式）保留
    if (state.last_skill && !this.lastSkillIsSingle(state)) {
      candidates.add(state.last_skill);
    }
    return candidates;
  }

  private skillIntentDesc(candidates: Set<string>): Record<string, string> {
    const desc: Record<string, string> = {};
    for (const skill of this.registry.list()) {
      if (!candidates.has(skill.manifest.id)) continue;
      for (const intent of skill.manifest.intents) {
        desc[intent] = `${skill.manifest.description}（技能 ${skill.manifest.id}）`;
      }
    }
    return desc;
  }

  private buildSystem(candidates: Set<string>): string {
    const extra = this.registry
      .list()
      .filter((s) => candidates.has(s.manifest.id) && s.manifest.system_prompt)
      .map((s) => s.manifest.system_prompt)
      .join("\n");
    return DEFAULT_SYSTEM + (extra ? `\n\n技能附加指令：\n${extra}` : "");
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
