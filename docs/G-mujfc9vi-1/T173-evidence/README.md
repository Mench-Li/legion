<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-27**（w/T-173 HEAD 200ef1f）的基线，其中的 file:line、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../../STATUS.md)（状态与测试基线）· [README.md](../../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T-173 部署阶段证据目录（devops）

本目录保存 T-173「部署与 CI/CD」阶段的可复跑证据：构建 / CI 门禁的真实命令输出、
沙箱适配层脚本与复跑说明。结论、清单与 go/no-go 见 [DEPLOY.md](../DEPLOY.md)。

| 文件 | 内容 |
| --- | --- |
| [01-build.txt](01-build.txt) | 构建：whiteboard build（exit 0）、workbench `tsc --noEmit`（0 诊断）、esbuild/vite 限制探针 |
| [02-suites.txt](02-suites.txt) | L0 套件逐文件直跑原始输出：19 文件 271 pass / 0 fail |
| [03-gates.txt](03-gates.txt) | 门禁原始输出：ci-syntax / encoding-check / config scan --check（红）/ dsh-boundary / check-docs |
| [04-gap-checks.txt](04-gap-checks.txt) | 生产接线与配置缺口核对：无消费者、`.legion/delivery.json` 校验失败、集成模式读取点 |
| [ci-run/](ci-run/ci.log) | `run-ci.mjs --only syntax,env,boundary,doc` 的 `ci.log` + `summary.json`（env FAIL，其余 PASS） |
| [ci-run-test/](ci-run-test/ci.log) | `run-ci.mjs --only test` 尝试：team-hub 外部包 junction `EPERM`，故 test 阶段改用逐文件直跑 |
| [run-suites.ps1](run-suites.ps1) | 逐文件直跑 L0 套件的复跑脚本（生成 02-suites.txt） |
| [run-evidence.ps1](run-evidence.ps1) | 生成 01/03/04 的复跑脚本 |
| [sandbox-pipe-shim.cjs](sandbox-pipe-shim.cjs) | **会话沙箱适配层**（pipe → 临时文件 fd）；非产品代码，见 DEPLOY.md §6 |
| [tsconfig.workbench-typecheck.json](tsconfig.workbench-typecheck.json) | workbench `tsc --noEmit` 的替代 tsconfig（paths 映射主 checkout `.pnpm`） |

复跑方式见 [DEPLOY.md §6](../DEPLOY.md)。

### 2026-10-05 复核轮（round5，基线 = main `3b0dd879`）

上一轮（`200ef1f` / `30bacf09`）的结论与读数是历史快照；**最新一轮复核**见 [round5/README.md](round5/README.md) 与 [DEPLOY.md](../DEPLOY.md)：

| 文件 | 内容 |
| --- | --- |
| [round5/01-baseline.txt](round5/01-baseline.txt) | 基线对齐到 main `3b0dd879` 的方法与差异（工作树 == main；沙箱禁写共享 `.git`，无法提交） |
| [round5/scan-check.txt](round5/scan-check.txt) | `scan --check` **PASS**（git-tracked，1443 字面量）—— 上一版 ① 红已消解 |
| [round5/boundary-check.txt](round5/boundary-check.txt) | `dsh-boundary --check` **8 处违规 / 6 文件**（既有红，归属 coder） |
| [round5/ci-full/](round5/ci-full/summary.json) · [round5/ci-env/](round5/ci-env/summary.json) | 完整 CI 与 env 单跑的 `ci.log` + `summary.json` |
| [round5/goal-suites.txt](round5/goal-suites.txt) | 目标相关 18 套件逐文件直跑：177 tests / 176 pass / 1 fail（metrics） |
| [round5/metrics-red.txt](round5/metrics-red.txt) | metrics TC-S4-12/13 红的复现与根因探针 |
| [round5/build-whiteboard.txt](round5/build-whiteboard.txt) · [round5/build-workbench-tsc.txt](round5/build-workbench-tsc.txt) · [round5/vite-build.txt](round5/vite-build.txt) | 构建证据：白板 exit 0 / tsc exit 0 / vite exit 1（沙箱限制） |
| [round5/06-wiring.txt](round5/06-wiring.txt) | `.legion/delivery.json` ok=true + 生产消费者 grep —— 上一版 ②③ 已消解 |
---

## exp-t092 判型留痕（回归复跑先查上游验证防空转）

- **上游交付核对**：本批实现 commit `5e32ae8`（T-170）已在 [T-171-REVIEW.md](../review/T-171-REVIEW.md) 与 [TEST_REPORT.md](../TEST_REPORT.md) 被覆盖；T-172 记录了 123 新增 + 148 回归 = 271 全绿，**但整体判为不通过/红**（生产接线未交付）。
- **判型结论：不是「目标已被上游验证、无增量的同批回归复跑」**，故不停工、不空转收尾。依据：① T-173 是部署与 CI/CD 阶段，交付物是部署说明 + 构建/门禁证据，上游从未执行过；② 本轮确有增量——workbench `tsc --noEmit` 首次真正执行（0 诊断）、`config/scan.mjs --check` 首次以 T-170 新常量跑出真红、`.legion/delivery.json` 校验失败被独立复现；③ 上游结论为红，本阶段据此做 go/no-go，属正常推进而非重复劳动。
- **验证留痕引用（不另造）**：套件范围/用例数/结果以上游合入的 [TEST_REPORT.md](../TEST_REPORT.md) 为准，本轮 [02-suites.txt](02-suites.txt) 为独立复跑读数（271/0，与之一致）。按 devops 边界不写仓库根 `docs/TEST_REPORT.md`，避免与目标目录外文档冲突。
