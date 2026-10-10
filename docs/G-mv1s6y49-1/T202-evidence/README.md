<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录反映 **2026-10-10**（w/T-202 开工基线 HEAD `cd569616`）的 CI 取数过程；其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T-202 部署证据目录（受限沙箱下的 CI 取数）

> 角色：devops（部署运维员）｜任务：T-202｜所属目标 G-mv1s6y49-1
> 阶段产物正文：[docs/G-mv1s6y49-1/DEPLOY.md](../DEPLOY.md)（部署与发布说明）

## 本目录是什么

本目录存放 T-202 在**本会话受限沙箱**下取得构建/CI 读数的工具与原始日志。
它**不是**产品代码，也**不改变**任何被测行为。它解决的是「同一台机器上，沙箱禁止 Node 进程建管道，
而 `scripts/ci/run-ci.mjs` 用管道捕获子进程输出」这一环境冲突。

| 文件 | 作用 |
| --- | --- |
| `ci-sandbox-patch.cjs` | `child_process` stdio 适配：把一次性捕获的管道换成临时文件 fd，退出后经内存流回放。只覆盖 public 的 spawn/spawnSync/execFileSync/execSync/execFile/exec；**对 esbuild 这类交互式子进程保持原样**（让沙箱限制如实暴露为 EPERM）。 |
| `run-ci-sandboxed.mjs` | CI `test` 阶段的等价执行器：文件集合 = `git ls-files '*.test.mjs'` − `run-ci.mjs` 的 EXEMPT 表 − **未配 `DSH_CHECKOUT` 时按 `run-ci.mjs:5215-5219` 排除的 `plugins/`、`board-plugin/`**；逐文件独立进程 + 四路并发；计数复用仓库自己的 `scripts/ci/parse-suite-output.mjs`。 |
| `run-ci-attempt.log` | **不挂补丁**直接跑 `node scripts/ci/run-ci.mjs --only syntax,env` 的现场：两个阶段都 `exception: spawn EPERM`（栈在 `run-ci.mjs:78`）。这是「为什么需要上面的补丁」的原始证据。 |
| `run-ci-patched-stages.log` | 挂补丁后跑 `node scripts/ci/run-ci.mjs --only syntax,env,boundary,deps,doc` 的完整输出（真实 run-ci，非替代品）：**5/5 PASS，exit 0**。 |
| `target-suites.log` | 本目标 6 支新套件 `node --experimental-strip-types <file>` 逐文件直跑：**41/41，全部 exit 0**。 |
| `build-whiteboard.log` · `build-workbench-tsc.log` · `build-workbench-vite.log` | 构建门禁 B1/B2/B3 的命令与退出码（B3 = esbuild `spawn EPERM`，环境限制）。 |
| `ci-syntax-patched.log` | `node scripts/ci/ci-syntax.mjs` 原始输出（257 脚本可解析）。 |
| `probe-t201-boundary-rerun.log` | 复跑 T-201 只读探针（临时库 + 真端口），M1/M2 在当前树上**仍复现**。 |
| `.ci/T-202-*/` | 与本目录同源的机读日志/汇总（`.ci/` 已被 gitignore，不入库）。 |

## 等价执行器与真实 `run-ci` 的差异（不改变被测行为）

1. 没有 `node --test` 聚合器：逐文件直跑（每个文件仍是独立进程，隔离粒度相同；聚合由本脚本做）。
2. `--experimental-strip-types` 对所有文件统一开启（CI 只对部分套件开）。
3. 套件层面的 label/分组不产生；产物是逐文件读数 + 汇总。
4. 文件集合不再包含「CI 在无 `DSH_CHECKOUT` 时本就会 SKIP」的 `plugins/`、`board-plugin/`（40 个文件）——与真实 `run-ci` 对齐；浏览器/条件用例由用例自身逐条 skip。

> **忠实范围（重要）**：本执行器对**输出运输**是忠实的（真命令、真进程、逐文件隔离、同一计数解析器）；
> 但它是**逐文件裸跑**，缺少真实 `run-ci` 的套件上下文（外部包构建、`DSH_CHECKOUT` 派生的宿主夹具、
> 守护/环境变量）。因此它**只在「本目标相关套件 + 无跨进程的纯单元套件」上可作为 CI 读数**；
> 对**整仓**会放大真进程/环境类失败（实测 2026-10-10：530/532 完成，482 PASS / 48 FAIL，2 挂起，
> 红集中在 `*-real-process`、`*-dsh-process`、`tests/e2e-unified/*`、`product/launcher/*` 等）。
> 整仓结论以 `run-ci` 在完整环境（配 `DSH_CHECKOUT`、允许管道）下的读数为准，**不以本执行器为准**。

> 为什么不用真实 `--only test`：`node --test` 的**内部** runner 经 primordials 直接 `spawn` 每文件子进程
> （`node:internal/test_runner/runner:517`），**绕过** public `child_process` 补丁 ⇒ 一律 `spawn EPERM`。
> 这是环境限制，不是门禁判据的变化。

## 复跑命令（PowerShell，仓库根）

```powershell
# ① 全量 test 阶段（受限沙箱等价执行器；产物落 .ci/T-202-full/）
node docs/G-mv1s6y49-1/T202-evidence/run-ci-sandboxed.mjs --out .ci/T-202-full --concurrency 4

# ② 真实 run-ci 的静态阶段（挂 stdio 适配补丁）
$env:NODE_OPTIONS='--require=<仓库根>/docs/G-mv1s6y49-1/T202-evidence/ci-sandbox-patch.cjs'
node scripts/ci/run-ci.mjs --only syntax,env,boundary,deps,doc

# ③ 本目标 6 支新套件（无补丁）
node --experimental-strip-types workbench/scripts/agent-avatar.test.mjs
node --experimental-strip-types team-hub/scripts/seed-roster.test.mjs
node --experimental-strip-types team-hub/agent-identity-tokens.test.mjs
node --experimental-strip-types workbench/scripts/agent-avatar-surfaces.test.mjs
node --experimental-strip-types workbench/scripts/agent-avatar-settings.test.mjs
node --experimental-strip-types workbench/mobile/avatar-parity.test.mjs
```

普通终端（无沙箱限制）**不需要**上面任何适配，直接 `node scripts/ci/run-ci.mjs` 即可。
