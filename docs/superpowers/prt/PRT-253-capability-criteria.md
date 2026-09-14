# PRT-253 能力判据批：三项必需能力、强制面判定住在哪里，以及为什么本批**什么都不改**

> 本文回答一个问题，并**只**回答这一个问题：
>
> **把 `runtime-host-registrar-row.mjs` 四项必需能力里那三项
> （`tool-permission-enforcement` / `cancel-and-timeout` / `usage-reporting`）
> 读成 `satisfied: true`（或把它们从必需集合里挪走），有没有一条**不乐观**的路？**
>
> 结论：**今天没有。本批的结论是 (C)——保持阻塞。**
> · **(A)** 被**顺序**否掉：那份"强制面已生效"的判定在能力探针跑的时候**还不存在**（§2），
>   而且即使把它接上，也**一点儿都不解阻**（三项里只动了 1 项，另外 2 项仍然 false）。
> · **(B)** 的方向是**真的**（spec 行 266 的 `degraded` 就是为这种处境写的，而且 Legion
>   已经把它实现了一大半），但把它搬到这条路上需要三样**今天不存在**的东西 + 回答一条
>   spec 张力，比"窄改"大得多。按批前约定：**不实现，写成提案**（§4）。
> · 本批**没有改任何生产代码**。改动只有一个已登记的测试文件加了两条读数（§6）。
>
> 本文不是"引擎接好了"的交付说明。它是**这条阻塞的界桩**：
> 三个否掉的选项各自否在哪个读数上、哪一条分界今天**说不清**（§5）、
> 以及"什么变了才算解开"的可执行清单（§4.4）。

---

## 0. 一句话结论

| 问题 | 读数 |
| --- | --- |
| 强制面"生效了吗"到底由谁判？ | 启动自检 `startupSelfCheck()` 的三个条目（§1），不是能力探针 |
| 那份判定在 `runtimeCapabilityEvidence()` 跑的时候在不在？ | **不在**。探针**先**跑（`probeRuntime -> startupSelfCheck`，§2） |
| 那能不能让能力去引用它？ | 引用面不存在：探针拿不到 `composition` / `sandbox`，只能自己再读一遍树（=第二份读数） |
| 就算接上了，能解阻吗？ | **不能**。三项里只动 1 项；`cancel-and-timeout` / `usage-reporting` 仍然 false |
| 那 `degraded`（行 266）能不能承载"部分能力不可用"？ | 判据在（`product/runtime-state.mjs` 全表 + 用例），**喂给它的人不在**，而且**任务侧没有"这任务需要哪些运行时能力"的声明面** |
| 本批改了什么？ | 一个已登记测试文件（+2 条读数）+ 本文档。生产代码 **0 行** |
| 结论 | **(C) 保持阻塞**；(A) 否掉；(B) 提案化 |

---

## 1. 强制面判定住在哪里（file + line）

三样东西**各自**判一次，全部在 `runtime/dsh-composition/selfcheck.mjs` 的
`startupSelfCheck()`（`:134`）里：

| 自检条目 | 判据 | 位置 |
| --- | --- | --- |
| `composition-patch-layer` | `reconcilePatchLayer(composition).effective` | `selfcheck.mjs:139-147`；判据体在 `patch-layer.mjs:248-315`（`:311` 是 `effective = 所有 finding 都 effective`，含 `:280-306` 的 preset 表判据） |
| `sandbox-enforcement` | `probeSandbox(sandbox).effective` | `selfcheck.mjs:159-167`；`probeSandbox` 在 `:54-…`，**硬判据是 `enforcement === 'full'`**（`:95-99`，规则写在 `:20`：「`partial` 一律判未生效」） |
| `enforcement-mapping` | `assertMappingConsistent({primitives:{'selfcheck.mjs':{probeSandbox}}}).ok && unresolvedPrimitives.length === 0` | `selfcheck.mjs:183-196`；注意这里 `probeSandbox` 只被检查**存在**，**不**被调用（沙箱探测全程只跑一次，就在 `:159`） |

结论汇总在 `selfcheck.mjs:250-258`：

```js
const failed = checks.filter((c) => !c.ok)
return {
  state: failed.length === 0 ? SELFCHECK_STATES.effective : SELFCHECK_STATES.incompatible,
  autoExecutionForbidden: failed.length > 0,   // :256
  ...
}
```

这三条的**输入**由补丁行自己读：`runtime-host-row.mjs:477-484` 用
`observeComposition(ctx)` 读 `ctx.loader.entries()` 得到 `{rows:[{id,activated}],permissionPresets}`，
`:486-492` 读 `ctx.get('sandbox')`，然后 `:494` 把两样一起交给 `root.bootstrap({runtimeHost, composition, sandbox, canRead})`。

**所以"Legion 的强制面是不是真的生效"这句话，在全仓库只有一个判定点：
`startupSelfCheck()` 的 ①②③ 三条合起来的 `state` / `autoExecutionForbidden`。**
能力探针里的三项 `false` 是**同一件事的第二次表述**，而它引用的就是这三条
（`runtime-host-registrar-row.mjs:526` 的 `source` 字段逐字写着这一点）。

---

## 2. 顺序：那份判定在能力探针跑的时候**还不存在**

这不是"我们不想引用"，是**引用不到**。读数（原始输出见 §7.0）：

```
ORDER probeRuntime -> startupSelfCheck
BOOT_OK true
BOOT_STATE enforcement-effective
BOOT_FAILED_CHECKS (无)
```

调用链（每一跳一个文件）：

| # | 位置 | 发生了什么 |
| --- | --- | --- |
| 1 | `bootstrap.mjs:247` | `probed = await probeFactory(runtimeHost ?? {})` ← **能力表在这里产生** |
| 2 | `probe.mjs:93` | `raw = await host.probeRuntime()` |
| 3 | `runtime-host-registrar-row.mjs:590-601` | `probeDshRuntime(ctx)`：`:594` 调 `runtimeCapabilityEvidence(ctx)` |
| 4 | `bootstrap.mjs:264-273` | `run({composition, sandbox, runtime: {ok: probed.ok, ...}})` ← **自检在这里才算** |

即：**第 3 步（能力表）严格早于第 4 步（判定）。**

还有一条更硬的：这个顺序**不能简单反过来**。自检的第 ② 项
（`runtime-probe`，`selfcheck.mjs:150-156`）吃的正是 `probed.ok`
（`bootstrap.mjs:268`），而 `probed.ok` 由能力表算出来
（`probe.mjs:121-124`：`requiredMissing.length === 0 && versionCheck.compatible`）。
把整个自检搬到探针之前 = 让判定吃自己的输出。**能前置的只有不依赖 `runtime` 的那几条
（① `composition-patch-layer`、③ `sandbox-enforcement`、④ `enforcement-mapping`，
以及 ⑤ `guard-approval-consistency`、⑥ `enforcement-availability`）**，
把其中三条拆出来当"一份测量"两处用，那是另一件事（见 (A) 的三条否掉理由）。

---

## 3. (A) 为什么**不施行**

批前给的施行条件是「*当且仅当*自检的强制面判据**在那一刻真的已经算出且可用**」。
逐条：

### 3.1 引用面不存在（顺序）

见 §2。在 `runtimeCapabilityEvidence()` 被调用的那一刻，`reconcilePatchLayer()` /
`probeSandbox()` 的结果都还没算。**(A) 的前置条件不成立，按批前约定：保持 `false` 并报告。**

### 3.2 "把它接上"只有两种接法，两种都不合规

真要接，只能：

- **(i) 让它自己再判一次**：`runtimeCapabilityEvidence(ctx)` 里自己调
  `observeComposition(ctx)` + `ctx.get('sandbox')` + `reconcilePatchLayer` + `probeSandbox`。
  那就是**第二次读同一棵树、第二次跑沙箱探测**——批前明确禁止（"do not run the
  sandbox probe a second time"），而且这正是 `runtime-host-registrar-row.mjs:527-529`
  那句话禁掉的东西：**两份判定会漂移**。
- **(ii) 让 bootstrap 先算、再注入**：把不依赖 `runtime` 的那几条（①③④⑤⑥）拆成
  可前置的"强制面测量"，
  `bootstrap` 先算它、再把它当作参数喂进探针、再让 `startupSelfCheck` **复用**同一个结果。
  这条路技术上成立，代价是三处新形状：`startupSelfCheck` 多一条"已注入"的调用路径
  （而它今天有 5 个以上调用点/用例走的是"自己算"那条）、端口方法 `probeRuntime()`
  变成"可带一个额外参数"（`port.mjs` 的契约声明里没有它）、以及补丁行侧要再多一条
  注入通道。**这不是"引用那一份既有判定"，是造一条新的测量管道。**

### 3.3 就算接上了，也不解阻

`checkCompatibility`（`contracts/adapter.mjs:108-118`）的判据是**任一**必需能力缺失即
`UNSUPPORTED_CAPABILITY`。把 `tool-permission-enforcement` 接上只动了 4 项里的 1 项，
`cancel-and-timeout` / `usage-reporting` 仍然 false ⇒ `probe.mjs:124` 的
`ok` 仍然 false ⇒ `runtime-probe` 项仍然红 ⇒ `autoExecutionForbidden` 仍然 true
⇒ 补丁行**照样不能**进静态补丁层。（实测：`COMPAT_PARTIAL` 一节，§7.0）

**(A) 是"把 1/4 变成 2/4"，不是解阻。** 用一批的代价换一个不改结论的读数，
还要往已经"零 DSH import"的目录里加一条注入通道——不值得，而且有漂移风险。

---

## 4. (B)：方向是真的，但今天搬不动

### 4.1 判据在（这是真的）

| 东西 | 位置 | 状态 |
| --- | --- | --- |
| spec 行 266 那张表 | `docs/superpowers/specs/2026-09-11-legion-product-runtime-design.md:266` | 「`degraded`｜部分能力不可用｜只认领其必需能力全部满足的任务」 |
| 六态 + 认领策略全表 | `product/runtime-state.mjs:95-104`（`CLAIM_POLICY.degraded`：`claimScope: 'required-capabilities-only'`、`digitalWorkerOnline: false`） | **实现完整** |
| 判据函数 | `product/runtime-state.mjs:206-233`（`mayClaimTasks`） | **实现完整**：不给判据 ⇒ 一个都不认领；给 ⇒ 只认领 `eligible` 里的 |
| 健康态行为表 | `runtime/contracts/adapter.mjs:148-152`（`HEALTH_BEHAVIOR.degraded`） | **实现完整** |
| 到 worker 认领闸门的接线 | `product/orchestrator/claim-gate.mjs:66-77`（`o.satisfiedCapabilities ?? null` 原样喂给 `mayClaimTasks`） | **接线在** |
| 用例 | `product/runtime-state.test.mjs:147-165` | 绿 |

### 4.2 缺的是什么（三样，都是"人不在"不是"码不在"）

**缺失 ①：`satisfiedCapabilities` 没有生产者。**
全仓库 17 处 `satisfiedCapabilities`：`runtime-state.mjs`（读）、`claim-gate.mjs:62,74`（原样透传）、
用例 3 处、文档/CI 注释若干。**没有一处生产代码在算它。**
`claim-gate.mjs:66` 的默认值就是 `getOverrides = () => ({})`。
这条**操作者自己已经记下来了**：`scripts/ci/run-ci.mjs:509`
「`degraded` 的 `satisfiedCapabilities` 同理：判据在，喂给它的人还没有」，
`docs/superpowers/prt/PRT-711-claim-gate-wiring.md:197` 同句。

**缺失 ②：任务侧没有"这任务需要哪些运行时能力"的声明面。**
`RunRequest` 的 15 个必填字段里**一个能力字段都没有**
（`runtime/contracts/run.mjs:65-82`；`permissions` 只有 `{preset, tools}`，`:121-129`）。
而 `REQUIRED_CAPABILITIES`（`contracts/adapter.mjs:39-48`）那四个名字
（`tool-permission-enforcement` / `cancel-and-timeout` / `structured-result` / `usage-reporting`）
与产品里另一套同名的"能力"（`runtime/packs/manifest.mjs:1175` 的
`requestedPermissions.capabilities`，是 `file:read` 那种**权限** id）**不是同一个命名空间**。
⇒ 「只认领其必需能力全部满足的任务」这句话，今天**算不出来**：
得先回答"一个任务凭什么说自己需要 `usage-reporting`"，而那是一条**新契约**
（spec 里也没有，spec 全文只有 `:173` 一个 `getCapabilities(): Promise<RuntimeCapabilities>` 声明，
`:230` 一句话说必需能力缺失要报 `UNSUPPORTED_CAPABILITY`，**没有任何地方定义逐任务的能力需求**）。

**缺失 ③：没有"已接线但部分能力"这一档。**
`product/orchestrator/claim-gate.mjs:45-55` 的 `runtimeStateFromExecutor` 只有两条出口：
`wired === true → 'ready'`（= `mayClaimTasks('ready')` ⇒ **全认领**），
其余 → `unavailable`。实测：

```
WIRED_PROCESS_STATE ready
WIRED_CLAIM {"mayClaim":true,"scope":"all"}
```

⇒ 今天只要绑定建立起来，认领闸门就说 `ready`、**认领一切**。
在这条路上加 `degraded`，必须先在"已接线"里分出"部分能力"这一档，
并且把能力表喂进去——否则**把三项目前让整条绑定失败的 false 变成"能跑"，
就等于让引擎在一个缺能力的进程上认领它不该认领的任务**。
那正是行 230「不得静默降级」禁止的形态。

**缺失 ③′（同一条线，跨进程那一侧）：线协议上也没有这一档。**
`runtime-contract-server-row.mjs:244-255` 的 `verdictFromRuntimeHostBinding()` 只在
绑定 `ok === true` 时给出 `{autoExecutionForbidden: false, ...}`，否则 `null`
（`:84-88` 是作者写下的诚实边界：这一行**分不开**"行没挂"与"行挂了但自检拒绝"）；
`orchestrator/worker/executor-binding.mjs:484-503` 收到 `null` ⇒ 具名拒绝。
`{ok:false, code, ...}` 的绑定结论今天**不发布服务**（`runtime-host-row.mjs:515-533` 只在成功路径 `provide`）。

### 4.3 一条必须同时回答的 spec 张力（这是本批**不能**顺手解决的原因）

- 行 230：「次版本能力通过 `RuntimeCapabilities` 探测；**任何必需能力缺失都返回
  `UNSUPPORTED_CAPABILITY`，不得静默降级**。」
- 行 266：「`degraded`｜部分能力不可用｜只认领其必需能力全部满足的任务。」

两条只能同时成立，当且仅当能力分成**两层**：
"缺了就整个引擎不受支持"（第一层，行 230）与"缺了只影响需要它的任务"（第二层，行 266）。
今天 `REQUIRED_CAPABILITIES` 是一张**平表**，被当成第一层用
（`adapter.mjs:108-118`）；`OPTIONAL_CAPABILITIES`（`:51-57`）的语义是
"缺失时禁用对应**产品功能**，而不是报错"，**不是**"只认领需要它的任务"。
把 `cancel-and-timeout` / `usage-reporting` 从第一层挪到第二层，
是一次**产品级的能力分类决策**，并且要把"对应功能被禁用"落到具体位置，例如：

- `usage-reporting` 缺失 ⇒ 事后预算检查读到的是**"确认没超"**：
  `usage.mjs:161` 的 `if (!usage) return null`，而 `null` 的含义是"确认没超"
  （模块自己的注释 `:149-157` 正是在讲这个陷阱）。实测：
  `CHECKBUDGET_USAGE_NULL null`。上游 `collectUsage()` 在引擎的真实结果形状上返回 `null`
  （`COLLECT_USAGE_ON_ENGINE_RESULT_SHAPE null`）；结算侧 `budget-gate.mjs:85-90`
  的 `tokensOf` 拿到 `{tokensIn:null,tokensOut:null}`。
  （**注意两件事**：① 事先的**预留**闸门不依赖 usage，它照常工作，
  这里失效的是**事后**那一次判定；② 这一条我只追到
  `adapter（index.mjs:624）`把 `budgetHit` 收下来，**没有**追完整条生产消费链，
  见 §9。）
- `cancel-and-timeout` 缺失 ⇒ 适配器的看门狗是**补偿**，不是引擎保证
  （`port.mjs` 文件头记录的生产故障；`runtime-host-registrar-row.mjs:535-537` 引的就是它）。

§5 说明为什么这两项的分界**今天不能**被合并成一句"反正是 Legion 补偿的"。

### 4.4 (B) 的提案：什么变了才算解开（可执行清单）

以下每一条都是**独立的一批**，且每一条都必须带自己的读数：

1. **给"任务需要哪些运行时能力"一个契约面。**
   在哪一层放（`RunRequest` / Task / EmployeeManifest / TeamPlan）要先论证；
   四个能力名与权限 id 的关系要写明；`validateRunRequest` 要能拒绝
   "声明了需要某能力但没人能判它"的请求。
2. **给 `satisfiedCapabilities` 一个生产者。**
   它必须是**逐任务**算出来的（对着 ① 的声明面），而不是"这个进程有哪些能力"的全局表；
   `claim-gate.mjs` 的 `getOverrides` 要从真来源接，不是默认 `() => ({})`。
3. **在 `runtimeStateFromExecutor` 里分出"已接线但部分能力"这一档，**
   并把能力表带进去（今天 `wired → ready`）。
4. **把这一档接到线上协议**（`/enforcement` 或 `getHealth`）：
   服务端要能回答"绑定了、但只有哪几项能力"，客户端要能把"没有这一档"与
   "这一档是空的"分开（照 `runtime-contract-server-row.mjs:84-88` 那条诚实边界的做法）。
5. **回答行 230 vs 行 266 的分层**：哪一项是第一层（缺了即 `UNSUPPORTED_CAPABILITY`），
   哪一项是第二层（缺了只缩小认领范围），以及被禁用的产品功能各是什么。
   **这一条是产品决策，不是实现细节。**
6. **（可选，但本批实测到的一条路）`usage-reporting` 也许不必依赖结果 seam。**
   DSH 会话转录里**确实记着** provider 上报的 usage
   （`scripts/prt/dsh-session-usage.mjs:4-14`：从 `.jsonl.zstd` 逐帧解出 usage，
   并校验 `totalTokens = inputTokens + outputTokens + cacheReadTokens`）。
   但那是**证据脚本**、读的是**另一个存储**，不是生产路径，也**不**改变今天的读数：
   `SubagentResult` 只有 `{output, structured?, diagnostic?, stopReason}`，**没有** usage 字段
   （本批在 DSH 检出里逐字读过：`D:\project\DSH\dsh\deepseek-harness\packages\subagent\subagent\src\types.ts:271-297`）。
   要走这条路，得先有一批把会话转录读取接进生产、并证明它给的是**这一次 run** 的用量。

---

## 5. 那条"引擎保证 vs Legion 补偿"的分界：**今天说不清的地方就说说不清**

批前的硬要求：不能把"引擎保证它"与"Legion 替它补"合成一句。逐项：

| 能力 | 引擎保证吗？ | Legion 补偿吗？ | 本批的判定 |
| --- | --- | --- | --- |
| `structured-result` | **是**（provider 自报 `capabilities.outputSchema`，且 `start()` 真的按它拒收：DSH 检出 `packages/subagent/subagent/src/index.ts:640-657` 的 `assertCapabilities`，缺能力即 `UNSUPPORTED_CAPABILITY`） | 不需要 | 具备（唯一一项有真来源的） |
| `tool-permission-enforcement` | **不是引擎的能力**：DSH 侧没有 Legion 语义的强制面；实现它的是 Legion 自己的补丁层 | **是**（guard / pre-execute / answerer） | **未确认**——它由自检判，而自检的判定在探针跑的时候还不存在（§2）。**这不等于"引擎没有它"，也不等于"它有"**：它是一句"这件事由别人判，而这里读不到那个结论" |
| `cancel-and-timeout` | 契约**声称**能（`request.signal` / `run.dispose()`），仓库记录了**相反**的现场事实 | **是**（适配器看门狗） | **未确认**。**分界未决**：没有任何读数说明"看门狗对记录里那次挂死是否真的收得住"。在拿到那个读数之前，把这一项报 true 就是把"补偿存在"读成"保证成立" |
| `usage-reporting` | **否**：结果契约上没有用量字段（`SubagentResult` 四个字段，本批在 DSH 检出里逐字读过） | **否**（生产路径上没有） | **未确认**。这一项**不是**分界未决，是**两侧都缺**：`collectUsage()` 在真实结果形状上返回 `null`。剩下的只是 (B) 的第 5 条（它到底该不该是"必需"） |

**一句话**：`cancel-and-timeout` 的分界**未决**（引擎声称有、仓库记录它没有、
Legion 有补偿但补偿的有效性没有读数）；`usage-reporting` 的分界**是清楚的**（两侧都没有）。
本批**不**把前者合并成"反正有人补"，也**不**把后者说成"也许某天会到"。

上一批在**真 DSH 进程**里的读数与这张表一致（`PRT-253-runtime-host-inputs.md` §4 `:175`）：
`caps={"tool-permission-enforcement":false,"cancel-and-timeout":false,"structured-result":true,"usage-reporting":false}`。

---

## 6. 本批改了什么 / 没改什么

**改（1 个文件，测试面）：**

- `runtime/dsh-composition/plugins/runtime-host-registrar-row.test.mjs`
  —— 该文件**已经登记**在 `scripts/ci/run-ci.mjs:1315`，所以没有"新文件漏登记"的风险。
  新增第 F 节两条读数（`tests 31 → 33`）：
  1. **强制面判定生效时，能力表里那一项仍是"未确认"**（判定 `composition-patch-layer` /
     `sandbox-enforcement` 都 `ok: true`，能力仍是 `false` + 具名码），
     并显式断言**两个读数不同**（`assert.notEqual`）。
  2. **反向控制**：把判定弄坏（砍掉一行补丁行）→ 自检那一项必须真的变红，
     而能力的判据码**一字不变** ⇒ 能力表**不跟**那份判定动。
  这两条把"顺序边界"钉成读数：谁哪天把能力接到那份判定上（无论接对还是接错），
  这里都会红，逼他回答"那份判定在探针跑的时候到底存不存在"。
  **红-验证**：临时把 `satisfied: false` 改成 `true` ⇒ 该节 2 条 + 既有 1 条共 3 条红
  （`tests 33 / pass 30 / fail 3`），随后**逐字还原**（`git status` 只剩这一个测试文件）。

**没改（生产代码 0 行）：**

- `runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs` 一个字未动：
  三项仍是 `satisfied: false`，三个具名码一字不改。
  理由就是 §3.1：**(A) 的前置条件不成立**。
- `bootstrap.mjs` / `selfcheck.mjs` / `patch-layer.mjs` / `product/runtime-state.mjs` /
  `product/orchestrator/claim-gate.mjs` / `run.mjs`：一字未动。
  (B) 是提案（§4.4），不是实现。
- 批前点名不给动的那些（`docs/STATUS.md`、`PRT-PROGRESS.md`、`scripts/ci/run-ci.mjs`、
  `PRT-IMPLEMENTATION-REPORT.md`、`legion-host.patch.yml`、`product/process-manifest.mjs`、
  `product/launcher/*`）：**全部未动**。

**新增文件：**

- `docs/superpowers/prt/PRT-253-capability-criteria.md`（本文）
- 新增 `*.test.mjs`：**无**（新读数加在既有已登记套件里，见上）

**批外的一次性测量脚本（不是交付物，在 worktree 之外）：**

- `.worktrees/_prt-handoff/prt253-capability-criteria-probe.mjs`
  （`git ls-files` 看不见它；`node --check` 通过；不启动任何子进程、不开任何监听）

---

## 7. 证据与门禁读数（原始输出）

### 7.0 一次性测量脚本

```
$ node .worktrees/_prt-handoff/prt253-capability-criteria-probe.mjs
=== ① 顺序：能力探针在启动自检之前 ===
BIND_CAN_READ_KIND null
ORDER probeRuntime -> startupSelfCheck
BOOT_OK true
BOOT_STATE enforcement-effective
BOOT_FAILED_CHECKS (无)

=== ② 缺口：强制面判定说生效，能力表说未确认 ===
GREEN_STATE enforcement-effective
GREEN_ITEM_composition-patch-layer true
GREEN_ITEM_sandbox-enforcement true
GREEN_ITEM_enforcement-mapping true
GREEN_AUTO_EXECUTION_FORBIDDEN false
GREEN_CAP_structured-result true
GREEN_CAP_tool-permission-enforcement false
GREEN_EVIDENCE_tool-permission-enforcement RUNTIME_HOST_REGISTRAR_CAPABILITY_ENFORCEMENT_PLANE_MEASURED_ELSEWHERE
TWO_READINGS_DIFFER {"selfCheckSaysEffective":true,"capabilitySaysUnconfirmed":true}
BROKEN_ITEM_composition-patch-layer false
BROKEN_STATE incompatible
BROKEN_CAP_tool-permission-enforcement false
BROKEN_EVIDENCE_tool-permission-enforcement RUNTIME_HOST_REGISTRAR_CAPABILITY_ENFORCEMENT_PLANE_MEASURED_ELSEWHERE

=== ③ (B) 的缺口：degraded 的判据在，喂给它的人不在 ===
DEGRADED_POLICY {"mayClaim":true,"claimScope":"required-capabilities-only","digitalWorkerOnline":false}
DEGRADED_NO_CRITERIA {"claim":false,"scope":"none"}
DEGRADED_WITH_CRITERIA {"claim":true,"scope":"required-capabilities-only","eligible":["task-1"]}
WIRED_PROCESS_STATE ready
WIRED_CLAIM {"mayClaim":true,"scope":"all"}
RUN_REQUEST_REQUIRED runId,attemptId,idempotencyKey,workspaceId,goalId,taskId,employeeId,teamPlanRef,contextSnapshotRef,modelProfileRef,budget,timeoutMs,workdir,permissions,expectedOutput
RUN_REQUEST_CAPABILITY_FIELDS []
REQUIRED_CAPABILITIES tool-permission-enforcement,cancel-and-timeout,structured-result,usage-reporting
OPTIONAL_CAPABILITIES streaming-deltas,artifact-emission,session-resume,sandbox-enforcement,mcp-tools
COMPAT_PARTIAL {"compatible":false,"code":"UNSUPPORTED_CAPABILITY","missingRequired":["tool-permission-enforcement","cancel-and-timeout","usage-reporting"]}
COLLECT_USAGE_ON_ENGINE_RESULT_SHAPE null
CHECKBUDGET_USAGE_NULL null
TOKENS_OF_NULL_USAGE {"tokensIn":null,"tokensOut":null}

PROBE-OK
```

（脚本里的 `GREEN_*` 输入是**由声明推出来**的：`PATCH_LAYER_ROWS` 每行 `activated:true`
+ `LEGION_PERMISSION_PRESETS` 的键 + 一个真的返回 `enforcement:'full'`、argv 变了、
拒绝签名非空的 `confine`。`fullSandbox()` 是**替身**，但它是"沙箱说它完全管制"的**最有利于**
情形——用它读出来的仍然是"能力表 false"，所以这个读数**不是**靠假件压出来的。）

### 7.1 改动套件

（下面是**尾部节选**——`…` 处是 31 条既有用例，一条未改；完整原始输出见批次报告。）

```
$ node --test runtime/dsh-composition/plugins/runtime-host-registrar-row.test.mjs
…
▶ PRT-253 能力判据批 · 强制面判定在能力探针**之后**才发生
  ✔ ★ 强制面判定生效时，能力表里那一项仍然是"未确认"——两个读数必须不同 (94.6ms)
  ✔ ★ 反向控制：判定变红时能力判据码**一字不变**（能力表不跟着那份判定动） (95.6ms)
✔ PRT-253 能力判据批 · 强制面判定在能力探针**之后**才发生 (190.6ms)
✔ DSH_PACKAGE_NAMES 仍然认 CLI 包与根工作区两个名字 (0.1618ms)
ℹ tests 33
ℹ suites 7
ℹ pass 33
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 389.248
```

### 7.2 门禁

全部在 worktree 根、`DSH_CHECKOUT=D:\project\DSH\dsh\deepseek-harness` 下跑（`git add -A` 之后）：

```
$ node scripts/config/scan.mjs --check
scan: PASS（全部 env 读取点与疑似字面量均已处理；共 558 个疑似字面量）
[exit=0]

$ node scripts/ci/ci-syntax.mjs
ci-syntax: PASS（50 个脚本全部可被 Node 解析）
  其中包含 scripts/ci/run-ci.mjs —— 它是跑门禁的程序，此前它坏掉时六道门禁全绿。
[exit=0]

$ node scripts/ci/encoding-check.mjs --all --quiet
encoding-check: PASS（1923 个文本文件：无 U+FFFD；代码/配置无 NUL 字节；37 个历史采集物为 UTF-16，已列出）
[exit=0]

$ node scripts/ci/check-docs.mjs
  历史 evidence banner 覆盖完整（docs/ 下证据快照目录全部标注）
check-docs: PASS（README.md + docs/FEATURES.md 结构/链接/索引一致，10 类校验项全绿）
[exit=0]

$ node scripts/ci/dsh-boundary.mjs --check
dsh-boundary: PASS（执行面依赖未增长：3 个文件 / 26 处，均在基线内）
[exit=0]

$ node scripts/prt/topology-inventory.mjs --diff
topology-inventory: 与清单一致（无漂移）
[exit=0]

$ node scripts/prt/baseline-snapshot.mjs --check
baseline-snapshot: 平台契约与基线一致（无漂移）
[exit=0]
```

**这些绿各自证明什么、不证明什么**（§8 第 7 条已经写过一遍，这里再点一次）：

- `scan: PASS` 覆盖的是 `team-hub` / `workbench` / `whiteboard` / `plugins` / `board-plugin` /
  `services-plugin` / `product` / `orchestrator` 这 8 个 `PROCESSES`。
  **`runtime/` 不在其中**——所以这条绿**不是**"`runtime/` 下新代码的字面量都已申报"的证据。
  本批在 `runtime/` 下的**生产**新增字面量是 0（生产代码 0 行），
  测试文件里新增的两条断言复用既有导出、没有新 SCREAMING_SNAKE 字面量。
- `dsh-boundary: PASS` 的 `3 个文件 / 26 处` 与批前一致：本批没有新增任何 `runtime/ → team-hub/`
  方向的 import（`runtime/` 侧生产代码 0 行；测试文件新增的两个 import
  ——`../patch-layer.mjs` / `../selfcheck.mjs`——都在 `runtime/dsh-composition/` 内部）。
- `topology-inventory` / `baseline-snapshot` 都是**源码提取**工具，**不**登记 `docs/` 下的文件，
  所以本文档的加入对这两条本来是"无影响"的——它们的绿证明的是"本批没有动到 env 读取面与
  旧平台契约（HTTP 路由 / 表 / 状态机）"，而不是"这份文档被检查过"。
- `ci-syntax` 只解析脚本；`check-docs` 只判 `README.md` / `docs/FEATURES.md` / `docs/STATUS.md`
  与证据快照 banner。**没有任何一道门禁读过本文的结论**——本文的结论由 §7.0 的读数与
  §7.1 的用例承担，不由门禁承担。

---

## 8. 诚实边界

**以下每一条都是真的、且都是限制：**

1. **本批没有解开阻塞，也不声称解开。** `legion-runtime-host` 那一行**仍然不能**进静态补丁层；
   在装了它的部署上，绑定仍然不会建立（`bootstrap.mjs:281-293` 具名拒绝且**什么都不注册**）。
   本批把"为什么"从一句散文变成了三组读数 + 一条可执行清单。
2. **顺序边界是"读出来的"，不是"断言出来的"**：(A) 的前置条件不成立，证据是 §2 的调用链
   （`bootstrap.mjs:247` → `probe.mjs:93` → `registrar-row.mjs:594` **早于**
   `bootstrap.mjs:264`）与 §7.0 的 `ORDER` 读数。**它成立的前提是这份组合没有被改**——
   谁把强制面子集前置了，这条结论就过期，而那正是 §6 那两条用例存在的意义。
3. **"接上它就能解阻"这件事本批没有实测**（因为不施行）。§3.3 的依据是
   `checkCompatibility` 的判据是"任一缺失"（`adapter.mjs:108-118`）这一条**读出来的代码事实**，
   不是跑出来的读数。
4. **`fullSandbox()` 是替身**（§7.0 的括号里写明了）。用真 DSH 进程读到的沙箱 enforcement
   只有 PRT-213 那一批的现场读数，本批**没有**重跑真进程。
5. **本批没有启动任何 DSH 子进程**，因此**没有**给出新的"真进程里能力表读什么"的现场读数；
   那一项沿用上一批在**真 DSH 进程**里的读数（`PRT-253-runtime-host-inputs.md` §4，
   `:156-176` 的 S 场景：
   `PROBEDCAPS {"tool-permission-enforcement":false,"cancel-and-timeout":false,"structured-result":true,"usage-reporting":false}`）。
   **本批的新读数全部在进程内。**
6. **`degraded` 这一档本批只做了静态证据**（读 + 现有用例），**没有**做任何端到端实验，
   证明"把它接到这条路上会表现出只认领合格任务"。§4.2 的三块缺失是按代码读出来的，
   不是跑出来的——但它们都是**缺席**（"没有生产者"、"没有字段"、"没有这一档"），
   缺席可以用枚举证明，这一点本批做到了（§7.0 的 `WIRED_PROCESS_STATE ready` /
   `RUN_REQUEST_CAPABILITY_FIELDS []` / 17 处 `satisfiedCapabilities` 全在测试与注释里）。
7. **`scan` 门禁的覆盖面对本批是空的**：`runtime/` **不在** `scan.mjs` 的 `PROCESSES` 里，
   所以 `scan --check` 绿**不是**"新增 `runtime/` 字面量已声明"的证据。
   本批在 `runtime/` 下新增的**生产**字面量为 **0**；新增的两条断言复用的是既有导出
   （`CAPABILITY_EVIDENCE_CODES`），没有新的 SCREAMING_SNAKE 字面量，因此**没有**需要
   在 `config-schema.mjs` 的 `nonEnvLiterals` 里申报的东西——即便有，那道门禁也管不到这个目录。
8. **§4.4 的清单是提案，不是已验证的修法。** 其中的第 1 条（任务级能力声明面）
   在 spec 里**没有**依据——spec 全文只有 `:173` 一个 `getCapabilities()` 声明，
   没有任何逐任务能力需求的定义。所以它可能不是"补一条字段"，
   而是要重新回答"认领粒度是按什么分的"。
9. **`usage-reporting` 的替代来源（会话转录）本批只做了阅读**（
   `scripts/prt/dsh-session-usage.mjs` 的文件头与 `collectUsage` 签名），
   **没有运行**它（批前明令不跑 `scripts/prt/*` 的 break-verification 脚本），
   也没有验证它对**单次 run** 的归因能力。把它写进 §4.4 第 6 条只是"这条路存在"，
   不是"这条路能用"。
10. **编码/换行**：本批只改了一个测试文件；改后**实测**该文件 548 行**全部**为 LF
    （无混用行尾；改动前 461 行，未做任何 `Get-Content -Raw` + `Set-Content` 式编辑）；
    CJK 未受破坏（`encoding-check --all` 见 §7.2）。

## 9. 我猜的 / 不确定的地方（不合并进结论）

- **"`tool-permission-enforcement` 到底算不算引擎能力"**：本批按"它由 Legion 的补丁层实现、
  由自检判定"来读（这正是 `registrar-row.mjs:526-529` 的 `source`/`reason` 写的）。
  但 spec 里 `RuntimeCapabilities` 只是 `:173` 的一个**类型名**（那四个能力名 spec 全文
  **0 命中**，所以"必需"是哪四项其实是 `contracts/adapter.mjs:39-48` 的实现选择），
  而行 62 又说 sandbox 的 enforcement 在启动时探测——**"能力表里的这一格是引擎的自我声明
  还是产品的自检结论"这件事，spec 没有把它说成一个口径**。我按代码现状读，没有替它定口径。
- **"`degraded` 是不是本条的预期形状"**：spec 行 266 支持这个方向，
  但 spec **没有**说"部分能力不可用"是指"必需集合里的某几项"还是"可选集合里的某几项"。
  我按"必需集合里的某几项"来推（因为可选集合的语义在 `adapter.mjs:50-57` 已经另有说法：
  禁用对应功能），这一步是**推断**。
- **`checkBudget({usage: null}) → null`** 我读成"事后预算检查读到的是'确认没超'"。
  这是按 `usage.mjs:149-157` 的注释（`null` 的含义是"确认没超"）读的；
  我没有追完整条生产调用链去确认"那次判定在生产上一定会被当成通过"
  （`runtime/adapters/dsh/index.mjs:624` 只是把它收进 `budgetHit`，
  它之后被谁读、读成什么，本批**没有**追）。§4.3 里我把结论限制在
  "`checkBudget` 在这种输入下返回 `null`（= 确认没超）"这一条**实测**上，
  没有替整条生产链下结论。
- **PRT-253 的序号**：本文按批前指定的文件名 `PRT-253-capability-criteria.md` 落盘，
  没有动任何台账（`PRT-PROGRESS.md` 归操作者）。
