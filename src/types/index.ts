/** flyer 核心类型（TS 版，对齐 Python 版设计） */
import { z } from "zod";

/** 技能返回的唯一合法形态（结果契约，harness 强制校验） */
export const SkillResultSchema = z.object({
  status: z.enum(["success", "error"]),
  output: z.string().default(""),
  reason: z.string().default(""),
  data: z.record(z.unknown()).default({}),
});
export type SkillResult = z.infer<typeof SkillResultSchema>;

/** 用户上下文（JWT 断言或 db 解析，agent 据此裁剪技能/数据域） */
export interface UserContext {
  user_id: string;
  role: string;
  allowed_skills: string[]; // 空 = 全部可用
  data_scopes: string[];    // 空 = 全部数据
}

/** 技能声明（仓库即规范：skill.yaml 的 manifest 段） */
export interface SkillManifest {
  id: string;
  name: string;
  description: string;
  intents: string[];
  trigger_keywords?: string[];
  system_prompt?: string;
  session_mode?: "single" | "multi";
  max_turns_per_session?: number;
  max_llm_calls_per_turn?: number;
  token_budget_per_session?: number;
  data_scopes?: string[];
  tools?: string[];
  requires_confirmation?: boolean;
  confirmation_after?: number;
}

/** 技能插件基类接口 */
export interface Skill {
  readonly manifest: SkillManifest;
  handle(state: GenericState, intent: IntentResult, newText: string): SkillResult;
}

/** 意图识别结果 */
export interface IntentResult {
  intent: string;
  params: Record<string, unknown>;
  raw?: string;
}

/** 通用状态（LangGraph State 合并后的运行态） */
export interface GenericState {
  user_text: string;
  user_id: string;
  user_ctx: UserContext | null;   // 注入的可信上下文（JWT）；null = 走 resolveUser
  messages: Array<{ type: "human" | "ai"; content: string }>;
  intent: string;
  intent_params: Record<string, unknown>;
  last_skill: string;
  data: Record<string, unknown>;
  turns: number;
  pending_questions: string[];
  output: string;
  output_type: string;
  task: { id: string; steps: Array<{ name: string; status: string; detail: string }>; failed_at?: string };
}
