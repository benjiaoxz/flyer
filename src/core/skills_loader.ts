/** 技能包加载器：扫描 skills/ 目录自动注册 + skill.yaml manifest 解析
 * 
 * 约定：skills/<id>/skill.yaml（manifest 段）+ handlers.ts（默认导出 Skill 实例）
 */
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

import { logger } from "./log.js";
import { SkillRegistry } from "./registry.js";
import type { Skill, SkillManifest } from "../types/index.js";

// 技能包目录：相对本模块位置推导（src/core/../../skills → src/skills），不依赖 cwd
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const SKILLS_DIR = process.env.FLYER_SKILLS_DIR || join(MODULE_DIR, "..", "skills");

const MANIFEST_FIELDS = [
  "name", "description", "intents", "intent_descriptions", "cacheable_intents", "trigger_keywords", "system_prompt",
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
      // auto_keywords：用 LLM 从意图描述生成关键词，与手写合并
      if (skill.manifest.auto_keywords) {
        const generated = await generateKeywords(skill.manifest);
        if (generated?.length) {
          const merged = [...new Set([...(skill.manifest.trigger_keywords ?? []), ...generated])];
          skill.manifest.trigger_keywords = merged;
          logger.info(`技能 ${skillId} LLM 生成关键词: ${generated.join("、")}`);
        }
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

/** LLM 生成 trigger_keywords：从技能描述/意图描述推断用户可能的触发说法。
 * auto_keywords=true 时调用；失败返回 null（回落到手写关键词）。
 */
export async function generateKeywords(manifest: SkillManifest): Promise<string[] | null> {
  const { config } = await import("./config.js");
  if (config.dryRun || !config.llmApiKey) return null;  // 无 LLM 不生成
  const { ChatOpenAI } = await import("@langchain/openai");
  const { z } = await import("zod");
  try {
    const model = new ChatOpenAI({
      model: config.llmModel,
      apiKey: config.llmApiKey,
      configuration: { baseURL: config.llmBaseUrl },
    }).withStructuredOutput(
      z.object({ keywords: z.array(z.string()) }),
      { method: "functionCalling" },
    );
    const intentDesc = Object.entries(manifest.intent_descriptions ?? {})
      .map(([k, v]) => `${k}: ${v}`).join("\n");
    const res = (await model.invoke([
      {
        role: "system",
        content: "你是技能关键词生成器。根据技能职责和意图描述，列出用户可能用来触发这个技能的中文短词。要求：1) 每个词 2-4 个汉字，优先动作词（如\"上架\"\"撤下\"\"调价\"）和核心业务词（如\"商品\"\"库存\"\"价格\"\"名称\"）；2) 覆盖口语说法（如\"看看\"\"调一下\"\"改改\"）；3) 不要复合长短语（如\"撤下商品\"应拆为\"撤下\"和\"商品\"）。只返回关键词列表。",
      },
      {
        role: "user",
        content: `技能：${manifest.name}（${manifest.description}）\n意图：\n${intentDesc || "（无）"}`,
      },
    ])) as { keywords: string[] };
    // 去重 + 过滤太短的
    const kws = [...new Set(res.keywords.filter((k) => k.length >= 2))];
    return kws.length ? kws : null;
  } catch (e) {
    console.warn(`生成关键词失败（${manifest.id}）: ${String(e)}`);
    return null;
  }
}
