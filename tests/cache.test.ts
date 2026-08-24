/** 语义缓存测试 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cosineSimilarity, SemanticCache } from "../src/core/cache.js";
import { getEmbedder } from "../src/core/embedding.js";

// mock embedder：确定性向量
vi.mock("../src/core/embedding.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/core/embedding.js")>();
  const v1 = [1, 0, 0];
  const v2 = [0.99, 0.01, 0];
  const v3 = [0, 1, 0];
  const map = new Map<string, number[]>([
    ["今天天气怎么样", v1],
    ["今天天气如何", v2],
    ["明天开会吗", v3],
  ]);
  return {
    ...orig,
    getEmbedder: () => ({ name: () => "fake:m1", embed: async (t: string) => map.get(t) ?? null }),
    embedText: async (t: string) => map.get(t) ?? null,
  };
});

describe("语义缓存", () => {
  it("cosine 相似度", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBe(1);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBe(0);
    expect(cosineSimilarity([1, 0, 0], [0.99, 0.01, 0])).toBeGreaterThan(0.99);
  });

  it("命中返回结果，语义相近也命中", async () => {
    const cache = new SemanticCache(0.9);
    await cache.save("今天天气怎么样", "晴 25 度", "ns_test");
    expect(await cache.tryGet("今天天气怎么样", "ns_test")).not.toBeNull();
    expect(await cache.tryGet("今天天气如何", "ns_test")).not.toBeNull();
    expect(await cache.tryGet("明天开会吗", "ns_test")).toBeNull();
  });

  it("跨技能隔离", async () => {
    const cache = new SemanticCache(0.9);
    await cache.save("今天天气怎么样", "晴", "weather");
    expect(await cache.tryGet("今天天气怎么样", "order")).toBeNull();
  });
});
