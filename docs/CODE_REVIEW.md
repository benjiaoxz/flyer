# 代码走查报告（2026-08-16）

> 范围：全项目源码 + 配置 + 测试 + 部署文件
> 结论：整体结构健康、分层清晰，发现并修复 4 个问题（1 个严重），记录若干轻微项。

> **补充（技能清理）**：业务技能（shopping/meeting/report 等）已全部移除，改为外部插件；
> 本文与技能相关的历史描述仅为当时记录。
>
> **补充（架构升级后）**：本报告基于旧版 `src/agent` 结构。已重构为
> `core/`（通用骨架）+ `skills/`（业务插件），重构本身经 23 个测试 + 真实模型多技能验证；
> 原报告 R1（结构化输出静默回退）在新架构已由 `core/llm.py` + 日志降级告警保障。

## 🔴 已修复问题

### R1【严重】真实模式下结构化输出全部静默回退到规则
- **文件**：`src/agent/llm.py`
- **现象**：`with_structured_output` 默认使用 `json_schema` response_format，DeepSeek API 不支持
  （400: `This response_format type is unavailable now`）。导致需求理解/质量评估/对比分析
  三个结构化调用全部异常，被 try/except **静默吞掉**，实际一直走规则解析。
  只有报告生成（非结构化）真正用了 LLM。
- **影响**：真实模型的智能只体现在"写报告"，理解与分析的智能没有生效（用户感知不到，
  因为异常被吞、流程照常跑）。
- **修复**：新增 `structured()` 封装，显式指定 `method="function_calling"`
  （DeepSeek 支持 OpenAI 兼容 function calling）。验证通过：
  `预算500以内的黑色皮鞋` → `{category=皮鞋, budget_max=500, keywords=[黑色]}` ✅
- **教训**：try/except 兜底要打日志——静默回退让"真实模式没生效"难以察觉。
  已列入改进建议（见 S3）。

### R2【一致性问题】评估节点的关键词命中池漏了 color
- **文件**：`src/agent/llm.py`（`_rule_based_evaluate`）
- **现象**：分析节点（`_rule_based_analyze`）的匹配池含 `color`，评估节点不含，
  导致"黑色皮鞋"的黑色命中在分析算、在评估不算，判定口径不一致。
- **修复**：评估节点的匹配池补上 `color` 字段。

### R3【健壮性】商品数据加载依赖 cwd
- **文件**：`src/agent/tools/product_search.py`
- **现象**：`load_products()` 基于 `os.getcwd()` 拼接路径，从非项目根目录运行时找不到数据。
- **修复**：改为基于模块文件路径定位项目根（`__file__` 向上推导），任意目录可运行。

### R4【评估依据不足】evaluate 传给 LLM 的候选信息不全
- **文件**：`src/agent/llm.py`（`evaluate_candidates`）
- **现象**：真实模式评估时候选只传 id/name/category/price/keywords，缺 description，
  模型评估依据不足。
- **修复**：候选文本补上 description。

## 🟡 已记录轻微项（暂不修）

| # | 项 | 说明 |
|---|---|---|
| S1 | `messages` 字段未使用 | state 预留了 add_messages 但无节点写入；未来多轮对话用 |
| S2 | 品类词规则匹配可能误判 | 如"鞋柜"含"鞋"会误识别品类；原型阶段可接受，真实 NLP 在理解节点已由 LLM 承担 |
| S3 | try/except 兜底无日志 | 建议后续给 `llm.py` 的降级路径加 `logging.warning`，便于发现"真实模式未生效" |
| S4 | `build_chat_model` 每次新建实例 | 每个节点调用都新建 ChatOpenAI；功能正确，可缓存复用（性能优化） |
| S5 | run_agent 对模糊输入抛 RuntimeError | 有意为之（提示改用交互接口），文档已说明 |

## 🟢 通过项

- 图结构（graph.py）：澄清/检索双循环 + interrupt 预留，结构清晰
- 状态设计（state.py）：schema 约束，字段职责明确
- 幻觉防护（analyze/build_report 空候选拦截）：有效
- 双通道（真实/dry-run）：降级链路完整，无 key 可跑
- 分层（接口/编排/节点/工具/配置）：职责单一
- 测试 8 用例：覆盖主流程/预算过滤/循环/澄清/边界

## 📋 后续建议

1. **评测体系已建立**（`eval/`）：每次改动后跑一次，量化质量与成本（见评测报告）
2. 接入真实日志（S3），让降级路径可观测
3. 真实模型下多跑边界输入，沉淀更多评测用例
