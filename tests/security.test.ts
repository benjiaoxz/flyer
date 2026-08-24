/** JWT 鉴权端测试（jose 签发/验证 + API 401 场景） */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportPKCS8, exportSPKI, generateKeyPair, SignJWT } from "jose";

import { buildApi } from "../src/api/server.js";
import { Agent } from "../src/core/agent.js";
import { config } from "../src/core/config.js";
import { BaseSkill } from "../src/core/registry.js";
import { verifyJwt } from "../src/core/security.js";
import type { SkillManifest, SkillResult } from "../src/types/index.js";

class OrderSkill extends BaseSkill {
  readonly manifest: SkillManifest = {
    id: "order", name: "订单", description: "订单技能",
    intents: ["new_request", "order_do"], max_turns_per_session: 5,
  };
  handle(): SkillResult {
    return { status: "success", output: "订单处理完成", data: {} };
  }
}

class SecretSkill extends BaseSkill {
  readonly manifest: SkillManifest = {
    id: "secret", name: "机密", description: "不应被访问",
    intents: ["new_request", "secret_do"], max_turns_per_session: 5,
  };
  handle(): SkillResult {
    return { status: "success", output: "机密泄露!", data: {} };
  }
}

let privPem = "";
let pubPem = "";

async function issueToken(payload: Record<string, unknown>, expiresInSec = 3600): Promise<string> {
  return new SignJWT(payload as never)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setExpirationTime(`${expiresInSec}s`)
    .sign(await import("jose").then((m) => m.importPKCS8(privPem, "RS256")));
}

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  privPem = await exportPKCS8(privateKey);
  pubPem = await exportSPKI(publicKey);
  config.jwtPublicKeyB64 = Buffer.from(pubPem).toString("base64");
  config.authMode = "jwt";
});

describe("JWT 验证端", () => {

  it("有效 JWT → UserContext 正确解析", async () => {
    const token = await issueToken({ sub: "2", role: "merchant", scopes: ["shop:1"], skills: ["order"] });
    const ctx = await verifyJwt(`Bearer ${token}`);
    expect(ctx.user_id).toBe("2");
    expect(ctx.role).toBe("merchant");
    expect(ctx.allowed_skills).toContain("order");
  });

  it("过期/伪造 JWT → PermissionError", async () => {
    await expect(verifyJwt("Bearer fake.token")).rejects.toThrow("无效 JWT");
    const expired = await issueToken({ sub: "2" }, -10);
    await expect(verifyJwt(`Bearer ${expired}`)).rejects.toThrow();
  });

  it("无 token → PermissionError", async () => {
    await expect(verifyJwt(null)).rejects.toThrow("缺少 JWT");
  });
});

describe("API 鉴权闭环", () => {
  let app: ReturnType<typeof buildApi>;
  let server: ReturnType<typeof app.listen>;

  beforeAll(async () => {
    const agent = new Agent();
    agent.registry.register(new OrderSkill());
    agent.registry.register(new SecretSkill());
    app = buildApi(agent);
    server = await app.listen({ port: 0 });
  });

  afterAll(async () => {
    await app.close();
  });

  const base = () => `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

  it("jwt 模式：白名单内技能放行", async () => {
    // 独立 agent：只注册 order（避免 new_request 映射冲突）
    const agent3 = new Agent();
    agent3.registry.register(new OrderSkill());
    const app3 = buildApi(agent3);
    const srv3 = await app3.listen({ port: 0 });
    const token = await issueToken({ sub: "2", role: "merchant", skills: ["order"], scopes: ["shop:1"] });
    const res = await fetch(`http://127.0.0.1:${(app3.server.address() as { port: number }).port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: "处理订单", thread_id: "a-1" }),
    });
    const body = (await res.json()) as { output: string };
    expect(body.output).toContain("订单处理完成");
    await app3.close();
  });

  it("jwt 模式：白名单外技能被拦截", async () => {
    const token = await issueToken({ sub: "2", role: "merchant", skills: ["order"], scopes: [] });
    const agent2 = new Agent();
    agent2.registry.register(new SecretSkill());
    const app2 = buildApi(agent2);
    const srv2 = await app2.listen({ port: 0 });
    const res = await fetch(`http://127.0.0.1:${(app2.server.address() as { port: number }).port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: "查机密", thread_id: "a-2" }),
    });
    const body = (await res.json()) as { output: string };
    expect(body.output).toContain("无权使用");
    await app2.close();
  });

  it("无 token → 401", async () => {
    const res = await fetch(`${base()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "你好", thread_id: "a-3" }),
    });
    expect(res.status).toBe(401);
  });

  it("伪造 token → 401", async () => {
    const res = await fetch(`${base()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer fake.token.here" },
      body: JSON.stringify({ text: "你好", thread_id: "a-4" }),
    });
    expect(res.status).toBe(401);
  });
});
