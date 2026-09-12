# 装配链端到端验证，以及它抓到的三个真 bug

> 交付物：`runtime/dsh-composition/e2e-assembly.test.mjs`（**15 例**）、
> `orchestrator/worker/executor-binding.mjs`（栈式绑定 + 预算主体接线）、
> `runtime/adapters/dsh/usage.mjs`（用量读数不再把"不知道"记成"零"）、
> `runtime/adapters/dsh/adapter.test.mjs`（改掉一条把 bug 当规格的用例）
>
> 关联：PRT-213/215/253/257/510、spec §6.7 / §8「钱不能靠猜」

---

## 1. 为什么需要这一组

最近四批各自交付了一块，每块都有自己的套件、各自全绿：

| # | 交付物 | 自己的套件 |
| --- | --- | --- |
| ① | `runtime/dsh-composition/bootstrap.mjs` | `dsh-bootstrap`（20 例） |
| ② | `orchestrator/worker/executor-binding.mjs` | 混在 `executor` 里 |
| ③ | `orchestrator/worker/executor.mjs` | `executor`（26 例） |
| ④ | `orchestrator/worker/budget-gate.mjs` | `budget-gate`（23 例） |

而**没有任何一条用例把它们接起来跑过一次**。

> 「注册了、跑了、过了」≠「这条路被测过」。

接缝上的错**恰恰是每一块的套件都看不见的**：它们各自的假件补上了对方那一半——
`bootstrap` 的假宿主不需要 `startRun`，`executor` 的假件直接跳过 `bootstrap`。

这一组就是那条缝：只用最外层的假件（DSH 引擎 + hub 的 HTTP），
中间四块全用**真实现**，从"组合树观察结果"一路走到"账本已结算"。

## 2. 抓到的三个真 bug

### 2.1 PRT-510 的闸门通过生产路径永远建不起来

`productionExecutorProvider` 只从 binding 里取 `{host, selfCheck, canRead}`：

```js
const { host, selfCheck, canRead, ...rest } = binding
return createProductionExecutor({ host, selfCheck, canRead, post, get, ...rest })
```

**`budgetActor` 没有来源。** 而 PRT-510 的套件把它直接传给
`createProductionExecutor`——**生产路径不经过那一步**。

于是：闸门代码是对的、套件是全绿的、而账本**一个请求都收不到**。

现由 `LEGION_BUDGET_ACTOR` 环境变量（显式入参优先）接到生产路径上，
并登记进 `orchestrator/config-schema.mjs` 的 env 读取点。

### 2.2 `unbind` 会**复活**一份已经被自己主人注销掉的绑定

前两版都是"单槽 + `previous` 链"：

```js
binding = mine
return () => { if (binding === mine) binding = previous }
```

装配 A、再装配 B，然后**先注销 A**：`binding` 是 B、不等于 A 的 `mine`，
所以什么都不做——看起来对。**但 A 的注销没留下任何痕迹。**
等 B 被注销时它把 `binding` 写回 `previous`，也就是 A——**A 复活了**。

后果：`productionExecutorProvider()` 返回 `ok: true` 与 A 的宿主端口，
而 A 的主人已经拆掉了它那一侧。

> 这正是「拒绝、却仍然递给 worker 一个能用的引擎」那一类里最坏的一种——
> **没有东西会报错**。

现改为**栈**：注销 = 把自己从活跃集合里删掉。与顺序无关、幂等、
且不会复活任何东西。

### 2.3 用量把「不知道」记成了「零」——**两层都在犯**

这条最值得记，因为它是被一条 e2e 用例**一步一步逼出来**的。同一处输入，
测试先后报出 `5`、`0`，最后才落到真问题：

**第一层：`pick` 接受负数。**

```js
if (typeof v === 'number' && Number.isFinite(v)) return v      // ← -3 通过
```

于是 `pick({ tokensOut: -3 })` 返回 `-3`，调用方认为"至少拿到了一个字段"、
不再返回 `null`——**一个全是垃圾的 usage 被当成了有效读数**。
负数 token 不是"少"，是一个不可能的值，只可能来自解析错误。

**第二层：缺的那一侧被补成 0。**

```js
const inTok = tokensIn ?? 0
const outTok = tokensOut ?? 0
```

看起来无害，实际是在**替引擎宣布一个它没报告的读数**：

- 引擎报了输入、没报输出 → 记成 `tokensOut: 0`
- 而 `0` 是一个**测量结论**（"一个输出 token 都没花"），不是"不知道"

这个 0 会一路流进预算账本与审计；事后对账时它是一个
**看起来专业的错误数字**，而没有任何东西提示它是编出来的。

> 缺一个数就写 0，等于把一个未知数记成了一个已知的零。

**而 `checkBudget` 又把它变成低估：**

```js
const used = (usage.tokensIn ?? 0) + (usage.tokensOut ?? 0)   // ← 低估
```

一次实际超支的运行会被判成"未超"。

> **低估比不知道更危险，因为它是错的却看起来是对的。**

现新增 `token-unknown` 违规：**无法判定时返回一个说明"无法判定"的违规，
而不是 `null`**——`null` 的含义是"确认没超"。
这与相邻那条费用判据（`cost-unknown`）本来是同一条口径，只是 token 这一侧漏了。

#### 这三处之前都"有测试"

`adapter.test.mjs` 里那条的标题就叫 **「双取缺失侧补 0」**：

```js
assert.equal(collectUsage({ usage: { promptTokens: 5 } }).tokensOut, 0)   // ← 断言了 bug
```

> 一条把 bug 断言成规格的用例，与一份错误的规格完全同形。

## 3. 顺带补掉的两个测试缺口

### 3.1 "预留早于执行"根本没被验到

第一版的 e2e 断言 `hub.order()` 是 `['get-snapshot', 'reserve', 'settle']`——
它能证明"预留早于结算"，**证明不了"预留早于执行"**：
引擎那次调用与 hub 的调用记在**两个地方**。

> 一条时间线分成两条，就等于没有时间线。

现统一成一条并断言
`get-snapshot → reserve → engine-run → settle`。

### 3.2 自检那条分支没有用例走到

原来只有"组合树没观察"那条拒绝用例，而它在自检**之前**就返回了——
于是 `autoExecutionForbidden === true` 那条分支**这条 e2e 走不到**。
补了 sandbox `partial` 的用例之后才走得到。

## 4. 变红验证：10 处，10 处红

覆盖：生产路径不读预算主体、显式入参不覆盖环境变量、提示词被重新拼装、
结算不带真实用量、预留晚于执行、装配没过仍注册、没接闸门不留痕、
结算失败被吞、用量缺侧被补 0、注销抹掉别人的注册。

### 四条第一轮没咬住，四种不同的原因

| 探针 | 为什么没红 | 教训 |
| --- | --- | --- |
| ⑭① | 缩进写错（实际 4 空格，探针写了 6 空格） | 补丁**没应用**与"实现是对的"同形——所以脚本必须断言 `applied` |
| ⑭③ | 打在 `requestPrompt` 上，而它**不是导出的**（在工厂函数里面） | 锚点必须核对真实源码 |
| ⑭⑤ | 改成 `await Promise.resolve().then(...)` 仍是 await，**顺序没变** | 探针必须真的改变要验的性质，而不是它的写法 |
| ⑭⑨ | 改的是 `n()`，而 `usage` **整个缺失**时 `tokensOf` 提前返回、`n()` 未被调用 | *一条没人走过的分支与一条不存在的分支，在"用例全绿"这个读数上完全一样* |
| ⑭⑥ | 打的 `autoExecutionForbidden` 分支**当时没有任何用例走到** | 同上；修法是补用例而不是改探针 |
| ⑭⑩ | 单槽实现与栈实现在"顺序注销"下**行为相同** | 探针必须构造**乱序**才区分得开 |

⑭⑨ 的修法特别值得记：不是改探针，而是**让用例真的走到那一层**——
加一条"一侧合法、另一侧不可信"的 usage。而第一版加的输入
（`{ inputTokens: 5 }`）被**适配器归一化**掉了，于是报的是 `5`：

> 一条「实现比测试想得更聪明」的红，与「实现是错的」完全同形。

### 还有一条：夹具把要验的状态清掉了

`assemble()` 里的 `resetDshRuntimeBinding()` 是夹具便利，
而它在"连续装配两次"那条用例里恰好把要验的状态抹掉了。
修法是给夹具一个显式开关：

> 夹具的便利不能改写被测的行为。

## 5. 未交付（与上一批同一条边界）

- **真正的调用点仍然不存在**：往运行中的 profile 写入补丁层那一步，
  属 PRT-257「一键启动」。
- **组合树观察结果仍没有生产来源**，所以真实部署里
  `composition-patch-layer` 自检只能拿到空观察 → 判未生效 → 禁止执行。
  那是**安全的默认方向**，但意味着今天真装上也会被自己的自检拦住。
- **`LEGION_BUDGET_ACTOR` 没有生产注入点**：Launcher 还没有往 worker 的
  环境里写它，所以真实部署里闸门仍然是 `not-gated`。
  这一批交付的是"**取消注释就能用**"，而不是"已经在用"。
- CI 的 `orchestrator` 套件在某一轮里被判超时（300s）后杀掉，
  而它**单独跑 65/65、16 秒**。`run-ci.mjs:84` 已经记录过同一处失败模式。
  见本轮报告里的复现结论。
