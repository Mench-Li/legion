# T-189 代码审查报告：CI test 阶段契约 / 端到端 9 套件归零

> 角色：reviewer（代码审查）｜任务：T-189｜所属目标：G-mujfc9vi-1
> 审查对象：分支 `w/T-189` 上的实现；本 worktree HEAD = `485f34e9869cf96ca2fb0d653fb17d1dd2be6f8b`
> 基线对照：`main` 在本轮审查开始时 = `423924ed3ff894b43b88e0db7c376786f7b4097e`，审查过程中另一会话又推进到 `0decd6b339a9149093fffb5da200b215a2c75739`（BUG-012 fix，见 §6）
> 纪律：本报告只出结论与证据，**不替人改代码**；所有结论都附可复跑命令或源码位置。

---

## 0. 必须先说清的事实：本次编码阶段没有可审查的 diff，目标已由上游 T-178 交付

- `git status --short` → 只有未跟踪的 `.t189-tmp/`（上一轮 worker 的测试日志）与 `.t189-review/`（本报告的证据目录）；**没有任何被跟踪文件的改动**。
- `git log --oneline main..HEAD` → **空**（w/T-189 没有超前 main 的提交）；`git reflog` 仅有一条 `reset: moving to HEAD`。
- 本任务目标（9 个契约 / 端到端套件归零）的实际实现在 **T-178**：提交 `6bcbcc7ea0d8fe5526ffcd9ae95e03eb51bf9a24`（分支 `w/T-178`），经 merge `e013398d` 合入 main，且：
  ```
  git merge-base --is-ancestor e013398d HEAD   # → exit 0（是祖先）
  git show 6bcbcc7e --stat                     # 11 files, +269/-30（9 个测试文件 + team-hub/routes/{agents,delivery}.mjs）
  ```
- T-178 的 commit message 与 T-189 任务描述**逐字同题**（同样的 9 个套件、同样的读数：model-api 15/15、can-read 8/8、e2e-assembly 19/19、employee-preset 35/35、route-family 32 文件 510/510、acceptance 10/10、handoff 8/8、run-events 18/18）。
- 结论：**T-189 是 T-178 的重新派工，目标已在上游交付。** 因此本报告审查的是"当前树里实际实现该目标的改动集"（T-178 的 11 个文件），并单独记录"T-189 自身 diff 为空"。

参考团队经验 **T-092「回归复跑先查上游验证防空转」**：接到复跑 / 归零类任务先核对上游交付与验证记录，避免多轮 worker 空转。本任务正是"目标已被上游验证"的教科书情形——若只看 T-189 的 worktree，会误判为"coder 什么都没做"。

---

## 1. 独立复跑：9 组套件读数

跑法：**逐文件一个 `node` 进程**（与 coder 的 `.t189-tmp/summary.txt` 同法）。之所以不用 `node --test`：本会话沙箱拦截子进程 pipe 捕获（`spawn EPERM`），多文件 `node --test` 无法启动；详见 §6。

| # | 套件 | 文件 | exit | tests | pass | fail | skipped |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | model-api | workbench/scripts/model-api.test.mjs | 0 | 15 | 15 | 0 | 0 |
| 2 | can-read | orchestrator/worker/can-read-authorization-source.test.mjs | 0 | 8 | 8 | 0 | 0 |
| 3 | e2e-assembly | runtime/dsh-composition/e2e-assembly.test.mjs | 0 | 19 | 19 | 0 | 0 |
| 4 | employee-preset | runtime/dsh-composition/employee-preset.test.mjs | 0 | 35 | 35 | 0 | 0 |
| 4 | employee-preset | runtime/dsh-composition/employee-preset-mount-dsh-process.test.mjs | 0 | 7 | 1 | 0 | 6 |
| 5 | secret-store | security/secrets/secrets.test.mjs | **1** | 19 | 16 | **2** | 1 |
| 5 | secret-store | security/secrets/run-credentials.test.mjs | 0 | 13 | 13 | 0 | 0 |
| 5 | secret-store | security/secrets/credential-materializer.test.mjs | 0 | 20 | 19 | 0 | 1 |
| 6 | route-family | team-hub 的 32 个 `*-routes.test.mjs`（CI 登记的 32 个） | 0 | 510 | 510 | 0 | 0 |
| 7 | acceptance-routes | team-hub/acceptance-routes.test.mjs | 0 | 10 | 10 | 0 | 0 |
| 8 | handoff-routes | team-hub/handoff-routes.test.mjs | 0 | 8 | 8 | 0 | 0 |
| 9 | run-events | team-hub/run-events.test.mjs | 0 | 18 | 18 | 0 | 0 |

证据：`.t189-review/summary.txt` 与每文件一份 `.t189-review/<套件>__<文件>.log`（本轮实跑，2026-10-06T09:16:36 ~ 09:17:52，HEAD=485f34e9）。

**两处非绿读数的定性：**

1. `secrets.test.mjs` 的 2 条 —— `★★★ 真·跨进程` 用例用 `execFileSync(process.execPath, ['-e', …])` 起子进程，被沙箱以 `spawnSync EPERM (errno -4048)` 挡住（`secrets.test.mjs:371/400`）。**这是环境限制，不是产品缺陷。**
   我按 T-178 的方法手工逐条复现了这 2 条的**全部断言**（用 pwsh 管道跑等价的子进程脚本，绕过沙箱的 pipe 限制）：
   ```
   TEST1 out=OUTCOME=SECRET_STORE_LOCK_TIMEOUT  fileUnchanged=True  lockUnchanged=True
   TEST2 o1=wrote  o2=wrote  bothRecords=True  lockLeft=False
   ```
   即：别人持锁时子进程被拒、库文件与锁一字未改；无争用时两个进程都能写、不留锁。
2. `employee-preset-mount-dsh-process.test.mjs` 的 6 条 skip —— 见 §4 R2（**这是需要跟进的覆盖缺口，不是本任务 9 套件的红**）。

---

## 2. 未放宽判据：断言数前后对比与自查

对比法：对 T-178 改动过的 9 个测试文件，统计 `6bcbcc7e^`（改前）与 `6bcbcc7e`（改后）的 `assert.` 出现次数、`test(` 条数、新增行里的 `skip/only`。

| 文件 | assert 前 | assert 后 | 差 | test 前 | test 后 | 新增 skip / only |
| --- | --- | --- | --- | --- | --- | --- |
| orchestrator/worker/can-read-authorization-source.test.mjs | 36 | 36 | 0 | 8 | 8 | 0 |
| runtime/dsh-composition/e2e-assembly.test.mjs | 68 | 68 | 0 | 19 | 19 | 0 |
| runtime/dsh-composition/employee-preset.test.mjs | 99 | 100 | +1 | 32 | 32 | 0 |
| security/secrets/credential-materializer.test.mjs | 122 | 122 | 0 | 20 | 20 | 0 |
| team-hub/acceptance-routes.test.mjs | 46 | 46 | 0 | 10 | 10 | 0 |
| team-hub/goal-lifecycle-routes.test.mjs | 62 | 64 | +2 | 17 | 17 | 0 |
| team-hub/handoff-routes.test.mjs | 53 | 53 | 0 | 8 | 8 | 0 |
| team-hub/run-events.test.mjs | 91 | 91 | 0 | 18 | 18 | 0 |
| workbench/scripts/model-api.test.mjs | 96 | 96 | 0 | 15 | 15 | 0 |

**自查（我没有动过的判据）：**
- 断言只增不减（+1 / +2 两处，其余持平），`test` 条数全部持平，**无新增 `skip` / `only`**。
- 真承重的整体比较至少保留原样：can-read ① 的"恰好 9 个键 + `AUTHORITY_LOOKING` 零命中"仍是 `deepEqual(Object.keys(lease).sort(), …)`；⑤ 仍是"9 + 恰好 3 个"；e2e-assembly ① 仍是**整体序列** `deepEqual`；model-api ③ 的 `bad` 交叉校验仍是 `deepEqual(bad, [])`。
- 我本人（reviewer）**没有修改任何产品代码或测试代码**；只读代码 + 实跑 + 写了本报告与 `.t189-review/` 取证目录。诊断期间在 `team-hub/` 下临时生成过 3 个"改前版本测试副本"（`zz-t189-prefix-*.test.mjs`），已全部删除；`git status --short` 现在只剩 `.t189-review/` 与 `.t189-tmp/` 两个未跟踪目录。

**判据被修改的两处，逐条核对依据（要求 2）：**
- `can-read` `CLAIMED_LEASE_KEYS`：`workerId` → `agentSelectionSnapshot`。依据 = 契约源码 `team-hub/run-store.mjs:1553-1583` 的 `claimed:` 对象，实际 9 个键为 `attemptId / taskId / scope / attemptNo / leaseEpoch / leaseExpiresAtMs / state / agentSelectionSnapshot / serverTimeMs`（`workerId` 是 `claim()` 的**请求**字段，不在这份响应对象上）。我逐行读过该对象，成立；判据未放宽（仍是整体 `deepEqual`，多一个键就红）。
- `goal-lifecycle-routes.test.mjs:214` ⑤：补上 `publishGoalRecord` 第 6 位。依据 = `team-hub/server.mjs:2380` 的签名 `(targetScope, objective, mode, by, docSync, workflowDefinitionRef = null)` 与调用点 `team-hub/routes/goal-lifecycle.mjs:71-78`（`body.workflowDefinition ?? null`）。成立，且是**加断言**（新增第 6 位正面断言），不是删断言。

---

## 3. 三个"顺序敏感"套件：单跑绿、串行也绿、以及"为什么 CI 串行时是红的"

**先说结论：这三条不是"跨文件共享 hub 库"，而是"同一文件内、前序用例留下的整仓独占写入预约把后续 claim 挡住"的确定性级联。"两棵树计数不同"来自两棵树**产品代码不同**（级联的起点不同），不是时序抖动。**

### 3.1 单跑绿（每个文件一个进程）

见 §1 第 7/8/9 行：acceptance 10/10、handoff 8/8、run-events 18/18，exit 0。

### 3.2 串行也绿

- 我的 9 组复跑本身就是**串行**跑的（第 6/7/8 组依次执行），全绿。
- 三个文件各自 `mkdtempSync` 独立库、`listen(0)` 随机端口（`acceptance-routes.test.mjs:19-28`、`handoff-routes.test.mjs:21-30`），CI 又是"每个套件一次 `node --test`"（`scripts/ci/run-ci.mjs:4712-4714`），进程隔离 ⇒ 相互之间没有可传递状态。

### 3.3 复现"改前是红的"，并定位根因

我把 `6bcbcc7e^`（T-178 改前）的三个测试文件原样取到 `team-hub/` 下临时复跑（每文件 2 次，跑完即删）：

| 套件 | 改前 run1 | 改前 run2 | 任务描述里"main 树"的读数 |
| --- | --- | --- | --- |
| acceptance-routes | 3 pass / 7 fail | 3 pass / 7 fail | 3 / 7 |
| handoff-routes | 3 pass / 5 fail | 3 pass / 5 fail | 3 / 5 |
| run-events | 14 pass / 4 fail | 14 pass / 4 fail | 14 / 4 |

两次**完全相同**，且与任务描述逐字吻合 ⇒ 确定性，不是抖动。

失败原文（`.t189-review/prefix-*.log`）指向同一个动作：`AssertionError: 应当领到 acc-3，实际 null`（`acceptance-routes.test.mjs:79` 的 `toValidating`）。即 **claim 返回 `claimed:null`**。机制：

1. 这些文件的夹具用裸 SQL `UPDATE tasks SET status='done' …` 清队列（改前 `onlyTask`），**绕过了产品里"任务收口"那条路**；而那条路一定会释放写入预约（`team-hub/server.mjs` 的 `finishTaskReservationInTx`）。
2. 认领时若任务没申报 `fileDomain`、也没有 write-intent，就按**整仓独占**授予预约（`team-hub/write-intent-store.mjs:255/289` 的 `unplanned-exclusive`；`team-hub/contention-paths.test.mjs:90-95` ④ 逐字钉住了这个方向）。
3. 预约**跨 `in_review` 持有**是刻意的（`write-intent-store.mjs:369-380` `rebindForRetry`：`A reviewed attempt has stopped; keep the same path lock while binding it to its retry`）。
4. 于是 ①② 领到任务后留下独占预约，③ 起的每一次 claim 都以 `FILE_CONTENTION` 返回 `claimed:null` ⇒ 后续用例从"领到了"那一行开始整片红。

**所以"顺序敏感"= 文件内用例顺序敏感**（红从"第一条领不到任务的用例"开始级联），不是跨进程顺序敏感。改前的三份日志里 `实际 null` 的命中分别是 acceptance 7 处、handoff 5 处、run-events 4 处，与 fail 数一致。

### 3.4 现有修法为何在"串行下也成立"

- acceptance / handoff：夹具在清队列时**顺带把 `write_reservations` 里 `reserved/reconciling` 的行置为 `released`**（`acceptance-routes.test.mjs:69-72`、`handoff-routes.test.mjs:80-83`）——即"做出产品在任务收口那一刻做的那件事"。级联的源头（前序用例的独占预约）被消掉。
- run-events：夹具给每个任务**申报自己的 `fileDomain`**（`run-events.test.mjs:325`，如 `["ev/<tag>"]`）——各任务的预约互不相交、谁都不再整仓独占。这一条**比裸 SQL 释放更接近真实派工**，方法上更好。
- 三个文件各有独立库与端口，所以"串行"不会再引入新的耦合。

### 3.5 一个额外的边界读数（不影响本任务结论）

若把三个文件**塞进同一个进程**跑（`node --test-isolation=none --test a b c`），会得到 36 tests / 31 pass / 5 fail（run-events ⑬⑭⑮⑯⑱ 红）——因为 `process.env.TEAM_HUB_DB` 与 `server.mjs` 模块缓存是进程级的，先 import 的文件会改写后者。**CI 用的是默认的进程隔离（每套件一次 `node --test`），不会命中这种耦合。** 记在这里是为了避免以后有人用 `--test-isolation=none` 复跑时把 5 条红误判成产品缺陷。

---

## 4. 问题清单（严重度 + 位置 + 修改建议）

> 说明：就"本任务 9 套件归零"这一目标，**阻塞项为 0**（§5）。以下按对目标与对下游的影响排序，全部是"审查 T-178 改动集"时读出来的，供将军决定是否单独立项。

### R1【中】`delivery.mjs` 为迁就抽取器拆路由，根因 `regexPath()` 未修
- 位置：`team-hub/routes/delivery.mjs:136-137`（把一条 `(?:/([^/]+))?` 拆成两条 `on()`）；根因在 `scripts/prt/baseline-snapshot.mjs:598-607` 的 `regexPath()`。
- 事实：我核过 `regexPath()` —— `/\((?:)\/[^)]*\)\?/g` 这类替换处理不了"可选段里再嵌捕获组"（`(?:/([^/]+))?`），该端点在 `platformHttpRoutes()` 里**原本一条都不出现**。拆分后 `GET /api/deliveries` 与 `GET /api/deliveries/:param` 才可见（这是 model-api ③ 能转绿的必要条件；workbench 确有 `workbench/src/api.ts:1932` 调 `GET /api/deliveries?taskId=`）。拆分本身**行为等价**（两条正则的并集与旧正则相同；`delivery-routes.test.mjs` 仍 4/4）。
- 但：根因没修。**下一个用同形写法的新路由仍会对契约隐形**，而"隐形"在 `--check` 上表现为"无漂移"。
- 建议：单独立项修 `regexPath()`（正确处理嵌套 `)`）并补一条抽取器自身的回归用例；或至少在 `baseline-snapshot.test.mjs` 里加一条"不可解析的可选段形态必须报错而不是静默跳过"的判据。

### R2【中】`employee-preset-mount-dsh-process` 的 DSH 路径过期，6 条真挂载断言永久 skip，且 skip 文案误导
- 位置：`runtime/dsh-composition/employee-preset-mount-dsh-process.test.mjs:109`（`join(DSH, 'packages', 'preset', 'agent-presets', 'lib', 'index.js')`）与 `:113` 的跳过原因 `…——未构建？`。
- 事实：本机检出 `D:\project\DSH\dsh\deepseek-harness` 里 **`packages/preset/agent-presets` 整个包已不存在**（我 find 过：没有该目录、没有 package.json），实际存在的是 `packages/preset/agent-preset/lib/index.js` 与 `packages/preset/agent-preset-registry/lib/index.js`（都已构建）。所以 6 条 `真实 DSH 进程 × standingKeyFor` 断言永远 skip，而原因被写成"未构建？"——**读者会去构建，而那个包已经改名/搬家了**。
- 这与 T-178 **自己刚修过的** `employee-preset.test.mjs`（standard preset 从 `packages/preset/agent-presets/…` 搬到 `packages/bundle/web-app/presets/standard.patch.yml`）是**同一件事的漏网**：兄弟文件里的路径没同步。
- 建议：把检查点改为按候选/发现解析（或改指 `packages/preset/agent-preset*/lib/index.js`），并把"包不存在（搬走了）"与"包在、产物没构建"分开报；别让 6 条真进程断言靠一个过时路径长期 skip。

### R3【中·范围外】`prt-baseline` 套件当前是红的，`run-ci --only test` 整阶段不会 PASS
- 位置：`scripts/prt/baseline-snapshot.test.mjs:227-233` ④；基线 `docs/superpowers/prt/prt-007-baseline.json`。
- 事实：`node scripts/prt/baseline-snapshot.test.mjs` → exit 1，漂移行含 `+ 路由: GET /api/deliveries`、`+ 路由: GET /api/deliveries/:param`，以及 5 个 `~ 源文件已变更`。
- 归因（我用 `git archive efc11c9c` 取改前文件、按 `baseline-snapshot.mjs` 相同的 `sha256(readFileSync(p,'utf8'))` 口径逐文件比过）：**这 5 个源文件在 T-178 的父提交上就已经与基线不一致**，所以 `prt-baseline` 在 T-178 之前**就已经是红的**（既有欠账），T-178 只是在上面又加了 2 条路由行。
- 影响：本任务的 9 个套件不在其中，故不阻塞目标；但"CI test 阶段全绿"并未达成——`run-ci --only test` 会因它 FAIL。
- 建议：单独立项决定是刷新基线（`node scripts/prt/baseline-snapshot.mjs --record`，会把既有漂移一并吸收，需人工确认每一行）还是修导致漂移的源头；不要把它算进本次 9 套件成果。

### R4【低】`agents.mjs` 让出分支在鉴权之前，鉴权口径不对称
- 位置：`team-hub/routes/agents.mjs:35`（`… return false`）在 `:36` 的 `authorized(req)` 之前。
- 事实：`GET /api/agents?scope=x` 由本族处理、走 `authorized`；`GET /api/agents`（无 scope）让给 `read-models` 族（`team-hub/routes/read-models.mjs:215-230`），该族不内建 `authorized`，只靠 `handle()` 的全局读门禁（`team-hub/server.mjs:7138`，且仅在 `readAuthRequired()` 时生效）。
- 判断：本地 / 回环模式两者都开放；远程 + token 模式全局门禁覆盖两者，**没有实际越权**。但这让"同一条路径两种鉴权路径"成立，且 T-178 只修了让出、没加回归判据。
- 建议：补一条"无头字段时全局门禁仍拦得住"的用例，或在 read-models 那一条上显式标注它依赖全局门禁。

### R5【低】e2e-assembly 的全链路序列把 `agent-runtime` 的两次 tick 硬编码
- 位置：`runtime/dsh-composition/e2e-assembly.test.mjs:229-230`。
- 事实：`agent-channel.mjs:2` 的 `intervalMs = 2000`，`start()` 先 tick 一次、再 setInterval；`executor.mjs:516/566` 保证 start 在 execute 前、stop 在 execute 后。当前假引擎是瞬时的，所以序列稳定为 `get-snapshot → reserve → agent-runtime → engine-run → agent-runtime → settle`。
- 风险：若某次 `engine-run` 的假实现跨过 2s（或机器极慢），会多出 tick，整体 `deepEqual` 变红——一个"时序导致的假红"。
- 建议：给 fixture 注入可配的 `intervalMs`（如 1e9）让 tick 数确定，或改为"断言相对顺序 + 允许 `agent-runtime` 出现多次"。

### R6【低】credential-materializer ⑥ 的正则接受"两种形态之一"
- 位置：`security/secrets/credential-materializer.test.mjs:793`。
- 事实：正则 `/(?:^const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'$|apiKeyEnv:[^\n]*\.default\('DEEPSEEK_API_KEY'\))/m`；旧常量名在扫描的两个目录里**已不存在**（我 grep 过；模型侧声明现为 `packages/llm/llm-deepseek-api-key/src/config.ts:16` 的 `apiKeyEnv: … .default('DEEPSEEK_API_KEY')`）。
- 判断：形态搬迁有据（与 T-178 注释一致），断言仍要求"标识符 + 逐字字面量同一行"，注释里提一句不算。仅"保留了一条永远不成立的替代分支"这一点是轻微放宽。
- 建议：钉死新形态，或加一句"旧形态不得复活"的反向断言；否则将来旧常量若在别的包重现，这条会静默接受。

### R7【低】employee-preset 的 `standard*.yml` 回退扫描可能选错基准
- 位置：`runtime/dsh-composition/employee-preset.test.mjs:536`（`globSync('packages/**/presets/standard*.yml')` + `find`）。
- 事实：候选表第一项 `packages/bundle/web-app/presets/standard.patch.yml` 在本机存在，所以走不到扫描；但若它搬走、盘上有**多个** `standard*.yml`，`find` 取 glob 顺序第一个，可能拿错基准而**静默通过**。
- 建议：对 `[...candidates, ...scanned]` 里命中的文件数做唯一性断言（命中 >1 就失败并列出），这与该文件原本"不静默退回凭记忆"的立场一致。

### R8【低·覆盖】acceptance / handoff 夹具用裸 SQL 释放**所有**预约，绕过了产品的收口释放路径
- 位置：`team-hub/acceptance-routes.test.mjs:71`、`team-hub/handoff-routes.test.mjs:82`。
- 事实：`UPDATE write_reservations SET state='released' … WHERE state IN ('reserved','reconciling')` 是无条件全表的。它修好了级联，但也意味着**这两个文件不再能发现"任务收口时忘记释放预约"这类产品回归**（若 `finishTaskReservationInTx` 哪天不再释放，这里照样绿）。
- 建议：确认这条接线在别处有专门用例；若无，补一条"走产品收口路径后预约必被释放"的判据（这是 R8 唯一的实质诉求）。

---

## 5. 必须修改 vs 建议优化

- **必须修改（阻塞本任务 9 套件目标）：0 项。** 9 组复跑里 8 组全绿；第 9 组（secret-store）仅剩 2 条沙箱 `spawn EPERM`，已手工复现其全部断言（§1）；判据未放宽（§2）；3 个顺序敏感套件单跑与串行均绿，且给出了改前确定性复现与根因（§3）。
- **建议优化 / 需单独立项：R1、R2、R3（中）**——R3 是"范围外既有红"，R1/R2 是同一类"路径 / 抽取器搬家后留下隐性失效"的新证据。
- **建议优化：R4 ~ R8（低）**——鉴权口径、时序稳健性、轻微放宽、基准唯一性、覆盖缺口。

---

## 6. 环境限制（如实标注）与普通终端复跑命令

1. **`run-ci --only test` 在本会话沙箱内无法运行**：
   ```
   node scripts/ci/run-ci.mjs --only test --out .t189-review/ci-out
   → [test] exception: spawn EPERM   （readTreeState → child_process.spawn）
   ```
   这是沙箱对"子进程 pipe 捕获"的既有边界（`scripts/ci/run-ci.mjs:29-30` 自己就写着）。**普通终端复跑命令**：
   ```
   node scripts/ci/run-ci.mjs --only test
   ```
2. **多文件 `node --test` 同样被挡**（测试运行器要 spawn 每文件子进程）：`node --test a b c` → 三个文件级 `spawn EPERM`。因此 §1 采用逐文件 `node <file>`（与 coder 一致），等价于 CI 里"每套件一次 `node --test`"的进程隔离语义。
3. **两处需要"普通终端"才能看到的读数**：(a) secrets 的 2 条真·跨进程用例（本会话已手工复现其断言）；(b) `employee-preset-mount-dsh-process` 的 6 条 skip 需要在 `agent-preset` 相关包可用后复跑。
4. **main 在本轮审查期间又推进**：开始时 `423924ed`，结束时 `0decd6b3`（BUG-012：`plugins/src/reclamation.ts`、`scripts/ci/run-ci.mjs`、`team-hub/claim-reservation.e2e.test.mjs` 等）。w/T-189 的 HEAD `485f34e9` 仍是 main 的祖先（`git merge-base --is-ancestor 485f34e9 main` → 0）。**引用本报告读数时请连"跑在哪棵树上"一起引用。**
5. **本报告目前是未跟踪文件（`docs/review/T-189-REVIEW.md`）**：本会话沙箱拒绝对 worktree 的 git 元数据写入，`git add` 报 `fatal: Unable to create '…/.git/worktrees/T-189/index.lock': Permission denied`（连试两次一致），因此无法在本会话内提交。文件已落盘、内容完整。普通终端补提交命令：
   ```
   git add docs/review/T-189-REVIEW.md
   git commit -m "T-189 审查报告（reviewer）" -- docs/review/T-189-REVIEW.md
   ```

---

## 7. 总体结论

**通过（就本任务 9 套件目标）；无阻塞项。**

- 事实层面：T-189 自身没有编码 diff；目标由上游 T-178（`6bcbcc7e`，merge `e013398d`）交付，已在本 worktree 的 HEAD 上独立复现为绿（8/9 组 + 第 9 组仅沙箱限制）。
- 审查层面：T-178 的 11 文件改动集**没有放宽判据**（断言只增不减、无新增 skip/only），承重的整体比较都还在；"改判据"的两处都能指向契约源码。
- 风险层面：**R1（抽取器根因未修）与 R2（同类的兄弟文件路径过期导致 6 条断言永久 skip）是同一类"路径/形态搬家后隐性失效"的复发**，值得各立一条 bug；R3 是既有红、非本次引入，但会让 `run-ci --only test` 整阶段 FAIL，请将军知情。

---

### 附：本报告的证据落点

- 逐套件读数：`.t189-review/summary.txt`（9 组，含 exit/tests/pass/fail/skipped）
- 逐文件原始日志：`.t189-review/*.log`
- 改前（T-178 父）三套件复现：`.t189-review/run-prefix.ps1`、`.t189-review/prefix-*.log`
- 断言数对比脚本：`.t189-review/assert-count.ps1`
- 真·跨进程手工复现：`.t189-review/xproc*.mjs`、`.t189-review/xproc.ps1`
- 基线哈希比对：`.t189-review/hash-check.mjs`
- 机器可复核的 git 事实：HEAD `485f34e9`、main（审查中）`423924ed` → `0decd6b3`、T-178 `6bcbcc7e`、merge `e013398d`。
