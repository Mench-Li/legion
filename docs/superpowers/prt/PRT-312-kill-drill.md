# PRT-312：强制终止 worker 后的整链路演练

**对应 spec**：§6.4 运行状态机、§6.10 进程顺序、§12 的 PRT-312
**阶段 3 完成标准**（spec 第 885 行，逐字）：强制终止 worker 或 DSH 后，重启不会丢任务、伪装成功或重复执行已确认的外部写操作。
**交付物**：`orchestrator/worker/scripts/kill-drill-worker.mjs`（真 worker 进程夹具）、
`team-hub/run-kill-drill.test.mjs`（2 例，真进程 + 真 team-hub + `SIGKILL`）

---

## 1. 为什么这个演练必须存在

在它之前，所有"崩后回收"的用例都是在**同一个进程里**调用 `recoverExpired`。
它们验证的是"回收函数写对了"，而不是：

> 一个进程真的被杀掉之后，**磁盘上留下的东西**会让回收做出正确判断。

完成标准问的恰恰是后者。同一进程里模拟"被杀"只能靠不调用某个函数，
而真实强杀的语义是"函数执行到一半，进程没了"——两者留下的痕迹不同：

| | 同进程模拟 | 真强杀 |
| --- | --- | --- |
| 被杀时机的粒度 | 函数边界（你知道该停在哪） | 任意指令处（可能正卡在一个 await 里） |
| 已经写进库的东西 | 由测试自己决定 | 由**先落库意图再做副作用**的顺序决定 |
| lease 会不会被释放 | 通常顺手就释放了 | **不会**——信号处理器一次都没跑 |
| 状态文件 | 通常会补写一个终态 | 停在最后一刻的值 |

最后两行是这条演练真正的价值所在：Windows 上 `child.kill('SIGKILL')`
（以及任何进程管理器发的"终止"）会**无条件终止**目标进程，
接收方的信号处理器根本不会被调用。因此"优雅停止后释放 lease"这条路径
在这个平台上有可能是**一次都没走过**的。

---

## 2. 夹具：`kill-drill-worker.mjs`

一个真实的 worker 进程，通过环境变量注入一个会在指定阶段**卡住**的执行引擎：

| 变量 | 作用 |
| --- | --- |
| `DRILL_BLOCK_IN` | 在哪个阶段卡住：`prepareWorkspace` / `buildContext` / `execute` / `none` |
| `DRILL_BLOCK_MS` | 卡多久（要足够长，让父进程来得及强杀） |
| `DRILL_MARKER` | 调用记录文件（每行一条 JSON），父进程在被杀之后读它 |

它调用的是**产品的** `runWorkerProcess({ executor })`，因此演练覆盖真实的
worker 主循环、心跳、失败上报与状态文件写入——只有"执行引擎"是假的。

`execute` 阶段的第一件事就是写一条 `external-write` 记录再卡住。
那条记录是"外部写可能已经发生"的**唯一证据**，恢复扫描必须据此拒绝自动重试。
父进程在被杀之后数它的行数——这是"不重复执行已确认的外部写操作"唯一可数的判据。

启动这个夹具的环境里**不能**设 `LEGION_WORKER_HEARTBEAT_MS`（那个变量并不存在）。
真实的心跳间隔是 10 秒（`WORKER_DEFAULTS.heartbeatIntervalMs`），
而演练在几秒内就完成强杀——因此被杀时 lease 仍然有效。这一点是被**显式验证**的（见 §3）。

---

## 3. 三条判据，对应完成标准的三个分句

### ① 不丢任务（`before`：在外部写边界之前被杀）

worker 卡在 `prepareWorkspace` 时被杀。此时：

- Attempt 停在 `PreparingWorkspace`、`finished_at_ms` 为 null。
  这正是"先落库意图再做副作用"（§6.4）在崩溃后的样子：
  进程没能走到 `execute`，因此外部世界没有任何改变。
- **回收必须由租约驱动**：因此先调一次 `recover` 并要求它**一无所获**
  （`recovered` 里没有这条任务）。抢占一个可能还活着的持有者，
  正是"同一任务被执行两次"的来源。
- 把"租约过期"这个前提摆好后（直接改库，见 §4），回收给出
  `retry-new-attempt` + `attemptsUsed: 1`，并新建第二条 Attempt。
- 另一个 worker 接手并执行完 → 第二条 Attempt 进入 `Validating`，
  marker 里 `external-write` **恰好一次**（第一条死在 `prepareWorkspace`，没走到 `execute`）。

### ② 不伪装成功（两个用例都验）

- 被杀那一刻 Attempt **不是** `Completed`，且 `finished_at_ms` 仍为 null。
- 状态文件必须判为**不新鲜**（`isStatusFresh` → `fresh: false`）：
  强杀之后文件停在最后一刻写的那个值，"文件存在"与"worker 还活着"是两件事。
  把两者混为一谈，外部就会把一个已经死掉的 worker 报成在跑，而队列永远不会有人认领。

### ③ 不重复执行已确认的外部写操作（`after`：在外部写边界之后被杀）

worker 卡在 `execute`（且已写过一次 marker）时被杀。此时 Attempt 停在 `Running`。

- 回收必须给出 `mark-unknown-outcome`，Attempt 进 `UnknownOutcome`，
  **不新建 Attempt**。
- 它出现在等人工清单（`/api/runtime/held`）里且 `isLatest: true`——
  否则"不静默重跑"会变成"静默消失"。
- **再起两个 worker 跑几秒**：队列里只剩这一条挂起任务，若回收判错它们会立刻领走并重跑。
  marker 里 `external-write` 的记录数必须**自始至终恰好一次**。
- 最后模拟人工对账：`external-effect-happened` → `Validating` +
  `externalEffect: 'confirmed'`，**仍然不得新建 Attempt**——那正是"绝不重跑"。

---

## 4. 两处让演练是真的演练、而不是碰巧通过的细节

### ① 先证明回收不会被"看到状态就动手"触发

在两个用例里，`recover` 都调了两次：**租约还有效时一次**（必须一无所获），
**过期后一次**（必须做出判定）。少了第一次，这个演练对"抢占活着的持有者"
这一类缺陷是完全瞎的——而被抢的执行会真的被两个 worker 各跑一遍。

### ② "租约过期"是**直接摆好**的前提，不是等出来的

默认租期 120s。等它自然过期会让这个文件跑两分钟以上，而演练要验的是
"租约已过期时回收判得对不对"，不是"120 秒到底有多长"（TTL 语义由 `run-store` 覆盖）。

因此 `expireLease(taskId)` 直接把 `lease_expires_at_ms` 改到过去。
**这是一个测试替身**，代码注释里写明了它的性质，以免下一个人以为回收
是"不需要租约状态就能工作"的。

---

## 5. 这条用例抓到的第一件事：`Validating` ≠ `Completed`

最初我把"接手后跑完"的判据写成 `Completed`，它超时失败了。查下来是：

```
ROWS: [{ id: 'att:d1:1', state: 'Validating', detail: 'drill-ok:att:d1:1' }]
```

执行成功落到 `Validating`——机器验收（PRT-307）是执行成功之后的一道**独立关卡**，
本批次未交付，因此没有东西会把它推到 `Completed`。

这里有一个真实的诱惑：**为了让用例变绿，把"执行完"直接写成"已完成"**。
那正是完成标准里"不伪装成功"要禁的事。现在断言 `Validating`，
并在注释里写明为什么——`Validating` 是诚实的落点：
执行确实成功了，但它还没有通过验收。

### 同时验证这条用例本身会红

把回收的「已越过外部写边界」判错（说 `Running` 不算越过，只给 `['HandingOff']`），
用例③立刻失败：

```
AssertionError: actual: 'retry-new-attempt', expected: 'mark-unknown-outcome'
```

即它会因为"外部写要变成两次"而红。**一个无论实现对不对都通过的演练没有价值**，
强杀演练尤其容易被写成那样（时序不对时它碰巧不触发竞争，于是永远绿）。

---

## 6. 顺带修正的一处断言错误

用例①最初断言"历史 Attempt 不得被改写"→ `PreparingWorkspace` 保持不变。
实际回收后它是 `RetryableFailure`。

**实现是对的，我的断言错了**：一条租约过期、停在 `PreparingWorkspace` 的 Attempt
如果原样留着，下一次恢复扫描会**再**把它当成在飞的执行处理一遍——
于是每扫一次就多一次回收，每一次都可能新建 Attempt。

「不可覆盖」说的是这条记录不会被删掉、不会被改写成另一次尝试，
**不是**说它的状态不再推进。现在断言 `id`/`attempt_no` 不变、
状态被结算为 `RetryableFailure`、且**再扫一次不会多出 Attempt**（幂等）。

---

## 7. 未交付

- **DSH 侧被强杀**：完成标准写的是"强制终止 worker **或 DSH**"。
  本批只做了 worker 侧。DSH 是 host 进程（由 Launcher 拉起），
  它的强杀语义与"宿主重启后任务如何恢复"属于 PRT-712/713 的范畴，
  且需要真实的 DSH 分发形态（PRT-011 已裁决路线 C，但落盘未做）。
- **执行中途被杀的 lease 自然过期路径**：本批用测试替身把"租约已过期"摆好，
  没有真的等满 120s（也没有覆盖率上的损失：TTL 的推进由 `run-store` 与
  `run-concurrency` 的用例覆盖）。
- **强杀发生在 HTTP 请求中途**：例如 worker 正在 `POST /api/runtime/transition`
  时被杀。服务端可能已经提交、也可能没有——这是"客户端不知道结果"的经典窗口，
  数据面上由 epoch 拒写与幂等键兜住，但没有专门的演练。
- **`Validating → Completed` 的推进**：机器验收未交付（PRT-307），
  因此成功执行的任务会停在 `Validating`。这是**已知且如实**的状态，
  不是缺陷，但意味着"跑完"目前并不等于"已验收"。

---

## 8. 复跑方式

```bash
node --test team-hub/run-kill-drill.test.mjs    # 2 例，约 30 秒（含真进程启停）
node scripts/ci/run-ci.mjs --only test          # 全套（设 DSH_CHECKOUT 时 65 套件 / 1803 用例）
```
