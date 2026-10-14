<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-10-14**（w/T-210 HEAD `f6f1f412`） 的部署与 CI 读数，其中的命令、端口与数字只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../../STATUS.md)（状态与测试基线）· [README.md](../../../README.md)（总览）· [docs/FEATURES.md](../FEATURES.md)（功能手册）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T210-evidence —— T-210（部署与 CI/CD）的复现证据

本目录是 T-210 在【部署与 CI/CD】阶段对 G-mv7kzgnu-1（软件流水线空间外部执行者头像补齐）
做构建 / CI / 部署验证时的**可复现**证据：命令、原始输出、探针脚本都留在这里。

- 部署与发布说明（结论）：[docs/G-mv7kzgnu-1/DEPLOY.md](../DEPLOY.md)
- 上游测试报告：[docs/G-mv7kzgnu-1/TEST_REPORT.md](../TEST_REPORT.md)（T-209，9 套件 92 例全绿）

## 目录内容

| 文件 | 是什么 |
| --- | --- |
| `target-suites.txt` | 9 支受影响/回归套件逐支直跑（`node <suite>.test.mjs`）的 `tests/pass/fail` 汇总与退出码 |
| `build-tsc.txt` | `workbench` 下 `tsc --noEmit` 的输出（空 = 0 诊断） |
| `build-whiteboard.txt` | `whiteboard` 下 `node scripts/build.mjs` 的输出（exit 0） |
| `ci-run-build.txt` | 真实 `run-ci --only build` 的完整输出（`workbench` 构建在本沙箱被 esbuild `spawn EPERM` 挡住） |
| `build-vite.txt` | `workbench` 下 `vite build` 的输出；本会话沙箱禁止管道采集 ⇒ esbuild `spawn EPERM`（环境限制，非编译错误） |
| `ci-run-static.txt` | 真实 `node scripts/ci/run-ci.mjs --only syntax,env,boundary,deps,doc` 的完整输出（挂 stdio 适配补丁） |
| `ci-run-green.txt` · `ci-run-green/summary.json` | 去掉既有红 `env` 的绿基线：`--only syntax,boundary,deps,doc` → 4/4 PASS，exit 0 |
| `ci-sandbox-patch.cjs` | stdio 适配补丁（非产品代码）：把一次性捕获的管道换成临时文件 fd，子进程仍真执行 |
| `deploy-smoke.mjs` / `deploy-smoke.json` | 部署冒烟探针：live 库只读快照 + 进程内真 hub + 真 HTTP 抓 `/api/roster`，按 R-1 判据统计 |
| `env-scan-pre.txt` / `env-scan-post.txt` | `scripts/config/scan.mjs --check` 在改动前/后的读数（用于证明 `env` 阶段红与本任务无关） |
| `migrate-avatars-dry.txt` | `node team-hub/scripts/migrate-avatars.mjs --dry` 的头像形态预检（0 行需迁移） |
| `docsync-grep.txt` | 三处 docSync（功能手册小节 / 功能索引 F-02 / README 引导段）的机械命中 |
| `ci-check-docs.txt` | `node scripts/ci/check-docs.mjs` 原始输出 |
| `t207-changed-files.txt` | T-207 功能提交 `b8f66e64` 的改动文件清单（用于对照 `env` 阶段红与本任务无关） |
| `run-deploy-verify.ps1` | 上面 1)~4) 的批量执行脚本（非产品代码） |

## 怎么复跑

```powershell
# 1) 9 支套件（逐支真命令）
node team-hub/team-views-routes.test.mjs
node team-hub/scripts/migrate-avatars.test.mjs
node team-hub/scripts/seed-roster.test.mjs
node workbench/scripts/external-avatar-parity.test.mjs
node workbench/scripts/agent-avatar.test.mjs
node workbench/scripts/avatar-photo.test.mjs
node workbench/mobile/avatar-parity.test.mjs
node workbench/scripts/agent-avatar-surfaces.test.mjs
node workbench/scripts/agent-avatar-settings.test.mjs

# 2) 类型门禁
cd workbench ; node node_modules/typescript/bin/tsc --noEmit

# 3) 真实 CI（本沙箱需挂 stdio 补丁；普通终端可去掉 `\$env:NODE_OPTIONS`）
\$env:NODE_OPTIONS='--require=<仓库根>/docs/G-mv7kzgnu-1/T210-evidence/ci-sandbox-patch.cjs'
node scripts/ci/run-ci.mjs --out docs/G-mv7kzgnu-1/T210-evidence/ci-run --only syntax,env,boundary,deps,doc

# 4) 部署冒烟（只读 live 库，不写库）
node docs/G-mv7kzgnu-1/T210-evidence/deploy-smoke.mjs --out=docs/G-mv7kzgnu-1/T210-evidence/deploy-smoke.json
```

## 边界

- 本目录是**证据**不是实现：不含任何产品代码变更，也不改业务功能。
- 探针读的库会随时间变化，输出里的条目清单只代表采样时刻；复跑即可得到当时的真实值。
- 生产发布**未执行、未放行**（未获将军批准；本阶段只产出放行材料）。
