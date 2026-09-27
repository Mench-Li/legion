# T-171 代码审查报告：并行任务文件冲突治理（审查对象 T-170 / commit 5e32ae8）

> 角色：reviewer（代码审查）｜任务：T-171（[auto-goal]｜所属目标 G-mujfc9vi-1 · software · chain）
> 审查对象：T-170 编码提交 `5e32ae8`（分支 w/T-170），42 文件 +4088/−1；本 worktree HEAD = `25b761c`（其后的 F-23 提交与本目标无关）。
> 设计基线：`docs/superpowers/specs/2026-09-27-parallel-task-conflict-control-design.md`（§3.2/§4/§5/§6/§7/§10/§11.1/§12）
> 切片依据：`docs/G-mujfc9vi-1/TASK_BREAKDOWN.md`（S1~S8）；用例依据：`docs/G-mujfc9vi-1/TEST_CASES.md`
> 纪律：本报告只出结论与证据，**不替人改代码**；所有结论均有可复跑命令或源码位置支撑。

---

## 0. 审查方法与本轮真实执行

真读代码（不是只看格式）：`team-hub/server.mjs`（claimTask/router/rowToTask）、`claim-policy.mjs`、`write-intent-store.mjs`、`delivery-store.mjs`、`integration-worker.mjs`、`routes/{write-intent,delivery,metrics}.mjs`、`verify-config.mjs`、`packages/shared/src/{path-domain,repo-identity}.mjs`、`plugins/src/{index.ts,writeEligibility.ts,legacyConvergence.ts,mediation.ts}`、`workbench/src/deliveryBadge.ts` 及其接线。

复跑证据（本 worktree 实跑，命令原样可复现）：

- 13 个新测试文件逐个 `node …` / `node --experimental-strip-types …` → **全部 exit 0，合计 123 pass / 0 fail**（与 TEST_REPORT 的「123 例全绿」一致）：
  `path-domain 9、repo-identity 6、write-intent-store 13、claim-policy 39、git-plumbing 6、delivery-store 11、integration-worker 7、write-intent-routes 5、delivery-routes 4、metrics 3、write-eligibility 8、legacy-convergence 6、delivery-ui 6`。
- `node scripts/ci/check-docs.mjs` → exit 0（PASS）。
- 接线静态核查：`git grep -n "selectEligibleCandidate|writeEligibility|createIntegrationWorker" -- ':!*.test.*'` → 三个符号在非测试代码中**只有定义点，无调用点**（下节逐条）。
- 配置真实性核查：`node -e "import('./team-hub/verify-config.mjs').then(m=>console.log(m.loadDeliveryConfig(process.cwd())))"` → `ok=false`，13 条 `verify[i].id 缺失`，`hasExecutableVerification=false`（见 M6）。

未执行项：`tsc --noEmit` / `vite build`（本 worktree 无 node_modules、禁联网）。JSX 运行时行为未执行——与 TEST_REPORT 一致。

---

## 1. 总体结论

**不通过（需修改后复审）。**

- 纯函数与仓储层（S1、S2 store、S3 store/git 接缝、S4 store 面、S7 纯函数、S8 测试登记）质量总体良好，123 例测试真实全绿，路径段边界、epoch/revision CAS、version CAS 409、`available:false+reason` 等核心行为有真实断言。
- 但 8 个切片里 **S2/S3/S4/S5/S6/S7/S8 均存在「模块已交付、生产接线未交付」或「声明的可测行为未落地」**：这属于**交付物与切片声明/设计契约不符**，不是环境限制。
- 当前默认 `LEGION_INTEGRATION_MODE` 未设 → `resolveIntegrationMode` 返回 `legacy`（`plugins/src/legacyConvergence.ts:28-31`），故默认行为与治理前一致、风险暂不暴露；**一旦按设计 §10 进入「调度/集成阶段」，系统会停摆或降级**（见 M1/M4）。
- 测试全绿但不能证明接线正确：123 例全部是纯函数/单模块测试，**没有任何一例断言核心接线**（claim 授予预约、守护申请资格、worker 消费队列、拒绝后入队），这正是「绿测试掩盖接线缺口」。

---

## 2. 将军指定的 4 项接线缺口 —— 逐条核实结论

| # | 项 | 结论 | 严重度 |
| --- | --- | --- | --- |
| 1 | 调度排队未接 claim | **不合格（声明行为未交付）** | 严重 |
| 2 | 守护未申报写入资格 | **需修正** | 高 |
| 3 | 集成 worker 无执行者 | **需修正** | 高 |
| 4 | 旧通道收敛只到「拒绝」 | **不合格（集成模式比现状更差）** | 严重 |

### 2.1 缺口 1 —— claim 事务未授予写入预约（不合格）

- 证据：`team-hub/server.mjs:4385` 的 `claimTask` 事务体只做 `UPDATE tasks SET status='in_progress' …`（:4403），**不读仓库活跃预约、不判路径交集、不写 reservation、不递增 lease epoch**；`server.mjs:5009-5016` 的 T-170 改动只有 import / 建表 / 路由注册三段。
- `team-hub/claim-policy.mjs:341 selectEligibleCandidate` 与 `team-hub/write-intent-store.mjs:382 claimWithReservation`（设计指定的 claim 事务）**在非测试代码中均无调用点**（`git grep` 只命中定义）。`selectEligibleCandidate` 只被 `claim-policy.test.mjs` 调用；`claimWithReservation` 无任何调用者。
- 后果：设计 §5.1 第 2 条「claim 事务同时授予 Attempt lease 与首次写入 reservation」与第 3 条「冲突候选跳过、不队头阻塞」**实际未生效**；「已认领但没有写入资格」的半状态防线不存在。
- 定位建议：把 `claimWithReservation`（或 `selectEligibleCandidate` + `reserve`）接进 `claimTask` 的同一 `withTx`，冲突返回结构化 `FILE_CONTENTION` 并保持 `todo/scheduling_state=waiting-file`、不增 `fixCount`。

### 2.2 缺口 2 —— 守护未申报写入资格（需修正）

- 证据：`plugins/src/writeEligibility.ts`（170 行，纯函数齐备）**在 `plugins/src/index.ts` 中无 import、无调用**（`git grep -n "writeEligibility" -- ':!*.test.*'` 只命中该文件自身；index.ts 的 T-170 改动仅 7 行＝1 行 import `legacyConvergence` ＋ 6 行 `autoPromote` 闸门）。
- 后果：S5 声明的「守护经 HTTP 申请写入资格/扩域并读等待原因、pre-execute 校验、RunRequest 授权快照」未交付；`tasks.scheduling_state` 不会被守护写成 `waiting-file`（只有外部 HTTP 调用 `POST /api/tasks/:id/reservation` 时才会，而调用方不存在）。
- `plugins/src/workspace.ts` 也未见「等待结束后从最新目标提交建工作区、不 reset WIP」的改动（切片 S5 声明的四个产出文件只交付了 `writeEligibility.ts` 一个）。

### 2.3 缺口 3 —— 集成 worker 在生产代码中无执行者（需修正）

- 证据：`team-hub/integration-worker.mjs:74 createIntegrationWorker` 在非测试代码中无调用点（`git grep` 只命中定义与错误消息）。`integration_jobs` 有表（`delivery-store.mjs:63`）与认领路由（`routes/delivery.mjs:68`），但**没有常驻进程/循环消费队列**，`runJob`/`recover` 只在 `integration-worker.test.mjs` 里被调用。
- 后果：设计 §8「Integration worker … 接受 team-hub 授权的 job」缺执行侧；队列可入不可消费，`recover()` 的崩溃对账能力也无入口。

### 2.4 缺口 4 —— 旧通道「只拒绝、不入队」，集成模式反而更差（不合格）

- 证据：`plugins/src/index.ts:1480-1485` 在 `refuse-legacy` 时只 `log` 后 `return false`；`autoPromote` 的调用方 `index.ts:1859/1901` 在返回 false 时按「自动合入失败（可能冲突）」处理，执行 `transitionTo('in_review')` 并给用户一段**手工 `git merge` 提示**（`:1903`），终态阶段直接 `return`、**永远到不了 done**。
- `legacyConvergence.decideIntegrationPath` 返回的 `enqueueIntegration:true` 在 `plugins/` 非测试代码中**无任何消费者**（`git grep enqueueIntegration` 只命中定义/赋值）。插件侧也没有调用 `POST /api/deliveries` / `/api/integration/claim` 的客户端代码。
- 后果：设置 `LEGION_INTEGRATION_MODE=integration` 后，**每个流水线环节都会「合入失败」停在 in_review 并提示人工 git merge**，与设计 §10/§12「同仓库只有一个集成入口、无冲突自动推进」相反，比现状更差。`mediation.ts` 同理会拒绝（见 M5 的连带数据安全问题）。

---

## 3. TEST_REPORT.md「诚实边界」的判据与结论

**结论：属于「自测结论与交付物不符（披露不完整）」，不能算「已在如实记录范围内」。**

判据（逐条核）：

1. **是否落在本次交付范围内**：是。4 项缺口分别属 S2/S5/S3/S6 的声明产出（TASK_BREAKDOWN「## slices」第 4 段明列 claim 接线、index.ts 段、唯一 integration worker、autoPromote/mediation 接入唯一入口）。它们不是「环境限制」，而是**纯代码接线未做**。
2. **是否受环境阻塞**：否。缺 node_modules 只影响 tsc/vite，与这 4 处接线无关；接线本身可在本环境写、可静态断言、可集成测试。
3. **是否有测试覆盖**：否。123 例全部是纯函数/单模块测试，没有一例断言接线；因此「测试全绿」不能推出「切片交付完整」。
4. **报告是否让读者据此判断交付完整**：不能。报告 §1 只写「自测通过（绿）」并列四个环境类边界；「关键行为证据」把「旧通道收敛」描述为正向能力（`:60`「两条旧直合并都被拒绝，且源码断言两处确实接线」），而**未声明拒绝之后无人入队、集成模式会停摆**；提交信息 `5e32ae8` 更写作「旧直合并被拒并**转唯一集成 worker**」——与代码事实不符。
5. **可追溯性后果**：将军/下游（T-172 tester、T-173 devops）若只读 TEST_REPORT，会把 4 项缺口漏判为「未覆盖的环境项」，从而把「接线未交付」误当「已交付」。

因此：**诚实边界应新增一段「接线缺口（非环境类）」，并把 §1 的「自测通过」限定为「纯函数/单模块层通过，端到端接线未验证/未交付」**。参考 skills「代码审查清单」与工程纪律「验收标准逐条对应说明，不留『应该没问题』式结论」，自测结论必须与交付物一一对应，声明过的产出缺失必须显式列出。

---

## 4. 必须修改（Blocking，未修不得视为交付完成）

### M1【严重】claim 未授予写入预约（缺口 1）
- 位置：`team-hub/server.mjs:4385-4407`；`team-hub/claim-policy.mjs:341`；`team-hub/write-intent-store.mjs:382`
- 问题：claim 事务不创建 reservation、不判冲突、不授予 epoch；`selectEligibleCandidate`/`claimWithReservation` 无调用点。设计 §5.1 第 2/3 条未交付。
- 建议：在 `claimTask` 的 `withTx` 内接入 `claimWithReservation`（或候选扫描+reserve），冲突整体回滚并返回结构化 `FILE_CONTENTION`；补一条**集成级**测试断言「claim 后 `write_reservations` 有活跃行、冲突任务不 in_progress」。

### M2【高】守护侧写入资格未接线（缺口 2）
- 位置：`plugins/src/writeEligibility.ts`（无 import）；`plugins/src/index.ts`（仅 +7 行）；`plugins/src/workspace.ts`（未改）
- 问题：S5 声明的 claim/派工/pre-execute/扩域/等待视图/最新目标建工作区均未落地；`tasks.scheduling_state` 不会被守护写成 `waiting-file`。
- 建议：在守护 claim/派工与写工具 pre-execute 处 import 并调用 `evaluatePreExecute`/`schedulingView`/`freezeRunRequest`；接 team-hub write-intent HTTP；补源码接线断言（如 S6 已有两处那样）。

### M3【高】集成 worker 无执行者（缺口 3）
- 位置：`team-hub/integration-worker.mjs:74`；`team-hub/routes/delivery.mjs:68`
- 问题：队列无消费者，`runJob`/`recover` 无生产调用点。
- 建议：提供常驻/轮询消费入口（单仓库单 worker、epoch 租约、崩溃对账），或明确由 devops 阶段启动；至少给出可被生产调用的 runner 与集成测试。

### M4【严重】integration 模式旧通道只拒不入队（缺口 4）
- 位置：`plugins/src/index.ts:1480-1485`、`:1859`、`:1901-1907`；`plugins/src/mediation.ts:310-315`；`plugins/src/legacyConvergence.ts:36-42`
- 问题：`refuse-legacy` 后 `return false` → 调用方按「合入失败」`in_review` ＋手工 merge 提示；`enqueueIntegration:true` 无消费者。开 `integration` 会让流水线停摆。
- 建议：拒绝分支必须真正入队唯一集成入口（调 `POST /api/deliveries` 建交付并 `state=ready`），且调用方在「已入队」时不得走「合入失败」路径；补集成测试断言 integration 模式下不出现「手工 git merge」提示。

### M5【高】mediation 在拒绝前已 stash 用户改动且不入队即 return（数据安全）
- 位置：`plugins/src/mediation.ts:300-315`
- 问题：第 2 步（:305-309）先对主工作区已跟踪改动执行 `git stash push …`，第 2.5 步（:311-315）才判 `refuse-legacy` 并直接 `return`；该 `return` **跳过了所有其他分支都有的 `stash pop`**（:324/:336/:345/:354/:363/:376）。即 integration 模式下用户本地改动会被悄悄 stash 且不还原，违反设计 §9「用户本地未提交改动｜不 stash、不覆盖」。
- 建议：把 `decideIntegrationPath` 判定前移到任何副作用（`merge --abort`/worktree remove/stash）之前；确需早返回时先 `stash pop` 恢复现场。补「integration 模式下脏工作区字节不变且 stash 列表不增」的用例。

### M6【高】`.legion/delivery.json` 与解析器字段不一致，校验不通过（S8 声明未达标）
- 位置：`.legion/delivery.json`（每条用 `"name"`）vs `team-hub/verify-config.mjs:46`（要求 `v.id`）
- 问题：实跑 `loadDeliveryConfig(process.cwd())` → `ok=false`，13 条 `verify[i].id 缺失`，`hasExecutableVerification=false`。S8 验收「`.legion/delivery.json` 存在且校验通过：verify 为 argv 数组、每受管仓库至少 1 条可执行验证」**不成立**；即便 worker 接线后，也会对所有交付判 `NO_VERIFY_CONFIG` 停 `needs-review`。
- 建议：统一字段（解析器接受 `name` 或文件改用 `id`）；新增一条测试真实加载仓库内 `.legion/delivery.json` 并断言 `ok=true`（当前 CI 未登记 `verify-config.test.mjs`，无测试会发现此错）。

### M7【高】Workbench 徽标数据链断裂＋legacy-unknown 未处理（S7 端到端未交付）
- 位置：`team-hub/server.mjs:1960-2010 rowToTask`（无 `schedulingState/deliveryState`）；`workbench/src/deliveryBadge.ts:18-26`（无 `legacy-unknown`）；`workbench/src/components/TaskCenterView.tsx:451-455`、`TaskDetailModal.tsx:400-401`；`workbench/src/types.ts:342-352`
- 问题 1（数据链）：任务 API 的 `rowToTask` 不输出 `scheduling_state/delivery_state`，`schedulingBlockedBy/schedulingBlockedPath` 连列都不存在（只有 `write-intent` 路由在冲突响应里自带 `schedulingState`）。因此前端 `t.schedulingState/t.deliveryState/…` 恒为 `undefined`，`schedulingBadgeOf/deliveryBadgeOf` 恒返回 null——**徽标永远不显示**，等待时也写不出「等谁/等哪个文件」。
- 问题 2（声明未达）：S7 验收「legacy-unknown 如实显示」未做——`workbench/src/deliveryBadge.ts` 无该键，`deliveryBadgeOf({deliveryState:'legacy-unknown'})` 返回 null（对比 `delivery-store.mjs:334` 有映射），且 `delivery-ui.test.mjs` 未覆盖。
- 问题 3：`unreadableBadge` 仅被测试引用，**无任何组件调用点**，指标不可读时的 UI 降级未真正呈现。
- 建议：`rowToTask` 补 `schedulingState/deliveryState` 输出并加等待阻塞列（或在任务详情按 taskId 调 `GET /api/deliveries` 与 contention 组装）；补 `legacy-unknown` 映射与测试；把 `unreadableBadge` 接进指标展示。

### M8【中】S4 路由把客户端 `repoId/targetRef` 当权威，未从 DB/空间绑定解析
- 位置：`team-hub/routes/write-intent.mjs:49-65`
- 问题：`resolveRepoId` 缺省回退 `'scope:'+scope`，存在时直接采用客户端传来的 `body.repoId`（仅拒绝绝对路径/shell 元字符）；`resolveTargetRef` 同样接受客户端 `refs/...`。设计 §4「仓库身份取规范化 Git common-dir 实路径」与 §8「服务端从数据库解析仓库目录与目标 ref，不接受浏览器传来的任意 … Git ref」未满足。
- 后果：调用方可自造 `repoId` 得到独立占用命名空间，从而绕过共享占用池——正是设计 §11.1 场景 9「多空间绑定同一仓库须共用一个权威」要防的事。
- 建议：由 `scope`（或 task/space 绑定）在服务端解析仓库根与 `targetRef`，`repoId` 用 `repo-id` 归一结果；忽略/拒绝浏览器传入的仓库身份与 ref。

### M9【中】delivery-store 无事务，`claimIntegrationJob` 跨进程竞态
- 位置：`team-hub/delivery-store.mjs:250-265`（整个 store 无 `BEGIN IMMEDIATE`/`withTx`）
- 问题：先 `SELECT` 活跃 job 再 `INSERT`，无事务、无唯一约束；设计 §6.2 第 1 条要求「以事务认领并发放 epoch 租约」。多进程同时认领可产生两个活跃 job，破坏「同仓库同 target ref 至多一个」不变量（单进程测试无法发现）。
- 建议：用 `BEGIN IMMEDIATE` 包裹认领，或对活跃 job 建唯一索引；补跨连接/子进程争用用例（可参考 S2 的「同进程双连接」等价口径并注明）。

### M10【中】S6 的 done 语义/仓库级模式/回滚纯函数无调用点
- 位置：`plugins/src/legacyConvergence.ts:57/67/72/77`（`resolveRepoMode/canProduceDone/observationMarker/planRollback`）
- 问题：四个纯函数只有定义与测试，生产代码无调用；设计 §3.2「done 仅在 integrated 且原验收通过后产生」、§10「同仓库共享一个模式」、§10「回滚只关新任务自动认领与集成」均未在运行路径生效。
- 建议：在 `advanceTo/transitionTo('done')`、模式解析、回滚入口接入，并补源码接线断言。

### M11【中】`claimWithReservation` 无调用者且会自我冲突
- 位置：`team-hub/write-intent-store.mjs:382-406`
- 问题：a) 无生产调用者（同 M1）；b) 其 `findConflicts(repoId, set.entries)` **未 ignore 本任务**（对比 `reserve` 在 :254/:263 做了 ignore），若任务已有活跃预约则重认领会读成「与自己冲突」；且每次都 `INSERT` 新行而不更新旧行，可能产生同任务两条活跃预约，破坏 `assertNoActiveOverlap`。
- 建议：与 `reserve` 对齐 ignore 语义、复用/更新既有活跃行；补重认领负例用例。

---

## 5. 建议优化（非阻塞，但建议随修）

- O1【中】交付徽标存在两份实现且词表漂移：`delivery-store.mjs:325-338 deliveryBadgeOf` vs `workbench/src/deliveryBadge.ts:56-75`。后者把 `awaiting-acceptance` 标成「待裁决」、`needs-review` 标成「待复验」、`integrated` 标成「已集成」，与设计 §3.2/§7 的「待验收/待裁决/已交付」不一致；两处并存与「唯一判定来源」原则（AC-R1-6 的精神）相悖。建议单一来源（服务端下发词表或共享常量）。
- O2【中】`checkEnqueueGates`（`delivery-store.mjs:112-119`）当 `intentPaths=null` 时**跳过**「缺少写入意图」门禁，只有传入 `[]` 才拦；设计 §4/§6.1 要求无 fileDomain 的旧任务也必须先申报 intent。建议 fail-closed（缺省即缺意图）。
- O3【中】`evaluatePreExecute`（`writeEligibility.ts:75-83`）仅在 epoch/revision/workspace **两侧都非空**时才比较，缺失时放行（fail-open）。设计 §5.1 第 4 条要求 worker 启动写工具前**必须核对**身份。建议缺身份即拒（或显式降级并记录）。
- O4【中】「裸字符串路径」两处语义不一：`path-domain.mjs:76` 视为 `file`，而 `writeEligibility.ts:54-55` 与 `schedulingView`（:146）视为 `dir`；`delivery-store.mjs:108/114` 又把字符串当 `dir`。同一输入两种类型会给出不同相交结论，正是该设计要避免的漂移。建议统一并加跨模块一致性断言。
- O5【低】设计 §4 的「符号链接越界」在 `path-domain.mjs` 未实现也未测（纯函数无 fs，合理），但 S1 验收文字含「符号链接越界逐条拒绝」。建议在能力探测/预约入口用 `realpath` 复核并补用例，或修订验收措辞。
- O6【低】`repo-identity.mjs:48-55 repoIdFromCommonDir` 只把盘符小写，未处理整路径大小写别名；Windows 下同一仓库经不同大小写访问可能得到两个 repoId，削弱「一仓库一占用池」。建议整路径大小写归一或加 canonical 目录复核。
- O7【低】路由 `POST /api/tasks/:id/reservation` 只校验 `epoch` 存在，不校验其为整数；`leaseMs` 亦未校验，非法值会写入 reservation。建议加类型/范围校验。
- O8【低】`claim-policy.mjs:1` 的 import 被放在文件头注释块之上，风格突兀（功能无碍）；建议移到注释之后，保持模块头注释连续。

---

## 6. 验收标准 / 设计 §11.1 九场景逐条对照

> 「通过」= 生产路径可达且有真实验证；「仅单测」= 纯函数/单模块测试通过但生产未接线；「未达」= 声明的可测行为不成立。

| 场景 / 验收 | 落点（声明） | 实测结论 | 依据 |
| --- | --- | --- | --- |
| 1 同文件互斥、异文件并行 | S2 | **仅单测**（claim 未接线，生产不可达） | M1 |
| 2 路径判准（src/a↔src/ab、大小写、重命名） | S1 | **通过** | path-domain 9 例全绿 |
| 3 动态扩域撞车保留产物 | S2+S5 | **仅单测**（守护未接线） | M2 |
| 4 同文件串行交付 | S3+S5 | **仅单测**（worker 无执行者、守护未接线） | M2/M3 |
| 5 集成后验证失败 ref 不变 | S3 | **仅单测**（worker 无生产调用） | M3 |
| 6 崩溃恢复每源提交至多集成一次 | S3 | **仅单测**（`recover` 无入口） | M3 |
| 7 本地脏工作区暂停且字节不变 | S3 | **仅单测**（worker 侧）；mediation 侧 **未达** | M5 |
| 8 人审打回与隔离成果 | S6 | **未达**（done 语义纯函数未接线） | M10 |
| 9 多空间同仓库、多 worker 同一权威 | S2+S3+S4 | **未达**（客户端可自造 repoId；store 无事务） | M8/M9 |
| S8 `.legion/delivery.json` 校验通过 | S8 | **未达**（实跑 ok=false） | M6 |
| S7 交付徽标/等待说明/不可读显示 | S7 | **未达**（数据链断裂、legacy-unknown 缺失、unreadableBadge 无调用） | M7 |
| S5 等待不烧重试 + pre-execute 四类拒绝 | S5 | **仅单测**（纯函数通过，守护未接线） | M2 |

补充：S1、S2 store、S3 store/git 接缝、S4 store 面、S7 纯函数、S8 测试登记的**模块级**测试真实全绿，值得肯定；问题集中在「声明的生产接线与端到端可测行为」。

---

## 7. 复跑命令附录（本报告证据）

```text
# 13 个新测试（逐条 exit 0；合计 123 pass / 0 fail）
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

# 文档门禁
node scripts/ci/check-docs.mjs        # exit 0 PASS

# 接线缺口静态核查（均「只有定义，无调用」）
git grep -n "selectEligibleCandidate" -- ':!*.test.*'
git grep -n "writeEligibility"        -- ':!*.test.*'
git grep -n "createIntegrationWorker" -- ':!*.test.*'
git grep -n "claimWithReservation"    -- ':!*.test.*'
git grep -n "enqueueIntegration"      -- plugins ':!*.test.*'

# 配置真实性核查（ok=false，13 条 id 缺失）
node -e "import('./team-hub/verify-config.mjs').then(m=>console.log(m.loadDeliveryConfig(process.cwd())))"
```

---

## 8. 审查纪律声明

- 本报告只给结论与证据，未修改任何被审查代码（不改代码是 reviewer 的边界）。
- 结论均可由第 7 节命令或文中 file:line 复现；未复现的项已标注「未执行」。
- 是否要求补齐接线、是否把 M1~M11 拆成新任务，由将军裁决；本报告不自行扩域。
