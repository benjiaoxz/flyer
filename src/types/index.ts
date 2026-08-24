/** flyer 核心类型 */
import { z } from "zod";

/** 技能返回的唯一合法形态（结果契约，harness 强制校验） */
export const SkillResultSchema = z.object({
  status: z.union([z.literal("success"), z.literal("error")]),
  output: z.string().default(""),
  reason: z.string().default(""),
  data: z.record(z.string(), z.unknown()).default({}),
});
/** 技能返回类型：status 必填，其余可选（运行时 zod default 补全） */
export interface SkillResult {
  status: "success" | "error";
  output?: string;
  reason?: string;
  data?: Record<string, unknown>;
}

/** 用户上下文（JWT 断言或 db 解析，agent 据此裁剪技能/数据域） */
export interface UserContext {
  user_id: string;
  role: string;
  allowed_skills: string[]; // 空 = 全部可用
  data_scopes: string[];    // 空 = 全部数据
  token?: string;           // 原始 JWT（技能调业务系统 API 时透传验证；无 token 场景可缺省）
  shop_id?: number;         // 所属店铺（JWT 断言，业务系统验证归属）
}

/** 技能声明（仓库即规范：skill.yaml 的 manifest 段） */
export interface SkillManifest {
  id: string;
  name: string;
  description: string;
  intents: string[];
  /** 每个意图的独立职责描述（供意图识别区分，如 catalog_update=修改价格/库存） */
  intent_descriptions?: Record<string, string>;
  /** 仅这些意图可命中语义缓存（写操作不应缓存，防返回过期结果）；空=全部可缓存 */
  cacheable_intents?: string[];
  /** true=加载时用 LLM 从意图描述自动生成 trigger_keywords（与手写合并） */
  auto_keywords?: boolean;
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
  handle(state: GenericState, intent: IntentResult, newText: string): SkillResult | Promise<SkillResult>;
  /** 可选：执行后自证（P2 结果验证）。返回 false = 执行结果未通过验证（按失败处理） */
  verify?(state: GenericState, result: SkillResult, newText: string): Promise<boolean> | boolean;
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
  /** 附件表格（网关解析上传文件后注入的 CSV 文本；技能按需读取，与 user_text 文字描述分离） */
  table_text: string;
  task: { id: string; steps: Array<{ name: string; status: string; detail: string }>; failed_at?: string };
}
