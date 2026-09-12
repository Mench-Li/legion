# PRT-302 / PRT-303 / PRT-313：运行实体落库（租约、Attempt、权威时间与 epoch 拒写）

**对应 spec**：§6.4 运行状态机、§6.11 目录职责、§12 的 PRT-302 / PRT-303 / PRT-313
**阶段 3 完成标准**（spec 第 885 行）：强制终止 worker 或 DSH 后，重启不会丢任务、伪装成功或重复执行已确认的外部写操作。
**交付物**：`team-hub/run-store.mjs`、`team-hub/server.mjs`（运行面路由）、`orchestrator/worker/{main,run}.mjs`（接线）、三套用例
**套件**：`run-plane`（63 例）= `team-hub/run-store.test.mjs`(34) + `run-routes.test.mjs`(19) + `run-plane-e2e.test.mjs`(10)

---

## 1. 为什么这三件事必须一起做

PRT-301 交付了状态机与 worker 骨架，但状态只在内存里：进程一停，"这次执行到哪一步"就没了。
于是三条判据都无法成立——

| 判据 | 缺了什么就做不到 |
| --- | --- |
| 不丢任务 | 没有租约，崩溃的 worker 占着任务；没有 Attempt 表，没人知道任务被谁领走过 |
| 不伪装成功 | 没有落库，"执行完成"只存在于 worker 的计数器里 |
| 不重复执行 | 没有 `leaseEpoch`，迟到的 worker 能改写别人的结果；没有 UnknownOutcome，外部写结果不可确认时会被自动重跑 |

`run_attempts` + `lease_epoch` + 服务端时钟是同一件事的三个侧面，因此一并落库。

---

## 2. 数据模型

### `run_attempts`（一次执行尝试）

```
id, task_id, scope, attempt_no, state, worker_id,
lease_epoch, lease_expires_at_ms, return_to,
outcome, failure_code, detail,
created_at_ms, updated_at_ms, finished_at_ms
UNIQUE(task_id, attempt_no)
```

### `run_attempt_events`（只追加的历史）

```
seq AUTOINCREMENT, attempt_id, task_id, at_ms,
from_state, to_state, actor, lease_epoch, reason, requires_persist
```

**这张表刻意没有 `updated_at` 列。** 「历史不可覆盖」如果只靠代码约定，一次手滑的 `UPDATE` 就能改掉它；
不给它可改的列，是让这件事在结构上不可能发生——有一条用例专门断言这个列不存在。

---

## 3. 服务端时钟是唯一权威（PRT-313）

`claim` / `heartbeat` 接受请求体里的 `nowMs`，但**只把它当作"调用方说了什么"记录下来**：
到期时间一律由本进程的 `clock()` 算出，并且把被忽略的字段名回显在 `ignoredClientFields` 里。

租期由持有者自己申报是自相矛盾的：一个时钟走偏（或时钟被改）的 worker 可以给自己续一个永不过期的租约，
而外部只看到"任务一直在跑"。回显字段是为了让调用方能看出"我发的 `nowMs` 没被采纳"，
而不是以为自己续租成功了。

`lease_epoch` 从 1 开始（0 表示"还没被领过"），并且在**每一次所有权变化**时推进：

- `claim`：新持有者 → epoch+1
- `release`：原持有者不再是持有者 → epoch+1
- 回收 / 重试新建尝试：原尝试被终结 → epoch+1

### 为什么释放也要推进 epoch

`release` 之后那个 worker 可能还有一个正在跑的 executor。不推进 epoch 的话，它结束后提交的结果会
**通过** epoch 校验，然后被状态机以 `RetryableFailure → Validating 不是合法迁移` 拒绝。
它确实没写进去，但它收到的信号是错的：它会以为"我状态写错了"，而不是"我已经不是持有者了，我该停手"。
让它继续重试是安全的，让它继续**执行**（工具调用）就不安全了。
推进 epoch 之后，同样的写入会得到 `LEASE_EPOCH_STALE` + 真实 epoch，也就是它真正需要的那个信号。

### 过期写入的拒绝必须带上真实 epoch

```
409 { code: 'LEASE_EPOCH_STALE', currentEpoch: 2, currentWorkerId: 'w-new' }
```

只说"拒绝"是不够的：worker 无法区分"我被接管了（停手）"与"我记错了 epoch（重试）"。
`LEASE_EXPIRED`（还是持有者但超时）与 `LEASE_NOT_HELD`（epoch 对但 worker 不是持有者）同样是独立的码，
因为三者的下一步动作不同。

---

## 4. 领取的原子性

```sql
UPDATE run_attempts SET state='Leased', worker_id=?, lease_epoch=?, lease_expires_at_ms=?
WHERE id=? AND state='Queued' AND lease_epoch=?
```

`changes !== 1` 即判负（`{ claimed: null, reason: 'lost-race' }`），不抛错——
"抢输了"在一次正常的多 worker 竞争里是预期结果，不是异常。
`reason: 'queue-empty'` 与 `lost-race` 分开，是因为前者该退避等待，后者该立刻再试一次。

候选任务来自两条路径，**共用同一组任务级条件**（`t.status='todo'` 且 `hold=0`）：

1. 已有 `Queued` 尝试的任务（重试/回收排出来的新尝试）；
2. 看板上处于 `todo` 且没有活跃尝试的任务（第一次入队）。

第二条路径的条件一开始漏了第 1 条路径（只有 `a.state='Queued'`）。后果是：
一条被将军 `hold` 住、或者被人手动标成 done 的任务，只要还留着一条 Queued 尝试，
就会照常被 worker 领走执行——「将军拦截优先于队列」这句话静默失效。
这个洞是端到端用例暴露出来的（"我插入的任务没被领走"），现有用例已把它钉住。

---

## 5. 不可覆盖的 Attempt 历史（PRT-303）

重试**不修改**已有尝试，而是新建一次：

```
RetryableFailure → Queued   (状态机声明 createsNewAttempt: true)
  ├─ 终结当前尝试为 RetryableFailure（保留 failure_code / detail）
  ├─ 推进它的 lease_epoch（见上：让旧持有者的写入被具名拒绝）
  └─ 新建 attempt_no+1，状态 Queued，写一条新事件
```

三件事在**同一个事务**里。少任何一件都不报错，这才是危险的地方：

| 漏掉 | 不报错的后果 |
| --- | --- |
| 终结当前尝试 | 同一任务两条活跃尝试，会被两个 worker 同时领走 |
| 新建尝试 | 任务卡死，没有任何 Queued 尝试可领 |
| 推进 epoch | 旧持有者收到误导性的"迁移非法"，而非"你已被接管" |

`historyOf(taskId)` 返回全部尝试（含已终结的），`eventsOf(attemptId)` 返回只追加的事件流。
"试过几次、每次错在哪"因此是可查的，而不是只能翻日志。

---

## 6. 回收与恢复（PRT-310 的仓储侧）

`recoverExpired({ externalEffectPossible })` 扫描过期租约，按**调用方给出的判定**分两支：

| 分支 | 条件 | 动作 |
| --- | --- | --- |
| 安全 | 未越过外部写边界 | 终结当前尝试 + 排队新尝试（重试） |
| 危险 | 可能已产生外部副作用 | 标记 `UnknownOutcome`，**绝不**自动重试 |

`externalEffectPossible` 缺失时**抛错**而不是取默认值。默认值无论取哪一边都是错的：
取 `false` 会在已经付过费的任务上重复执行，取 `true` 会让本可自动恢复的任务全部挂起等人工。
`/api/runtime/recover` 因此要求请求显式给出 `externalEffectPossibleStates`（空数组同样拒绝——
它等价于"全都安全重试"）。被拒时什么都不改，用例断言了这一点。

---

## 7. 运行面 HTTP 契约（7 条路由）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/runtime/claim` | 认领；空队列返回 `{claimed:null, reason:'queue-empty'}`（200，不是 404） |
| POST | `/api/runtime/heartbeat` | 续租 |
| POST | `/api/runtime/transition` | 阶段迁移 / 提交结果 |
| POST | `/api/runtime/release` | 优雅停止时释放 |
| POST | `/api/runtime/recover` | 过期回收（必须给出外部写边界） |
| GET | `/api/runtime/status` | 13 态计数 + 过期租约数 |
| GET | `/api/runtime/attempt` | 单次尝试 + 该任务全部历史 + 事件流（诊断） |

`/api/config` 增加 `runPlane: true` 能力发现位：一个升级到一半的部署（hub 还是旧的）会让 worker 收到 404，
而 404 的文案无法区分"路由不存在"与"路径拼错"。

### 不使用 `handleWrite`

既有看板写路径要求 `by`（成员）。运行面的主体是 **worker**，不是成员。
把 worker 塞进 `by` 会让审计里出现一个假的成员名，也会让"谁的这次写入"在两张表里各有一套说法。

### 具名错误码一路传到响应体

路由把仓储异常的 `code` / `stateMachineCode` / `currentEpoch` 原样放进响应体。
这不是冗余：worker 靠 `LEASE_EPOCH_STALE` 决定**停手**，靠 `LEASE_EXPIRED` 决定**加快**，
两者被压成一个笼统的 409 之后，worker 只能靠文案猜，而文案会变。

`stateMachineCode` 与仓储 `code` 分开（`TRANSITION_REJECTED` + `ILLEGAL_TRANSITION`）：
前者是"哪一类拒绝"，后者是"具体哪条规则"，两个字段各有各的读者。
`UNKNOWN_OUTCOME`（请求给了不认识的结果名义 → 400）与 `UNKNOWN_ATTEMPT_STATE`
（库里的状态未登记 → 500，数据/版本问题）也是两件事，合成一个码会让运维无法区分
"有人在乱传参数"与"库被改坏了"。

---

## 8. worker 接线：先落库意图，再做副作用

`tick()` 的执行段按 §6.4 走四个阶段，每步都是"先写状态、再做那件事"：

```
transition(PreparingWorkspace) → prepareWorkspace(lease)
transition(BuildingContext)    → buildContext(lease)
transition(Running)            → execute(lease)
transition(outcome)            → 提交结果（completed → Validating）
```

顺序反过来的话，进程在做事的中途被杀会留下一个**看起来没开始**的 Attempt，
恢复扫描会认为它什么都没做、可以安全重跑——而它可能已经改过外部系统。
顺序正确时，中途被杀留下的是 `PreparingWorkspace`/`BuildingContext`，
恢复扫描据此知道"它已经越过某条边界"。

### 三个阶段都是必需的

`Leased → Validating` 是非法迁移，因此一个只实现了 `execute` 的执行引擎**产生不了一次合法的 Attempt**：
它认领之后必然失败，把重试额度烧光，最终表现为"任务都在跑但全都失败"。

当前没有工作区隔离（PRT-306）也没有上下文快照（PRT-401）。
这里**不假装它有**，而是要求调用方显式选择降级模式：`inPlaceStages()` 铺开两个
明确记录自己什么都没做的阶段（`kind: 'in-place'` / `'minimal'`，note 写明缺哪个 PRT），
这些 `kind` 会写进 Attempt 的证据里。于是降级是一个具名的调用点，
而不是一个埋在默认值里的静默行为——日后替换它时也找得到。

缺阶段时 worker 进入 `no-stages` 状态并且**一次 claim 都不发**，理由与 `no-executor` 相同。

### 阶段失败要如实上报

阶段抛出的异常会被打上阶段名，再按映射表转成已登记的失败码
（`prepareWorkspace → workspace-prepare-failed`）。不打阶段名的话，
工作区建不起来会被记成 `stage:'execute'` → `runtime-unavailable`（可重试），
而真实原因是另一个——错误分类直接决定要不要重试。

失败**必须上报**，不能让 Attempt 停在 `PreparingWorkspace` 等租期过期：
停在那儿的话，恢复扫描只能按"有没有可能已产生外部副作用"去猜，
而我们知道得更多——我们知道它失败在哪一步、有没有越过 `Running`。
上报本身失败（例如 epoch 已前进，即已被接管）时不会抛错，而是记进日志与 `lastError.reportFailed`。

### 心跳遇到 STALE 就停手

心跳失败会记 `leaseMayBeLost`（外部可观测，不只在日志里）。
`LEASE_EPOCH_STALE` 的含义是"你已经被接管了"，不是"网络抖了一下"，
因此心跳循环在这一条上直接退出，不再徒劳重试。

---

## 9. 本次自审改掉的四处（都不是会报错的缺陷）

| 缺陷 | 为什么危险 |
| --- | --- |
| `Object.assign(this, extra)` 让 `extra.code` 静默覆盖错误码 | 仓储错误码变成"有时候是状态机码"，于是谁都不能依赖它。改成 `code` 与 `stateMachineCode` 两个字段 |
| `release` 只终结不排队 | 释放后没有任何 Queued 尝试，任务要等租期自然过期才被恢复扫描捡起来——而释放的全部意义就是**不等**租期过期。若释放后还要等，`SIGTERM` 时释放与不释放没有区别 |
| 领取的 Queued 分支不检查 `hold`/`status` | 「将军拦截优先于队列」静默失效 |
| `openNextAttempt` 直接 `UPDATE` 终结状态 | 终结状态由调用方直接写进库，绕过了状态机的合法性校验；回收是无人值守路径，一个非法终结状态会安静地留在库里直到有人看看板。改为经 `transitionPlan` 验证 |

---

## 10. 测试策略：三层，各查一类只有那层才看得见的缺陷

| 层 | 文件 | 只有这一层看得见的东西 |
| --- | --- | --- |
| 仓储 | `run-store.test.mjs`(34) | 并发领取只有一个赢家（两个**独立连接**）、过期 epoch 拒写、回收两条分支、历史不可覆盖、事务回滚。真实 `node:sqlite` + 注入时钟，租期到期是确定性跨过去的，不 sleep |
| HTTP | `run-routes.test.mjs`(19) | 具名错误码有没有传到响应体、到期时间是不是服务端算的、`recover` 有没有强制要求外部写边界、诊断端点的形状 |
| 端到端 | `run-plane-e2e.test.mjs`(10) | 真 team-hub + 真 worker 客户端。**前两层各自全绿也可能合起来错** |

端到端这一层抓到的问题是前两层结构上不可能看见的：worker 的 hub 客户端把 `{ok, claimed}` 信封
当成 claim 对象直接用，于是 `claimed.taskId === undefined`——而 `undefined` 恰好就是 worker
判断"没领到任务"的条件。结果：**任务被服务端领走（状态 Leased、租约在跑），worker 以为队列是空的**。
仓储单测不经过 HTTP 信封，worker 单测的假 hub 返回的已经是解包后的形状，两边都自洽。

### 两个测试脚手架问题（值得记下来）

1. **全局 `fetch` 的连接池让 `node --test` 不退出。** undici 的 keep-alive 连接在
   `server.closeAllConnections()` 之后仍挂在事件循环上，实测卡死 90s+。
   产品代码不改（生产 worker 是长驻进程，连接池正是它想要的），
   测试这一侧改用 `agent: false` 的无池 HTTP 客户端。
2. **一个失败的断言会把"失败"伪装成"卡住"。** 断言失败后 worker 没被停止，
   它的心跳循环每 10s 续一次、永远不停，于是进程不退出、
   `ℹ fail N` 那一行永远不打印。调试时这正是最难查的一步。
   现在所有起 worker 的用例都走 `withWorker()`（`finally` 里 `stop()`），
   心跳测试也用事件同步而不是 `sleep` 轮询。

---

## 11. 未交付

- **PRT-309 的 Dead Letter 落库与人工处置入口**：退避与失败分类已落地，
  但"重试预算耗尽 → DeadLetter → 人工放行"这条链路只有状态机层面的边，没有落库与 UI/API 入口。
- **PRT-311 的幂等键**：`UnknownOutcome` 的出边与 epoch 拒写已经封住了"自动重跑"这条路，
  但"外部写操作本身如何做到幂等"（幂等键、外部系统侧去重）未做。
- **PRT-312 的真实 `SIGKILL` 整链路演练**：Windows 上"终止"不走信号处理器，
  因此"进程被杀 → 租约过期 → 回收 → 另一 worker 接手"目前是分两段验证的（回收用注入时钟，进程用真实进程），
  没有一次端到端的强杀演练。
- **PRT-314 的多进程压测**：并发用例用的是同一进程内的两条连接；
  真正的多进程锁等待预算没有实测记录。
- **PRT-304~308**：`plugins/src/index.ts` 的扫描/认领/岗位/工作区/验收等提取工作未开始
  （属 PRT-315/316 同批拆分）。

---

## 12. 复跑方式

```bash
node scripts/ci/run-ci.mjs --only test      # 全套（含 run-plane 63 例）
node --test team-hub/run-store.test.mjs team-hub/run-routes.test.mjs team-hub/run-plane-e2e.test.mjs
node scripts/config/scan.mjs --check        # env 声明门禁（237 个疑似字面量）
node scripts/ci/dsh-boundary.mjs --check    # DSH 边界棘轮（3 文件 / 26 处，未增长）
node scripts/prt/topology-inventory.mjs --diff   # 拓扑清单无漂移
node scripts/prt/baseline-snapshot.mjs --record  # 新增 7 条路由后刷新平台契约基线
```
