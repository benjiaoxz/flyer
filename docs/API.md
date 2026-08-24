# API 对接文档（前端/外部服务用）

> 供前端项目对接 Flyer 通用对话框架。Base URL：`http://localhost:8000`
> 完整契约以代码为准（src/api/server.ts），本文给出对接必需信息。

## 1. 接口总览

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/chat` | 发起一轮对话（任意技能） |
| POST | `/api/resume` | 提交用户对追问的回答 |
| GET | `/health` | 健康检查 |
| GET | `/api/usage` | 审计报表：token 用量汇总（按技能/会话/全量） |

技能为**外部插件**（本仓库不含业务技能）；框架按**意图路由**自动分发到已注册技能，前端无需指定技能。
未注册技能时返回通用 fallback 回复。

## 2. 核心概念：对话与追问

每轮调 `/api/chat`，响应分两种：

```
POST /api/chat {text, thread_id}
  → status="need_input"  → 展示 questions[]，收集回答 → POST /api/resume
  → status="result"      → 展示 output + data
```

- 需要澄清/补充信息时返回 `need_input`（购物澄清会问预算/品类；最多 2 轮）
- 用户可跳过回答（answer 传空串）→ Agent 达上限后强制继续，不卡住
- **同一会话始终传同一个 `thread_id`**（Agent 通过 Checkpointer 记住上下文）

## 3. 接口详情

### POST /api/chat

```json
{"text": "请帮我总结今天的会议", "thread_id": "user_1:session_a"}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `text` | ✅ | 用户输入 |
| `thread_id` | ❌ | 会话 id（同会话传同一个） |
| `user_id` | ❌ | 用户标识；购物技能会据此**查用户偏好**补全缺失维度（品类/预算/特征） |

响应：
```json
// 情况 A：需要追问
{"status": "need_input", "questions": ["您的预算大概在什么范围？"], "data": {}, "thread_id": "..."}

// 情况 B：结果
{
  "status": "result",
  "output": "技能回复文本",                       // 用户可读回复
  "data": {                                      // 技能命名空间（按技能而异）
    "<skill_id>": { ... 技能自定义产出 ... }
  },
  "thread_id": "user_1:session_a"
}
```

### POST /api/resume

```json
{"thread_id": "user_1:session_a", "answer": "好的，补充待办：李四负责测试"}
```
响应同 `/api/chat`（可能仍为 `need_input` 或 `result`）。

### GET /health
```json
{"status": "ok"}
```

## 4. 前端对接要点

### 4.1 交互状态机
```
chat(text) → need_input → 展示问题 → resume(answer) → need_input(循环) | result
          → result → 渲染 output + data
```

### 4.2 技能数据展示
- `data.<skill_id>`：技能自定义状态/产出（按技能而异，由技能写入）
- `output`：技能产出的可读文本（可直接展示）

### 4.3 多轮与崩溃恢复
- 同一会话固定 `thread_id`；服务端 `CHECKPOINTER=sqlite` 时崩溃/重启可恢复会话
- CORS 已配置（`CORS_ORIGINS`，开发期 `*`）

### 4.4 鉴权（AUTH_MODE）
- 开发默认 `AUTH_MODE=none`（不校验）；生产设 `AUTH_MODE=api_key` + `API_KEYS=sk-xxx,...`
- 请求头携带：`Authorization: Bearer <你的 Key>`
- 无/错误 Key → `401`；`/health` 始终开放

### 4.5 限流（RATE_LIMIT_PER_MINUTE）
- 按调用方身份限流（默认 60 次/分钟，`RATE_LIMIT_PER_MINUTE=0` 关闭）
- 超限 → `429`

## 5. 快速试用（curl）

```bash
# 购物：完整需求
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"text":"请帮我总结今天的会议","thread_id":"demo-1"}'

# 购物：模糊需求 → 追问 → 续答
curl -X POST http://localhost:8000/api/chat \
  -d '{"text":"想买双鞋","thread_id":"demo-2"}'       # → need_input + questions
curl -X POST http://localhost:8000/api/resume \
  -d '{"thread_id":"demo-2","answer":"补充待办：李四负责测试"}'

# 客服：意图自动路由
curl -X POST http://localhost:8000/api/chat \
  -d '{"text":"怎么退货","thread_id":"demo-3"}'       # → 客服技能回复
```

## 6. 运行方式

```bash
npm run api        # tsx 启动（默认 8099）
npm test           # vitest
```
