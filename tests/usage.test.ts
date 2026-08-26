/** usage 用量记录测试（memory 模式：record/skillUsage/totalAllTokens/cacheHit） */
import { describe, expect, it } from "vitest";

import { config } from "../src/core/config.js";
import { totalAllTokens, usage } from "../src/core/usage.js";

describe("usage 用量记录（memory 模式）", () => {
  it("record 后 skillUsage 正确聚合", () => {
    config.usageStore = "memory";
    usage.record("thread-1", "catalog", 100, 50);
    usage.record("thread-1", "catalog", 200, 80);
    const agg = usage.skillUsage("catalog");
    expect(agg.calls).toBe(2);
    expect(agg.prompt_tokens).toBe(300);
    expect(agg.completion_tokens).toBe(130);
    expect(agg.total).toBe(430);
  });

  it("不同技能隔离统计", () => {
    usage.record("thread-1", "report", 10, 5);
    const catalog = usage.skillUsage("catalog");
    const report = usage.skillUsage("report");
    expect(catalog.calls).toBe(2); // 仅 catalog 的
    expect(report.calls).toBe(1);
  });

  it("totalAllTokens 汇总所有技能", () => {
    // catalog 430 + report 15 + 之前测试可能残留 → 只验证非递减且 ≥ 445
    expect(totalAllTokens()).toBeGreaterThanOrEqual(445);
  });

  it("recordCacheHit 计入 saved_tokens", () => {
    usage.recordCacheHit("thread-1", "catalog", 120);
    const agg = usage.skillUsage("catalog");
    expect(agg.cache_hits).toBeGreaterThanOrEqual(1);
    expect(agg.saved_tokens).toBeGreaterThanOrEqual(120);
  });

  it("无记录的技能返回零值", () => {
    const agg = usage.skillUsage("nonexistent");
    expect(agg.calls).toBe(0);
    expect(agg.total).toBe(0);
  });
});
