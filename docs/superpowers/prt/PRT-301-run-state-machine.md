# PRT-301 持久化运行状态机 + Orchestrator worker 入口

状态：**已交付**。新增 `orchestrator/state-machine/`（`states.mjs` / `transitions.mjs` / `failure.mjs`）、
`orchestrator/worker/`（`main.mjs` / `status-file.mjs` / `run.mjs`）、
入口 `product/orchestrator/worker.mjs`、配置面 `orchestrator/config-schema.mjs`，
套件 `orchestrator`（**51 例**，含 **1 例真实进程**）。

这一批同时关掉了清单里最后两个已知缺口中的一个：
`MANIFEST_KNOWN_GAPS` 从 `[ENTRY_MISSING:orchestrator, ENTRY_UNRESOLVED:runtime]`
变成 `[ENTRY_UNRESOLVED:runtime]`——**门禁先变红，再改文档**。

---

## 1 状态机的价值全在「拒绝」上

`orchestrator/state-machine/` 是一个纯模块（不碰数据库、不碰网络）。
它接受一次迁移，回答两个问题：**允许吗？允许的话，副作用之前必须先落库什么？**

一批 30 条用例里，**19 条断言的是「拒绝」**。这不是风格偏好：状态机最危险的失效方式
不是「写错一个状态」，而是「本该拒绝的迁移被接受了」。被接受之后没有异常、没有日志，
只有很晚才被用户发现的现象：

| 本该拒绝的事 | 接受之后的表象 | 后果 |
| --- | --- | --- |
| `Queued → Running`（跳状态） | 与正常执行**完全一致** | 没有工作区、没有上下文快照：产物落在错误目录，审计缺来源哈希 |
| 过期 worker 写入（无 CAS） | 用户看到「已完成」变回「进行中」 | 已提交的终态被改写，所有日志正常 |
| `UnknownOutcome → Queued` | 任务「自动恢复了」 | **重复外部写入**：重复付费 / 重复推送 / 重复下单 |
| 未登记错误码默认可重试 | 「重试了几次就好了」 | 对不认识的错误无限重试，最终烧光队列 |
| 缺 `hasNextPost` 时默认「没有下一岗位」 | 任务正常 `done` | 任务链静默掐断，直到目标停住才被发现 |
| 缺 `retryBudgetRemaining` 时猜一个 | 任务「待办」或「阻塞」 | 「还会自动重试」与「等人处理」表现成同一种状态 |

因此每一条拒绝都返回**具名错误码**（`UNKNOWN_OUTCOME_NOT_RETRYABLE` 而不是笼统的
`ILLEGAL_TRANSITION`）：具名才能被 metrics 单独统计与告警，也才能告诉人下一步做什么。

## 2 三条具体的设计决定

### 2.1 CAS：迁移必须声明来源

```js
applyTransition({ current: 'Completed', expectedFrom: 'Running', to: 'Running' })
// → { ok: false, code: 'STALE_STATE', current: 'Completed', expectedFrom: 'Running' }
```

`expectedFrom` 是调用方**以为**的当前状态（通常来自它领取时读到的那一行）。
这就是「过期 worker 拒写」在纯逻辑层的形态；数据库层的 `leaseEpoch` 判定属 PRT-313。
两者都要有：逻辑层的 CAS 挡住「读到的和写时的不是同一行」，
数据库层的 epoch 挡住「读的时候就已经过期了」。

### 2.2 `AwaitingApproval` 必须记住它从哪来

`AwaitingApproval` 有两种入口，对应两种任务状态：

| 入口 | 任务状态 | 批准后去哪 |
| --- | --- | --- |
| 运行中的工具请求 | `in_progress` | 回到 `Running` |
| 验收后的交付审批 | `in_review` | 回到 `Validating`（再 HandingOff/Completed） |

如果只画一条 `AwaitingApproval → Running` 出边，交付级审批通过后会回到 `Running`
**再跑一遍**，而验收环节被静默跳过。因此进入暂停时必须记下 `returnTo`，
且出边只允许回到那一个状态——返回别处直接报 `RETURN_TO_REQUIRED`。

配套的一条：`in_review` 是唯一一个「看起来结束、其实还在跑」的状态。
映射成 `done` 会让用户以为任务完成；映射成 `blocked` 会让它出现在「待人工处置」列表里
而实际不需要干预。两种都不是小偏差。

### 2.3 未登记的失败码**不**默认可重试

```js
classifyFailure('something-new')                            // → fatal（DeadLetter）
classifyFailure('something-new', { externalEffectPossible: true })  // → unknown-outcome
```

新错误码意味着「我们还不知道它是什么」。对一个不认识的错误自动重试，
最好的情况是浪费一次额度，最坏的情况是重复执行外部写操作。
因此未登记的码按「外部副作用是否可能已发生」分成两类，**都不会**得到 `retryable`。

同一原则的第二个入口是崩溃恢复：

```js
recoveryDecision({ attemptState: 'Running', leaseValid: false })
// → { ok: false, code: 'EXTERNAL_EFFECT_UNKNOWN' }   ← 拒绝判定，不猜
```

判错的代价不对称：判成「可重试」会在已发生副作用时重复执行；判成「结果未知」，
最坏只是多一次人工确认。因此这里要求调用方显式回答，缺这个输入就拒绝判定。

## 3 worker：**不认领自己执行不了的任务**

`orchestrator/worker/main.mjs` 的循环很短，但有一条行为是本批次最重要的：

> 没有配置执行引擎时，worker **一次 `claim` 都不发**。

一个「积极」的 worker 会照常认领任务、然后立刻失败，把每个任务的重试额度烧掉，
最后全部落进 Dead Letter。从外部看，产品的表现是「任务在跑，但全都失败了」——
而真实原因只是「没配执行引擎」，本该在启动时就说清楚。

同样地，拿不到 team-hub 时不认领（认领不到就无事可做），
且**不退出**：退出会让 Launcher 只看到「进程没了」，看不到原因。

状态文件（`DataDir/orchestrator/worker.status.json`）是这类「无监听端口」进程的唯一观测出口。
Launcher 对 orchestrator 声明的就绪判据是 `kind: 'none'`——
也就是「进程起来了」就等于「好了」。而 worker 可能起来了但拿不到 hub、
没有执行引擎、或正在退避；没有状态文件时这三种情况在外部**完全同形**。

两条约束：
- **原子替换**（写 `.tmp` 再 rename）：诊断页读到半截 JSON 会得到「状态未知」，
  而真因只是写入被打断；
- **绝不写入凭证**：这个文件会被贴进 issue 与诊断包，而进程恰好持有 `TEAM_HUB_TOKEN`。
  脱敏写在**写入侧**（键名黑名单），不能指望每个读它的人自己记得。

## 4 一条实测出来的平台事实：Windows 上「终止」不走信号处理器

真实进程用例原本断言：`child.kill('SIGTERM')` → 进程写 `stopped` → 退出码 0。
实测结果是 `{ code: null, signal: 'SIGTERM' }`——**信号处理器一次都没被调用**。

这不是 Node 的缺陷：Windows 上 `SIGTERM`/`SIGINT` 没有对应语义，
`child.kill()` 会**无条件终止**目标进程（Node 文档明确写了这一点）。

它对产品有直接后果：

1. **优雅停止在 Windows 上可能一次都不会执行。** 释放 lease 这一步不能依赖
   worker 自己走完收尾流程。Launcher 的 `SIGTERM → 宽限 → taskkill /T /F`
   里，前半段在 Windows 上等价于直接杀。
2. **状态文件会停在最后一刻的值**（例如 `executing`）。
   「文件存在」与「worker 还活着」是两件事，必须分开判定。

因此新增 `isStatusFresh(status, { now, maxAgeMs })`：超过窗口、缺时间戳、
时间戳不可解析、或时间戳落在未来（时钟被调整过）一律返回 `fresh: false`。
宁可说「不确定」，也不要把一个可能已经死掉的 worker 报成在跑——
后者的代价是任务永远没人认领，且没有任何错误信息。

用例按平台分支断言，并把这条结论写成注释：Windows 分支断言「确实被信号终止」
且「状态文件没有停在 `stopped`」——如果哪天它真的出现了 `stopped`，
说明这条平台结论需要重新验证，用例会立刻告诉我们。

## 5 自查改掉的四处（边界 / 命名 / 覆盖）

编码完成后按「边界与错误处理、命名、测试覆盖」三项自查，改掉四处。它们都是**不会报错**的那一类：

| # | 问题 | 为什么不报错 |
| --- | --- | --- |
| ① | `heartbeatIntervalMs` 被接收但从未使用 | 参数在，行为不在。缺心跳不会让任何用例失败，只会让长任务在租期后被**第二个 worker 重跑一遍**——对已调用过外部写的步骤就是重复副作用。已实现执行期心跳（计数、`leaseMayBeLost`、日志说明后果、写进状态文件）。 |
| ② | 入口 `const { runPromise } = await runWorkerProcess()`，而缺 `LEGION_DATA_DIR` 时它返回数字 `8` | 解构数字得到 `undefined`，`await undefined` 通过，`process.exitCode = 0`。Launcher 会认为「worker 起来了」，而它什么都没做。已改为**判别式联合**（`ok:false` 携带 `exitCode` + `message`），并从类型上让这种写法不可能再出现。 |
| ③ | `isMainModule()` 只有它自己的用例在用 | 入口是专用文件，不存在「被 import 时误自启动」的场景。无人使用的分支会让读者以为存在双用途。已删除。 |
| ④ | `stop()` 里一个空 `if (loopPromise !== null) {}` | 空块比没有更坏：它暗示这里本该做点什么。已删，注释保留在它该在的地方。 |

②是最值得记住的一条：**「起不来却报成功」比「起不来」坏得多**。

## 6 心跳不是保活优化，是「不重复执行」的前提

租期的含义是「另一个 worker 多久之后可以认为我死了并接管这个任务」。
执行期间不发心跳，长任务一定会被第二个 worker 认领并重跑。
因此 `startHeartbeat` 落在 `execute()` 前后，而不是「以后补」：

- 心跳**必带 `leaseEpoch`**：不带 epoch 的心跳无法证明「我还是持有者」。
- 执行结束**必须停心跳**：继续发会让一个已释放的 lease 看起来还活着。
- 心跳失败**必须可见**：连续失败意味着 lease 可能已易主。此时本次执行继续下去，
  最后提交的终态会被 epoch 校验拒绝（PRT-313 的防线）；**如果它没被拒绝，那就是覆盖了别人的结果**。
  本批次还没有中断正在执行的 executor 的能力（需要把 `AbortSignal` 一路穿到
  RuntimeAdapter，属 PRT-302/311），因此这里能做且必须做的是：计数、置 `leaseMayBeLost`、
  写进状态文件、并在日志里**说清后果**，而不是只写「心跳失败」四个字。

## 7 顺带修正：配置面声明的形状必须是 `defineSchema`

`orchestrator/config-schema.mjs` 第一版是手写对象 + `envNames` 数组。
`scan --check` 立刻报 `mod.SCHEMA.envNames is not a function`——
扫描器调的是 `SCHEMA.envNames()`。改成 `defineSchema` 后，
「配置面声明写错形状」这件事在**导入时**就被 schema 校验拦住，
而不是等到 CI 跑扫描才以一句类型错误的形式出现。

同一处还有第二个发现：加上 `TEAM_HUB_` 前缀后，`check --strict` 立刻对
`TEAM_HUB_PORT` / `TEAM_HUB_HOST` / `TEAM_HUB_DB` 报「前缀属于本进程但未在 schema 中声明」——
而这三个变量**属于 team-hub 自己**。前缀机制的前提是「该前缀下的变量都属于我」，
在共享的 `TEAM_HUB_*` 变量族里只拥有两个成员时它不成立。改用 `foreignEnv` 逐个登记：
代价是显式，收益是不产生假告警——而假告警会让人习惯性忽略 warnings，
那正是这个机制失效的方式。

## 8 未交付

- **PRT-302/313 lease 的落库实现**：`leaseEpoch`、team-hub 权威时间、过期 epoch 拒写
  目前只有**语义与判定**（`applyTransition` 的 CAS、`recoveryDecision`、
  worker 的 `leaseEpoch` 传递与心跳），数据库事务与条件更新未实现。
  心跳已能发现「lease 可能已易主」，但**还不能中断正在执行的 executor**——
  中断需要把 `AbortSignal` 一路穿到 RuntimeAdapter，属 PRT-302/311。
- **PRT-303 attempt 持久化与不可覆盖历史**：状态机声明了 `createsNewAttempt`，
  仓储未实现。
- **PRT-304~308 从 `plugins/src/index.ts` 的提取**：未开始。
- **PRT-309/310 的重试队列与恢复扫描**：退避计算与恢复判定已成函数，
  调度循环与 Dead Letter 存储未实现。
- **worker 尚未接上 RuntimeAdapter**：`executor` 注入点已就绪但生产路径传 `null`，
  因此真实运行时它报 `no-executor` 且不认领（这是**如实上报**，不是缺陷）。
- **数据面路由 `/api/runtime/*` 不存在**：worker 的 hub 客户端按这四条路由编写，
  team-hub 侧尚未实现，因此即使是配置完整的 worker 也还认领不到任务。
- **状态文件尚未被 Launcher 消费**：`isStatusFresh` 已就绪，
  但 `readiness` 仍是 `kind: 'none'`，接线属 PRT-711。
