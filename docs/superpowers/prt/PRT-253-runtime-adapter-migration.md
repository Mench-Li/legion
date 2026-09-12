# PRT-253：单员工黄金任务迁移到 RuntimeAdapter

> spec 阶段 2.5：「只迁移单员工、无自动交接的黄金任务到 RuntimeAdapter」
>
> 交付物：`orchestrator/worker/executor.mjs`、`orchestrator/worker/executor-binding.mjs`、
> `orchestrator/worker/executor.test.mjs`（26 例）、`runtime/adapters/dsh/index.mjs`
> 的提示词优先级修复、`orchestrator/worker/run.mjs` 的提供者接线、
> `product/orchestrator/worker.mjs` 的入口接线

---

## 1. 这一批要解决的问题

上下文装配（PRT-401~413）交付了一整套机器：来源归一、权限过滤、预算裁剪、
脱敏、冻结、哈希、持久化、回放。**每一件都有套件，每一件都全绿。**

而 `orchestrator/worker/run.mjs` 的这一行：

```js
executor = null,   // 「执行引擎由调用方给」
```

也就是说——**没有任何真实部署走过那条路**。

> 一个功能没有入口，与一个功能不存在，在用户看来完全一样。

这一批交出那个入口。

## 2. 接缝上发现的三件事

### 2.1 适配器**自己拼提示词**，冻结的正文没人看（最要紧的一件）

`runtime/adapters/dsh/index.mjs` 里原来是这样：

```js
function requestPrompt(request) {
  return [
    `任务：${request.taskId}`,
    `目标：${request.goalId}`,
    `员工：${request.employeeId}`,
    `验收：${request.expectedOutput.acceptance}`,
  ].join('\n')
}
```

它上面那段注释写着：**「真正的上下文装配属于 §6.5 Context Assembler（阶段 4）」**。
阶段 4 现在已经做完了——而这条线还停在那里。

后果是这样的：装配器把上下文冻结、算哈希、记审计、写进库；
`RunRequest` 里也确实带着 `prompt: finalText`；
**然后适配器拼了一份自己的文本发出去，那份冻结的正文从头到尾没有被读过。**

而这一次失效**在任何现有断言下都是隐形的**：

- 装配器的 22 例端到端验的是"快照里存了什么"——存对了；
- 适配器的 85 例验的是"请求发出了、终态映射对了"——发对了；
- 库里那份快照看起来完全正常。

> 一份被冻结、被哈希、被审计、然后**没有被用上**的上下文，
> 与一份从未被冻结的上下文，在"模型看到了什么"这个问题上是同一个答案。

**修法**：`request.prompt` 非空时**原样**返回，不包任何标签。
不包标签这一点是刻意的——包了就改了 `finalText`，而快照里存的是没包的那一份，
两者又对不上了。

回落到阶段 2 的最小包装时**逐字不变**，因为生产对拍测试（`parity.mjs`）
以它为基准；那条路径现在是"没有装配器的调用方"在用，不是生产路径，
注释也改成了这么说。

**这一条是"我是怎么发现的"值得记下来的地方**：它不是被审出来的，
是被一条**写得足够强的断言**逼出来的。第一版用例断言的是

```js
assert.ok(JSON.stringify(sent).includes(FROZEN_TEXT), '引擎收到的请求里必须包含冻结的正文')
```

——它过去了。因为 `prompt` 字段确实在请求对象里。**加一个"含不含"的断言
对一个"用不用"的缺陷完全不敏感。** 改成断言
`sent.prompt[0].text === FROZEN_TEXT` 之后才红。

### 2.2 拿不到的字段填 `''`，让适配器在两跳之外报"必填"

`defaultRequestFor` 第一版把 lease 里没有的字段一律填空字符串。
结果是适配器在 `validateRunRequest` 里报：

```
RunRequest 不合法：workspaceId 必填；modelProfileRef 必填
```

**那已经离真因很远了。** 真因是"这次 lease 里没有工作区"。两跳之外的报错
会把排障指向适配器，而不是指向那个没传值的调用方。

> 一个中间层把错误糊过去，下游那次拒绝就永远看不到真正的输入。

**修法**：本地先按 `RUN_REQUEST_REQUIRED` 检查一遍，缺什么就用
`BAD_WIRING` **逐个点名**（`e.missing`），一次说清。
能从快照 `associations` 里取的（goalId / taskId / employeeId / teamPlanId）
才允许回落；`workspaceId` 与 `modelProfileRef` 取不到就必须由调用方给——
它们是"在哪个目录里、用哪个模型跑"，**猜不出来**。

### 2.3 一句 `no-executor` 掩盖了三种不同的处境

入口以前无论如何都只有一句"没配"。而三种处境的修复动作**完全不同**：

| 处境 | 该去看什么 |
| --- | --- |
| 自检没过 | 强制面（补丁层 / 运行时能力 / 沙箱管制） |
| 缺宿主端口 | 组合层的接线（PRT-214/215） |
| 没配 hub | 配置 |

> 一句不区分处境的报错，与没有报错，在排障上的价值是一样的。

**修法**：`executorRefusal` 带上 `code` 与 `reasons`，并且
**进启动结果**（`executorWired` / `executorRefusal`），不只打在日志行里——
日志行文是会随措辞变更而碎的判据。

## 3. 这一批交付了什么

### `orchestrator/worker/executor.mjs` —— 生产执行引擎

`createProductionExecutor(deps)` 返回**判别式联合**（与 `runWorkerProcess` 同一约定）：

```
{ ok: false, code, message, reasons }        ← 拒绝，说得清为什么
{ ok: true, executor: { buildContext, execute } }
```

**三道拒绝，都不是降级：**

1. **启动自检未过 → 不构造执行引擎。**
   一个能跑但强制面没生效的引擎，去执行真实的写操作时，
   表现与一个正常引擎**完全一样**——直到那次写发生。
   自检结果**形状不对**同样 fail closed：`{}` 会让
   `autoExecutionForbidden === true` 读出 `false`，于是放行。
   **不给自检**也视为未过——「没检查」不等于「没问题」。
2. **缺宿主端口 → 拒绝。** 端口（`startRun`/`probeRuntime`）是把引擎接上来的
   唯一通道；缺了它，"能执行"只能靠编。
3. **没有冻结快照 / 快照验不过 → 这次执行失败。**
   不"用空上下文继续"：那会让模型在一个我们无法回答的世界里动手。
   读回时带 `?verify=1` 并且**真的检查** `verification.ok`——
   把一份验不过的记录喂给模型，等于让"快照可验证"这个保证在最后一米失效。

**`execute` 只从快照取正文**，一个字节都不自己拼。这是本模块存在的理由。

### `orchestrator/worker/executor-binding.mjs` —— 注入端口，不 import 引擎包

worker 是**独立进程**，`import` 不到也探测不到 DSH 进程里的引擎。
所以留一个**注册口** `bindDshRuntime({host, selfCheck, canRead})`，
由 `runtime/dsh-composition/`（PRT-214/215 的地盘）在 DSH 进程内装配进来。

这与 `runtime/adapters/dsh/port.mjs` 是同一条设计取舍：**注入端口，不 import 引擎包**。
好处是这一整条接线能在**不启动 DSH** 的前提下被完整测到——
`executor.test.mjs` 全程用假宿主端口。

`bindDshRuntime` **不收**缺 `selfCheck` 或 `canRead` 的绑定：一个"没给自检就当通过"
的默认值，会让这个注册口本身变成绕过 PRT-215 的入口。

**注销函数可用**：绑定是进程级副作用，装上了卸载不掉会让同一个进程里的
第二次启动带着上一次的残留状态跑。

### `orchestrator/worker/run.mjs` —— 提供者接线

`executorProvider` 是一个返回判别式联合的**异步**函数。拒绝**不是**致命启动错误：
worker 照常起来、写状态文件、**不认领任何任务**，并把理由带进启动结果。
否则 Launcher 只看到"进程退出"，看不到原因。

### `product/orchestrator/worker.mjs` —— 入口

```js
const startup = await runWorkerProcess({
  executorProvider: () => productionExecutorProviderFromEnv({}),
})
```

**今天它大概会返回 `EXECUTOR_HOST_PORT_REQUIRED`**（DSH 侧还没装端口）。
这不是"没做完"——这是这个设计的要点：**DSH 侧装上端口之后，
这个入口不需要改一行代码就开始真的执行了。**

## 4. 一个只在特定顺序下出现的脏状态

`bindDshRuntime` 的注销函数第一版写成：

```js
if (binding === null || binding === previous) binding = previous
```

想表达的是"只撤销自己装上的那一份"。但 `previous` 是**绑定之前**的值，
而最常见的路径恰恰是"从没绑定过 → 绑定 → 注销"：

- `previous = null`
- 绑定后 `binding = obj`
- 注销时：`binding === null`？否。`binding === previous`（`obj === null`）？否。
- **于是注销不掉。**

这个 bug 有个很坏的性质：它**不在第一次绑定时暴露**，而是在下一次绑定时
表现为"上一个绑定没清干净"——一个只在特定顺序下出现的脏状态。

改法是记住**自己装上的那一份**（按引用比较）：`const mine = {...}; if (binding === mine) binding = previous`。

**为什么这条值得写下来**：探针 ⑨⑤ 就是拿它做的。
一个不能被注销的绑定与一个能注销的绑定，在"装上了"这个观测点上完全一样。

## 5. 变红验证：18 处

18 个探针覆盖：提示词优先级、包装、空提示词、必填字段点名、自检缺失/形状/未过、
缺端口、`?verify=1`、`verification.ok`、404 降级、提供者拒绝、两个启动结果字段、
注销、绑定必填项、未绑定、`hubIo` 空壳。

其中**三条是第一轮没咬住、或者咬错了地方**，都记在下面：

- **⑧①** 第一版探针只把 `return frozen` 删掉，**没红**。
  原因：删掉之后函数仍然走回落分支，而我的用例断言的是
  `sent.prompt[0].text === FROZEN_TEXT`——**回落分支在这种情况下不会被执行**，
  因为 `request.prompt` 还在。补上 `void request?.prompt` 让它会红。
  教训与 ⑥②/⑥③ 同类：*一条只拆掉一半的探针，与一条没打上的探针，
  在"用例没红"这个读数上分不出来。*
- **⑨②/⑨④** 涉及"把具名拒绝改成 null"——`executorRefusal.code` 的断言
  会红，但 `executorRefusal` 本身为 `null` 时读 `.code` 是 `TypeError`。
  两处都保留了，改成显式 null 检查之后读数清楚。

## 6. 未交付（如实记录）

- **DSH 侧的端口绑定没有交付。** `bindDshRuntime` 的定义在这里，
  **调用者还不存在**——它要么由 `runtime/dsh-composition/` 在 DSH 进程内调用，
  要么由一次宿主插件装配完成。这是本批与"真的执行起来"之间**唯一**还缺的一环。
  本批能证明的是：**装上端口之后，同一入口不需要改代码就开始执行**（用例 ④）。
- **`contextSnapshotRef` 只是一个 id 字符串**，没有校验它指向的快照
  就是"该员工在该工作空间下应当看到的那一份"。任何人都能传一个别的 attemptId。
  这条防线属于 PRT-3xx 的 Attempt 归属校验，不在本批。
- **预算没有接线。** `budget` 只按契约形态给了一个 `{}`；
  `runtime/adapters/dsh/usage.mjs` 有算钱的能力，但**没有任何地方**在
  执行前预留、执行后结算，也没有 `BUDGET_EXCEEDED` 的写路径。
  「钱不能靠猜」这条判据在本批**没有被满足**。
- **单员工、无自动交接**这个范围是按 spec 走的：`execute` 不做交接、
  不做多员工编排，那是阶段 3。
- **黄金任务没有真的跑过。** 这一批验的是接线与拒绝边界，
  不是"一个真实任务端到端成功"——那需要 DSH 侧的端口，也就是上一节的第一条。
