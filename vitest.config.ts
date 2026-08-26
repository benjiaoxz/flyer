import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    env: {
      // 测试环境固定 dry-run：不调真实 LLM（意图识别走规则兜底，结果确定）
      AGENT_DRY_RUN: "true",
      EMBEDDING_PROVIDER: "",
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 70,
      },
    },
  },
});
