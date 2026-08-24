/** 技能包机制测试：扫描注册 + yaml manifest */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SkillRegistry } from "../src/core/registry.js";
import type { Skill } from "../src/types/index.js";

let skillsDir = "";
let loadSkillManifest: any;
let scanSkills: any;

beforeAll(async () => {
  skillsDir = join(tmpdir(), `flyer-skills-${Date.now()}`);
  mkdirSync(join(skillsDir, "demo"), { recursive: true });
  writeFileSync(
    join(skillsDir, "demo", "skill.yaml"),
    `id: demo\nenabled: true\nmanifest:\n  name: 示例\n  description: 演示技能\n  intents: [demo_do]\n  trigger_keywords: [示例]\n  system_prompt: 演示规则\n`,
  );
  writeFileSync(
    join(skillsDir, "demo", "handlers.ts"),
    `import type { Skill, SkillManifest, SkillResult } from "../../src/types/index.js";\n` +
      `const manifest: SkillManifest = { id: "demo", name: "示例", description: "演示技能", intents: ["demo_do"], trigger_keywords: ["示例"] };\n` +
      `const skill: Skill = { manifest, handle: (): SkillResult => ({ status: "success", output: "demo ok", data: {} }) };\n` +
      `export default skill;\n`,
  );
  process.env.FLYER_SKILLS_DIR = skillsDir;
  // env 就绪后再动态 import（SKILLS_DIR 常量在 import 时求值）
  const mod = await import("../src/core/skills_loader.js");
  loadSkillManifest = mod.loadSkillManifest;
  scanSkills = mod.scanSkills;
});

afterAll(() => {
  rmSync(skillsDir, { recursive: true, force: true });
});

describe("技能包机制", () => {
  it("yaml manifest 解析（仓库即规范）", () => {
    const m = loadSkillManifest("demo");
    expect(m).not.toBeNull();
    expect(m?.id).toBe("demo");
    expect(m?.intents).toContain("demo_do");
    expect(m?.system_prompt).toBe("演示规则");
  });

  it("扫描 skills/ 自动注册", async () => {
    const reg = new SkillRegistry();
    const n = await scanSkills(reg);
    expect(n).toBe(1);
    expect(reg.resolve("demo_do")?.manifest.id).toBe("demo");
  });

  it("无 manifest 段 → 返回 null", () => {
    expect(loadSkillManifest("noskill")).toBeNull();
  });
});

describe("LLM 生成关键词（auto_keywords）", () => {
  it("generateKeywords 在无 LLM 时返回 null（dry-run 不生成）", async () => {
    const { generateKeywords } = await import("../src/core/skills_loader.js");
    const m = { id: "demo", name: "示例", description: "演示", intents: ["demo_do"] } as never;
    const r = await generateKeywords(m);
    expect(r).toBeNull();  // 测试环境 dry-run，不调 LLM
  });
});
