/** API 服务（Fastify）：/health /api/chat /api/resume /api/usage /api/upload */
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { z } from "zod";

import { Agent } from "../core/agent.js";
import { config } from "../core/config.js";
import { logger } from "../core/log.js";
import { PermissionError, verifyJwt } from "../core/security.js";
import { usage } from "../core/usage.js";
import { parseCsvText, parseExcelFile, type ParsedTable } from "../tools/excel.js";
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
  void app.register(multipart);  // 文件上传
  ensureUploadDir();

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

  app.post("/api/chat", async (req: any, reply) => {
    const caller = await authorize(req);
    const callerUserId = typeof caller === "string" ? caller : (caller.user_id ?? "");
    let text = "";
    let threadId = "default";
    let tableText = "";
    if (req.isMultipart()) {
      // 一次打包：file（Excel/CSV 表格，可选）+ text（文字描述，可选）+ thread_id
      // 网关区分：表格 → table_text（CSV 文本），文字描述 → user_text
      const parts = req.parts();
      for await (const part of parts) {
        if (part.type === "file") {
          const buf = await part.toBuffer();
          if (callerUserId && callerUserId !== "anonymous") {
            const fileId = `${Date.now()}-${randomUUID().slice(0, 8)}${basename(String(part.filename ?? "upload"))}`;
            writeFileSync(join(UPLOAD_DIR, fileId), buf);
            userUploads.set(callerUserId, fileId);
            logger.info(`[对话附件] ${part.filename} (${buf.length} bytes, user=${callerUserId})`);
          }
          tableText = tableToCsv(buf, String(part.filename ?? ""));
        } else if (part.fieldname === "text") {
          text = String(part.value ?? "");
        } else if (part.fieldname === "thread_id") {
          threadId = String(part.value || "default");
        }
      }
    } else {
      const parsed = ChatReq.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ detail: parsed.error.message });
      text = parsed.data.text;
      threadId = parsed.data.thread_id;
    }
    if (!text.trim() && !tableText) {
      return reply.status(400).send({ detail: "需要文字描述或表格附件" });
    }
    const init: Record<string, unknown> = { user_text: text, user_id: callerUserId };
    if (typeof caller !== "string") {
      // jwt：用户身份 + 权限从 token 断言
      init.user_id = caller.user_id;
      init.user_ctx = caller;
    }
    if (tableText) init.table_text = tableText;
    const snap = await agent.start(init, threadId);
    return reply.send({
      status: snap.__next?.includes("dispatch") ? "need_input" : "result",
      output: snap.output,
      questions: snap.pending_questions ?? [],
      data: snap.data,
      task: snap.task,
      thread_id: threadId,
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

  registerUpload(app, authorize);  // 文件上传（前端附件通道，表格批量操作使用）

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
          global: usage.skillUsage("-"),  // 意图识别等全局 LLM 成本
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

// ---------------------------------------------------------------- 文件上传
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { basename, dirname } from "node:path";

const UPLOAD_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "uploads");

function ensureUploadDir(): void {
  mkdirSync(UPLOAD_DIR, { recursive: true });
}

/** 用户最近上传的文件（user_id → file_id），供技能按用户取 */
const userUploads = new Map<string, string>();

export function getLatestUpload(userId: string): string | null {
  const fileId = userUploads.get(userId);
  return fileId ?? null;
}

export function readUploadFile(fileId: string): Buffer | null {
  const path = join(UPLOAD_DIR, fileId);
  if (!existsSync(path)) return null;
  return readFileSync(path);
}

/** 表格文件 → CSV 文本（网关区分"表格"与"文字描述"：表格进 table_text，文字进 user_text） */
function tableToCsv(buf: Buffer, filename: string): string {
  const lower = filename.toLowerCase();
  let parsed: ParsedTable;
  try {
    parsed = lower.endsWith(".csv") || lower.endsWith(".txt")
      ? parseCsvText(buf.toString("utf8"))
      : parseExcelFile(buf);
  } catch {
    return "";
  }
  if (!parsed.rows.length) return "";
  const { headers, rows } = parsed;
  const esc = (v: string) => (/[,"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => esc(r[h] ?? "")).join(",")),
  ].join("\n");
}

function registerUpload(app: any, authorize: (req: any) => Promise<string | UserContext>) {
  app.post("/api/upload", async (req: any, reply: any) => {
    // JWT 鉴权（复用 authorize 的 UserContext 取 user_id）
    const caller = await authorize(req);
    const userId = typeof caller === "string" ? caller : caller.user_id;
    if (!userId || userId === "anonymous") {
      return reply.status(401).send({ detail: "需要登录" });
    }
    const file = await req.file();
    if (!file) return reply.status(400).send({ detail: "缺少文件" });
    const safeName = basename(String(file.filename ?? "upload"));  // 防路径穿越（../ 注入）
    const fileId = `${Date.now()}-${randomUUID().slice(0, 8)}${safeName}`;
    const buf = await file.toBuffer();
    writeFileSync(join(UPLOAD_DIR, fileId), buf);
    userUploads.set(userId, fileId);
    logger.info(`文件上传: ${file.filename} (${buf.length} bytes, user=${userId})`);
    return reply.send({ file_id: fileId, filename: file.filename, size: buf.length });
  });
}
