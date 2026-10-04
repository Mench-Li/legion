# T-173 round5 证据索引（部署与 CI/CD · G-mujfc9vi-1）

> 本目录是 **2026-10-05** 一轮复核的证据（响应将军 2026-10-04 评论：解除 hold、要求「重跑完整 CI + 出 DEPLOY.md」）。
> 基线：**worktree 文件内容 = main `3b0dd879`**；分支 `w/T-173` 的 HEAD 仍是旧 WIP 提交 `66c85a0e`（原因见 [01-baseline.txt](01-baseline.txt)：会话沙箱不允许写共享 `.git`，无法 add/commit/merge）。
> 结论与清单见 [DEPLOY.md](../DEPLOY.md)。

## 1. 关键读数（本轮实测）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 基线对齐 | `git read-tree main` + `git checkout main -- .`（GIT_INDEX_FILE=本地索引） | 工作树 == 索引 == main 3b0dd879；见 [01-baseline.txt](01-baseline.txt) |
| 配置面门禁 | `node scripts/config/scan.mjs --check` | **exit 0 PASS**（mode=git-tracked，113 文件，1443 疑似字面量）见 [scan-check.txt](scan-check.txt) |
| 完整 CI | `node scripts/ci/run-ci.mjs` | syntax PASS / **env PASS** / boundary **FAIL** / deps PASS / build **FAIL** / test **FAIL** / smoke **FAIL** / stage **FAIL** / doc PASS；见 [ci-full/](ci-full/summary.json) |
| env 单跑 | `node scripts/ci/run-ci.mjs --only env` | [env] PASS（scan / sync / check(good fixture) / encoding 全绿）；见 [ci-env/](ci-env/summary.json) |
| 边界棘轮 | `node scripts/ci/dsh-boundary.mjs --check` | **exit 1，8 处违规 / 6 个文件**（既有真红，归属 coder）；见 [boundary-check.txt](boundary-check.txt) |
| 构建（白板） | `node whiteboard/scripts/build.mjs` | **exit 0**（copied 12 shared modules）；见 [build-whiteboard.txt](build-whiteboard.txt) |
| 构建（workbench 类型检查） | `node workbench/node_modules/typescript/bin/tsc -p workbench/tsconfig.json --noEmit --extendedDiagnostics` | **exit 0**；Files 1068 / Check 9.19s / Total 12.78s；见 [build-workbench-tsc.txt](build-workbench-tsc.txt) |
| 构建（workbench dist） | `node workbench/node_modules/vite/bin/vite.js build` | **exit 1**：esbuild 长驻服务双向管道被沙箱拦；见 [vite-build.txt](vite-build.txt)（环境限制，非代码缺陷） |
| 目标套件（逐文件直跑） | 18 个文件（S1–S7 + 回归） | **177 tests / 176 pass / 1 fail**（metrics TC-S4-12/13）；见 [goal-suites.txt](goal-suites.txt) |
| metrics 红根因 | `node --test team-hub/metrics.test.mjs` + 探针 | 写入口径 repoId=`d:/project/DSH/legion/.git`，测试查 `scope:default` ⇒ 值恒 0；见 [metrics-red.txt](metrics-red.txt) |
| 交付配置 | `loadDeliveryConfig(<worktree>)` | **ok=true / errors=[] / verifyCount=13**；见 [06-wiring.txt](06-wiring.txt) |
| 生产接线 | `git grep`（生产模块） | claim=预约、integration-runner 消费 worker、`POST /api/deliveries/submit`、legacyConvergence 接线；见 [06-wiring.txt](06-wiring.txt) |
| DSH 出处锚点 | `node scripts/prt/dsh-pin-drift.mjs` | exit 0；见 [pin-drift.txt](pin-drift.txt) |
| 子进程 pipe 限制 | [probe-spawn.mjs](probe-spawn.mjs) | 本会话 `spawn/spawnSync/execFileSync` 带 pipe 一律 `EPERM` |

## 2. 目录内容

| 文件 | 说明 |
| --- | --- |
| [01-baseline.txt](01-baseline.txt) | HEAD / main SHA、对齐方法、工作树 vs main 差异（空）、未跟踪项、沙箱拒绝原文 |
| [scan-check.txt](scan-check.txt) | `scan --check` 完整输出（PASS，1443 字面量） |
| [boundary-check.txt](boundary-check.txt) | `dsh-boundary --check` 完整输出（8 处违规 / 6 文件） |
| [pin-drift.txt](pin-drift.txt) | `dsh-pin-drift` 输出（exit 0） |
| [build-whiteboard.txt](build-whiteboard.txt) | 白板构建原始输出（exit 0） |
| [build-workbench-tsc.txt](build-workbench-tsc.txt) | workbench `tsc --noEmit --extendedDiagnostics` 原始输出（exit 0） |
| [vite-build.txt](vite-build.txt) | `vite build` 失败原文（esbuild 服务 `undefined.on`，沙箱管道限制） |
| [goal-suites.txt](goal-suites.txt) | 18 个目标相关套件逐文件直跑读数（176/177） |
| [metrics-red.txt](metrics-red.txt) | metrics 套件红的 `node --test` 原文 + 根因探针输出 |
| [06-wiring.txt](06-wiring.txt) | `.legion/delivery.json` 校验 + 生产消费者 grep |
| [ci-full/](ci-full/summary.json) · [ci-env/](ci-env/summary.json) | 完整 CI 与 env 单跑的 `ci.log` + `summary.json` |
| [07-final-recheck.txt](07-final-recheck.txt) | 清理临时脚手架后的收尾复核：scan exit 0 / boundary exit 1（8 处）/ check-docs exit 0 / evidence-banner exit 0 |
| [probe-spawn.mjs](probe-spawn.mjs) | 子进程 pipe `EPERM` 探针 |
| [run-goal-suites.ps1](run-goal-suites.ps1) | 逐文件直跑脚本的留档（本轮实际用内联同版脚本执行） |

## 3. 复跑（普通终端，无沙箱限制）

### 3.1 临时脚手架清理

前几轮留下的大体积临时目录已删除（本次会话无法写共享 `.git/info/exclude`，故改用删除）：`.ci-main/`（71.7MB）、`.tmp-verify/`（56.5MB，含 `main.tar`）、`.ci-run-env/`、`.ci-main-index`、`.scan-*.txt`、`.ci-full-run.txt`。
清理后工作树的未跟踪项只剩：`.git-local-index`（本会话对齐用的索引，可删）、`docs/G-mujfc9vi-1/DEPLOY.md`、`docs/G-mujfc9vi-1/T173-evidence/`（本任务交付物）。
> 因此 **promote / `git add -A` 前无需再排除旧脚手架**；若不想把 `.git-local-index` 带进提交，删掉即可（它只是本轮的会话内索引）。

```powershell
cd D:\project\DSH\legion\.legion-worktrees\T-173
git merge main                    # 或由将军 promote（沙箱内无法提交）
node scripts/config/scan.mjs --check
node --test scripts/config/config.test.mjs
node scripts/ci/run-ci.mjs --only env
node scripts/ci/run-ci.mjs        # 完整 9 阶段；build 需要 workbench/node_modules 可用
```
