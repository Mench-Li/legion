<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录为 T-198（w/T-198 HEAD 4fcf0692）测试用例设计的自检证据，命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../../STATUS.md) · [README.md](../../../README.md) · 最新 CI 证据 .ci/<run>/summary.json。
<!-- evidence-banner:end -->

# T198-evidence —— T-198 用例设计自检证据

本目录是任务 T-198（test-designer，目标 G-mv1s6y49-1）的自检证据，**只校验文档结构与骨架语法，不执行任何业务用例**（用例执行是 T-201 tester 的职责）。

| 文件 | 说明 |
| --- | --- |
| `machcheck-test-cases.mjs` | 零依赖自检脚本：7 列完整 / ID 唯一 / 类别与优先级枚举 / §0 计数一致 / 34 条 AC 全覆盖 / 16 条 BR 正反向配对 / 附录 B 骨架 `node --check` |
| `01-doc-machcheck.txt` | 主校验输出（脚本复跑结果） |
| `02-skeleton-syntax.txt` | 附录 B 各骨架的 `node --check` 逐条结果 |

运行：`node docs/G-mv1s6y49-1/T198-evidence/machcheck-test-cases.mjs`（退出码 0 = PASS）。

- 提交状态：本任务在独立 worktree（分支 `w/T-198`）产出；沙箱 workspace-write 只覆盖 `.legion-worktrees/T-198`，`git add` 需要写 D:\project\DSH\legion\.git\worktrees\T-198\index（工作区之外），实测 `[UnauthorizedAccessException]` 被拒 → **本会话无法提交**。产物已完整落在工作区内（`docs/G-mv1s6y49-1/TEST_CASES.md` 与 `docs/G-mv1s6y49-1/T198-evidence/`），请由守护/将军捕获 diff 并 promote。

基线：w/T-198 HEAD `4fcf0692`，Node v24.19.0。本目录不含任何产品源码改动，也不含各切片文件域内的 `*.test.mjs`（那些由对应 coder 切片物化并登记 CI）。
