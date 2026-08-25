# report 技能：数据看板（ChatBI）

运营用自然语言问数 → 网关语义解析 + 取数 → 返回图表数据（前端按契约渲染看板/报告，支持下载）。
对接业务系统**预期提供的** `/api/stats` 统计接口（聚合由业务系统承担，契约见 docs/ChatBI.md §2）。

## 1. 意图与参数

| 意图 | 触发 | LLM 抽取 params.extra |
|---|---|---|
| `report_chart` | "看看X对比/分布/排行/趋势" | `dataset` `group_by` `metric` `chart_type` |
| `report_summary` | "总结一下/报告一下/这周怎么样" | 同上 + `summary=true`（追加 LLM 总结文字） |

参数取值：`dataset=products\|orders`、`group_by=status\|name\|month\|product`、
`metric=count\|price\|stock\|amount\|quantity`、`chart_type=bar\|pie\|line`。
推断规则：占比→pie、趋势/每月→line+month、对比/排行→bar。

## 2. 执行流程（确定性归确定性）

```
用户描述 → ① LLM 抽结构化参数（唯一 AI 环节，system_prompt 指导 extra 结构）
         → ② 代码校验参数合法性 + 图表类型-数据形态匹配（折线需时间轴，月份不适合饼图）
         → ③ 调业务系统 /api/stats（预期提供的聚合接口）→ 聚合结果
         → ④ 生成 charts: [{title, type, series:[{name,value}]}]（TopN 前10）
         → ⑤ 报告模式：第二次 LLM 写总结文字
         → ⑥ 前端按 type 套模板渲染（交互/PNG/CSV 由前端实现）
```

## 3. 分工边界

- **AI 只做**：意图识别 + 参数抽取 + 报告总结文字
- **网关代码做**：参数校验、类型匹配、取数、TopN、标题模板
- **前端做（预期）**：图表模板、看板布局、tooltip/缩放、PNG 下载、CSV 下载——网关不做 UI
- **业务系统做（预期）**：聚合取数（/api/stats），网关只拿聚合结果，不拉原始大数据

## 4. 权限与缓存

- `data_scopes: [shop]`——商家只看自己店铺（业务系统按 JWT 过滤数据域）
- `cacheable_intents: []`——报表数据动态，**不进语义缓存**（缓存会返回过期报表）
- 无数据 → 明确提示"该维度暂无数据"

## 5. 示例

```
看看各商品的价格对比        → 📊 商品对比（价格）· 前10 [bar]
订单各状态的占比            → 📊 订单状态分布（数量）[pie]
订单金额的月度趋势          → 📊 订单月度趋势（金额）[line]
总结一下最近的订单情况      → 📝 [LLM 总结文字] + [bar]
```
