# PRT-253（续批二）：`runtimeHost` / `canRead` 的**生产来源**

> 这一批去填上一批点名的那**唯一**还缺的一件：`runtimeHost`（版本 + 四项必需能力）
> 与 `canRead` 的**生产来源**。
>
> 结论写在最前面，免得后面的话读起来像"都做完了"：
>
> **填上了一样（引擎版本），一项有一处真来源（`structured-result`），
> 三样能力没有来源因而按未确认报，`canRead` 没有合法来源因而以具名码拒绝。
> 因此这一行**仍然不能**进静态补丁层，部署读数**仍然**是 `EXECUTOR_HOST_PORT_REQUIRED`。**
>
> 而且本批在真进程里量到一条**比"缺一个端口工厂"更大**的事：
> 消费方（`product/orchestrator/worker.mjs`）与注册方（DSH Runtime 进程）**是两个进程**，
> 所以这条缝**填多好都不会改变 worker 的读数**。逐条见 §5 诚实边界。

前置：`PRT-253-runtime-binding-caller.md`（上一批：调用方 + 缝 + 具名拒绝）。

## 1. 这一批要回答的三个问题

上一批的文件头与文档 §3.3 把缝里那两样东西写成了一句诚实的话：

> `probeRuntime`（版本 + 四项必需能力）在全仓库**没有任何生产实现**，
> `canRead` 同样只有用例替身……**今天这个缝是空的，没有生产注册方**。

于是本批要**用证据**回答：

1. 引擎**版本**与四项必需能力，在真 DSH 进程里各自能从哪里合法地读出来？
2. `canRead` 这个**权限判定**有没有合法来源？
3. 把这些填上之后，`legion-runtime-host` 这一行可不可以挂进补丁层？

## 2. 交付了什么

### 2.1 `runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs` —— 生产注册方

形状与 `team-hub/approval-registrar-row.mjs` **逐条同形**（那是本仓库已经量过的形状）：

* 在**模块求值期**调用 `setDshRuntimeInputsFactory(...)`；
* 默认导出 `runtime-host-row.mjs` 的 `default`——**`===` 同一个对象**，不是替身；
* 于是"注册先于 `apply`"由 **ESM 求值顺序**保证，而不是由补丁行顺序保证
  （`Promise.allSettled` 并发建行的 2×2 矩阵读数见 PRT-214 文档 §10）。

它导出的东西：

| 导出 | 作用 |
| --- | --- |
| `RUNTIME_HOST_REGISTRAR_CODES` | 三个具名码：`NO_CONTEXT` / `NO_SUBAGENTS_PORT` / `NO_CAN_READ_SOURCE`（外加装载期的 `CAPABILITY_TABLE_MISMATCH`） |
| `DSH_VERSION_CODES` | `READ` / `NOT_FOUND` / `MALFORMED`——"读到了"与"没读到"必须分得开 |
| `CAPABILITY_EVIDENCE_CODES` | 四项能力各自的**判据码**（见 §3.2） |
| `readDshVersionOfInstall()` | 版本阅读器（纯 fs 逻辑，可注入） |
| `runtimeCapabilityEvidence(ctx)` | 四项能力的布尔表 + 逐项判据 |
| `probeDshRuntime(ctx)` | 端口契约要的 `{version, capabilities}`（外加给人和运维读的判据） |
| `createRuntimeHostInputsFactory({canRead})` | 造那个工厂：`(ctx) => ({runtimeHost, canRead})` |
| `default` | **真的那个** `runtime-host-row` 插件对象（`===`） |

它**没有**从 `runtime/dsh-composition/index.mjs` 出口：本模块在模块求值期注册工厂，
把出口接上去会让"import 一下 barrel"变成一次生产注册的副作用（包括在根本不跑 Runtime
的进程里）。补丁层是按**路径**加载这一行的模块的，不经过 barrel。

### 2.2 一处契约扩展：工厂拿得到**本行那一侧的 Context**

`runtime-host-row.mjs` 里从 `factory()` 改成 `factory(ctx)`。

理由：真的 `runtimeHost` 只能从现场服务上取（`ctx.get('subagents').start` 是 `startRun`
的唯一真来源），而模块求值期还没有树。上一批的文件头已经把意图写成
「工厂在**本行 `apply` 时**被调用：它需要 DSH 进程的现场」——这一行让"现场"真的到手。

**向后兼容**：上一批那些零参工厂在 JS 里忽略多余实参，行为一字不变
（上一批那四条真进程用例本批一字未改、仍然全绿）。新增一条用例钉住"工厂收到的就是本行
那一个 Context（`===`）"。

### 2.3 两个新套件

* `runtime-host-registrar-row.test.mjs` —— **26 例**（不启动 DSH）：版本阅读器的四条分支、
  能力的七个判据分支、工厂的三个具名拒绝、注册形状、以及"工厂收到的是本行的 ctx"。
* `runtime-host-registrar-row-dsh-process.test.mjs` —— **6 例**（真 DSH 进程，5 次启动）：
  见 §4。

## 3. 三样东西各自的来源（这是本批要回答的问题）

### 3.1 引擎版本：**有**真来源 → 填上了

`probeRuntime` 要报的是**这台机器上正在跑的那个引擎**的版本，所以它必须来自进程现场。

本批在真 DSH 进程里量到的现场事实（一次性 `DSH_HOME`、`bundles: []`、探针行写 stderr）：

```
ARGV1 D:\project\DSH\dsh\deepseek-harness\apps\cli\lib\bin.js
ENTRIES [{"id":"include","name":"cordis:include"},
         {"id":"prt253probe-row","name":"file:///D:/project/DSH/legion/.worktrees/_prt-handoff/…/probe-row.mjs"}]
GET launchEnvironment object
GET cmdlineArgs object
GET subagents absent / tools absent / sandbox absent / permission absent
```

所以：DSH 进程的入口就是那份安装里的 CLI。本模块的版本来源是
**`process.argv[1]`（+ 加载器树里那些 `file://` 模块名）向上有限层找
`@deepseek-ai/dsh` / `@deepseek-ai/dsh-root` 的 `package.json`，读它的 `version`**。

真进程读数（§4 场景 S）：

```
PROBEDVERSION 0.1.5-rc.2        ← 与 <DSH>/apps/cli/package.json 的 version 逐字相等
PROBEDVERSIONCODE RUNTIME_HOST_REGISTRAR_DSH_VERSION_READ
CANDIDATE0VERSION 0.1.5-rc.2
```

fail closed：读不到就是 `version: null`，`checkRuntimeVersion(null)` 判**不兼容**
（`probe.mjs` 的口径：「读不到」不等于「没问题」）。`package.json` 在但 `version`
不是非空字符串时报 `MALFORMED`，**不编一个版本**。

### 3.2 四项必需能力：一项有真来源，三项**未确认**

`probe.mjs` 的判据是「必须**显式为 true**，缺失不算具备」——所以能力表里写 `false`
就是"**未确认**"。逐项：

| 能力 | 本批的读数 | 真来源 |
| --- | --- | --- |
| `structured-result` | 现场唯一 provider 自报 `outputSchema` 时才 `true` | DSH `ctx.get('subagents')` 的**命名 provider 注册表**（`list()` / `getProvider(name).capabilities`），且引擎的 `start()` **真的按它拒收**（`packages/subagent/subagent/src/types.ts` 的 `SubagentCapabilities` + `assertCapabilities`） |
| `tool-permission-enforcement` | `false`（未确认） | 本产品里这件事由 **Legion 自己的补丁层**实现，生效与否由启动自检的 `composition-patch-layer` / `enforcement-mapping` 判定。探针**不把同一件事再判一遍**（两份判定会漂移）→ 判据码 `…_ENFORCEMENT_PLANE_MEASURED_ELSEWHERE` |
| `cancel-and-timeout` | `false`（未确认） | `runtime/adapters/dsh/port.mjs` 文件头记录的**已发生生产故障**：「subagent 可能挂死且 `run.result` 永不结算（abort 不保证杀死子代理）」。引擎契约声称能取消，仓库自己记录了它不保证 → `…_CANCEL_NOT_GUARANTEED_BY_ENGINE` |
| `usage-reporting` | `false`（未确认） | DSH 的 `SubagentResult` 契约（`output` / `structured?` / `diagnostic?` / `stopReason`）**没有**用量字段，而 `runtime/adapters/dsh/usage.mjs` 的 `collectUsage()` 读 `result.usage` / `tokenUsage` / `tokens` → `…_RESULT_CONTRACT_HAS_NO_USAGE` |

"多于一个 provider"时**不挑一个**：探针拿不到那一次请求会用谁，挑一个就是替调用方猜。

装载期还有一条 `assertCapabilityTableComplete()`：能力表与 `REQUIRED_CAPABILITIES`
不**恰好**相同就当场抛（少报一项会让探针在缺能力时仍然报 ok）。

### 3.3 `canRead`：**没有**合法来源 → 具名拒绝

`canRead` 是"这一次 Attempt 能读哪些上下文来源"的**权限判定**。它的合法权威只有一处：
EmployeeManifest / lease 上的那次授权（`orchestrator/worker/context-stage.mjs` 的注释
写明了这一点）。而本模块跑在 **DSH Runtime 进程**里，那个进程只有身份 / hub 地址 /
cwd / taskId / scope（`root.mjs` 从环境解析出来的那一份）：**没有岗位清单，也没有 lease**
（lease 要等 worker 侧认领之后才存在）。实测的服务清单（§3.1）里也没有任何权限服务。

所以生产默认的工厂在**被调用时**抛 `RUNTIME_HOST_REGISTRAR_NO_CAN_READ_SOURCE`：

```
$ dsh --profile … --patch prt253ri-registrar-row.patch.yml
exit=1  RUNTIME_HOST_ROW_INPUTS_FACTORY_THREW（code=RUNTIME_HOST_REGISTRAR_NO_CAN_READ_SOURCE）
```

这与强制面 plane 的口径同源（`hub = derivedHub ?? configuredFrom(ENV.hubUrl)`，
**没有编出来的默认值**）：拿不到来源的名字，就以具名码拒绝。

注入点留给知道答案的那一侧：`createRuntimeHostInputsFactory({ canRead })`
（形状与 `createRootRow({createRequestApproval})` 相同）。本批的 F 场景用的就是它，
而那个 `canRead` **是替身**——这件事写在 §4 与 §5 里，不在读数里含糊过去。

## 4. 真 DSH 进程里的读数（`runtime-host-registrar-row-dsh-process.test.mjs`）

五个场景，每个只动**一个**变量。全部一次性 `DSH_HOME`（`os.tmpdir()` 下、spawn 前断言）、
`bundles: []`、`patchReload: 'startup'`、删掉 `DSH_SNAPSHOT`、`spawnSync` 超时、`after()` 删除。
补丁层用的是**磁盘上那份真 `legion-host.patch.yml`**（一个字节都不改）。

| 场景 | 唯一变量 | 原始读数 |
| --- | --- | --- |
| **N** | 那一行的模块 = 组件本体（上一批的取值，没人注册工厂） | `exit=1` `RUNTIME_HOST_ROW_NO_INPUTS_FACTORY` |
| **R** | 那一行的模块 = **本批的生产注册方** | `exit=1` `RUNTIME_HOST_ROW_INPUTS_FACTORY_THREW`（`code=RUNTIME_HOST_REGISTRAR_NO_CAN_READ_SOURCE`） |
| **F** | R + **注入的** `canRead`（替身） | `exit=1` `RUNTIME_HOST_ROW_BIND_REFUSED`（`BOOTSTRAP_SELF_CHECK_INCOMPATIBLE`，理由里逐个列出未确认的能力） |
| **S** | 注册方**被加载**、那一行**不挂**（进程活着）→ 读生产函数 | `exit=0` `PROBEDVERSION 0.1.5-rc.2`、`PROBEDCAPS {"tool-permission-enforcement":false,"cancel-and-timeout":false,"structured-result":true,"usage-reporting":false}`、`DEFAULTFACTORY RUNTIME_HOST_REGISTRAR_NO_CAN_READ_SOURCE`、`STARTFWD handle` |
| **S2** | S 的桩 provider 把 `outputSchema` 报成 `false` | `structured-result=false`、判据码 `…_PROVIDER_LACKS_OUTPUT_SCHEMA`（版本读数**不变**） |

`node --test` 的原始汇总：

```
▶ PRT-253 续批二：生产注册方在**真 DSH 进程**里的读数
  ✔ N. 上一批的取值（组件本体当模块、没人注册工厂）→ `RUNTIME_HOST_ROW_NO_INPUTS_FACTORY` (942.6693ms)
  ℹ N: exit=1 RUNTIME_HOST_ROW_NO_INPUTS_FACTORY
  ✔ R. ★★★ 换成生产注册方当那一行的模块 → 换一条**不同**的具名码 (1169.3118ms)
  ℹ R: exit=1 RUNTIME_HOST_ROW_INPUTS_FACTORY_THREW(RUNTIME_HOST_REGISTRAR_NO_CAN_READ_SOURCE)
  ✔ F. 注册方 + 注入的 canRead（替身）→ 未确认的能力在**启动自检**那一步后果可见 (1020.1022ms)
  ℹ F: exit=1 RUNTIME_HOST_ROW_BIND_REFUSED(BOOTSTRAP_SELF_CHECK_INCOMPATIBLE)
  ✔ S. ★★ 生产探针在真 DSH 进程里的读数：版本是真安装的版本，能力逐项有据 (3979.0696ms)
  ℹ S: version=0.1.5-rc.2 caps={"tool-permission-enforcement":false,"cancel-and-timeout":false,"structured-result":true,"usage-reporting":false}
  ✔ S2. S 的反向对照：桩 provider 把 `outputSchema` 报成 false → 那两项读数跟着变 (3938.0519ms)
  ℹ S2: structured-result=false RUNTIME_HOST_REGISTRAR_CAPABILITY_PROVIDER_LACKS_OUTPUT_SCHEMA
  ✔ ★ 四个场景的读数两两不同形（"注册方在不在""能力读没读到"都被读出来了） (0.2641ms)
  ℹ N=RUNTIME_HOST_ROW_NO_INPUTS_FACTORY / R=RUNTIME_HOST_ROW_INPUTS_FACTORY_THREW(RUNTIME_HOST_REGISTRAR_NO_CAN_READ_SOURCE) / F=RUNTIME_HOST_ROW_BIND_REFUSED(BOOTSTRAP_SELF_CHECK_INCOMPATIBLE)
✔ PRT-253 续批二：生产注册方在**真 DSH 进程**里的读数 (11051.1523ms)
ℹ tests 6  ℹ pass 6  ℹ fail 0
```

**负面对照（三条，缺一条整套就没有意义）**：

1. N ↔ R：差别只有**一个模块路径**，读数却是两个不同的具名码。
   没有这一条，"注册方在场"可能只是"这一行现在什么都不检查了"。
2. S ↔ S2：能力判据的**唯一**变量是桩 provider 的一个布尔值，`structured-result`
   的布尔值与判据码都必须跟着变。没有这一条，"读注册表"与"写死一个 true"分不开。
3. S 里 `DEFAULTFACTORY` 读的是 `NO_CAN_READ_SOURCE`：生产默认在**同一个真进程、
   同一个 ctx** 上就是拒绝，而 F 的成功只因为那条注入的替身。

## 5. 诚实边界

### 5.1 ★★ 这条缝填上了，也**改不了部署读数**（本批最大的发现）

`bindDshRuntime()` 注册的是 `orchestrator/worker/executor-binding.mjs` 里一个
**模块级 `bindingStack`**——它是**进程内**的。而消费方在另一个进程：

```
product/process-manifest.mjs:
  key: 'runtime'       ← DSH 组合层在这里（runtime-host-row 也在这一侧）
  key: 'orchestrator'  ← entry: node-file product/orchestrator/worker.mjs（productionExecutorProviderFromEnv 在这里）
  orchestrator.dependsOn: ['team-hub', 'runtime']
```

上一批"绑定生效"的读数，是在**同一个 DSH 进程内**由一个探针行直接 import worker 侧那个
模块读出来的——它证明了这条链在**一个进程里**通，**没有**证明它在**部署的两个进程之间**通。

> 一个"注册进本进程模块级变量"的绑定，与一个"注册进另一个进程"的绑定，
> 在运行的部署上是同一个东西——只不过前者有一个同进程的绿色用例。

这不是猜测：`bindingStack` 是模块级变量（读出来的），两个进程 key 分开（读出来的）。
**本批没有修它**，因为它不是"填一个端口工厂"能修的：它要么改部署拓扑（谁和谁同进程），
要么给这条绑定加一条跨进程通道。那是另一个批次的题目。

### 5.2 三样东西我**没有**填上，各自的原因不同

* **`canRead`：没有合法来源。** 见 §3.3。本批交付的是**具名拒绝**，不是默认值。
* **`cancel-and-timeout` / `usage-reporting`：引擎侧没有来源。** 见 §3.2。
  前者依据的是仓库记录的**已发生生产故障**，后者依据的是 DSH 的结果契约里**没有**用量字段。
  两项都不是"我们没查"，是"查了，答案是未确认"。
* **`tool-permission-enforcement`：有真来源，但那个来源是启动自检。**
  探针重复判定只会得到两份会漂移的判定，所以它报未确认——**不是**说强制面没生效。

### 5.3 因此这一行**仍然不进**补丁层

三条，任一条单独成立就够：

1. 探针现在会以"缺三项必需能力"判不兼容（这是**诚实**的读数），
   挂上去 = 每一个 DSH Runtime 进程都起不来（PRT-214 文档 §9 读数 C 的形状）；
2. `canRead` 没有合法来源，生产默认工厂以具名码拒绝——同样拦启动；
3. §5.1 的进程拓扑：挂上了也改不了 worker 进程的读数。

所以：`PATCH_LAYER_ROWS` **没动**、`legion-host.patch.yml` **没动**、
`DSH_COMPOSITION_PATCH_VERSION` **没动**、`render.mjs --write` **没跑**。

本模块今天是"**可被挂载的生产注册方**"，不是"已挂载的部署件"。
这个区别是本批诚实边界里最要紧的一句。

### 5.4 本批**故意没做**的事

* 没有动 `docs/STATUS.md` / `docs/superpowers/prt/PRT-PROGRESS.md`（操作者的）。
* 没有改 `scripts/ci/run-ci.mjs`（两个新套件要**操作者登记**，见 §7）。
* 没有改 `scripts/prt/*` 的破验脚本、没有跑它们。
* 没有把 `team-hub/` 拉进来：本模块只需要 DSH 服务与 Node 内建模块，
  于是它留在 `runtime/` 一侧，依赖方向问题根本不出现（`dsh-boundary --check` 见 §7）。
* 没有修 §3.2 里顺带量到的那条**相邻缺陷**（PRT-510 预算闸门在生产路径上拿不到
  token 用量：`collectUsage()` 读的三个字段在真结果上都不存在）。它不属于这条缝。

### 5.5 哪一处是**判断**，不是从契约推出来的

1. **版本取自"启动本进程的那份安装的 CLI 包"**。它是真读数（§4 S 与
   `<DSH>/apps/cli/package.json` 逐字相等），但语义上它是**CLI 的版本**，不是引擎
   自报的版本。如果哪天 DSH 用别的进程跑 Runtime，这条来源会失准——
   而失准的表现是 `version: null` → 判不兼容（fail closed），不是"静默当成兼容"。
2. **"多于一个 provider 就报未确认"**。DSH 允许注册多个 provider，而探针拿不到那一次
   请求的 provider 名。挑第一个是猜；报未确认是保守。这是我的取舍。
3. **`tool-permission-enforcement` 不在探针里判**。也可以反过来：从组合树读出
   "强制面三行 ACTIVE"就报 true。我**没有**这么做——那会让探针与启动自检对同一件事
   判两遍，而两遍迟早不一样。
4. **`cancel-and-timeout` 报未确认**，尽管引擎契约（`SubagentRun.dispose` /
   `request.signal`）声称取消会到达静默。我按仓库记录的现场故障取了保守方向。

### 5.6 这套证据**没有**证明的东西

* **`subagents` 是替身**：`bundles: []` 的一次性 profile 里没有真引擎。所以
  "读现场 provider 注册表"这一路的**推导链**被验过了，"真 DSH 引擎支持
  `outputSchema`"**没有**被验过。
* **`canRead` 是替身**（只在 F 场景里，为了把未确认能力的后果读出来）。
* **沙箱端口是替身**（沿用上一批的桩）。
* **SCAFFOLD 场景（S/S2）里那一行没有挂**：它 import 生产注册方并调用生产函数，
  但**没有**走那一行的 `apply`。走 `apply` 的那条路是 R 与 F。
* 本批**没有**用带 bundle 的真实 profile 启动过（安全规则要求 `bundles: []`），
  所以"真实部署里 `subagents` / `tools` / `sandbox` 的形状与这里一致"是**假设**。

## 6. 三样输入来源一览（与上一批那张表对读）

| 输入 | 来源 | 本批的落地 |
| --- | --- | --- |
| `composition` | 真组合树（`ctx.get('loader').entries()`） | 上一批已交付，本批未动 |
| `sandbox` | 真 DSH 服务（`ctx.get('sandbox')`） | 上一批已交付，本批未动 |
| `runtimeHost.startRun` | 真 DSH 服务（`ctx.get('subagents').start`，按引用转发） | **本批**：生产注册方；没有它就以 `NO_SUBAGENTS_PORT` 拒绝 |
| `runtimeHost.probeRuntime` 的**版本** | 进程现场（本进程入口所属安装的 `package.json`） | **本批填上**；读不到报 null（fail closed） |
| `runtimeHost.probeRuntime` 的**能力** | 一项读现场 provider 注册表；三项**无来源 → 未确认** | **本批**：逐项判据码，见 §3.2 |
| `canRead` | **无合法来源** | **本批**：具名拒绝 `NO_CAN_READ_SOURCE` |

## 7. 验证（本批实际跑的）

全部在 `D:\project\DSH\legion\.worktrees\prt-runtime`（分支 `codex/prt-runtime`）下，
`DSH_CHECKOUT=D:\project\DSH\dsh\deepseek-harness`。

| 命令 | 读数 |
| --- | --- |
| `node --test "runtime/dsh-composition/plugins/runtime-host-registrar-row.test.mjs"` | `tests 26 / pass 26 / fail 0` |
| `node --test "runtime/dsh-composition/plugins/runtime-host-registrar-row-dsh-process.test.mjs"` | `tests 6 / pass 6 / fail 0`（5 次真 DSH 启动，11.0s） |
| `node --test "runtime/dsh-composition/*.test.mjs"` | `tests 539 / pass 539 / fail 0`（**与上一批逐字相同**，本批未动那一层） |
| `node --test "runtime/dsh-composition/plugins/*.test.mjs"` | `tests 91 / pass 91 / fail 0`（上一批 59 → 本批 +32） |
| `node --test orchestrator/worker/{executor,executor-binding-sources,worker}.test.mjs` | `tests 72 / pass 72 / fail 0`（回归：改了 `runtime-host-row.mjs` 的工厂调用形状） |

静态门禁（`git add -A` 之后跑）：

```
node scripts/config/scan.mjs --check            → scan: PASS（542 个疑似字面量均已处理）
node scripts/ci/ci-syntax.mjs                   → ci-syntax: PASS（50 个脚本全部可被 Node 解析）
node scripts/ci/encoding-check.mjs --all --quiet→ encoding-check: PASS（1901 个文本文件）
node scripts/ci/check-docs.mjs                  → check-docs: PASS（10 类校验项全绿）
node scripts/ci/dsh-boundary.mjs --check        → dsh-boundary: PASS（3 个文件 / 26 处，均在基线内）
```

`dsh-boundary` 的读数与上一批**逐字相同**：本模块只用 `ctx.get('subagents')` 这个
**逃生口**读现场服务，没有新增任何 `ctx.<service>` 执行面记号、也没有 import 任何 DSH 包，
所以它留在 `runtime/` 一侧，依赖方向问题根本不出现。

### 7.1 破验（三个变异，都被咬住）

| 变异 | 改的是什么 | 变红的地方 |
| --- | --- | --- |
| A | `structuredResultEvidence()` 里改成恒 `true`（= 编一个能力表） | 单测 `★ 同一个 provider 自报 outputSchema:false → 那一项不具备`；真进程 `S2`（`桩 provider 说不支持时必须跟着报 false`）+「两两不同形」那条 |
| B | `probeDshRuntime()` 里把版本读数**写死** | 单测 3 条：`版本读不到时报 version: null` / `payload 同时带能力布尔表与判据` / `probeRuntime 用注入的版本读法` |
| C | 去掉模块求值期那次 `setDshRuntimeInputsFactory(...)` | 真进程 `R`（`注册方在场却报"没有人注册工厂"`）+「两两不同形」那条 |

**一个诚实的补充**：变异 B 在真进程套件里**不会**变红——因为写死的那个字面量恰好
等于这台机器上的 `0.1.5-rc.2`。也就是说真进程场景 S 能证明的只是
"读出来的版本 = 这份安装的版本"，证不了"它每次都是**读**出来的"；
后一条由单测那三条（注入不同的读法、读不到时报 null）承担。
两个套件合起来盖住，单独任一个都不够。

### 7.2 ★ `scan` 这一侧的覆盖情况（**不粉饰**）

`scripts/config/scan.mjs` 的 `PROCESSES` 里**没有** `runtime`——本批新增的两个模块与
两个套件全都在 `runtime/dsh-composition/plugins/` 下，所以：

* `scan --check` **绿**这件事，对这批新代码**不是证据**；
* 本批的具名码**没有**、也**不需要**登记进任何 `config-schema.mjs` 的 `nonEnvLiterals`
  （那份清单是给被扫描的进程用的）；
* 真正被 `scan` 覆盖的改动是**零个**（本批没有改 `team-hub/` / `product/` /
  `orchestrator/` / `plugins/` 下任何文件）。

### 7.3 操作者需要登记的新套件

* `runtime/dsh-composition/plugins/runtime-host-registrar-row.test.mjs`
* `runtime/dsh-composition/plugins/runtime-host-registrar-row-dsh-process.test.mjs`

`scripts/ci/run-ci.mjs` 由操作者所有，本批**没有**改它。
