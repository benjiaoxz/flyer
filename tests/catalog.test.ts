/** catalog 技能测试：上架/查询/改价/下架（mock 业务系统 API） */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/core/config.js";
import type { GenericState, IntentResult } from "../src/types/index.js";

let fetchMock: ReturnType<typeof vi.fn>;
let products: Array<{ id: number; shop_id: number; name: string; price: number; stock: number; status: string }>;

beforeEach(() => {
  products = [
    { id: 1, shop_id: 1, name: "Nike 鞋", price: 299, stock: 50, status: "on_sale" },
    { id: 2, shop_id: 1, name: "调试鞋", price: 599, stock: 5, status: "on_sale" },
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
    expect(r.output).toContain("需要价格");
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

describe("catalog 字段解析增强（用户真实输入）", () => {
  it("价格改为199（无'元'后缀）→ 解析出价格", async () => {
    const r = await run('帮我把调试鞋价格改为199', "catalog_update");
    expect(r.status).toBe("success");
    expect(r.output).toContain("199元");
  });

  it("引号名称价格 → 名称清洗不带引号", async () => {
    const r = await run('帮我把"调试鞋"价格改为"199元"', "catalog_update");
    expect(r.status).toBe("success");
    expect(r.output).toContain("「调试鞋」");
    expect(r.output).not.toContain('"调试鞋"');
  });
});

describe("catalog 下架名称解析（操作词剔除）", () => {
  it("无引号下架 → 名称不含'下架'", async () => {
    const r = await run('帮我把调试鞋下架', "catalog_off");
    expect(r.status).toBe("success");
    expect(r.output).toContain("「调试鞋」");
    expect(r.output).not.toContain("下架」");
  });

  it("引号下架 → 名称清洗", async () => {
    const r = await run('帮我把"调试鞋"下架', "catalog_off");
    expect(r.status).toBe("success");
    expect(r.output).toContain("「调试鞋」");
  });

  it("状态改为下架 → 名称不含'状态'", async () => {
    const r = await run('帮我把"调试鞋"的状态改为下架', "catalog_off");
    expect(r.status).toBe("success");
    expect(r.output).toContain("「调试鞋」");
    expect(r.output).not.toContain("状态");
  });
});

describe("catalog 上架语义（同名恢复 vs 新建）", () => {
  it("同名商品已存在（off_sale）→ 恢复上架，不新建", async () => {
    // mock 里调试鞋是 on_sale，先下架再上架验证恢复
    products[1].status = "off_sale";
    const r = await run('上架"调试鞋" 599元 库存99', "catalog_add");
    expect(r.status).toBe("success");
    expect(r.output).toContain("已上架");
    expect(products[1].status).toBe("on_sale");
    // 未创建新商品（总数不变）
    expect(products.length).toBe(2);
  });

  it("同名商品不存在 → 创建新商品", async () => {
    const before = products.length;
    const r = await run('上架"全新鞋" 299元 库存10', "catalog_add");
    expect(r.status).toBe("success");
    expect(products.length).toBe(before + 1);
  });
});

describe("catalog 部分更新（只改价格/只改库存）", () => {
  it("只改价格 → 库存不变", async () => {
    products[1] = { ...products[1], price: 599, stock: 5 };
    const r = await run('把调试鞋价格改为168元', "catalog_update");
    expect(r.status).toBe("success");
    expect(products[1].price).toBe(168);
    expect(products[1].stock).toBe(5);  // 库存未被改动
  });

  it("只改库存 → 价格不变（防库存数字误当价格）", async () => {
    products[1] = { ...products[1], price: 168, stock: 5 };
    const r = await run('把调试鞋库存改成77', "catalog_update");
    expect(r.status).toBe("success");
    expect(products[1].stock).toBe(77);
    expect(products[1].price).toBe(168);  // 价格未被误改
  });
});

describe("catalog 单商品查询（查单个 vs 查全部）", () => {
  it("查单个（引号名称）→ 返回单个商品", async () => {
    const r = await run('给我"调试鞋"所有的信息', "catalog_query");
    expect(r.status).toBe("success");
    expect(r.output).toContain("调试鞋");
    expect(r.output).not.toContain("Nike 鞋");  // 不含其他商品
  });

  it("查全部（无名称）→ 返回列表", async () => {
    const r = await run('查一下我的商品', "catalog_query");
    expect(r.status).toBe("success");
    expect(r.output).toContain("Nike 鞋");
    expect(r.output).toContain("调试鞋");
  });

  it("查不存在的商品 → error", async () => {
    const r = await run('给我"不存在鞋"信息', "catalog_query");
    expect(r.status).toBe("error");
    expect(r.output).toContain("未找到");
  });
});
