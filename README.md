# Flyer 通用对话 Agent 框架（TypeScript）

**model + harness** 架构：LLM 做语义决策，harness（框架）做执行/边界/记账/反馈。
业务能力以**技能（Skill）插件**形式外部提供，框架零改动。

> 原 Python 版已重写为 TypeScript（重写动机：类型系统/生态）。架构决策语言无关，
> 完整设计见 [docs/](docs/)（harness 五子系统、JWT 四层鉴权、SkillResult 契约、任务状态、执行目录）。

## 核心能力（harness）

- **对话引擎**：意图识别（历史感知 + 关键词预筛）→ 技能路由 → 记忆写入
- **结果契约**：`SkillResult`（status 必填 success/error，error 必填 reason）——zod 校验，契约违规可观测
- **结果反馈**：技能执行成败记录（环节/原因）+ 失败不存语义缓存
- **任务状态**：任务 id + 步骤轨迹（intent/execute/技能子步骤）+ 失败定位 failed_at
- **语义缓存**：可插拔 embedding（ollama/cloud）+ 向量存储（memory/sqlite），重复问题命中直接返回
- **JWT 鉴权**：业务方签发 JWT（RS256）→ 验证 → UserContext（角色/技能白名单/数据域）强制裁剪
- **技能包机制**：`skills/<id>/` 拷入即自动注册（skill.yaml 声明 + handlers.ts 实现）

## 技术栈

```
Node 22+ / TypeScript strict / vitest
@langchain/langgraph（三节点：intent → dispatch → remember）
Fastify（API） / zod（契约）/ jose（JWT RS256）/ better-sqlite3（存储）
```

## 快速开始

```bash
npm install
cp .env.example .env        # 填 LLM_API_KEY（或 DEEPSEEK_API_KEY）
npm run api                 # 启动 Fastify API（默认 8099）
```

```bash
npm test                    # 22 个测试（vitest）
```

## 与 flyer-biz（业务服务器）联调

```
商家登录 flyer-biz → JWT（sub/role/scopes/skills）
  → 调 flyer /api/chat（Bearer JWT）
  → flyer 验证 RS256 公钥 → UserContext → 技能白名单强制
  → 技能调 flyer-biz 业务 API（X-Biz-Key + 透传 JWT）
```

配置见 `.env.example`（`AUTH_MODE=none/api_key/jwt`；`JWT_PUBLIC_KEY` = flyer-biz 公钥 base64）。

## 项目文档

- [**架构与流程图**](docs/ARCHITECTURE.md) — core 架构 + harness 五子系统 + 单轮请求时序
- [**演进清单**](ROADMAP.md) — M6 harness 加固排期（P0 结果契约 / P1 指令声明层+任务状态 / P2 结果验证 / P3 执行目录）
- [**PRD**](docs/PRD.md) / [**API 文档**](docs/API.md)
