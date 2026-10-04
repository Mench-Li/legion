<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-10-05**（worktree 内容对齐 main `3b0dd879`；分支 `w/T-173` HEAD `66c85a0e`）的基线，其中的 file:line、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T-173 部署与发布说明（DEPLOY.md）—— 并行任务文件冲突治理（G-mujfc9vi-1）

> 阶段：部署与 CI/CD（devops）｜任务：T-173（[auto-goal]｜目标 G-mujfc9vi-1 · software · chain）
> 上游依据（只认本目标目录版本）：[REQUIREMENTS.md](REQUIREMENTS.md)（T-166）→ [RESEARCH.md](RESEARCH.md)（T-167）→ [TASK_BREAKDOWN.md](TASK_BREAKDOWN.md)（T-168）→ [TEST_CASES.md](TEST_CASES.md)（T-169）→ coder T-170 `5e32ae8` → [T-171-REVIEW.md](../review/T-171-REVIEW.md) → [TEST_REPORT.md](TEST_REPORT.md)（T-172）→ 配置面修复 T-174（将军注记 `3f1fce2e`）
> 设计依据：[2026-09-27-parallel-task-conflict-control-design.md](../superpowers/specs/2026-09-27-parallel-task-conflict-control-design.md)（§10 迁移与发布、§11 验收与度量）
> 本文件落点：`docs/G-mujfc9vi-1/DEPLOY.md`（只写本目标目录，不碰仓库根 `docs/DEPLOY.md` 与其他目标目录）
> 本轮基线：**worktree 文件内容 = main `3b0dd879`**（分支 HEAD 仍为旧 WIP `66c85a0e`，无法提交的原因见 §6.0）
> 证据目录：[T173-evidence/round5/](T173-evidence/round5/README.md)（本文所有命令与读数均为本轮在该树上真实执行，原始输出为证）

---

## 0. 结论速览（TL;DR）

- **本阶段结论：NO-GO（不放行生产）。** 理由不在「构建坏」，而在 **两道既有真红的门禁**（均归属 coder，不在 devops 边界内）+ 未获生产发布授权。
- **上一版 DEPLOY.md 的两条 NO-GO 依据已消解**（本轮在 `3b0dd879` 上复跑确认）：① 配置面门禁 `node scripts/config/scan.mjs --check` 已 **PASS（exit 0）**；② 生产接线（claim 授予写入预约 / integration-runner 消费 worker / `POST /api/deliveries/submit` / legacyConvergence）已在 main 上交付；③ `.legion/delivery.json` 经 `loadDeliveryConfig` **ok=true / errors=[] / verifyCount=13**。
- **本轮真实跑通**：完整 `run-ci` 的 syntax / env / deps / doc 四阶段 PASS；`whiteboard build` exit 0；`workbench tsc --noEmit` exit 0（Files 1068，Check 9.19s）；目标相关 18 个套件 177 例 **176 pass / 1 fail**；smoke 4 组里 3 组全绿（chat-l1 35/35、files-s5 32/32、whiteboard 探活 + v1 看板）。
- **两道真红（既有，非本批引入，非 devops 可修）**：
  - **R1 `boundary`**：`dsh-boundary.mjs --check` exit 1，**8 处违规 / 6 个文件**（`plugins/src/index.ts` ctx.subagents 实际 11、基线 6，另 5 个测试/夹具/TSX 文件为 new-file）。
  - **R2 `metrics` 套件 TC-S4-12/13**：写入口径 repoId 解析为仓库身份 `d:/project/DSH/legion/.git`，而测试查 `scope:default`，`sameFileWriteBlocked` 恒为 0 ⇒ 断言失败（归属 coder 复核是改测试还是改路由）。
- **本会话沙箱结构限制（如实标注，不是通过）**：`spawn/spawnSync/execFileSync` 带 pipe 一律 `EPERM`；共享 `.git` 只读（无法 add/commit/merge）；`vite build` 因 esbuild 长驻服务双向管道不可用；`run-ci` 的 test 阶段因外部包 junction/symlink 被拦；`smoke` 的 S2-A 与 `stage` 是 dist 缺失的下游现象。普通终端复跑命令见 §6.1。
- **边界遵守**：未改任何业务功能代码（本轮只新增 `docs/G-mujfc9vi-1/` 下 DEPLOY.md 与证据）；未 push、未 promote、未发布生产；未跳过任何已能执行的门禁。

---

## 1. 发布对象与变更影响说明

### 1.1 批次清单（并行任务文件冲突治理 S1–S8；实现 commit `5e32ae8`，另含 `934e45ef` 等接线补齐）

| 切片 | 文件（代表） | 性质 | 影响面 |
| --- | --- | --- | --- |
| S1 路径域与仓库身份 | `packages/shared/src/path-domain.mjs`、`repo-identity.mjs` | 新纯函数 | 路径归一/相交判定、仓库身份与 Git 能力探测；无 I/O |
| S2 写入意图/预约 | `team-hub/write-intent-store.mjs`、`claim-policy.mjs` | 新仓储 + 事务 | 新表 `task_write_intents`/`write_reservations`；claim 事务内授予预约 |
| S3 Git/验证/交付 | `git-plumbing.mjs`、`verify-config.mjs`、`delivery-store.mjs`、`integration-worker.mjs`、`integration-runner.mjs` | 新模块 | 新表 `task_deliveries`/`integration_jobs`/`integration_events` |
| S4 HTTP 面 | `routes/{write-intent,delivery,metrics}.mjs` + `server.mjs` 接线 | 新路由 | `/api/tasks/:id/write-intent`、`/api/tasks/:id/reservation`、`/api/deliveries/submit`、`/api/metrics/repository`；`tasks` 加列 `scheduling_state`/`delivery_state`（幂等迁移） |
| S5/S6 插件侧 | `plugins/src/writeEligibility.ts`、`legacyConvergence.ts`（接进 `index.ts` / `mediation.ts`） | 纯决策 + 闸门 | `LEGION_INTEGRATION_MODE` 开关；默认沿用 legacy 通道 |
| S7 Workbench | `workbench/src/deliveryBadge.ts` + `TaskCenterView.tsx`/`TaskDetailModal.tsx` | UI | **用户可见**：任务卡/详情标题行新增调度与交付徽标 |
| S8 CI/文档 | `scripts/ci/run-ci.mjs` 登记、`.legion/delivery.json`、`README.md`、`docs/FEATURES.md`、`docs/STATUS.md` | 门禁与文档 | 13 个新套件进 CI 注册表；功能手册 §3.20 + F-21 索引 + README 引导段 |

### 1.2 变更影响面

1. **用户可见**：任务卡与详情标题行展示「⏸ 等待文件 / 已预约写入 / 对账中」调度徽标与「待裁决 → 待集成 → 集成准备中 → 集成后验证中 → 已集成」交付徽标；等待写入资格的任务保持 `todo` 且**不消耗重试**。
2. **数据模型（加性）**：`tasks.scheduling_state`/`delivery_state` 经 `ensureColumn` 幂等 ALTER 落库；3 张新表由 schema-util 建表。旧库可直接启动，**升级前必须备份**（§4.2 步骤 1）。
3. **HTTP 面（加性）**：新增写入资格/预约/交付/集成/指标端点；既有端点语义不变。
4. **开关与兼容**：默认 `LEGION_INTEGRATION_MODE=legacy`（旧 `autoPromote`/`mediation` 直合并通道保留）；切到 `integration` 后旧通道被拒并转入唯一集成 worker。**同仓库不得同时启用旧直合与新队列**（设计 §10.3）。
5. **风险**：本批为交付语义变更（`done` 只在交付子状态为已集成时置位）。回滚必须先对账在制 job，再切回旧通道（§4.4）。

### 1.3 文档同步（docSync，验收项 4）

本批**是用户可见功能变更**，功能手册三处已在 main 中齐备且门禁绿（本轮 `doc` 阶段 PASS）：

| 落点 | 位置 | 内容 |
| --- | --- | --- |
| 功能手册小节 | [FEATURES.md](../FEATURES.md#L252)（§3.20 并行任务文件冲突治理） | 入口、功能、相关设置与边界 |
| 功能索引 | [FEATURES.md](../FEATURES.md#L286)（F-21 行） | 「并行任务文件冲突治理 → §3.20」 |
| README 引导段 | [README.md](../../README.md#L165-L167) | 写入调度/交付徽标说明 + 手册链接 |

> 本任务（devops）本身**不产生用户可见行为变更**，故不新增/改写功能手册；上表为被发布批次的既有同步事实，由 `node scripts/ci/check-docs.mjs`（11 类校验）守。

---

## 2. 部署环境与发布目标（环境清单）

| # | 环境 | 承载 | 发布动作 | 状态 |
| --- | --- | --- | --- | --- |
| E1 | 开发验证：worktree `w/T-173`（内容 = main `3b0dd879`） | Node v24.19.0 / git 2.55.0 / Windows | 构建 + 目标套件 + 完整 CI 门禁（本文 §3） | ✅ 已执行（两红 + 沙箱限制，见 §5） |
| E2 | 主 checkout `D:\project\DSH\legion` | pnpm 依赖（typescript/vite 二进制） | E1 的依赖来源（只读引用）；`workbench/node_modules` 已就绪 | ✅ deps PASS |
| E3 | DSH 检出 `D:\project\DSH\dsh\deepseek-harness` | `vendor/cordis` 等外部包 | `build-external-package.mjs` 建 junction | ⛔ 本会话沙箱拦 symlink（EPERM），故 `run-ci` test 阶段起即 FAIL（§5.2） |
| E4 | 验收/宿主机（acceptance） | team-hub + `workbench/dist` + plugins | §4.2 步骤 4–6 | ⛔ 未授权，未执行 |
| E5 | 生产/稳定通道 | 用户环境 | 发布 | ⛔ 未授权；本批 go/no-go = **NO-GO**，不发布 |

端口与数据（沿用既有约定）：team-hub `:8787`（v2 SQLite `team-hub/team.db`，WAL）；workbench 构建产物 `workbench/dist`（预览 `:4173`，开发 `:5173`）；whiteboard 自托管。

---

## 3. 构建与 CI 事实（真实命令与读数）

### 3.1 完整 CI 逐阶段（`node scripts/ci/run-ci.mjs`，2026-10-04T16:22:14Z 结束）

命令（沙箱内复跑口径，普通终端直接跑同一脚本）：

```powershell
$env:GIT_INDEX_FILE = "$PWD\.git-local-index"     # 索引 = main 树（沙箱无法提交，见 §6.0）
$env:NODE_OPTIONS  = "--require $PWD\docs\G-mujfc9vi-1\T173-evidence\sandbox-pipe-shim.cjs --test-isolation=none"
node scripts/ci/run-ci.mjs --out docs/G-mujfc9vi-1/T173-evidence/round5/ci-full
```

| 阶段 | 结果 | 耗时 | 依据 / 说明 |
| --- | --- | --- | --- |
| syntax | ✅ PASS | 30317ms | `ci-syntax.mjs` exit 0（CI 脚本可解析性） |
| env | ✅ PASS | 16130ms | scan PASS（1443 字面量）/ sync PASS / check(good fixture) PASS / encoding PASS（2862 文件） |
| boundary | ⛔ **FAIL** | 1715ms | `dsh-boundary.mjs` exit 1：**8 处违规 / 6 个文件**（R1，既有红）；`dsh-pin-drift.mjs` exit 0 |
| deps | ✅ PASS | 11ms | `workbench/node_modules` 就绪 |
| build | ⛔ FAIL | 20448ms | 白板构建 exit 0；workbench `vite build` 因 esbuild 服务管道被沙箱拦（§5.2），dist 未产出 |
| test | ⛔ FAIL | 187ms | `build-external-package.mjs` symlink `vendor/cordis` → `EPERM`（沙箱）；改用逐文件直跑，见 §3.4 |
| smoke | ⛔ FAIL | 11336ms | 4 组里 3 组全绿；chat-s2 的 S2-A `GET /` 404 是 dist 缺失的下游现象 |
| stage | ⛔ FAIL | 117ms | `workbench/dist 不存在：请先跑 build 阶段`（build 的下游） |
| doc | ✅ PASS | 4005ms | `check-docs.mjs` exit 0（11 类全绿）+ `spec-progress --check` exit 0（141/146） |

CI 自带的树警告（必须连树一起引用）：

```text
本次 CI 跑在一棵**脏树**上：已改 316 个文件 + 未跟踪 11 个（指纹 77ff4b0c6135a078）。
git head=66c85a0e   ← 回答"哪个提交"，不回答"跑的哪棵树"
```

> 口径说明：本次读数的树 = **worktree（内容逐路径等于 main `3b0dd879`）+ 本任务新增的 `docs/G-mujfc9vi-1/` 未跟踪文件**。"已改 316 个"是相对本分支旧 HEAD `66c85a0e` 的基线差（见 [01-baseline.txt](T173-evidence/round5/01-baseline.txt)），不是脏在制品。

### 3.2 env 阶段明细（`run-ci --only env` 独立复跑，[env] PASS）

```text
config scan: PASS   scan: PASS（全部读取点、字面量与动态读取均已处理；共 1443 个疑似字面量）
config sync: PASS   sync: PASS（白板副本与根实现一致）
config check(good fixture): PASS   （error 0，warning 0，strict）
encoding: PASS      encoding-check: PASS（2862 个文本文件）
```

单跑 `node scripts/config/scan.mjs --check`（加 shim）的**模式行**为 `扫描模式 git-tracked；扫描文件 113 个`，exit 0 —— 即上一版的红已归零（原始输出 [scan-check.txt](T173-evidence/round5/scan-check.txt)）。

### 3.3 构建证据

```text
$ node whiteboard/scripts/build.mjs
[build] copied 12 shared modules -> apps/web/public/shared/
[build] excluded (node-only): hash.mjs, index.mjs, config.mjs
-> exit=0                                    （[build-whiteboard.txt](T173-evidence/round5/build-whiteboard.txt)）

$ node workbench/node_modules/typescript/bin/tsc -p workbench/tsconfig.json --noEmit --extendedDiagnostics
Files: 1068 · Lines of TypeScript: 20048 · Check time: 9.19s · Total time: 12.78s
-> exit=0                                    （[build-workbench-tsc.txt](T173-evidence/round5/build-workbench-tsc.txt)）

$ node workbench/node_modules/vite/bin/vite.js build     （cwd=workbench）
TypeError: Cannot read properties of undefined (reading 'on')
    at ensureServiceIsRunning (.../esbuild@0.28.2/lib/main.js:2288:15)
-> exit=1   ← 会话沙箱限制（esbuild 长驻服务双向管道），非代码缺陷
                                             （[vite-build.txt](T173-evidence/round5/vite-build.txt)）
```

> `workbench/package.json` 的 `build` = `tsc --noEmit && vite build`：**类型检查部分真实通过**，打包部分被环境拦；这是 full-CI `build` 阶段 FAIL 的确切原因。

### 3.4 测试证据

- **`run-ci` test 阶段**：阶段一开始就调用 `scripts/ci/build-external-package.mjs` 为 team-hub 建 `vendor/cordis` 链接，被沙箱拦：`EPERM: operation not permitted, symlink ... -> team-hub\node_modules\cordis`（原始输出见 [ci-full/ci.log](T173-evidence/round5/ci-full/ci.log)）。
- **等价替代（逐文件直跑 `node <file>`，每文件独立进程）**：18 个目标相关套件（S1–S7 + 回归）合计 **177 tests / 176 pass / 1 fail**（[goal-suites.txt](T173-evidence/round5/goal-suites.txt)）：

| 套件 | tests | pass | fail |
| --- | --- | --- | --- |
| packages/shared/test/path-domain.test.mjs | 9 | 9 | 0 |
| packages/shared/test/repo-identity.test.mjs | 7 | 7 | 0 |
| team-hub/write-intent-store.test.mjs | 18 | 18 | 0 |
| team-hub/claim-policy.test.mjs | 39 | 39 | 0 |
| team-hub/claim-reservation.e2e.test.mjs | 1 | 1 | 0 |
| team-hub/git-plumbing.test.mjs | 8 | 8 | 0 |
| team-hub/delivery-store.test.mjs | 12 | 12 | 0 |
| team-hub/integration-worker.test.mjs | 9 | 9 | 0 |
| team-hub/integration-runner.test.mjs | 1 | 1 | 0 |
| team-hub/write-intent-routes.test.mjs | 7 | 7 | 0 |
| team-hub/delivery-routes.test.mjs | 4 | 4 | 0 |
| team-hub/delivery-submit.e2e.test.mjs | 1 | 1 | 0 |
| team-hub/event-delivery.test.mjs | 31 | 31 | 0 |
| team-hub/event-delivery-wiring.test.mjs | 7 | 7 | 0 |
| **team-hub/metrics.test.mjs** | **3** | **2** | **1（R2）** |
| plugins/tests/write-eligibility.test.mjs | 8 | 8 | 0 |
| plugins/tests/legacy-convergence.test.mjs | 6 | 6 | 0 |
| workbench/scripts/delivery-ui.test.mjs | 6 | 6 | 0 |
| **合计** | **177** | **176** | **1** |

- **R2 复现与根因**（[metrics-red.txt](T173-evidence/round5/metrics-red.txt)）：`node --test team-hub/metrics.test.mjs` → `✖ TC-S4-12/13 ... sameFileWriteBlocked.value >= 1`；探针显示写入口径 `repoId=d:/project/DSH/legion/.git`、事件表 `FILE_CONTENTION×1 / RESERVED×2`，而测试查询 `?repoId=scope%3Adefault` ⇒ 指标值恒 0。**这是测试与实现的口径分叉，归属 coder。**

### 3.5 冒烟与文档门禁

| 项 | 结果 |
| --- | --- |
| chat-l1-smoke.mjs（对话 L1） | ✅ 35/35 断言通过，进程级异常 0 |
| chat-s2-smoke.mjs（对话 S2 数据面） | ⛔ 8/9：唯一失败 S2-A `GET / → 200 + html`（实得 404）= `workbench/dist` 未产出 |
| files-s5-smoke.mjs（文件 S5 数据面） | ✅ 32/32 |
| whiteboard 真实进程探活 + 首页 | ✅ `/healthz 200`、`GET / 200 html (2318 bytes)` |
| v1 看板 `/api/config` | ✅ auth=true（`--token` 生效），子进程已回收 |
| `check-docs.mjs` | ✅ exit 0（README + FEATURES 结构/链接/索引，11 类全绿） |
| `spec-progress.mjs --check` | ✅ exit 0（进度区与台账一致 141/146） |
| `dsh-pin-drift.mjs` | ✅ exit 0（[pin-drift.txt](T173-evidence/round5/pin-drift.txt)） |

---

## 4. 部署 / 发布清单

### 4.1 发布前置（pre-flight，缺一不发布）

| # | 前置项 | 判据 | 本轮状态 |
| --- | --- | --- | --- |
| P1 | 上游验收结论 | T-171 审查通过、T-172 测试全绿 | ⛔ T-171 不通过 / T-172 整体不通过（历史） |
| P2 | 完整 CI 全绿 | `node scripts/ci/run-ci.mjs` exit 0 | ⛔ boundary FAIL（R1）；build/test/smoke/stage 受沙箱限制未能在本会话判定 |
| P3 | 交付配置可被自己校验 | `.legion/delivery.json` 经 `loadDeliveryConfig` `ok=true` | ✅ ok=true / errors=[] / verifyCount=13（[06-wiring.txt](T173-evidence/round5/06-wiring.txt)） |
| P4 | 生产接线存在真实消费者 | 治理入口有非测试调用者 | ✅ 已确认（claim→`writeIntentStore.reserve`、`integration-runner.mjs`→`createIntegrationWorker`、`plugins/src/index.ts:1653`→`POST /api/deliveries/submit`、`legacyConvergence` 接 `index.ts`/`mediation.ts`） |
| P5 | 文档同步 | FEATURES §3.20 + F-21 索引 + README 引导段 + `check-docs` 绿 | ✅ 三处齐备，`check-docs` exit 0 |
| P6 | 授权 | 将军批准发布生产 | ⛔ 未授权 |

### 4.2 发布步骤（E4 验收环境；本会话未执行，供授权后照做）

1. **取数备份**：停 team-hub 写流量 → 复制 `team-hub/team.db`（含 `-wal`/`-shm`）到备份目录；记录当前 `git rev-parse HEAD`。
2. **合入**：由将军在验收通过后 promote（士兵不 push；pre-push 拦 `w/*`）。本会话无法提交，见 §6.0。
3. **安装依赖**：`cd workbench && pnpm install --frozen-lockfile`（本会话无 store 且禁网，未执行）。
4. **构建**：`cd workbench && pnpm build`（= `tsc --noEmit && vite build`）→ 校验 `workbench/dist/index.html` 存在且引用 `assets/*`；另跑 `node whiteboard/scripts/build.mjs`。
5. **迁移自检**：以现有旧库启动 team-hub 一次，确认 `ensureColumn` 幂等加列（`tasks.scheduling_state`/`delivery_state`）与 3 张新表创建成功、旧任务 `delivery_state` 显示 `legacy-unknown`。
6. **启动与健康**：启动 team-hub（`:8787`）、workbench（dist 静态服务）、plugins 宿主重载；`GET /api/health` 与看板首页可开。
7. **灰度开关**：先 `LEGION_INTEGRATION_MODE=observation`（只观察不改派工），按设计 §10 逐级到 `scheduling`、`integration`；**每级只在同仓库唯一模式**。

### 4.3 验证项清单（发布后逐条核）

| # | 验证项 | 方法（期望） | 本轮可核状态 |
| --- | --- | --- | --- |
| V1 | 旧库可启动、无数据丢失 | 启动日志无迁移错误；任务计数与升级前一致 | 待验收环境 |
| V2 | 加列与建表 | `PRAGMA table_info(tasks)` 含 `scheduling_state`/`delivery_state`；3 张新表存在 | 待验收环境 |
| V3 | 历史任务不冒充已交付 | 旧任务 `delivery_state=legacy-unknown`，不自动置 `done` | `delivery-store.test.mjs` 12/12 绿（逻辑已覆盖） |
| V4 | 等待不烧重试 | `FILE_CONTENTION` 任务保持 `todo`、`scheduling_state=waiting-file`、`fixCount` 不增 | `claim-policy`(39)、`claim-reservation.e2e`(1)、`write-intent-routes`(7) 绿 |
| V5 | 同仓库唯一集成入口 | 启用 integration 后旧 `autoPromote`/`mediation` 被拒且 job 有唯一执行者 | 接线已交付；`integration-runner`/`integration-worker` 套件绿，端到端待 tester |
| V6 | 交付配置生效 | `loadDeliveryConfig` ok=true，验收命令来自 `argv` 白名单 | ✅ 本轮 ok=true（13 条） |
| V7 | 集成后验证失败不改目标分支 | 目标 ref SHA 不变，任务停在 `needs-review`（设计 §11.5） | `integration-worker` 9/9 绿 |
| V8 | 指标不可读不显示为 0 | `/api/metrics/repository` 返回 `available:false` + reason | TC-S4-11 绿；**TC-S4-12/13 红（R2）** |
| V9 | 用户可见徽标 | 任务卡/详情出现调度与交付徽标 | `delivery-ui.test.mjs` 6/6 绿；真机待验收环境 |

### 4.4 回滚方案

1. **代码回滚**：将军按需 revert 本批 commit（`5e32ae8` 及其 promote/接线补齐）。**只关闭新任务的自动认领与集成，不删除数据库记录、预约、分支或临时工作区**（设计 §10 末段）。
2. **开关回滚（首选，代价最小）**：`LEGION_INTEGRATION_MODE=legacy` 即回到旧直合并通道；无需回滚 schema。
3. **在制 job 对账后再切**：切回旧通道前，先对账 `integration_jobs`/`integration_events`（`prepared/applying/ref-updated/finalized`）与 Git 目标 ref，确认「未应用 / 已应用未记账 / 结果不明」；结果不明时暂停集成并保留分支，禁止自动删除。
4. **数据库回滚**：本批迁移为**加性**（`ensureColumn` + 新表），旧代码可忽略新列/新表；如需彻底回退，用 §4.2 步骤 1 的备份恢复 `team.db`（恢复前再次停止写流量）。
5. **产物回滚**：`workbench/dist` 与 whiteboard 静态产物用上一版快照覆盖；前端发布后需强刷（非热更）。

---

## 5. 变更影响与验证结果（go/no-go）

### 5.1 本轮真红（R1 / R2，均归属 coder，不在 devops 边界内）

| # | 红项 | 证据 | 归属判断 |
| --- | --- | --- | --- |
| R1 | `boundary`（PRT-108 棘轮）exit 1，8 处违规 / 6 文件：`plugins/src/index.ts`（ctx.subagents 实际 11 / 基线 6）+ `plugins/tests/worker-regression.test.mjs`(×3+`ctx.agents`×3) + `tests/p13-fixture/control-plugin.mjs` + `tests/p13-fixture/real-codex-cancel.mjs` + `tests/p13-fixture/real-codex-system-proxy-connectivity.mjs` + `workbench/src/components/AgentWorkflowConfigurator.tsx` | [boundary-check.txt](T173-evidence/round5/boundary-check.txt) | 既有红：`scripts/ci/dsh-boundary-baseline.json` 仍写 `ctx.subagents: 6`；棘轮口径「只许减不许增」，新增调用点直接红。**需 coder 修复轮**（devops 不改业务代码） |
| R2 | `team-hub/metrics.test.mjs` TC-S4-12/13 断言失败：`sameFileWriteBlocked.value >= 1` 实得 0 | [metrics-red.txt](T173-evidence/round5/metrics-red.txt) | 写入口径解析出真实 repoId（`d:/project/DSH/legion/.git`），测试按 `scope:default` 查询 ⇒ 口径分叉。**归属 coder**（改测试或改路由由 coder 判定） |

> 说明：R2 是本轮**新发现**（将军此前报告「boundary 是唯一红」时 test 阶段尚未跑完）。两棵不同的树（worktree 与 T-172 时的读数）口径不同，故 R2 在 T-172 报告里曾是 3/3 绿——实现侧仓库身份口径变化后测试未同步。

### 5.2 会话沙箱限制（非代码缺陷，未冒充通过）

| 限制 | 现象 | 影响 |
| --- | --- | --- |
| 子进程 pipe 被禁 | `spawn/spawnSync/execFileSync` 带 `stdio:'pipe'` ⇒ `EPERM`（探针 [probe-spawn.mjs](T173-evidence/round5/probe-spawn.mjs)） | `run-ci` 编排、`node --test` 运行器、`vite build`(esbuild 服务) 结构性不可用；本轮用 [sandbox-pipe-shim.cjs](T173-evidence/sandbox-pipe-shim.cjs)（pipe→临时文件 fd）与逐文件直跑替代 |
| 符号链接/junction 被禁 | `symlinkSync vendor/cordis -> team-hub/node_modules/cordis` ⇒ `EPERM` | `run-ci` test 阶段在此 FAIL；已改为逐文件直跑目标套件 |
| 共享 `.git` 只读 | `fatal: Unable to create '.git/worktrees/T-173/index.lock': Permission denied` | 无法 add/commit/merge；基线对齐改用 `GIT_INDEX_FILE` + `read-tree main`（§6.0） |
| esbuild 服务不可用 | `TypeError: Cannot read properties of undefined (reading 'on')` | `vite build` 无法产出 `workbench/dist` ⇒ `smoke` S2-A 与 `stage` 连带 FAIL |

### 5.3 已消解的旧红（上一版 DEPLOY.md 的 NO-GO 依据）

| 旧依据 | 本轮复核 | 证据 |
| --- | --- | --- |
| ① `config/scan.mjs --check` exit 1（50 项未登记） | **已消解**：exit 0 PASS，mode=git-tracked，1443 字面量 | [scan-check.txt](T173-evidence/round5/scan-check.txt) |
| ② 生产接线无消费者 | **已消解**：claim 事务授予预约、integration-runner 消费 worker、交付 HTTP 面被 plugins 调用 | [06-wiring.txt](T173-evidence/round5/06-wiring.txt) |
| ③ `.legion/delivery.json` 13 条 verify 缺 id | **已消解**：`loadDeliveryConfig` ok=true / errors=[] / 13 条 | [06-wiring.txt](T173-evidence/round5/06-wiring.txt) |

### 5.4 go/no-go

- **GO 条件**：P1–P6 全绿；R1、R2 由 coder 修复并登记；`run-ci` 在**干净 main 检出**（无沙箱限制）上 9 阶段全绿；将军授权发布。
- **本轮判定：NO-GO**。不进入验收发布；不启用 `LEGION_INTEGRATION_MODE=integration`；`legacy` 默认行为可保持现状。
- **明确不是失败**：构建的类型检查与白板构建真实通过、配置面/文档/依赖门禁真实通过；红与未执行项均已定位到具体归属（coder 修复面 / 环境限制）。

---

## 6. 沙箱限制与复跑说明

### 6.0 基线对齐与「无法提交」

将军要求先对齐 main 再跑。本会话沙箱下 `.git` 在工作树外且**只读**，`git merge/commit/add` 均被拒（原文：[01-baseline.txt](T173-evidence/round5/01-baseline.txt) §7）。因此对齐采用**只写工作树 + 工作树内索引**的等价方式：

```powershell
$env:GIT_INDEX_FILE = "$PWD\.git-local-index"
git read-tree main          # 索引 := main 树
git checkout main -- .      # 工作树内容 := main
git diff --stat             # (empty) —— 工作树 == 索引 == main 3b0dd879
```

效果与将军预演的 `git merge main` 对齐后一致（树内容相同）；差别只是**分支 HEAD 仍是 `66c85a0e`**，所以 CI 自带的脏树警告会如实报「316 改 + 11 未跟踪」。**合并/提交动作请由将军或普通终端执行**（`git merge main` 后 `git add -A && git commit`）。

**本轮已清理旧脚手架**（`.ci-main/` 71.7MB、`.tmp-verify/` 56.5MB、`.ci-run-env/`、`.ci-main-index`、`.scan-*.txt`、`.ci-full-run.txt`）——本会话无法写共享 `.git/info/exclude`，故以删除代替排除。清理后未跟踪项只剩 `.git-local-index`（会话内索引，可删）+ 本任务交付物；收尾复核见 [07-final-recheck.txt](T173-evidence/round5/07-final-recheck.txt)。

### 6.1 普通终端（无沙箱限制）复跑命令

```powershell
cd D:\project\DSH\legion\.legion-worktrees\T-173
git merge main                                   # 或由将军 promote
node scripts/config/scan.mjs --check             # 期望 exit 0（PASS，1439–1443 字面量）
node --test scripts/config/config.test.mjs       # 期望 53/53（本轮未跑：见下）
node scripts/ci/run-ci.mjs --only env            # 期望 [env] PASS
node scripts/ci/run-ci.mjs                       # 完整 9 阶段（build 需 workbench/node_modules）
node scripts/ci/dsh-boundary.mjs --check         # 期望仍红（R1），coder 修复后转绿
```

> 本轮**未跑** `node --test scripts/config/config.test.mjs`：它内部会 spawn（pipe 被沙箱拦）且部分断言依赖 git-tracked 口径；将军已在主工作树独立给出 53/53 读数，本文件不重复冒领。

---

## 7. 验收标准逐条对应

| 验收标准 | 结论 | 证据 |
| --- | --- | --- |
| 构建 / CI 真实跑通（命令输出为证） | **部分达成（如实标注）**：白板 build exit 0、workbench `tsc --noEmit` exit 0（1068 文件）、完整 CI 的 syntax/env/deps/doc PASS、目标套件 176/177；`vite build`、`run-ci` test 阶段因沙箱 pipe/symlink 限制不可执行；`boundary`/R1 与 `metrics`/R2 为真实红 | §3、[goal-suites.txt](T173-evidence/round5/goal-suites.txt)、[ci-full/](T173-evidence/round5/ci-full/summary.json)、[build-workbench-tsc.txt](T173-evidence/round5/build-workbench-tsc.txt)、[vite-build.txt](T173-evidence/round5/vite-build.txt) |
| 部署 / 发布清单含：环境、步骤、验证项、回滚方案 | **达成** | §2（环境 E1–E5）、§4.2（步骤）、§4.3（验证项 V1–V9）、§4.4（回滚） |
| 说明变更影响与验证结果 | **达成** | §1（影响面）、§3（验证读数）、§5（红项归属 + go/no-go） |
| 用户可见行为变更须同步 FEATURES 小节 + 功能索引 + README 引导段（纯重构豁免） | **达成（批次既有同步 + 门禁绿）**：FEATURES §3.20、F-21 索引、README 引导段均在 main 且 `check-docs` exit 0；本 devops 任务自身无用户可见变更 | §1.3、§3.5 |

---

## 8. 边界遵守与后续动作

- ✅ 只做构建与部署类操作并按清单留痕（§1–§4、§6）；✅ **未改业务功能代码**（本轮只新增/改写 `docs/G-mujfc9vi-1/` 下 DEPLOY.md 与 `T173-evidence/round5/`）；✅ 未跳过已能执行的门禁（红项如实登记）；✅ **未发布生产**（E5 未授权，go/no-go = NO-GO）；✅ 未 push、未 promote。
- 后续动作（供将军排程）：① 开 coder 修复轮处理 **R1 boundary 基线**与 **R2 metrics 口径**；② 在**无沙箱限制的干净 main 检出**上跑完整 `node scripts/ci/run-ci.mjs`（含真正的 `vite build`/`dist`/smoke/stage），把逐阶段读数补进本文件 §3.1；③ tester 按设计 §11.1 九场景做端到端复测；④ 将军批准后按 §4.2 发布，按 §4.4 预备回滚。

*（本文件由 T-173 devops 产出：命令与原始输出见 [T173-evidence/round5/](T173-evidence/round5/README.md)；未修改任何业务功能代码，未调用 taskctl/看板写接口，未 push。）*
