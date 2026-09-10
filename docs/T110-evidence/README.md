<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-07**（commit `b38f5f0`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T-110 部署与 CI/CD 证据目录（目标 G-mtpaab3x-1 文档预览特性）

| 文件 | 内容 |
| --- | --- |
| 01-ci-output.txt | `node scripts/ci/run-ci.mjs` 全量 CI 输出（env deps build test smoke stage；唯一 build FAIL=F1 App.tsx TS1185×3，test/smoke 前序真实运行） |
| 02-summary.json | CI 六阶段 summary.json |
| 03-plugins-board-build.txt | `node scratch/t110-build/build-deps.mjs plugins board-plugin`（tsc emit → lib/，exit 0；本批实跑复验） |
| 04-feature-l0-tests.txt | 特性 L0 契约测试 node --test：doc-contract 4 + artifact-register 7 + artifact-content 16 + doc-render 11 + artifact-detail 10 = 48 用例全绿 |
| 05-s3-l1-smoke.txt | 新端点 GET /api/artifact/content 真实 L1 HTTP 冒烟（200/400/404 + worktree 优先 + digest 落库校验）RESULT: PASS |
| 06-workbench-tsc.txt | **F1 解析后 `tsc --noEmit` 重测：exit 0（0 诊断）**（本批实跑） |
| 07-f1-resolution.txt | F1（App.tsx 合并冲突标记）解析说明：清除冲突符、保留双函数、取与实际行为一致注释、零行为差异 |

# 汇总

| 项 | 结果 |
| --- | --- |
| workbench 类型检查（F1 解析后） | ✅ `tsc --noEmit` exit 0（0 诊断，App.tsx 314/328/330 TS1185×3 已消除）—— 证据 06 |
| 全量 CI 构建 | ⚠ 前序真实运行唯一 build FAIL=F1（TS1185×3）；F1 已解 → 唯一阻塞消除；vite/esbuild dist 装配需宿主（R-18） |
| 全量 CI 测试 | ✅ 7 套件全绿（chat 23 / skills 20 / calendar 13 / files-api 40 / web 24 / contracts 56 / whiteboard 67） |
| 全量 CI 冒烟 | ✅ chat-l1 35/35 · files-s5 32/32 · whiteboard/v1 通过；chat-s2 8/9（S2-A 因 dist 缺失=F1 下游；F1 已解则消除） |
| 特性插件构建 | ✅ plugins + board-plugin tsc exit 0 |
| 特性 L0 契约 | ✅ 48/48 |
| 特性 L1 冒烟 | ✅ RESULT: PASS |

> 环境受限项（R-18）：本批沙箱拦截子进程 pipe 捕获（`node --test`/`vite build`/`node scripts/ci/run-ci.mjs` 均 spawn EPERM），故 test/smoke 采用前序真实运行输出 + 本批 `tsc --noEmit`/插件构建实跑（证据 03/06）；L2 浏览器走查需宿主验收人；插件宿主注入不可达。
