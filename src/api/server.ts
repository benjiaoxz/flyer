/** API 服务（Fastify）：/health /api/chat /api/resume /api/usage /api/failures
 * 
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";

import { Agent } from "../core/agent.js";
import { config } from "../core/config.js";
import { logger } from "../core/log.js";
import { PermissionError, verifyJwt } from "../core/security.js";
import { usage } from "../core/usage.js";
import type { UserContext } from "../types/index.js";

const ChatReq = z.object({
  text: z.string(),
  thread_id: z.string().default("default"),
  user_id: z.string().optional(),
});

const ResumeReq = z.object({
  thread_id: z.string(),
  answer: z.string(),
});

export function buildApi(agent: Agent) {
  const app = Fastify({ logger: false });
  void app.register(cors, { origin: true });  // 开发期全放行；生产按域名限制

  app.get("/health", async () => ({ status: "ok" }));

  // 鉴权中间件：none / api_key / jwt
  async function authorize(req: any): Promise<string | UserContext> {
    if (config.authMode === "none") return "anonymous";
    if (config.authMode === "jwt") {
      try {
        return await verifyJwt(req.headers.authorization);
      } catch (e) {
        throw { statusCode: 401, message: (e as PermissionError).message };
      }
    }
    // api_key
    const key = extractBearerSafe(req.headers.authorization);
    if (!key || !config.apiKeys.includes(key)) {
      throw { statusCode: 401, message: "无效 API Key" };
    }
    return key;
  }

  app.post("/api/chat", async (req, reply) => {
    const parsed = ChatReq.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ detail: parsed.error.message });
    const { text, thread_id, user_id } = parsed.data;
    const caller = await authorize(req);
    const init: Record<string, unknown> = { user_text: text, user_id: user_id ?? "" };
    if (typeof caller !== "string") {
      // jwt：用户身份 + 权限从 token 断言
      init.user_id = caller.user_id;
      init.user_ctx = caller;
    }
    const snap = await agent.start(init, thread_id);
    return reply.send({
      status: snap.__next?.includes("dispatch") ? "need_input" : "result",
      output: snap.output,
      questions: snap.pending_questions ?? [],
      data: snap.data,
      task: snap.task,
      thread_id,
    });
  });

  app.post("/api/resume", async (req, reply) => {
    const parsed = ResumeReq.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ detail: parsed.error.message });
    await authorize(req);
    const snap = await agent.resume(parsed.data.answer, parsed.data.thread_id);
    return reply.send({
      status: "result",
      output: snap.output,
      data: snap.data,
      task: snap.task,
      thread_id: parsed.data.thread_id,
    });
  });

  app.get("/api/usage", async (req) => {
    await authorize(req);
    const skillId = (req.query as { skill_id?: string }).skill_id;
    return skillId
      ? { scope: "skill", skill_id: skillId, ...usage.skillUsage(skillId) }
      : {
          scope: "all",
          skills: Object.fromEntries(
            agent.registry.list().map((s) => [s.manifest.id, usage.skillUsage(s.manifest.id)]),
          ),
        };
  });

  return app;
}

function extractBearerSafe(auth: string | undefined): string {
  if (!auth) return "";
  const parts = auth.split(" ");
  return parts.length === 2 && parts[0].toLowerCase() === "bearer" ? parts[1].trim() : "";
}

export async function startApi(agent: Agent, port = 8099): Promise<ReturnType<typeof Fastify>> {
  const app = buildApi(agent);
  await app.listen({ port, host: "0.0.0.0" });
  logger.info(`flyer API 已启动: http://127.0.0.1:${port}`);
  return app;
}

// ---------------------------------------------------------------- 直接运行入口
// npm run api：创建 Agent → 扫描 src/skills/ 技能 → 启动 Fastify
// 配置从 .env 读取（JWT 公钥 / 业务系统地址等）
async function main() {
  const { Agent } = await import("../core/agent.js");
  const { scanSkills } = await import("../core/skills_loader.js");
  const agent = new Agent();
  const n = await scanSkills(agent.registry);
  logger.info(`技能注册: ${n} 个（${agent.registry.list().map((s) => s.manifest.id).join(", ") || "无"}）`);
  const app = await startApi(agent, 8099);
  return app;
}

if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  main().catch((e) => {
    logger.error(`网关启动失败: ${String(e)}`);
    process.exit(1);
  });
}
