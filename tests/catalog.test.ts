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
      const body = JSON.parse(String(init?.body)) as { name: string; price: number; stock: number; status?: string };
      const p = { id: 2, shop_id: 1, ...body, status: body.status ?? "draft" };
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

describe("catalog LLM params 优先（字段语义抽取）", () => {
  it("params 提供字段 → 正则未覆盖的说法也能解析", async () => {
    const { default: skill } = await import("../src/skills/catalog/handlers.js");
    const r = await skill.handle(
      { user_text: "把调试鞋库存调低到60", user_ctx: { user_id: "2", role: "merchant", allowed_skills: ["catalog"], data_scopes: ["shop:1"], token: "t", shop_id: 1 } } as never,
      { intent: "catalog_update", params: { name: "调试鞋", stock: 60 } } as never,
      "把调试鞋库存调低到60",
    );
    expect(r.status).toBe("success");
    expect(products[1].stock).toBe(60);  // params 的 stock=60 生效（正则可能抓不到"调低到60"）
  });
});

describe("catalog 改名（new_name）", () => {
  it("名称改为X → 商品名更新", async () => {
    products[0] = { ...products[0], name: "Nike 鞋" };
    const { default: skill } = await import("../src/skills/catalog/handlers.js");
    const r = await skill.handle(
      { user_text: "Nike 鞋名称改为Nike Pro", user_ctx: { user_id: "2", role: "merchant", allowed_skills: ["catalog"], data_scopes: ["shop:1"], token: "t", shop_id: 1 } } as never,
      { intent: "catalog_update", params: { name: "Nike 鞋", new_name: "Nike Pro" } } as never,
      "Nike 鞋名称改为Nike Pro",
    );
    expect(r.status).toBe("success");
    expect(products[0].name).toBe("Nike Pro");
  });
});

describe("catalog 批量上架（add_batch）", () => {
  it("CSV 文本批量上架 → 逐条创建", async () => {
    const { default: skill } = await import("../src/skills/catalog/handlers.js");
    const csv = "名称,价格,库存\n批量鞋A,100,10\n批量鞋B,200,20";
    const before = products.length;
    const r = await skill.handle(
      { user_text: "批量上架", user_ctx: { user_id: "2", role: "merchant", allowed_skills: ["catalog"], data_scopes: ["shop:1"], token: "t", shop_id: 1 } } as never,
      { intent: "catalog_add_batch", params: { extra: { table: csv } } } as never,
      "批量上架",
    );
    expect(r.status).toBe("success");
    expect(r.output).toContain("成功 2 条");
    expect(products.length).toBe(before + 2);
    expect(products.some((p) => p.name === "批量鞋A" && p.price === 100)).toBe(true);
    expect(products.some((p) => p.name === "批量鞋A" && p.status === "on_sale")).toBe(true); // 上架创建即在售
    expect(products.some((p) => p.name === "批量鞋B" && p.stock === 20)).toBe(true);
  });

  it("部分行缺字段 → 记失败不崩", async () => {
    const { default: skill } = await import("../src/skills/catalog/handlers.js");
    const csv = "名称,价格,库存\n完整鞋,100,10\n缺价鞋,,";
    const r = await skill.handle(
      { user_text: "批量上架", user_ctx: { user_id: "2", role: "merchant", allowed_skills: ["catalog"], data_scopes: ["shop:1"], token: "t", shop_id: 1 } } as never,
      { intent: "catalog_add_batch", params: { extra: { table: csv } } } as never,
      "批量上架",
    );
    expect(r.output).toContain("成功 1 条");
    expect(r.output).toContain("失败 1 条");
    expect(r.output).toContain("缺价鞋");
  });
});

describe("catalog 批量更新（表格批量改价/库存）", () => {
  it("CSV 批量改价 → 只 PATCH 已有商品，不新建", async () => {
    const { default: skill } = await import("../src/skills/catalog/handlers.js");
    const csv = "名称,价格\nNike 鞋,259\n调试鞋,199";
    const before = products.length;
    const r = await skill.handle(
      { user_text: "用刚才的表格批量调整价格", user_ctx: { user_id: "2", role: "merchant", allowed_skills: ["catalog"], data_scopes: ["shop:1"], token: "t", shop_id: 1 } } as never,
      { intent: "catalog_update", params: { extra: { table: csv } } } as never,
      "用刚才的表格批量调整价格",
    );
    expect(r.status).toBe("success");
    expect(r.output).toContain("成功 2 条");
    expect(products.length).toBe(before); // 不新建商品
    expect(products.find((p) => p.name === "Nike 鞋")?.price).toBe(259);
    expect(products.find((p) => p.name === "调试鞋")?.price).toBe(199);
    // 全走 PATCH，无 POST
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === "POST")).toBe(false);
  });

  it("批量改库存 + 找不到的商品记失败", async () => {
    const { default: skill } = await import("../src/skills/catalog/handlers.js");
    const csv = "名称,库存\nNike 鞋,80\n不存在鞋,99";
    const r = await skill.handle(
      { user_text: "用刚才的表格批量改库存", user_ctx: { user_id: "2", role: "merchant", allowed_skills: ["catalog"], data_scopes: ["shop:1"], token: "t", shop_id: 1 } } as never,
      { intent: "catalog_update", params: { extra: { table: csv } } } as never,
      "用刚才的表格批量改库存",
    );
    expect(r.output).toContain("成功 1 条");
    expect(r.output).toContain("失败 1 条");
    expect(r.output).toContain("不存在鞋");
    expect(products.find((p) => p.name === "Nike 鞋")?.stock).toBe(80);
  });

  it("意图护栏：LLM 误判 add_batch 但文本是批量改价 → 确定性改走 update", async () => {
    const { default: skill } = await import("../src/skills/catalog/handlers.js");
    const csv = "名称,价格\n调试鞋,168";
    const before = products.length;
    const r = await skill.handle(
      { user_text: "用刚才的表格批量调整价格", user_ctx: { user_id: "2", role: "merchant", allowed_skills: ["catalog"], data_scopes: ["shop:1"], token: "t", shop_id: 1 } } as never,
      { intent: "catalog_add_batch", params: { extra: { table: csv } } } as never, // 故意传 add_batch
      "用刚才的表格批量调整价格",
    );
    expect(r.status).toBe("success");
    expect(r.output).toContain("批量更新完成");
    expect(products.length).toBe(before); // update 不新建
    expect(products.find((p) => p.name === "调试鞋")?.price).toBe(168);
  });

  it("列护栏：说批量改库存但表格只有价格列 → 报错不改价", async () => {
    const { default: skill } = await import("../src/skills/catalog/handlers.js");
    const csv = "名称,价格\n调试鞋,168";
    const before = products.find((p) => p.name === "调试鞋")?.price;
    const r = await skill.handle(
      { user_text: "用刚才的表格批量改库存", user_ctx: { user_id: "2", role: "merchant", allowed_skills: ["catalog"], data_scopes: ["shop:1"], token: "t", shop_id: 1 } } as never,
      { intent: "catalog_update", params: { extra: { table: csv } } } as never,
      "用刚才的表格批量改库存",
    );
    expect(r.status).toBe("error");
    expect(r.output).toContain("没有库存列");
    expect(products.find((p) => p.name === "调试鞋")?.price).toBe(before); // 价格未被误改
  });

  it("描述条件：价格上限 → 超上限的行跳过并汇报", async () => {
    const { default: skill } = await import("../src/skills/catalog/handlers.js");
    const csv = "名称,价格\n调试鞋,199\n调试鞋2,300";
    const r = await skill.handle(
      { user_text: "批量上架价格低于200的", user_ctx: { user_id: "2", role: "merchant", allowed_skills: ["catalog"], data_scopes: ["shop:1"], token: "t", shop_id: 1 } } as never,
      { intent: "catalog_add_batch", params: { extra: { table: csv }, filters: { price_max: 200 } } } as never,
      "批量上架价格低于200的",
    );
    expect(r.status).toBe("success"); // 跳过≠失败
    expect(r.output).toContain("成功 1 条");
    expect(r.output).toContain("跳过 1 条");
    expect(r.output).toContain("调试鞋2:价格300高于上限200"); // 价格300>200 被过滤
  });

  it("描述条件：排除名单 → 排除的商品不处理", async () => {
    const { default: skill } = await import("../src/skills/catalog/handlers.js");
    const csv = "名称,价格\nNike 鞋,259\n调试鞋,129";
    const r = await skill.handle(
      { user_text: "批量调整价格，除了调试鞋", user_ctx: { user_id: "2", role: "merchant", allowed_skills: ["catalog"], data_scopes: ["shop:1"], token: "t", shop_id: 1 } } as never,
      { intent: "catalog_update", params: { extra: { table: csv }, filters: { exclude: ["调试鞋"] } } } as never,
      "批量调整价格，除了调试鞋",
    );
    expect(r.status).toBe("success");
    expect(r.output).toContain("成功 1 条");
    expect(r.output).toContain("跳过 1 条");
    expect(r.output).toContain("在排除名单中");
    expect(products.find((p) => p.name === "Nike 鞋")?.price).toBe(259);
    expect(products.find((p) => p.name === "调试鞋")?.price).toBe(599); // 未被改
  });

  it("描述与表格数量不一致 → 拒绝并提示", async () => {
    const { default: skill } = await import("../src/skills/catalog/handlers.js");
    const csv = "名称,价格\n调试鞋,129";
    const r = await skill.handle(
      { user_text: "这9个商品都批量调整价格", user_ctx: { user_id: "2", role: "merchant", allowed_skills: ["catalog"], data_scopes: ["shop:1"], token: "t", shop_id: 1 } } as never,
      { intent: "catalog_update", params: { extra: { table: csv }, filters: { expected_count: 9 } } } as never,
      "这9个商品都批量调整价格",
    );
    expect(r.status).toBe("error");
    expect(r.output).toContain("你说的是 9 个商品");
    expect(r.output).toContain("表格里有 1 行");
    expect(products.find((p) => p.name === "调试鞋")?.price).toBe(599); // 未执行
  });

  it("全部行被条件过滤 → 明确提示而非静默成功", async () => {
    const { default: skill } = await import("../src/skills/catalog/handlers.js");
    const csv = "名称,价格\n调试鞋,199";
    const r = await skill.handle(
      { user_text: "批量上架价格低于100的", user_ctx: { user_id: "2", role: "merchant", allowed_skills: ["catalog"], data_scopes: ["shop:1"], token: "t", shop_id: 1 } } as never,
      { intent: "catalog_add_batch", params: { extra: { table: csv }, filters: { price_max: 100 } } } as never,
      "批量上架价格低于100的",
    );
    expect(r.status).toBe("error");
    expect(r.output).toContain("没有符合条件的商品行");
  });

  it("描述条件：状态过滤 → 只改 on_sale 商品", async () => {
    const { default: skill } = await import("../src/skills/catalog/handlers.js");
    products[0] = { id: 1, shop_id: 1, name: "Nike 鞋", price: 299, stock: 50, status: "on_sale" };
    products[1] = { id: 2, shop_id: 1, name: "调试鞋", price: 599, stock: 5, status: "off_sale" };
    const csv = "名称,价格\nNike 鞋,259\n调试鞋,199";
    const r = await skill.handle(
      { user_text: "批量调整价格，只改上架中的", user_ctx: { user_id: "2", role: "merchant", allowed_skills: ["catalog"], data_scopes: ["shop:1"], token: "t", shop_id: 1 } } as never,
      { intent: "catalog_update", params: { extra: { table: csv }, filters: { status: "on_sale" } } } as never,
      "批量调整价格，只改上架中的",
    );
    expect(r.status).toBe("success");
    expect(r.output).toContain("成功 1 条");
    expect(r.output).toContain("状态off_sale不符合条件on_sale");
    expect(products[0].price).toBe(259);  // on_sale 被改
    expect(products[1].price).toBe(599);  // off_sale 未被改
  });
});

describe("catalog 表格附件（table_text 一次打包）", () => {
  const ctx = { user_id: "2", role: "merchant", allowed_skills: ["catalog"], data_scopes: ["shop:1"], token: "t", shop_id: 1 };

  it("state.table_text 优先于 extra.table：网关打包的表格直接驱动", async () => {
    const { default: skill } = await import("../src/skills/catalog/handlers.js");
    const csv = "名称,价格\nNike 鞋,159\n调试鞋,129";
    const r = await skill.handle(
      { user_text: "批量上架", table_text: csv, user_ctx: ctx } as never,
      { intent: "catalog_add_batch", params: { extra: { table: "名称,价格\n旧表鞋,1" } } } as never,
      "批量上架",
    );
    expect(r.status).toBe("success");
    expect(r.output).toContain("成功 2 条");
    expect(products.find((p) => p.name === "Nike 鞋")?.price).toBe(159); // 新商品创建
    expect(products.some((p) => p.name === "旧表鞋")).toBe(false);      // 未被 extra.table 覆盖
  });

  it("无'上架'字样（表格驱动调整）→ 已存在商品保留原状态", async () => {
    const { default: skill } = await import("../src/skills/catalog/handlers.js");
    products[1] = { id: 2, shop_id: 1, name: "调试鞋", price: 599, stock: 5, status: "off_sale" };
    const csv = "名称,价格\n调试鞋,168";
    const r = await skill.handle(
      { user_text: "", table_text: csv, user_ctx: ctx } as never,
      { intent: "catalog_add_batch", params: {} } as never,
      "",
    );
    expect(r.status).toBe("success");
    expect(products[1].price).toBe(168);
    expect(products[1].status).toBe("off_sale"); // 表格驱动调整不强制上架
  });

  it("明确'批量上架' → 已存在商品恢复 on_sale", async () => {
    const { default: skill } = await import("../src/skills/catalog/handlers.js");
    products[1] = { id: 2, shop_id: 1, name: "调试鞋", price: 599, stock: 5, status: "off_sale" };
    const csv = "名称,价格\n调试鞋,168";
    const r = await skill.handle(
      { user_text: "批量上架", table_text: csv, user_ctx: ctx } as never,
      { intent: "catalog_add_batch", params: {} } as never,
      "批量上架",
    );
    expect(r.status).toBe("success");
    expect(products[1].price).toBe(168);
    expect(products[1].status).toBe("on_sale"); // 明确上架 → 恢复
  });

  it("批量改价不动状态（下架商品不被意外上架）", async () => {
    const { default: skill } = await import("../src/skills/catalog/handlers.js");
    products[0] = { id: 1, shop_id: 1, name: "Nike 鞋", price: 299, stock: 50, status: "off_sale" };
    const csv = "名称,价格\nNike 鞋,259";
    const r = await skill.handle(
      { user_text: "用刚才的表格批量调整价格", table_text: csv, user_ctx: ctx } as never,
      { intent: "catalog_update", params: {} } as never,
      "用刚才的表格批量调整价格",
    );
    expect(r.status).toBe("success");
    expect(products[0].price).toBe(259);
    expect(products[0].status).toBe("off_sale");
  });

  it("表格状态列驱动：'下架' → 商品被下架（无文字表格驱动）", async () => {
    const { default: skill } = await import("../src/skills/catalog/handlers.js");
    products[0] = { id: 1, shop_id: 1, name: "Nike 鞋", price: 299, stock: 50, status: "on_sale" };
    const csv = "名称,价格,库存,状态\nNike 鞋,259,40,下架";
    const r = await skill.handle(
      { user_text: "", table_text: csv, user_ctx: ctx } as never,
      { intent: "catalog_add_batch", params: {} } as never,
      "",
    );
    expect(r.status).toBe("success");
    expect(products[0].price).toBe(259);
    expect(products[0].status).toBe("off_sale"); // 状态列"下架"生效
  });

  it("价格为 0 的行不算缺价格（0 是合法值）", async () => {
    const { default: skill } = await import("../src/skills/catalog/handlers.js");
    const csv = "名称,价格\n零价鞋,0";
    const r = await skill.handle(
      { user_text: "批量上架", table_text: csv, user_ctx: ctx } as never,
      { intent: "catalog_add_batch", params: {} } as never,
      "批量上架",
    );
    expect(r.status).toBe("success");
    expect(r.output).toContain("成功 1 条");
    expect(products.find((p) => p.name === "零价鞋")?.price).toBe(0);
  });

  it("描述指名商品 → 只处理表格中匹配的行，其余跳过", async () => {
    const { default: skill } = await import("../src/skills/catalog/handlers.js");
    const csv = "名称,价格\nNike 鞋,259\n调试鞋,199";
    const r = await skill.handle(
      { user_text: "根据表格调整\"Nike 鞋\"的信息", table_text: csv, user_ctx: ctx } as never,
      { intent: "catalog_update", params: { name: "Nike 鞋" } } as never,
      "根据表格调整\"Nike 鞋\"的信息",
    );
    expect(r.status).toBe("success");
    expect(r.output).toContain("成功 1 条");
    expect(r.output).toContain("跳过 1 条");
    expect(r.output).toContain("描述指定了「Nike 鞋」，跳过");
    expect(products.find((p) => p.name === "Nike 鞋")?.price).toBe(259); // 目标行被改
    expect(products.find((p) => p.name === "调试鞋")?.price).toBe(599); // 其他行不动
  });

  it("描述指名商品但表格里没有该行 → 明确报错", async () => {
    const { default: skill } = await import("../src/skills/catalog/handlers.js");
    const csv = "名称,价格\nNike 鞋,259";
    const r = await skill.handle(
      { user_text: "根据表格调整\"不存在的鞋\"的信息", table_text: csv, user_ctx: ctx } as never,
      { intent: "catalog_update", params: { name: "不存在的鞋" } } as never,
      "根据表格调整\"不存在的鞋\"的信息",
    );
    expect(r.status).toBe("error");
    expect(r.output).toContain("表格里没有「不存在的鞋」这一行");
  });

  it("new_request 兜底 + 表格 + 引号点名 → 限定该行批量更新（LLM 漏抽 name 也不整表）", async () => {
    const { default: skill } = await import("../src/skills/catalog/handlers.js");
    const csv = "名称,价格\nNike 鞋,259\n调试鞋,199";
    const r = await skill.handle(
      { user_text: "根据表格调整\"Nike 鞋\"的信息", table_text: csv, user_ctx: ctx } as never,
      { intent: "new_request", params: {} } as never, // LLM 识别成 new_request（不稳定场景）
      "根据表格调整\"Nike 鞋\"的信息",
    );
    expect(r.status).toBe("success");
    expect(r.output).toContain("成功 1 条");
    expect(r.output).toContain("跳过 1 条");
    expect(products.find((p) => p.name === "Nike 鞋")?.price).toBe(259); // 目标行被改
    expect(products.find((p) => p.name === "调试鞋")?.price).toBe(599); // 其他行不动
  });

  it("表格带 id 列 → 按 id 定位，名称列变化 → 改名", async () => {
    const { default: skill } = await import("../src/skills/catalog/handlers.js");
    products[0] = { id: 1, shop_id: 1, name: "Nike 鞋", price: 299, stock: 50, status: "on_sale" };
    const csv = "id,名称,价格\n1,Nike Pro,259"; // id 1 = Nike 鞋，名称改为 Nike Pro
    const r = await skill.handle(
      { user_text: "", table_text: csv, user_ctx: ctx } as never,
      { intent: "catalog_add_batch", params: {} } as never,
      "",
    );
    expect(r.status).toBe("success");
    expect(r.output).toContain("成功 1 条");
    expect(products[0].name).toBe("Nike Pro");  // 按 id 定位 → 名称变更生效
    expect(products[0].price).toBe(259);
    expect(products.length).toBe(2); // 不创建新商品（id 定位到已有）
  });

  it("描述与表格无关联 → 分别处理：描述改价 + 表格驱动", async () => {
    const { default: skill } = await import("../src/skills/catalog/handlers.js");
    const csv = "名称,价格\n新表鞋X,88";
    const before = products.length;
    const r = await skill.handle(
      { user_text: "把调试鞋价格改为199", table_text: csv, user_ctx: ctx } as never,
      { intent: "catalog_update", params: { name: "调试鞋", price: 199 } } as never,
      "把调试鞋价格改为199",
    );
    expect(r.status).toBe("success");
    expect(r.output).toContain("已更新「调试鞋」");   // 描述部分执行
    expect(r.output).toContain("表格处理：成功 1 条"); // 表格部分独立处理
    expect(products.find((p) => p.name === "调试鞋")?.price).toBe(199);
    expect(products.length).toBe(before + 1); // 表格新商品被创建
  });
});

describe("catalog 上传文件批量上架", () => {
  it("读上传的 Excel → 批量上架", async () => {
    // mock api/server 的 getLatestUpload/readUploadFile
    vi.mock("../src/api/server.js", async (importOriginal) => {
      const mod = await importOriginal<typeof import("../src/api/server.js")>();
      return {
        ...mod,
        getLatestUpload: () => "test-file",
        readUploadFile: () => {
          const XLSX = require("xlsx") as typeof import("xlsx");
          const ws = XLSX.utils.aoa_to_sheet([["名称", "价格", "库存"], ["上传鞋A", 300, 30]]);
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
          return XLSX.write(wb, { type: "buffer" }) as Buffer;
        },
      };
    });
    const { default: skill } = await import("../src/skills/catalog/handlers.js");
    const before = products.length;
    const r = await skill.handle(
      { user_text: "用刚才上传的表格批量上架", user_ctx: { user_id: "2", role: "merchant", allowed_skills: ["catalog"], data_scopes: ["shop:1"], token: "t", shop_id: 1 } } as never,
      { intent: "catalog_add_batch", params: {} } as never,
      "用刚才上传的表格批量上架",
    );
    expect(r.status).toBe("success");
    expect(r.output).toContain("成功 1 条");
    expect(products.some((p) => p.name === "上传鞋A")).toBe(true);
  });

  it("Excel 表头不在第一行（标题行/合并单元格）→ 仍能定位表头并批量上架", async () => {
    const { parseExcelFile } = await import("../src/tools/excel.js");
    const XLSX = require("xlsx") as typeof import("xlsx");
    // 模拟用户真实表格：第一行是标题"表格 1"，第二行才是表头（名称/价格/库存/状态）
    const ws = XLSX.utils.aoa_to_sheet([
      ["表格 1"],
      ["", "名称", "价格", "库存", "状态"],
      ["", "标题表鞋A", 120, 12, "上架"],
      ["", "标题表鞋B", 220, 22, "上架"],
    ]);
    ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 4 } }]; // 标题行合并单元格
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buf = XLSX.write(wb, { type: "buffer" }) as Buffer;
    const t = parseExcelFile(buf);
    expect(t.headers).toContain("名称");
    expect(t.headers).toContain("价格");
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0].name ?? t.rows[0]["名称"]).toBe("标题表鞋A");
  });
});
