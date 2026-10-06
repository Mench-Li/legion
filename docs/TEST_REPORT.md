# T-191 测试执行报告（tester）——CI test 阶段「契约 / 端到端」9 套件归零

> 角色：测试执行（tester）｜执行任务：T-191（隔离 worktree w/T-191）
> 被测基线：**本 worktree HEAD = 88c7c21c162b8ab98b5734c2c20250b48bd484a8（promote T-190）**，
> 与 main 同点（`git log main..HEAD` 为空、`git status --short` 无编码改动）。
> 9 条修复的实现来源 = 上游 T-178（提交 **6bcbcc7e**，合入 main 的 merge **e013398d**）；本 worktree 不含新编码 diff，
> 本轮职责为**独立复跑验证**（T-190 收尾后 tester 环境）。
> 结论速览：**8 / 9 条命令 exit 0（全绿）；第 9 条 `secrets.test.mjs` 在本沙箱 exit 1，唯一原因是 2 条真·跨进程用例的
> `spawnSync` 被 named-pipe EPERM 挡住（环境边界，非产品缺陷）**——这 2 条的全部 5 处断言已用 pwsh 真跨进程手工复现并通过，
> 普通终端应 exit 0。`run-ci.mjs --only test` 在本沙箱**入口即 `spawn EPERM`**（见 §4），无法在此环境复跑整阶段；
> 已给出等价逐套件命令与普通终端复跑命令。

## 1. 环境与方法

| 项 | 值 |
| --- | --- |
| 执行机 | Windows 沙箱 workspace-write、禁网、审批关闭；node v24.19.0 |
| 被测树 | `.legion-worktrees/T-191`，HEAD 88c7c21c（= main，含 T-178 修复） |
| DSH 检出 | `D:\project\DSH\dsh\deepseek-harness`（存在且已构建，两处 `Test-Path` = True）；secret-store ⑥ 与 employee-preset ★★★ 因此**实际核对、未 skip** |
| 执行口径 | CI 用 `node --test <file>`（默认 isolation=process）。本沙箱 **node 以管道 stdio 派生子进程 → EPERM**，`node --test` 无法启动。改用**每文件单独进程**直跑 `node <file>`（node:test 在被直跑时会自行执行并回写 exit code）——与 CI「每个文件一个进程」等价；route-family 32 文件逐文件串行直跑。 |
| 证据目录 | `docs/T191-evidence/`（01..10 原始日志 + probe-lock/ 多进程探针） |
| 基线读数来源 | 任务书「将军实测的原始读数」（main / 纯净 a8ff20de 对照）；改后读数 = 本轮实测 |

## 2. 用例执行矩阵（改前 → 改后；跑在 w/T-191 @ 88c7c21c）

| # | 套件 | 改前（将军实测） | 改后（本轮实测） | exit | 证据 |
| --- | --- | --- | --- | --- | --- |
| 1 | workbench/scripts/model-api.test.mjs | 14 pass / 1 fail | **15 / 0**，skipped 0 | 0 | 01-model-api.log |
| 2 | orchestrator/worker/can-read-authorization-source.test.mjs | 5 / 3 | **8 / 0**，skipped 0 | 0 | 02-can-read.log |
| 3 | runtime/dsh-composition/e2e-assembly.test.mjs | 17 / 2 | **19 / 0**，skipped 0 | 0 | 03-e2e-assembly.log |
| 4 | runtime/dsh-composition/employee-preset.test.mjs | 34 / 1（skipped 6） | **35 / 0**，skipped 0（检出可达） | 0 | 04-employee-preset.log |
| 5 | security/secrets 三件套 | 50 / 1 | **52 例：48 pass / 0 真失败 / 2 沙箱受限 / 2 skip**（详见 §3） | 0/0/**1** | 05a/05b/05c |
| 6 | team-hub route-family（32 文件） | 507 / 2 | **510 / 0**，skipped 0 | 0 | 06-route-family.log |
| 7 | team-hub/acceptance-routes.test.mjs ★顺序敏感 | 3 / 7（纯树 1/9） | **10 / 0**（3 次重复一致） | 0 | 07/10 |
| 8 | team-hub/handoff-routes.test.mjs ★顺序敏感 | 3 / 5（纯树 2/6） | **8 / 0**（3 次重复一致） | 0 | 08/10 |
| 9 | team-hub/run-events.test.mjs ★顺序敏感 | 14 / 4（纯树 13/5） | **18 / 0**（3 次重复一致） | 0 | 09/10 |

聚合（`10-serial-all.log`，一次 pwsh 内 9 组**串行**逐文件直跑）：model-api 15/0、can-read 8/0、e2e-assembly 19/0、
employee-preset 35/0、run-credentials 13/0、credential-materializer 19/0（skip 1）、**route-family 510/0**、
acceptance 10/0、handoff 8/0、run-events 18/0；唯 `secrets` exit=1（16 pass / 2 fail / 1 skip，2 fail = EPERM）。

### 任务书点名的失败用例逐条核对（全部已转绿）

- model-api ③「api.ts 里用到的每个 /api/ 路径都能在源码抽出的路由表里找到」 → ✔（01 日志）
- can-read ①「真 claim() 恰好那 9 个键」/⑤「租约多出恰好三个键」/⑤「端口返回 null 与没接上必须分开」 → ✔（02 日志）
- e2e-assembly ①「全链路跑通」/④「未接闸门 budgetState=not-gated 且零账务请求」 → ✔（03 日志）
- employee-preset「引擎产出的包名与 standard preset 逐字相同」 → ✔（04 日志，1.2s）
- secret-store ⑥「映射目标名来自 DSH 自己的声明」 → ✔（05c 日志，检出可达时真实执行，未 skip）
- route-family ⑤「发布时作用域回落」（goal-lifecycle-routes）→ ✔；㉛「/api/agents 按 role 去重并把来源空间收进 scopes」（read-models-routes）→ ✔（06 日志）
- acceptance ③④⑤⑥⑦、handoff ②③④⑥、run-events ⑭⑮⑯⑱ → 逐条 ✔（07/08/09 日志，见下）

acceptance 通过项：① ② ③ ④ ⑤ ⑥(×4) ⑦（共 10）
handoff 通过项：① ② ③(×2) ④ ⑤(×2) ⑥（共 8）
run-events 通过项：①..⑱（⑭ 失败路径同样落明细、⑮ 不带明细仍成功、⑯ 明细写失败不回滚、⑱ 未知类型 known:false）

## 3. 失败 / 受限项（如实登记，不冒充通过）

### E1【环境边界】security/secrets/secrets.test.mjs 2 例 `spawnSync EPERM`
- 现象：`✖ ★★★ 真·跨进程：另一个真进程持锁时…` 与 `✖ ★★★ 真·跨进程无争用时两个进程都能写…`，
  报错 `Error: spawnSync D:\software\nodejs\node.exe EPERM`（node 以管道 stdio 派生子进程被沙箱拒），套件 exit 1。
- 归属：**沙箱边界，不是产品缺陷**（CI 脚本 run-ci.mjs 第 29-30 行已记录同一边界）。
- 手工复现（`docs/T191-evidence/probe-lock/` + pwsh 真跨进程，逐条断言等价）：
  - `A_OUT=OUTCOME=SECRET_STORE_LOCK_TIMEOUT`（子进程被锁挡住，命中预期码）
  - `A_FILE_UNCHANGED=True`（被挡住的子进程未改动库文件）
  - `A_LOCK=parent-holds-it`（父进程的锁没被子进程删掉）
  - `B1=OUTCOME=ok` / `B2=OUTCOME=ok`（无争用时两个进程都写成）
  - `B_P1=True` / `B_P2=True` / `B_LOCK_LEFT=False`（两笔都保留、不留锁）
  ⇒ 5/5 断言成立；普通终端该套件应为 18 pass / 0 fail / 1 skip，exit 0。
- 另一 skip（1）为 `④ 落盘后的文件模式是 0600`——win32 无法表达 POSIX 权限位，用例自带 skip 文案，合法平台跳过。

### E2【环境边界】`node scripts/ci/run-ci.mjs --only test` 入口即失败
- 现象：`[test] exception: spawn EPERM`，summary `test FAIL (14ms)`（07 行的 exec() 用管道 stdio spawn）。
- 归属：沙箱 named-pipe 边界；与产品/套件无关（本阶段唯一被执行的是 env 之外的 run-ci 自身 spawn）。
- 普通终端复跑命令：`node scripts/ci/run-ci.mjs --only test`（在干净终端应跑完全部套件；本任务的 9 组读数见 §2）。

## 4. 三个顺序敏感套件：单跑绿 + 串行绿 + 「为什么 CI 串行时是红的」

- **单跑**：各 3 轮独立进程重复（原始读数 `11-order-sensitive-repeat.log`）逐轮一致：acceptance 10/0、handoff 8/0、run-events 18/0，exit 全部 0。
- **串行**：`10-serial-all.log` 在一次 pwsh 内 9 组按固定顺序**逐文件串行**直跑，三者仍 10/0、8/0、18/0；route-family 32 文件同样串行 510/0。
- **根因（不是"单跑绿所以好了"，而是夹具缺陷被修掉）**：
  1. 三个文件各自**共用本文件一个 hub 库**，node:test 按声明顺序**串行**跑顶层用例；每次认领都会在同一事务里授予写入预约。
  2. 旧夹具用**裸 SQL** 把别的任务清成 `done`，绕过了产品"任务收口"那条路（`team-hub/server.mjs` 的 `finishTaskReservationInTx`），
     于是库里留着上一条任务 `state='reserved'` 的**整仓独占**预约（未申报范围 ⇒ 整仓独占，设计如此并被
     `contention-paths.test.mjs` ④ 钉住；预约跨 `in_review` 持有亦为刻意，见 `write-intent-store.mjs` 的 `rebindForRetry`）。
  3. 下一条用例再 `/api/runtime/claim` 时以 `FILE_CONTENTION` 返回 `claimed:null`，红的位置却指向"这次没领到任务"。
     **红点随"累计了几条未结清预约 / 用例顺序"漂移**，这正是两棵树上计数不同（3/7 vs 1/9 等）的来源；每个文件内又是确定性的。
  4. 修法（T-178，夹具层）：
     - acceptance-routes.test.mjs:69-71 与 handoff-routes.test.mjs:76-78 的 `onlyTask()` 追加
       `UPDATE write_reservations SET state='released' …`，**做出产品在收口那一刻做的那件事**；
     - run-events.test.mjs:325 的 `claimOne()` 让每条夹具任务**只申报自己那一片路径**（`fileDomain=[ev/<tag>]`），互不相交、谁也不整仓独占。
- **为什么修法在 CI 串行下也成立**：预约不再跨用例泄漏 ⇒ 每一条用例都从"队列里只有它"的真实前提起跑，与执行顺序、与文件放进哪个进程无关。
- **补充读数（非 CI 配置，仅作边界说明）**：强行把三个文件塞进**同一进程**（`node --test --experimental-test-isolation=none`）会 36 例 5 失败
  （run-events ⑬~⑱）——原因是 `./server.mjs` 模块单例只按**第一次** import 时的 `TEAM_HUB_DB` 建库，后两个文件改了 env 也不会重新建；
  CI 与本次验证都是**每文件独立进程**，不存在该形态。

## 5. 判据未放宽自查（断言只增不减，无 skip/only）

- 断言数（`assert.` 出现次数）改前(6bcbcc7e^) → 改后（当前）：can-read 36→36、e2e-assembly 68→68、employee-preset 99→**100**、
  credential-materializer 122→122、acceptance 46→46、goal-lifecycle 62→**64**、handoff 53→53、run-events 91→91、model-api 96→96。
  **无一处减少；employee-preset 与 goal-lifecycle 各新增正面断言。**
- skip 计数：9 个文件逐文件 0→0（employee-preset 1→1、credential-materializer 2→2 为平台/条件 skip，均未新增）；
  `\.only(` / `test.only` / `describe.only` 全库文件名扫描 **0 命中**。
- 我**没有动**的判据（承担主判据的部分逐条保留）：
  - can-read ①「恰好那 9 个键、零 `AUTHORITY_LOOKING` 命中」与 ⑤「接线后**恰好**多三个键」仍是**整体 deepEqual**（不是"包含"）；
  - e2e-assembly ① 仍是**整体序列** deepEqual（多一个/少一个都红），④ 只把"账务请求"的口径收窄到 `reserve|settle|observe`（依据
    `team-hub/budget-gate.mjs`：账务入口只有这三个 kind），并未降低"零账务请求"的强度；
  - employee-preset 找不到 standard preset 基准时**就地失败**（不静默 skip、不退化为"凭记忆写包名"）；
  - credential-materializer ⑥ 仍要求**标识符 + 逐字字面量**同行出现（注释里提一句不满足）；
  - acceptance/handoff/run-events 的**断言一条未动**，只改夹具前置数据。

## 6. 根因定位（文件:行）与「改产品 / 改判据」及依据

| 套件 | 根因定位 | 改产品 / 改判据 | 依据 |
| --- | --- | --- | --- |
| model-api ③ | 抽取器在模板段处截断（workbench/scripts/model-api.test.mjs:351-…）；且服务端 `team-hub/routes/delivery.mjs` 的 `GET /api/deliveries(?:/:id)?` 可选段正则**平台契约抽取器看不见**（`scripts/prt/baseline-snapshot.mjs` 的 `regexPath()`） | **两边都改**：产品把可选段**拆成两条** `on()`（delivery.mjs:120-121）；测试改抽取/归一（不再是"端点不存在"） | 抽取后路径**变多**（后缀不再丢）、位置参数段须与路由表逐字对上 ⇒ 判据更严 |
| can-read ① | 期望键集把**请求字段** `workerId` 当成响应字段，漏了后加的 `agentSelectionSnapshot` | **改判据** | 契约唯一权威 `team-hub/run-store.mjs` 的 `claimed:` 对象（注释引 1553-1583 行）；仍是整体比较 |
| e2e-assembly ①④ | 生产路径恒定开启 Run 内 agent 通道（`orchestrator/worker/executor-binding.mjs` 的 `agentInteractions: true`），夹具把不认识的 `/api/agent-runtime` 记成 `assemble` | **改夹具分类 + 订正期望序列** | agent-channel.mjs 的 start()/stop() 各拨一次；账务入口只有 reserve/settle/observe |
| employee-preset ★★★ | DSH 检出里 standard preset 搬家：旧 `packages/preset/agent-presets/presets/standard/agent.cordis.yml` → `packages/bundle/web-app/presets/standard.patch.yml` | **改判据的"基准定位"**（候选表+目录扫描，找不到仍失败） | 实检 DSH 检出目录；不再对路径敏感 |
| secret ⑥ | DSH 模型侧声明改由 schemastery 的 `apiKeyEnv` 给出：`packages/llm/llm-deepseek-api-key/src/config.ts:16`（旧 `DEFAULT_API_KEY_ENV` 常量只剩 web 搜索 provider） | **改判据的扫描范围与形态**（两种代码形态之一，标识符+字面量同行） | 实检 DSH 检出源码；未 skip、未放宽为"注释提到即可" |
| route-family ⑤ | `publishGoalRecord` 第 6 位 `workflowDefinitionRef`（`team-hub/server.mjs:2379`）上线后，旧判据只写第 5 位，把**正确**搬运报成"作用域没回落" | **改判据**（补第 6 位 + 正面断言真的搬过去） | `team-hub/routes/goal-lifecycle.mjs:77` 与 `team-hub/pipeline.test.mjs:589-597` 的 HTTP 层覆盖 |
| route-family ㉛ | `GET /api/agents` 被两族共用，`agents` 族注册在前且 `service.list` 缺 scope 抛错 → 前端那条不带 scope 的全局目录请求**永远 400** | **改产品**：`team-hub/routes/agents.mjs:35` 对"无 scope 的 GET /api/agents"返回 false，让给 `read-models` 族（全局鉴权在 server.mjs 另一道，让出不绕过认证） | `workbench/README.md:91-92`、`workbench/src/api.ts:340`、`team-hub/routes/read-models.mjs:218` |
| acceptance / handoff | 夹具裸 SQL 清队列未释放写入预约（acceptance-routes.test.mjs:69-71、handoff-routes.test.mjs:76-78） | **改夹具**（产品行为刻意如此，非缺陷） | `team-hub/server.mjs` `finishTaskReservationInTx`；`contention-paths.test.mjs` ④ |
| run-events | 夹具任务未申报 `fileDomain` ⇒ 整仓独占预约跨用例压制后续 claim（run-events.test.mjs:325） | **改夹具**（断言一条未动） | `write-intent-store.mjs` `resolvePlannedPaths`/`rebindForRetry` |

## 7. 回归范围与结论

- **回归范围**：T-178 改动面（11 文件，+269/-30）——product `team-hub/routes/agents.mjs`、`team-hub/routes/delivery.mjs`；
  测试 9 文件。对应回归面 = 上表 9 组套件 + route-family 32 文件 510 例；无新增运行时依赖、无 `only`/新 skip。
- **结论**：
  1. **7 个确定性套件全部转绿**（model-api、can-read、e2e-assembly、employee-preset、route-family、run-credentials、credential-materializer）；
  2. **2 个原确定性缺陷按根因修**（route-family 的两个真产品缺陷：`/api/agents` 路由遮蔽、`/api/deliveries` 契约不可抽取）；
  3. **3 个顺序敏感套件**：单跑 3×+串行一次全绿，根因=夹具写入预约泄漏（不是产品缺陷），修法去掉了对执行顺序的依赖；
  4. **残留 1 条环境受限**（secrets.test.mjs 的 2 条真·跨进程断言，5/5 手工复现通过）与 **1 条无法在沙箱内执行的 CI 入口**
     （`run-ci.mjs --only test` 的 spawn EPERM），均如实标注并给出普通终端复跑命令；**未虚报通过**。
  5. 本报告只做执行与报告，**未改任何被产品/测试套件消费的代码**；写入 = `docs/TEST_REPORT.md` + `docs/T191-evidence/`（证据日志与探针）。
  6. **入库受限（如实登记）**：`git add`/`git commit` 被沙箱拒（`Unable to create 'D:/project/DSH/legion/.git/worktrees/T-191/index.lock': Permission denied`），改动留在 worktree 待守护捕获/promote，**未 push**。

### 普通终端复跑命令（逐条）
```
node workbench/scripts/model-api.test.mjs
node orchestrator/worker/can-read-authorization-source.test.mjs
node runtime/dsh-composition/e2e-assembly.test.mjs
$env:DSH_CHECKOUT='D:\project\DSH\dsh\deepseek-harness'; node runtime/dsh-composition/employee-preset.test.mjs
node security/secrets/secrets.test.mjs; node security/secrets/run-credentials.test.mjs; node security/secrets/credential-materializer.test.mjs
node --test team-hub/activity-routes.test.mjs ...（32 文件，见 run-ci.mjs:2742-2773）
node team-hub/acceptance-routes.test.mjs; node team-hub/handoff-routes.test.mjs; node team-hub/run-events.test.mjs
node scripts/ci/run-ci.mjs --only test      # 整阶段（本沙箱入口 spawn EPERM，未能执行）
```
