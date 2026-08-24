/** 用量记录：token 记账 + 缓存命中审计 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { config } from "./config.js";
import { logger } from "./log.js";

interface UsageAgg {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  total: number;
  cache_hits: number;
  saved_tokens: number;
}

const ZERO: UsageAgg = { calls: 0, prompt_tokens: 0, completion_tokens: 0, total: 0, cache_hits: 0, saved_tokens: 0 };

class UsageStore {
  private db: Database.Database | null = null;
  private memory = new Map<string, Map<string, UsageAgg>>(); // thread -> skill -> agg

  constructor() {
    if (config.usageStore === "sqlite") {
      mkdirSync(dirname(config.usageDbPath), { recursive: true });
      this.db = new Database(config.usageDbPath);
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS usage_events (
           id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT, skill_id TEXT,
           prompt_tokens INTEGER, completion_tokens INTEGER, total_tokens INTEGER)`,
      );
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS cache_events (
           id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT, skill_id TEXT, saved_tokens INTEGER)`,
      );
    }
  }

  record(thread: string, skill: string, prompt: number, completion: number): void {
    if (this.db) {
      this.db
        .prepare("INSERT INTO usage_events (thread_id, skill_id, prompt_tokens, completion_tokens, total_tokens) VALUES (?,?,?,?,?)")
        .run(thread, skill, prompt, completion, prompt + completion);
    } else {
      const agg = this.memory.get(thread)?.get(skill) ?? { ...ZERO };
      agg.calls += 1;
      agg.prompt_tokens += prompt;
      agg.completion_tokens += completion;
      agg.total += prompt + completion;
      this.ensure(thread).set(skill, agg);
    }
    logger.info("usage_event", { thread_id: thread, skill_id: skill, prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion });
  }

  recordCacheHit(thread: string, skill: string, savedTokens: number): void {
    if (this.db) {
      this.db.prepare("INSERT INTO cache_events (thread_id, skill_id, saved_tokens) VALUES (?,?,?)").run(thread, skill, savedTokens);
    } else {
      const agg = this.memory.get(thread)?.get(skill) ?? { ...ZERO };
      agg.cache_hits += 1;
      agg.saved_tokens += savedTokens;
      this.ensure(thread).set(skill, agg);
    }
    logger.info("cache_hit_event", { thread_id: thread, skill_id: skill, saved_tokens: savedTokens });
  }

  private ensure(thread: string): Map<string, UsageAgg> {
    let m = this.memory.get(thread);
    if (!m) {
      m = new Map();
      this.memory.set(thread, m);
    }
    return m;
  }

  skillUsage(skill: string): UsageAgg {
    if (this.db) {
      const r = this.db
        .prepare("SELECT COUNT(*) c, COALESCE(SUM(prompt_tokens),0) p, COALESCE(SUM(completion_tokens),0) co, COALESCE(SUM(total_tokens),0) t FROM usage_events WHERE skill_id=?")
        .get(skill) as { c: number; p: number; co: number; t: number };
      const ch = this.db
        .prepare("SELECT COUNT(*) c, COALESCE(SUM(saved_tokens),0) s FROM cache_events WHERE skill_id=?")
        .get(skill) as { c: number; s: number };
      return { calls: r.c, prompt_tokens: r.p, completion_tokens: r.co, total: r.t, cache_hits: ch.c, saved_tokens: ch.s };
    }
    const agg = { ...ZERO };
    for (const skills of this.memory.values()) {
      const s = skills.get(skill);
      if (s) {
        for (const k of Object.keys(agg) as Array<keyof UsageAgg>) agg[k] += s[k];
      }
    }
    return agg;
  }
}

export const usage = new UsageStore();

/** 全局累计 total token（不限 skill，用于计算执行增量） */
export function totalAllTokens(): number {
  const skills = new Set<string>();
  // memory 模式遍历所有
  for (const thread of (usage as unknown as { memory: Map<string, Map<string, UsageAgg>> }).memory?.values() ?? []) {
    for (const skillId of thread.keys()) skills.add(skillId);
  }
  let total = 0;
  for (const s of skills) total += usage.skillUsage(s).total;
  return total;
}

/** 读指定 thread+skill 的当前累计 total token（用于计算执行增量） */
export function currentTotalTokens(thread: string, skill: string): number {
  return usage.skillUsage(skill).total;
}
