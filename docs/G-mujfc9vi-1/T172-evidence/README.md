<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录为 T-172（w/T-172 HEAD 0be2781，验证对象 T-170 / commit 5e32ae8）测试执行的原始证据，命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../../STATUS.md) · [README.md](../../../README.md) · 最新 CI 证据 .ci/&lt;run&gt;/summary.json。
<!-- evidence-banner:end -->

# T-172 测试执行证据（并行任务文件冲突治理）

本目录是 [../TEST_REPORT.md](../TEST_REPORT.md) 的可复跑证据。全部脚本零第三方依赖，仅用 node:fs/node:os/node:path 与 node 内置 fetch。

- `e2e-claim-reservation.mjs`：隔离 hub（mkdtemp 临时库）真实启动，端到端验证「守护 claim 是否授予写入预约」（E2E-1 核心）。
- `e2e-task-fields.mjs`：直接调用 `server.mjs` 导出的 `rowToTask`，验证任务 API 是否下发调度/交付子状态（S7 徽标数据链）。
- `e2e-client-repo-identity.mjs`：验证写意图路由是否信任客户端传入的 `repoId/targetRef`（设计 §4/§8、I-8）。
- `01-suites.txt`：13 个新增/相关测试套件与 6 个回归抽样套件的实跑输出。
- `02-gap-repro.txt`：失败项复现命令与原始输出（delivery.json 校验、调用点 grep、rowToTask 字段、徽标映射）。

复跑（工作目录 = 工作树根）：

```text
node docs/G-mujfc9vi-1/T172-evidence/e2e-claim-reservation.mjs
node docs/G-mujfc9vi-1/T172-evidence/e2e-task-fields.mjs
node docs/G-mujfc9vi-1/T172-evidence/e2e-client-repo-identity.mjs
```
