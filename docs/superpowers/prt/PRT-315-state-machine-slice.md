# PRT-315（切片 3）：拆分 `plugins/src/index.ts` —— 状态机（任务迁移决策）

> spec §阶段 3 的 PRT-315 要求「按仓储、状态机、workspace、验收和交接边界拆分
> `plugins/src/index.ts`，**每次只迁移一个切片**」。
>
> 本文件记录**第 3 个切片**：**状态机边界** —— `spaceWorker()` 每轮扫单里的五段任务迁移决策
> （`// 1. todo：认领 → 派工`、`// 2. blocked 解阻续做`、`// 3. in_progress 退回纠错`、
> `// 3.1 连续失败交调解员`、`// 3.2 反馈退回 vs 中止退避`），连它们读的六个判定谓词一起。
>
> 第 1 个切片（交接边界：合入调解）见 `PRT-315-slice1-mediation.md` + `plugins/src/mediation.ts`；
> 第 2 个切片（仓储边界：租约回收）见 `PRT-315-reclamation-slice.md` + `plugins/src/reclamation.ts`。
> 本切片**照它们的形状写**：同样的模块形状、同样的接线风格、同样的用例风格、同一种注释口径。

---

## 1. 搬了什么、没搬什么

**搬走了**（`plugins/src/stateMachine.ts`，导出 `createStateMachine`）：

| 原位置（`index.ts` 的 `sweep()` 内） | 新位置 |
| --- | --- |
| `// 依赖未解除` 的 `openDeps` + `// 1.` → `// 3.2` 整块（92 行） | `runRound(tasks, byId)` |
| `// ❓ 士兵提问待将军答复状态` 的 `confirmState`、`gaveUp`、`giveUpAwaitingGeneral`、`workerFailStreak`、`medWorkerRedispatchCount`（39 行，含原始注释） | 模块内（`runRound` 之外、`createStateMachine` 之内） |
| `const self` / `const isOurs`（2 行 + 注释） | 模块内 |

**故意没搬**：

- **`stageOf(t)`** —— `sweep()` 的 `// 4. 流水线 done 补流转` 也用它（那是**流水线边界**，
  不是本切片）。搬进来要么在 `index.ts` 留第二份（同一逻辑两处，正是任务禁止的），
  要么让流水线补流转去够状态机模块里的阶段查表（依赖方向反了）。故留原处、由调用点注入：
  一个身份稳定、每次调用重新读 `stageByRole` 的箭头函数。
- **`room()` / `sliceRoomOk(t)` / `inflight` / `runDetached`** —— 并发与在办登记。
  `sliceRoomOk` 依赖**本轮任务聚合**（`sliceBusy` / `goalBusy`），属切片编排边界。
- **`confirmState` 之外的那批"结算/流转"兄弟能力**：`claimTask` / `workTodo` /
  `workReturned` / `runDiscussion` / `safeComment` / `transitionTo` /
  `mediation.mediatorRecoverWorker`。它们要写 hub、要跑 subagent、要动 worktree，
  属于 worker 的上下文；状态机只声明「我需要一个能认领/续做/安全评论的东西」。
  这也让本模块可以只用替身测。
- **`isOurInbox`（离线 inbox 计数）** —— 它只是"数一数本轮有多少待认领"，不是迁移决策，
  与本切片无关，原样留在 `index.ts`。
- **`maxWorkerRetry` / `maxMediateAttempts` 两个常量** —— 仍是 `index.ts` 里的 `const`
  （`mediation` 也读 `maxMediateAttempts`），传值注入。**没有搬动它们的定义**，
  否则会改掉 `index.ts` 里那两条带现场注释的声明。

`index.ts` 的调用点变成**每次 sweep 一次接线 + 一行调用**，位置就是原来那 92 行的位置
（`// 0.5` 之后、`// 4.` 之前），顺序与副作用时机不变：

```ts
const stateMachine = createStateMachine({ … })
stateMachine.runRound(tasks, byId)
```

> 为什么接线在**调用点**而不是 `createMergeMediation` / `createReclamation` 那样的
> `spaceWorker()` 顶部：`room` / `sliceRoomOk` 是**每轮 sweep 的局部闭包**（`sliceRoomOk`
> 依赖本轮 `tasks` 聚合），顶部没有它们。这与原实现把这些判定定义在 `sweep()` 体内同形；
> `stateMachine` 本身无状态，per-round 构造不改变任何东西。

---

## 2. 行数与用例

| | 之前 | 之后 |
| --- | --- | --- |
| `plugins/src/index.ts` | 3292 行 | **3177 行**（−115） |
| 新增 | — | `plugins/src/stateMachine.ts`（281 行）、`plugins/tests/stateMachine.test.mjs`（600 行） |
| 状态机相关用例 | **0** | **39**（`plugins` 套件 228 → **267**） |
| `spaceWorker()` | 约 2725 行 | 约 2610 行 |

`index.ts` 的 diff 是 `19 insertions(+), 134 deletions(-)`：

- 删 134 行 = 状态机块 93 行（含贯穿 `openDeps` 与 `// 1.`→`// 3.2` 的注释）+ 判定谓词 39 行
  + `self`/`isOurs` 2 行；
- 加回 19 行 = `import` 1 行 + `self`/`isOurs` 指针注释 1 行 + 谓词指针注释 2 行 + 接线 15 行
  （4 行说明 + `createStateMachine({…})` 10 行 + `runRound` 调用 1 行）。

> 一个"净减 115 行"的改动，
> 与一个"净减 115 行、但**这台机器的全部自动重跑决策第一次可以被单测**"的改动，
> 在行数上是同一个东西——只不过收益本来就不在行数上（同切片 1、2 的结论）。

---

## 3. ★ 模块级可变状态：本切片**一个都没有**

切片 2 把 `bootReconciled` 提成了调用方持有的 `{ done: boolean }`，因为它必须**每实例一份**。
本切片的结论更彻底：`stateMachine.ts` 里**没有任何模块级 `let` / 模块级集合**。

会被改写的东西只有两个，全部由 `spaceWorker()` 闭包持有并注入：

| 状态 | 原形态 | 现在 |
| --- | --- | --- |
| `inflight` | 闭包 `const Set`（`spaceWorker` 顶部，早已是每实例一份） | 注入（`inflight.add/has`） |
| `abortRetryAt` | 闭包 `const Map`（`spaceWorker` 顶部） | 注入（`abortRetryAt.get/set`） |

**为什么不能变成模块级变量**：`superviseSpaces()` 会在**同一进程**里按空间把 `spaceWorker`
mount 成多个子实例（`index.ts` 的 `mountRunner`），它们共用一个模块注册表。一个模块级
`abortRetryAt` 会让空间 A 的退避把空间 B 的**同名 taskId** 一起挡住——任务 id 只在空间内唯一，
跨空间撞号是常态而不是意外，症状是"某个空间的中止重试被莫名其妙吞掉"，日志里一行都不会有。

> 一个"每实例一份"的闭包 Map，
> 与一个"每进程一份"的模块级 Map，在只有一个守护实例的部署里是同一个东西——
> 只不过多空间部署下，后者会让两个空间的任务 id 互相退避。

这条有专门的用例（"退避表由调用方持有、每实例一份"）与专门的变异（M6：退避表改成模块级
→ **红 4 条**，其中包括另外三个**根本没打算测多空间**的用例——模块级状态一被写下，
同一测试进程里后续每个 harness 都被串台，这正是多空间部署里会发生的事）。

---

## 4. ★ 取值函数注入：`isPipeline` / `stageByRole`

两个都是 `spaceWorker()` 里的 `let`，`applyPipeline()` 换流水线来源时会被**重新赋值**
（`stageByRole` 是整个 Map 被替换）。传值 = 模块从构造那一刻起看着一份冻结的旧快照：

- `isPipeline` 快照 → 切到流水线之后，`isOurs` 一直按单角色口径（`soldier === config.role`）
  判定：阶段角色认领的任务被判成"不是本守护的"，**blocked 解阻与 in_progress 退回纠错
  静默地不再发生**，任务干等 `staleMinutes`；
- `stageByRole` 快照 → 换流水线之后"本角色"映射整个是旧的。

> 一个"构造时快照了可变配置"的模块，
> 与一个"每次用之前重新取值"的模块，在只跑一次的场景里是同一个东西——
> 只不过前者会在配置变化之后，安静地继续按旧的来。

`config` / `scope` / `maxWorkerRetry` / `maxMediateAttempts` / `stageOf` 则**传值**
（前四个是 `const`，`stageOf` 是身份稳定、每次调用重新取值 `stageByRole` 的箭头函数）——
与 `mediation.ts` / `reclamation.ts` 一致。

**这条的读法有一个坑，写用例时踩到了**：`self(t)` 用 `isPipeline()` 决定"谁是守护自己"，
于是同一份评论在不同模式下含义不同——单角色模式里 `coder` 的评论**算**他人反馈（触发退回），
流水线模式里同一条评论**不算**（同事不是将军）。用例必须两边都断言，否则"活性"只测了一半。

---

## 5. 验证一：搬迁**逐字对拍**（133 行，只放行 4 条改写规则）

脚本：`.worktrees/_prt-handoff/prt315c-compare.mjs`。

为什么按**源码**对拍而不是编译产物：本切片搬的是 `sweep()` 里的**语句块**（不是具名声明），
只能按注释锚点 + 大括号配平抽；"before" 取自 `git show HEAD:plugins/src/index.ts`
（工作区那份已被改过）。TS 里这些语句与编译产物几乎 1:1，源码对拍同样有约束力。

做法：把旧文件的三段切片与新模块的三段切片各自归一化（去公共缩进、去纯空行）后**逐字比较**，
只放行一份**穷尽的改写规则**白名单（规则而不是"允许出现的字符串清单"——规则覆盖全部同类位置，
清单只能证明"我记得检查的那几处"）：

```
isPipeline ?            →  isPipeline() ?          （self / isOurs / stageOf 三处三元判定）
isPipeline &&           →  isPipeline() &&         （// 1. 里跳过未知角色任务）
stageByRole.has(        →  stageByRole().has(      （isOurs 的"是不是流水线角色"）
await mediation.mediatorRecoverWorker(  →  await mediatorRecoverWorker(   （兄弟能力经构造点注入）
```

结果：

| 被搬走的块 | 结果 |
| --- | --- |
| `self` / `isOurs` | ✅ 2 行逐字一致 |
| `openDeps` + `// 1.` → `// 3.2`（含 for 收尾 `}`） | ✅ **92 行**逐字一致 |
| `confirmState` → `medWorkerRedispatchCount`（含原始注释） | ✅ **39 行**逐字一致 |
| 新 `index.ts` 不再含 `const openDeps` / `const confirmState` / `const gaveUp` / `const workerFailStreak` / `const medWorkerRedispatchCount` / `const self` / `const isOurs` / 认领失败日志 / 两条 🛑 文案 | ✅ 全部不在 |

**对拍脚本自己的元检查**（`prt315c-compare-meta.mjs`）：三处各改一个字（日志串 /
`// 3.2` 评论文案 / 退避谓词 `intervalMs * 4` → `* 3`），每次对拍立刻红 1 行、
exit=1、且**打印出的差异行指向变异处**；逐字节还原后重跑 PASS。

> 一个"永远绿"的对拍，与一个"真的在比对"的对拍，
> 在代码没被动过的时候是同一个东西。

---

## 6. 验证二：断验证 9/9（每个变异都咬住"那条"用例）

脚本：`.worktrees/_prt-handoff/prt315c-breakverify.mjs`。判据不是"红了就行"，
而是**红的是哪条用例**——每个变异声明必须出现在红名单里的用例名，不匹配即判失败；
每次变异后逐字节还原（sha256 校验，`finally` 兜底）并重建产物。

| # | 弄坏什么 | 红几条 | 红的是不是目标用例 |
| --- | --- | --- | --- |
| M1 | 第 1 步不看 `inflight.has(t.id)`（互斥失效） | 1 | ✔ 互斥用例 |
| M2 | 第 2 步去掉 `openDeps(t)`（依赖闸门失效） | 2 | ✔ 依赖未解除 + 依赖 id 查不到 |
| M3 | 第 3.2 步去掉中止退避闸门 | 1 | ✔ 退避窗口用例 |
| M4 | `🟢 已派 AI` 从 `continue` 改回 `break`（**T-117 churn**回归） | 1 | ✔ churn 回归用例 |
| M5 | `isPipeline` 退回构造时快照 | 1 | ✔ 取值函数活性用例 |
| M6 | `abortRetryAt` 改成**模块级** Map | **4** | ✔ 含多空间那条（见 §3） |
| M7 | blocked 续做不再前置认领（**T-117 现场**回归） | 3 | ✔ 先 claim 再 workReturned 那条 |
| M8 | `>= maxMediateAttempts` 改成 `>`（安全阀迟到一轮） | 1 | ✔ 调解上限用例 |
| M9 | 任务的 `scope` 被实例 `scope` 顶掉 | 1 | ✔ 多空间 scope 用例 |

还原：`sha256(stateMachine.ts) = e7f8ecd6771578f6d3a0dbbf10b17b0268aa0d7e95a37060315fee5cf73fbb9f`
（变异前 = 变异后 = 还原后），还原后重跑 39/39 绿。

**没有一个是"不红"的**——即：本文件里没有"写了却测不到东西"的用例。

---

## 7. 验证三：逻辑只有一处（按构建产物查，不按源码查）

`prt315c-singleplace.mjs`：构建产物 `plugins/lib/stateMachine.js` **必须**含那 13 条
迁移后的记号；`plugins/lib/index.js` **必须不再**含其中 12 条；同时**必须**含 4 条接线记号
（`createStateMachine` / `from './stateMachine.js'` / `stateMachine.runRound(tasks, byId)` /
`mediatorRecoverWorker: mediation.mediatorRecoverWorker`）。

结果：**PASS**。也就是说"迁移"不是"复制"——`index.ts` 里只剩接线，逻辑一行都不在了。

> 只 grep 源码是不够的：源码里删干净、编译产物里留着的可能性不该靠人去想。

---

## 8. 棘轮一：`dsh-parity` —— 2114 → **2115**（对拍出来的）

`index.ts` 顶部只多了 1 行 `import`，锚点整体**下移 1 行**；本批它当场变红 **5 条用例**
（含端到端那条）。

按模块自己的方法重新对拍（`prt315c-rederive-parity.mjs`，用 `extractLegacyCallOptions` +
`LEGACY_CALL_OPTIONS` + `deepEqual`，经 `pathToFileURL` import）：

```
调用点总数 = 4 （上一批记录 4）
各行号 = 1151, 2115, 2328, 2723
  行  1151  选项 = [label, prompt, parent, signal, outputSchema]            ← 无 ...spread
  行  2115  选项 = [label, prompt, parent, signal, outputSchema, ...spread] ← ★ 与期望完全一致
  行  2328  选项 = [label, prompt, parent, signal, outputSchema]            ← 无 ...spread
  行  2723  选项 = [label, prompt, parent, signal, outputSchema, agentOptions]
与期望选项集完全一致的调用点 = 1 个： 2115
★ 新行号 2115（原 2114）——唯一，可安全改写
```

**没有用算术**（不是 `2114 + 1`）：`parity.mjs` 的注释明确禁止，理由是算术在下一批拆分时
会再错一次，而"找到了一行、只是不是那一行"这种错误不会报错。已在 `parity.mjs` 的
`LEGACY_CALL_SITE` JSDoc **内部**追加 `★ 2026-09-15 PRT-315 切片 3` 记录（旧→新行号、
搬了什么、4 个调用点各自的形态、为什么"搬的东西在它下面"**不是**"锚点不会动"的证据）。
重跑 `node --test runtime/adapters/dsh/parity.test.mjs`：**36 tests / 0 fail**。

（写这段注释时踩了一个坑，记下来：第一版把新块插在 `…覆盖率损失。 */` **之后**，
JSDoc 提前闭合、后面的 ` *` 变成裸语法，`parity.test.mjs` 直接 `test failed`
——**不是断言红，是解析红**。正确做法是插在那一行之前，让 `*/` 仍收尾整个块。）

## 9. 棘轮二：`dsh-boundary` —— 未增长（3 个文件 / 26 处）

新模块 `stateMachine.ts` 不含任何执行面记号（它连 `@deepseek-ai/*` 都不 import），
新用例文件也不含。`node scripts/ci/dsh-boundary.mjs --check` 报
`PASS（执行面依赖未增长：3 个文件 / 26 处，均在基线内）`，与上一批读数一致。

（执行面记号在本文件脉络里一律写成拆分形式——`parity.mjs` 已经为此打过警告，
写成一整串会被记为「执行面依赖 +1」，那是往坏的方向错的假阳性。）

---

## 10. 验证读数

- `npm run typecheck`：exit 0（无输出）。
- `npm test`（`plugins`）：**267 tests / 0 fail / 10 suites**（本批前 228，+39）。
- `index.ts` diff：`1 file changed, 19 insertions(+), 134 deletions(-)`。
- `parity.test.mjs`：36 tests / 0 fail（重钉之前是 **5 条红**，含端到端那条）。
- 门禁（`git add -A` 之后，`DSH_CHECKOUT` 已设，原始输出）：

```
node scripts/config/scan.mjs --check
scan: PASS（全部 env 读取点与疑似字面量均已处理；共 558 个疑似字面量）
node scripts/ci/ci-syntax.mjs
ci-syntax: PASS（50 个脚本全部可被 Node 解析）
node scripts/ci/encoding-check.mjs --all --quiet
encoding-check: PASS（1929 个文本文件：无 U+FFFD；代码/配置无 NUL 字节；37 个历史采集物为 UTF-16，已列出）
node scripts/ci/check-docs.mjs
check-docs: PASS（README.md + docs/FEATURES.md 结构/链接/索引一致，10 类校验项全绿）
node scripts/ci/dsh-boundary.mjs --check
dsh-boundary: PASS（执行面依赖未增长：3 个文件 / 26 处，均在基线内）
node scripts/prt/topology-inventory.mjs --diff
topology-inventory: 与清单一致（无漂移）
node scripts/prt/baseline-snapshot.mjs --check
baseline-snapshot: 平台契约与基线一致（无漂移）
```

七道全部 exit 0。（文本文件计数 1926 → **1929**：新增的模块 / 测试 / 本文件三个。
另：`git add` 对三个新文件报了 `LF will be replaced by CRLF`
——仓库 `core.autocrlf=true`，与既有的 `mediation.ts` / `reclamation.ts` 同形，
仓库 blob 恒为 LF。）

---

## 11. ⚠️ 诚实边界

1. **只完成第 3 个切片，而且"状态机"这一类也只做了 `sweep()` 里的**任务迁移决策**。**
   仍在 `spaceWorker()` 里、按 spec 还属于"状态机"但本批**一行没动**的有：
   `// 4. 流水线 done 补流转`（`advancePipeline`，更接近流水线/交接边界）、
   `// 4.5 合入调解的内嵌路径`（复用切片 1 的模块，但**驱动它的循环与退避**还在 `index.ts`）、
   `// 5. 切片流水线编排`（`orchestrateSlices`）。
2. **`spaceWorker()` 仍是约 2610 行。** 本切片只切掉了它最靠前的一小段。剩余边界至少还有：
   **workspace**（worktree 建/复用/清理、`prepareWorktree`、`runWorker` 的派工与看门狗）、
   **验收**（`// 4.2` 经验沉淀、`// 4.3` 置信度晋升、`// 4.4` 规则资产 doctor、
   `// 4.5a` 技能桥、契约文档/产物登记）、以及**状态机的其余部分**（上面第 1 条那三项）。
   这是一次**按边界分批**的迁移，不是"拆完了"。
3. **逐字对拍证明的是"搬对了"，不是"这段代码是对的"。** 它只能证明新旧一致；
   代码里原有的问题会**一起**搬过来。本切片就有一个现成的例子（照原样保留、未修正）：
   `// 3.2` 的 `abortDriven` 判定用的是 `Date.now()`，而任务评论时间用 `new Date(c.at).getTime()`
   ——两者混用在同一段里，本批**原样保留**（"顺手统一时钟"是另一个改动，会改行为）。
4. **断验证的 9 个变异只覆盖新用例断言到的东西。** 没有断言到的分支本轮既没覆盖、也没被探针
   检验，例如：`workerFailStreak` 里 `claimedAt` 为 `null`（`since = 0`）时的计数、
   `confirmState` 的 `answers` 里 `at` 与 `lastAsk.at` **完全相等**的边界、
   `comments` 缺 `text` 字段（`c.text.startsWith` 在 `// 3.2` 会抛——**原实现就这样**）、
   多依赖 `blockedBy` 部分解除、以及 `room()` 变 false 之后已在 `inflight` 的任务收尾。
5. **`runDetached` 的收尾路径不是本切片验证的对象。** 用例里 `runDetached` 是替身
   （收 job 进 `deferred`，用 `await h.flush()` 手动等），所以
   "`inflight.delete` 在 `finally` 里"这条语义**仍是端到端用例在覆盖**（继承来的证据），
   本切片没有为它加断言——它是 worker 上下文，按 §1 故意留在 `index.ts`。
6. **端到端覆盖是"继承"来的，不是本批加的。** `worker-regression.test.mjs` 等真实守护用例
   每轮扫单都会走这五步，所以这次重构有端到端证据（含 T-117 那两条回归）；
   但那些用例是本批之前就有的，覆盖的是主路径，不覆盖上面第 4 条列的那些边界分支。
7. **`stateMachine` 是每轮 sweep 构造一次的对象**（见 §1 的"为什么接线在调用点"）。
   这与原实现（谓词定义在 `sweep()` 体内、每轮重建）语义相同，但**构造次数是个真实的
   运行时事实**：每轮多一次对象创建（几十个函数引用）。我没有测它对扫单耗时的影响
   ——量级显然可忽略，但**这是推断，不是测量**。
8. **`stageOf` 有两份定义面**：`index.ts` 里仍有一个 `stageOf`（给 `// 4.` 用），
   状态机模块**不再自己定义**、而是收调用点注入的同一个函数。这不是"两处逻辑"，
   但它是本切片对"逻辑只有一处"这条不变量唯一的例外说明，写在这里以免被误读。
9. **`docs/STATUS.md` / `docs/superpowers/prt/PRT-PROGRESS.md` /
   `PRT-IMPLEMENTATION-REPORT.md` 未动**（按任务要求，operator 自己维护），
   所以进度表仍写着"切片 1（或 2）已交付"。
10. **编码：** 新文件是 LF（与 `mediation.ts` / `reclamation.ts` / 两个测试文件一致）；
    `index.ts` 保持工作区 CRLF（本批编辑用脚本按 `\r\n` 拼回，改完复核 3177 个 CRLF / 0 个裸 LF）；
    `parity.mjs` 同样保持 CRLF（570 个 CRLF / 0 个裸 LF）。仓库 blob 恒为 LF（git 归一化），
    `git diff` 里因此看不到行尾噪音。
11. **未运行**：`scripts/ci/run-ci.mjs`（全量 CI，任务明确禁止）、
    `topology-inventory --record`、以及任何 `git commit` / `git push`。
12. **本文件是新增文档**；`plugins/tests/stateMachine.test.mjs` 是本批**新增的测试文件**
    （CI 套件自动 glob `plugins/tests/*.test.mjs`，无需改 runner，但 operator 需要知道这个路径）。
