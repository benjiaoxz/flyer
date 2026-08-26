/** embedding 层测试：Ollama/Cloud embedder 成功/失败路径 + getEmbedder 分支 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/core/config.js";

// 直接测类（不依赖 getEmbedder 单例缓存）
let OllamaEmbedder: typeof import("../src/core/embedding.js").OllamaEmbedder;
let CloudEmbedder: typeof import("../src/core/embedding.js").CloudEmbedder;

beforeEach(async () => {
  const mod = await import("../src/core/embedding.js");
  OllamaEmbedder = mod.OllamaEmbedder;
  CloudEmbedder = mod.CloudEmbedder;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OllamaEmbedder", () => {
  it("embed 成功 → 返回向量", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ embeddings: [[0.1, 0.2]] }) })));
    const e = new OllamaEmbedder("http://ollama:11434", "bge-m3");
    expect(e.name()).toBe("ollama:bge-m3");
    const v = await e.embed("你好");
    expect(v).toEqual([0.1, 0.2]);
  });

  it("embed 失败（网络/非 2xx）→ 返回 null 不抛异常（缓存降级）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connection refused"); }));
    const e = new OllamaEmbedder("http://ollama:11434", "bge-m3");
    expect(await e.embed("你好")).toBeNull();
  });

  it("响应无 embeddings 字段 → 返回 null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    const e = new OllamaEmbedder("http://ollama:11434", "bge-m3");
    expect(await e.embed("你好")).toBeNull();
  });
});

describe("CloudEmbedder", () => {
  it("embed 成功 → 返回向量，带 Bearer 头", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ embedding: [1, 2] }] }) }));
    vi.stubGlobal("fetch", fetchMock);
    const e = new CloudEmbedder("sk-test", "embed-v3", "http://cloud/v1");
    expect(e.name()).toBe("cloud:embed-v3");
    const v = await e.embed("你好");
    expect(v).toEqual([1, 2]);
    const call = fetchMock.mock.calls[0] as unknown as [string, { headers: { Authorization: string } }];
    expect(call[1].headers.Authorization).toBe("Bearer sk-test");
  });

  it("embed 失败 → 返回 null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("timeout"); }));
    const e = new CloudEmbedder("sk-test", "embed-v3", "http://cloud/v1");
    expect(await e.embed("你好")).toBeNull();
  });
});

describe("getEmbedder 配置分支", () => {
  it("embeddingProvider 为空 → embedder 为 null（缓存禁用）", async () => {
    const { getEmbedder } = await import("../src/core/embedding.js");
    config.embeddingProvider = "" as never;
    expect(getEmbedder()).toBeNull();
  });
});
