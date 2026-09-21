// runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs
// ============================================================================
// PRT-253（续批二）：`setDshRuntimeInputsFactory()` 的**生产注册方**——
// 也就是上一批 §6 点名的「唯一还缺的那一件」的下一层。
//
// ## 上一批留下的那个缝
//
// `runtime-host-row.mjs` 在自己的文件头写着一句诚实的话：
//
//   > `probeRuntime`（版本 + 四项必需能力）在全仓库**没有任何生产实现**，
//   > `canRead` 同样只有用例替身……**今天这个缝是空的，没有生产注册方**。
//
// 本模块就是那个注册方。它按 `team-hub/approval-registrar-row.mjs` 已经验证过的
// 形状工作：**模块求值期**注册工厂，然后默认导出**真的那个**插件对象
// （`===` 同一个对象，不是形状相同的替身）——于是"注册先于 `apply`"由 Node 的
// ESM 求值顺序保证，而不是由补丁行顺序保证（那条 2×2 矩阵的读数见
// `docs/superpowers/prt/PRT-214-enforcement-composition-root.md` §10）。
//
// ## ★ 本批真正回答的问题：这三样各自**从哪里来**
//
// | 输入 | 本批的结论 | 依据 |
// | --- | --- | --- |
// | 引擎**版本** | **有**真来源 → 填上了 | 进程自己那次启动的入口（`process.argv[1]`）所属安装的 `package.json`；读不到就**报 null**（fail closed） |
// | 四项必需**能力** | 一项有真来源，三项**报未确认** | 见下 |
// | `canRead` | **这个进程里没有读者** → 缺席如实记成 `null`（改掉了上一版的"具名拒绝"） | 见下 |
// | `currentModelSelection` | **有**合法来源 → 接上了 | DSH 的 `agentDefaultModel` 服务；缺席报 `null`（`MODEL_UNAVAILABLE`） |
//
// ### 版本：从"正在跑的那份安装"读，不从常量读
//
// `probeRuntime` 要报的是**这台机器上正在跑的那个引擎**的版本。它必须来自
// 进程现场，不能是一行写死的字符串。本批实测（一次性 `DSH_HOME`、`bundles: []`、
// 真 `dsh` 进程）：
//
//     ARGV1 D:\project\DSH\dsh\deepseek-harness\apps\cli\lib\bin.js
//
// 也就是：DSH 进程的入口就是那份安装里的 CLI。于是本模块从 `process.argv[1]`
// （外加加载器树里那些 `file://` 模块名）出发，向上有限层找
// `@deepseek-ai/dsh` / `@deepseek-ai/dsh-root` 的 `package.json`，读它的 `version`。
// 找不到就是 `{ok:false}`，`probeDshRuntime()` 报 `version: null`——
// 而 `checkRuntimeVersion(null)` 判**不兼容**（`probe.mjs` 的 fail closed 口径）。
//
//   · 一个"读不到版本就当它兼容"的探针，
//     与一个"把补丁层装在认不出的引擎上"的探针，是同一个东西。
//
// ⚠️ 这条来源是一个**判断**，不是从契约推出来的：版本取自"启动本进程的那份安装的
// CLI 包"，不是引擎自报。理由与代价逐条写在文档 §诚实边界。
//
// ### 能力表：一项真有来源，两项按**未确认**报，一项**不由本模块表态**
//
// `probe.mjs` 的判据是「必须**显式为 true**，缺失不算具备」。能力表里写 `false`
// 就是"未确认"（不是"引擎说不行"）。逐项：
//
//   · `structured-result`：**有**真来源。DSH 的 `ctx.get('subagents')` 是一张
//     **命名 provider 注册表**，每个 provider 自报 `capabilities.outputSchema`
//     （`packages/subagent/subagent/src/types.ts` 的 `SubagentCapabilities`），
//     而 `start()` 在派发前**真的按它拒收**。所以"这一次会用到的那个 provider
//     支不支持 outputSchema"是可以从现场读出来的。本模块读它：
//     注册表读不到 / 空 / 多于一个 provider（说不清会用哪一个）→ 一律**未确认**。
//   · `tool-permission-enforcement`：★ **2026-09-21 起本模块不再表态**
//     （业主裁决：它移出 `REQUIRED_CAPABILITIES`，进 `PRODUCT_PLANE_CAPABILITIES`）。
//     本产品里"按 `RunRequest.permissions` 约束工具与文件范围"就是 Legion 自己的
//     补丁层（硬底线 guard / pre-execute 策略 / 审批应答者），生效与否由启动自检的
//     `composition-patch-layer` 与 `enforcement-mapping` 两项判定。
//     ★ 为什么**不再**在这里报一个 `false`：本函数的产物会被 `probeRuntime()`
//     当作**引擎自报的能力表**交出去，在里面放一个产品侧能力 = 替引擎答一个
//     它不负责的问题，而那个 `false` 会被下游读成"产品没有强制面"。
//   · `cancel-and-timeout`：**未确认**，而且理由是一条**已发生的生产故障**：
//     `runtime/adapters/dsh/port.mjs` 的文件头记着「subagent 可能挂死且
//     `run.result` 永不结算（abort 不保证杀死子代理）」——适配器的看门狗正是为它存在。
//     引擎契约（`SubagentRun.dispose` / `request.signal`）**声称**能取消；
//     仓库自己记录了它不保证。**不乐观**：这一项报未确认。
//   · `usage-reporting`：**未确认**。引擎一次性子代理的结果契约
//     （`SubagentResult`：`output` / `structured?` / `diagnostic?` / `stopReason`）
//     **没有**任何用量字段；而 `runtime/adapters/dsh/usage.mjs` 的 `collectUsage()`
//     读的是 `result.usage` / `result.tokenUsage` / `result.tokens`——这三个在真结果上
//     都不存在。所以一次 run 拿不回 token 用量：这一项报未确认。
//     （顺带量到的一条**相邻缺陷**：预算闸门（PRT-510）在生产路径上因此永远拿不到
//     token 数。本批**不修**它——它不属于这条缝；记在文档的诚实边界里。）
//
// ### `canRead`：**这个进程里没有读者** → 缺席就是缺席，不猜（本批改掉了"具名拒绝"）
//
// ⚠️ 上一版这里写的是「`canRead` **没有**合法来源 → 默认工厂在**被调用时**抛
// `RUNTIME_HOST_REGISTRAR_NO_CAN_READ_SOURCE`」。**那条要求是残留的**，本批把它
// 改掉了，理由是四条**读出来的**测量（不是态度）：
//
//   ① `runtime/adapters/dsh/port.mjs:44` 的 `REQUIRED_PORT_METHODS` 是
//      `['startRun','probeRuntime']`，`:47` 的可选表是 `currentModelSelection` /
//      `subscribeRun` / `listModels`——**端口契约里没有权限面**；同一文件里
//      `canRead|permission|readScope|acl` 是 **0 命中**。
//   ② `runtime/dsh-composition/enforcement.mjs` 里 `canRead` 是 **0 命中**。
//   ③ 全仓库**唯一**读某个绑定的 `canRead` 的地方是
//      `orchestrator/worker/executor-binding.mjs` 的 `productionExecutorProvider()`
//      ——而那个函数跑在 **worker 进程**里。跨进程那条路（
//      `productionExecutorProviderFromEnv({canRead})`）用的是**调用方**给的那一份，
//      走线上的 `selfCheck` 也是 worker 自己读的。
//   ④ spec（`docs/superpowers/specs/2026-09-11-legion-product-runtime-design.md`）
//      里 `canRead` 是 **0 命中**——它是 Legion 的实现概念，不是 spec 要求的输入。
//   ⑤ 绑定本身在 Runtime 进程里**确有**读者，但读的是别的字段：
//      `runtime-contract-server-row.mjs:415-416` 惰性读 `legionRuntimeHostBinding`，
//      交给 `verdictFromRuntimeHostBinding()`（`:244-255`），后者**只取**
//      `{ok, state, patchVersion, checks}` 并附一个 `source`。**`canRead` 不在其中。**
//
// 合起来只有一句话：**Runtime 进程里没有任何东西读这个绑定的 `canRead`。**
// 为一个没有读者的输入拦住整个绑定，是把两种完全不同的处境压成同一条拒绝：
//
//   · "某个部署忘了接权限权威"（worker 进程的问题，那里确实要拦）；
//   · "这个进程里根本没有这个读者"（Runtime 进程的**正常**形状）。
//
// 所以本批的取值是：
//
//   · **缺席 → 如实记成 `canRead: null`**，原样交下去。不是 `() => true`
//     （默认放行 = 一次接线遗漏变成一次静默越权），不是 `() => false`
//     （默认拒绝 = 一次接线遗漏变成一次静默停摆），不是空对象，不是别的东西。
//     "没有"就是"没有"，而它在读数上是一个**分得开的**值。
//   · **真正要执行的那一侧仍然 fail closed**：
//     `productionExecutorProvider()` 读到 `canRead` 不是函数（同进程绑定与跨进程
//     两条路**都**）→ `EXECUTOR_CAN_READ_REQUIRED`。跨进程那条路一字未改。
//     同进程那条路本批**新加**了这个判定：它以前根本读不到这种绑定
//     （`bindDshRuntime` 当场就拒了），所以必须自己拒——而且是那个**具名**的权限码，
//     不是 `executor.mjs:147` 那条更笼统的 `BAD_WIRING`（那条**原样保留**，它是
//     `createProductionExecutor` 自己的要求，把"权限来源缺席"压成一个笼统接线错误
//     会把排障指向网络与路由）。
//   · **想挂一个不是函数的 `canRead` → 当场拒**（构造期与本工厂被调用时两处）。
//     静默丢掉它，就再没有人看得出有人试图挂它。
//
// 注入点原样保留：知道答案的那一侧（岗位清单 / lease 的持有者）仍然可以
// `createRuntimeHostInputsFactory({canRead})` 显式给。给的会被**按引用**带出去。
//
// ### `currentModelSelection`：**有**合法来源 → 接上了（本批新增）
//
// `runtime/adapters/dsh/port.mjs:27` 把 `currentModelSelection()` 写进端口契约
// （返回 `{provider, model, endpoint?, reasoningEffort?, limits?}`，**可选**方法），
// `index.mjs:250` 读它，`:455-457` 在它缺席时给出 `MODEL_UNAVAILABLE`。
// 而 DSH 自己就把"当前默认模型"做成了一等服务：`agentDefaultModel`
// （`packages/core/agent-default-model/src/index.ts:64,73,90`：`super(ctx,'agentDefaultModel')`
// + `currentSelection()`），由基础组合层挂载。本模块跑在 DSH 宿主进程里，
// 所以它**读得到**——本批把它接上：
//
//     currentModelSelection: () => readModelSelection(ctx).selection
//
// 形状**先对过**：DSH 的 `currentSelection()` 返回 `{provider, model, reasoningEffort?}`
// （同一文件 `:49-57` 的 `selection()`），是端口契约那个形状的**子集**——
// 必需的 `provider` / `model` 都在，可选的几个缺席本来就被 `index.mjs:266-270`
// 各自兜成 `''` / `null` / `{}`。所以这里**不做任何字段搬运**（搬一遍就等于多一份
// 会漂移的副本），原样返回服务给的对象。
//
// **不编模型名**：服务不在 → `null`（判据码 `..._MODEL_SELECTION_SERVICE_ABSENT`），
// 适配器照旧走它那条诚实的 `MODEL_UNAVAILABLE`；服务在但形状不对 → 另外两个码。
// 服务自己抛错就**让它抛**——`index.mjs:252-258` 已经把它归类成 `MODEL_UNAVAILABLE`
// 并带上真因，在这里吞掉会把"坏了"变成"没有"。
//
// ## ★★ 本批量到的**更大的**一条：这条缝填上也不会改变部署读数
//
// `bindDshRuntime()` 注册进的是 `orchestrator/worker/executor-binding.mjs` 里一个
// **模块级 `bindingStack`**——它是**进程内**的。而 `productionExecutorProviderFromEnv()`
// 的生产调用点在 `product/orchestrator/worker.mjs`，那是**另一个进程**：
//
//     product/process-manifest.mjs:
//       key: 'runtime'      ← DSH 组合层在这里（本行也在这一侧）
//       key: 'orchestrator' ← entry: node-file product/orchestrator/worker.mjs（消费方在这里）
//       orchestrator.dependsOn: ['team-hub', 'runtime']
//
// 于是：**无论这个缝填得多好，另一个进程里的读者都看不到。** 上一批"绑定生效"的读数
// 是在**同一个 DSH 进程内**由一个探针行直接 import worker 侧那个模块读出来的——
// 那证明了这条链在**一个进程里**是通的，没有证明它在**部署的两个进程之间**通。
//
// 这条不是猜测：两侧都是读出来的（`bindingStack` 是模块级变量；进程清单里两个 key 分开）。
// 它意味着本批**不能**让 `runtimeHostRow` 变得可挂载，也意味着"最后一个生产环节"
// 缺的不只是一个端口工厂，还有**谁和谁在同一个进程里**这个前提。
// 详见 `docs/superpowers/prt/PRT-253-runtime-host-inputs.md` §诚实边界。
//
// ## ★ 为什么本行仍然**不进**静态补丁层（`PATCH_LAYER_ROWS`）
//
// 两条，任一条单独成立就够（**本批去掉了上一版列在这里的第②条**——"`canRead`
// 没有合法来源、工厂会以具名码拒绝"。它已经不成立了，因为工厂现在如实交出缺席）：
//
//   ① 探针**现在**会以"缺三项必需能力"判不兼容（这是诚实的读数），
//      于是挂上去 = 每一个 DSH Runtime 进程都起不来（PRT-214 文档 §9 读数 C 的形状）。
//      这一条是本批之后**下一个**阻塞点：它不再是接线问题，而是"三项必需能力在
//      这个进程里没有可确认的来源"（探针按未确认报，是对的）。
//   ② 上面那条进程拓扑：挂上了也改不了 worker 进程的读数。
//
// 所以本模块**没有** `PATCH_LAYER_ROWS` 登记、**没有**进 `legion-host.patch.yml`、
// `DSH_COMPOSITION_PATCH_VERSION` **不变**、`render.mjs --write` **不跑**。
// 它今天是"可被挂载的生产注册方"，不是一个已挂载的部署件——这个区别写在文档里。
//
// ## 为什么它**没有**从 `runtime/dsh-composition/index.mjs` 出口
//
// 本模块在**模块求值期**注册工厂（这正是它安全的原因）。把它加进那个 barrel，
// 会让"import 一下出口"变成一次生产注册的副作用——包括在根本不跑 Runtime 的
// 进程里。补丁层是按**路径**加载这一行的模块的（与 `team-hub/approval-registrar-row.mjs`
// 完全一样），不经过 barrel；所以这里刻意不添那条出口。
// ============================================================================

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { REQUIRED_CAPABILITIES } from '../../contracts/adapter.mjs'
import {
  createRunFloorInstallation,
  installRunFloorIntoAgent,
  runFloorCarrierOf,
  runFloorOptionOf,
  withRunFloorCarrier,
} from '../run-floor.mjs'
import { RUN_FLOOR_STATES } from '../../contracts/run-floor.mjs'
import {
  createRunIdentityInstallation,
  installRunIdentityIntoAgent,
  runIdentityCarrierOf,
  runIdentityOptionOf,
  withRunIdentityCarrier,
} from '../run-identity.mjs'
import { RUN_IDENTITY_STATES } from '../../contracts/run-identity.mjs'
import { createUsageProjectionDefinition, readRunUsage } from '../usage-projection.mjs'
import realRuntimeHostRow, { setDshRuntimeInputsFactory } from './runtime-host-row.mjs'

/**
 * 改动来源、拒绝码或能力判据时递增。
 *
 * 3 = `startRun` 按 Run 安装静态 hard floor。
 * 4 = `startRun` 按 Run 安装**授权身份**（PRT-214 缺口②）。
 * 5 = `tool-permission-enforcement` 移出 `REQUIRED_CAPABILITIES`（产品面能力，
 *     2026-09-21 业主裁决）⇒ 本模块的能力表从 4 项变 3 项，且**不再对它表态**。
 *     ⚠️ 兼容性影响：本模块的 5 与"探针报 4 项"不再配对。本仓内所有消费者
 *     都从 `REQUIRED_CAPABILITIES` 派生（不写死项数），所以**无需**同步升级；
 *     但若外部有按"恰好 4 项"读这份读数的人，它会看到 3 项——故递增此号。
 */
export const RUNTIME_HOST_REGISTRAR_VERSION = 5

/** 本模块的具名码。每一个对应**一样具体的输入**，不是一个笼统的"注册失败"。 */
export const RUNTIME_HOST_REGISTRAR_CODES = Object.freeze({
  /** 工厂被调用时没有拿到 Cordis Context（要能 `ctx.get` 读现场服务）。 */
  NO_CONTEXT: 'RUNTIME_HOST_REGISTRAR_NO_CONTEXT',
  /** 进程里没有 `subagents` 服务（`startRun` 的**唯一**真来源）。 */
  NO_SUBAGENTS_PORT: 'RUNTIME_HOST_REGISTRAR_NO_SUBAGENTS_PORT',
  /** 能力表与 `REQUIRED_CAPABILITIES` 对不上（装载期就抛，不安静地少报一项）。 */
  CAPABILITY_TABLE_MISMATCH: 'RUNTIME_HOST_REGISTRAR_CAPABILITY_TABLE_MISMATCH',
  /**
   * Run 的下限载荷解释不了（`createRunFloorInstallation` 具名拒绝）。
   *
   * 这一条发生在**起跑之前**：一个解释不了的下限不许"跳过安装照跑"——
   * 那正是"派生失败"被洗成"这次没有东西要禁止"的那一步。
   */
  FLOOR_UNREADABLE: 'RUNTIME_HOST_REGISTRAR_FLOOR_UNREADABLE',
  /**
   * 下限**装不上**：引擎没交回 in-process 子 Agent（远程 provider），
   * 或那个 Agent 的作用域里没有 `tools.guard` / `tools/pre-execute`。
   *
   * 与 `FLOOR_UNREADABLE` 分开：那一条要改**载荷的生产者**，这一条要看**引擎/provider**。
   */
  FLOOR_NOT_INSTALLABLE: 'RUNTIME_HOST_REGISTRAR_FLOOR_NOT_INSTALLABLE',
  /**
   * PRT-214 缺口②：Run 的**授权身份**载荷解释不了。
   *
   * 与 `FLOOR_UNREADABLE` 同一档、同样在**起跑之前**拒绝，但理由不同：
   * 下限读不懂时"照跑"= 强全面整段不在；身份读不懂时"照跑"= 这一次执行会被记在
   * **进程级那个空间**名下——不报错，只是错标，而审计从此不能用来追责。
   *
   *   > 一次"读不懂就按进程级继续"的起跑，
   *   > 与一次"把甲空间的事记在乙空间名下"的起跑，是同一个东西——
   *   > 只不过前者的归因里只有一句"这次没覆盖"。
   */
  IDENTITY_UNREADABLE: 'RUNTIME_HOST_REGISTRAR_IDENTITY_UNREADABLE',
  /**
   * **尝试挂一个不是函数的 `canRead`**（`createRuntimeHostInputsFactory({canRead})`
   * 的构造期检查）。
   *
   * ⚠️ 这个码的含义本批**收窄**了：它不再表示"没有 `canRead` 来源"（缺席现在是
   * 合法的，会被如实记成 `null`），只表示"给了一个不是函数、也不是 null/undefined 的
   * `canRead`"。静默丢掉它就会让"有人试图挂一个坏的"这件事在读数上消失。
   *
   * 与 `NO_SUBAGENTS_PORT` 仍然分开：前者要去修调用方给的那个值，后者要去看
   * 引擎装没装上。
   */
  NO_CAN_READ_SOURCE: 'RUNTIME_HOST_REGISTRAR_NO_CAN_READ_SOURCE',
})

/**
 * `currentModelSelection` 来源的**判据码**。
 *
 * 为什么要有码、而不是只报 `null`：`null` 有三种成因，修法不同——
 * 服务不在（去装基础组合层）、服务在但形状不对（去看引擎版本）、
 * 服务在、也调了，但返回值不是一个对象（去看引擎）。
 * 只有"没有选择"这一件事是同一件；成因不是。
 */
export const MODEL_SELECTION_CODES = Object.freeze({
  /** 现场有 `agentDefaultModel`，它给了一个对象——**原样**交出去。 */
  SERVICE_READ: 'RUNTIME_HOST_REGISTRAR_MODEL_SELECTION_READ',
  /** 现场没有那个服务。**不编一个模型名**：端口报 `null`，适配器判 `MODEL_UNAVAILABLE`。 */
  SERVICE_ABSENT: 'RUNTIME_HOST_REGISTRAR_MODEL_SELECTION_SERVICE_ABSENT',
  /** 服务在，但它没有 `currentSelection`（形状不对）——与"服务不在"必须分开。 */
  SERVICE_MALFORMED: 'RUNTIME_HOST_REGISTRAR_MODEL_SELECTION_SERVICE_MALFORMED',
  /** 服务调了，返回值不是对象：同样**不编**，与"服务不在"也分开。 */
  RESULT_MALFORMED: 'RUNTIME_HOST_REGISTRAR_MODEL_SELECTION_RESULT_MALFORMED',
})

/** 版本来源的具名码。"读到了"与"没读到"必须分得开。 */
export const DSH_VERSION_CODES = Object.freeze({
  /** 从现场安装里读到了版本。 */
  READ: 'RUNTIME_HOST_REGISTRAR_DSH_VERSION_READ',
  /** 有限层数内没有找到那份安装的 `package.json`。**不是**"版本是 0"。 */
  NOT_FOUND: 'RUNTIME_HOST_REGISTRAR_DSH_VERSION_NOT_FOUND',
  /** 找到了 `package.json` 但读不出一个非空字符串版本。 */
  MALFORMED: 'RUNTIME_HOST_REGISTRAR_DSH_VERSION_MALFORMED',
})

/**
 * 四项必需能力各自的**判据码**。
 *
 * 每一个都说明"这一项为什么是现在这个答案"，于是"未确认"不会与"引擎说不行"同形——
 * 前者要人去接来源，后者要人去换引擎。
 */
export const CAPABILITY_EVIDENCE_CODES = Object.freeze({
  /** 现场 provider 注册表确认支持 `outputSchema`。 */
  PROVIDER_REGISTRY_CONFIRMS: 'RUNTIME_HOST_REGISTRAR_CAPABILITY_PROVIDER_REGISTRY_CONFIRMS',
  /** 注册表在，但那个 provider 自报不支持 `outputSchema`。 */
  PROVIDER_LACKS_OUTPUT_SCHEMA: 'RUNTIME_HOST_REGISTRAR_CAPABILITY_PROVIDER_LACKS_OUTPUT_SCHEMA',
  /** 注册表读不到 / 是空的（引擎端口不在场）。 */
  PROVIDER_REGISTRY_ABSENT: 'RUNTIME_HOST_REGISTRAR_CAPABILITY_PROVIDER_REGISTRY_ABSENT',
  /** 注册了多于一个 provider：说不清这次会用哪一个，**不挑一个**。 */
  PROVIDER_REGISTRY_AMBIGUOUS: 'RUNTIME_HOST_REGISTRAR_CAPABILITY_PROVIDER_REGISTRY_AMBIGUOUS',
  /**
   * ★ **已退役**（2026-09-21）：`tool-permission-enforcement` 移出
   * `REQUIRED_CAPABILITIES` 之后，本模块不再对它表态 ⇒ **本码没有任何产出者**。
   *
   * 保留（而不是删掉）的理由：它出现在**已归档的证据文件**里
   * （`docs/superpowers/prt/PRT-253-capability-criteria.md`、
   * `PRT-HUMAN-INTERVENTION-2026-09-20.md`、`PRT-FINAL-REPORT-2026-09-18.md`），
   * 且仍登记在 `runtime/config-schema.mjs` 的 `NON_ENV_LITERALS` 里。
   * 删掉它会让那些归档读起来像"记了一个从未存在过的码"。
   *
   *   > 一个"保留着但没人再产出的码"，与一个"我当时忘了删"的码，
   *   > 在源码里长得一样——所以这里必须写明它**为什么**还在。
   *
   * ⚠️ 谁要是想用它，先回答一个问题：**强制面该由谁判？**
   * 今天的答案是启动自检（`composition-patch-layer` / `enforcement-mapping`），
   * 引擎探针不判——用它等于把那个决定又搬回引擎侧。
   */
  ENFORCEMENT_PLANE_MEASURED_ELSEWHERE: 'RUNTIME_HOST_REGISTRAR_CAPABILITY_ENFORCEMENT_PLANE_MEASURED_ELSEWHERE',
  /** 仓库记录了"abort 不保证杀死子代理"这条生产故障。 */
  CANCEL_NOT_GUARANTEED_BY_ENGINE: 'RUNTIME_HOST_REGISTRAR_CAPABILITY_CANCEL_NOT_GUARANTEED_BY_ENGINE',
  /** 引擎的一次性结果契约里没有用量字段。 */
  RESULT_CONTRACT_HAS_NO_USAGE: 'RUNTIME_HOST_REGISTRAR_CAPABILITY_RESULT_CONTRACT_HAS_NO_USAGE',
})

/**
 * 哪些包名算"引擎的安装"。
 *
 * 两个都认：DSH 的 CLI 包是 `@deepseek-ai/dsh`（`apps/cli/package.json`，实测
 * version `0.1.5-rc.2`），根工作区是 `@deepseek-ai/dsh-root`。只认这两个，
 * 免得从 Legion 自己的 `package.json` 里读出产品的版本当成引擎版本——
 * 那会是一个"有依据样子"的错读数。
 */
export const DSH_PACKAGE_NAMES = Object.freeze(['@deepseek-ai/dsh', '@deepseek-ai/dsh-root'])

/** 向上找 `package.json` 的层数上界。有限，免得在一个异常路径上走到盘根。 */
export const DSH_VERSION_SEARCH_DEPTH = 8

/**
 * 本模块的拒绝错误。
 *
 * ★ 码进**消息文本**的理由与 `runtime-host-row.mjs` 的 `rowError()` 逐字相同
 * （那里写全了）：DSH 的 app-boot 打的是 `err.stack` 首行，`err.code` **不在其中**，
 * 于是只放 `err.code` 的码在真进程的 stderr 上**根本看不见**——
 * 值班的人 grep 不到它，而"某个码不在 stderr 里"这一类断言也变成恒真。
 *
 * @param {string} code 具名拒绝码；同时进 `err.code` 与消息文本。
 * @param {string} message 人读的理由。
 * @param {object} [extra] 附加字段。
 * @returns {Error} `name` 为 `RuntimeHostRegistrarError` 的错误。
 */
function registrarError(code, message, extra = {}) {
  const err = new Error(`runtime-host-registrar 拒绝（code=${code}）：${message}`)
  err.name = 'RuntimeHostRegistrarError'
  err.code = code
  Object.assign(err, extra)
  return err
}

/** `ctx.get(name)`——**读不到就是 undefined**（第二个参数是 strict，不是 fallback）。 */
function serviceOf(ctx, name) {
  return ctx !== null && typeof ctx === 'object' && typeof ctx.get === 'function'
    ? ctx.get(name)
    : undefined
}

// ───────────────────────────────────────────────────────────────────────────
// 版本：从**正在跑的那份安装**读
// ───────────────────────────────────────────────────────────────────────────

/** 一个候选路径 → 绝对路径（`file://` 名字要转回来；其余的路径原样）。 */
function candidatePath(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const text = raw.trim()
  if (text.startsWith('file://')) {
    try {
      return fileURLToPath(text)
    } catch {
      return null
    }
  }
  return text
}

/** 从加载器树里取**字符串**模块名当候选（非字符串一律不猜）。 */
function loaderModuleNames(ctx) {
  const loader = serviceOf(ctx, 'loader')
  if (loader === null || typeof loader !== 'object' || typeof loader.entries !== 'function') return []
  const out = []
  try {
    for (const entry of loader.entries()) {
      const name = entry?.options?.name
      if (typeof name === 'string' && name !== '') out.push(name)
    }
  } catch {
    // 树读了一半抛错：不给部分结果——版本来源少一个候选不等于"读到了别的"。
    return []
  }
  return out
}

/**
 * 版本搜索的候选：**本进程的入口** + 加载器树里的模块名。
 *
 * `process.argv[1]` 是主候选，理由是实测的（文件头）：DSH 进程的入口就是那份安装里的
 * `apps/cli/lib/bin.js`。加载器树里那些 `file://` 行是**第二个**候选——
 * 在带 bundle 的真实部署里它们也指回同一份安装。
 */
export function dshInstallCandidates({ ctx = null, argvEntry = process.argv[1] } = {}) {
  const out = []
  const push = (p) => {
    if (p !== null && !out.includes(p)) out.push(p)
  }
  push(candidatePath(argvEntry))
  for (const name of loaderModuleNames(ctx)) push(candidatePath(name))
  return out
}

/**
 * 从候选路径向上找 DSH 安装的 `version`。
 *
 * 纯 fs 逻辑，可注入（用例拿它测"读到 / 读不到 / 读到畸形"三条分支）。
 *
 * @param {object} [o]
 * @param {string[]} [o.candidates] 候选**文件**路径（从它们的目录开始向上找）。
 * @param {(path: string) => string} [o.readTextFile] 读文本（默认 `readFileSync`）。
 * @param {number} [o.maxDepth] 向上层数上界。
 * @returns {{ok: boolean, code: string, version: string|null, packageName: string|null, source: string|null, searched: number, reason: string|null}}
 */
export function readDshVersionOfInstall({
  candidates = [],
  readTextFile = (p) => readFileSync(p, 'utf8'),
  maxDepth = DSH_VERSION_SEARCH_DEPTH,
} = {}) {
  const list = Array.isArray(candidates) ? candidates : []
  let searched = 0
  let sawPackageJson = false
  for (const raw of list) {
    if (typeof raw !== 'string' || raw === '') continue
    let current = resolve(raw)
    for (let depth = 0; depth <= maxDepth; depth += 1) {
      const dir = dirname(current)
      if (dir === current) break // 到根了
      const pkgPath = join(dir, 'package.json')
      searched += 1
      let text = null
      try {
        text = readTextFile(pkgPath)
      } catch {
        text = null // 这一层没有 package.json（或读不了）：继续向上，不猜
      }
      if (typeof text === 'string' && text !== '') {
        sawPackageJson = true
        let parsed = null
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = null
        }
        if (parsed !== null && typeof parsed === 'object' && DSH_PACKAGE_NAMES.includes(parsed.name)) {
          if (typeof parsed.version !== 'string' || parsed.version.trim() === '') {
            return {
              ok: false,
              code: DSH_VERSION_CODES.MALFORMED,
              version: null,
              packageName: parsed.name,
              source: pkgPath,
              searched,
              reason: `${pkgPath} 的 name 是 ${parsed.name}，但 version 不是一个非空字符串` +
                '——**不编一个版本**：一个编出来的版本会让兼容判定在一个认不出的引擎上给"可以跑"',
            }
          }
          return {
            ok: true,
            code: DSH_VERSION_CODES.READ,
            version: parsed.version,
            packageName: parsed.name,
            source: pkgPath,
            searched,
            reason: null,
          }
        }
      }
      current = dir
    }
  }
  return {
    ok: false,
    code: DSH_VERSION_CODES.NOT_FOUND,
    version: null,
    packageName: null,
    source: null,
    searched,
    reason: `在 ${list.length} 个候选路径的 ${maxDepth} 层之内` +
      `${sawPackageJson ? '没有找到 name 属于 ' + JSON.stringify([...DSH_PACKAGE_NAMES]) + ' 的 package.json' : '没有读到任何 package.json'}` +
      '——探测据此报 `version: null`，而版本读不出来按**不兼容**处理' +
      '（「读不到」不等于「没问题」）',
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 四项能力：一项读现场注册表，三项按**未确认**报
// ───────────────────────────────────────────────────────────────────────────

/**
 * 现场 provider 注册表里**那一个** provider 的 `outputSchema` 支持。
 *
 * 为什么"多于一个就报未确认"而不是挑第一个：`runtime/adapters/dsh/index.mjs` 派发时
 * 用的是 `RunRequest` 里那个 provider 名，而探针**拿不到那一次请求**。
 * 挑一个等于替调用方猜"你会用谁"——猜对了没有功劳，猜错了就是一条
 * "有依据样子"的错误能力表。
 */
function structuredResultEvidence(ctx) {
  const registry = serviceOf(ctx, 'subagents')
  if (registry === null || typeof registry !== 'object'
    || typeof registry.list !== 'function' || typeof registry.getProvider !== 'function') {
    return {
      satisfied: false,
      code: CAPABILITY_EVIDENCE_CODES.PROVIDER_REGISTRY_ABSENT,
      source: null,
      reason: '进程里读不到子代理 provider 注册表（`subagents` 服务不在或形状不对）：' +
        '说不清这次会用哪一个 provider，因此这一项报**未确认**，而不是 true',
    }
  }
  let names = null
  try {
    names = registry.list()
  } catch {
    names = null
  }
  if (!Array.isArray(names) || names.length === 0) {
    return {
      satisfied: false,
      code: CAPABILITY_EVIDENCE_CODES.PROVIDER_REGISTRY_ABSENT,
      source: null,
      reason: '子代理 provider 注册表是空的（或 `list()` 没有返回数组）：没有 provider 可以支持 ' +
        '`outputSchema`，这一项报未确认',
    }
  }
  if (names.length > 1) {
    return {
      satisfied: false,
      code: CAPABILITY_EVIDENCE_CODES.PROVIDER_REGISTRY_AMBIGUOUS,
      source: null,
      reason: `注册了 ${names.length} 个 provider（${names.join(', ')}）：探针拿不到那一次请求会用哪一个，` +
        '**不挑一个**，这一项报未确认',
    }
  }
  const name = names[0]
  let provider = null
  try {
    provider = registry.getProvider(name)
  } catch {
    provider = null
  }
  const advertised = provider?.capabilities?.outputSchema
  if (advertised !== true) {
    return {
      satisfied: false,
      code: CAPABILITY_EVIDENCE_CODES.PROVIDER_LACKS_OUTPUT_SCHEMA,
      source: `subagents.getProvider(${JSON.stringify(name)}).capabilities.outputSchema`,
      reason: `现场唯一的 provider ${JSON.stringify(name)} 没有把 outputSchema 报成 true` +
        `（读到 ${JSON.stringify(advertised)}）：引擎的 start() 会据此**拒收**带 schema 的请求，` +
        '所以这一项报未确认',
    }
  }
  return {
    satisfied: true,
    code: CAPABILITY_EVIDENCE_CODES.PROVIDER_REGISTRY_CONFIRMS,
    source: `subagents.getProvider(${JSON.stringify(name)}).capabilities.outputSchema`,
    reason: null,
  }
}

/**
 * 四项必需能力**逐项**的根据。
 *
 * @returns {{capabilities: object, evidence: object}}
 *   `capabilities` 是 `probe.mjs` 要的布尔表（只有显式 true 才算具备）；
 *   `evidence` 是逐项的判据码与来源说明，给运维与人读。
 */
export function runtimeCapabilityEvidence(ctx) {
  const structured = structuredResultEvidence(ctx)
  const evidence = {
    'structured-result': structured,
    // ★ 2026-09-21 业主裁决：这一项**已移出 `REQUIRED_CAPABILITIES`**。
    //
    //   它以前在这里报 `satisfied: false`（码 `ENFORCEMENT_PLANE_MEASURED_ELSEWHERE`），
    //   而现在 `REQUIRED_CAPABILITIES` 里没有它了 ⇒ **本函数不再对它表态**。
    //
    //   为什么不继续报一个 `false`：本函数产出的表会被 `probeRuntime()` 当作
    //   **引擎自报的能力表**交出去（`probeDshRuntime()` → `capabilities`）。
    //   在里面放一个产品侧能力，等于**替引擎答了一个它不负责的问题**——
    //   而那个 `false` 会被下游读成"产品没有强制面"。
    //
    //   > 一份"我顺手把产品那格也填成 false"的能力表，
    //   > 与一份"引擎真的不具备这项能力"的能力表，在 `probe.mjs` 的眼里是同一个东西。
    //
    //   强制面由启动自检 ①`composition-patch-layer` 与 ④`enforcement-mapping` 判，
    //   那两项**直接读补丁层**，与本函数无关。
    'cancel-and-timeout': {
      satisfied: false,
      code: CAPABILITY_EVIDENCE_CODES.CANCEL_NOT_GUARANTEED_BY_ENGINE,
      source: 'runtime/adapters/dsh/port.mjs 文件头记录的生产故障',
      reason: '引擎契约声称 `request.signal` / `run.dispose()` 会终止执行，而本仓库记录了相反的现场事实：' +
        '「subagent 可能挂死且 run.result 永不结算（abort 不保证杀死子代理）」。' +
        '适配器的看门狗正是为它存在——**不乐观**，这一项报未确认',
    },
    'usage-reporting': {
      satisfied: false,
      code: CAPABILITY_EVIDENCE_CODES.RESULT_CONTRACT_HAS_NO_USAGE,
      source: 'DSH SubagentResult 契约（output / structured? / diagnostic? / stopReason）',
      reason: '引擎一次性子代理的结果契约里**没有**任何用量字段，而 ' +
        '`runtime/adapters/dsh/usage.mjs` 的 `collectUsage()` 读的是 result.usage / tokenUsage / tokens。' +
        '一次 run 拿不回 token 用量：这一项报未确认',
    },
  }

  const capabilities = {}
  for (const name of REQUIRED_CAPABILITIES) {
    capabilities[name] = evidence[name]?.satisfied === true
  }
  return { capabilities, evidence }
}

/**
 * 装载期检查：能力表**恰好**覆盖产品的必需清单。
 *
 * 与 `root-row.mjs` 的 `NONE_SHORTCUT_CHECKED` 同一条理由：靠契约的东西要在装载期
 * 测一遍。`REQUIRED_CAPABILITIES` 加一项而本模块没跟上时**当场抛**，
 * 而不是安静地少报一项——后者会让探针在缺一项能力时仍然报 ok。
 */
export function assertCapabilityTableComplete() {
  const known = Object.keys(runtimeCapabilityEvidence(null).evidence)
  const missing = REQUIRED_CAPABILITIES.filter((c) => !known.includes(c))
  const extra = known.filter((c) => !REQUIRED_CAPABILITIES.includes(c))
  if (missing.length > 0 || extra.length > 0) {
    throw registrarError(RUNTIME_HOST_REGISTRAR_CODES.CAPABILITY_TABLE_MISMATCH,
      `能力表与 REQUIRED_CAPABILITIES 不一致（少：${missing.join(', ') || '无'}；多：${extra.join(', ') || '无'}）。` +
      '少报一项会让探针在缺能力时仍然可能报 ok——这条契约必须在装载期就对上')
  }
  return true
}

/** 装载期结论（`true`；不成立就抛）。 */
export const CAPABILITY_TABLE_CHECKED = assertCapabilityTableComplete()

// ───────────────────────────────────────────────────────────────────────────
// 探针
// ───────────────────────────────────────────────────────────────────────────

/**
 * `probeRuntime()` 的实现：报**从现场读到**的版本与能力表。
 *
 * 形状是 `runtime/adapters/dsh/port.mjs` 的端口契约要的那个：
 * `{ version, capabilities }`。额外的 `versionEvidence` / `capabilityEvidence`
 * 是给运维与人读的判据——`probe.mjs` 只读 `version` 与 `capabilities`，
 * 多出来的键不影响它的判定（也就不会把判据码混进布尔表）。
 */
export function probeDshRuntime(ctx, { readVersion = readDshVersionOfInstall, argvEntry } = {}) {
  const versionReading = readVersion({
    candidates: dshInstallCandidates(argvEntry === undefined ? { ctx } : { ctx, argvEntry }),
  })
  const { capabilities, evidence } = runtimeCapabilityEvidence(ctx)
  return {
    version: versionReading.ok === true ? versionReading.version : null,
    capabilities,
    versionEvidence: versionReading,
    capabilityEvidence: evidence,
  }
}

// ───────────────────────────────────────────────────────────────────────────
// `currentModelSelection`：从 DSH 一等服务 `agentDefaultModel` 读
// ───────────────────────────────────────────────────────────────────────────

/**
 * 读现场 `agentDefaultModel` 服务给出的**当前默认模型选择**。
 *
 * ## 形状先对过，不搬运
 *
 * 端口契约（`runtime/adapters/dsh/port.mjs:27`）要的是
 * `{provider, model, endpoint?, reasoningEffort?, limits?}`；
 * DSH 的 `currentSelection()`（`packages/core/agent-default-model/src/index.ts:49-57`）
 * 返回 `{provider, model, reasoningEffort?}`。前者所需的两项后者都给，
 * 后者多出来的 `reasoningEffort` 也在前者的可选表里。所以这里**原样返回**
 * 服务给的那个对象：搬一遍字段就多一份会漂移的副本，而"两个形状对不上"这件事
 * 会在某一天变成一次静默的字段丢失。
 *
 * ## 三条"没有"必须分开
 *
 * 都返回 `selection: null`，但码不同——因为修法不同：
 *   · 服务不在 → 去装基础组合层（或接受 `MODEL_UNAVAILABLE`）；
 *   · 服务在、没有 `currentSelection` → 引擎版本不对；
 *   · 调了、返回的不是对象 → 引擎行为不对。
 *
 * **服务自己抛错就让它抛**：`runtime/adapters/dsh/index.mjs:252-258` 已经把它
 * 归类成 `MODEL_UNAVAILABLE` 并带上真因。在这里吞掉它，会把"坏了"读成"没有"。
 *
 * @returns {{ok: boolean, code: string, selection: object|null}}
 */
export function readModelSelection(ctx) {
  const service = serviceOf(ctx, 'agentDefaultModel')
  if (service === undefined || service === null) {
    return { ok: false, code: MODEL_SELECTION_CODES.SERVICE_ABSENT, selection: null }
  }
  if (typeof service !== 'object' || typeof service.currentSelection !== 'function') {
    return { ok: false, code: MODEL_SELECTION_CODES.SERVICE_MALFORMED, selection: null }
  }
  const raw = service.currentSelection()
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, code: MODEL_SELECTION_CODES.RESULT_MALFORMED, selection: null }
  }
  return { ok: true, code: MODEL_SELECTION_CODES.SERVICE_READ, selection: raw }
}

// ───────────────────────────────────────────────────────────────────────────
// 一次 Run 的用量：注册仅主机会话投影
// ───────────────────────────────────────────────────────────────────────────

/** 注册结果的具名码。三种"没注册成"修法不同，所以不许合成一个。 */
export const USAGE_REGISTRATION_CODES = Object.freeze({
  /** 注册了。 */
  REGISTERED: 'RUNTIME_HOST_REGISTRAR_USAGE_PROJECTION_REGISTERED',
  /** 现场没有 `sessionProjections` 服务（DSH 组合层没挂那一行）。 */
  SERVICE_ABSENT: 'RUNTIME_HOST_REGISTRAR_USAGE_PROJECTION_SERVICE_ABSENT',
  /** 服务在，但没有 `register`（引擎版本不对）。 */
  SERVICE_MALFORMED: 'RUNTIME_HOST_REGISTRAR_USAGE_PROJECTION_SERVICE_MALFORMED',
  /** 注册抛了（例如同一个 key 被别的 stateVersion 占用）。 */
  REGISTER_THREW: 'RUNTIME_HOST_REGISTRAR_USAGE_PROJECTION_REGISTER_THREW',
})

/**
 * 注册 Legion 自己的用量投影。**不抛**：用量是可选信息。
 *
 * @returns {{ok: boolean, code: string, dispose: Function|null, detail: string|null}}
 */
export function registerUsageProjection(ctx) {
  const service = serviceOf(ctx, 'sessionProjections')
  if (service === undefined || service === null) {
    return { ok: false, code: USAGE_REGISTRATION_CODES.SERVICE_ABSENT, dispose: null, detail: null }
  }
  if (typeof service !== 'object' || typeof service.register !== 'function') {
    return { ok: false, code: USAGE_REGISTRATION_CODES.SERVICE_MALFORMED, dispose: null, detail: null }
  }
  try {
    const dispose = service.register(createUsageProjectionDefinition())
    return {
      ok: true,
      code: USAGE_REGISTRATION_CODES.REGISTERED,
      dispose: typeof dispose === 'function' ? dispose : null,
      detail: null,
    }
  } catch (err) {
    // ★ 吞掉异常**但把真因带出来**：注册失败（比如 key 被别的 stateVersion 占了）
    //   与"服务不在"是两件事，前者说明有人改了 stateVersion。
    //   *一个"注册抛了但被吞掉"的部署，与一个"没注册"的部署，
    //   在下游读到的 `null` 上是同一个东西——区别只在这条 detail。*
    return {
      ok: false,
      code: USAGE_REGISTRATION_CODES.REGISTER_THREW,
      dispose: null,
      detail: err instanceof Error ? err.message : String(err),
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 工厂：`canRead` **可选**（缺席如实记成 null），端口接上模型选择
// ───────────────────────────────────────────────────────────────────────────

/**
 * 造一个 `setDshRuntimeInputsFactory()` 认的工厂：`(ctx) => ({runtimeHost, canRead})`。
 *
 * ## 为什么工厂收 `ctx`
 *
 * `runtime-host-row.mjs` 在**它自己的 `apply` 期**调工厂，并把那个 Context 交进来。
 * 少了它，工厂只能靠一个全局 Context 或者靠模块求值期的现场——前者是隐式依赖，
 * 后者在 DSH 里根本不存在（模块求值期还没有树）。这是本批对上一批契约的**唯一**
 * 一处扩展，方向与上一批文件头写的那句一致：「工厂在本行 `apply` 时被调用：
 * 它需要 DSH 进程的现场」——现在它**真的**拿得到现场。
 * `currentModelSelection` 同样要现场（`ctx.get('agentDefaultModel')`）。
 *
 * 零参工厂（上一批的用例形状）不受影响：多传一个参数，JS 会忽略。
 *
 * ## 为什么 `canRead` **缺席是合法的**
 *
 * 见文件头那四条测量：Runtime 进程里**没有**这个绑定的读者。所以缺席被**如实**
 * 记成 `canRead: null` 交出去，而不是抛、不是替身。
 *
 * 但**"没有来源"与"挂了个坏的"是两件事**：构造期给了个不是函数、也不是
 * null/undefined 的值 → 当场拒（`NO_CAN_READ_SOURCE`）。静默丢掉它，就再也没有人
 * 看得出有人试图挂它。给的**是**函数时按引用带出，不包一层。
 */
export function createRuntimeHostInputsFactory({
  canRead = null,
  probe = probeDshRuntime,
  readVersion = readDshVersionOfInstall,
} = {}) {
  if (canRead !== null && canRead !== undefined && typeof canRead !== 'function') {
    throw registrarError(RUNTIME_HOST_REGISTRAR_CODES.NO_CAN_READ_SOURCE,
      `canRead 要么是一个函数，要么是 null/undefined（表示"没有来源"），收到 ${typeof canRead}。` +
      '一个"挂了一个不是函数的"与"明确没有来源"必须在读数上分得开——静默丢掉它，' +
      '就再没有人看得出有人试图挂它')
  }
  // ★ 缺席**如实记成 `null`**：不是 `() => true`，不是 `() => false`，不是空对象。
  const suppliedCanRead = canRead ?? null
  return function runtimeHostInputsFactory(ctx) {
    if (ctx === null || typeof ctx !== 'object' || typeof ctx.get !== 'function') {
      throw registrarError(RUNTIME_HOST_REGISTRAR_CODES.NO_CONTEXT,
        `工厂需要一个 Cordis Context（要能 \`ctx.get\` 读现场服务），收到 ${ctx === null ? 'null' : typeof ctx}`)
    }

    const subagents = serviceOf(ctx, 'subagents')
    if (subagents === null || typeof subagents !== 'object' || typeof subagents.start !== 'function') {
      throw registrarError(RUNTIME_HOST_REGISTRAR_CODES.NO_SUBAGENTS_PORT,
        '进程里没有可用的 `subagents` 服务（`start(provider, request)` 不在）。' +
        '它是 `startRun` 的**唯一**真来源——编一个"能返回结果的 startRun"就是伪造执行引擎')
    }

    // ── 下限告诫（notices）的出口（PRT-214 续）────────────────────────────
    //
    // 安装点（`dsh-composition/run-floor.mjs`）把告诫交给它的 `log` 口，
    // 而**本文件是那个口的唯一生产供给者**。此前两处调用都不传 `log`，
    // 于是"为了拦一个推送而关掉整个 shell"这条告诫在真实部署里
    // 产生了、跨了线、然后被丢掉——`log = null` 的默认值让它悄无声息。
    //
    //   > 一个"产出了告诫但没接出口"的下限，与一个"根本没产生告诫"的下限，
    //   > 在运维读到的输出里是同一个东西。
    //
    // 用 `warn` 而不是 `info`：这类告诫说的是一次**代价**（连带禁掉了别的工具、
    // 或一条政策禁令在执行面上落不了地），它是运维需要看见的东西，
    // 级别不该与"已挂上下限"这种正常状态输出相同。`ctx.logger` 缺席时
    // 返回 `null`（而不是空函数）——那让"这个部署没有日志设施"成为
    // 调用点上可读的事实，而不是一次静默的丢弃。
    const floorLog = typeof ctx.logger?.warn === 'function'
      ? (line) => ctx.logger.warn(line)
      : (typeof ctx.logger?.info === 'function' ? (line) => ctx.logger.info(line) : null)

    // ── 一次 Run 的 token 用量：注册一个**仅主机**会话投影（usage-reporting）──
    //
    // `SubagentResult` 契约里没有 usage 字段（逐字读过），所以用量拿不回来；
    // 但 DSH 把每条 `assistant/message` 的用量写进会话日志，而
    // `ctx.sessionProjections` 是它的一等读面（框架急切驱动纯折叠）。
    // 归因键是 `SubagentRun.id === SessionId`（`startRun` 的返回值上就有）。
    //
    // ★ 注册是**effect**（住在调用它的 fiber 上）：本行的 fiber 卸载时，
    //   这个投影键跟着消失——不会留下一个没人读、也没人负责的注册。
    //
    // ★ 服务不在（DSH 组合层没挂 `sessionProjections`）时**不抛**：
    //   用量是可选信息，缺它不该让一次成功的启动变成失败。
    //   如实记下"没注册"，并让读取方按具名码读到这件事（见 `runUsageReader`）。
    const usageRegistration = registerUsageProjection(ctx)

    const runtimeHost = Object.freeze({
      startRun: (provider, options) => startRun(provider, options),
      probeRuntime: () => probe(ctx, { readVersion }),
      // ★ 端口契约里的**可选**方法，本批接上：来源是 DSH 一等服务
      //   `agentDefaultModel`。服务不在 → `null`（适配器判 `MODEL_UNAVAILABLE`），
      //   **绝不**编一个模型名。判据码用 `readModelSelection()` 单独读得到。
      currentModelSelection: () => readModelSelection(ctx).selection,
      // ★ 一次 Run 的用量。`sessionId` 由调用方从 `run.id` 取（那是 `SessionId`）。
      //   读不到就返回 `null`——绝不补 0（理由见 usage-projection.mjs 的文件头）。
      runUsage: (sessionId) => readRunUsage(ctx, sessionId).usage,
    })

    /**
     * 在飞的下限载荷（按**对象身份**）。只有端口自己放进来的那些对象在里面，
     * 于是"这是不是我要管的那次 Run"由身份回答，不由顺序或 sessionId 猜。
     */
    const pendingFloors = new Set()
    /** 载荷 → 已装好的读数（含 dispose）。装上之后留着供收尾用。 */
    const installedFloors = new Map()

    /**
     * PRT-214 缺口②：同一套「在飞载荷按对象身份」的登记，给授权身份一份。
     *
     * 两份 Set/Map 而不是合并成一份：合并之后"这次没给下限"与"这次没给身份"
     * 会共用一个缺席读数，而两者的处置完全不同（前者 fail closed 拒绝一切工具，
     * 后者回落进程级身份）。
     */
    const pendingIdentities = new Set()
    const installedIdentities = new Map()
    /** 身份安装的诊断口。与 `floorLog` 同一档，但不抢占它的"告诫"语义。 */
    const identityLog = typeof ctx.logger?.info === 'function'
      ? (line) => ctx.logger.info(line)
      : null

    /**
     * 创建窗口那一钩（见上面 `startRun` 的长注释）。
     *
     * ⚠️ 这里**故意让安装失败抛出去**：`agent/created` 的同步抛出会否决这次发布
     * （`packages/core/agent/src/index.ts:548`：`A synchronous creation failure vetoes
     * publication and rolls back`），于是"下限装不上"直接变成"这个孩子没出生"，
     * 而不是"出生了但没人管"。**不用 try/catch 吞掉它。**
     */
    if (typeof ctx.on === 'function') {
      ctx.on('agent/created', ({ agent }) => {
        const payload = runFloorCarrierOf(agent)
        if (payload === undefined || !pendingFloors.has(payload)) return
        pendingFloors.delete(payload)
        installedFloors.set(payload, installRunFloorIntoAgent({
          agent,
          installation: createRunFloorInstallation(payload),
          log: floorLog,
        }))
      })

      /**
       * ★ PRT-214 缺口②：**同一个创建窗口**里装授权身份。
       *
       * 与下限共用一个钩子，但**各认各的载体键**（`legionRunIdentity` /
       * `legionRunFloor`），于是"这次只给了其中一个"是一件读得出来的事。
       *
       * ⚠️ 这里**不抛**（下限那一钩故意抛）：身份不新增任何判定点，只改一份既有判定
       * 读到的值，所以它没有"装一半"的中间态——装不上只会让这次 Run 用进程级身份，
       * 而那**已经**是一个被记下来的读数（`runIdentityOverlayOf === undefined`）。
       * 让身份装失败否决整个孩子的发布，会把一次"归属回落"升级成"任务生不出来"。
       */
      ctx.on('agent/created', ({ agent }) => {
        const payload = runIdentityCarrierOf(agent)
        if (payload === undefined || !pendingIdentities.has(payload)) return
        pendingIdentities.delete(payload)
        installedIdentities.set(payload, installRunIdentityIntoAgent({
          agent,
          installation: createRunIdentityInstallation(payload),
          log: identityLog,
        }))
      })
    }

    /**
     * 一次 Run 的起跑。三种处境：
     *   · 端口选项里**没有**下限键 → 老调用方/别的适配器：按引用转发，一个字段都不动；
     *   · 有键 → **按 Run** 安装，装不上就拒绝；
     *   · 载荷解释不了 → 起跑前拒绝（具名码）。
     */
    async function startRun(provider, options) {
      const payload = runFloorOptionOf(options)
      const identityPayload = runIdentityOptionOf(options)
      if (payload === undefined && identityPayload === undefined) {
        // 真来源：引擎的 subagents 服务。**不包一层**，按引用转发，
        // 于是"端口连的是谁"与"引擎是谁"是同一个对象——多包一层就会有一个会漂移的替身。
        return subagents.start(provider, options)
      }

      // ── PRT-214 缺口②：身份载荷先读，**缺席与读不懂分开**──────────────
      //
      // 缺席（适配器没给这个键）是**合法**的：老调用方、别的适配器都可能是这样，
      // 那时沿用进程级身份——行为与接线之前逐字相同，而且 `runIdentityOverlayOf`
      // 会如实返回 `undefined`，所以"这次没有覆盖"是一个读得出来的事实。
      //
      // 读不懂则**在起跑之前拒绝**：一次形状坏掉的载荷完全可能是"想覆盖但写错了
      // 字段名"，回落会让它**看起来**成功了——而它失败的形状正是"把甲空间的事
      // 记在乙空间名下"，不报错、只错标。
      let identityInstallation = null
      if (identityPayload !== undefined) {
        identityInstallation = createRunIdentityInstallation(identityPayload)
        if (identityInstallation.state === RUN_IDENTITY_STATES.REFUSED) {
          throw registrarError(RUNTIME_HOST_REGISTRAR_CODES.IDENTITY_UNREADABLE,
            `这次 Run 的授权身份载荷解释不了（${identityInstallation.code}）：${identityInstallation.message}。`
            + '**不回落成进程级身份照跑**：回落之后这次执行会被安静地记在'
            + '进程级那个空间名下，而审计从此不能用来追责')
        }
      }

      let installation = null
      if (payload !== undefined) {
        try {
          installation = createRunFloorInstallation(payload)
        } catch (e) {
          throw registrarError(RUNTIME_HOST_REGISTRAR_CODES.FLOOR_UNREADABLE,
            `这次 Run 的下限载荷解释不了（${e?.code ?? 'unknown'}）：${e?.message ?? String(e)}。`
            + '**不跳过安装照跑**：跳过就等于把"派生失败"洗成"这次没有东西要禁止"')
        }
        // ★ 解释不了的载荷**在起跑之前**拒绝这次 Run。
        //
        //   `createRunFloorInstallation` 对坏载荷也会给出一份"拒绝一切"的 guard，
        //   而这一档**不是**它：那一份是给"给了下限、但读不懂"用的（第三档），
        //   与"没给下限"（`absent`，同样拒绝一切，但理由是 §6.8 `:479` 的发布前姿态——
        //   静态下限比的是**执行面的工具名**，而派生出来的名单写的是 Legion 的
        //   **能力名**，名字空间不相交，按名字装进来一个真工具名都拦不住）
        //   是两件事。坏载荷是一次接线错误，不是一份政策：照跑会让它伪装成一个
        //   能跑的 Run，于是"搬运写坏了"只会表现为"这次任务什么也没干成"。
        if (installation.state === RUN_FLOOR_STATES.REFUSED) {
          throw registrarError(RUNTIME_HOST_REGISTRAR_CODES.FLOOR_UNREADABLE,
            `这次 Run 的下限载荷解释不了（${installation.code}）：${installation.message}。`
            + '**不跳过安装照跑**：跳过就等于把"派生失败"洗成"这次没有东西要禁止"')
        }
      }

      // ★ 两个载体**各挂各的键**，一次转发。合并成一个对象会让"这次只给了其中一个"
      //   变成不可判定，而两者的缺席处置完全不同（见文件头那份清单）。
      let forwarded = options
      if (installation !== null) {
        forwarded = withRunFloorCarrier(forwarded, payload)
        pendingFloors.add(payload)
      }
      if (identityInstallation !== null) {
        forwarded = withRunIdentityCarrier(forwarded, identityPayload)
        pendingIdentities.add(identityPayload)
      }

      let run
      try {
        run = await subagents.start(provider, forwarded)
      } catch (e) {
        pendingFloors.delete(payload)
        installedFloors.delete(payload)
        pendingIdentities.delete(identityPayload)
        installedIdentities.delete(identityPayload)
        throw e
      }

      // ── 身份：装到那个 Agent 上（**装不上不拒绝起跑**，见下面的理由）──────
      if (identityInstallation !== null && identityInstallation.state === RUN_IDENTITY_STATES.INSTALLED) {
        let identityReading = installedIdentities.get(identityPayload)
        if (identityReading === undefined) {
          pendingIdentities.delete(identityPayload)
          const agent = run?.localAgent
          if (agent !== undefined) {
            // 身份安装**不需要** ctx 缝合点（见 `../run-identity.mjs` 文件头），
            // 所以这里唯一会抛的是"它不是 Agent"——那说明引擎交回了一个别的东西。
            identityReading = installRunIdentityIntoAgent({
              agent, installation: identityInstallation, log: identityLog,
            })
          } else {
            // ★ 与下限**不同**：远程 provider 交不回 in-process Agent 时，
            //   下限拒绝起跑（装不上 = 强全面整段不在），而身份**不拒绝**——
            //   它不新增判定点，落空只会让这次 Run 用进程级身份，
            //   而"归属回落"不该把一次任务变成生不出来。
            //   代价如实记一条日志，于是它不是无声的。
            identityLog?.(`[run-identity] 这次 Run 的身份没有装上：引擎交回的运行没有 `
              + `in-process 子 Agent（provider=${String(provider)}）——本次执行会用**进程级**身份，`
              + '它的归属可能是错的（这是"归属回落"，不是"拒绝起跑"）')
          }
          if (identityReading !== undefined) installedIdentities.set(identityPayload, identityReading)
        }
      } else {
        pendingIdentities.delete(identityPayload)
      }

      // ── 下限：装不上就拒绝起跑（原有语义，一个字都没动）──────────────────
      let reading = installedFloors.get(payload)
      if (installation !== null && reading === undefined) {
        // 创建窗口那一钩没接上（端口 ctx 没有 on，或 provider 不走 agent/created）。
        // 退到"拿回句柄之后立刻装"——但**装不上就拒绝**，不退化成"没装"。
        pendingFloors.delete(payload)
        const agent = run?.localAgent
        if (agent === undefined) {
          throw registrarError(RUNTIME_HOST_REGISTRAR_CODES.FLOOR_NOT_INSTALLABLE,
            `这次 Run 的下限装不上：引擎交回的运行没有 in-process 子 Agent（provider=${String(provider)}）。`
            + '下限的落点就是那个 Agent 的作用域，没有它这次 Run 一个工具都没人管——'
            + '**拒绝起跑**，而不是让它跑在一个没有下限的执行面上')
        }
        try {
          reading = installRunFloorIntoAgent({ agent, installation, log: floorLog })
        } catch (e) {
          throw registrarError(RUNTIME_HOST_REGISTRAR_CODES.FLOOR_NOT_INSTALLABLE,
            `这次 Run 的下限装不上（${e?.code ?? 'unknown'}）：${e?.message ?? String(e)}`)
        }
        installedFloors.set(payload, reading)
      }

      // 收尾：Run 结算就把那几个面撤掉。**不影响返回值**——句柄原样交出去
      // （`runtime-host-registrar-row.test.mjs` 有一条按引用比较的用例）。
      const settle = () => {
        pendingFloors.delete(payload)
        installedFloors.delete(payload)
        pendingIdentities.delete(identityPayload)
        // ★ 先取出来再删：反过来的话 `dispose()` 拿到的是 `undefined`，
        //   而"撤不掉身份"这件事**没有任何东西会报**——下一个 Run 若复用了同一个
        //   Agent 对象（测试替身、或引擎的复用路径），它会读到上一个 Run 的空间。
        const identityReading = installedIdentities.get(identityPayload)
        installedIdentities.delete(identityPayload)
        try { reading?.dispose() } catch { /* Agent 自己的作用域回收也会撤它 */ }
        try { identityReading?.dispose() } catch { /* 同上 */ }
      }
      if (run?.result !== undefined && typeof run.result.then === 'function') {
        run.result.then(settle, settle)
      }

      return run
    }

    return { runtimeHost, canRead: suppliedCanRead }
  }
}

/**
 * ★★ PRT-214 缺口①：**按 Run** 安装静态 hard floor。
 *
 * ## 这一段为什么住在宿主端口里，而不是装配方
 *
 * spec §6.8 `:440` 的原话是「**DshRuntimeAdapter 安装到目标 Agent/Session**」。
 * 而"目标 Agent"只有引擎在派生子 Agent 的那一刻才知道——`startRun` 正好是
 * Legion 与引擎之间的那道缝，也是**每次 Run 只过一次**的地方。
 * 装配级（`assembleEnforcement({floor})`）是进程级、只过一次，所以它装出来的下限
 * 必然被第二个 Run 继承（见 `../run-floor.mjs` 文件头）。
 *
 * ## 两种装法，一个结论
 *
 *   ① **创建窗口**（正常路径）：下限随 `agentOptions` 走（`withRunFloorCarrier`），
 *      `agent/created` 在 `agents.create()` 内、`followup()` **之前**派发，
 *      于是安装发生在任何一次模型请求之前——顺序保证，不是时序侥幸。
 *   ② **回退**（端口 ctx 没有 `ctx.on`，或引擎的 provider 不走 `agent/created`）：
 *      `start()` 结算之后立刻装到 `run.localAgent` 上。
 *
 * 两条路都**不是**"装不上就照跑"：`localAgent` 缺席（远程 provider）或那个 Agent
 * 的作用域里没有 guard/pre-execute 落点时，这次 Run **当场拒绝**（具名码）。
 * 这就是"缺席不许退化成空下限"在安装点的落法。
 *
 * ## 为什么载荷要按**对象身份**配对，而不是按 FIFO / sessionId
 *
 * 并发两个 Run 各带各的载荷对象；`agent.options[KEY]` 就是端口这次传进去的那个对象
 * 本身（见 `../run-floor.mjs` 里 `RUN_FLOOR_CHILD_OPTION_KEY` 的注释）。
 * 按身份配对，于是"第二个 Run 拿到了第一个 Run 的下限"在构造上不可能发生：
 *
 *   > 一个"按到达顺序给下一次创建分配下限"的实现，
 *   > 与一个"每次 Run 都拿对自己的下限"的实现，在串行的那些用例里是同一个东西——
 *   > 只不过前者在两次派工重叠时会把甲的下限装到乙的头上。
 */

/**
 * ★ 注册发生在**模块求值期**——与 `team-hub/approval-registrar-row.mjs` 同一个形状。
 *
 * 补丁层按路径加载本模块时拿到的是本模块的 default；Node 的 ESM 语义保证
 * 被 import 的模块先求值完，才轮到 import 它的那个模块——也就必然先于挂载那个
 * 插件的 Fiber 的 `apply`。所以无论 Loader 并发创建多少行、无论别的行挂起多久，
 * `setDshRuntimeInputsFactory()` 都已经执行过了。
 *
 * 生产默认**没有** `canRead` 来源 → 工厂被调用时**成功**，并把这一缺席如实记成
 * `canRead: null`。这不是"少挂了一样"：注册了、并且**缺席本身是一个分得开的值**，
 * 这两件事在读数上分得开（上一版会在这里以 `NO_CAN_READ_SOURCE` 拒绝——那条
 * 拒绝拒绝的是一个在这个进程里没有读者的输入，见文件头）。
 *
 * 它同时给 `runtimeHost` 接上了 `currentModelSelection`（来源：`agentDefaultModel`）。
 */
export const registeredRuntimeHostInputsFactory = createRuntimeHostInputsFactory()

/** `setDshRuntimeInputsFactory()` 给的那次注销（幂等；只撤掉**自己**那一次注册）。 */
const undoRegistration = setDshRuntimeInputsFactory(registeredRuntimeHostInputsFactory)

/** 撤销上面那次注册（用例专用：反向对照要在同一进程里做）。 */
export function unregisterRuntimeHostInputsFactory() {
  undoRegistration()
}

/**
 * ★ 默认导出就是**真的那个** `runtime-host-row` 插件对象（`===`，不是形状相同的替身）。
 *
 * 补丁层里的行 id 与插件名仍然是 `legion-runtime-host`：换掉的只是
 * "这一行的模块从哪里加载"，挂载审计读的那两个字段一字未改。
 */
export default realRuntimeHostRow
