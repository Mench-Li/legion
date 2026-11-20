# BUG-050｜一个是"声明过期"让机器永远领不走活儿，一个是 `TypeError` 让根因看不见

> 同一条现场（2026-11-20，本机，空间 `personal-profile` 的第一条业务目标）。
> 两个缺陷都在**节点/派工**这条链上，且第二个正是第一个的**根因的另一半**，所以记在一起。

## 现象

目标 `G-mwom2ph8-1` 发布成功，4 条链任务（T-312…T-315）全部建好、`blockedBy` 串成一条链，
然后**一动不动**。看板上是「待认领 4」。

worker 日志每 30 秒一次：

```
T-312 认领失败（可能已被他人认领）：Error: 执行节点未注册或未就绪：desktop-personal-profile (incompatible)
```

人工把节点修好（见 §050-a 的现场处置）之后，认领成功，紧接着：

```
T-312 复用既有 worktree：D:\project\DSH\legion\.legion-worktrees\T-312
T-312 派工失败：TypeError: Cannot read properties of undefined (reading 'id')
🛑 已自动重试 3 次且调解员未能自动修复根因（），任务已置 blocked
```

## 050-a：自注册节点的「声明」冻结在注册那一刻，之后**再也不更新**

hub 的节点就绪判据是「**声明** ⊆ **观测**」（`harness-store.mjs` 的 `nodePresence`）：
`env.node.providerNames.every(name => observedProviders.includes(name))`，能力位同理。

真库读数（两台表一个字都不差地摆在那里）：

| 表 | 内容 |
| --- | --- |
| `agent_node_configs`（声明，11:25 自注册时写死，`version=1`） | providers `["spawn","fork"]`、`structuredOutput:true`、`cancellation:true` |
| `agent_node_presence`（观测，每 30 秒重写） | providers `[]`、`structuredOutput:false`、`cancellation:false` |

声明是**守护自注册时冻结**的，观测是每轮心跳重写的。两者一旦分叉，节点就**永久**
`incompatible` —— 认领被 409 挡死，而错因只有 `(incompatible)` 三个字母。

于是"那次启动读到的能力"变成了"这台机器永远的能力上限"：

> 一个"注册那一刻我会什么"的声明，
> 与一个"现在我还会什么"的观测，在**两者一致**的时候是同一个东西 ——
> 区别只在机器换了状态的那天，而那天之后它一件活儿也领不走。

### 修法

1. `agent_node_configs` 增列 `self_registered`（默认 0）。**只有守护自己登记的节点**才允许自愈；
   人手登记的节点是**人的意图**，心跳无权改写它。
2. `heartbeatAgentNode`：当节点 `selfRegistered === true` 且「声明 ⊄ 观测」时，
   把声明**降级到观测得到的子集**（provider 取交集、能力位 `declared && observed`），
   版本 +1，并把 `selfHealed: { fromVersion, toVersion, providers, capabilities }`
   随心跳响应返回。**只降不升**：观测恢复后不会自动升回去（升是人的决定）。
3. 守护把 `selfHealed` 打进日志 —— 一次自动改写必须留下能读的证据。
4. 非 ready 的理由写清**差在哪一项**：
   `声明了但观测不到：provider[spawn、fork] 能力[structuredOutput、cancellation]`；
   认领 409 的文案随之变成 `(incompatible：声明了但观测不到：…)`。
   停用与心跳过期也各有各的说法（`disabled` / `offline`），不再挤成一句。

## 050-b：provider 不在册时，唯一线索是一句 `TypeError`

修好 050-a 之后认领成功，派工立刻炸在：

```
TypeError: Cannot read properties of undefined (reading 'id')
```

同一时刻 worker 的心跳诊断（每次启动只打一行）给出了另一半：

| 启动时间 | 注册表读数 |
| --- | --- |
| 11:25 | `注册表 provider=[spawn,fork]` ← 那一次节点声明是好的 |
| 11:58 | `注册表 provider=[]` |
| 13:46 | `注册表 provider=[]` |
| 15:03 | `注册表 provider=[]` |

也就是说：**DSH 的子 Agent 注册表在这几次启动后是空的**（服务在，`.list()` 返回空），
而守护照旧按 `config.provider`（`spawn`）派工 ⇒ DSH 内部读 `undefined.id` 崩掉。

> 一个"provider 不在册"的失败，
> 与一个"provider 内部崩溃"的失败，在 `TypeError` 面前是同一句话 ——
> 而它们的修法完全不同。

### 修法

`runtime/adapters/dsh/subagent-start.mjs` 的 `startChildAgent`：真正调用之前先查一次注册表
（**只在运行期确实提供 `getProvider` 时才查**，不替旧版服务编造能力）。查不到就抛具名错误：

```
SUBAGENT_PROVIDER_UNREGISTERED: spawn（本机 ctx.subagents 已注册：（空 —— 一个 provider 都没有：
执行面服务在，但注册表是空的））
```

带稳定 `code: 'SUBAGENT_PROVIDER_UNREGISTERED'`，供错误分类器使用；`派工失败：…` 的评论
因此直接可读，而不是一句 TypeError。

## 验证

| 用例 | 守的是什么 | 读数 |
| --- | --- | --- |
| `team-hub/harness-store.test.mjs` ①~④ | 自注册节点漂移 ⇒ 自动降级、当场 ready、版本 +1、`selfHealed` 写清降了什么、**一致时不刷版本**；观测变多不动声明；人手节点**不许**被改写（保持 incompatible 且理由写清差哪几项）；`disabled`/`offline`/`unknown` 三态各说各话 | 4/4 通过 |
| `runtime/adapters/dsh/subagent-start-unregistered.test.mjs` ①~④ | 不在册 ⇒ 具名错误 + 列出已注册 + **一次都不真的去启动**；在册 ⇒ 照常启动（不误杀）；有别的 provider 但缺这一个 ⇒ 列出那几个名字；运行期不支持查询 ⇒ 不编造失败 | 4/4 通过 |
| `subagent-start.test.mjs`（既有 7 例） | 两代 API 兼容层不回归 | 7/7 通过 |
| `goal-node-binding` + `routes/harness` + `provider-readiness` | 节点绑定/心跳/就绪探测不回归 | 85/85 通过 |
| `team-hub/pipeline.test.mjs` | 空间流水线与节点相关断言不回归 | 25/25 通过 |
| `plugins` `tsc -p tsconfig.json --noEmit` | 守护侧改动可编译（新增 `selfRegistered` 与 `selfHealed` 日志） | exit 0 |

## 未修的那一半（**重要，别当成已经好了**）

050-b 让失败**说得清**，但**没有让注册表重新有 provider** —— 那是 DSH 侧的运行期状态：
`ctx.subagents.list()` 返回空数组。在它恢复之前，任何派工都会以
`SUBAGENT_PROVIDER_UNREGISTERED: spawn` 结束（而不再是 TypeError）。

排查方向（下一步，未完成）：
1. 这个 DSH 版本的 `ctx.subagents` 目录 API 是否变了形状（`list()` 从数组变成别的、
   或 `getProvider` 改名）—— `listSubagentProviders` 只在**数组**时才采信，
   非数组一律按空目录处理，于是"形状变了"与"真的没有 provider"在当前读数里**长得一样**；
2. 装载外部 provider 的那几个插件（`subagent-codex` / `subagent-claude-code`）与
   内置 `spawn` / `fork` 是否在启动期加载失败（本次没有宿主日志可读）；
3. 11:25 那次启动是好的 —— 说明这不是"配置错"，而是**启动期状态**，
   所以先看"那次与之后几次差在哪"比看代码更快。

## 与其它缺陷的关系

- **与 BUG-048/BUG-049 同一条现场链**：048 修"建的空间自己进不去"，049 修"建了链却不知道
  有没有建、以及修复命令跑不通"，050 修"链建好了却永远没人领得走 / 领走后死在一句 TypeError"。
  三次都是同一件事的不同层：**每一环都以为下一环是好的**。
- **与 BUG-017 同形**（多空间守护读错 `/api/spaces` 形状 ⇒ 一个空间都不接管，而且不打日志）：
  这一条的 050-b 是同一个"读到的形状变了 ⇒ 静默变成空集"的形状，
  只是这次的静默发生在 `ctx.subagents.list()` 上。
