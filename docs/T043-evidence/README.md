<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-07**（commit `b38f5f0`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T-043 验证证据（devops 部署与 CI/CD）

本目录存放 T-043 阶段真实命令输出与产物记录（均在本 worktree 实测生成，未修改任何业务代码）。

| 文件 | 内容 | 来源命令 |
| --- | --- | --- |
| ci-full-1/summary.json | CI 六阶段结果（env/deps/build/test/smoke/stage 全 PASS，exit 0） | node scripts/ci/run-ci.mjs --out docs/T043-evidence/ci-full-1 |
| ci-full-1/ci-run-output.txt | 全量门禁完整原始输出（构建/测试/冒烟断言逐条；ci.log 为同内容运行时文件，*.log 被 gitignore） | 同上 |
| ci-full-1/stage/MANIFEST.json | 发布物暂存清单（releases/legion-f5975ac-2026-09-03/，含 gitHead/ciStages） | CI stage 阶段产物快照 |
| ci-full-1/stage/SHA256SUMS.txt | dist 与关键服务端文件 sha256 清单（部署校验用） | 同上 |

复跑方式（普通终端，非受限沙箱）：

node scripts/ci/run-ci.mjs --out docs/T043-evidence/ci-full-1

要点：workbench tsc --noEmit + vite build 全绿（615 modules）；L0 179/179（chat 13/skills 12/files-api 21/web 10/contracts 56/whiteboard 67）；
L1 三件套真实服务 28 项 HTTP 断言全过（对话/审计/SSE/token 矩阵/文件读写/越界 403/SSRF 拦截/v1 看板）；
发布物暂存 releases/legion-<head>-<date>/（MANIFEST + SHA256SUMS + dist 快照）。

已知缺陷（P0-1/P0-2/P0-3）与放行门禁见 docs/DEPLOY.md §7；本阶段不改实现、不发布生产。
