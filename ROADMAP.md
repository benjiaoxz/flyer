# 演进清单：Flyer 商城智能交互网关后续需求

> 当前项目 = 商城智能交互网关（界面与业务系统之间的 Agent 编排层）；业务能力以技能插件接入。
> 本文记录网关后续需求，主线为"**可信执行**"（结果契约/反馈/验证 + 业务技能对接）。

## 阶段总览

| 阶段 | 内容 | 状态 |
|---|---|---|
| M1 core 基础 | 引擎/意图/记忆/持久化/日志/示例技能 | ✅ 完成 |
| M2 数据接入 | Agent 连数据库（示例）+ mock 测试 | ✅ 完成 |
| M3 资源边界 | 用量记录/单次控制/配额/技能策略/语义缓存（token 治理） | ✅ 完成 |
| M4 安全边界 | 数据/工具白名单 + 高危闸门 + 审计报表 + API 鉴权/限流（权限） | ✅ 完成 |
| M5 演进预留 | 子图/Store/摘要向量 | ⬜ 按需 |

> 主线心智模型：**技能通过一个 manifest 声明"能花多少 / 能碰什么 / 什么要批准"**，core 强制执行。
> M3 管"能花多少"（资源），M4 管"能碰什么/什么要批准"（安全），最终合为 SkillBoundary（ARCHITECTURE §7）。

---

## M3：资源边界（token 治理，按 P0→P3 推进）

### P0 用量记录升级 + max_tokens（改动小，先行）
- [x] 用量收集雏形（`core/llm.py` UsageCollector：全局累计）——已具备
- [x] 升级为**按会话（thread_id）+ 技能（manifest.id）**拆分（core/usage.py）
- [x] **持久化**：每次调用落 JSON 日志事件（usage_event：thread/技能/输入输出 token）
- [x] `max_tokens` 单次输出上限（2048，core/llm.py）

### P1 语义缓存 + 会话级配额（框架价值大）
- [x] **语义缓存**（`core/cache.py` + `core/embedding.py`）：可插拔 embedding（ollama/cloud），命中跳过 LLM，busting 失效
- [x] **向量存储可插拔**（`VECTOR_STORE`）：memory（默认）/ sqlite（落盘，跨进程/重启保留）/ pgvector（生产预留）
- [x] **会话配额**（`core/limits.py`）：轮数上限 + token 预算，超限强制拒绝/告警

### P2 技能资源策略（机制入框架）
- [x] manifest 增加：`session_mode`/`max_llm_calls_per_turn`/`data_scopes`/`tools`/`requires_confirmation`
- [x] core 按 manifest 校验：轮数/预算/白名单/闸门（dispatch 拦截器）
- [x] 补充：single 模式意图识别不喂历史（core/intent.py `_last_skill_is_single`）；每轮 LLM 调用数计数接入 dispatch（core/agent.py）
- [ ] 业务技能外部提供（Skill 插件机制已就绪，业务技能按需开发/引入）

### P3 预留接口（等痛点出现）
- [ ] `core/context.py` 预留：历史摘要接口、向量检索接口
- [ ] 触发条件：滑动窗口丢早期信息成为真实体验问题

### P4 意图预筛增强（trigger_keywords 粗筛已落地，以下等技能量起来再做）
- [ ] **embedding 召回**：关键词覆盖不到的语义说法（如"帮我记一下周三下午三点"），复用 `core/cache.py` 的 embedding 通道（ollama/cloud）做相似度召回——粗筛零命中时按相似度取 top-k，避免误伤 fallback
- [ ] **真实 LLM 验证**：技能多起来后在真实模型下评测候选注入准确率（命中率 / 意图选择是否被稀释 / 零候选误伤率），据结果调关键词与 top-k 策略

---

## M4：安全边界（权限，与 M3 合为 SkillBoundary）

- [x] **API 鉴权**：Bearer API Key（`AUTH_MODE=api_key`，`core/security.py`）
- [x] **限流**：按调用方身份内存滑窗（`RATE_LIMIT_PER_MINUTE`，多副本可升级 Redis/PG）
- [x] **数据/工具白名单**：`data_scopes`/`tools` 已实现，工具/数据层运行时拦截
- [x] **高危操作闸门**：`requires_confirmation` + `confirmation_after`，interrupt 确认（已实现）
- [x] **边界校验告警**：校验失败 = 日志 + 告警（limits.py enforce）
- [x] **用户隔离**：用户上下文（core/user.py）按用户裁剪技能/数据域（USER_PROVIDER=db）
- [x] **审计报表**：`GET /api/usage` 按技能/会话汇总用量（拦截记录有日志告警）
- [ ] 用户体系/角色：**归业务方**，框架只留接入点（user_id 透传已有）

---

## M6：对话 Agent harness 加固（未应用期排期，按序执行）

> 审视来源：harness 五子系统模型（指令/工具/环境/状态/反馈）对照。
> 前提：项目未进入正式应用，无"老技能"包袱，可推翻重做。

| 优先级 | 内容 | 状态 |
|---|---|---|
| **P0** | 结果契约：SkillResult（status 必填，success/error + reason），harness 强制校验，契约违规记 outcome(stage=contract) | ✅ 完成 |
| **P1-a** | 指令声明层：技能完整对外契约 yaml 化（intent/描述/关键词/约束从 handlers.py 抽出），意图识别 prompt 模板化（system 部分可配置） | ✅ 完成 |
| **P1-b** | 任务状态模型：状态里定义"任务"一等公民（任务 id/步骤序列/当前步骤/每步成败），checkpointer 持久化 | ✅ 完成 |
| P2 | 结果验证：技能执行后自证（如写操作后回读确认，按技能逐个加） | ⬜ 未开始 |
| P3 | 执行目录（workspace）：core 机制（任务级透传/用户级解析/三层上下文）+ skill 语义（workspace 技能读 AGENTS.md） | ⬜ 未开始 |

### P0：结果契约（SkillResult）

- [x] core/types.py：SkillResult（status: Literal[success,error] 必填 / output / reason / data / output_type）
- [x] agent：handle 返回归一化校验（SkillResult/dict 归一化）；status 必填且 ∈{success,error}；error 必填 reason；契约违规 → outcome(stage=contract) + 不存缓存
- [x] 示例技能 + 测试技能全部显式改造为 SkillResult
- [x] 测试：契约违规路径（缺 status/非法 status/缺 reason/非 dict）全量通过

### P1-a：指令声明层

- [x] skill.yaml 扩展 manifest 段 = 技能完整契约（name/intents/trigger_keywords/边界/system_prompt）
- [x] Skill 基类 manifest 来源：显式传入 > 类属性 > skill.yaml（模块路径推断技能 id）
- [x] 示例技能迁移：manifest 声明移到 yaml，handlers.py 只实现 handle
- [x] 意图识别 prompt 模板化：INTENT_SYSTEM_PROMPT 配置覆盖内置模板；候选技能 manifest.system_prompt 注入
- [x] "仓库即规范"：外部业务方改技能 = 改 skill.yaml 声明 + handlers.py 实现

### P1-b：任务状态模型

- [x] GenericState.task 字段：{id, steps:[{name,status,detail}], failed_at}
- [x] harness 自动记录：intent:<意图> / execute:<技能>（success/error/cache_hit）；失败定位 failed_at（resolve/boundary/execute）
- [x] 技能可上报子步骤：core/task.record_task_step()（handle 内调用，agent 后 drain 并入）
- [x] checkpointer 自动持久化（GenericState 字段）；API /api/chat 响应带 task
- [x] 修复：interrupt 抛异常时 pending steps 残留（每次 handle 前 reset 防跨任务污染）

### P3：执行目录（workspace）——core 机制 + skill 语义，两层

> 设计结论（讨论定稿）：每次调用同时有"用户 + 任务"两个维度，不存在二选一。
> 执行目录**绑定哪个维度**决定了它在 core 的角色：
> - 绑定**用户** → core **必须有**（用户身份解析是 core 职责）
> - 绑定**任务/会话** → core **可选有**（只提供透传机制，语义归 skill）

#### core 层（机制，所有 skill 可用）
- [ ] **任务级目录透传**：/api/chat 或 state 增加目录字段，透传给 skill（skill 不用则无感）
- [ ] **用户级目录解析**：用户档案存储（存用户默认工作目录）+ 按 user_id 解析（复用 user.py 身份体系）
- [ ] **三层上下文机制**：请求级 / 会话级 / 用户级 的目录解析（按"具体优先"覆盖：请求 > 会话 > 用户）
- [ ] 目录进 ALLOWED_DIRS（安全边界，防越权——机制现成）

#### skill 层（语义决策，由具体 skill 选择/混用）
- [ ] `workspace` 技能示例：声明"我要用执行目录"→ core 注入；启动读 `<dir>/AGENTS.md`（可无）→ 注入 system_prompt（复用 P1-a 机制）
- [ ] 探索类工具：复用 read_file/list_files；写文件（write_file）高危 → 确认闸门后按需
- [ ] 三层混用示例：会话级默认目录 + 请求级临时目录（演示"具体优先"覆盖）

#### 边界
- [ ] 这是**能力扩展**，不改变 harness 形态；"网页界面设置目录"是产品形态问题，另立

### P0-pre：JWT 鉴权体系（嵌入业务的地基，两端）

- [ ] flyer 侧：`core/security.verify_jwt()`（RS256 验签/过期/kid）；`AUTH_MODE=jwt`
- [ ] flyer 侧：`core/user.USER_PROVIDER=jwt`（从 payload 构造 UserContext）
- [ ] flyer 侧：api.py authorize 升级（token → UserContext）；报表按 token 归属隔离
- [ ] 业务系统侧：JWT 签发（RS256 私钥）+ /api/jwks 公钥发布 + 密钥轮换
- [ ] 闭环：用户登录业务系统 → 调 flyer（带 JWT）→ 技能调业务系统 API（业务 Key + 透传 JWT）→ 回读验证

---

## M5：演进预留（不实现，留接口）

| 预留项 | 触发条件 | 落地方式 |
|---|---|---|
| 子 Agent/子图 | 技能内部分工需并行/独立循环 | 技能内部建 LangGraph 子图（core 零改动） |
| PgVectorStore（pgvector） | 多副本/集群，需共享缓存（sqlite 单机够用） | 实现同接口类，`VECTOR_STORE=pgvector` 切换；复用业务 Postgres |
| 跨会话长期记忆 | 需要用户画像/全局知识 | LangGraph Store（InMemory→Postgres），`compile(store=)` |
| 历史摘要/向量 | 窗口丢信息成痛点 | `core/context.py` 预留接口 |

---

## 部署形态演进

| 阶段 | 方式 | 说明 |
|---|---|---|
| 当前 | 本地 uv + Docker（临时库） | 开发验证 |
| M4 后 | Docker 容器化 | 已有 Dockerfile；DB 用环境变量切换 |
| 规模化 | K8s / 云托管 | 弹性伸缩、多副本（Checkpointer 换 Postgres） |
