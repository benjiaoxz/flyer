/** 技能注册表（对齐 Python 版 core/registry.py） */
import type { Skill, SkillManifest } from "../types/index.js";
import { logger } from "./log.js";

export class SkillRegistry {
  private skills = new Map<string, Skill>();
  private intentMap = new Map<string, string>();

  register(skill: Skill): void {
    if (this.skills.has(skill.manifest.id)) {
      logger.warn(`技能 ${skill.manifest.id} 重复注册，覆盖`);
    }
    this.skills.set(skill.manifest.id, skill);
    for (const intent of skill.manifest.intents) {
      this.intentMap.set(intent, skill.manifest.id);
    }
  }

  resolve(intent: string): Skill | null {
    const id = this.intentMap.get(intent);
    return id ? this.skills.get(id) ?? null : null;
  }

  allIntents(): string[] {
    return [...this.intentMap.keys()];
  }

  list(): Skill[] {
    return [...this.skills.values()];
  }
}

/** Skill 基类辅助（manifest 从 yaml 加载或传入） */
export abstract class BaseSkill implements Skill {
  abstract readonly manifest: SkillManifest;
  abstract handle(state: any, intent: any, newText: string): any;
}
