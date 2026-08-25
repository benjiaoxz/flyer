# report 技能：数据看板（ChatBI）

运营用自然语言问数 → 网关取数聚合 → 前端渲染图表看板 / 报告，支持下载。
对接业务系统 `/api/stats`（SQL 聚合）+ 前端 ECharts（mall-web）。

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
         → ③ 调 biz /api/stats（SQL 聚合，数据不经过网关）→ 聚合结果
         → ④ 生成 charts: [{title, type, series:[{name,value}]}]（TopN 前10）
         → ⑤ 报告模式：第二次 LLM 写总结文字
         → ⑥ 前端按 type 套 ECharts 模板渲染（交互/PNG/CSV 全前端）
```

## 3. 分工边界

- **AI 只做**：意图识别 + 参数抽取 + 报告总结文字
- **网关代码做**：参数校验、类型匹配、取数、TopN、标题模板
- **前端做**：ECharts option 模板、看板布局、tooltip/缩放、PNG 下载（getDataURL）、CSV 下载
- **业务服务器做**：SQL 聚合（/api/stats），网关永不拉原始大数据

## 4. 权限与缓存

- `data_scopes: [shop]`——商家只看自己店铺（stats 端点按 JWT shop_id 过滤）
- `cacheable_intents: []`——报表数据动态，**不进语义缓存**（缓存会返回过期报表）
- 无数据 → 明确提示"该维度暂无数据"

## 5. 示例

```
看看各商品的价格对比        → 📊 商品对比（价格）· 前10 [bar]
订单各状态的占比            → 📊 订单状态分布（数量）[pie]
订单金额的月度趋势          → 📊 订单月度趋势（金额）[line]
总结一下最近的订单情况      → 📝 [LLM 总结文字] + [bar]
```
