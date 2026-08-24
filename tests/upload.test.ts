/** /api/chat multipart 契约：文件（表格）+ 文字描述 一次打包，网关区分二者
 * - 表格 → state.table_text（解析为 CSV 文本）
 * - 文字 → state.user_text
 * - 无文字只有表格 → 仍处理（表格驱动）
 * - 都无 → 400
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApi } from "../src/api/server.js";
import { Agent } from "../src/core/agent.js";
import { config } from "../src/core/config.js";
import { BaseSkill } from "../src/core/registry.js";
import type { SkillManifest, SkillResult } from "../src/types/index.js";

// 表格技能：直接把收到的 text/table 回显（验证网关区分）
class TableSkill extends BaseSkill {
  readonly manifest: SkillManifest = {
    id: "table", name: "表格技能", description: "表格处理测试",
    intents: ["new_request", "table_do"],
    trigger_keywords: ["表格", "批量", "上架", "调整"],
  };
  handle(state: any): SkillResult {
    return {
      status: "success",
      output: `text=[${state.user_text}]|table=[${state.table_text ?? ""}]`,
      data: {},
    };
  }
}

let base = "";
let app: any;

beforeAll(async () => {
  config.authMode = "none"; // 测试免鉴权（表格解析不依赖文件存储）
  const agent = new Agent();
  agent.registry.register(new TableSkill());
  app = buildApi(agent);
  await app.listen({ port: 0 });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await app.close();
});

async function multipartChat(fields: Record<string, string>, file?: { name: string; content: string | Uint8Array; type: string }) {
  const form = new FormData();
  if (file) form.append("file", new Blob([file.content as any], { type: file.type }), file.name);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = await fetch(`${base}/api/chat`, { method: "POST", body: form });
  return { status: res.status, body: (await res.json()) as { output?: string; detail?: unknown } };
}

describe("/api/chat multipart（表格+文字一次打包）", () => {
  it("CSV 文件 + 文字描述 → 网关区分：text=文字，table=表格 CSV", async () => {
    const { status, body } = await multipartChat(
      { text: "批量上架", thread_id: "u-1" },
      { name: "商品.csv", content: "名称,价格,库存\n鞋A,100,10\n鞋B,200,20", type: "text/csv" },
    );
    expect(status).toBe(200);
    expect(body.output).toContain("text=[批量上架]");
    expect(body.output).toContain("table=[名称,价格,库存\n鞋A,100,10\n鞋B,200,20]");
  });

  it("Excel 文件 → 解析为 CSV 表格文本", async () => {
    // 用 xlsx 包生成真实 xlsx buffer
    const XLSX = require("xlsx") as typeof import("xlsx");
    const ws = XLSX.utils.aoa_to_sheet([["名称", "价格"], ["鞋X", 300]]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buf = XLSX.write(wb, { type: "buffer" }) as Uint8Array;
    const { status, body } = await multipartChat(
      { text: "批量调整价格", thread_id: "u-2" },
      { name: "改价.xlsx", content: buf, type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    );
    expect(status).toBe(200);
    expect(body.output).toContain("text=[批量调整价格]");
    expect(body.output).toContain("table=[名称,价格\n鞋X,300]");
  });

  it("只有表格无文字 → 仍处理（user_text 为空，表格驱动）", async () => {
    const { status, body } = await multipartChat(
      { thread_id: "u-3" },
      { name: "表.csv", content: "名称,价格\n鞋C,150", type: "text/csv" },
    );
    expect(status).toBe(200);
    expect(body.output).toContain("text=[]");
    expect(body.output).toContain("table=[名称,价格\n鞋C,150]");
  });

  it("无文字无表格 → 400", async () => {
    const form = new FormData();
    form.append("thread_id", "u-4");
    const res = await fetch(`${base}/api/chat`, { method: "POST", body: form });
    expect(res.status).toBe(400);
  });

  it("JSON 对话（无附件）不受影响", async () => {
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "批量上架", thread_id: "u-5" }),
    });
    const body = (await res.json()) as { output?: string };
    expect(res.status).toBe(200);
    expect(body.output).toContain("text=[批量上架]");
    expect(body.output).toContain("table=[]");
  });
});
