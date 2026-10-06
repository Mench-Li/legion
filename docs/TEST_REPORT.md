# T-192 测试执行报告（tester）——BUG-007 worker 超时后写入预约不释放

> 角色：测试执行（tester）｜任务：T-192（隔离 worktree `w/T-192`）｜父任务：T-190（代码审查）
> 被测基线：**本 worktree HEAD = 93990c75f0916b4c7c66b797b7e4f992fb0da1f5**，
> 与 main 同点（`git rev-list --count main..HEAD` = 0、`git status --short` 为空）⇒ 本 worktree 无编码 diff；
> BUG-007 的实现来自上游 **`efc11c9c`（初修）+ `d8c29923`（T-184 续修）**，两者均为 HEAD 的祖先。
>
> **结论速览：判定「不通过」。**
> 机制层（要求 1/3/4）全绿：typecheck/emit exit 0；`timeout-settlement` **8/0**；`claim-reservation.e2e` **1/0**；
> 6 个回归套件全绿（stateMachine 40/0、reclamation 21/0、write-eligibility 8/0、boot-orphan-reclaim-order 5/0、
> write-intent-store 25/0、write-intent-routes 7/0）；断言只增不减（0→47、72→102），无新增 skip/only。
> 但**要求 2（"文案必须与实现一致"）未全绿**：两个分支文案给出的**人工恢复命令，照抄执行当场走不通**——
> - **F1**：hold 分支（取不到终止证据）的恢复命令 **400 `MISSING_SCOPE`**（补上 scope 后 **403 `STOP_CONFIRMATION_REQUIRED`**，
>   因为该分支**故意不动状态**，任务仍是 `in_progress`）；这正是 reviewer T-190 标记为「必须修改」的 **R1**，本轮独立复现确认**未修**。
> - **F2**（本轮新发现，同类）：`planTimeoutTransitionFailure` 的失败文案**步骤②**同样缺 `scope` ⇒ **400 `MISSING_SCOPE`**。
>
> 归属：两处都在 `plugins/src/timeoutSettlement.ts`（F1 = 91-92 行；F2 = 139 行），需 coder 修改文案（本角色只报告、不改代码）。

---

## 1. 环境与方法

| 项 | 值 |
| --- | --- |
| 执行机 | Windows，DSH 文件沙箱 workspace-write、禁网、审批关闭 |
| Node | v24.19.0 |
| TypeScript 编译器 | `D:/project/DSH/dsh/deepseek-harness/node_modules/typescript/bin/tsc`（Test-Path True） |
| 被测树 | `.legion-worktrees/T-192`，HEAD 93990c75（= main） |
| 执行口径 | 沙箱内 `node --test <file>` **入口即 `spawn EPERM`**（测试运行器要以管道 stdio 派生子进程）。改用**每文件一个进程**直跑 `node <file>`（node:test 被直跑时会自行执行并回写 exit code），与 CI「每套件一个进程」语义等价。 |
| 证据目录 | `docs/T192-evidence/`（01~05 原始日志 + 3 个复现探针） |
| 复现探针 | `docs/T192-evidence/probe-a-hold-and-directions.mjs`、`probe-b-failpath-commands.mjs`、`probe-c-comment-strings.mjs`（对真 hub 起临时库、走 HTTP，不改被测文件） |

### 1.1 上游验证核对（参考团队经验 exp-t092「回归复跑先查上游验证防空转」）

按该经验先核对上游是否已交付验证，避免空转：

- BUG-007 的实现在 `efc11c9c` + `d8c29923`（T-184），现场记录 `docs/bugs/BUG-007-*.md` §八/§九 已登记改法与读数，**均为 HEAD 祖先**；
- T-190 审查已独立复跑 typecheck/build、`timeout-settlement` 8/0、`claim-reservation.e2e` 1/0，并落盘 `docs/review/T-190-REVIEW.md`；
- **但**：T-190 判定 **R1 为「必须修改」**，而看板中**没有** T-190 之后的 coder 修复任务（`SELECT ... WHERE parent IN ('T-184','T-190')` 只有 T-192 自身），本 worktree 也无 diff。
- ⇒ 本轮**不是**「目标已被上游验证」的空转场景：R1 仍未修，存在**新的验证增量**（对"人工恢复命令是否可执行"做真 hub 复现）。

## 2. 用例执行矩阵（跑在 w/T-192 @ 93990c75）

| # | 用例 / 套件 | 命令 | 实际结果 | exit | 证据 |
| --- | --- | --- | --- | --- | --- |
| 1 | typecheck | `tsc -p plugins/tsconfig.json --noEmit` | 无输出 | **0** | 本报告 |
| 2 | build/emit | `tsc -p plugins/tsconfig.json` | 生成 `plugins/lib/*.js`（含 `timeoutSettlement.js`） | **0** | 本报告 |
| 3 | 超时结算单测（8 例） | `node plugins/tests/timeout-settlement.test.mjs` | **8 tests / 8 pass / 0 fail / 0 skipped** | **0** | `01-timeout-settlement.log` |
| 4 | hub 认领+预约 e2e（含 BUG-007 三半对照 ⑰） | `node team-hub/claim-reservation.e2e.test.mjs` | **1 test / 1 pass / 0 fail**（19.16s） | **0** | `02-claim-reservation-e2e.log` |
| 5 | 回归：stateMachine | `node plugins/tests/stateMachine.test.mjs` | 40 / 40 / 0 | **0** | `05-regression.log` |
| 6 | 回归：reclamation | `node plugins/tests/reclamation.test.mjs` | 21 / 21 / 0 | **0** | `05-regression.log` |
| 7 | 回归：write-eligibility | `node plugins/tests/write-eligibility.test.mjs` | 8 / 8 / 0 | **0** | `05-regression.log` |
| 8 | 回归：boot-orphan-reclaim-order | `node plugins/tests/boot-orphan-reclaim-order.test.mjs` | 5 / 5 / 0 | **0** | `05-regression.log` |
| 9 | 回归：write-intent-store | `node team-hub/write-intent-store.test.mjs` | 25 / 25 / 0 | **0** | `05-regression.log` |
| 10 | 回归：write-intent-routes | `node team-hub/write-intent-routes.test.mjs` | 7 / 7 / 0 | **0** | `05-regression.log` |
| 11 | **追加验收**：hold 分支现场 + 三方向 | `node docs/T192-evidence/probe-a-hold-and-directions.mjs` | A 组**失败**（见 F1）；B/C/D/E 通过 | 0 | `03-hold-branch-probe.log` |
| 12 | **追加验收**：失败文案两步命令逐字复跑 | `node docs/T192-evidence/probe-b-failpath-commands.mjs` | 步骤②**失败**（见 F2） | 0 | `04-failpath-commands.log` |

## 3. 要求逐条对应（要求 1/3/4 通过，要求 2 不通过）

### 要求 1 —— 超时结算走诚实出口：先证实、再决定 ✅（机制通过）

| 验证点 | 结果 | 证据 |
| --- | --- | --- |
| 顺序「先 `dispose()` → 再取证 `workerStoppedWithin` → 才决定」 | 成立 | `plugins/src/index.ts:2500-2507`；单测 ⑥ 钉住该顺序（8/0） |
| 能证实 ⇒ `confirmedStopped=true` + `to='todo'` | 成立 | 单测 ①；`planTimeoutSettlement` `timeoutSettlement.ts:71-80` |
| 释放走"执行者本人"出口（`by = t.soldier`） | 成立 | `index.ts:1246`（`by = t.soldier ?? config.role`）+ `:2514` |
| 真 hub 行为：能证实 ⇒ 预约 **released** + 任务 **todo** + 下一轮 claim **200** | 通过 | 探针 C：`C_release=200 {"task":"todo","reservation":"released"}`、`C_reclaim=200`；e2e ⑰① |
| 不能证实 ⇒ **保持冻结**（不动状态、不释放） | 通过 | 单测 ②④；探针 A：`A_AFTER={"task":"in_progress","reservation":"reserved"}`（评论命令未能解锁）；e2e ⑰② |
| 非执行者拿 `confirmedStopped=true` 声明 ⇒ 403 且整事务回滚 | 通过 | 探针 E：`E_imposter=403 STOP_CONFIRMATION_DENIED`、`E_AFTER=in_progress/reserved`；e2e ⑰③ |

> 释放路径之所以能解开与机制 B（stale 回收器）的互锁：`releaseStaleTasks`（`team-hub/server.mjs:6140`）只扫
> `status='in_progress'`，任务释放回 todo 后该回收器不再触及它；而对"不能证实"的 hold 分支，超龄冻结仍然是安全方向。

### 要求 2 —— 文案必须与实现一致：部分成立，**核心文案已诚实，但两处恢复命令走不通** ❌

**已达成**（不抹杀）：
- 旧的"任务保留在 in_progress，下一轮自动重试"已从**可执行代码**删除（对照：`git show efc11c9c^:plugins/src/index.ts` 含该句 = True；当前 `stripComments(index.ts)` 不含 = 单测 ⑥ 通过）。
- 释放成功文案只在 `transitionTo` **成功后**打印（单测 ⑧、探针 C）；
- `transitionTo` 抛错时改写为 `planTimeoutTransitionFailure` 的"释放失败 / 仍被持有 / 不会自动重试"（单测 ⑦）；
- hold 分支不再承诺"下一轮自动重试"（单测 ②）。

**未达成**（F1/F2，见 §4）：两个分支文案附加的**人工恢复命令照抄不可执行**——
`confirm-stopped` 路由（`team-hub/routes/write-intent.mjs:37-47,172-186`）要求 body 必须含非空 `scope`，
且要求任务状态 ∈ `{todo, blocked, canceled}` 且存在 `reconciling` 预约；
而 hold 文案给的 body 只有 `by`/`confirm`（无 scope），失败文案步骤②同样无 scope。**"给出一个走不通的出口"与"读数必须说实话"直接冲突。**

### 要求 3 —— 回归测试覆盖两个方向 + 对照 ✅

| 方向 | 用例 | 结果 |
| --- | --- | --- |
| 能证实 ⇒ 释放 + todo + 下一轮能认领 | 单测① + e2e ⑰① + 探针 C | ✅ `released` + `todo` + claim 200 |
| 不能证实 ⇒ 保持冻结 | 单测②④ + e2e ⑰② + 探针 A | ✅ `reserved`（hold 未释放）；e2e 侧 `reconciling` + claim 409 |
| 对照：普通 `in_progress→todo`（`confirmedStopped=false`）仍冻结 | e2e ⑰② + 探针 D | ✅ `D_transition=200 {"task":"todo","reservation":"reconciling"}`、`D_reclaim=409 RECONCILING` |
| 非执行者声明 ⇒ 403 回滚 | e2e ⑰③ + 探针 E | ✅ |
| 人工两步恢复路径（补 scope 后）确实能解锁 | 探针 B | ✅ `200 / 200 / reclaim 200` |

### 要求 4 —— 不放宽断言、不把 expected 改成 actual ✅

| 指标 | 改前 | 本轮 | 说明 |
| --- | --- | --- | --- |
| `plugins/tests/timeout-settlement.test.mjs` `assert.` | 0（文件不存在） | **47** | 只增 |
| `team-hub/claim-reservation.e2e.test.mjs` `assert.` | 72（`efc11c9c^` 实测） | **102** | 只增（+30） |
| `test.skip / test.only / describe.skip / describe.only / .only(` | 0 | **0** | 两文件全库扫描零命中 |

通读两份测试文件：无 `assert.equal` 降级为 `assert.ok`、无 expected/actual 互换、无新增豁免分支。

## 4. 失败项（复现步骤 + 实际输出 + 归属）

### F1【必须修改·沿用 reviewer T-190 的 R1】hold 分支恢复命令当场不可执行

- **位置**：`plugins/src/timeoutSettlement.ts:91-92`（hold 文案），约束方 `team-hub/routes/write-intent.mjs:37-47` 与 `:172-186`。
- **实际文案**（探针 C 直接打印纯函数产物，非转述）：

  ```text
  ⚠ worker 超时（>25 分钟），但**未能确认该 worker 已停止**（abort 后 20 秒内 run 未结算）。为避免两个写者落进同一个 worktree，**写入占用仍被本轮持有，且不会自动重试**。确认执行者已停止后请执行：POST /api/tasks/T-178/reservation/confirm-stopped（body: {"by":"general","confirm":"stopped:T-178"}）。
  contains scope? false
  ```

- **复现步骤**（真 hub、临时库）：
  1. `node docs/T192-evidence/probe-a-hold-and-directions.mjs`；
  2. 探针 claim `T-hold-a`（⇒ `in_progress` + `reserved`，这正是 hold 分支"不动状态"的现场）；
  3. 逐字照抄文案命令：`POST /api/tasks/T-hold-a/reservation/confirm-stopped {by:'general',confirm:'stopped:T-hold-a'}`。
- **实际输出**（`03-hold-branch-probe.log`）：

  ```text
  A_BEFORE={"task":"in_progress","reservation":"reserved"}
  A_评论原样(无scope)=400 {"ok":false,"code":"MISSING_SCOPE","message":"缺少 scope"}
  A_补scope=403 {"ok":false,"code":"STOP_CONFIRMATION_REQUIRED","message":"请确认该任务的执行进程已经停止"}
  A_AFTER={"task":"in_progress","reservation":"reserved"}
  ```

  ⇒ 照抄 **400**；即使操作者自己补上 `scope: 'default'` 仍 **403**（因为 hold 分支刻意保持 `in_progress`，
  不满足路由的 `['todo','blocked','canceled']` 前置）——**评论指向的人工出口是关着的**。
- **对照（能走通的路径）**：先 `POST /api/transition {id,to:'todo',by:'general',scope:'default'}`（⇒ 任务 todo、预约 reconciling），
  再带 scope 调 `confirm-stopped` ⇒ **200 / released / reclaim 200**（`B_step1=200 … B_step2=200 … B_reclaim=200`）。
- **归属**：`plugins/src/timeoutSettlement.ts`（hold 文案缺 `scope`，且未先迁回 todo）；与 `plugins/tests/timeout-settlement.test.mjs:68-69`
  的断言只钉"URL + confirm 字面量"、**不钉可执行性**有关——所以"套件全绿"不能推出"命令可用"。
- **加重情形**：`planTimeoutSettlement` 用的是判断句"确认执行者已停止后请执行"，但**在当前状态下该操作必然失败**，
  与 reviewer R1 的定性一致（又一次"读数与事实两张皮"）。

### F2【本轮新发现，同类】失败文案步骤②同样缺 `scope`

- **位置**：`plugins/src/timeoutSettlement.ts:139`（`planTimeoutTransitionFailure` 的步骤②），约束同 F1。
- **实际文案**（探针 C）：

  ```text
  ⚠ worker 超时：已确认该次执行终止，但**自动把任务释放回 todo 失败**（乐观锁冲突）。写入占用仍被本轮持有，**不会自动重试**（放开会有两个写者落进同一个 worktree）。人工恢复：① POST /api/transition {"id":"T-178","to":"todo","by":"general","scope":"default"} ② POST /api/tasks/T-178/reservation/confirm-stopped {"by":"general","confirm":"stopped:T-178"}。
  step2 missing scope? true
  ```

  注意步骤①**带** `scope:"default"`，步骤②**不带** —— 同一句恢复路径里两种写法。
- **复现**：`node docs/T192-evidence/probe-b-failpath-commands.mjs`，逐字复跑两步。
- **实际输出**（`04-failpath-commands.log`）：

  ```text
  BEFORE task=in_progress res=reserved
  STEP1(文案原样)=200 task=todo res=reconciling
  STEP2(文案原样,无scope)=400 {"ok":false,"code":"MISSING_SCOPE","message":"缺少 scope"}
  STEP2(补scope)=200 res=released
  RECLAIM=200
  ```

  ⇒ 步骤① 可用、步骤② 照抄 **400**；补 `scope` 后才 `released` 且能重认领。**失败文案的恢复路径也有一半走不通。**
- **归属**：`plugins/src/timeoutSettlement.ts:139`；断言盲区同 F1（`timeout-settlement.test.mjs:134-135`）。

## 5. 残留风险（本轮**未能行为级复现**，如实登记，不计入失败项）

- **R2（reviewer T-190 提出）in-process provider 下 hold 分支不可达 / 真挂死时无读数**：本轮独立核对 DSH 检出源码，
  确认 `packages/subagent/subagent-in-process-driver/src/index.ts:199-207` 的 `dispose()` 是
  `await Promise.allSettled([handle.dispose(), result])` ⇒ **dispose 本身在等 result**。因此
  (a) 正常 abort 后 `workerStoppedWithin` 只会为 true（hold 分支对 in-process 不可达）；
  (b) 若 `result` 真永不结算，`await run.dispose()`（`index.ts:2500`）会卡在**取证之前**，连 hold 读数都不会落。
  本沙箱无法起真挂死 worker，**未做行为级验证**，故仅作风险记录（reviewer 亦标注为非阻塞）。
- **R3**：`plugins/src/index.ts:2456` 注释仍无条件写"下轮自动重试（带退避）"，与 hold 分支"不会自动重试"不一致；
  单测 ⑥ 会剥离注释，故扫不到。属注释级读数漂移（低）。
- **R5**：`timeoutSettlement.ts:134` 的 `reason` 未转义（会原样进评论），`index.ts:2506` 用 `Math.round` 分钟数（<30s 会显示">0 分钟"）（低）。

## 6. 回归范围与结论

- **改动面（上游 T-184）**：`plugins/src/timeoutSettlement.ts`（新增决策/文案模块）、`plugins/src/index.ts`（超时结算调用点 +33/-2 与失败分支 +13/-8）、
  `plugins/tests/timeout-settlement.test.mjs`、`team-hub/claim-reservation.e2e.test.mjs`、现场记录。
- **本轮回归范围**：上述两套件 + 直接相关的 6 个套件（stateMachine / reclamation / write-eligibility / boot-orphan-reclaim-order /
  write-intent-store / write-intent-routes），共 **8 条测试命令、115 例、0 失败**（另 typecheck/emit 各 exit 0）；无新增依赖。
- **结论**：
  1. **机制层通过**：先 dispose→取证→决定 的接线成立；能证实走 `by=t.soldier + confirmedStopped=true` 的诚实出口 ⇒ 预约 released + todo + 下一轮可认领；
     不能证实保持冻结；对照（普通 `in_progress→todo`）仍冻结；非执行者 403 回滚。要求 1/3/4 满足。
  2. **要求 2 不通过**：hold 分支与失败分支的**人工恢复命令照抄不可执行**（F1 400/403、F2 400）——评论指向的出口走不通，
     仍是"读数与事实不一致"；其中 F1 = reviewer R1（必须修改），本轮确认**未修**。
  3. 因此**整体判定：不通过（全绿未达成）**。属"缺陷未修完"，不是"测试执行失败"；修复归属见 §4，本角色只报告、不改代码。
  4. 未虚报通过：F1/F2 均为真 hub 上逐字复跑的真实 HTTP 读数，已随 `03/04` 日志落盘。

## 7. 环境边界（如实标注，不是产品缺陷）

- `node --test <file>` 在本沙箱 **`Error: spawn EPERM`（exit 1）**，故改用 `node <file>` 每文件一进程直跑（与 CI 语义等价）。
- 无法在本沙箱内起"真 worker + 25 分钟超时"的完整守护活体链路（需真实子进程/长挂），故守护端为
  "决策单测（①②③④⑤⑦⑧）+ 接线文本断言（⑥⑧）+ hub 行为 e2e（⑰）"三段拼接，而非真超时活体。
  F1/F2 的复现不依赖该链路：它们直接检验"评论命令是否被 hub 接受"。

### 普通终端复跑命令

```powershell
# 机制（应全绿）
node plugins/tests/timeout-settlement.test.mjs
node team-hub/claim-reservation.e2e.test.mjs
# 回归
node plugins/tests/stateMachine.test.mjs; node plugins/tests/reclamation.test.mjs
node plugins/tests/write-eligibility.test.mjs; node plugins/tests/boot-orphan-reclaim-order.test.mjs
node team-hub/write-intent-store.test.mjs; node team-hub/write-intent-routes.test.mjs
# F1/F2 复现（应分别在 400/403 与 400 上失败）
node docs/T192-evidence/probe-a-hold-and-directions.mjs
node docs/T192-evidence/probe-b-failpath-commands.mjs
node docs/T192-evidence/probe-c-comment-strings.mjs
```

### 未入库说明

本会话沙箱对 worktree 的 git 元数据写入受限（与 T-190/T-191 同一形态），故**未 `git add`/`commit`**；
本报告与 `docs/T192-evidence/` 留在 `w/T-192`，由守护捕获/promote。**未 push。**
