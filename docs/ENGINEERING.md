# 工程实践：门禁链路与健康审计

> 面向网关开发者：代码怎么过闸、健康审计失败怎么处理、CI 怎么配置。

## 1. 门禁链路（三层）

```
本地提交 → 远程 PR → 合并保护
```

| 层 | 触发 | 自动运行 | 不达标后果 |
|---|---|---|---|
| **pre-commit**（`.husky/pre-commit`） | 每次 `git commit` | `npm run check`（typecheck + test） | 提交被拦截 |
| **CI**（`.github/workflows/ci.yml`） | 每次 PR / main 推送 / 每周定时 | typecheck → test → 覆盖率 ≥80% → lint → `health:ci` | 对应 step 失败 |
| **合并保护**（GitHub 仓库设置） | 尝试 merge PR | 要求 CI status check 通过 | PR 无法合并 |

### 本地脚本

| 命令 | 作用 |
|---|---|
| `npm run check` | typecheck + test（pre-commit 跑的） |
| `npm run lint` | eslint（0 error；warning 上限 20） |
| `npm run test:coverage` | 测试 + 覆盖率门禁（lines/statements/functions ≥80%，branches ≥70%） |
| `npm run health` | 健康审计（本地，跳过 npm audit） |
| `npm run health:ci` | 健康审计（CI 模式，含 npm audit） |

### 开启合并保护（仓库设置，需人工配置一次）

1. GitHub 仓库 → Settings → Branches → Add branch protection rule
2. Branch name pattern 填 `main`
3. 勾选 **Require status checks to pass before merging**，选择 CI workflow 的 status check
4. 勾选 **Require branches to be up to date before merging**

## 2. 健康审计

### 运行时机

- **每次 PR**：CI 自动跑（`health:ci`）
- **每周定时**：CI cron（周一 02:00）——防"没人动也在烂"（依赖漏洞/文档漂移/配置退化）
- **里程碑 / 交接 / 事故复盘**：人工跑 `npm run health` 作为决策输入

### 检查维度与分级

| 维度 | 输出 | 分级 |
|---|---|---|
| ROADMAP 声称"已实现"符号存在性 | 🔴 阻断 | 文档虚报会误导对接方 |
| API.md 路由均已注册 | 🔴 阻断 | 同上 |
| README 测试数与实际一致 | 🔴 阻断 | 误导 |
| env 键覆盖率（config.ts vs .env.example） | 🔴 阻断 | 新环境按示例配置起不来 |
| npm audit 高危漏洞（仅 CI） | 🔴 阻断 | 安全 |
| 文档标注"规划中/未实现" | 🟡 不阻断 | 人工确认项 |
| as 断言数量 | 🟡 不阻断 | 渐进治理目标 |
| TODO/FIXME 残留 | 🟡 不阻断 | 卫生项，可攒批清理 |

### 审计失败处理流程（脚本 → AI 分析 → 人工确认 → 执行）

```
① 脚本检测：npm run health（或 CI 失败输出）
② AI 分析：把输出喂给 AI → AI 分类：
     🔴 阻断项 → 给"修复方案 + 需人工拍板的点"（如：文档虚报 = 补实现 or 改文档）
     🟡 不阻断项 → 一句话建议，标注可跳过
③ 人工确认：拍板 🔴 的方案；🟡 勾选"本轮处理 / 攒着"
④ 执行：AI 按确认结果改 → 跑 npm run health 验证 🔴 归零 → 提交/合并
```

- **审计不自动修复**：检测与修复分离——自动修会掩盖漂移（向检测器妥协），且多数修复含判断（改文档 vs 补实现），脚本无判断力
- **修复含判断的项**（文档虚报/依赖升级）必须人工拍板方向；机械项（README 测试数/env 键补齐）AI 可直接给 diff

## 3. 故障定位辅助

- 审计失败先看**分级前缀**：🔴 阻断项才卡合并，🟡 只是提示
- 一致性失败（🔴）常见三种：
  - ROADMAP 声称符号缺失 → 功能未实现或文档虚报，二选一处理
  - 路由未注册 → API.md 写了但 server.ts 没实现
  - README 测试数过时 → 改了测试忘了改文档
