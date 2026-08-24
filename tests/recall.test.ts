/** embedding 召回测试：关键词零命中时用语义相似度兜底 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IntentRecognizer } from "../src/core/intent.js";
import { BaseSkill } from "../src/core/registry.js";
import type { SkillManifest, SkillResult } from "../src/types/index.js";

// 有 trigger_keywords 但用户输入不含它们的技能
class CatalogSkill extends BaseSkill {
  readonly manifest: SkillManifest = {
    id: "catalog", name: "商品管理", description: "商家管理商品（上架/改名/改价/库存）",
    intents: ["catalog_add", "catalog_update"],
    trigger_keywords: ["上架", "下架"],
  };
  handle(): SkillResult {
    return { status: "success", output: "ok", data: {} };
  }
}

describe("embedding 召回", () => {
  beforeEach(() => {
    // 技能代表向量 = [1,0,0]；用户输入"帮我调一下跑步鞋库存"语义相近 [0.99,...]；
    // 无关输入 = [0,1,0]
    vi.mock("../src/core/embedding.js", async (importOriginal) => {
      const mod = await importOriginal<typeof import("../src/core/embedding.js")>();
      return {
        ...mod,
        embedText: async (t: string) => {
          if (t.includes("商品管理") || t.includes("上架")) return [1, 0, 0];
          if (t.includes("帮我调一下跑步鞋库存")) return [0.99, 0.01, 0];
          if (t.includes("今天天气怎么样")) return [0, 1, 0];
          return null;
        },
      };
    });
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("关键词零命中但语义相近 → 召回技能", async () => {
    const { IntentRecognizer: Rec } = await import("../src/core/intent.js");
    const { Agent } = await import("../src/core/agent.js");
    const agent = new Agent();
    agent.registry.register(new CatalogSkill());
    const rec = new Rec(agent.registry);
    // "帮我调一下跑步鞋库存"无"上架/下架"关键词，但语义与 catalog 相近
    const cands = await rec.coarseCandidates(
      { user_text: "帮我调一下跑步鞋库存", last_skill: "" } as never,
      "帮我调一下跑步鞋库存",
    );
    expect(cands.has("catalog")).toBe(true);
  });

  it("无关输入 → 不召回", async () => {
    const { IntentRecognizer: Rec } = await import("../src/core/intent.js");
    const { Agent } = await import("../src/core/agent.js");
    const agent = new Agent();
    agent.registry.register(new CatalogSkill());
    const rec = new Rec(agent.registry);
    const cands = await rec.coarseCandidates(
      { user_text: "今天天气怎么样", last_skill: "" } as never,
      "今天天气怎么样",
    );
    expect(cands.has("catalog")).toBe(false);
  });
});
