/** 技能包加载器：扫描 skills/ 目录自动注册 + skill.yaml manifest 解析
 * 对齐 Python 版 core/skills_loader.py
 * 约定：skills/<id>/skill.yaml（manifest 段）+ handlers.ts（默认导出 Skill 实例）
 */
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { logger } from "./log.js";
import { SkillRegistry } from "./registry.js";
import type { Skill, SkillManifest } from "../types/index.js";

export const SKILLS_DIR = process.env.FLYER_SKILLS_DIR || join(process.cwd(), "skills");

const MANIFEST_FIELDS = [
  "name", "description", "intents", "trigger_keywords", "system_prompt",
  "session_mode", "max_turns_per_session", "max_llm_calls_per_turn",
  "token_budget_per_session", "data_scopes", "tools",
  "requires_confirmation", "confirmation_after",
];

export function loadSkillManifest(skillId: string): SkillManifest | null {
  const yamlPath = join(SKILLS_DIR, skillId, "skill.yaml");
  if (!existsSync(yamlPath)) return null;
  try {
    const raw = parseYaml(readFileSync(yamlPath, "utf8")) as Record<string, unknown>;
    const decl = (raw.manifest ?? {}) as Record<string, unknown>;
    if (!Object.keys(decl).length) return null;
    const filtered: Record<string, unknown> = {};
    for (const k of MANIFEST_FIELDS) {
      if (k in decl) filtered[k] = decl[k];
    }
    return { id: skillId, intents: [], ...(filtered as Partial<SkillManifest>) } as SkillManifest;
  } catch (e) {
    logger.warn(`读取技能声明 ${skillId} 失败: ${String(e)}`);
    return null;
  }
}

export async function scanSkills(registry: SkillRegistry): Promise<number> {
  if (!existsSync(SKILLS_DIR)) return 0;
  let count = 0;
  for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const skillId = entry.name;
    // enabled 检查
    const yamlPath = join(SKILLS_DIR, skillId, "skill.yaml");
    if (existsSync(yamlPath)) {
      const raw = parseYaml(readFileSync(yamlPath, "utf8")) as Record<string, unknown>;
      if (raw.enabled === false) {
        logger.info(`技能 ${skillId} 被 skill.yaml 禁用，跳过`);
        continue;
      }
    }
    const handlersPath = join(SKILLS_DIR, skillId, "handlers.ts");
    if (!existsSync(handlersPath)) continue;
    try {
      const mod = await import(`file://${handlersPath}`);
      const skill = mod.default as Skill;
      if (!skill || !skill.manifest) {
        logger.warn(`技能 ${skillId} 未导出 Skill（default），跳过`);
        continue;
      }
      registry.register(skill);
      count += 1;
      logger.info(`自动注册技能: ${skillId}`);
    } catch (e) {
      logger.warn(`加载技能 ${skillId} 失败: ${String(e)}`);
    }
  }
  return count;
}
