# PRT-510 运行侧：执行路径上的预算闸门

> spec §8「单次运行预算原子预留、结算、取消和 Unknown Outcome 锁定」
>
> 交付物：`orchestrator/worker/budget-gate.mjs`、
> `orchestrator/worker/budget-gate.test.mjs`（23 例）、`executor.mjs` 的接线
>
> 说明：`team-hub/budget-ledger.mjs`（账本本体，PRT-510/511 的上一批）**已经交付**
> 并且有 20+ 例套件。本文记录的是**运行侧**这一半。

---

## 1. 与 PRT-253 完全同一个形状的缺口

账本侧已经完整：`reserve`（`BEGIN IMMEDIATE` + `attempt_id` 主键）、
`observe`、`settle`、`resolveLocked`，状态机 `RESERVATION_TRANSITIONS` 全定义，
HTTP 路由齐全（`/api/runtime/run-budget/reserve|observe|settle|resolve`）。

而**执行路径上一次都没有调用过它**。

> 一个功能没有入口，与一个功能不存在，在用户看来完全一样。

这一批给出的就是那个入口。

## 2. 为什么事后的 `checkBudget` 不够

`runtime/adapters/dsh/usage.mjs` 的 `checkBudget` 在运行结束之后拿实际 usage
判一次超支，超了就报 `BUDGET_EXCEEDED`。它是对的，也够用——

**但它只能回答一个问题**：

| 问题 | 何时能回答 |
| --- | --- |
| 这次花超了吗 | 事后 |
| **这笔钱现在还在不在** | **只能事前** |

差别在并发上。两个 Attempt 各有 $5 上限，账户里一共 $5：

```
事后判定：A 跑完（花了 $5，没超自己的上限）→ B 跑完（花了 $5，没超自己的上限）
          合计 $10。账本对此无话可说——两次都"合规"。
预留：    A 预留 $5（余额 $5 → $0）→ B 预留被拒 → B 根本没开始跑
```

> 「花了多少」可以在事后回答；「还能不能花」只能在事前回答。

## 3. 三件事必须成对

预留与结算是一对，拆开两边都错：

| 只做一半 | 表现 |
| --- | --- |
| 只预留不结算 | 余额被永久占住 → "能跑，但所有 worker 都说没钱" |
| 只结算不预留 | 账本里出现一笔没有预留的支出 → 账对不上，且并发拦不住 |

所以本模块把它们绑在同一个 `runBudgeted()` 里。**失败的方向永远是"钱还占着"**：

- **预留失败 → 不执行。** 这是闸门，不是建议。
- **结算失败 → 预留继续占着**，返回 `{ settled: false, code, message }`
  并留一条诊断。**不抛**——抛了调用方就丢掉 `outcome`，
  于是不知道该不该重试；而钱那边其实只是"还占着"，方向是安全的。
- **结果未知 → `locked`**，**不写任何金额**。

## 4. 结算按**终态**映射，不按"execute 返回了"

```js
completed / failed / cancelled / timed-out  → settle({ outcome: 'known' })
outcome_unknown                             → settle({ outcome: 'unknown' })  → locked
```

`outcome_unknown` 走 `locked` 而不是当作 0 结算，理由账本模块头已经写过：
**写入任何数字都等于宣称"算清了"**，而那时恰恰不知道算没算清。

### 一个刻意的不对称

```js
export function settlementOutcomeFor(runOutcome) {
  if (runOutcome === 'outcome_unknown') return 'unknown'
  return 'known'      // ← 其余**一律**已知，包括拼错的字符串
}
```

看起来"未知的字符串应该保守地当成 unknown"更稳妥。**不是。**
把未知字符串映射成 `unknown` 意味着：一处拼写错误（`outcome_unkown`）
会把余额**永久锁住**，而锁住的表现是"这个 worker 之后都说没钱"——
排查方向会被带到配置上，而真因是一个字符串写错了。

所以未知一律按"已知"结算：钱该释放就释放，而这次运行的 `outcome`
本身仍然是可疑的、会照常上报（那条线上有它自己的断言）。

## 5. 抛错路径也要结算

`adapter.execute` 抛出时，`executor.execute` 会：

1. 按 `outcome_unknown` **先结算**（半途抛出时用量不可知，
   把预留悄悄放掉等于宣称"这次没花钱"）；
2. 然后**原样重抛**原始异常（不让结算的成败掩盖真因）。

这一条是本批**最值得记下来**的地方——见第 7 节。

## 6. 「没上限」与「没接闸门」都必须可见

`budgetState` 是三者之一：

| 值 | 含义 |
| --- | --- |
| `bounded` | 有上限，钱已被占住 |
| `unbounded` | **没有上限**——这次花费不受任何预留约束（留一条诊断） |
| `not-gated` | **压根没接闸门** |

前两者的区别在于风险，后两者的区别在于"这个部署到底接没接"。
三者若压成同一件事，**"没接预算"与"预算充足"就同形了**——
而它们一个是一次不受约束的支出，一个是被闸门保护着的运行。

`actor` **不给默认值**：账本要求"谁结算的必须留痕"，
而一个默认值会让"没人签名"与"某人签了名"在账本里长得一样。

`observe` 只**请求**取消（返回 `{ cancel: true, kind }`），不自己取消——
它不知道 Run 的生命周期，而"以为取消已经发出去了"是最坏的一种错觉。

## 7. 变红验证：16 处，16 处红

覆盖：预留先于执行的**顺序**、预留失败不执行、抛错也结算、
抛错按未知、结算失败不吞、`actor` 必给、`post` 必给、
未知 outcome 不锁死、usage 缺省不是 0、`observe` 失败不当超预算、
`requireBounded`、`unbounded` 上报，以及执行路径上的四处（不预留 / 不结算 /
没接闸门不留痕 / 抛错不结算）。

### 有一条第一轮没咬住，而且它暴露了一个真问题

探针 **⑪④**（把 `executor.execute` 里"抛错也结算"那个 catch 分支改掉）
**没有让任何用例变红**。

原因不是断言太弱，是**没有任何用例进得去那个分支**：

> 适配器**刻意**把引擎故障分类成终态事件（`run.failed` 等），不往外抛。

那是对的设计——一次引擎故障是一条**有名字的结论**，不是一个栈。
但它的副作用是：`executor.execute` 里那个 catch **用真适配器永远走不到**。

> 一条没人走过的分支，与一条不存在的分支，在"用例全绿"这个读数上完全一样。

修法**不是删掉分支**（它防的是"某个适配器实现真的抛了"），
而是用**已有的** `adapterFactory` 注入点把它走到——
那个注入点本来就是为这种事准备的。补上用例之后 16/16。

### 同一批还修掉一个测试夹具缺陷

`budget-gate.test.mjs` 的假宿主少了 `currentModelSelection`，于是适配器报
`MODEL_UNAVAILABLE`、**整次执行失败**——而两条断言只看 `budgetState` /
`reservation`、**都没看 `outcome`**，所以在全流程失败的情况下依然"通过"。

- 能力齐全 ≠ 选中了模型；
- 而"执行失败了"必须在用例里看得见。

补上 `currentModelSelection` 与 `assert.equal(r.outcome, 'completed')` 之后才是真的在验。

## 8. 未交付（如实记录）

- **这一环在真实部署里还没被激活。** 闸门接在 `createProductionExecutor` 上，
  而那个引擎今天仍返回 `EXECUTOR_HOST_PORT_REQUIRED`——因为 DSH 侧的端口绑定
  （`bindDshRuntime` 的调用者）还不存在，那是 PRT-257 的事。
  也就是说：**机制补齐到了执行路径上，但它要等到 PRT-257 落地才会真正开始拦人。**
- **门槛的取消只是记录。** `observe` 返回 `{ cancel: true }` 时，
  `executor` 把它记进 `cancelRequested`，**没有真的把取消发给引擎**。
  真正的取消需要适配器侧接上（`adapter.cancel(runId)`），本批没做。
- **预留金额来自 `lease`，而这个 lease 由谁填还没有生产来源。**
  测试里是手写的；真实部署里该由 hub 的任务定义给。
- **没有做"预留与 Run 生命周期绑定"的守护**：一个 worker 崩溃后，
  它的预留会一直占着直到超时/人工处置。账本有 `resolveLocked`，
  但没有自动的租期回收。
