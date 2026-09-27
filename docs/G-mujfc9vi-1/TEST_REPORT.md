<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-27**（w/T-172 HEAD 0be2781）的基线，其中的 file:line、命令与结论只代表当时状态。本报告验证对象为 T-170 编码提交 5e32ae8。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· 最新 CI 证据 .ci/&lt;run&gt;/summary.json。
<!-- evidence-banner:end -->

# T-172 测试执行报告：并行任务文件冲突治理

> 阶段：测试执行（tester）｜任务：T-172（[auto-goal]｜所属目标 G-mujfc9vi-1 · software · chain）
> 被验证对象：T-170 编码提交 `5e32ae8`（分支 w/T-170，42 文件 +4088/−1）；本 worktree HEAD = `0be2781`（promote T-171）。
> 上游依据：设计 [2026-09-27-parallel-task-conflict-control-design.md](../../superpowers/specs/2026-09-27-parallel-task-conflict-control-design.md)、切片 [TASK_BREAKDOWN.md](TASK_BREAKDOWN.md)、用例 [TEST_CASES.md](TEST_CASES.md)、审查 [T-171-REVIEW.md](../review/T-171-REVIEW.md)。
> 环境：Windows / Node v24.19.0 / git 2.55.0.windows.5；**worktree 内无 node_modules**（无 pnpm/vite/tsc 依赖），DSH 沙箱下 `run-ci.mjs` 子进程 `spawn EPERM`。
> 证据目录：[T172-evidence/](T172-evidence/README.md)（可复跑脚本 + 原始日志）。

---

## 0. 结论

**不通过（红）。**

- **模块/契约层全绿**：13 个套件（本批新增 12 + claim-policy 基线）**123 例 pass / 0 fail**；回归抽样 6 套件 **148 例 pass / 0 fail**；`check-docs.mjs` exit 0；`node --check` 7 个改动文件全 exit 0。
- **生产接线/端到端为红**：以真实运行时复现确认 4 项此前审查指出的严重缺口全部成立，并新增确认 4 类问题；另有 2 个声明回归门禁因缺构建产物无法执行。
- 按验收标准「**全绿才判定通过**」：本批**不满足放行条件**。失败项均给出复现命令、实际输出与归属（文件:行 / 切片），详见 §3。

一句话：**纯函数与仓储层实现质量可接受（123 例真实全绿），但「声明交付的生产接线与端到端行为」大面积未交付——测试全绿不能推出交付完整。**

---

## 1. 环境与执行方法

- 工作目录 = 工作树根 `D:\project\DSH\legion\.legion-worktrees\T-172`（分支 w/T-172）；未对 live 库 / 主工作区做任何写入型验证（全部 mkdtemp 临时库 / 系统临时仓库）。
- 只读验证，未修改任何被验证代码；本报告与 `T172-evidence/` 是唯一新增产物。
- 执行方式：`node <file>`（`.mjs`）与 `node --experimental-strip-types <file>`（`.ts` 依赖的插件/前端纯函数）；隔离 hub 用 `TEAM_HUB_DB=mkdtemp` + `listen(0)`。
- 无法执行：`tsc -p plugins/tsconfig.json --noEmit`、`pnpm --dir workbench build`、`node scripts/ci/run-ci.mjs` 全量阶段（无依赖 + 沙箱 EPERM，见 §6）。

---

## 2. 全绿部分：实跑命令与读数

13 个新增/直接相关套件（原始日志 [01-suites.txt](T172-evidence/01-suites.txt)）：

| 套件（命令） | 用例 | 结果 |
| --- | --- | --- |
| `node packages/shared/test/path-domain.test.mjs` | 9 | pass 9 / fail 0 |
| `node packages/shared/test/repo-identity.test.mjs` | 6 | pass 6 / fail 0 |
| `node team-hub/write-intent-store.test.mjs` | 13 | pass 13 / fail 0 |
| `node team-hub/claim-policy.test.mjs` | 39 | pass 39 / fail 0（基线 35 + 新增 4） |
| `node team-hub/git-plumbing.test.mjs` | 6 | pass 6 / fail 0 |
| `node team-hub/delivery-store.test.mjs` | 11 | pass 11 / fail 0 |
| `node team-hub/integration-worker.test.mjs` | 7 | pass 7 / fail 0 |
| `node team-hub/write-intent-routes.test.mjs` | 5 | pass 5 / fail 0 |
| `node team-hub/delivery-routes.test.mjs` | 4 | pass 4 / fail 0 |
| `node team-hub/metrics.test.mjs` | 3 | pass 3 / fail 0 |
| `node --experimental-strip-types plugins/tests/write-eligibility.test.mjs` | 8 | pass 8 / fail 0 |
| `node --experimental-strip-types plugins/tests/legacy-convergence.test.mjs` | 6 | pass 6 / fail 0 |
| `node --experimental-strip-types workbench/scripts/delivery-ui.test.mjs` | 6 | pass 6 / fail 0 |
| **合计** | **123** | **123 pass / 0 fail** |

回归抽样（原始日志 [01-suites.txt](T172-evidence/01-suites.txt)）：

| 套件 | 用例 | 结果 |
| --- | --- | --- |
| `node team-hub/run-store.test.mjs` | 43 | pass 43 / fail 0 |
| `node team-hub/schema-util.test.mjs` | 6 | pass 6 / fail 0 |
| `node team-hub/members-routes.test.mjs` | 8 | pass 8 / fail 0 |
| `node team-hub/create-routes.test.mjs` | 10 | pass 10 / fail 0 |
| `node team-hub/chat.test.mjs` | 51 | pass 51 / fail 0 |
| `node team-hub/task-lifecycle-routes.test.mjs` | 30 | pass 30 / fail 0 |
| **合计** | **148** | **148 pass / 0 fail** |

门禁与语法：

| 命令 | 结果 |
| --- | --- |
| `node scripts/ci/check-docs.mjs` | exit 0，PASS（11 类校验项全绿） |
| `node --check team-hub/server.mjs`、`routes/{write-intent,delivery,metrics}.mjs`、`plugins/src/{writeEligibility,legacyConvergence}.ts`、`workbench/src/deliveryBadge.ts` | 7/7 exit 0 |
| `node docs/G-mujfc9vi-1/T169-evidence/machcheck-test-cases.mjs` | exit 0；140 条用例 / 50 AC 全覆盖 / 42 BR 配对 / 8 骨架语法 OK |

---

## 3. 失败项：复现步骤、实际结果与归属

> 所有输出可在 [02-gap-repro.txt](T172-evidence/02-gap-repro.txt) 复读；脚本在 [T172-evidence/](T172-evidence/README.md)。

### F1【严重】守护 claim 未授予写入预约（S2 接线未交付）

- **复现**：`node docs/G-mujfc9vi-1/T172-evidence/e2e-claim-reservation.mjs`
  1. 隔离 hub 建任务 T-a / T-b，两者 intent 均含 `src/a.mjs`；
  2. `POST /api/tasks/T-a/reservation` → 200，产生活跃预约；
  3. 走**守护真实入口** `POST /api/claim` 认领 T-b。
- **实际结果**：claim 返回 200；`T-b.status=in_progress`、`scheduling_state=unplanned`、`write_reservations` 中 T-b **0 条**。
- **期望**（设计 §5.1、TC-S2-02、E2E-1）：T-b 保持 `todo` / `waiting-file`，返回结构化 `FILE_CONTENTION{paths,holderTaskId}`，不产生预约、不消耗重试。
- **归属**：`team-hub/server.mjs:4385-4407 claimTask` 事务体只做 `UPDATE tasks SET status='in_progress'`，无冲突检查/预约/epoch；`team-hub/write-intent-store.mjs:382 claimWithReservation`、`team-hub/claim-policy.mjs:341 selectEligibleCandidate` 在生产代码**无调用点**（`git grep` 只命中定义）。

### F2【严重】`.legion/delivery.json` 校验不通过（S8 验收 2/3 未达）

- **复现**：`node -e "import('./team-hub/verify-config.mjs').then(m=>console.log(m.loadDeliveryConfig(process.cwd())))"`
- **实际结果**：`ok=false`，`errors=[verify[0..12].id 缺失]`（13 条），`config=null`。
- **期望**（TC-S8-03、TC-S8-06）：`ok=true`；`targetRef=refs/heads/main`；13 条 verify 的 argv/timeoutMs 合法。
- **归属**：`.legion/delivery.json` 每条用 `"name"`；`team-hub/verify-config.mjs:46` 要求 `v.id`。**后果**：即便 worker 接线，凡加载此配置的交付都会命中 `NO_VERIFY_CONFIG`（`integration-worker.mjs:113-115`）而停 `needs-review`。

### F3【严重】集成 worker 无生产执行者（S3 缺执行侧）

- **复现**：`git grep -n "createIntegrationWorker" -- ':!*.test.*'`
- **实际结果**：仅 `team-hub/integration-worker.mjs:74` 定义与 :89-91 的入参校验；全仓无 runner/常驻循环/路由消费 `integration_jobs`，`runJob`/`recover` 只被测试调用。
- **期望**（设计 §8、TC-S3-07、E2E-4/6）：队列有消费者、`recover` 有入口。
- **归属**：`team-hub/integration-worker.mjs:74`；`team-hub/routes/delivery.mjs:68` 只有认领路由，无执行侧。

### F4【严重】integration 模式旧通道只拒不入队，且主动下发人工 git merge 指引（S6 验收 1）

- **复现**：`Select-String -Path plugins/src/index.ts -Pattern 'refuse-legacy|自动合入失败'`
- **实际结果**：`index.ts:1482-1485` refuse-legacy 只 `log` + `return false`；调用方 `:1859-1865`、`:1901-1907` 把 false 当「自动合入失败」→ `transitionTo('in_review')` 并在 `:1861/:1903` 评论里要求人工执行 `git merge --no-ff w/<id>`。`enqueueIntegration` 仅出现在 `plugins/src/legacyConvergence.ts:23/39/46/52`，**无消费者**。
- **期望**（设计 §10/§12、TC-S6-01/02、E2E-11）：拒绝分支真正入队唯一集成入口（`POST /api/deliveries`），且不出现「手工 git merge」路径。
- **归属**：`plugins/src/index.ts:1482-1485`、`:1859-1865`、`:1901-1907`；`plugins/src/legacyConvergence.ts:36-42`。

### F5【高】mediation 在拒绝前已 stash 且不还原（数据安全，违反 I-6）

- **复现**：`Select-String -Path plugins/src/mediation.ts -Pattern 'stash|pop'`
- **实际结果**：`:306` 先 `git stash push`，`:311-314` 判 refuse-legacy 后直接 `return`——**跳过**其他全部分支都有的 `stash pop`（:324/:336/:345/:354/:363/:376/:386）。integration 模式下用户已跟踪改动会被悄悄 stash 且不还原。
- **期望**（设计 §9、TC-S6-11、I-6）：不 stash、不覆盖；确需早返回先 `stash pop` 恢复现场。
- **归属**：`plugins/src/mediation.ts:304-315`。

### F6【高】守护侧写入资格未接线（S5 声明产出缺失）

- **复现**：`git grep -n -e writeEligibility -e evaluatePreExecute -e schedulingView -e freezeRunRequest -- ':!*.test.*'`
- **实际结果**：只命中 `plugins/src/writeEligibility.ts` 自身定义/注释；`plugins/src/index.ts` 无 import、无调用。`git show --stat 5e32ae8` 的插件侧只有 `index.ts +7`、`legacyConvergence.ts`、`mediation.ts +7`、`writeEligibility.ts`——S5 声明的 `workspace.ts` 改动**不在 diff 中**。
- **期望**（TASK_BREAKDOWN S5、TC-S5-01..19）：守护 claim/派工/pre-execute/运行中扩域/等待视图接线，`tasks.scheduling_state` 会被守护写成 `waiting-file`。
- **归属**：`plugins/src/index.ts`（缺 import/调用）、`plugins/src/writeEligibility.ts:69/109/135`（纯函数无生产调用者）。

### F7【高】Workbench 徽标数据链断裂 + legacy-unknown 缺失 + unreadableBadge 无调用（S7 端到端未交付）

- **复现 1**：`git grep -n -e schedulingState -e deliveryState team-hub/server.mjs` → 无命中（exit 1）。
- **复现 2**：`node docs/G-mujfc9vi-1/T172-evidence/e2e-task-fields.mjs` → `GET /api/task` 返回 200，但任务对象无 `schedulingState/deliveryState`（仅 `blockedBy`）；DB 列 `scheduling_state/delivery_state` **确实存在**。
- **复现 3**：`deliveryBadgeOf({deliveryState:'legacy-unknown'})` → `null`（TC-S7-03 未达）；且 `awaiting-acceptance` 被标成「待裁决」、`integrated` 标成「已集成」，与设计 §3.2/§7 的「待验收/已交付」不一致。
- **复现 4**：`unreadableBadge` 仅定义于 `workbench/src/deliveryBadge.ts:90`，非测试代码无组件调用点。
- **期望**（TC-S7-01/03/04/10）：徽标由实时数据面驱动并如实显示；不可读显示「暂无读数及原因」。
- **归属**：`team-hub/server.mjs:1966-2010 rowToTask`（`getTask`/`listTasks` 的唯一序列化函数）；`workbench/src/deliveryBadge.ts`（缺 legacy-unknown、`unreadableBadge` 未接组件）。

### F8【中】客户端可自造仓库身份与目标 ref（I-8 服务端权威未达）

- **复现**：`node docs/G-mujfc9vi-1/T172-evidence/e2e-client-repo-identity.mjs`
- **实际结果**：`POST /api/tasks/T-x/write-intent {repoId:'attacker-pool', targetRef:'refs/heads/evil'}` → **200**，且落库 `repoId=attacker-pool`、`targetRef=refs/heads/evil`。
- **期望**（设计 §4/§8、TC-S4-06/07/08、E2E-9）：服务端从 DB/空间绑定解析仓库身份与 target ref，忽略/拒绝浏览器传入身份与任意 Git ref。
- **归属**：`team-hub/routes/write-intent.mjs:49-65`（`resolveRepoId` 直接采用 `body.repoId`，只挡绝对路径/shell；`resolveTargetRef` 接受任意完整 ref）。

### F9【中】delivery-store 认领无事务（并发唯一性不成立）

- **复现**：`git grep -n -e 'BEGIN IMMEDIATE' -e withTx team-hub/delivery-store.mjs` → 无命中（exit 1）。
- **实际结果**：`claimIntegrationJob` 先 SELECT 活跃 job 再 INSERT，无事务、无唯一约束。
- **期望**（设计 §6.2、TC-S3-07）：事务化认领 + epoch 租约，保证「同仓库同 target ref 至多一个活跃 job」跨进程成立。
- **归属**：`team-hub/delivery-store.mjs:250-265`（整个 store 无 `BEGIN IMMEDIATE`/`withTx`）。

### F10【中】S6 done 语义/仓库级模式/回滚纯函数无生产调用点

- **复现**：`git grep -n -e resolveRepoMode -e canProduceDone -e observationMarker -- ':!*.test.*'`
- **实际结果**：三者仅定义于 `plugins/src/legacyConvergence.ts:57/67/72`，无调用；`planRollback`（legacy 版，:77）同样无调用者（`product/upgrade` 里的同名函数是另一模块）。
- **期望**（设计 §3.2/§10、TC-S6-04..15）：done 仅在 integrated + 原验收通过后产生、同仓库单一模式、回滚入口生效。
- **归属**：`plugins/src/legacyConvergence.ts:57/67/72/77`。

### F11【回归门禁未绿】两个声明回归门禁因缺构建产物不可执行

- **复现**：`node --experimental-strip-types plugins/tests/workspace.test.mjs`、`node --experimental-strip-types plugins/tests/mediation.test.mjs`
- **实际结果**：均 exit 1，`ERR_MODULE_NOT_FOUND`（`plugins/lib/workspace.js` / `plugins/lib/mediation.js` 不存在，未构建）。
- **归属/性质**：环境受限（worktree 无 node_modules、禁联网），**不是代码 bug 结论**，但 TC-S5-20 / TC-S6-14 声明的门禁非绿，不得冒充通过。

---

## 4. 逐切片 / 验收口径对照

| 切片 | 模块/契约层（实跑） | 生产接线 / 端到端 | 判定依据 |
| --- | --- | --- | --- |
| S1 路径域与仓库身份 | 15/15 绿 | 纯函数无需接线 | path-domain 9 + repo-identity 6；TC-S1-01..14 |
| S2 写入意图/预约/claim 接线 | 52/52 绿 | **未达**：claim 不授予预约 | F1（E2E-1 runtime） |
| S3 交付/集成 worker | 24/24 绿 | **未达**：worker 无执行者；delivery.json 无效 | F2、F3 |
| S4 HTTP 路由与指标 | 12/12 绿 | **部分未达**：客户端可自造 repoId/ref | F8 |
| S5 守护写入资格 | 8/8 绿 | **未达**：纯函数无生产调用 | F6、F11 |
| S6 legacy 收敛 | 6/6 绿 | **未达**：拒绝后不入队 + mediation stash 泄漏 | F4、F5、F10、F11 |
| S7 Workbench 交付面 | 6/6 绿 | **未达**：数据链断裂、legacy-unknown 缺失 | F7 |
| S8 CI 登记/验证声明/文档 | 登记与 check-docs 绿 | **未达**：delivery.json 校验 ok=false | F2 |

## 4.1 端到端九场景（E2E）结论

| 用例 | 结论 | 说明 |
| --- | --- | --- |
| E2E-1 同文件互斥/异文件并行 | **FAIL** | claim 不判冲突（F1） |
| E2E-2 路径判准矩阵 | **PASS** | path-domain 套件覆盖段边界/大小写/重命名两端 |
| E2E-3 动态扩域撞车保留产物 | **FAIL** | 扩域在 S2 store 层通过，但守护未接线、生产不可达（F1/F6） |
| E2E-4 同文件串行交付 | **FAIL** | worker 无执行者（F3）、claim 未接线（F1） |
| E2E-5 集成后验证失败 ref 不变 | **FAIL** | worker 无生产调用（F3）；delivery.json 无效（F2） |
| E2E-6 崩溃恢复至多集成一次 | **FAIL** | `recover` 无生产入口（F3） |
| E2E-7 脏工作区暂停且字节不变 | **部分** | worker 侧单测通过；mediation 侧 **未达**（F5） |
| E2E-8 人审打回与隔离成果 | **FAIL** | done/回滚语义未接线（F10） |
| E2E-9 多空间同仓库多 worker | **FAIL** | 客户端自造 repoId（F8）+ store 无事务（F9） |
| E2E-10 发布门槛九场景 | **FAIL** | 聚合结论（多项未达） |
| E2E-11 默认决策审计 | **部分** | 未发现「强制同写」入口（无此端点）；但旧通道下发人工 merge 指引（F4） |

---

## 5. 回归范围与结论

- **回归范围**（与本批改动文件域直接相关）：team-hub 数据面/路由（run-store、schema-util、members-routes、create-routes、chat、task-lifecycle-routes、claim-policy），新增 13 套件，plugins 两个声明回归门禁（mediation、workspace），文档门禁 check-docs。
- **结论**：
  1. 既有基线**未回归**：148 例回归抽样 + claim-policy 39 例（由基线 35 增至 39）全部 pass/0 fail。
  2. 新增模块/契约层 123 例全绿，但**不代表生产接线正确**（123 例全是纯函数/单模块测试，无一例断言接线）。
  3. `plugins/tests/mediation.test.mjs`、`plugins/tests/workspace.test.mjs` 两个声明门禁**不可执行**（缺构建产物），回归面存在空洞，见 F11。
  4. `check-docs.mjs` exit 0；7 个改动文件 `node --check` exit 0——文档与语法面无回归。

---

## 6. 未执行项与环境限制（如实记录，不冒充通过）

1. **类型检查 / 打包**：`tsc -p plugins/tsconfig.json --noEmit`、`pnpm --dir workbench build`（含 vite）——worktree 无 node_modules，且禁止联网安装依赖，未执行。
2. **前端 JSX 运行时行为**：无 DOM 测试环境，`TaskCenterView.tsx`/`TaskDetailModal.tsx` 接线未被任何用例执行；徽标仅验证到纯函数与任务 API 数据面（见 F7）。
3. **L4 全量 run-ci**：`node scripts/ci/run-ci.mjs` 在沙箱下 `[deps] junction 建立失败 EPERM`、`syntax/env/boundary/build/test/smoke` 均 `spawn EPERM`（子进程管道边界），无法整跑；登记面改用源码核对：本批 12 个新测试文件均已在 `scripts/ci/run-ci.mjs:1461-1472` 登记。
4. **跨仓库 git 传输**：集成夹具不做 `git push`/本地传输（沙箱限制），跨仓库路径未覆盖。
5. **未触碰**：live 库、主工作区、他人任务分支（I-2）。
6. **本 worktree 无法执行 git 写操作**：`git add`/`git checkout` 均因 `D:/project/DSH/legion/.git/worktrees/T-172/index.lock` 落在会话沙箱可写范围之外而报 `Permission denied`（非 `w/*` 保护所致）；故本报告与 `T172-evidence/` 以工作区未提交状态留痕，改动 diff 由守护捕获。`docs/G-mujfc9vi-1/T169-evidence/*.txt` 在 `git status` 中显示为 M，但 `git hash-object` 与 HEAD 完全一致（仅 core.autocrlf=true 的行尾噪声，`git diff --numstat` 为空）。

---

## 7. 复跑命令附录

```text
# 13 套件（123 例全绿）
node packages/shared/test/path-domain.test.mjs
node packages/shared/test/repo-identity.test.mjs
node team-hub/write-intent-store.test.mjs
node team-hub/claim-policy.test.mjs
node team-hub/git-plumbing.test.mjs
node team-hub/delivery-store.test.mjs
node team-hub/integration-worker.test.mjs
node team-hub/write-intent-routes.test.mjs
node team-hub/delivery-routes.test.mjs
node team-hub/metrics.test.mjs
node --experimental-strip-types plugins/tests/write-eligibility.test.mjs
node --experimental-strip-types plugins/tests/legacy-convergence.test.mjs
node --experimental-strip-types workbench/scripts/delivery-ui.test.mjs

# 回归抽样（148 例全绿）
node team-hub/run-store.test.mjs && node team-hub/schema-util.test.mjs && node team-hub/members-routes.test.mjs && node team-hub/create-routes.test.mjs && node team-hub/chat.test.mjs && node team-hub/task-lifecycle-routes.test.mjs

# 门禁
node scripts/ci/check-docs.mjs                                   # exit 0
node docs/G-mujfc9vi-1/T169-evidence/machcheck-test-cases.mjs    # exit 0

# 失败项复现（三支脚本 + 原始日志见 T172-evidence/）
node docs/G-mujfc9vi-1/T172-evidence/e2e-claim-reservation.mjs
node docs/G-mujfc9vi-1/T172-evidence/e2e-task-fields.mjs
node docs/G-mujfc9vi-1/T172-evidence/e2e-client-repo-identity.mjs
node -e "import('./team-hub/verify-config.mjs').then(m=>console.log(m.loadDeliveryConfig(process.cwd())))"
git grep -n -e selectEligibleCandidate -e claimWithReservation -e createIntegrationWorker -e enqueueIntegration -- ':!*.test.*' ':!docs/*'
```

---

## 8. 对上游验证的核对（防空转）

按团队技能「回归复跑先查上游验证防空转」：上游 T-171 已复跑 123 例并静态指出接线缺口，但**结论为「不通过，需修改后复审」**——目标**未**被上游验证交付。本轮不是同批空转复跑，而是：(1) 独立复跑全部套件确认读数；(2) 新增**运行时端到端复现**（隔离 hub claim、任务 API 字段、客户端自造身份），把审查的静态判断落成可执行证据；(3) 留痕到本报告与 [T172-evidence/](T172-evidence/README.md)。结论：目标尚未达到可放行状态，需修复后复审。
