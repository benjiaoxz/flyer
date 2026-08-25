/** report 技能测试：取数/聚合/图表数据生成/类型校验（mock 业务系统 /api/stats） */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/core/config.js";
import type { GenericState, IntentResult } from "../src/types/index.js";

let fetchMock: ReturnType<typeof vi.fn>;
const statsMap = new Map<string, Array<{ label: string; value: number }>>();

beforeEach(() => {
  statsMap.clear();
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const full = String(url);
    if (!full.includes("/api/stats")) {
      return { ok: false, json: async () => ({ detail: "not found" }) } as Response;
    }
    const u = new URL(full);
    const key = `${u.searchParams.get("dataset")}|${u.searchParams.get("group")}|${u.searchParams.get("metric")}`;
    const rows = statsMap.get(key) ?? [];
    return { ok: true, json: async () => ({ rows }) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  config.bizBaseUrl = "http://biz.test";
  config.bizApiKey = "test-key";
  config.dryRun = true; // 报告模式不调 LLM
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function run(text: string, intent: string, extra: Record<string, unknown> = {}) {
  const { default: skill } = await import("../src/skills/report/handlers.js");
  const state = {
    user_text: text,
    user_ctx: { user_id: "2", role: "merchant", allowed_skills: ["report"], data_scopes: ["shop:1"], token: "jwt-token", shop_id: 1 },
  } as unknown as GenericState;
  return skill.handle(state, { intent, params: { extra } } as unknown as IntentResult, text);
}

describe("report 技能", () => {
  it("商品价格对比（柱状）→ charts 含 bar + series", async () => {
    statsMap.set("products|name|price", [
      { label: "鞋A", value: 299 }, { label: "鞋B", value: 199 },
    ]);
    const r = await run("看看各商品的价格对比", "report_chart", { dataset: "products", group_by: "name", metric: "price", chart_type: "bar" });
    expect(r.status).toBe("success");
    const charts = (r.data as { charts: Array<{ title: string; type: string; series: Array<{ name: string; value: number }> }> }).charts;
    expect(charts).toHaveLength(1);
    expect(charts[0].type).toBe("bar");
    expect(charts[0].series).toEqual([{ name: "鞋A", value: 299 }, { name: "鞋B", value: 199 }]);
  });

  it("订单状态占比（饼图）→ pie", async () => {
    statsMap.set("orders|status|count", [{ label: "paid", value: 5 }, { label: "pending", value: 2 }]);
    const r = await run("订单各状态占比", "report_chart", { dataset: "orders", group_by: "status", metric: "count", chart_type: "pie" });
    expect(r.status).toBe("success");
    const charts = (r.data as { charts: Array<{ type: string }> }).charts;
    expect(charts[0].type).toBe("pie");
  });

  it("订单月度趋势（折线）→ line + month", async () => {
    statsMap.set("orders|month|count", [{ label: "2026-06", value: 2 }, { label: "2026-07", value: 5 }]);
    const r = await run("订单量的月度趋势", "report_chart", { dataset: "orders", group_by: "month", metric: "count", chart_type: "line" });
    expect(r.status).toBe("success");
    const charts = (r.data as { charts: Array<{ type: string; series: Array<{ name: string }> }> }).charts;
    expect(charts[0].type).toBe("line");
    expect(charts[0].series.map((s) => s.name)).toEqual(["2026-06", "2026-07"]);
  });

  it("类型-数据形态校验：非 month 却要折线 → 降级柱状", async () => {
    statsMap.set("orders|status|count", [{ label: "paid", value: 5 }]);
    const r = await run("订单状态趋势", "report_chart", { dataset: "orders", group_by: "status", metric: "count", chart_type: "line" });
    const charts = (r.data as { charts: Array<{ type: string }> }).charts;
    expect(charts[0].type).toBe("bar"); // 折线需要时间轴，确定性降级
  });

  it("非法参数 → 确定性回退默认（不崩）", async () => {
    statsMap.set("orders|status|count", [{ label: "paid", value: 3 }]);
    const r = await run("看看数据", "report_chart", { dataset: "hack", group_by: "nonsense", metric: "hack", chart_type: "hack" });
    expect(r.status).toBe("success");
    const charts = (r.data as { charts: Array<{ type: string }> }).charts;
    expect(charts[0].type).toBe("bar"); // 非法 chart_type 回退 bar
  });

  it("该维度无数据 → 明确报错", async () => {
    const r = await run("看看商品状态分布", "report_chart", { dataset: "products", group_by: "status", metric: "count", chart_type: "pie" });
    expect(r.status).toBe("error");
    expect(r.output).toContain("暂无数据");
  });

  it("报告模式（dry run）→ charts + 无 summary（不调 LLM）", async () => {
    statsMap.set("orders|status|amount", [{ label: "paid", value: 624 }]);
    const r = await run("总结一下订单情况", "report_summary", { dataset: "orders", group_by: "status", metric: "amount", chart_type: "pie" });
    expect(r.status).toBe("success");
    const data = r.data as { charts: unknown[]; summary?: string };
    expect(data.charts).toHaveLength(1);
    expect(data.summary).toBeUndefined(); // dry run 不调 LLM
  });
});
