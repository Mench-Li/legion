# PRT-309 / PRT-310 / PRT-311：重试退避与 Dead Letter、恢复扫描与人工处置、外部副作用幂等与 Unknown Outcome

**对应 spec**：§6.4 运行状态机、§12 的 PRT-309 / PRT-310 / PRT-311
**阶段 3 完成标准**（spec 第 885 行）：强制终止 worker 或 DSH 后，重启不会丢任务、伪装成功或重复执行已确认的外部写操作。
**交付物**：`team-hub/run-store.mjs`（新增 5 个方法 + 5 个列 + 建表补列）、`team-hub/server.mjs`（4 条新路由）、
`orchestrator/state-machine/transitions.mjs`（`UnknownOutcome` 的两条新出边 + 两个新守卫）、
`orchestrator/worker/{main,run}.mjs`（失败上报改走单一入口）
**套件**：`run-plane` 87 例（仓储 48 + HTTP 契约 26 + 端到端 13）、`orchestrator` 58 例（状态机 31 + worker 27）

---

## 0. 这一批补的是什么

PRT-302/303/313 解决了「状态落库、不丢、不乱写」。剩下四类是**都不会报错**的失败，
它们共同的特征是：所有日志都正常，所有测试都可以通过，而系统在做错的事。

| 静默失败 | 不修它的后果 |
| --- | --- |
| ① 无限重试 | 一个持续失败的任务安静地永远跑下去，把模型配额、日志和外部系统调用次数一起吃掉 |
| ② 任务停在中间态 | 它既没有可领的队列、也不在等人工清单里；从任何界面看只是"失败了"，没有人会处理它 |
| ③ 静默消失 | `DeadLetter`/`UnknownOutcome` 只是历史里的一行；用户以为它还在跑 |
| ④ 重复副作用 | 一个**真的已经交付**的结果被当失败重做，或者挂起的任务被一次"又失败了"重新拉起来 |

---

## 1. 「失败了之后怎么办」只有一个决策点（PRT-309）

```js
scheduleRetry(row, { atMs, actor, reason, failureCode, detail, delayMs })
  → { action: 'retry-new-attempt', attempt, nextAttemptAtMs, attemptsUsed, maxAttempts }
  → { action: 'dead-letter', attempt, reason, attemptsUsed, maxAttempts }
```

为什么必须合成一个函数：把「重试」与「放弃」分成两处调用时，漏掉"额度用完"那条分支的后果是
**无限重试**——而无限重试不会报错，它只是安静地永远跑下去。

### 为什么先终结为 `RetryableFailure` 再走一步到 `DeadLetter`

即使额度已经用完，也**先**写 `RetryableFailure`（"它失败了一次"这个事实），再写
`RetryableFailure → DeadLetter`（"我们决定不再重试"这个决定）。两个理由：

1. `Running → DeadLetter` 在状态机里**不是合法边**。直接把终结状态写成 `DeadLetter`
   要么被守卫拒绝，要么得绕过状态机——而回收路径是无人值守的，绕过校验的错误状态
   会安静地留在库里直到有人看看板。
2. 事件流里因此能看出两步：先失败、后因额度耗尽被丢弃。
   只有一步时，"为什么它进了 Dead Letter"要靠 `failure_code` 猜。

### 退避是**服务端写进队列的闸门**

```
新尝试 next_attempt_at_ms = now + retryDelayMs(attempt_no)
领取查询 WHERE (next_attempt_at_ms IS NULL OR next_attempt_at_ms <= ?)
```

不这么做时 `retryDelayMs` 只是一段**没人调用的纯函数**——"退避"这个词在系统里不成立，
而所有代码看起来都是对的。退避参数：`baseMs 2000`、`factor 2`、`maxMs 300000`、
jitter 由仓储注入 `random`（各调用点自己取随机数会让"退避算错"无法确定性断言，
而那恰好只表现为"重试得太快"，只有生产里看得见）。

### 额度用 `attempt_no` 而不是"已经失败过几次"

尝试编号是唯一不会漂的计数（每次重试 +1，且历史不可覆盖）；
"失败次数"要靠遍历历史去数，一旦有人补写了一条事件就会算错。

### 回收路径**同样**查额度

`recoverExpired` 的重试分支也走 `scheduleRetry`。不这么做的话，
一个**每次快要失败就被杀掉**的任务会永远重试下去——这条路径上没有任何失败上报、
没有错误日志，只有租约一次次过期，是最难查的一种故障。
两条产生新尝试的路径必须共用同一个额度判定，否则等于没有上限。

**但回收不叠退避**（`delayMs: 0`）。理由：等待已经由租期本身（默认 120s）付过了；
退避策略要防的是"对已知失败的依赖快速重试"，而租约过期是**未知原因**的中断
（机器重启、OOM、被强杀）。再加一段延迟只会推迟一条本来可能完全正常的任务。
这一条是开发中真实遇到的分歧：先按"统一策略"给回收也加了退避，
结果是把「回收后立即可再领」这条**阶段 3 完成标准所在的判据**削弱了 2 秒，而没有任何收益。

### `maxAttempts` 非法时拒绝

`0`、负数、小数、字符串都拒绝。按 `0` 或 `NaN` 继续会让额度判定变成永不成立或永远成立，
两种都不会报错。`1` 是合法配置（只做首次、不重试）。

---

## 2. 失败上报只有一个入口

`failAndRetry` 是 worker 报告失败的**唯一**路径，`/api/runtime/fail` 是它在 HTTP 上的形状。

之前 worker 走的是 `transition({to:'RetryableFailure'})`：那只把尝试标成失败就结束了，
"接下来怎么办"没人做。结果是任务永远停在 `RetryableFailure`——既没有可领的队列，
也不在等人工清单里（它不是 `DeadLetter`/`UnknownOutcome`）。这类缺陷不会报错。

`failAndRetry` 保证任务必然被送到「重试中」或「DeadLetter」其中之一。
hub 客户端刻意**不提供** `transition({to:'RetryableFailure'})` 的替代封装：
让 worker 有能力绕过这个入口，就等于让它有能力制造那个缺陷。

### 重复上报必须是 no-op（自审抓到的一处真实缺陷）

在一条**已经结算过**的尝试上再报一次失败，原实现会继续往下走，
对 `RetryableFailure` 再触发一次 `RetryableFailure → Queued`——于是：

> 一次失败被结算两次 → 排出两条排队尝试 → 同一条任务被两个 worker 各领一条 → 重复副作用

现在 `RetryableFailure` 与 `UnknownOutcome` 上的重复上报是 no-op。
`UnknownOutcome` 还额外返回 `reason: 'awaiting-human-reconciliation'`：
挂起等人工的尝试**绝不能**因为"又报了一次失败"就重跑，这是它存在的全部意义。

不带 `leaseEpoch` 时是系统侧的重放（no-op）；带 `leaseEpoch` 且已过期时报
`LEASE_EPOCH_STALE`——**不能替别人报失败**。

---

## 3. 「等人工」必须是一份可结清的清单（PRT-310）

```js
listHeld({ scope, limit })
  → { total, actionable, items: [{ ...attempt, isLatest, taskStatus }] }
```

`UnknownOutcome`（结果不可确认）与 `DeadLetter`（额度耗尽）两类。
这个列表是"不丢任务"在**运维意义上**的落点：
状态机保证不会静默重跑，这个列表保证不会静默消失。

`isLatest` 是必需的：历史里的 `DeadLetter` 不该继续出现在待办列表上，
否则每次重试都会让列表变长，人工要在一堆早已被替代的条目里找活的那些。
`total` 与 `actionable` 分开返回，是为了让界面既能追溯全部、又只把 `actionable` 当待办。

### 四种处置决定，各自对应一个不同的事实

| decision | 事实 | 去向 |
| --- | --- | --- |
| `external-effect-happened` | 对账确认外部写已生效 | `UnknownOutcome → Validating`（按成功走验收，**不重跑**） |
| `external-effect-absent` | 对账确认外部写未生效 | `UnknownOutcome → RetryableFailure` → 重试/额度判定 |
| `dead-letter` | 查不清 / 决定人工兜底 | → `DeadLetter` |
| `cancel` | 决定不做 | → `Cancelled` |

未登记的决定一律拒绝（`BAD_DECISION`，400），**不做任何默认**。
猜错的两种结果分别是"重复执行一次已生效的外部写"与"静默丢弃一次已完成的交付"。

处置必须留痕（`actor` 必填，`external_effect` / `resolved_by` / `resolved_note` 落库），
且**仍然过状态机**：人工处置不是绕过规则的后门，它只是提供了规则要求的那个输入（对账结论）。
所以 `DeadLetter`（终态）上不能凭空"再试一次"（`NOT_HELD`）。

不需要处置的状态上报处置返回 `NOT_HELD` 而不是笼统的拒绝：
「有人点错了按钮」与「另一个 worker 正在跑它」需要不同的处置。

---

## 4. 幂等与 Unknown Outcome（PRT-311）

### 4.1 幂等键跨尝试稳定

```js
idempotencyKey = `idem:${taskId}`   // 刻意不含 attempt_no
```

含 `attempt_no` 就等于没有幂等键：每次重试都是一个新键，
外部系统无法判断"这是同一次操作的重试"，去重照旧失效。
这是整个「不重复执行已确认的外部写操作」里**唯一需要外部系统配合**的一环，
因此它必须是一个能拿去用的稳定值，而不是一个每次执行都变的本地编号。

### 4.2 `UnknownOutcome` 的两条新出边

原状态机里 `UnknownOutcome` 只能进 `DeadLetter` 或 `Cancelled`。禁令是对的
（自动重试 = 重复付费），但它把「人在对账之后得出的两个确定结论」也一起堵死了：

- 确认**已发生** → 只能进 `DeadLetter`（把做好的交付当失败重做）或 `Cancelled`（静默丢弃）；
- 确认**未发生** → 只能挂在那儿，一个本可安全重试的任务永远等人工。

现在补上 `Validating` 与 `RetryableFailure` 两条边。
**`UnknownOutcome → Queued` 仍然非法**——若允许，"未知"与"确认没发生"就合并成了一个状态，
那条最关键的禁令会自己失效。这也是为什么"确认未发生"要去 `RetryableFailure`
而不是直接回 `Queued`。

两个新守卫都要求**显式**布尔值：

| 输入 | `externalEffectHappened` | `externalEffectDidNotHappen` |
| --- | --- | --- |
| `true` | 通过 | `TRANSITION_GUARD_FAILED`（重试会造成重复副作用） |
| `false` | `TRANSITION_GUARD_FAILED`（应走 RetryableFailure） | 通过 |
| 缺失 / 非布尔 | `MISSING_GUARD_INPUT`（**不得默认**） | `MISSING_GUARD_INPUT` |

缺省必须报错而不是默认某一个方向：默认"已发生"会把没做成的交付当成功推进验收，
默认"未发生"会重复执行一次已经生效的外部写。**两种都不报错。**

---

## 5. 建表补列：为什么 `CREATE TABLE IF NOT EXISTS` 不够

上一批（PRT-302/303/313）已经推送到远程，也就是说线上可能有一个没有新列的库。
`CREATE TABLE IF NOT EXISTS` 对**已经存在**的表是空操作——表建好了，新列一列都不会加上。
只改 `CREATE TABLE` 的后果是：**老部署在第一条 claim 上就报 `no such column`**，
而新部署一切正常。这种「新旧部署行为不同」的缺陷在单机开发里永远看不到。

因此 `ensureRunSchema` 增加 `ensureColumn`（读 `PRAGMA table_info`，缺了才 `ALTER TABLE ADD COLUMN`）。
新增 5 列：`idempotency_key`、`next_attempt_at_ms`、`external_effect`、`resolved_by`、`resolved_note`。

`external_effect` 用**三态**而不是布尔：`null`=未对账 / `'confirmed'`=已发生 / `'absent'`=确认未发生。
布尔无法区分"确认没发生"与"还没人问过"，而这两者一个可以安全重试、一个必须继续等人工。

---

## 6. HTTP 契约（4 条新路由）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/runtime/fail` | 失败结算的唯一入口；返回 `action` / `nextAttempt` / `nextAttemptAtMs` / `taskStatus` |
| GET | `/api/runtime/held` | 等人工清单（`scope` / `limit`） |
| POST | `/api/runtime/resolve` | 人工处置（`attemptId` / `decision` / `actor` / `note`） |
| GET | `/api/runtime/budget` | 重试额度读数（`taskId`）：`attemptsUsed` / `maxAttempts` / `remaining` / `nextAttemptAtMs` / `idempotencyKey` |

退避时刻必须由**服务端**给出（worker 自己算会受本机时钟影响）——
这与 PRT-313 的"权威时间只在服务端"是同一条原则的延伸。

`/api/runtime/budget` 存在是因为界面上要能回答"这条任务还能自动重试几次、下次什么时候"。
答不出来时用户看到的只是"它又失败了"，而无法判断该不该干预。

---

## 7. 测试策略

沿用三层分工，新增 33 例：

| 层 | 新增 | 只有这一层看得见的 |
| --- | --- | --- |
| 仓储（48 例） | +14 | 退避闸门真的拦住了领取、额度耗尽进 DeadLetter、回收也查额度、重复上报是 no-op、处置决定非法时不改状态、幂等键跨尝试稳定 |
| HTTP（26 例） | +7 | 具名码（`BAD_DECISION` / `MISSING_PARAM` / `NOT_HELD`）有没有被吞掉、服务端给的退避时刻、`held` 清单的 `isLatest` |
| 端到端（13 例） | +3 | 真 hub + 真 worker：执行失败被结算成「重试 + 退避」、反复失败进 DeadLetter 且能在清单里找到、挂起的 `UnknownOutcome` 不被后续失败上报偷偷重试 |

端到端这一层的价值再次被验证：仓储与 HTTP 各自的断言都通过之后，
真 worker 打真 hub 才暴露出"上报失败后服务端有没有真的把新尝试排进队列"这件事。

### 时间处理

所有时间都由注入的 `clock` 决定，「租期到期」「退避到期」都是**确定性跨过去**的，不 sleep。
端到端用例里唯一需要等退避的地方（`/api/runtime/budget` 与 DeadLetter 链路）
用服务端返回的 `nextAttemptAtMs` 直接改库把闸门清掉，而不是真等 2~16 秒。

---

## 8. 未交付

- **幂等键的实际使用方**：键已经稳定地生成并落库，但**还没有任何执行引擎把它带进外部写请求**
  （那需要接上 RuntimeAdapter，属 PRT-253/311 的接线）。也就是说：
  本批交付的是"幂等键存在且语义正确"，不是"外部去重已经生效"。
- **DeadLetter 的人工"重新打开"入口**：目前 `DeadLetter` 是终态，处置只支持 `cancel`。
  人工确认可以再试时应新建任务，或补一个显式的 reopen 操作（本批刻意没做：
  离开终态需要一个比 `resolveAttempt` 更强的语义，不该顺手加）。
- **恢复扫描的自动调度**：`recoverExpired` 有完整实现与路由，但**没有常驻调度者**
  定期调用它（现在由测试/手工触发）。PRT-712 的队列指标与 Launcher 的健康循环是它的自然归属。
- **退避的持久化调度**：退避闸门在库里，但队列里到点的尝试要等 worker 来领——
  没有"定时唤醒"机制，因此最坏情况下的延迟是 worker 的 poll 间隔。
- **PRT-312 的真实强杀演练**（跨批未交付）：Windows 上强制终止不走信号处理器，
  因此"进程被杀 → 租约过期 → 回收 → 另一 worker 接手"目前是分两段验证的。

---

## 9. 复跑方式

```bash
node scripts/ci/run-ci.mjs --only test      # 全套（设 DSH_CHECKOUT 时 62 套件 / 1796 用例）
node --test orchestrator/state-machine/state-machine.test.mjs orchestrator/worker/worker.test.mjs \
            team-hub/run-store.test.mjs team-hub/run-routes.test.mjs team-hub/run-plane-e2e.test.mjs  # 145 例
node scripts/config/scan.mjs --check        # env 声明门禁（244 个疑似字面量）
node scripts/ci/dsh-boundary.mjs --check    # DSH 边界棘轮（3 文件 / 26 处，未增长）
node scripts/prt/topology-inventory.mjs --diff   # 拓扑清单无漂移
node scripts/prt/baseline-snapshot.mjs --record  # 新增 4 条路由后刷新平台契约基线
```
