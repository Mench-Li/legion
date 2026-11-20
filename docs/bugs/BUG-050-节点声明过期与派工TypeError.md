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

### 真因（050-c）：DSH 这一代把 `startActivation` 的**参数形状**改了，而那一句 TypeError 是 `parent.id`

排查过程（可复用）：先用 `cordis_inspect_query`（Host `Service` provider）读出这一版 `ctx.subagents`
的**契约**，得到两件事：

1. 它**没有 `list()`** —— provider 目录不再是"全局可枚举表"（`registerProvider` / `getProvider`
   还在；会话目录改按 Agent 树走：`listDescendants` / `namesOf`）。
   Legion 的 `listSubagentProviders` 直接调 `.list()` ⇒ `TypeError` ⇒ 被
   `try { providerNames = listSubagentProviders(ctx) } catch {}` 吞掉 ⇒ `[]`
   ⇒ **"列不出来"与"真的一个都没有"在读数上长得一模一样**（与 BUG-017 同形）。
2. `startActivation(spec)` 的 spec 是**扁平的**：
   `{ provider, label, prompt, parent, signal, delivery, … }`
   （`SubagentActivationSpec extends Omit<SubagentStartRequest, 'label'|'signal'>`）。
   而 Legion 的兼容层发的是 **rc 那一代的嵌套形状**：
   `{ provider, label, request: { prompt, parent }, signal, delivery }`
   ⇒ 实现读 `spec.parent.id` ⇒ **`Cannot read properties of undefined (reading 'id')`**。

   > 一个"方法签名对了、参数形状没对上"的调用，
   > 与一个"方法不存在"的调用，在 `is not a function` 面前是两件事，
   > 在 `reading 'id'` 面前是同一件事。

   这与该文件头记过的 2026-10-20 那次（编译期 0.2.1-alpha、运行期 0.2.1-rc）**是同一个形状**：
   兼容层吸收的是"方法在不在"，这次暴露的是"参数形状"。两者都只能靠**真的调一次**发现。

### 修法

1. `startChildAgent` 按**这一代独有的方法**判形状（`registerProvider` / `namesOf` 不参与启动）：
   有 ⇒ 发**扁平** spec；没有 ⇒ 仍发 rc 的嵌套 `request`（老服务不许被这次修法弄坏）。
2. `listSubagentProviders`：没有 `list()` 时返回空数组而**不抛**；新增
   `subagentProviderCatalogMode(ctx)`（`'list' | 'unavailable'`），心跳诊断里打
   `目录可枚举=…` —— 让"列不出来"与"一个都没有"从此在日志里分得开。
3. provider 不在册时给具名错误（见上）而不是 TypeError。

> ⚠️ 仍未做的那一半：这一代**没有全局枚举**，所以节点心跳里的
> `providers: []` 是"读不到"而不是"没有"。其中枢侧的后果由 050-a 的自愈兜住
> （自注册节点的声明会被降到 `[]`，节点照样 ready），但"这台机器到底有哪些 provider"
> 这件事，从此只能从 `getProvider(名字)` 一个个问 —— 记在这里，未实现。

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
| `runtime/adapters/dsh/subagent-start-unregistered.test.mjs` ①~⑥ | 不在册 ⇒ 具名错误 + 列出已注册 + **一次都不真的去启动**；在册 ⇒ 照常启动（不误杀）；有别的 provider 但缺这一个 ⇒ 列出那几个名字；运行期不支持查询 ⇒ 不编造失败；**第三代扁平 spec 走通**（用"读 `spec.parent.id`"的假服务把形状差异钉死）；**rc 嵌套形状仍走通** | 6/6 通过 |
| `subagent-client.test.mjs`（既有） | 目录读取面不回归（新增 `subagentProviderCatalogMode`） | 4/4 通过 |
| `subagent-start.test.mjs`（既有 7 例） | 两代 API 兼容层不回归 | 7/7 通过 |
| `goal-node-binding` + `routes/harness` + `provider-readiness` | 节点绑定/心跳/就绪探测不回归 | 85/85 通过 |
| `team-hub/pipeline.test.mjs` | 空间流水线与节点相关断言不回归 | 25/25 通过 |
| `plugins` `tsc -p tsconfig.json --noEmit` | 守护侧改动可编译（新增 `selfRegistered` 与 `selfHealed` 日志） | exit 0 |

## 050-d：目录枚举不到 ≠ 一个都没有（已修）

这一代 `ctx.subagents` **没有 `list()`**（目录按 Agent 树走），于是
`listSubagentProviders(ctx)` 恒为 `[]`，而节点心跳把 `[]` 当"观测到的 provider"上报
⇒ 中枢的「声明 ⊆ 观测」必然失败 ⇒ 节点永久 `incompatible`（050-a 那条现场的另一半）。
**而注册表其实是好的**：`getProvider('spawn')` 拿得到，就绪度里 `spawn/fork` 都是 `ready`。

> 一个"列不出来"的目录，与一个"空目录"，在 `[]` 这个读数上是同一个东西 ——
> 区别只在有人照着它做判定的那一次。

修法：新增 `observedSubagentProviders(ctx, extraNames)` —— 能枚举就枚举；
不能枚举就对**候选名单**逐个 `getProvider`，只认问到的（候选 = 本机已知规格
`readinessProbeTargets([])` ∪ 自己配置要用的 `config.provider`）。
守护的心跳改用它；`listSubagentProviders` 保留（仍诚实地表示"枚举不到"）。

## 050-e：一行**只在该错的时机**打的日志，把排查带偏了一轮

原诊断日志只在**第一次心跳**打印（`heartbeatDiagnosed`），而那一刻后台探测必然还没回来，
所以日志里永远写着：

```
本轮读数=(探测尚未出结果)
```

我照着这一行判断"探针从来没出过结果"，还把它写进了本文件的「未修」清单 ——
去库里查 `members.providers_json` 才发现 `spawn=ready、fork=ready`（15:47 的读数）。

> 一句在**错误时机**打出来的正确日志，
> 与一句错话，在读者眼里是同一个东西。

修法：**首次真的拿到读数时**再补一行
`provider 就绪度首次读数：spawn=ready、fork=ready（之后随心跳每轮刷新，TTL 10 分钟）`。
（本文件「未修」条目里关于探针的那条判断已据此**撤回**。）

## 仍未修（如实清单）

1. **这一代没有全局 provider 枚举**：050-d 之后，节点上报的是"对候选逐个问到的那几个"，
   不是"全部"。若某台机器注册了候选名单之外的 provider，它不会出现在观测里
   （要人工把它加进候选，或等 DSH 提供枚举面）。
2. **`unprobed`（没有探测规格）与 `unknown`（探测超时）** 在面板上仍是两个状态，
   但两者都需要人工看；没有任何自动升级路径。

## 与其它缺陷的关系

- **与 BUG-048/BUG-049 同一条现场链**：048 修"建的空间自己进不去"，049 修"建了链却不知道
  有没有建、以及修复命令跑不通"，050 修"链建好了却永远没人领得走 / 领走后死在一句 TypeError"。
  三次都是同一件事的不同层：**每一环都以为下一环是好的**。
- **与 BUG-017 同形**（多空间守护读错 `/api/spaces` 形状 ⇒ 一个空间都不接管，而且不打日志）：
  这一条的 050-b 是同一个"读到的形状变了 ⇒ 静默变成空集"的形状，
  只是这次的静默发生在 `ctx.subagents.list()` 上。
