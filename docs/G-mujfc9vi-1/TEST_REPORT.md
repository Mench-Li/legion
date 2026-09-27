<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-27**（w/T-166 HEAD a3abf4e）的基线，其中的 file:line、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 .ci/<run>/summary.json。
<!-- evidence-banner:end -->

# T-170 编码实现自测报告：并行任务文件冲突治理

> 阶段：编码实现（coder）｜任务：T-170（[auto-goal]，所属目标 G-mujfc9vi-1 · software · chain）
> 上游设计：[2026-09-27-parallel-task-conflict-control-design.md](../superpowers/specs/2026-09-27-parallel-task-conflict-control-design.md)；本阶段切片见 [TASK_BREAKDOWN.md](TASK_BREAKDOWN.md)，用例编号见 [TEST_CASES.md](TEST_CASES.md)。
> 工作树：`.legion-worktrees/T-170`（分支 `w/T-170`）｜环境：Node v24.19.0、git 2.55.0.windows.5、零第三方依赖、无 `node_modules`。

## 1. 结论

**自测通过（绿）**：13 个新测试文件、123 个用例，`pass` 全绿、`fail 0`。既有回归抽样（run-store 43、schema-util 6、members-routes 8、create-routes 10）全绿，`server.mjs` 接线未引入回归。

诚实边界（逐条）：

1. **无法运行 `tsc` / `pnpm` / `vite build`**：本工作树没有 `node_modules`（`plugins/`、`workbench/`、仓库根均无），且禁止联网装依赖。因此前端与插件侧的 **类型检查与打包未执行**；新增的 `.ts` / `.tsx` 改动仅由「纯函数单测 + 源码结构断言」覆盖，JSX 接线（`TaskCenterView.tsx` / `TaskDetailModal.tsx`）**没有**被任何用例执行。
2. **浏览器级验证缺失**：无 DOM 测试环境，徽标渲染只验证到纯函数输出。
3. **集成 worker 的验证命令执行**：`integration-worker.test.mjs` 用系统临时目录里的单仓库夹具跑真实 `git`（merge-tree / commit-tree / update-ref），但**不做** `git push`／本地传输（沙箱下本地 `fetch`/`push` 会触发 `couldn't create signal pipe`），故跨仓库传输路径未覆盖。
4. **未调用 `taskctl`／不改他人模块**：改动全部落在 T-170 切片文件域内。

## 2. 逐切片自测命令与读数

已执行（工作目录 = 工作树根，命令原样可复现）：

- `node packages/shared/test/path-domain.test.mjs` → tests 9 / pass 9 / fail 0（S1）
- `node packages/shared/test/repo-identity.test.mjs` → tests 6 / pass 6 / fail 0（S1）
- `node team-hub/write-intent-store.test.mjs` → tests 13 / pass 13 / fail 0（S2；含双连接等价 A-3）
- `node team-hub/claim-policy.test.mjs` → tests 39 / pass 39 / fail 0（S2；基线 35 例未破，+4）
- `node team-hub/git-plumbing.test.mjs` → tests 6 / pass 6 / fail 0（S3）
- `node team-hub/delivery-store.test.mjs` → tests 11 / pass 11 / fail 0（S3）
- `node team-hub/integration-worker.test.mjs` → tests 7 / pass 7 / fail 0（S3）
- `node team-hub/write-intent-routes.test.mjs` → tests 5 / pass 5 / fail 0（S4）
- `node team-hub/delivery-routes.test.mjs` → tests 4 / pass 4 / fail 0（S4）
- `node team-hub/metrics.test.mjs` → tests 3 / pass 3 / fail 0（S4）
- `node --experimental-strip-types plugins/tests/write-eligibility.test.mjs` → tests 8 / pass 8 / fail 0（S5）
- `node --experimental-strip-types plugins/tests/legacy-convergence.test.mjs` → tests 6 / pass 6 / fail 0（S6）
- `node --experimental-strip-types workbench/scripts/delivery-ui.test.mjs` → tests 6 / pass 6 / fail 0（S7）

回归抽样：

- `node team-hub/run-store.test.mjs` → 43/43；`node team-hub/schema-util.test.mjs` → 6/6；`node team-hub/members-routes.test.mjs` → 8/8；`node team-hub/create-routes.test.mjs` → 10/10。

语法检查：

- `node --check team-hub/server.mjs`、`node --check team-hub/routes/{write-intent,delivery,metrics}.mjs`、`node --check plugins/src/{writeEligibility,legacyConvergence}.ts`、`node --check workbench/src/deliveryBadge.ts` 全部 exit 0。

文档门禁：

- `node scripts/ci/check-docs.mjs` → exit 0（README/FEATURES 索引、锚点、状态入口、banner、表行形状全绿）。

## 3. 关键行为证据（对应用例）

- **等待不失败**（TC-S4-03）：预约冲突返回 `200 + {ok:false, code:'FILE_CONTENTION', paths, holderTaskId}`；断言 `tasks.status='todo'`、`fixCount=0`、`scheduling_state='waiting-file'`。
- **epoch/revision 隔离**（TC-S4-05、TC-S5-05）：过期 epoch 释放 409 `EPOCH_STALE` 并回 `currentEpoch`；模型补丁改不动 RunRequest 的 `attemptId/epoch/intentRevision/workspaceId`。
- **版本 CAS 不覆盖**（TC-S4-09）：第二页用同一 `version` 裁决 409 `VERSION_CONFLICT`，断言 `decisionId` 未变、过期 reason 未落库。
- **权限负例**（TC-S4-08）：无裁决职责岗位 403，交付状态与裁决列不变。
- **不可读≠0**（TC-S4-11/12）：缺 repoId 时七项指标 `available:false`、`value:null`、带 reason；P50/P95 无样本时同样降级并附 `window.formula`。
- **旧通道收敛**（TC-S6-01/06）：集成模式下 `autoPromote` 与 `mediation` 两条旧直合并都被拒绝，且源码断言两处确实接线。
- **路径域唯一**（TC-S5-08）：守护判定复用 `packages/shared/src/path-domain.mjs`，静态断言不出现第二份 `startsWith` 前缀判定。

## 4. 未执行项（须由 tester 阶段补）

1. `tsc --noEmit` 与 `vite build`（缺依赖）。
2. 前端 JSX 接线的运行时行为（无 DOM）。
3. `scripts/ci/run-ci.mjs` 全量阶段（本阶段只登记套件并单跑；全量 CI 需要完整环境）。
