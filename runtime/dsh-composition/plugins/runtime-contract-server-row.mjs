// runtime/dsh-composition/plugins/runtime-contract-server-row.mjs
// ============================================================================
// Runtime Contract 服务端在**补丁层里的一行**（PRT-253 跨进程边界）
//
// ## 它补的是哪一截
//
// 上一批（`PRT-253-runtime-host-inputs.md` §5）量到的那条更大的缝是：
//
//   > 消费方（`product/orchestrator/worker.mjs`）与注册方（DSH Runtime 进程）
//   > **是两个进程**，所以 `bindDshRuntime()` 这条缝**填多好都不会改变 worker 的读数**。
//
// 本行是那条缝上的一台**监听器**：把 `createRuntimeContractServer()` 挂起来，
// 用**进程内**那台真的 `createDshRuntimeAdapter(runtimeHost)` 回答请求。
// 于是 worker 进程终于有一条路可以走到 DSH 执行引擎。
//
// ## ★ 挂载失败时：**降级 + 可见具名状态**，不拒绝启动
//
// 这是本批的一个**明确取舍**，理由写在下面（不是"图省事"）：
//
//   · 被要求装上的**强制面**（`legion-enforcement-root` 那一系）在挂不上时
//     **必须拒绝启动**——一个"强制面没生效却照跑"的 harness 会在没有任何征兆的
//     情况下执行真实的写操作。那条取舍已经在 PRT-214 文档 §9 里量过。
//   · 本行**不是强制面**：它是**出口**。出口挂不上时，harness 本身仍然可用、
//     worker 仍然报 `EXECUTOR_HOST_PORT_REQUIRED` 且**不认领任何任务**——
//     那是**可见**的降级，不是静默失效。
//   · 反过来（在 `apply` 期 throw）的代价是：**每一个** Runtime 进程都起不来。
//     一个"为了多报一条错而让整个产品起不来"的行，把一个可见的小故障换成了
//     一个不可用的大故障。
//
//   > 一个"因为出口装不上而整个产品起不来"的部署，
//   > 与一个"出口装不上、但产品照常在跑并明说自己干不了活"的部署，
//   > 后者的失败面小得多——而两者都能被看见。
//
// 所以本行**永不**在 `apply` 期抛：一律 `ctx.provide(RUNTIME_CONTRACT_SERVER_SERVICE, {ok:false, code, ...})`。
// 具名码让"哪一种装不上"是机器可读的（见 `RUNTIME_CONTRACT_ROW_CODES`）。
// 这一点与 `runtime-host-row.mjs` 的取舍**故意相反**，两份文件都写了自己的理由。
//
// ## 输入从哪来
//
// `{runtimeHost, token, bindPort, dataDir?, enforcement?}`，由**知道答案的那一侧**在
// 模块求值期注册（`setRuntimeContractInputsFactory`）。形状与
// `runtime-host-registrar-row.mjs` / `team-hub/approval-registrar-row.mjs` 完全一样：
// 注册方在自己的模块图里注册，然后 `export default` **真的那个**插件对象。
//
// 为什么必须是这个形状：Loader 用 `Promise.allSettled(config.map(create))`
// **并发**创建补丁行，所以"注册行先求值、本行后 apply"只在两个模块都不挂起时
// 碰巧成立。把注册放进本行自己的模块图里，ESM 保证被 import 的模块先求值完
// （2×2 矩阵读数见 PRT-214 文档 §10）。
//
// **一样默认值都没有**：没有 `runtimeHost` → `NO_HOST_PORT`；没有 `bindPort` →
// `NO_BIND_PORT`；没有 `token` → 服务照起但**需要鉴权的操作全部具名拒绝**
// （`RUNTIME_CONTRACT_NO_TOKEN`，由 server 那一层给）；没有 `dataDir` →
// 服务照起、端口照听，但**端口发布不出去**（`NO_PUBLICATION_DIR`，一条可见的降级；
// 跨进程那个 worker 会因此以 `RUNTIME_CONTRACT_PUBLICATION_ABSENT` 具名拒绝）。
// 编一个 token 或一个端口默认值，会让"没配"与"配好了"在读数上同形。
//
// `dataDir` 是 PRT-253 续批四加上去的**可选**输入：本行绑的是临时端口
// （`bindPort: 0`），消费方只有经发布文件才知道实际端口。见
// `../runtime-contract-publication.mjs` 的文件头。
//
// ## `canRead` 为什么**不**在这一行
//
// `runtime-host-row.mjs` 要 `canRead`（它跑启动自检并绑定强平面）。本行**不要**。
// 理由是一条真实的接线事实：`canRead` 是"这一次 Attempt 能读哪些上下文来源"，
// 它的权威在 **lease / 岗位清单**上，而 lease 由 **worker 进程**在认领之后才有。
// 在 Runtime 进程里配一个 `canRead`，无论填什么都是编的。
//
//   > 把 worker 侧的权限判定搬到 Runtime 进程里做，
//   > 与把它留在一个"没有 lease 可看"的地方，是同一个东西——
//   > 只不过前者看起来像已经解决了。
//
// 所以它留在 worker 一侧（见 `orchestrator/worker/executor-binding.mjs`）。
//
// ## `enforcement`（强制面结论）的两个来源与一条**不能说清**的边界
//
// 优先级：
//   ① 工厂给的 `enforcement`（显式的一手结论）；
//   ② 本行**惰性**读 `legionRuntimeHostBinding` 服务（`runtime-host-row.mjs` 发布的
//      绑定结论）。它 `ok === true` 就等价于"启动自检过了"，于是
//      `autoExecutionForbidden: false`；`state` / `patchVersion` / `checks` 原样带出。
//      惰性读是为了**顺序无关**：Loader 并发建行，`apply` 期读不到不等于没有。
//   ③ 都没有 → `RUNTIME_CONTRACT_ENFORCEMENT_UNAVAILABLE`。
//
//   ⚠️ **诚实的边界**：③ 同时覆盖两种处境——"`legion-runtime-host` 那一行没挂"
//   与"它挂了但启动自检拒绝"（拒绝时它 throw，因此**不发布**服务）。
//   从本行看这两者同形。区分它们需要 `runtime-host-row` 把自己的拒绝也发布出来，
//   而那不在本批范围内。这一条写在 PRT-253 文档的诚实边界里，
//   **不**用一句含糊的"强制面不可用"盖过去。
// ============================================================================

import { createDshRuntimeAdapter } from '../../adapters/dsh/index.mjs'
import { RUNTIME_CONTRACT_WIRE_VERSION } from '../../contracts/wire.mjs'
import {
  RUNTIME_CONTRACT_SERVER_CODES,
  createRuntimeContractServer,
} from '../runtime-contract-server.mjs'
import {
  clearRuntimeContractPublication,
  publishRuntimeContractEndpoint,
} from '../runtime-contract-publication.mjs'
import { RUNTIME_HOST_BINDING_SERVICE } from './runtime-host-row.mjs'

/** 行接口（插件名、服务名、状态字段、具名码）变化时递增。
 *
 * 续批四把它从 1 提到 2：服务值新增了 `publication` 状态字段
 * （见 `published()`）——按本节自己的规矩，状态字段变化就要递增。 */
export const RUNTIME_CONTRACT_ROW_VERSION = 2

/** 补丁行 id 与插件名。与 `legion-host.patch.yml` 里那一行逐字一致。 */
export const RUNTIME_CONTRACT_ROW_PLUGIN_NAME = 'legion-runtime-contract-server'

/** 这一行发布的服务名。名字进契约：别的行与探针按它读。 */
export const RUNTIME_CONTRACT_SERVER_SERVICE = 'legionRuntimeContractServer'

/**
 * 本行的具名码。**逐个列出**，因为它们是跨进程读数的一部分
 * （运维与用例都按码排查）。每一条都对应一种**不同的修法**。
 */
export const RUNTIME_CONTRACT_ROW_CODES = Object.freeze({
  /** `apply` 拿到的不是可用 Context。 */
  NO_CONTEXT: 'RUNTIME_CONTRACT_ROW_NO_CONTEXT',
  /** 没有人注册输入工厂（`setRuntimeContractInputsFactory`）。 */
  NO_INPUTS_FACTORY: 'RUNTIME_CONTRACT_ROW_NO_INPUTS_FACTORY',
  /** 工厂抛了。**与"没注册"不同**：一个接线坏了，一个接线缺一截。 */
  INPUTS_FACTORY_THREW: 'RUNTIME_CONTRACT_ROW_INPUTS_FACTORY_THREW',
  /** 工厂没给 `runtimeHost`（`{startRun, probeRuntime}`）。 */
  NO_HOST_PORT: 'RUNTIME_CONTRACT_ROW_NO_HOST_PORT',
  /** 工厂没给监听端口。**不给默认端口**（见文件头）。 */
  NO_BIND_PORT: 'RUNTIME_CONTRACT_ROW_NO_BIND_PORT',
  /** 造真适配器失败（`createDshRuntimeAdapter` 抛）。 */
  ADAPTER_CREATE_FAILED: 'RUNTIME_CONTRACT_ROW_ADAPTER_CREATE_FAILED',
  /** 适配器形状不合契约（`RUNTIME_CONTRACT_SERVER_BAD_ADAPTER` 的转发）。 */
  ADAPTER_SHAPE_INVALID: 'RUNTIME_CONTRACT_ROW_ADAPTER_SHAPE_INVALID',
  /** `listen` 失败（端口被占等）。**与"没配端口"不同**。 */
  LISTEN_FAILED: 'RUNTIME_CONTRACT_ROW_LISTEN_FAILED',
  /**
   * 装上了，但**没有** token：需要鉴权的操作全部拒绝（服务本身仍在监听 health）。
   *
   * 它不是"装不上"——服务在听、health 在答。所以它以**状态里的 warning** 出现，
   * 而不是以 `ok:false` 出现：把"降级"与"没装上"合成一个读数，
   * 会让一个只配了一半的部署看起来像完全没配。
   */
  NO_TOKEN: 'RUNTIME_CONTRACT_ROW_NO_TOKEN',
  /**
   * 装上了，但**没有**强制面结论的来源：`/enforcement` 会以
   * `RUNTIME_CONTRACT_ENFORCEMENT_UNAVAILABLE`（线上码）拒绝。
   *
   * 这里不另立一个同义的码：那个处境**只有一个**名字，写在 `wire.mjs` 里。
   */
  NO_ENFORCEMENT_SOURCE: 'RUNTIME_CONTRACT_ENFORCEMENT_UNAVAILABLE',
  /**
   * 装上了、也听上了，但输入工厂**没有给 `dataDir`**：端口无处发布。
   *
   * 后果是一条**可见的降级**：同进程/本机诊断仍然能用（服务值里有端口），
   * 但另一个进程里的 worker **发现不了**这台监听器——Launcher 会以
   * `RUNTIME_CONTRACT_PUBLICATION_ABSENT` 具名拒绝，而不是编一个 URL。
   *
   * ★ 它是一条 warning 而不是 `ok:false`：把"降级"与"没装上"合成一个读数，
   *   会让一个只配了一半的部署看起来像完全没配（与 `NO_TOKEN` 同一条判据）。
   */
  NO_PUBLICATION_DIR: 'RUNTIME_CONTRACT_ROW_NO_PUBLICATION_DIR',
  /**
   * 发布**写失败**（目录建不出来、盘满、权限）。与"没给目录"分开：
   * 一个要去看路径有没有被写坏，一个要去补输入。
   */
  PUBLICATION_FAILED: 'RUNTIME_CONTRACT_ROW_PUBLICATION_FAILED',
})

/**
 * 进程级的输入工厂。
 *
 * **单槽而不是栈**，与 `executor-binding.mjs` 的 `bindingStack` 不同——
 * 那条栈存在的理由是"同一进程里可能有多份绑定各自注销"。这里不会：
 * 一个进程里只应有一个契约出口（两个出口意味着两个端口、两个 token，
 * 而 worker 只知道一个）。后注册**覆盖**前一个并返回幂等的注销函数。
 */
let inputsFactory = null

/**
 * 注册输入工厂。返回**幂等**的注销函数（只撤掉自己那一次注册——
 * 若期间已被别人覆盖，注销是 no-op，不会把别人的注册撤掉）。
 */
export function setRuntimeContractInputsFactory(factory) {
  if (typeof factory !== 'function') {
    throw new TypeError('setRuntimeContractInputsFactory 需要一个函数：那才是"从哪里取输入"的答案')
  }
  const previous = inputsFactory
  inputsFactory = factory
  let undone = false
  return function unregister() {
    if (undone) return false
    undone = true
    if (inputsFactory === factory) inputsFactory = previous
    return true
  }
}

/** 当前工厂；没有时 `null`。 */
export function runtimeContractInputsFactory() {
  return inputsFactory
}

/** 撤销注册（用例专用：反向对照要在同一进程里做）。 */
export function resetRuntimeContractInputsFactory() {
  inputsFactory = null
}

function describe(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

/** 装上了但某个可选来源缺失时的**可见**状态（不是失败）。 */
function degraded(code, message, extra = {}) {
  const reasons = Object.freeze([...(extra.reasons ?? [])])
  const { reasons: _ignored, ...rest } = extra
  return Object.freeze({
    ok: false,
    code,
    rowVersion: RUNTIME_CONTRACT_ROW_VERSION,
    message: String(message ?? ''),
    listening: false,
    port: null,
    warnings: Object.freeze([]),
    // 降级路径也给出**形状完整**的 `publication`：读侧读到 `undefined` 时
    // "没这一项"与"没发布"看起来是同一个东西（与 heartbeat 的
    // `wired`/`enabled` 无条件给出同一条判据）。
    publication: Object.freeze({ published: false, path: null }),
    ...rest,
    reasons,
  })
}

/**
 * 从 `legionRuntimeHostBinding` 服务推导强制面结论。
 *
 * **只接受一种形态**：`{ok: true, ...}`。其余（服务不在、`ok` 不是 `true`）
 * 一律返回 `null`——本函数**不猜**。"读不到就当通过"会让
 * 「强制面未生效时禁止自动执行」这条保证变成一个装饰。
 *
 * 值本身是从**模块外**传进来的（`ctx.get` 的结果），因此这里不 import 任何东西。
 */
export function verdictFromRuntimeHostBinding(binding) {
  if (binding === null || typeof binding !== 'object' || binding.ok !== true) return null
  return Object.freeze({
    autoExecutionForbidden: false,
    state: binding.state ?? null,
    patchVersion: binding.patchVersion ?? null,
    checks: Object.freeze([...(binding.checks ?? [])]),
    reasons: Object.freeze([]),
    // 说清这条结论**是**从哪里来的。读者不必从字段猜。
    source: 'legionRuntimeHostBinding',
  })
}

/** 本行发布的服务值形状（真装上了）。 */
function published(server, { warnings = [], publication = null } = {}) {
  const state = server.state()
  return Object.freeze({
    ok: true,
    code: null,
    rowVersion: RUNTIME_CONTRACT_ROW_VERSION,
    message: null,
    reasons: Object.freeze([]),
    listening: state.listening === true,
    host: state.address === null ? null : state.address.host,
    port: state.address === null ? null : state.address.port,
    wireVersion: state.wireVersion ?? RUNTIME_CONTRACT_WIRE_VERSION,
    tokenConfigured: state.tokenConfigured === true,
    enforcementConfigured: state.enforcementConfigured === true,
    /**
     * 端口**发布**的结果（PRT-253 续批四）。
     *
     * 为什么把它放进服务值而不是只放进日志：另一个进程里的 worker 能不能
     * 发现本监听器，**取决**于这件事。一台"在听、但没人能发现"的监听器
     * 与一台不存在的监听器，对 worker 是同一个东西——
     * 只不过前者的服务值是 `ok:true`。
     *
     * `published:false` 时 `code` 说明为什么（`NO_PUBLICATION_DIR` /
     * `PUBLICATION_FAILED`），而那条码**同时**在 `warnings` 里。
     */
    publication: Object.freeze({
      published: publication === null ? false : publication.published === true,
      path: publication === null ? null : publication.path,
      code: publication === null ? null : publication.code,
    }),
    /**
     * 降级——**装上了但少配了一样**。它与 `ok:false` 必须分得开：
     * 一个是"出口不在"，一个是"出口在、某些操作会拒绝"。
     */
    warnings: Object.freeze([...warnings]),
  })
}

/**
 * 把「本进程实际绑在哪个地址上」发布到 DataDir 下（PRT-253 续批四）。
 *
 * `dataDir` 缺失 → `NO_PUBLICATION_DIR`；写失败 → `PUBLICATION_FAILED`。
 * 两条都**不**拒绝启动：监听器照常服务，只是另一个进程发现不了它。
 * 见 `RUNTIME_CONTRACT_ROW_CODES` 上那两段说明。
 */
function publishEndpoint(inputs, listened) {
  // `trim()` 而不是只判空串：**读侧**（`product/launcher/runtime-contract-endpoint.mjs`
  // 的 `runtimeContractEndpointPath`）判的就是 trim 之后非空。两边判据不一致时，
  // 一个 `"  "` 的 dataDir 会让这里"发布成功"、而那里报"没有 DataDir"——
  // 一个写进了别处、另一个在正确的地方找不到，两条读数都"合理"却互相矛盾。
  const raw = typeof inputs?.dataDir === 'string' ? inputs.dataDir.trim() : ''
  const dataDir = raw === '' ? null : raw
  if (dataDir === null) {
    return Object.freeze({
      published: false,
      path: null,
      code: RUNTIME_CONTRACT_ROW_CODES.NO_PUBLICATION_DIR,
      detail: '输入工厂没有给 dataDir：契约端口无处发布，另一个进程里的 worker 无法发现本监听器',
    })
  }
  const pid = typeof process !== 'undefined' && Number.isInteger(process.pid) ? process.pid : null
  const r = publishRuntimeContractEndpoint({
    dataDir,
    host: listened.host,
    port: listened.port,
    pid,
  })
  if (r.ok !== true) {
    return Object.freeze({
      published: false,
      path: null,
      code: RUNTIME_CONTRACT_ROW_CODES.PUBLICATION_FAILED,
      detail: `发布失败（内层码 ${r.code}）：${r.message}`,
    })
  }
  return Object.freeze({ published: true, path: r.path, code: null, detail: null })
}

/**
 * 真的那一行。
 *
 * `apply` **永不抛**——理由见文件头（降级 + 可见具名状态）。
 */
export const runtimeContractServerRow = {
  name: RUNTIME_CONTRACT_ROW_PLUGIN_NAME,

  async apply(ctx) {
    if (ctx === null || typeof ctx !== 'object' || typeof ctx.provide !== 'function') {
      // 连 Context 都没有时**没有地方发布状态**，只能抛。
      // 这是本行唯一会抛的路径：它意味着 DSH 的插件契约本身没被满足。
      throw new Error(
        `${RUNTIME_CONTRACT_ROW_CODES.NO_CONTEXT}：需要一个 Cordis Context（要能 ctx.provide 发布服务）`,
      )
    }

    const publishRefusal = (code, message, reasons = [], extra = {}) => {
      ctx.provide(RUNTIME_CONTRACT_SERVER_SERVICE, degraded(code, message, { reasons, ...extra }))
    }

    const factory = inputsFactory
    if (typeof factory !== 'function') {
      publishRefusal(
        RUNTIME_CONTRACT_ROW_CODES.NO_INPUTS_FACTORY,
        '没有人注册 Runtime Contract 的输入工厂（setRuntimeContractInputsFactory）。' +
        '**本行不补一个假的**：一个编出来的 runtimeHost 会让 worker 连上一台不存在的引擎，' +
        '而一个编出来的 token 会让"没鉴权"看起来像"鉴权过了"',
        [
          '修法：由部署方在自己的模块图里注册工厂并 export default 本行',
          '本行**不**因此拒绝启动：出口挂不上时 harness 仍可用，worker 仍报 HOST_PORT_REQUIRED 且不认领任务',
        ],
      )
      return
    }

    let inputs = null
    try {
      // 工厂拿得到**本行这一侧的** Context：真 `runtimeHost` 只能从现场服务上取。
      inputs = factory(ctx)
    } catch (e) {
      publishRefusal(
        RUNTIME_CONTRACT_ROW_CODES.INPUTS_FACTORY_THREW,
        `输入工厂抛了：${e?.message ?? String(e)}` + (e?.code === undefined ? '' : `（code=${e.code}）`),
      )
      return
    }
    if (inputs === null || typeof inputs !== 'object') {
      publishRefusal(
        RUNTIME_CONTRACT_ROW_CODES.NO_HOST_PORT,
        `输入工厂返回了 ${describe(inputs)}，而它必须返回 {runtimeHost, token, bindPort}`,
      )
      return
    }

    const runtimeHost = inputs.runtimeHost
    if (runtimeHost === null || typeof runtimeHost !== 'object') {
      publishRefusal(
        RUNTIME_CONTRACT_ROW_CODES.NO_HOST_PORT,
        `runtimeHost 是 ${describe(runtimeHost)}，而它必须是 {startRun, probeRuntime} 对象。` +
        '**不回落**：没有宿主端口就没有可暴露的引擎，"暴露一个空壳"比"明说自己没有"更坏',
      )
      return
    }

    const bindPort = inputs.bindPort ?? inputs.port
    if (typeof bindPort !== 'number' || !Number.isInteger(bindPort) || bindPort < 0 || bindPort > 65535) {
      publishRefusal(
        RUNTIME_CONTRACT_ROW_CODES.NO_BIND_PORT,
        `bindPort 是 ${JSON.stringify(bindPort)}，而它必须是 0..65535 的整数。` +
        '**端口没有默认值**：给一个默认端口会让"没配"与"配在这个端口上"在读数上同形。' +
        '用 0 让内核分配临时端口，实际端口从发布的服务值 `port` 读回',
      )
      return
    }

    // 强制面结论：显式 `enforcement` 优先；否则惰性读绑定服务（顺序无关）。
    const explicitEnforcement = typeof inputs.enforcement === 'function' ? inputs.enforcement : null
    const enforcement = explicitEnforcement ?? (async () => {
      const binding = typeof ctx.get === 'function' ? ctx.get(RUNTIME_HOST_BINDING_SERVICE) : undefined
      return verdictFromRuntimeHostBinding(binding === undefined ? null : binding)
    })

    let adapter
    try {
      adapter = createDshRuntimeAdapter(runtimeHost)
    } catch (e) {
      publishRefusal(
        RUNTIME_CONTRACT_ROW_CODES.ADAPTER_CREATE_FAILED,
        `createDshRuntimeAdapter 抛了：${e?.message ?? String(e)}`,
        ['宿主端口形状不对时适配器会当场拒绝——那正是要的行为，不在这里补一个能用的空壳'],
      )
      return
    }

    const created = createRuntimeContractServer({
      adapter,
      token: inputs.token ?? null,
      enforcement,
      host: typeof inputs.host === 'string' && inputs.host !== '' ? inputs.host : undefined,
      port: bindPort,
    })
    if (created.ok !== true) {
      const code = created.code === RUNTIME_CONTRACT_SERVER_CODES.BAD_ADAPTER
        ? RUNTIME_CONTRACT_ROW_CODES.ADAPTER_SHAPE_INVALID
        : RUNTIME_CONTRACT_ROW_CODES.ADAPTER_CREATE_FAILED
      publishRefusal(code, `契约服务端没有造出来（内层码 ${created.code}）：${created.message}`, created.reasons)
      return
    }

    const listened = await created.listen()
    if (listened.ok !== true) {
      // 关掉半开的服务端，避免留下一个"造了但没听"的对象。
      try { await created.close() } catch { /* 本来就没听上 */ }
      publishRefusal(
        RUNTIME_CONTRACT_ROW_CODES.LISTEN_FAILED,
        `契约服务端没有听上（内层码 ${listened.code}）：${listened.message}`,
        listened.reasons,
      )
      return
    }

    // ★ 端口**发布**（PRT-253 续批四）：本进程绑的是**临时端口**，
    //   而消费方（另一个进程里的 worker）只有在拿到它之后才能构造出
    //   `LEGION_RUNTIME_URL`。发布的时机**必须**是"listen 成功之后"——
    //   先发布再监听会让消费方拿到一个没人听的端口，而那个读数是
    //   `RUNTIME_UNREACHABLE`（看起来像网络问题）。
    //
    //   `dataDir` 缺失 → `NO_PUBLICATION_DIR`；写失败 → `PUBLICATION_FAILED`。
    //   两条都不拒绝启动：见 `RUNTIME_CONTRACT_ROW_CODES` 上那两段说明。
    const publication = publishEndpoint(inputs, listened)

    // 监听是一个**进程级副作用**：本行被卸载（HMR / stop）时必须关掉，
    // 否则同一个进程里的下一次启动会撞上自己的旧监听（EADDRINUSE）。
    // 形状照既有那几行：`ctx.effect` 收的是**返回 disposer 的回调**。
    //
    // 发布文件也在这里收尾：它描述的是"**本进程**在听哪个端口"，
    // 本行卸掉之后那句话就不成立了，留着它就是一份**陈旧发布**——
    // 而消费侧虽然还有 pid 兜底，让一个已经下线的监听器继续"看起来在"
    // 没有任何好处。
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        created.close().catch(() => undefined)
        if (publication.published === true) {
          clearRuntimeContractPublication({ dataDir: inputs.dataDir })
        }
      })
    }

    const warnings = []
    if (created.state().tokenConfigured !== true) warnings.push(RUNTIME_CONTRACT_ROW_CODES.NO_TOKEN)
    if (publication.code !== null) warnings.push(publication.code)

    ctx.provide(RUNTIME_CONTRACT_SERVER_SERVICE, published(created, { warnings, publication }))

    // ★ **不返回任何东西**。cordis 会把 `apply` 的返回值当**效果**收集，
    // 一个既不是函数、又没有 then / Symbol.iterator 的对象会当场报
    // `TypeError: Invalid effect`——并连带回滚本行已经 provide 出去的服务。
    // 这条教训在 `runtime-host-row.mjs` 上已经被真 Context 咬过一次。
  },
}

export default runtimeContractServerRow
