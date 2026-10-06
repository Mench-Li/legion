# T-190 代码审查报告：worker 超时后写入预约不释放（BUG-007）

> 角色：reviewer（代码审查）｜任务：T-190｜父任务：T-184｜scope：software
> 审查对象：分支 `w/T-190`；本 worktree HEAD = `ecbebd47a1b80023f2264657f434723d0b6c6ece`（= 审查开始时的 `main`）
> 现场记录：`docs/bugs/BUG-007-timeout-reservation-not-released.md`
> 纪律：本报告只出结论与证据，**不替人改代码**；所有结论都附可复跑命令或源码位置。

---

## 0. 必须先说清的事实：本 worktree 没有编码 diff，BUG-007 的实现在上游 T-184

- `git status --short`（审查开始时）→ **空**（无被跟踪文件改动；`plugins/lib`、`scratch/` 均被 `plugins/.gitignore` / 根 `.gitignore` 覆盖）。本报告落盘后，工作树里唯一的未跟踪项就是它自己：`?? docs/review/T-190-REVIEW.md`。
- `git log --oneline main..HEAD` → **空**；`git rev-list --count main..HEAD` = 0；`git reflog show w/T-190` 只有一条 `branch: Created from HEAD`。
- BUG-007 的实际改动在 **`efc11c9c`（初修）** 与 **`d8c29923`（T-184 续修）**，两者都已是本 HEAD 的祖先（`git merge-base --is-ancestor <sha> HEAD` 均 exit 0）：
  - `efc11c9c`：`plugins/src/timeoutSettlement.ts`（新增 114 行）+ `plugins/src/index.ts`（+33/-2）+ `plugins/tests/timeout-settlement.test.mjs`（+120）+ 现场记录（+69）。
  - `d8c29923`：`index.ts`（+13/-8）失败分支文案、`timeoutSettlement.ts`（+28）`planTimeoutTransitionFailure`、`timeout-settlement.test.mjs`（+32）⑦⑧、`team-hub/claim-reservation.e2e.test.mjs`（+44）⑰。
- 看板侧旁证：T-190 的 `patches` / `evidence` 字段均为 `[]`；历史评论含「守护重启检测到孤儿在办任务（worker 已随进程消失），自动释放回 todo 重新认领续做」。
- **结论：T-190 是 BUG-007 的重新派工；本任务自身无编码 diff。** 本报告审查的是"当前树里实际实现该缺陷修法的改动集"（`efc11c9c` + `d8c29923`），并单独记录"T-190 自身 diff 为空"。

---

## 1. 验收标准逐条对照（要求 1~4）

### 要求 1：超时结算走诚实出口（先证实已停止；证不实保持冻结且读数说实话）

**实现路径**（`plugins/src/index.ts:2500-2526`）：

```ts
await run.dispose().catch(() => undefined)                 // ① 先终止本次会话
const workerStopped = await workerStoppedWithin(run, TIMEOUT_SETTLE_GRACE_MS)  // ② 再取证（race run.result）
const settlement = planTimeoutSettlement({ taskId: t.id, stopped: workerStopped, ... })
if (settlement.to !== null) await transitionTo(t.id, settlement.to, t.scope ?? scope, settlement.confirmedStopped) // ③
await safeComment(t.id, timeoutComment)                    // ④ 文案由决策模块产出
```

- `transitionTo`（`index.ts:1244-1251`）的 `by = t.soldier ?? config.role`，hub 侧 `team-hub/server.mjs:6028-6029`：`confirmedStopped=true` 且 `by === t.soldier` ⇒ `finishTaskReservationInTx(id, { cancelled: !confirmedStopped })` = **release**（`server.mjs:5953-5962`）。**走的是既有诚实出口，成立。**
- 取不实 ⇒ `planTimeoutSettlement` 返回 `to: null` + `confirmedStopped: false`（`timeoutSettlement.ts:82-94`），**不动状态、不释放**；文案写"写入占用仍被本轮持有，且不会自动重试"。安全方向保持。
- 我独立复核了 hub 端三半对照（见 §2 的 ⑰ 实跑），① released + todo + 立即 claim 200；② confirmedStopped=false ⇒ reconciling + 409；③ 非执行者 403 且整事务回滚。

**⚠ 本条的缺口见 §4 R1（hold 分支给的恢复命令当场 403）与 R2（in-process provider 下 hold 分支不可达、挂死时无读数）。**

### 要求 2：修掉"承诺了却不做"的文案，文案必须与实现一致

- 旧文案 `'⚠ worker 超时（守护强制结算），任务保留在 in_progress，下一轮自动重试…'` 已从**可执行代码**删除；超时文案只由 `planTimeoutSettlement` 一处产出（测试 ⑥ 钉住，且我实跑通过）。
- 释放分支文案（`timeoutSettlement.ts:76-79`）只在 `transitionTo` **成功后**打印（`index.ts:2508-2524`）；`transitionTo` 抛错时改写为 `planTimeoutTransitionFailure` 的"释放失败 / 仍被持有 / 不会自动重试"两段式文案（`index.ts:2515-2522`）。**"释放没成功就不打印释放成功"成立。**
- 我确认 `index.ts:2508` 是 `let timeoutComment = settlement.comment`，`:2524` 统一 `safeComment(t.id, timeoutComment)`；测试 ⑧ 钉的是这两处（实跑通过）。
- **⚠ 仍有一处与实现不一致的"读数"**：`index.ts:2456` 的注释仍无条件写"下轮自动重试（带退避）"，而 hold 分支明确不重试。见 §4 R3。

### 要求 3：回归测试覆盖两个方向（+ 对照）

| 方向 | 用例 | 判据 | 我的实跑 |
| --- | --- | --- | --- |
| 超时且能证实 ⇒ 释放 + todo + 下一轮能认领 | `timeout-settlement.test.mjs` ① + `claim-reservation.e2e.test.mjs` ⑰① | `to==='todo'` / `confirmedStopped===true` / hub 侧 `released` + claim 200 | 8/0、1/0 通过 |
| 超时但不能证实 ⇒ 保持冻结 | ②、④ + ⑰② | `to===null` / `confirmedStopped===false`；hub 侧 `reconciling` + claim 409 | 通过 |
| 对照：正常 in_progress→todo（confirmedStopped=false）仍冻结 | ⑰② | `reconciling` + 409，人工 confirm-stopped 后才 200 | 通过 |

- 测试 ③④ 还反向钉了"reject 也算已结算""宽限期内不结算必须返回 false"，把"不许猜成已停止"写死；我实跑确认 ④ 真等满宽限期（63.9ms / 60ms 参数）才返回。
- **接线层面**：⑥⑧ 是对 `index.ts` 源码文本的断言（先 `stripComments` 再匹配），能防"纯函数写对了但调用点不用它"这一原缺陷形态；但它是**文本级**而非行为级，覆盖缺口见 §4 R4。

### 要求 4：不许放宽 / 删除断言，不许把 expected 改成 actual

- `assert.` 计数（本 HEAD 实测）：`plugins/tests/timeout-settlement.test.mjs` **47**、`team-hub/claim-reservation.e2e.test.mjs` **102**；与 `d8c29923` 提交信息记录的 47 一致，e2e 从当时 89 增到 102 是 BUG-012（`0decd6b3`）追加 ⑯③④ 所致，非本次删改。
- `test.skip / test.only / describe.skip / .only(` 在两个文件里**零命中**。
- 通读两份测试：**没有**把 `assert.equal` 降级为 `assert.ok`、没有把 expected 改成 actual、没有新增豁免分支。**本项成立。**

---

## 2. 独立复跑读数（2026-10-06，本 worktree，HEAD `ecbebd47`）

沙箱拦截 `node --test` 的逐文件子进程（`spawn EPERM`），故采用**同进程直跑**（`node <file>`），与 CI 的"每套件一个进程"语义等价：

| 套件 | 命令 | 读数 |
| --- | --- | --- |
| typecheck | `node <checkout>/node_modules/typescript/bin/tsc -p plugins/tsconfig.json --noEmit` | exit 0 |
| build/emit | `node …/tsc -p plugins/tsconfig.json` | exit 0（`plugins/lib` 已生成，被 gitignore） |
| 超时结算单测 | `node plugins/tests/timeout-settlement.test.mjs` | **8 tests / 8 pass / 0 fail**，exit 0 |
| hub 三半对照 e2e | `node team-hub/claim-reservation.e2e.test.mjs` | **1 test / 1 pass / 0 fail**（16.25s），exit 0 |

补充复核（我自己写的只读探针，见 §6 落点）：真实 hub 上按 hold 分支**逐字照抄**的命令执行，结果见 R1。

---

## 3. 判据未放宽自查（我动过什么）

- **我没有修改任何产品代码或测试代码。** 只在 `scratch/`（gitignore）下写了两个一次性探针：`review-t190-hold-probe.mjs`、`old-index.ts`（后者用于取 `efc11c9c^` 的改前代码）。
- `git status --short` 在本报告落盘前仍为**空**；`plugins/lib` 为构建产物、被 `plugins/.gitignore` 第 2 行 `lib/` 覆盖，未进版本控制。

---

## 4. 问题清单（严重度 + 位置 + 修改建议）

> 就"BUG-007 修法满足要求 1~4"而言，**阻塞项 1 项（R1）**；R2 是同一处的结构性风险；R3~R5 为建议优化。

### R1【必须修改·中高】hold 分支给出的恢复命令，在它写出来的那一刻**当场 403**（又一次"读数与事实不一致"）

- 位置：`plugins/src/timeoutSettlement.ts:88-92`（hold 文案里的 `POST /api/tasks/:id/reservation/confirm-stopped`）；约束方在 `team-hub/routes/write-intent.mjs:172-186`。
- 事实：hold 分支**不动任务状态**，所以任务此刻是 `in_progress` + 预约 `reserved`；而 `confirm-stopped` 要求 `auth.by === 'general'`、`confirm === 'stopped:<id>'`、**任务状态 ∈ {todo, blocked, canceled}**、且存在 **state === 'reconciling'** 的预约（`write-intent.mjs:177-181`）。
- 我用真实 hub 探针逐字复现（任务 claim 后立即照抄评论命令）：

  ```
  BEFORE task.status=in_progress reservation.state=reserved
  HOLD-BRANCH COMMAND (直接照抄评论) => HTTP 403 {"code":"STOP_CONFIRMATION_REQUIRED"}
  对照：step1 transition→todo = 200（state=reconciling），step2 confirm-stopped = 200
  ```

- 判据：`planTimeoutTransitionFailure`（`timeoutSettlement.ts:117-128`）自己就写明了这个约束（"confirm-stopped 只对 reconciling + todo/blocked/canceled 开放…直接调会被 403/404 拒"），并因此给了**两步**恢复命令；**hold 分支却给了单步**——同一份源码里两种说法，必有一错。这正是 BUG-007/§9.1 记的"读数与事实两张皮"。
- 建议：hold 文案改成与失败分支同形的**两步**恢复路径（先 `POST /api/transition {id,to:'todo',by:'general',scope}` ⇒ 预约转 reconciling，再 `POST …/reservation/confirm-stopped`），并同步钉一条断言（照抄文案里的两步必须都能被 hub 接受）。**不要**把这段命令删掉了事——保持 in_progress 是对的（避免回到"todo+reconciling 每 30 秒刷 409"的原症状），缺的只是可执行的两步。

### R2【建议优化·中高，建议与 R1 一并修】in-process provider 下"取证宽限期/hold 分支"逻辑上不可达；挂死时反而**没有任何读数**

- 位置：`plugins/src/index.ts:2500-2501`（`await run.dispose()` 无超时包裹后接 `workerStoppedWithin(run, 20s)`）；provider 侧 `subagent-in-process-driver/src/index.ts:199-208`。
- 事实链（我读了 provider 源码）：
  1. `drivePublishedRun.dispose()` 的实现是 `await Promise.allSettled([handle.dispose(), result])`——**它本身就在等 `result`**。`handle.dispose()` 的契约是"stops the loop, awaits its exit"（`packages/core/agent/src/index.ts:146-163`）。
  2. ⇒ 只要 `await run.dispose()` 返回（或被 catch 吞掉后返回），`result` **必然已经结算** ⇒ `workerStoppedWithin` 只会返回 `true`。**hold 分支对 in-process provider 不可达**；20 秒宽限期是死代码。
  3. ⇒ 反过来，`result` 永不结算（注释里写的"subagent 可能挂死"）时，`dispose()` 也永不返回，于是 `await run.dispose()` **卡在取证之前**：既不写评论、也不改状态。对比 `efc11c9c^` 的旧序（**先评论再 dispose**，`index.ts:2501-2504`），新序在"挂死"这一场里**把唯一的读数也推迟没了**。
- 影响：要求 1 的"无法证实时…必须让读数说实话"在最常见的 in-process provider + 真挂死场景下**产生不了读数**；只对 dispose 不等 result 的 out-of-process provider 才可能走 hold。
- 建议：(a) 给 `dispose()` 套与取证同一个宽限（例：`await Promise.race([run.dispose().catch(()=>undefined), delay(TIMEOUT_SETTLE_GRACE_MS)])`），超时即按 `stopped=false` 落 hold 文案；(b) 若认为 dispose 有内部超时保证，请在 `index.ts:2500` 就地写明依据（并补一条"dispose 不返回时也必须落 hold 读数"的接线/行为用例）。我未能复现真挂死（沙箱不便起长挂 worker），故本条按"源码可达性推理"如实标注，不作阻塞。

### R3【建议优化·低】`index.ts:2456` 的注释仍无条件承诺"下轮自动重试（带退避）"

- 位置：`plugins/src/index.ts:2455-2456`。
- 事实：`// workerTimeoutMs 内未完成 → 强制结算为超时，放行 inflight/单槽，下轮自动重试（带退避）。` ——修好后"是否重试"取决于是否证实已停止；hold 分支明确"不会自动重试"。测试 ⑥ 只扫可执行代码（`stripComments` 之后），扫不到这句。这是与要求 2 同一形态的**注释级**读数漂移。
- 建议：把该行改成条件表述（"能证实已停止 ⇒ 释放并重派；证不实 ⇒ 保持持有等人工"），与 `timeoutSettlement.ts` 文件头分工一致。

### R4【建议优化·中】超时结算的"daemon 接线"只有源码文本断言，没有行为级用例

- 位置：`plugins/tests/timeout-settlement.test.mjs:97-121`（⑥）、`:141-152`（⑧）。
- 事实：⑥⑧ 用 `INDEX_CODE.includes('transitionTo(t.id, settlement.to, …)')`、`INDEX_CODE.includes('let timeoutComment = settlement.comment')` 这类**逐字字符串**匹配。它确实钉住了"调用点必须用决策模块"，但：(a) 改一行缩进/换一个等价写法（如先解构再传参）就会误报；(b) 它**测不到** `by = t.soldier` 这个真正决定"释放还是冻结"的前提；(c) ③ 的 `confirmedStopped` 是否被 `transitionTo` 透传到 `/api/transition`（`index.ts:1248`）这一环，只有文本断言。
- 现有 e2e ⑰ 只覆盖 hub 端，未覆盖"守护超时→按证据选分支→调 hub"的整链。
- 建议：把 `transitionTo` 的 by/confirmedStopped 透传抽成可注入的调用口（或用一个假 hub/假 run 的接线用例）做**行为级**断言；文本断言可保留作补充，但不应是唯一防线。这与本仓"活体验证抓出单元测试全绿但生产不生效"的既有教训同型。

### R5【建议优化·低】文案里的失败原因未转义；超时分钟数用 `Math.round` 会在 <30s 时显示">0 分钟"

- 位置：`plugins/src/timeoutSettlement.ts:134`（`reason` 只做换行/tab→空格 + 200 字截断，未转义反引号/引号，且可能截断半句）；`plugins/src/index.ts:2506`（`Math.round(config.workerTimeoutMs / 60000)`）。
- 事实：`reason` 来自 `String(e)`，会原样进任务评论；`config.workerTimeoutMs` 若小于 30s，`Math.round` 会得到 0，文案出现"超时（>0 分钟）"。
- 建议：`reason` 包进代码块/转义，截断处加省略号；分钟数改用向上取整或直接输出原始毫秒/秒。

---

## 5. 必须修改 vs 建议优化

- **必须修改（1 项）：R1。** 旧缺陷的病根就是"评论承诺的事做不到 / 指向的出口走不通"；hold 文案给的命令当场 403，等价于把"人工恢复路径"写成了不可执行——正是本任务要求 2 要根除的形态（§9.1 已为失败分支修过一次，hold 分支漏网）。
- **建议优化（4 项）：** R2（in-process 下 hold/宽限期不可达 + 挂死无读数，建议与 R1 一并处理）、R3（`:2456` 注释承诺漂移）、R4（接线只有文本断言）、R5（文案转义/分钟数取整）。
- **就 BUG-007 的核心机制（A 承诺重试 + B 超龄冻结互锁）而言：修法方向正确、安全方向未被放松、两方向回归齐全、判据未放宽。** R1 是文本/命令层缺陷，不影响已达成的"先取证再决定"机制，但它落在"读数必须说实话"这条验收线上。

---

## 6. 环境限制（如实标注）

1. `node --test`（多文件或单文件）在本会话沙箱内被拦：测试运行器要 spawn 每文件子进程 ⇒ `spawn EPERM (errno -4048)`。改为 `node <file>` 同进程直跑（§2），与 CI 的进程隔离等价。
2. `node scripts/ci/build-external-package.mjs plugins` 失败于 `rmSync plugins/node_modules/cordis → EPERM`：本 worktree 的 `plugins/node_modules` 是指向 `D:/project/DSH/legion/plugins/node_modules` 的 junction，沙箱不允许删其内的链接。改用 checkout 的 tsc 直接编译（`node <checkout>/node_modules/typescript/bin/tsc -p plugins/tsconfig.json`），typecheck/emit 均 exit 0。
3. 本报告涉及 provider 源码（`packages/subagent/…`、`packages/core/agent/…`）位于 DSH 检出 `D:/project/DSH/dsh/deepseek-harness`，不在本仓 diff 内，仅作 R2 的依据引用。
4. 普通终端复跑命令：
   ```
   node --test plugins/tests/timeout-settlement.test.mjs
   node --test team-hub/claim-reservation.e2e.test.mjs
   ```
5. 探针落点：`scratch/review-t190-hold-probe.mjs`（R1 的 403 复现）、`scratch/old-index.ts`（改前 `index.ts` 摘录）。`scratch/` 被根 `.gitignore` 覆盖，未进版本控制。
6. **本报告未能提交**：本会话沙箱拒绝对 worktree 的 git 元数据写入，`git add docs/review/T-190-REVIEW.md` 报
   `fatal: Unable to create 'D:/project/DSH/legion/.git/worktrees/T-190/index.lock': Permission denied`（exit 128）。
   文件已落盘、内容完整；`git status --short` 显示为未跟踪 `?? docs/review/T-190-REVIEW.md`。普通终端补提交命令：
   ```
   git add docs/review/T-190-REVIEW.md
   git commit -m "T-190 审查报告（reviewer）" -- docs/review/T-190-REVIEW.md
   ```

---

## 7. 总体结论

**通过（有条件）：机制正确、无阻塞级正确性缺陷；要求 1/2/3/4 基本满足，但要求 2 在 hold 分支留有 1 处必须修改的"读数不一致"。**

- 事实层面：T-190 自身没有编码 diff；BUG-007 的实现由上游 `efc11c9c` + `d8c29923`（T-184）交付，已在本 worktree HEAD 上独立复现为绿（typecheck/build exit 0、单测 8/0、hub e2e 1/0）。
- 修法层面："先 dispose → 再取证 → 才决定是否释放"顺序正确；释放只走既有的 `by = t.soldier + confirmedStopped: true` 诚实出口；证不实保持持有；失败分支文案已诚实；两方向 + 对照回归齐全；判据只增不减、无新增 skip/only。
- 风险层面：**R1（hold 文案给的单步命令当场 403）必须修**；R2 指出 in-process provider 下 hold/宽限期不可达、且挂死时连读数都不落，建议与 R1 同批处理；R3~R5 为可选优化。

---

### 附：本报告的关键证据落点

| 结论 | 证据 |
| --- | --- |
| T-190 无 diff | `git status --short` 空、`git log --oneline main..HEAD` 空、`patches=[]` |
| 实现来自上游 | `efc11c9c` / `d8c29923` 的 `--stat`；`git merge-base --is-ancestor <sha> HEAD` = 0 |
| 释放语义 | `team-hub/server.mjs:6025-6029`、`:5953-5962`；`team-hub/claim-reservation.e2e.test.mjs:214-256` |
| R1（403） | `scratch/review-t190-hold-probe.mjs` 的输出；`team-hub/routes/write-intent.mjs:172-186` |
| R2（dispose 等 result） | `subagent-in-process-driver/src/index.ts:195-208`；`packages/core/agent/src/index.ts:146-163`；`packages/subagent/subagent/src/types.ts:308-334` |
| R3（注释漂移） | `plugins/src/index.ts:2455-2456` |
| 判据未放宽 | 断言计数 47 / 102；`skip/only` 零命中 |
| 复跑读数 | §2 两张命令与输出 |
