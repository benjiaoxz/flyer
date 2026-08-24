/** Agent 核心测试：三节点流程 + 意图路由 + 用户隔离 */
import { describe, expect, it, vi } from "vitest";

import { Agent } from "../src/core/agent.js";
import { BaseSkill } from "../src/core/registry.js";
import type { SkillManifest, SkillResult } from "../src/types/index.js";

class GreetSkill extends BaseSkill {
  readonly manifest: SkillManifest = {
    id: "greet",
    name: "打招呼",
    description: "处理打招呼/问候",
    intents: ["new_request", "greet"],
    max_turns_per_session: 5,
  };
  handle(): SkillResult {
    return { status: "success", output: "你好！", data: {} };
  }
}

describe("Agent 三节点", () => {
  it("意图路由到技能，输出进入 state，记忆写入", async () => {
    const agent = new Agent();
    agent.registry.register(new GreetSkill());
    const snap = await agent.start("你好", "t-1");
    expect(snap.last_skill).toBe("greet");
    expect(snap.messages.length).toBe(2);
    expect(snap.messages[0].type).toBe("human");
    expect(snap.messages[1].type).toBe("ai");
    expect(snap.task.id).toBeTruthy();
  });

  it("任务轨迹含 intent + execute 步骤", async () => {
    const agent = new Agent();
    agent.registry.register(new GreetSkill());
    const snap = await agent.start("你好", "t-2");
    const names = snap.task.steps.map((s) => s.name);
    expect(names).toContain("intent:new_request");
    expect(names).toContain("execute:greet");
  });

  it("无技能时 fallback 回复", async () => {
    const agent = new Agent();
    const snap = await agent.start("你好", "t-3");
    expect(snap.output).toContain("无法处理");
  });
});

describe("用户隔离（JWT 白名单）", () => {
  it("白名单外技能被拦截", async () => {
    const agent = new Agent();
    agent.registry.register(new GreetSkill());
    const snap = await agent.start({
      user_text: "你好",
      user_id: "2",
      user_ctx: { user_id: "2", role: "merchant", allowed_skills: ["order"], data_scopes: [] },
    }, "t-4");
    expect(snap.output).toContain("无权使用");
    expect(snap.task.failed_at).toBe("boundary");
  });

  it("白名单内技能放行", async () => {
    const agent = new Agent();
    agent.registry.register(new GreetSkill());
    const snap = await agent.start({
      user_text: "你好",
      user_id: "2",
      user_ctx: { user_id: "2", role: "merchant", allowed_skills: ["greet"], data_scopes: [] },
    }, "t-5");
    expect(snap.last_skill).toBe("greet");
  });
});

describe("结果契约（M3）", () => {
  class BoomSkill extends BaseSkill {
    readonly manifest: SkillManifest = {
      id: "boom", name: "爆炸", description: "抛异常",
      intents: ["new_request", "boom_do"], max_turns_per_session: 5,
    };
    handle(): SkillResult {
      throw new Error("模拟技能崩溃");
    }
  }

  class FailSkill extends BaseSkill {
    readonly manifest: SkillManifest = {
      id: "failskill", name: "失败技能", description: "标记失败",
      intents: ["new_request", "fail_do"], max_turns_per_session: 5,
    };
    handle(): SkillResult {
      return { status: "error", output: "写入订单失败：库存不足", reason: "库存不足", data: {} };
    }
  }

  class BadContractSkill extends BaseSkill {
    readonly manifest: SkillManifest = {
      id: "badcontract", name: "坏契约", description: "返回不合规",
      intents: ["new_request", "bc_do"], max_turns_per_session: 5,
    };
    handle(): any {
      return { output: "忘了标 status" };  // 故意违反契约
    }
  }

  it("技能抛异常 → 不崩 + 友好错误", async () => {
    const agent = new Agent();
    agent.registry.register(new BoomSkill());
    const snap = await agent.start("触发", "m3-1");
    expect(snap.output).toContain("执行出错");
    expect(snap.task.failed_at).toBe("execute");
  });

  it("status=error 业务失败 → failed_at=execute", async () => {
    const agent = new Agent();
    agent.registry.register(new FailSkill());
    const snap = await agent.start("失败一下", "m3-2");
    expect(snap.task.failed_at).toBe("execute");
    const step = snap.task.steps.find((s) => s.name === "execute:failskill");
    expect(step?.status).toBe("error");
    expect(step?.detail).toContain("库存不足");
  });

  it("契约违规（缺 status）→ error + failed_at", async () => {
    const agent = new Agent();
    agent.registry.register(new BadContractSkill());
    const snap = await agent.start("随便", "m3-3");
    expect(snap.output).toContain("不合规");
    expect(snap.task.failed_at).toBe("execute");
  });

  it("成功技能 → 正常输出 + success 步骤", async () => {
    const agent = new Agent();
    agent.registry.register(new GreetSkill());
    const snap = await agent.start("你好", "m3-4");
    expect(snap.output).toBe("你好！");
    const step = snap.task.steps.find((s) => s.name === "execute:greet");
    expect(step?.status).toBe("success");
  });
});
