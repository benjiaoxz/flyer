# Flyer 商城智能交互网关

**商城界面（运营后台/前端）与业务系统之间的 Agent 编排层**：把自然语言请求变成对业务系统的可信执行——理解 → 鉴权 → 编排 → 执行 → 反馈。

- **理解**：意图识别（历史感知 + 关键词预筛）
- **鉴权**：JWT 用户断言（角色/技能白名单/数据域）强制裁剪
- **编排**：技能路由 + 多步执行（人工确认闸门规划中，见 ROADMAP M4）
- **执行**：调业务系统 API（业务能力以 Skill 插件形式接入）
- **反馈**：结果契约（SkillResult）/ 失败定位 / 任务轨迹 / 用量审计

> 业务系统为外部系统（商城后端），网关通过业务 API 对接，业务能力以 Skill 插件接入。完整设计见 [docs/](docs/)。

## 核心能力（harness）

- **对话引擎**：意图识别（历史感知 + 关键词预筛）→ 技能路由 → 记忆写入
- **结果契约**：`SkillResult`（status 必填 success/error，error 必填 reason）——zod 校验，契约违规可观测
- **结果反馈**：技能执行成败记录（环节/原因）+ 失败不存语义缓存
- **任务状态**：任务 id + 步骤轨迹（intent/execute/技能子步骤）+ 失败定位 failed_at
- **语义缓存**：可插拔 embedding（ollama/cloud）+ 向量存储（memory/sqlite），重复问题命中直接返回
- **JWT 鉴权**：业务方签发 JWT（RS256）→ 验证 → UserContext（角色/技能白名单/数据域）强制裁剪
- **技能包机制**：`src/skills/<id>/` 即自动注册（skill.yaml 声明 + handlers.ts 实现 + **README.md 技能文档**——每个技能包自带文档，说明用途/意图/流程/边界，见 `src/skills/catalog/` 范例）

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
npm test                    # 100 个测试（vitest）
```

> **开发环境**：网关开发与测试不依赖任何外部服务——技能单元测试全部 mock（`AGENT_DRY_RUN` 下无需 LLM key）。
> 与业务系统端到端联调为可选项：按 [docs/ChatBI.md](docs/ChatBI.md) 接入契约自备业务系统即可。

## 与业务系统对接（接入契约）

```
商城用户登录业务系统 → JWT（sub/role/scopes/skills，业务系统签发，见 docs/ChatBI.md §2.2 最小契约）
  → 调 flyer /api/chat（Bearer JWT）
  → flyer 验证 RS256 公钥 → UserContext → 技能白名单强制
  → 技能调业务系统 API（X-Biz-Key + 透传 JWT，路径/结构为技能与业务系统的约定）
```

配置见 `.env.example`（`AUTH_MODE=none/api_key/jwt`；`JWT_PUBLIC_KEY` = 业务系统签发的公钥 base64；`BIZ_BASE_URL`/`BIZ_API_KEY` = 业务系统对接）。
接入其他业务系统：按 JWT 契约配置身份 → 按技能约定实现业务 API（如 report 需 `/api/stats`，见 [docs/ChatBI.md](docs/ChatBI.md)）→ 网关即连通。

## 项目文档

- [**架构与流程图**](docs/ARCHITECTURE.md) — core 架构 + harness 五子系统 + 单轮请求时序
- [**演进清单**](ROADMAP.md) — M6 harness 加固排期（P0 结果契约 / P1 指令声明层+任务状态 / P2 结果验证）
- [**PRD**](docs/PRD.md) / [**API 文档**](docs/API.md)
