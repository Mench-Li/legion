<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-06**（commit `497b2d8`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T-098 证据目录（test-designer 阶段产出）

本目录是 T-098「测试用例设计」的可复现证据，与 docs/TEST_CASES.md（第三批用例文档）配套。

| 文件 | 内容 | 复现命令 |
| --- | --- | --- |
| 01-doc-machcheck.txt | 用例文档机器自检输出（计数/ID 唯一/类别/优先级/追溯引用完整性） | `node docs/T098-evidence/machcheck.mjs > docs/T098-evidence/01-doc-machcheck.txt` |
| machcheck.mjs | 自检脚本（读取 docs/TEST_CASES.md；类别按码点判定，脚本零非 ASCII 依赖） | 见上 |
| 01-baselines.txt | 既有契约测试基线实测输出（skills/chat/calendar） | `node team-hub/<file>.test.mjs` 直跑（沙箱 node --test spawn EPERM 受限，直跑等效；node v24.19.0） |

环境事实：本 worktree 无 node_modules/dist；plugins typecheck（tsc -p plugins/tsconfig.json --noEmit）与 workbench build（pnpm --dir workbench build）需宿主/CI，按仓库 R-18「环境受限 + 复现步骤」记录，不冒充通过。本阶段未执行业务用例（执行为 tester 职责，见 docs/TEST_CASES.md §2 分层）。
