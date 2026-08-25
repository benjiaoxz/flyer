# API 对接文档（前端/外部服务用）

> 供商城界面（运营后台/前端）对接 Flyer 商城智能交互网关。Base URL：`http://localhost:8099`
> 完整契约以代码为准（src/api/server.ts），本文给出对接必需信息。

## 1. 接口总览

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/chat` | 发起一轮对话（任意技能） |
| POST | `/api/resume` | 提交用户对追问的回答 |
| GET | `/health` | 健康检查 |
| GET | `/api/usage` | 审计报表：token 用量汇总（按技能/会话/全量） |

技能为**外部插件**（当前示例：catalog 商品管理）；框架按**意图路由**自动分发到已注册技能，前端无需指定技能。
未注册技能时返回通用 fallback 回复。

## 2. 核心概念：对话与追问

每轮调 `/api/chat`，响应分两种：

```
POST /api/chat {text, thread_id}
  → status="need_input"  → 展示 questions[]，收集回答 → POST /api/resume
  → status="result"      → 展示 output + data
```

- 需要澄清/补充信息时返回 `need_input`（最多 2 轮）
- 用户可跳过回答（answer 传空串）→ Agent 达上限后强制继续，不卡住
- **同一会话始终传同一个 `thread_id`**（Agent 通过 Checkpointer 记住上下文）

## 3. 接口详情

### POST /api/chat

```json
{"text": "上架\"Nike 鞋\" 299元 库存50", "thread_id": "user_1:session_a"}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `text` | ✅ | 用户输入 |
| `thread_id` | ❌ | 会话 id（同会话传同一个） |
| `user_id` | ❌ | 用户标识（透传给技能/业务系统） |

响应：
```json
// 情况 A：需要追问
{"status": "need_input", "questions": ["您的预算大概在什么范围？"], "data": {}, "thread_id": "..."}

// 情况 B：结果
{
  "status": "result",
  "output": "技能回复文本",                       // 用户可读回复
  "data": {                                      // 技能自定义产出（顶层字段，按技能而异）
    "charts": [ {"title": "...", "type": "bar", "series": [{"name": "A", "value": 1}]} ],  // report 技能
    "summary": "..."                            // report 技能（报告模式）
  },
  "thread_id": "user_1:session_a"
}
```

`data` 为技能直接写入的顶层字段（`SkillResult.data`），无 `<skill_id>` 包裹；
各技能产出结构见对应技能文档（`src/skills/<id>/README.md`，如 report 技能返回 `charts`/`summary` 见 [ChatBI.md](ChatBI.md)）。

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
- `data`：技能自定义产出（顶层字段，按技能而异，由技能写入）
- `output`：技能产出的可读文本（可直接展示）
- 例：report 技能（数据看板）返回 `data.charts`（数组，每项 `{title, type, series}`）+ 可选 `data.summary`，对接结构见 [ChatBI.md](ChatBI.md)

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
# 商品管理（catalog 技能）：上架
curl -X POST http://localhost:8099/api/chat \
  -H "Content-Type: application/json" \
  -d '{"text":"上架\"Nike 鞋\" 299元 库存50","thread_id":"demo-1"}'

# 商品管理：查询
curl -X POST http://localhost:8099/api/chat \
  -H "Content-Type: application/json" \
  -d '{"text":"查一下我的商品","thread_id":"demo-2"}'
```

## 6. 运行方式

```bash
npm run api        # tsx 启动（默认 8099）
npm test           # vitest
```
