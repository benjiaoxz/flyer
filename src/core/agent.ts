/** 对话 Agent 主流程（LangGraph JS 三节点：intent → dispatch → remember）
 * 
 */
import { Annotation, Command, END, StateGraph, interrupt } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { randomUUID } from "node:crypto";

import { config } from "./config.js";
import { getCache } from "./cache.js";
import { usage } from "./usage.js";
import { IntentRecognizer } from "./intent.js";
import { logger } from "./log.js";
import { SkillRegistry } from "./registry.js";
import { SkillResultSchema, type GenericState, type IntentResult, type SkillResult, type UserContext } from "../types/index.js";

// LangGraph state 字段定义（reducer 显式标注类型，v1 需要）
const State = Annotation.Root({
  user_text: Annotation<string>({ reducer: (a, b) => b, default: () => "" }),
  user_id: Annotation<string>({ reducer: (a, b) => b, default: () => "" }),
  user_ctx: Annotation<UserContext | null>({
    reducer: (a, b) => b,
    default: () => null,
  }),
  messages: Annotation<GenericState["messages"]>({
    reducer: (a, b) => [...(a ?? []), ...(b ?? [])],
    default: () => [],
  }),
  intent: Annotation<string>({ reducer: (a, b) => b, default: () => "" }),
  intent_params: Annotation<Record<string, unknown>>({ reducer: (a, b) => b, default: () => ({}) }),
  last_skill: Annotation<string>({ reducer: (a, b) => b, default: () => "" }),
  data: Annotation<Record<string, unknown>>({ reducer: (a, b) => ({ ...(a ?? {}), ...(b ?? {}) }), default: () => ({}) }),
  turns: Annotation<number>({ reducer: (a, b) => b, default: () => 0 }),
  pending_questions: Annotation<string[]>({ reducer: (a, b) => b, default: () => [] }),
  output: Annotation<string>({ reducer: (a, b) => b, default: () => "" }),
  output_type: Annotation<string>({ reducer: (a, b) => b, default: () => "text" }),
  task: Annotation<GenericState["task"]>({
    reducer: (a, b) => b,
    default: () => ({ id: "", steps: [] }),
  }),
});

type Snapshot = GenericState & { __next?: string[] };

export class Agent {
  readonly registry: SkillRegistry;
  private recognizer: IntentRecognizer;
  private graph: any;  // CompiledStateGraph（langgraph v1 泛型复杂，运行时安全）

  constructor(registry?: SkillRegistry, checkpointer?: unknown) {
    this.registry = registry ?? new SkillRegistry();
    this.recognizer = new IntentRecognizer(this.registry);
    this.graph = this.buildGraph(checkpointer ?? new MemorySaver());
  }

  private buildGraph(checkpointer: unknown) {
    return new StateGraph(State)
      .addNode("intent_node", async (s: GenericState) => {
        const intent = await this.recognizer.recognize(s, s.user_text);
        const task = { ...s.task, id: s.task.id || randomUUID().slice(0, 12) };
        this.recordTaskStep(task, `intent:${intent.intent}`, "done");
        return { intent: intent.intent, intent_params: intent.params, task };
      })
      .addNode("dispatch_node", async (s: GenericState) => this.dispatch(s))
      .addNode("remember_node", (s: GenericState) => ({
        messages: [
          { type: "human" as const, content: s.user_text },
          { type: "ai" as const, content: s.output || "" },
        ],
        turns: s.turns + 1,
      }))
      .addEdge("__start__", "intent_node")
      .addEdge("intent_node", "dispatch_node")
      .addEdge("dispatch_node", "remember_node")
      .addEdge("remember_node", END)
      .compile({ checkpointer: checkpointer as never });
  }

  // ------------------------------------------------------------ dispatch
  private async dispatch(s: GenericState): Promise<Partial<GenericState>> {
    const task = { ...s.task };
    const skill = this.registry.resolve(s.intent);
    if (!skill) {
      logger.warn(`意图 ${s.intent} 无技能处理`);
      this.recordOutcome("error", "resolve", `意图 ${s.intent} 无技能处理`);
      task.failed_at = "resolve";
      return { output: "抱歉，我暂时无法处理这个请求。", output_type: "text", task };
    }

    const manifest = skill.manifest;
    // 用户隔离：优先注入的 user_ctx（JWT 断言），否则无（简化版暂无 db provider）
    const userCtx = s.user_ctx;
    if (userCtx && userCtx.allowed_skills.length > 0 && !userCtx.allowed_skills.includes(manifest.id)) {
      logger.warn(`[用户隔离] 用户 ${userCtx.user_id} 无权使用技能 ${manifest.id}`);
      this.recordOutcome("error", "boundary", `用户 ${userCtx.user_id} 无权使用技能 ${manifest.id}`);
      task.failed_at = "boundary";
      return { output: "您无权使用该功能。", output_type: "text", task };
    }
    // 数据域交集（技能声明 ∩ 用户域）
    if (userCtx && userCtx.data_scopes.length > 0 && manifest.data_scopes?.length) {
      // 简化：技能数据域需在用户域内（示例）
    }

    // 语义缓存：命中直接返回（省技能执行；失败不存缓存，防固化）
    const cached = await getCache().tryGet(s.user_text, manifest.id, config.cacheBusting);
    if (cached) {
      usage.recordCacheHit("-", manifest.id, cached.saved_tokens);
      logger.info(`[缓存命中] 技能 ${manifest.id} 直接返回缓存结果（约省 ${cached.saved_tokens} tokens）`);
      this.recordTaskStep(task, `execute:${manifest.id}`, "success", "cache_hit");
      return { output: String(cached.result), output_type: "text", last_skill: manifest.id, task };
    }

    // 执行技能（结果契约：SkillResult 校验；异常视为 error 不崩）
    this.recordTaskStep(task, `execute:${manifest.id}`, "running");
    let updates: SkillResult;
    try {
      const raw = await skill.handle(s, { intent: s.intent, params: s.intent_params }, s.user_text);
      updates = this.normalizeResult(raw);
    } catch (e) {
      logger.error(`[技能异常] ${manifest.id} handle 抛异常: ${String(e)}`);
      this.recordOutcome("error", "execute", `${(e as Error).constructor.name}: ${String(e)}`);
      task.failed_at = "execute";
      this.recordTaskStep(task, `execute:${manifest.id}`, "error", String(e).slice(0, 200));
      return {
        output: `技能「${manifest.name}」执行出错：${String(e)}`,
        output_type: "text",
        last_skill: manifest.id,
        task,
      };
    }
    // 结果检查：失败记 outcome + 不存缓存（缓存 M4 接入）
    if (updates.status === "error") {
      this.recordOutcome("error", "execute", updates.reason ?? "", updates.output ?? "");
      task.failed_at = "execute";
      this.recordTaskStep(task, `execute:${manifest.id}`, "error", updates.reason ?? "");
    } else {
      // P2 结果验证：技能声明 verify 则执行后自证，未通过 → 按失败处理（不存缓存）
      let verified = true;
      if (skill.verify) {
        try {
          verified = await skill.verify(s, updates, s.user_text);
        } catch (e) {
          logger.warn(`[验证异常] ${manifest.id} verify 抛异常: ${String(e)}`);
          verified = false;
        }
        if (!verified) {
          this.recordOutcome("error", "verify", "执行后自证未通过", updates.output);
          task.failed_at = "verify";
          this.recordTaskStep(task, `execute:${manifest.id}`, "error", "verify_failed");
          return {
            output: `执行结果未通过验证：${updates.output}`,
            output_type: "text",
            last_skill: manifest.id,
            task,
          };
        }
        this.recordTaskStep(task, "verify", "success");
      }
      this.recordOutcome("success", "execute", "", updates.output);
      this.recordTaskStep(task, `execute:${manifest.id}`, "success");
      if (updates.output) {
        await getCache().save(s.user_text, updates.output, manifest.id, config.cacheBusting, 0);
      }
    }
    return {
      output: updates.output,
      output_type: "text",
      data: updates.data,
      last_skill: manifest.id,
      task,
    };
  }

  // ------------------------------------------------------------ 结果契约
  private normalizeResult(raw: unknown): SkillResult {
    const parsed = SkillResultSchema.safeParse(raw);
    if (parsed.success) {
      return parsed.data as SkillResult;
    }
    logger.warn(`[契约违规] 技能返回不合规: ${JSON.stringify(raw)} type=${typeof raw}`);
    this.recordOutcome("error", "contract", `SkillResult 校验失败: ${parsed.error.message}`, JSON.stringify(raw).slice(0, 200));
    return {
      status: "error" as const,
      output: `技能返回结果不合规: ${parsed.error.message}`,
      reason: "contract_violation",
      data: {},
    };
  }

  // ------------------------------------------------------------ 工具
  private recordTaskStep(task: GenericState["task"], name: string, status: string, detail = ""): void {
    const steps = task.steps ?? [];
    const existing = steps.find((st) => st.name === name);
    if (existing) {
      existing.status = status;
      existing.detail = detail;
    } else {
      steps.push({ name, status, detail });
    }
    task.steps = steps;
  }

  private recordOutcome(status: "success" | "error", stage: string, reason = "", output = ""): void {
    logger.info("outcome_event", { thread_id: "-", skill_id: "-", status, stage, reason, output: output.slice(0, 200) });
  }

  // ------------------------------------------------------------ 交互接口
  async start(init: string | Partial<GenericState>, threadId = "default"): Promise<Snapshot> {
    const input: Partial<GenericState> =
      typeof init === "string" ? { user_text: init } : init;
    await this.graph.invoke(input as GenericState, { configurable: { thread_id: threadId } });
    return this.snapshot(threadId);
  }

  async resume(answer: string, threadId = "default"): Promise<Snapshot> {
    await this.graph.invoke(new Command({ resume: answer }), { configurable: { thread_id: threadId } });
    return this.snapshot(threadId);
  }

  async snapshot(threadId = "default"): Promise<Snapshot> {
    const state = await this.graph.getState({ configurable: { thread_id: threadId } });
    const values = state.values as GenericState;
    return { ...values, __next: state.next ?? [] };
  }
}
