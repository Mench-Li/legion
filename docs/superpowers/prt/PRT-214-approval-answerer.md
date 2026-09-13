# PRT-214（三）：approval answerer —— 而且上一批的规划是错的

> 上一批（`PRT-214-enforcement-plugins.md` §6）写着：
> "接管 `approval` 必须 `disabled` 掉 base bundle 那一行，否则服务注册冲突。"
>
> **那句话是错的。** 读了 DSH 的源码才发现正确的缝合点是别的，而且好得多。

---

## 1. ★ 更正：不该接管 `ApprovalService`，该**加入 answerer 链**

`packages/interaction/user-approval/src/index.ts` 里，`ApprovalService` 干三件事：

```
1. 先按 session 策略判：'never' → 直接 'rejected'，不问任何人          (:268)
2. 再派发瀑布：ctx.waterfall(target, 'approval/request', req,
                             () => 'unavailable')                       (:273)
3. 把 approval/asked + approval/decided 这一对审计事件写进 session      (:218,:225)
```

也就是说 **`ApprovalService` 是策略 + 审计层，判定本身委托出去**。
Legion 该做的是加入那条链：

```js
ctx.on('approval/request', async (req, next) => {
  return 'allowed-once'   // 认领这次询问
  // 或
  return next()           // 让给别人
})
```

这样两件事同时成立：

- **没有服务注册冲突**，base bundle 那一行完全不用动（上一批的 `disabled` 计划作废）；
- **审计事件仍由 DSH 写**。

> 一个"自己接管 approval 服务"的实现，
> 与一个"接进 answerer 链"的实现，在一个人批准之后看起来是同一个东西——
> 只不过前者的审计事件得靠我们自己再写一遍，
> 而写第二遍的东西会与 DSH 的那一遍漂移。

而 `ApprovalOutcome`（DSH）= `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`
= Legion 的 `APPROVAL_OUTCOMES`，**逐字相同**，所以**不需要翻译层**。

### 1.1 为什么上一批会写错

那条错误结论读起来完全合理——"要换掉一个能力就得先关掉旧的"，
在有服务注册冲突时是对的。问题是它是在**还没读那个服务的源码之前**
就被写成了结论，而当时的依据只是"base bundle 里有一行提供 `approval`"。

> 一个"从服务名相同推出的注册冲突"，
> 与一个"真的会发生注册冲突"的判断，在有人去读源码之前是同一个东西。

所以那段话**留在原地、只加更正**，而不是删掉。

---

## 2. ⚠️ 撞上一个真实的限制：answerer 拿不到工具参数

DSH 递过来的是（`packages/core/tools/src/index.ts:1696`）：

```js
approval.request({ agent, toolName: exec.name, callId: exec.callId, reason, signal })
```

**没有 `arguments`。** 而 team-hub 的权限检查要靠参数算绑定哈希
（`hashToolArguments`）——没有参数，就造不出一次**可被消费**的批准：
人批了，执行时哈希对不上，票据作废。

> 一个"没有参数也算得出主体"的审批，
> 与一个"人批了却在执行时不匹配"的审批，在审计里是同一个东西——
> 只不过前者会让每一次批准都白批。

而 `tools/pre-execute` **拿得到**完整 `exec`（含 `arguments`）。
于是这两个缝合点必须共享一份状态：

```
pre-execute 行 ──put(callId, 投影)──▶ 【在飞登记簿】 ◀──peek(callId)── answerer 行
```

### 2.1 在飞登记簿（`inflight.mjs`）

两行是两个**独立的 DSH 补丁行**，各自加载自己的模块。它们之间只有两条路：
一个 Cordis 服务（谁 provide？两行都想要它，于是得再有第三行），或一个共享模块。
这里选后者——ESM 会把同一份模块实例给两行。

**代价写在文件里**：进程级单例是隐藏的全局状态。所以它：

- 有 **TTL**（一个永远不被审批的调用不能永远占着内存）；
- 有 **`clear()`**（用例之间必须能互相隔离，否则测的是累积效果）；
- 只放**纯数据**（投影本身），不放 `ctx`、不放活对象。

---

## 3. 交付

| 文件 | 内容 |
| --- | --- |
| `runtime/dsh-composition/inflight.mjs` | 新增：进程级在飞登记簿 |
| `runtime/dsh-composition/plugins/approval-answerer.mjs` | 新增：加入 answerer 链的插件本体 |
| `runtime/dsh-composition/approval-answerer.test.mjs` | 新增：**17 例**，驱动真瀑布 + 源码契约检查 |

插件本身 `inject: ['approval']`，并**复用** `createApprovalAnswerer`
（两段式超时、故障 → `unavailable`、闭集外 → `unavailable` 都已现成）。
它只补一件事：**从登记簿取投影**。

### 3.1 三条认领判据

```js
// ① 没有 callId，或登记簿里没有它 → next()
if (projection === undefined) return next()
// ② 部署级放弃认领 → next()
if (typeof claim === 'function' && claim(req, projection) !== true) return next()
// ③ 认领：这是我们拦下来的调用，去问审批箱
return await answerer({ toolName, callId, reason, signal })
```

**为什么"取不到就 `next()`"而不是"取不到就 `unavailable`"**：

> 一个"抢答一切、于是把别人能答的问题也答成不可用"的 answerer，
> 与一个"根本没接进来"的 answerer，在用户那里是同一个东西——
> 只不过前者的用例是绿的，而且它还能把好部署弄坏。

反过来，**有**投影却问不到 hub（超时 / 不可达）→ **认领**并返回 `unavailable`：
那是我们的权威范围，spec §6.8 要求 fail closed 且**不得等待**。

---

## 4. ★ 两条要害判据

### 4.1 "`next()`" 与 "抢答但答不上来" 必须能被区分开（断验证逼出来的）

我第一版测"没有投影就 `next()`"是这么断言的：**结局 == `'unavailable'`**。
断验证把实现改成"抢答，然后因为找不到投影返回 `unavailable`"——**那条用例照样绿**。

因为 **DSH 自己的兜底值也是 `unavailable`**。

> 一个"让给别人"的实现，
> 与一个"抢答然后答不上来"的实现，
> 在**下游没有别人**的时候是同一个东西——
> 只不过前者不会把好部署弄坏，而后者会。

要区分它们，必须有**一个下游答主在场**，而且它给出的答案与 `unavailable` 不同。
新增的 ★★★★★ 用例：Legion 先注册（瀑布里排前面），下游再挂一个会放行的答主；
callId 不在登记簿里 → Legion 让路 → 下游放行 → **`allowed-once`**。

**`allowed-once` 是这条用例的关键**——它是"下游真的被问到了"的唯一证据。
断言 `unavailable` 什么都证明不了。

### 4.2 插件里那层"闭集兜底"是死代码，已删除

我第一版在插件里又写了一遍：

```js
return APPROVAL_OUTCOMES.includes(outcome) ? outcome : 'unavailable'
```

断验证证明它**永远触发不了**：`createApprovalAnswerer` 已把闭集外归一
（`enforcement.mjs:543`），DSH 那边还会**再**归一化一次（`:281`）。

> 一个"永远不会执行的兜底"，与一个"根本没有兜底"，
> 在它能被触发的那一天之前是同一个东西。

保证只该写在一个地方。删掉之后，探针④（把 `enforcement.mjs` 里那一处改成放行）
**仍然判红**——证明那条保证还是活的，只是不再有第二、第三份副本。

> 一个"我加的这层保护"与"什么都没做"，
> 在断验证面前的读数是一样的。

---

## 5. 验证

### 5.1 断验证 4/4，逐字节还原

| 探针 | 弄坏什么 | 结果 |
| --- | --- | --- |
| ① | 取不到投影改成抢答 | ✅ 红（★★★★★ 那条） |
| ② | 没 port 改成默默造一个永远拒绝的端口 | ✅ 红 |
| ③ | TTL 判定改成永不过期 | ✅ 红 |
| ④ | `enforcement.mjs` 里闭集外 → 放行 | ✅ 红 |

脚本本身也修了一处：原来的循环在锚点找不到时**抛在还原之前**，
会把源码留在被改坏的状态。已改成 `try/finally` 全局还原——

> 断验证脚本必须**即使被杀也**逐字节还原。

### 5.2 源码契约检查（防漂移）

用例里有一条直接读 DSH 的 `user-approval/src/index.ts`，断言四件事仍在：

1. `ctx.waterfall(scopeTarget(…), 'approval/request', req, …)` 的形状；
2. 没人认领时的兜底值 `'unavailable'`；
3. `if (this.effectivePolicy(session) === 'never') return 'rejected'`（**派发之前**的短路）；
4. 结局闭集的归一化点。

> 一个"对着自己抄下来的契约"测的用例，
> 与一个"对着真契约"测的用例，在别人改契约那天是同一个东西——
> 只不过前者一直是绿的。

第 3 条尤其要紧：**无人值守模式（preset `approval: never`）根本走不到 answerer**——
DSH 在派发之前就定了 `rejected`。所以"审批箱在无人值守时会被咨询"是错的，
而这正是那条断言在守的事。

### 5.3 全量

`approval-answerer` **17/17**；七道门禁全 PASS；全量 CI **9 阶段全 PASS**，
`test` **166 套件 / 4486 用例 / 0 fail**（`.ci/prt-214c/`）。

---

## 6. ⚠️ 诚实边界：**本行刻意不导出 default**

`plugins/approval-answerer.mjs` **不导出 default**，因此 `PATCH_LAYER_ROWS`
里这一行**仍然是 `module: null`**。理由不是偷懒：

`hard-floor` 可以有 `export default createHardFloorPlugin()`，因为静态下限是一个
**常量**。本行不行——它需要一个接在 team-hub 上的审批端口，而
**`PatchOptions.config` 是数据，不是函数**，YAML 带不了它。

两条路都还没定，模块**不替部署猜**：

- **a)** 由 `pre-execute` 行（或一个装配函数）在进程内
  `ctx.plugin(createApprovalAnswererPlugin({ port }))`；
- **b)** 给一行装一个**从 config 造 hub 客户端**的 default 导出
  （需要 `hubBaseUrl` / `scope` / `actor`），而这几个值目前没有权威来源。

导出一个"会挂载、却因为没端口而什么都不做"的 default，正是本批要防的东西：

> 一个"挂上了、但什么都没接管"的 answerer，
> 与一个"从来没有被写进补丁层"的 answerer，在组合树上长得一模一样——
> 只不过前者的文件看起来是装好的。

**但本行现在挂不上去并不会弄坏任何部署**——因为"取不到投影就让给别人"这条判据
就在**这里**。这也是为什么它值得一条 ★★★★★ 用例。

### 行的状态

| 行 | 状态 |
| --- | --- |
| `legion-enforcement-hard-floor` | ✅ 有模块、已进补丁层、真运行时 10 例全绿 |
| `legion-enforcement-permission-presets` | ✅ patch-over，已生效 |
| `legion-enforcement-approval-answerer` | 🟡 模块已写好并验证 17 例，**刻意无 default**（等装配路径） |
| `legion-enforcement-pre-execute` | ⬜ `module: null`——**它是在飞登记簿的生产者，也是本行的前置** |

`reconcilePatchLayer()` 仍报两条 `ROW_MISSING`，启动自检仍拒绝注册（fail closed）。
补丁层**仍未真的被注入过任何 profile**；员工 agent preset 那一半尚未开始。

**下一轮**：`pre-execute` 行——它有完整 `exec.arguments`，是唯一能造出合法审批主体的
角色；`put(callId, 投影)` 之后本批这两条判据就都能真跑起来了。
