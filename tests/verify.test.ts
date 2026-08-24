/** P2 结果验证测试：Skill.verify 机制（自证通过/不通过/异常） */
import { describe, expect, it } from "vitest";

import { Agent } from "../src/core/agent.js";
import { BaseSkill } from "../src/core/registry.js";
import type { SkillManifest, SkillResult } from "../src/types/index.js";

class VerifyingSkill extends BaseSkill {
  verifyImpl: (result: SkillResult) => Promise<boolean> | boolean = () => true;
  readonly manifest: SkillManifest = {
    id: "verifyskill", name: "验证技能", description: "有 verify",
    intents: ["new_request", "vs_do"], max_turns_per_session: 5,
  };
  handle(): SkillResult {
    return { status: "success", output: "写入完成", data: { product_id: 1 } };
  }
  verify(): Promise<boolean> | boolean {
    return this.verifyImpl({ status: "success", output: "写入完成", data: { product_id: 1 } });
  }
}

class NoVerifySkill extends BaseSkill {
  readonly manifest: SkillManifest = {
    id: "noverify", name: "无验证", description: "没有 verify",
    intents: ["new_request", "nv_do"], max_turns_per_session: 5,
  };
  handle(): SkillResult {
    return { status: "success", output: "普通完成", data: {} };
  }
}

describe("P2 结果验证", () => {
  it("verify 通过 → 正常 success", async () => {
    const agent = new Agent();
    agent.registry.register(new VerifyingSkill());
    const snap = await agent.start("写入", "p2-1");
    expect(snap.output).toBe("写入完成");
    expect(snap.task.steps.some((s) => s.name === "verify" && s.status === "success")).toBe(true);
    expect(snap.task.failed_at).toBeUndefined();
  });

  it("verify 不通过 → 按失败处理（failed_at=verify，不存缓存）", async () => {
    const agent = new Agent();
    const skill = new VerifyingSkill();
    skill.verifyImpl = () => false;
    agent.registry.register(skill);
    const snap = await agent.start("写入", "p2-2");
    expect(snap.output).toContain("未通过验证");
    expect(snap.task.failed_at).toBe("verify");
    const step = snap.task.steps.find((s) => s.name === "execute:verifyskill");
    expect(step?.status).toBe("error");
    expect(step?.detail).toContain("verify_failed");
  });

  it("verify 抛异常 → 视为不通过", async () => {
    const agent = new Agent();
    const skill = new VerifyingSkill();
    skill.verifyImpl = () => {
      throw new Error("回读失败");
    };
    agent.registry.register(skill);
    const snap = await agent.start("写入", "p2-3");
    expect(snap.task.failed_at).toBe("verify");
  });

  it("无 verify 的技能 → 不受影响（正常 success）", async () => {
    const agent = new Agent();
    agent.registry.register(new NoVerifySkill());
    const snap = await agent.start("写入", "p2-4");
    expect(snap.output).toBe("普通完成");
    expect(snap.task.failed_at).toBeUndefined();
  });
});
