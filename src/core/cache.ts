/** 语义缓存：重复/相似问题命中直接返回（）
 * 向量存储可插拔：memory（进程内）/ sqlite（落盘）
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { config } from "./config.js";
import { embedText, getEmbedder } from "./embedding.js";
import { logger } from "./log.js";

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  const dot = a.reduce((s, x, i) => s + x * b[i]!, 0);
  const na = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
  const nb = Math.sqrt(b.reduce((s, x) => s + x * x, 0));
  return na && nb ? dot / (na * nb) : 0;
}

interface CacheEntry {
  result: unknown;
  saved_tokens: number;
  vector: number[];
}

export class SemanticCache {
  private items = new Map<string, CacheEntry>(); // memory 模式
  private db: Database.Database | null = null;

  constructor(threshold = config.cacheThreshold) {
    this.threshold = threshold;
    if (config.vectorStore === "sqlite") {
      mkdirSync(dirname(config.vectorDbPath), { recursive: true });
      this.db = new Database(config.vectorDbPath);
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS cache_entries (key TEXT, namespace TEXT, busting TEXT, vector TEXT, result TEXT, saved_tokens INTEGER)",
      );
    }
  }

  readonly threshold: number;

  get enabled(): boolean {
    return getEmbedder() !== null;
  }

  private key(text: string): string {
    return createHash("sha256").update(text).digest("hex").slice(0, 16);
  }

  private ns(namespace: string, busting: string): string {
    const emb = getEmbedder();
    const name = emb ? emb.name() : "noembed";
    return `${namespace}:${name}:${busting}`;
  }

  async tryGet(query: string, namespace = "default", busting = "1"): Promise<CacheEntry | null> {
    const vec = await embedText(query);
    if (!vec) return null;
    const targetNs = this.ns(namespace, busting);
    let best: { sim: number; entry: CacheEntry } | null = null;
    if (this.db) {
      const rows = this.db
        .prepare("SELECT vector, result, saved_tokens FROM cache_entries WHERE namespace=? AND busting=?")
        .all(targetNs, busting) as Array<{ vector: string; result: string; saved_tokens: number }>;
      for (const row of rows) {
        const sim = cosineSimilarity(vec, JSON.parse(row.vector));
        if (sim >= this.threshold && (!best || sim > best.sim)) {
          best = { sim, entry: { vector: JSON.parse(row.vector), result: JSON.parse(row.result), saved_tokens: row.saved_tokens } };
        }
      }
    } else {
      for (const [k, entry] of this.items) {
        if (!k.startsWith(targetNs + ":")) continue;
        const sim = cosineSimilarity(vec, entry.vector);
        if (sim >= this.threshold && (!best || sim > best.sim)) {
          best = { sim, entry };
        }
      }
    }
    return best?.entry ?? null;
  }

  async save(query: string, result: unknown, namespace = "default", busting = "1", savedTokens = 0): Promise<void> {
    const vec = await embedText(query);
    if (!vec || !result) return;
    const targetNs = this.ns(namespace, busting);
    if (this.db) {
      this.db
        .prepare("INSERT INTO cache_entries (key, namespace, busting, vector, result, saved_tokens) VALUES (?,?,?,?,?,?)")
        .run(this.key(query), targetNs, busting, JSON.stringify(vec), JSON.stringify(result), savedTokens);
    } else {
      this.items.set(`${targetNs}:${this.key(query)}`, { vector: vec, result, saved_tokens: savedTokens });
    }
  }

  clear(): void {
    if (this.db) {
      this.db.exec("DELETE FROM cache_entries");
    } else {
      this.items.clear();
    }
  }
}

let cache: SemanticCache | null = null;

export function getCache(): SemanticCache {
  if (!cache) cache = new SemanticCache();
  return cache;
}
