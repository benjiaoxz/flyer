/** catalog 技能测试：上架/查询/改价/下架（mock 业务系统 API） */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/core/config.js";
import type { GenericState, IntentResult } from "../src/types/index.js";

let fetchMock: ReturnType<typeof vi.fn>;
let products: Array<{ id: number; shop_id: number; name: string; price: number; stock: number; status: string }>;

beforeEach(() => {
  products = [
    { id: 1, shop_id: 1, name: "Nike 鞋", price: 299, stock: 50, status: "on_sale" },
  ];
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(config.bizBaseUrl, "");
    const method = init?.method ?? "GET";
    if (path === "/api/products" && method === "GET") {
      return { ok: true, json: async () => products } as Response;
    }
    if (path === "/api/products" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { name: string; price: number; stock: number };
      const p = { id: 2, shop_id: 1, ...body, status: "draft" };
      products.push(p);
      return { ok: true, json: async () => p } as Response;
    }
    const match = path.match(/^\/api\/products\/(\d+)$/);
    if (match && method === "PATCH") {
      const p = products.find((x) => x.id === Number(match[1]))!;
      Object.assign(p, JSON.parse(String(init?.body)));
      return { ok: true, json: async () => p } as Response;
    }
    return { ok: false, json: async () => ({ detail: "not found" }) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  config.bizBaseUrl = "http://biz.test";
  config.bizApiKey = "test-key";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function run(text: string, intent: string) {
  const { default: skill } = await import("../src/skills/catalog/handlers.js");
  const state = {
    user_text: text,
    user_ctx: { user_id: "2", role: "merchant", allowed_skills: ["catalog"], data_scopes: ["shop:1"], token: "jwt-token", shop_id: 1 },
  } as unknown as GenericState;
  return skill.handle(state, { intent, params: {} } as IntentResult, text);
}

describe("catalog 技能", () => {
  it("上架商品：调业务 API + 汇报", async () => {
    const r = await run('上架"Nike Air" 599元 库存20', "catalog_add");
    expect(r.status).toBe("success");
    expect(r.output).toContain("已上架");
    expect(r.output).toContain("Nike Air");
    // 请求头：X-Biz-Key + 透传 JWT
    const call = fetchMock.mock.calls.find((c) => c[1]?.method === "POST");
    expect(call![1]!.headers).toMatchObject({
      "X-Biz-Key": "test-key",
      Authorization: "Bearer jwt-token",
    });
  });

  it("上架缺价格 → error + reason", async () => {
    const r = await run('上架"Nike Air"', "catalog_add");
    expect(r.status).toBe("error");
    expect(r.output).toContain("需要商品名和价格");
    expect(r.reason).toContain("缺少");
  });

  it("查询商品列表", async () => {
    const r = await run("查一下我的商品", "catalog_query");
    expect(r.status).toBe("success");
    expect(r.output).toContain("Nike 鞋");
    expect(r.output).toContain("299元");
  });

  it("改价：找到商品并更新", async () => {
    const r = await run('改"Nike 鞋"价格 259元', "catalog_update");
    expect(r.status).toBe("success");
    expect(r.output).toContain("259元");
    expect(products[0].price).toBe(259);
  });

  it("下架商品", async () => {
    const r = await run('下架"Nike 鞋"', "catalog_off");
    expect(r.status).toBe("success");
    expect(r.output).toContain("已下架");
    expect(products[0].status).toBe("off_sale");
  });

  it("无 JWT（未登录）→ error", async () => {
    const { default: skill } = await import("../src/skills/catalog/handlers.js");
    const state = { user_text: "上架商品", user_ctx: null } as unknown as GenericState;
    const r = await skill.handle(state, { intent: "catalog_add", params: {} } as IntentResult, "上架商品");
    expect(r.status).toBe("error");
    expect(r.output).toContain("登录态");
  });

  it("业务系统 4xx → 失败反馈（不崩）", async () => {
    fetchMock.mockImplementationOnce(async () => ({ ok: false, json: async () => ({ detail: "库存不足" }) }) as Response);
    const r = await run('上架"测试" 100元 库存5', "catalog_add");
    expect(r.status).toBe("error");
    expect(r.reason).toContain("库存不足");
  });
});

describe("catalog new_request 动作猜测（无 LLM 兜底）", () => {
  it("上架文本（含库存）→ 猜 add 而非 update", async () => {
    const r = await run('上架"自动鞋" 299元 库存10', "new_request");
    expect(r.status).toBe("success");
    expect(r.output).toContain("已上架");
    expect(r.output).toContain("自动鞋");
  });

  it("改价文本 → 猜 update", async () => {
    const r = await run('改"Nike 鞋"价格 259元', "new_request");
    expect(r.status).toBe("success");
    expect(r.output).toContain("259元");
  });

  it("下架文本 → 猜 off", async () => {
    const r = await run('下架"Nike 鞋"', "new_request");
    expect(r.status).toBe("success");
    expect(r.output).toContain("已下架");
  });
});
