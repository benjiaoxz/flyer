# catalog 技能：商品管理

商家通过对话管理自己店铺的商品（上架/查询/改名/改价/改库存/下架）。
对接业务系统商品 API，JWT 透传验证商家身份与店铺归属。

> 技能包文档范式：每个技能包（`src/skills/<id>/`）应带 README.md，
> 说明 用途 / 意图字段 / 执行流程 / 权限边界 / 缓存策略。本文件即范例。

## 1. 意图与字段

| 意图 | 动作 | LLM 抽取的 params | 说明 |
|---|---|---|---|
| `catalog_add` | 上架 | `name`(商品名) `price` `stock` | 同名商品已存在 → 恢复 on_sale；不存在 → 创建新商品 |
| `catalog_query` | 查询 | `name`(可选) | 指定名称 → 查单个；否则查全部列表 |
| `catalog_update` | 改名/改价/改库存 | `name`(定位旧名) `new_name` `price` `stock` | 部分更新，只传用户指定的字段 |
| `catalog_off` | 下架 | `name` | 状态置 off_sale |

`new_request`（规则兜底）按文本猜测动作：上架 > 下架 > 改价 > 查询。

**字段来源优先级**：LLM `intent.params`（语义抽取）→ `parseProduct` 正则（兜底，无 LLM/漏抽时）。

## 2. 执行流程

```
用户输入
  → ① 关键词预筛（trigger_keywords + auto_keywords 生成 + embedding 召回兜底）
  → ② LLM 意图识别 + 字段抽取（一次调用，返回 intent + params）
  → ③ 代码校验（商品名必填 / 更新值合法性）
  → ④ 调业务系统 API（X-Biz-Key 服务间鉴权 + 透传用户 JWT）
  → ⑤ verify 回读确认落库（上架/改名/改价/下架后）
  → ⑥ SkillResult 汇报
```

## 3. 权限边界

- **JWT 必需**：`user_ctx.token`（业务系统验证身份）+ `user_ctx.shop_id`（店铺归属）
- **数据域**：`data_scopes: [shop]`——商家只能操作自己店铺的商品
- 缺失 token/shop_id → 拒绝："需要业务系统登录态（JWT）"

## 4. 缓存策略

- **仅 `catalog_query` 可缓存**（`cacheable_intents`）——查询是幂等读
- 写操作（上架/改名/改价/下架）**跳过缓存**，防返回过期结果

## 5. 配置

| 配置 | 说明 |
|---|---|
| `auto_keywords: true` | 加载时用 LLM 从意图描述生成 trigger_keywords（与手写合并） |
| `session_mode: single` | 请求级：每次请求独立，无跨轮状态 |
| `max_turns_per_session: 1` | 单会话最多 1 轮 |

## 6. 示例对话

```
上架"Nike 鞋" 299元 库存50        → ✅ 已上架
帮我查一下商品                    → 📦 商品列表
把调试鞋价格改为199              → ✏️ 已更新（部分更新：只改价格）
网页测试鞋名称改为商城测试鞋      → ✏️ 已更新（改名）
撤下调试鞋2                      → 🛑 已下架
```
