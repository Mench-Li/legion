# PRT-253 canRead 授权批：「这一次 Attempt 能读哪些来源」到不到得了 Runtime 进程

> ## ⚠️ 后续批次（阅读本文前先读这一段）
>
> 本文的**结论不变**：`canRead` 的答案**没有**跨过 worker → Runtime 的进程边界，
> 应当**走 (B)**。后来的一批（[`PRT-253-runtime-host-binding-unblocked.md`](./PRT-253-runtime-host-binding-unblocked.md)）
> 只改了本文**没有**主张的一件事：
>
> - 本文记录的是"答案不在这边"这条**边界事实**——它仍然成立。
> - 但本文写的时候，那条边界事实被**实现**成了一道**拦绑定的门**
>   （`runtime-host-registrar-row.mjs` 的默认工厂在"没有 `canRead` 来源"时抛
>   `RUNTIME_HOST_REGISTRAR_NO_CAN_READ_SOURCE`，`bindDshRuntime` 硬性必填）。
>   后一批量到：**Runtime 进程里没有任何东西读这个绑定的 `canRead`**
>   （五条测量见后文那篇 §0 的表，其中第 ⑤ 条正是"这个绑定的读者只取
>   `{ok,state,patchVersion,checks}`"），
>   于是"缺席"改为**如实记成 `canRead: null`**，绑定照常建立。
> - **两条 fail-closed 一字未改**：同进程（后一批**新加**了这条判定）与跨进程
>   两条路都仍然 `EXECUTOR_CAN_READ_REQUIRED`；`createProductionExecutor` 自己的
>   要求（`executor.mjs:147`）也原样保留。
>
> 也就是说：**本文是那篇的"为什么答案不在这边"，那篇是"所以这边不应据此拒绝绑定"。**
> 本文 §8 里"注册方的具名拒绝是对的、下一个读数会是 `MODEL_UNAVAILABLE`"
> 这两句**已被后一批取代**——`MODEL_UNAVAILABLE` 不是下一个读数，
> 下一个阻塞点是三项必需能力在进程内没有可确认的来源（见那篇 §9）。

> 本文回答一个问题，并**只**回答这一个问题：
>
> **`canRead`（"这一次 Attempt 能读哪些上下文来源"的权限判定）的答案，有没有跨过
> worker → Runtime 的进程边界？**
>
> 结论：**没有。走 (B)。** 拒绝保留，不发明任何默认值、替身或"暂时放行"。
>
> 本文不是"授权做完了"的交付说明。它是**一条缝的界桩**：把"答案不在这边"从一句
> 注释变成一组可失败的读数，并写清要到哪一天、改哪个生产者、哪个字段，这条缝才会合上。

---

## 0. (A)/(B) 的判据与结论

任务给的判据是**结构性的**，不是态度性的：

| 情形 | 合法性 | 本批结论 |
|---|---|---|
| `canRead` 只在**一次 Attempt 内**被调用（boot 期只需要"有个函数"，不需要"一个决定"） | 延迟判定**合法** | ✅ 成立 |
| boot 期的启动自检**需要一个决定** | 那就必须有一个跨 attempt 的授权来源；没有就只能拒绝 | ❌ 不成立 |

**两条都测了，结论落在 (B)**：

1. **boot 期不需要一个"决定"——只需要一个函数。**
   `bootstrapDshRuntime` 对 `canRead` 只做**形状检查**（`runtime/dsh-composition/bootstrap.mjs:187`
   `if (typeof canRead !== 'function')`），随后把它**原样转发**给 `bind`（同文件 `:310`）。
   它**从不调用**它。真 DSH 进程读数 F 是对照：注入一个永远放行 `{all:true}` 的
   `canRead` 替身，绑定**照样失败**，失败码是 `BOOTSTRAP_SELF_CHECK_INCOMPATIBLE`
   ——启动自检的输入是**能力表与组合树**，与 `canRead` 无关。
   → 所以"延迟判定"这个形状**本身是合法的**：`canRead` 的每一次调用都发生在
   `buildContext`（一次 Attempt）里。

2. **但没有任何东西可以"延迟到"。**
   延迟判定要求授权**随它服务的那个请求到达**。而跨进程的 `execute` 请求里
   **没有授权字段**（读数 A / A2），RunRequest 的契约里也**没有**（`runtime/contracts/run.mjs`
   `RUN_REQUEST_REQUIRED`）。Runtime 进程既没有 lease，也没有岗位清单，也没有 hub 凭证
   （`product/process-manifest.mjs:142-156` 的 `envNames` 里没有 `TEAM_HUB_TOKEN`）。
   → 延迟判定**合法但无物可依**。任何在 Runtime 进程里配出来的 `canRead`，填什么都是编的。

**因此按任务的 (B) 分支办**：说清楚它为什么不成立、要保持哪条拒绝、以及要改什么才能成立。
**没有**新建默认授权、没有替身放行、没有"暂时允许"路径。

这条结论与仓库里已有的、更早的一条论证**同向**，而本文是第一次**把它测住**：
`runtime/dsh-composition/plugins/runtime-contract-server-row.mjs:61-72` 早已写明
「在 Runtime 进程里配一个 `canRead`，无论填什么都是编的」。
本文的工作是：把这句话从"作者当时相信"变成"再多加一个键就会红的读数"。

---

## 1. 端到端 trace（文件 + 行号）

### 1.1 worker 侧：授权判定**确实做了**，做在 worker 里

```
orchestrator/worker/executor-binding.mjs:132-133   bindDshRuntime 要求 canRead（缺了抛 TypeError）
orchestrator/worker/executor-binding.mjs:402-414   跨进程路径缺 canRead → EXECUTOR_CAN_READ_REQUIRED
orchestrator/worker/executor-binding.mjs:437-449   createProductionExecutor({ ..., canRead })
orchestrator/worker/executor.mjs:200-203           createHubContextStage({ post, canRead, clock })
orchestrator/worker/context-stage.mjs:340           const verdict = canRead({ lease, scope, sources })
orchestrator/worker/context-stage.mjs:341-352       回答必须是显式的 true / {all:true} / id 数组，含糊 = BAD_WIRING
orchestrator/worker/context-stage.mjs:357-383       POST /api/context-snapshots/assemble，带 canReadAll / canReadIds
orchestrator/worker/context-stage.mjs:415-417       冻结结果：canReadDefaulted:false, assembledBy:'hub'
```

**要点**：生产的 `buildContext` 是**远程**那一个（`executor.mjs:200` 用的是
`createHubContextStage`）。也就是说 `canRead` 被调用了——但它的输出变成的是
**发给 hub 的装配请求里的 `canReadAll` / `canReadIds`**，判定与装配都落在 **hub 侧**。
`canRead` 的**受众是 hub，不是 Runtime 进程**。

### 1.2 请求构造：授权**在这里就已经不在场了**

```
orchestrator/worker/executor.mjs:406-431   defaultRequestFor(lease, snapshot) 造 RunRequest
orchestrator/worker/executor.mjs:408-431   请求的每一个字段的来源都是 lease 或 snapshot.associations
orchestrator/worker/executor.mjs:419       contextSnapshotRef = lease.attemptId（引用那份被冻结的快照）
orchestrator/worker/executor.mjs:424       permissions 的默认值是 { preset:'legion-attended', tools:[] }
orchestrator/worker/executor.mjs:430       prompt 逐字来自 snapshot.finalText
```

**要点**：`defaultRequestFor` **不转发** lease 上的任意字段——它是逐字段挑的。
即使 lease 上**真的**多带了一个授权字段，它也不会进入请求（这一点有破验支撑，见 §5）。
请求里唯一带默认值的权限项是 `permissions.preset`，那是**工具面档位**，
与"能读哪些上下文来源"是两件事；把它读成授权就是本批明令禁止的那种编造。

### 1.3 传输：`execute` 的请求体**恰好**两个顶层键

```
orchestrator/worker/runtime-contract-client.mjs:213-220  execute(request)
orchestrator/worker/runtime-contract-client.mjs:217      body: JSON.stringify(wireRequest({ request }))
runtime/contracts/wire.mjs:419                           wireRequest(payload, wireVersion) → { wireVersion, ...payload }
runtime/dsh-composition/runtime-contract-server.mjs:277  handleExecute → adapter.execute(request)
```

**要点**：`execute` 只把 `{ request }` 交给 `wireRequest`。Runtime 进程那一侧
拿到的就是 RunRequest 本身（读数 A：服务端适配器收到的键集与客户端请求体里的
`request` **完全相同**——服务端不补字段）。

### 1.4 Runtime 进程侧：`canRead` 根本不在这一层出现

```
runtime/dsh-composition/enforcement.mjs         全文没有 canRead（`grep canRead` 零命中）
runtime/dsh-composition/runtime-contract-server.mjs   只是把 request 转给 adapter，从不装配上下文
```

**要点**：Runtime 进程**从不装配上下文**。装配（以及它的权限判定）100% 在 hub 侧完成，
Runtime 进程拿到的只是一段已经被冻结、被哈希、被审计的 `prompt` 正文。
于是"Runtime 进程需要一个 `canRead`"这件事，前提本身就不成立。

### 1.5 绑定缝：这里就是那条拒绝

```
runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs:562-591
  :568-573  ctx.get('subagents') 不在 → NO_SUBAGENTS_PORT（与"缺权限来源"**分得开**）
  :575-581  typeof canRead !== 'function' → NO_CAN_READ_SOURCE
  :583-588  runtimeHost = Object.freeze({ startRun, probeRuntime })   ← 只有这两个
  :590      return { runtimeHost, canRead }
runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs:605
  registeredRuntimeHostInputsFactory = createRuntimeHostInputsFactory()   ← 生产默认：没有 canRead
runtime/dsh-composition/plugins/runtime-host-row.mjs:427,444-447,468
  工厂被调用 → canRead 必须是个函数 → root.bootstrap({ runtimeHost, composition, sandbox, canRead })
runtime/dsh-composition/bootstrap.mjs:187-192   BAD_WIRING（形状检查，不是决定）
runtime/dsh-composition/bootstrap.mjs:310       canRead 原样进 bind
```

**要点**：这条拒绝拒绝的是"**没有一个函数**"，不是"没有做出一个决定"。
任务担心的那种坏形状（把缺失的授权静默变成 allow 或静默 deny）在这里**没有发生**：
它是一条具名、可区分、拦在启动期的码。

---

## 2. 原始读数（可逐字复核）

### 2.1 一次性测量脚本的现场读数

脚本：`D:\project\DSH\legion\.worktrees\_prt-handoff\prt253cra-measure.mjs`
（scratch，**不入库**；它做的两件持久化的事已分别落进 §2.2 的两个套件）
运行：`node prt253cra-measure.mjs`，exit 0。

```
D-CLAIMED-KEYS attemptId,attemptNo,leaseEpoch,leaseExpiresAtMs,scope,serverTimeMs,state,taskId
D-CLAIMED-READAUTH-LOOKING (none)
D-CLAIMED-STATE Leased
C-CLAIMED-LEASE-MISSING-FOR-RUNREQUEST budget,contextSnapshotRef,employeeId,expectedOutput,goalId,idempotencyKey,modelProfileRef,permissions,runId,teamPlanRef,timeoutMs,workdir,workspaceId
C-REQUEST-KEYS attemptId,budget,contextSnapshotRef,employeeId,expectedOutput,goalId,idempotencyKey,modelProfileRef,permissions,prompt,runId,taskId,teamPlanRef,timeoutMs,workdir,workspaceId
C-REQUIRED-KEYS attemptId,budget,contextSnapshotRef,employeeId,expectedOutput,goalId,idempotencyKey,modelProfileRef,permissions,runId,taskId,teamPlanRef,timeoutMs,workdir,workspaceId
C-NOT-IN-REQUIRED prompt
C-REQUIRED-NOT-PRESENT (none)
C-PERMISSIONS-KEYS preset,tools
C-READAUTH-LOOKING-KEYS (none)
A-WIRE-URL-PATH /legion/runtime/v1/execute
A-SENT-BODY-KEYS request,wireVersion
A-SENT-REQUEST-KEYS attemptId,budget,contextSnapshotRef,employeeId,expectedOutput,goalId,idempotencyKey,modelProfileRef,permissions,prompt,runId,taskId,teamPlanRef,timeoutMs,workdir,workspaceId
A-SENT-PERMISSIONS-KEYS preset,tools
A-SENT-READAUTH-LOOKING-KEYS (none)
A-SERVER-ADAPTER-KEYS attemptId,budget,contextSnapshotRef,employeeId,expectedOutput,goalId,idempotencyKey,modelProfileRef,permissions,prompt,runId,taskId,teamPlanRef,timeoutMs,workdir,workspaceId
A-SERVER-ADAPTER-HAS-AUTHISH (none)
A-TERMINAL-TYPE run.completed
B-BAG-KEYS lease,scope,sources
B-BAG-LEASE-KEYS attemptId,attemptNo,leaseEpoch,leaseExpiresAtMs,scope,serverTimeMs,state,taskId
B-BAG-LEASE-READAUTH-LOOKING (none)
B-BAG-SOURCES-KEYS employeeManifest,goal
B-POST-PATH /api/context-snapshots/assemble
B-POST-BODY-KEYS associations,attemptId,canReadIds,frozenAtMs,runId,scope,sources
B-POST-PERMISSION-KEYS canReadIds
B-FROZEN-KIND frozen
B2-META-KEYS id,scope,trust,type,version
B2-CTX-KEYS inputs,lease,scope
B2-CTX-LEASE-KEYS attemptId,attemptNo,leaseEpoch,leaseExpiresAtMs,scope,serverTimeMs,state,taskId
B2-CTX-READAUTH-LOOKING (none)
B2-INPUTS-KEYS employeeManifest,goal,scope,task,teamPlan
B2-FROZEN-KIND frozen
MEASURE-DONE
```

读法（四行最要紧）：

- `A-SENT-BODY-KEYS request,wireVersion` —— 跨进程请求**恰好**两个顶层键。
- `A-SERVER-ADAPTER-KEYS` 与 `A-SENT-REQUEST-KEYS` **逐字相同** —— 服务端不补字段，边界另一侧
  拿到的就是 worker 造出来的那一份。
- `*-READAUTH-LOOKING (none)` —— 四处（RunRequest / 线上请求体 / `canRead` 拿到的 lease /
  本地路径的 ctx）用 `/read|auth|grant|permit|acl|visib/i` 筛，**全空**。
- `D-CLAIMED-KEYS` —— 真 `claim()` 返回**恰好** 8 个键，同样全空。

> ★★★ **订正（2026-09-18，PRT-214 第二步之后）：上面这一行作为"全局读数"已经过期。**
>
> 它当时成立，而且**今天是按接线与否分叉**的：
>
> | store | 租约上的键 | 档位 |
> | --- | --- | --- |
> | **接了线**（生产：`team-hub/server.mjs` 给了 `resolveRunPermissions`）+ 有岗位清单 | **11** 个（多 `allowedTools` / `deniedTools` / `approvalPolicy`） | **在**这一侧 |
> | **没接线**（本文件 ①②③④ 刻意跑的那一半） | 恰好 **8** 个 | 不在 |
>
> 于是"8 个键"是**分叉的一边**，不是全局状态。
> 生产证据：`team-hub/run-plane-e2e.test.mjs` ⑧ —— 清单里的 `git-push`
> 一路变成 guard **真的拒掉**的 `bash` / `pwsh`。
>
> ★ 本文件下面的原始输出**一字未改**：它是那次批次的证据，改它等于伪造证据。
> 这条订正只负责说明"它今天该怎么读"。
>
> ★ 这也是为什么`orchestrator/worker/executor.mjs` 里那两处
> "`claim()` 只回 8 个键、于是**每一个** Run 都走 ③" 的 JSDoc 同批被订正——
> **一个偏保守方向的过期读数比一个偏乐观的更难被发现，因为它读起来像有人在谨慎。**

### 2.2 两个入库套件（原始输出）

`runtime/dsh-composition/can-read-authorization-boundary.test.mjs`（**新增**）
—— 把"各段接缝搬了哪些键"锁成可失败读数。判据一律是 `deepEqual` 比**完整键集**，
不是 `includes`：多加一个键就红，而"多加一个键"正是本批要找的东西。

```
$ node --test runtime/dsh-composition/can-read-authorization-boundary.test.mjs
✔ A. 跨进程 `execute` 携带的顶层键**恰好**是 wireVersion 与 request (534.7083ms)
✔ A2. 跨边界的 RunRequest **恰好**是契约必填集加 prompt；权限面只有工具面的两个键 (18.8285ms)
✔ B. 远程 buildContext 交给 canRead 的**恰好**是 {lease, scope, sources} (23.7962ms)
✔ B2. 本地 buildContext 交给 canRead 的**恰好**是 (meta, {lease, scope, inputs}) (48.3111ms)
✔ C. `defaultRequestFor` 造出的 RunRequest 不含任何读权限字段 (1.0309ms)
✔ E. 生产默认工厂**仍然**以具名码拒绝；注入 canRead 后同一形状能建出端口 (2.7751ms)
ℹ tests 6
ℹ suites 0
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 4178.9547
```

`orchestrator/worker/can-read-authorization-source.test.mjs`（**新增**）
—— 本批结论的前提是"worker 认领回来的东西里没有授权"。前提若是自己写的夹具，
结论就只是自己跟自己对账。所以这个套件走**真** `claim()`（临时 SQLite + 真
`run-store.mjs`）。

```
$ node --test orchestrator/worker/can-read-authorization-source.test.mjs
✔ ① 真 claim() 返回的对象**恰好**那 8 个键，且没有任何读 / 授权形状的键 (145.4201ms)
✔ ② 拿**真** lease 造 RunRequest：仍然只有工具面权限，读面一个字段都没有 (154.3051ms)
✔ ③ 真 lease 缺的 RunRequest 必填字段是"配置面"的，不是"授权面"的 (150.0792ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2331.5696
```

`runtime/dsh-composition/plugins/runtime-host-registrar-row-dsh-process.test.mjs`（**既有，本批复跑**）
—— 生产默认那条拒绝在**真 DSH 进程**里仍然拦启动：

```
$ $env:DSH_CHECKOUT='D:\project\DSH\dsh\deepseek-harness'; node --test runtime/dsh-composition/plugins/runtime-host-registrar-row-dsh-process.test.mjs
▶ PRT-253 续批二：生产注册方在**真 DSH 进程**里的读数
  ✔ N. 上一批的取值（组件本体当模块、没人注册工厂）→ `RUNTIME_HOST_ROW_NO_INPUTS_FACTORY` (2253.7157ms)
  ℹ N: exit=1 RUNTIME_HOST_ROW_NO_INPUTS_FACTORY
  ✔ R. ★★★ 换成生产注册方当那一行的模块 → 换一条**不同**的具名码 (2500.9264ms)
  ℹ R: exit=1 RUNTIME_HOST_ROW_INPUTS_FACTORY_THREW(RUNTIME_HOST_REGISTRAR_NO_CAN_READ_SOURCE)
  ✔ F. 注册方 + 注入的 canRead（替身）→ 未确认的能力在**启动自检**那一步后果可见 (3456.2603ms)
  ℹ F: exit=1 RUNTIME_HOST_ROW_BIND_REFUSED(BOOTSTRAP_SELF_CHECK_INCOMPATIBLE)
  ✔ S. ★★ 生产探针在真 DSH 进程里的读数：版本是真安装的版本，能力逐项有据 (6827.6815ms)
  ℹ S: version=0.1.5-rc.2 caps={"tool-permission-enforcement":false,"cancel-and-timeout":false,"structured-result":true,"usage-reporting":false}
  ✔ S2. S 的反向对照：桩 provider 把 `outputSchema` 报成 false → 那两项读数跟着变 (8617.2783ms)
  ℹ S2: structured-result=false RUNTIME_HOST_REGISTRAR_CAPABILITY_PROVIDER_LACKS_OUTPUT_SCHEMA
  ✔ ★ 四个场景的读数两两不同形（"注册方在不在""能力读没读到"都被读出来了） (0.8446ms)
  ℹ N=RUNTIME_HOST_ROW_NO_INPUTS_FACTORY / R=RUNTIME_HOST_ROW_INPUTS_FACTORY_THREW(RUNTIME_HOST_REGISTRAR_NO_CAN_READ_SOURCE) / F=RUNTIME_HOST_ROW_BIND_REFUSED(BOOTSTRAP_SELF_CHECK_INCOMPATIBLE)
✔ PRT-253 续批二：生产注册方在**真 DSH 进程**里的读数 (23662.799ms)
ℹ tests 6
ℹ suites 1
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 26277.2681
```

F 这一行是本批 (A)/(B) 判据的**直接证据**：`canRead` 替身给的是"永远全放行"，
绑定仍然失败——**启动自检不看 `canRead` 的决定**。

---

## 3. (B) 的实质：授权在哪一侧、为什么进不了请求

一句话版：

> **授权判定在 worker 侧确实发生了，但它的产物是给 hub 的装配指令
> （`canReadAll` / `canReadIds`），而 `execute` 请求的构造器
> （`defaultRequestFor`）逐字段从 lease / 快照关联取值——授权的产物不在它取的字段里。**

更细的两个原因，任一条单独成立就足以让 (A) 不成立：

1. **时序**：授权在**冻结上下文之前**就被消费掉了。`canRead` 决定 hub 允许把哪些来源
   写进快照；快照冻结之后，正文（`prompt`）就是授权的**结果**。到 Runtime 进程时，
   "还能不能读"这个问题已经被回答完了——把它再回答一遍没有意义。
2. **可达性**：Runtime 进程的 `envNames`（`product/process-manifest.mjs:142-156`）
   里没有 `TEAM_HUB_TOKEN`，也没有任何模型 / 岗位选择器。它即使想重新推导，
   既没有凭证去问 hub，也没有 lease 可看。

### 3.1 要到哪一天、改什么，这条缝才会合上

**不建议**按下面的方式合——列出它是为了让"不修"是个**有内容的判断**，不是一个省略：

| 要动的层 | 具体位置 | 要发生什么 |
|---|---|---|
| 契约 | `runtime/contracts/run.mjs:66` `RUN_REQUEST_REQUIRED` / `:94` `validateRunRequest` | 增加一个授权字段并纳入校验。**这是一次 wire 契约变更**，要一起定版本语义（`RUNTIME_CONTRACT_WIRE_VERSION`）。 |
| 生产者 | `orchestrator/worker/executor.mjs:406-431` `defaultRequestFor` | 把这次 Attempt 的授权决定放进去。它今天拿不到：`canRead` 的产物经 `context-stage.mjs:357-383` 直接 POST 给了 hub，**没有留在快照上**。所以还要先让 hub 的装配响应把结论回吐出来（`runtime/contracts/run.mjs` 之外的另一处契约）。 |
| 消费者 | `runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs:583-590` | 工厂的 `runtimeHost` 要多一个 `canRead`，且它必须是**从被服务的那个请求**派生的（`execute(request)` 的 `request`）。 |
| 进程 | Runtime 进程 | **无事可做**。它不需要新的 env、不需要新服务——这正是 (A) 的形状合法的原因，也是它今天空转的原因。 |

**明确不做的事**：不把 `permissions.preset`（工具面档位）当读权限用；不由
`scope` 推出"这一空间里都能读"；不在 Runtime 进程里配一个恒真 / 恒假的 `canRead`。
这三条都会让"没接线"与"接好了"在读数上同形，而那正是
`runtime-host-registrar-row.mjs:1-140` 那段论证在防的东西。

---

## 4. 下一个阻塞点（③）：引擎绑上了，第一次读模型就会停

**任务要求**：不要修，只查有没有**合法**来源。结论：**有，而且就在 Runtime 进程里**。

### 4.1 现象与证据

```
runtime/adapters/dsh/port.mjs:27      currentModelSelection(): { provider, model, ... }   ← 端口契约里**已登记**
runtime/adapters/dsh/port.mjs:47      OPTIONAL_PORT_METHODS = ['currentModelSelection', 'subscribeRun', 'listModels']
runtime/adapters/dsh/index.mjs:250    if (typeof host.currentModelSelection !== 'function') return null
runtime/adapters/dsh/index.mjs:455-457 selection = await adapter._selection(); === null → MODEL_UNAVAILABLE
runtime/adapters/dsh/index.mjs:478    该次运行以终态失败结算（不是崩溃）
```

而**生产**给这个端口的地方（`runtime-host-registrar-row.mjs:583-588`）只返回：

```js
runtimeHost = Object.freeze({
  startRun: (provider, options) => subagents.start(provider, options),
  probeRuntime: () => probe(ctx, { readVersion }),
})
```

**没有 `currentModelSelection`**。而它在端口契约里是**可选**方法（`:47`），
所以 `assertHostPort` 不会拦——于是它一路走到 `_selection() → null →
MODEL_UNAVAILABLE`。**这就是"引擎绑上之后的第一个读数"。**

`runtime/` 里所有出现 `currentModelSelection` 的地方（`grep` 读数）**清一色是测试替身**：
`adapter.test.mjs:69-73`、`e2e-assembly.test.mjs:67`、`session-boundary.test.mjs:43`、
`bootstrap.test.mjs:56`、`parity.test.mjs:86`、`root.test.mjs:139`。
**没有一个生产来源。**

### 4.2 合法来源**存在**：`agentDefaultModel` 是 DSH 的一等公民服务

这是本批查出来的、值得单独记的一件事：**引擎自己就把"当前默认模型"做成了一个
Cordis 服务**，而 Runtime 进程**就是**一个 DSH 宿主进程。

```
D:\project\DSH\dsh\deepseek-harness\packages\core\agent-default-model\src\index.ts:64
  export class AgentDefaultModelConfig extends Service {
D:\project\DSH\dsh\deepseek-harness\packages\core\agent-default-model\src\index.ts:73
  super(ctx, 'agentDefaultModel')
D:\project\DSH\dsh\deepseek-harness\packages\core\agent-default-model\src\index.ts:90
  currentSelection(): ModelSelection { return selection(this.source()) }
```

它由**基础组合层**挂载（也就是 Runtime 进程必然挂载的那一层）：

```
D:\project\DSH\dsh\deepseek-harness\packages\bundle\base\cordis.patch.yml:73-79
  # The transport-independent default for Agents created by entry points.
  # Settings may supply a saved selection; consumers read it at creation time.
  - id: agent-default-model
    name: '@deepseek-ai/dsh-agent-default-model'
    config:
      provider: deepseek-official
      model: deepseek-flash
```

旁证两条（同一读法的既有实践）：
`plugins/src/index.ts:67` 的 inject 列表里**已经有** `agentDefaultModel`，
并在 `:909` 等处调 `ctx.agentDefaultModel.currentSelection()`；
DSH 自己的 headless bundle 也是这么读的
（`packages/bundle/headless/src/index.ts:175-180`）。

**所以**：Runtime 进程有一个**合法**的 `currentModelSelection` 来源——
`ctx.get('agentDefaultModel').currentSelection()`。它**不是**替身、不是默认值、
不是编的：它是引擎作者为这件事提供的服务，配置就在组合层里，
而且用户设置（`$DSH_HOME/settings.yaml` 的 `agent-default-model:` 段）会**热覆盖**它
（`index.ts:76-83` 的 `ctx.inject(['settings'], ...)`）。

**因此 ③ 的结论是**：不是"没有合法来源"，而是"**有来源、没人读**"。
修法方向（本批**不做**）：在 `runtime-host-registrar-row.mjs:583-588` 的工厂里，
把 `currentModelSelection: () => ctx.get('agentDefaultModel')?.currentSelection() ?? null`
接进 `runtimeHost`。**不**发明模型名、**不**回落成一个写死的 provider/model。

这条也解释了为什么 `agentDefaultModel` 缺席时必须是 `null → MODEL_UNAVAILABLE`
而不是抛错：`_selection()` 已经这么处理了（`index.mjs:250`），行为本身是对的，
**缺的只是生产者**。

---

## 5. 破验（我动了生产代码，然后还原）

只靠"套件全绿"不能说明断言**有效**——一条永远为真的断言也是绿的。
所以对三处关键判据各做了一次**临时**变异（全部已还原；`git diff --cached --stat` 最终只余
三个新增文件 = 本文 + 两个套件，生产代码 0 行改动）：

| 变异 | 位置 | 结果 |
|---|---|---|
| M1：往 RunRequest 里塞 `readableSourceIds: ['goal:measure']` | `orchestrator/worker/executor.mjs:430` 附近 | **A2 与 C 变红**（`expect [] / actual ['readableSourceIds']`）。A 仍绿——它只读线上字节。 |
| M2：往交给 `canRead` 的对象里塞 `authorization: null` | `orchestrator/worker/context-stage.mjs:340` | **B 变红**（键集从 3 个变 4 个）。 |
| M3：往 `claim()` 的返回值里塞 `canReadIds: ['goal:cra']` | `team-hub/run-store.mjs:1013` 附近 | **① 变红**（真 claim 的键集从 8 个变 9 个）。 |

M3 有一个**值得记下的副产品**：变异期间 **② 仍然绿**——因为 `defaultRequestFor`
是逐字段挑值的，它不转发 lease 上的任意字段。也就是说即使 lease 将来真带了授权，
**请求构造器这一层还会把它丢掉**。这条边界在两个地方同时是关着的，
而这是**读数**，不是推断。

---

## 6. 诚实边界（这一批**没有**证明的东西）

按重要性排序，每一条都必须当成"未知"来用：

1. **"绑定通过自检" ≠ "真引擎执行了真任务"。**
   本批**没有**让任何引擎跑过一次真实 Attempt。A/B 两个读数里的 `execute` 走的是
   **契约服务端 + 桩适配器**（真 socket、真 wire、真 NDJSON，但适配器是替身），
   不是真 `subagent`、不是真模型。本文任何一处都不应被读成"端到端跑通了"。
2. **真 DSH 进程里的读数沿用既有套件，本批只复跑、未新增场景。**
   §2.2 第三段那些读数来自 `runtime-host-registrar-row-dsh-process.test.mjs`
   （上一批所建）。本批**没有**为 `canRead` 新增真进程场景——
   因为 (B) 下没有新的可观测差异可测，硬加一个只会得到一个"恒绿"的场景。
3. **`agentDefaultModel` 在真 Runtime 进程里的存在性，是文件级证据，不是进程内读数。**
   §4.2 引的是 DSH 检出里的类定义与基础组合层 yml。我**没有**起一个挂了
   base bundle 的真 DSH 进程去读 `ctx.get('agentDefaultModel')`——
   既有真进程套件用的是 `bundles: []` 的一次性 profile（刻意不装 bundle），
   在那个进程里这个服务**本来就该缺席**，去那里读会得到一个**误导性**的"不存在"。
   所以这一条我按"文件+行号证据"给，并在此标出它的等级。
4. **用例里的 lease 与生产里的 lease 是同形的，但"同形"靠的是一个自检。**
   两个套件里都写了键集自检（`claimedLease()` 里的 `assert.deepEqual`、
   ① 的整体比较）。自检漂了会红——但它防不住"`claim()` 与用它的人都改了"。
   M3 是这一条的正面证据：改动确实被咬住了。
5. **`runtime/` 不在 `scan.mjs` 的 `PROCESSES` 里。**
   所以 `node scripts/config/scan.mjs --check` 绿**不能**当作新 `runtime/` 代码的证据
   （`runtime/dsh-composition/can-read-authorization-boundary.test.mjs` 落在这一侧）。
   被 scan 覆盖的**只有** `orchestrator/worker/can-read-authorization-source.test.mjs`
   那一侧，以及本批未改动的既有文件。见 §7.2。
6. **`authorized(req)` 在 hub token 为空时恒放行**（`team-hub/server.mjs:4132-4139`）。
   本批**没有**去判定生产部署里那个 token 是否配了。这是一条与本文问题正交、
   但同样属于"没接线与接好了可能同形"的风险，记在这里以免被当成已核对过。
7. **"(A) 的形状合法"是结构判断，不是"应该按 (A) 做"。**
   即使将来授权真的随请求到达，也仍然要回答"同一份授权被评估两次，两次不一致怎么办"。
   本文只论证前者，没有设计后者。

---

## 7. 本批改了什么、验证了什么

### 7.1 变更清单

**新增测试**（两处，按层级分开——`runtime/` 不得 import `team-hub/`）：

- `runtime/dsh-composition/can-read-authorization-boundary.test.mjs`
- `orchestrator/worker/can-read-authorization-source.test.mjs`

**新增文档**：本文 `docs/superpowers/prt/PRT-253-can-read-authorization.md`。

**生产代码：零改动。** 最终 `git status --porcelain` 恰好三行、全是 `A `（新增），
没有任何 `M` / `D`：
（破验期间的临时变异已全部还原，见 §5。）

```
A  docs/superpowers/prt/PRT-253-can-read-authorization.md
A  orchestrator/worker/can-read-authorization-source.test.mjs
A  runtime/dsh-composition/can-read-authorization-boundary.test.mjs
```

`git diff --cached --stat`：

```
 .../prt/PRT-253-can-read-authorization.md          | 484 +++++++++++++++++++++
 .../worker/can-read-authorization-source.test.mjs  | 144 ++++++
 .../can-read-authorization-boundary.test.mjs       | 333 +++++++++++++++++++++
 3 files changed, 961 insertions(+)
```

### 7.2 覆盖边界（必须一起读）

| 门禁 | 覆盖 `runtime/` 新码？ |
|---|---|
| `scripts/config/scan.mjs --check` | **否**。`PROCESSES` 里没有 `runtime`（只有 team-hub / workbench / whiteboard / plugins / board-plugin / services-plugin / product / orchestrator）。绿 ≠ 对 `can-read-authorization-boundary.test.mjs` 的背书。 |
| `scripts/ci/dsh-boundary.mjs --check` | **是**。它按前缀判，`runtime/dsh-composition/` 是允许的适配器前缀，`runtime/contracts/`、`orchestrator/` 是 MUST_BE_ZERO。 |

### 7.3 门禁复跑（`git add -A` 之后，`DSH_CHECKOUT` 已设，逐条原始输出）

```
=== 1. node scripts/config/scan.mjs --check ===
scan: PASS（全部 env 读取点与疑似字面量均已处理；共 558 个疑似字面量）      [exit=0]

=== 2. node scripts/ci/ci-syntax.mjs ===
ci-syntax: PASS（50 个脚本全部可被 Node 解析）                              [exit=0]

=== 3. node scripts/ci/encoding-check.mjs --all --quiet ===
encoding-check: PASS（1920 个文本文件：无 U+FFFD；代码/配置无 NUL 字节；
  37 个历史采集物为 UTF-16，已列出）                                        [exit=0]

=== 4. node scripts/ci/check-docs.mjs ===
  历史 evidence banner 覆盖完整（docs/ 下证据快照目录全部标注）
check-docs: PASS（README.md + docs/FEATURES.md 结构/链接/索引一致，10 类校验项全绿）  [exit=0]

=== 5. node scripts/ci/dsh-boundary.mjs --check ===
dsh-boundary: PASS（执行面依赖未增长：3 个文件 / 26 处，均在基线内）          [exit=0]

=== 6. node scripts/prt/topology-inventory.mjs --diff ===
topology-inventory: 与清单一致（无漂移）                                     [exit=0]

=== 7. node scripts/prt/baseline-snapshot.mjs --check ===
baseline-snapshot: 平台契约与基线一致（无漂移）                               [exit=0]
```

两点必须与读数一起读：

- **scan 的绿对本批只有一半效力。** 两个新文件里，只有
  `orchestrator/worker/can-read-authorization-source.test.mjs` 落在被扫的
  `orchestrator` 进程里（它是 `git add` 之后才纳入的，所以 §2.2 的复跑早于 `add`，
  而 §7.3 这一次是纳入后的）。另一个落在 `runtime/`，**不在** `PROCESSES` 里（见 §7.2）。
  本批没有新增 env 读取，也没有新增字符串字面量式的具名码，所以两个进程都不需要新的
  `nonEnvLiterals` 声明——这是读数的结果，不是"应该不用"。
- 本批**没有**跑 `scripts/ci/run-ci.mjs`（任务明令禁止），也没有跑 `scripts/prt/*` 的
  破验脚本，也没有跑 `topology-inventory --record`。

**零新增第三方依赖**：本批只用了 `node:test` / `node:assert` / `node:sqlite` / `node:fs` /
`node:os` / `node:path`。`package.json` 未改。

---

## 8. 一句话总结

`canRead` 的判定**做了**、在 **worker** 里做、产物喂给的是 **hub 的装配路由**；
它**没有**、也**无法**随 `execute` 请求到达 Runtime 进程——
所以 Registrar 那条 `RUNTIME_HOST_REGISTRAR_NO_CAN_READ_SOURCE` 拒绝是**对的**，
本批把它测住了而不是绕过去。而引擎一旦真的绑上，下一个读数会是
`MODEL_UNAVAILABLE`：那个**合法**来源（`agentDefaultModel`）已经在 Runtime 进程里，
缺的只是有人去读它。
