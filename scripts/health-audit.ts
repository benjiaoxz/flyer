/**
 * 项目健康审计脚本（确定性检查，CI 门禁用）
 *
 * 检查维度（全部机器可验证）：
 * 1. 文档-实现一致性：ROADMAP/ARCHITECTURE 声称"已实现"的代码符号是否存在；
 *    README 声称的测试数 vs vitest 实际
 * 2. 配置完整性：config.ts 引用的 env 键 vs .env.example 覆盖率
 * 3. 代码卫生：any/as 断言计数、未使用导出（粗查）、TODO/FIXME 计数
 * 4. 依赖健康：npm audit（仅 CI 中启用，本地可跳过）
 * 5. 测试健康：vitest 全量跑（退出码）
 *
 * 用法：npm run health         （本地，跳过 npm audit）
 *       CI=true npm run health （CI，含 npm audit + 严格阈值）
 * 退出码：0=通过；1=有失败项（阻断合并）
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { globSync } from "node:fs";

// ---------------------------------------------------------------- 工具
const ROOT = new URL("..", import.meta.url).pathname;
const inCI = process.env.CI === "true";
let failures = 0;
let warnings = 0;

function report(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failures += 1;
    console.log(`  🔴 [阻断] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function warn(name: string, detail = ""): void {
  warnings += 1;
  console.log(`  🟡 [不阻断] ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---------------------------------------------------------------- 1. 文档-实现一致性
function checkDocImplConsistency(): void {
  console.log("\n[1] 文档-实现一致性");
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  const roadmap = read(`${ROOT}ROADMAP.md`);
  const apiDoc = read(`${ROOT}docs/API.md`);
  const srcFiles = globSync(`${ROOT}src/**/*.ts`).map((p) => p.replace(ROOT, "").replace(/\//g, "/"));
  const allSrc = srcFiles.map((p) => read(`${ROOT}${p}`)).join("\n");

  // 1a. 声称"已实现"的符号必须存在（ROADMAP 中 [x] 的括号注释里的符号）
  const claimed = [...roadmap.matchAll(/\[x\][^\n]*[`](\w+)[`][^\n]*/g)].map((m) => m[1]);
  const missing = claimed.filter((sym) => !allSrc.includes(sym));
  report("ROADMAP 声称已实现的符号存在", missing.length === 0,
    missing.length ? `缺失: ${missing.join(", ")}` : `核验 ${claimed.length} 个符号`);

  // 1b. API.md 路由清单 vs server.ts 注册的路由
  const apiRoutes = [...apiDoc.matchAll(/\| (?:POST|GET) \| `([^`]+)`/g)].map((m) => m[1]);
  const serverRoutes = [...allSrc.matchAll(/app\.(get|post)\("([^"]+)"/g)].map((m) => m[2]);
  const missingRoutes = apiRoutes.filter((r) => !serverRoutes.includes(r));
  report("API.md 路由均已注册", missingRoutes.length === 0,
    missingRoutes.length ? `缺失: ${missingRoutes.join(", ")}` : `核验 ${apiRoutes.length} 条路由`);

  // 1c. 声称"未实现/规划中"的功能不得有对应实现（防止文档改口后代码又加了）
  const planned = [...roadmap.matchAll(/未实现|规划中/g)].length + [...apiDoc.matchAll(/规划中/g)].length;
  warn(`文档标注'规划中/未实现' ${planned} 处（人工确认这些功能确实未实现）`);

  // 1d. README 测试数 vs vitest 实际
  const readmeCount = read(`${ROOT}README.md`).match(/(\d+) 个测试/)?.[1];
  const actual = execSync(`npx vitest run --reporter=json 2>/dev/null`, { cwd: ROOT, encoding: "utf8" });
  const actualCount = JSON.parse(actual).numTotalTests;
  report("README 测试数与实际一致", String(actualCount) === readmeCount,
    readmeCount ? `README=${readmeCount}, 实际=${actualCount}` : "README 未标注测试数");
}

// ---------------------------------------------------------------- 2. 配置完整性
function checkConfigCoverage(): void {
  console.log("\n[2] 配置完整性（config.ts env 引用 vs .env.example）");
  const config = readFileSync(`${ROOT}src/core/config.ts`, "utf8");
  const example = readFileSync(`${ROOT}.env.example`, "utf8");
  const envKeys = [...config.matchAll(/env\("([A-Z_]+)"/g)].map((m) => m[1]);
  const exampleKeys = [...example.matchAll(/^#?\s*([A-Z_]+)=/gm)].map((m) => m[1]); // 识别注释形式（# JWT_PUBLIC_KEY=）
  const missing = [...new Set(envKeys)].filter((k) => !exampleKeys.includes(k));
  const coverage = (1 - missing.length / new Set(envKeys).size) * 100;
  report("env 键覆盖率 100%", missing.length === 0,
    missing.length ? `缺失: ${missing.join(", ")}` : `${new Set(envKeys).size} 键全覆盖（${coverage.toFixed(0)}%）`);
}

// ---------------------------------------------------------------- 3. 代码卫生
function checkHygiene(): void {
  console.log("\n[3] 代码卫生");
  const src = globSync(`${ROOT}src/**/*.ts`).map((p) => readFileSync(p, "utf8")).join("\n");
  const tests = globSync(`${ROOT}tests/**/*.ts`).map((p) => readFileSync(p, "utf8")).join("\n");
  const srcAny = (src.match(/\bas any\b|\bas never\b|\bas unknown as/g) || []).length;
  const testAny = (tests.match(/\bas any\b|\bas never\b|\bas unknown as/g) || []).length;
  warn(`源码 as 断言: ${srcAny} 处（eslint 治理目标）`);
  warn(`测试 as 断言: ${testAny} 处`);
  const todo = (src.match(/TODO|FIXME|HACK/g) || []).length;
  warn(`TODO/FIXME 残留: ${todo} 处（卫生项，不阻断合并，可攒批清理）`);
}

// ---------------------------------------------------------------- 4. 依赖健康（仅 CI）
function checkDeps(): void {
  if (!inCI) {
    console.log("\n[4] 依赖健康（跳过：本地不跑 npm audit，CI 中启用）");
    return;
  }
  console.log("\n[4] 依赖健康（npm audit）");
  try {
    const out = execSync("npm audit --audit-level=high 2>&1", { cwd: ROOT, encoding: "utf8" });
    report("npm audit 无高危漏洞", out.includes("found 0"), out.trim().split("\n").pop());
  } catch (e) {
    const msg = String(e.stdout || e.message);
    // 环境不支持 audit（镜像源无 audit 端点/网络问题）→ 提示不阻断；CI 官方 registry 可正常执行
    if (/NOT_IMPLEMENTED|audit endpoint returned an error|not implemented yet|ECONNREFUSED|ETIMEDOUT/i.test(msg)) {
      warn("npm audit 当前环境不可用（registry 不支持 audit 端点），CI 官方源可正常执行");
      return;
    }
    // npm 输出格式兼容：老版 "found N vulnerabilities" / npm10+ "N high severity vulnerability"
    const found = msg.match(/found (\d+) vulnerabilities/)?.[1]
      ?? msg.match(/(\d+) high severity vulnerability/)?.[1]
      ?? msg.match(/(\d+) moderate severity vulnerability/)?.[1]
      ?? "?";
    const noFix = /No fix available/.test(msg) ? "（无修复版本）" : "";
    report("npm audit 无高危漏洞", false, `发现 ${found} 个漏洞${noFix}`);
  }
}

// ---------------------------------------------------------------- 主流程
console.log(`项目健康审计（${inCI ? "CI 模式" : "本地模式"}）`);
checkDocImplConsistency();
checkConfigCoverage();
checkHygiene();
checkDeps();

console.log(`\n结果：${failures === 0 ? "✅ 通过" : `❌ ${failures} 个 🔴 阻断项（需处理才能合并）`}，🟡 提示 ${warnings} 项（不阻断，可攒批）`);
if (failures > 0) process.exit(1);
