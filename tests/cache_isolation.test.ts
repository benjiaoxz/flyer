/** P0 回归：语义缓存按用户隔离——A 的查询结果不得命中给 B
 * （修复前 cache namespace 无用户维度，catalog_query 等可缓存意图会跨用户泄露） */
import { describe, expect, it, vi } from "vitest";

import { Agent } from "../src/core/agent.js";
import { getCache } from "../src/core/cache.js";
import { BaseSkill } from "../src/core/registry.js";
import type { GenericState, SkillManifest, SkillResult } from "../src/types/index.js";

// mock embedder：固定向量使语义缓存生效（cosine=1 ≥ 阈值）
vi.mock("../src/core/embedding.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/core/embedding.js")>();
  return {
    ...orig,
    getEmbedder: () => ({ name: () => "fake:v1", embed: async () => [1, 0, 0] }),
    embedText: async () => [1, 0, 0],
  };
});

class EchoSkill extends BaseSkill {
  readonly manifest: SkillManifest = {
    id: "echo", name: "回声", description: "返回用户 id（检测缓存是否跨用户）",
    intents: ["new_request"], max_turns_per_session: 5,
  };
  handle(state: GenericState): SkillResult {
    return { status: "success", output: `echo-${state.user_id}`, data: {} };
  }
}

describe("语义缓存用户隔离", () => {
  it("用户 B 相同问题不命中用户 A 的缓存（输出各自用户 id）", async () => {
    getCache().clear();
    const agent = new Agent();
    agent.registry.register(new EchoSkill());
    const a = await agent.start({ user_text: "你好", user_id: "userA", user_ctx: null }, "t-a");
    const b = await agent.start({ user_text: "你好", user_id: "userB", user_ctx: null }, "t-b");
    expect(a.output).toBe("echo-userA");
    expect(b.output).toBe("echo-userB"); // 修复前：命中 A 的缓存返回 echo-userA
  });
});
