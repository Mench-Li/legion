// runtime/dsh-composition/assemble.mjs
// ============================================================================
// PRT-214：把强制面真的**装配**起来——这是此前一直"没定下来"的那条路径。
//
// ## 问题是什么
//
// 补丁层的三行 enforcement 各自需要一个**插件模块**，而其中两行
// （`pre-execute` / `approval-answerer`）都拿不到 YAML 能携带的配置：
//
//   · `pre-execute` 需要一条 `createEnforcementBridge(...)` 造的桥，而桥的参数有
//     Legion 身份（scope/actor/action）、策略端口 `decide`、岗位白名单 `whitelist`、
//     路径范围 `pathScope` —— 函数与运行时数据；
//   · `approval-answerer` 需要一个接在 team-hub 上的审批端口 —— 同样是函数。
//
// `PatchOptions.config` 是**数据**，装不下函数。所以这三行不能靠 `insert` 的
// `name` 直接加载。硬要写进去的后果是"挂上了但什么都没接管"：
//
//   > 一个"挂上了、但什么都没接管"的强制面，
//   > 与一个"从来没有被写进补丁层"的强制面，在组合树上长得一模一样——
//   > 只不过前者的文件看起来是装好的。
//
// ## 本模块的答案
//
// **装配方负责造一次桥、备一份登记簿，再把两行插件挂上去。**
// 三个强制点因此共享同一份投影与同一本账——这正是 `tool-request.mjs` 里那句
// "三个强制点共用**同一份**投影"能够成立的前提：
//
//   > 一个"三个强制点各自造一次桥"的装配，
//   > 与一个"三个强制点看到三个不同目标"的装配，是同一个东西——
//   > 只不过前者在只有一个强制点被触发时看起来是对的。
//
// ## 为什么不在这里读环境变量造 hub 客户端
//
// 因为 hub 地址 / scope / actor 的**权威来源还没定**（见 `docs/STATUS.md` 里
// PRT-505 那条未决问题：spec Appendix A.2 要求复用 `$DSH_HOME/.credentials.yaml`，
// 而 Legion 有零依赖规则）。本模块**不替部署猜**——猜出来的默认值
// （比如 `http://127.0.0.1:8787`）会让"没配"与"配对了"在读数上同形。
// 端口一律由调用方传入，缺了就抛。
// ============================================================================

import { createApprovalAnswererPlugin } from './plugins/approval-answerer.mjs'
import { createPreExecutePlugin } from './plugins/pre-execute.mjs'
import { createConnectorFeedbackPlugin } from './plugins/connector-feedback.mjs'
import { createRegistry } from '../connectors/registry.mjs'
import { createOutcomeListener } from '../connectors/outcome-port.mjs'
import { createConnectorDecisionPort } from '../connectors/decision-port.mjs'
import { createInFlightRegistry } from './inflight.mjs'
import { createEnforcementBridge } from './tool-request.mjs'

export const ASSEMBLE_VERSION = 1

/**
 * 读一行**实际**拿到的 `{ bridge, registry }`。
 *
 * ## 为什么必须"读行自己报的"，而不是"记下我传了什么"
 *
 * 本模块存在的全部理由是**两行共用同一份桥与同一本登记簿**。
 * 而"共用"是**身份**，不是形状：两份各自 `createInFlightRegistry()` 出来的
 * 登记簿有一模一样的接口，`put`/`peek` 各自都对，只在"一行 put 了、
 * 另一行 peek 不到"时才暴露。
 *
 *   > 一个"两份登记簿都有同样的方法"的装配，
 *   > 与一个"两行共用同一本"的装配，在形状断言下是同一个东西——
 *   > 只不过前者的失败要等到真的有人要审批的那一天。
 *
 * ★ 这里踩过一次：第一版在本函数所在模块里用 WeakMap **记下传参**
 * （`set(row, { bridge, registry: sharedRegistry })`），于是把一个
 * "答案行被传了另一本登记簿"的实现改出来之后，用例**照样全绿**——
 * 因为账本记的是我以为传了什么，不是行实际闭包到了什么。
 *
 *     > 一个"记录了我传了什么"的诊断，
 *     > 与一个"记录了行实际拿到什么"的诊断，在传错参数时是同一个东西——
 *     > 只不过前者的用例是绿的。
 *
 * 所以改为读**插件对象自己暴露的诊断属性**（`createPreExecutePlugin` /
 * `createApprovalAnswererPlugin` 用不可枚举属性挂上去），装配方不再自证。
 *
 * @returns {{bridge: object|null, registry: object|null}|null}
 *   不是本目录装配出来的行返回 `null`。
 */
export function bindingOf(row) {
  if (row === null || typeof row !== 'object') return null
  const registry = row.registry ?? null
  const bridge = row.bridge ?? null
  if (registry === null && bridge === null) return null
  return Object.freeze({ bridge, registry })
}

/** 装配期的失败码。 */
export const ASSEMBLE_CODES = Object.freeze({
  /**
   * ★★ F-21：给了 `connectorDeclarations` 却没给 `resolveConnectorId`。
   *
   * 两者必须**同时**给，理由见 `assembleEnforcement` 里那一段：连接器那一半
   * 的**判定面与反馈面是同一条链的两端**，只来一半会得到一个"永远合闸、
   * 而且一行错都不报"的熔断器。
   */
  NO_CONNECTOR_RESOLVER: 'ASSEMBLE_NO_CONNECTOR_RESOLVER',
  /** 没给 Legion 上下文（scope/actor/action/taskId/cwd）。 */
  NO_CONTEXT: 'ASSEMBLE_NO_CONTEXT',
  /** 没给策略端口 `decide`。**不给默认值**：默认放行是静默降级，默认拒绝是静默停摆。 */
  NO_DECIDE: 'ASSEMBLE_NO_DECIDE',
  /** 没给审批端口 `requestApproval`。 */
  NO_APPROVAL_PORT: 'ASSEMBLE_NO_APPROVAL_PORT',
})

function assembleError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/**
 * 装配完整的强制面。
 *
 * @param {object} cfg
 * @param {{scope: string, actor: string, action?: string, taskId?: string|null,
 *          cwd: string, platform?: string}} cfg.context Legion 身份（授权主体）。
 * @param {(projection: object) => Promise<object>|object} cfg.decide 策略端口。
 * @param {(projection: object, opts: object) => Promise<string>} cfg.requestApproval
 *   team-hub 审批端口（`createHubApprovalPort()` 的返回形状）。
 * @param {object} [cfg.floor] 静态下限。
 * @param {(p: object) => object} [cfg.whitelist] 岗位白名单（PRT-603）。
 * @param {(p: object) => object} [cfg.pathScope] 路径范围（PRT-604）。
 * @param {(p: object) => object} [cfg.executionScope] 命令/网络/MCP 范围（PRT-605）。
 * @param {(p: object) => object} [cfg.externalApiScope] 外部 API 读/写范围（PRT-606）。
 * @param {number} [cfg.connectTimeoutMs]
 * @param {number} [cfg.responseTimeoutMs]
 * @param {number} [cfg.approvalConnectTimeoutMs]
 * @param {number} [cfg.approvalResponseTimeoutMs]
 * @param {() => number} [cfg.now]
 * @param {object} [cfg.registry] 在飞登记簿；默认新建一份（**两行共用这一份**）。
 * @param {(e: object) => void} [cfg.onDecision]
 * @returns {{
 *   bridge: object,
 *   registry: object,
 *   rows: {preExecute: object, approvalAnswerer: object},
 *   mount: (ctx: object) => Promise<object[]>,
 *   dispose: () => Promise<void>,
 *   mountedRowNames: () => string[],
 *   enforcementSurfaces: () => object,
 * }}
 */
export function assembleEnforcement({
  context,
  decide,
  requestApproval,
  floor,
  whitelist = null,
  pathScope = null,
  /**
   * ★★★ PRT-605 的命令/网络/MCP 范围（2026-09-18 第 19 轮加）。
   *
   * 与 `pathScope` **同一个形状、同一条投递路线**：`(projection) => {allowed, code, reason}`，
   * 由 `execution-scope-port.mjs` 从 `LEGION_EXECUTION_SCOPE` 造出来。
   * 缺省 `null` ⇒ 桥那一格是放行，而 `enforcementSurfaces().executionScope` 读成 `false`。
   */
  executionScope = null,
  /**
   * ★★★ PRT-606 的外部 API 读/写范围（2026-09-18 第 20 轮加）。
   *
   * 与 `pathScope` / `executionScope` **同一个形状、同一条投递路线**：
   * `(projection) => {allowed, code, reason}`，由 `external-api-scope-port.mjs`
   * 从 `LEGION_EXTERNAL_API_SCOPE` 造出来。
   * 缺省 `null` ⇒ 桥那一格是放行，而 `enforcementSurfaces().externalApiScope` 读成 `false`。
   */
  externalApiScope = null,
  connectTimeoutMs = 2000,
  responseTimeoutMs = 3000,
  approvalConnectTimeoutMs = 2000,
  approvalResponseTimeoutMs = 60_000,
  now = () => Date.now(),
  registry = null,
  onDecision = null,
  /**
   * ★★ F-21 的**连接器那一半**（2026-09-18 加）。
   *
   * `connectorDeclarations`：`runtime/connectors/target-binding.mjs` 的
   * `bindConnectorTargets()` 产出的 `declarations`（**执行面只读的字段**那一片）。
   * `resolveConnectorId`：`(projection, exec) => string | null`——
   * 这一次调用属于哪一条连接器。
   *
   * ## 为什么这两个参数必须**成对**给
   *
   * `registry.mjs` 的 `decide()` **读**熔断器，改它的只有 `recordOutcome()`。
   * 只接判定面（给 declarations、不给反馈）得到的是
   * **一个永远合闸的熔断器**：注册表建得起来、`decide()` 答得出来、
   * 用例全绿，而 `enforcementSurfaces()` 里**连"连接器"这一格都没有**。
   *
   *   > 一个"接了连接器判定、但反馈面没装"的强制面，
   *   > 与一个"连接器从来不会因为失败而被拦下"的强制面，是同一个东西——
   *   > 只不过前者的组合树看起来是接好的。
   *
   * 所以本函数把它们做成**同一段代码的两半**：给了一个而不给另一个 ⇒
   * **抛具名码**，而不是"装一半、另一半悄悄缺席"。
   * 于是"两半一起上"是**结构**，不是文档里的一句话。
   *
   * ## 缺省 `null`：不装，且读得出来
   *
   * 两个都不给时行为与本批之前逐字相同，`enforcementSurfaces().connectorFeedback`
   * 读成 `false`——"没装"是**看得见**的。
   *
   * ⚠️ **本参数不会自己去读部署配置**：declarations 从哪来是第 14 条那个
   * 决定（`product/execution-plane-config.mjs` 今天**零生产导入方**）。
   * 这里只把"拿到 declarations 之后怎么装"这一段做好，
   * 并保证它**一次装齐两半**。
   */
  connectorDeclarations = null,
  resolveConnectorId = null,
  connectorShape = null,
} = {}) {
  if (context === null || typeof context !== 'object') {
    throw assembleError(ASSEMBLE_CODES.NO_CONTEXT,
      'assembleEnforcement 需要 Legion 上下文（scope / actor / cwd）。' +
      '**不给默认值**：一个默认的身份会让审计里的 actor 变成一个谁也不是的名字')
  }
  if (typeof decide !== 'function') {
    throw assembleError(ASSEMBLE_CODES.NO_DECIDE,
      'assembleEnforcement 需要 decide 端口（策略门）。' +
      '**不给默认值**：默认放行是静默降级，默认拒绝是静默停摆，两者都不会报错')
  }
  if (typeof requestApproval !== 'function') {
    throw assembleError(ASSEMBLE_CODES.NO_APPROVAL_PORT,
      'assembleEnforcement 需要 requestApproval 端口（team-hub 审批箱）')
  }

  // ★★ F-21：连接器那一半。**成对校验**——给了一个不给另一个是接线写错。
  if ((connectorDeclarations === null) !== (resolveConnectorId === null)) {
    throw assembleError(ASSEMBLE_CODES.NO_CONNECTOR_RESOLVER,
      'connectorDeclarations 与 resolveConnectorId 必须**一起**给。' +
      '只给 declarations 会装出一个**永远合闸**的熔断器（决定读得到、反馈没人写），' +
      '而它在 enforcementSurfaces() 里看起来是接好的；' +
      '只给 resolver 则没有任何连接器可记。**不给就两个都不给**（那就是本批之前的行为）')
  }
  if (resolveConnectorId !== null && typeof resolveConnectorId !== 'function') {
    throw assembleError(ASSEMBLE_CODES.NO_CONNECTOR_RESOLVER,
      `resolveConnectorId 必须是 (projection, exec) => string | null（收到 ${typeof resolveConnectorId}）`)
  }
  const connectorRegistry = connectorDeclarations === null
    ? null
    : createRegistry({ connectors: [...connectorDeclarations] })

  // ★ **一份**登记簿，两行共用。这是它们唯一的会合点。
  const sharedRegistry = registry ?? createInFlightRegistry()

  // ★ 反馈面的 listener：**先造**，因为桥要拿着它去填
  //   `enforcementSurfaces().connectorFeedback` 那一格。桥自己不订阅事件
  //   （订阅属于"行"，见 `plugins/connector-feedback.mjs`）。
  const connectorOutcomeListener = connectorRegistry === null
    ? null
    : createOutcomeListener({
      registry: connectorRegistry,
      resolveConnectorId,
      // ★ 与强制面**同一份**投影（桥按 callId 记忆）——两个点看两个目标
      //   正是 `tool-request.mjs` 记过的坑。
      projectionFor: (exec) => bridge.projectionFor(exec),
    })

  // ★★★ 判定面（F-21 第一半）：**替**在决策路径上，内部调 `decide` 当政策门。
  //
  //   到这里，两半才第一次共用**同一份** registry：
  //     · `decide()`    读熔断器（判定面）
  //     · `recordOutcome()` 写熔断器（反馈面）
  //   在 `connectorRegistry === null` 时两者都是 `null`，行为逐字不变。
  const connectorDecisionPort = connectorRegistry === null
    ? null
    : createConnectorDecisionPort({
      registry: connectorRegistry,
      // ★ 判定面只拿得到 `projection`（这是 `decide` 端口唯一的入参），
      //   所以这里传一个**只吃 projection** 的适配器；`exec` 是反馈面才有的。
      //
      //   传两参的原始 resolver 也照样能用（多出来的那个参数被忽略），
      //   而"需要 exec 才能认出连接器"的 resolver 在判定面上会抛 ⇒
      //   端口把它算作**认不出** ⇒ 原样交给政策门（不是放行）。
      resolveConnectorId: (projection) => resolveConnectorId(projection, null),
      // ★★★ 2026-09-24（§5 第 23 条）：谓词端口**同批**接上 —— 少了它，
      //   `mcp__evil__x` 又只能落给政策门（"未知工具"是**可以被人批准**的）。
      ...(connectorShape === null ? {} : { connectorShape }),
      inner: decide,
    })

  const bridge = createEnforcementBridge({
    context,
    ...(floor === undefined ? {} : { floor }),
    decide,
    ...(connectorDecisionPort === null ? {} : { connectorJudgment: connectorDecisionPort }),
    requestApproval,
    whitelist,
    pathScope,
    executionScope,
    externalApiScope,
    connectTimeoutMs,
    responseTimeoutMs,
    approvalConnectTimeoutMs,
    approvalResponseTimeoutMs,
    now,
    ...(onDecision === null ? {} : { onDecision }),
    ...(connectorOutcomeListener === null ? {} : { connectorFeedback: connectorOutcomeListener }),
  })

  const rows = Object.freeze({
    preExecute: createPreExecutePlugin({ bridge, registry: sharedRegistry, onDecision }),
    /**
     * ★★ F-21 第二半那一行。`null` ⇒ 没有连接器登记表，**不挂**——
     * 而 `enforcementSurfaces().connectorFeedback` 同时读成 `false`，
     * 所以"没挂"在组合树的读数里是**看得见**的。
     */
    connectorFeedback: connectorOutcomeListener === null
      ? null
      : createConnectorFeedbackPlugin({ listener: connectorOutcomeListener }),
    approvalAnswerer: createApprovalAnswererPlugin({
      port: requestApproval,
      registry: sharedRegistry,
      connectTimeoutMs: approvalConnectTimeoutMs,
      responseTimeoutMs: approvalResponseTimeoutMs,
      now,
      ...(onDecision === null ? {} : { onOutcome: onDecision }),
    }),
  })

  /** 已经挂上的 fiber，供 `dispose()` 按序卸载。 */
  const mounted = []

  /**
   * 挂载账（PRT-214 收口续）：**只有 `mount()` 会往它里面写**。
   *
   * ## 它回答的是哪一个问题
   *
   * `reconcilePatchLayer()` 要为补丁层声明里的两行运行期行（`module: null` +
   * `runtimeModule`）找一个**真的来源**：它们永远不会是 loader 条目，所以按组合树
   * 查只会得到一条永远不变的红。而"装配好了"这件事**不能**当证据——
   * `enforcementSurfaces()` 在 `assembleEnforcement()` 一跑就是 true，
   * 与"有没有人调 `mount()`"完全无关：
   *
   *   > 一个"装配好了、端口齐全"的读数，
   *   > 与一个"真的挂上去了"的读数，在**没有挂载**的部署上完全同形——
   *   > 只不过前者来自一份注释，后者来自一次调用。
   *
   * 所以证据必须由**挂载这个动作本身**产生：账在 `mount()` 的第一刻被写，
   * `mount()` 没被调用过 ⇒ 账是空的 ⇒ 那两行按未生效处理（fail closed）。
   *
   * ## ★★ 两本账，不是一个（本批修的一个**确定的**假绿）
   *
   * 上面那段只回答了"`mount()` 调没调过"，**没有**回答"那两行挂上了没有"。
   * 而 `mount()` 是 async：`ctx.plugin(...)` 要跨越若干微任务才 settle。
   * 于是"在第一刻就写账"这件事本身留下了一个窗口——**在这个窗口里，
   * 账宣布两行已挂载，而实际上一个 `apply` 都还没被调用**：
   *
   *   ```js
   *   const mounting = root.mount(ctx)      // 同步返回
   *   root.mountedEnforcementRows()         // 已经是两行 ← 一行都没挂上
   *   ```
   *
   * 顺着 `reconcilePatchLayer()` → `startupSelfCheck()` 第①项 →
   * `bootstrapDshRuntime()` 注册端口，这个窗口在**最关键的那条保证**上是
   * 开着的：「强制面未生效时禁止自动执行」——那一刻强制面**一行都没在听**，
   * 而判决说"生效"。
   *
   *   > 一本"挂载一发起就宣布挂好了"的账，
   *   > 与一本"根本没记挂载"的账，在没有并发读者的世界里是同一个东西——
   *   > 只不过前者的假绿只在**读的时刻恰好在窗口里**才看得见。
   *
   * 本批的处置是把两件事分成两本账，各有各的名字：
   *   · `coveredRowNames` —— **本次挂载覆盖哪几行**（第一刻就写；给诊断与用例看）；
   *   · `settledRowNames` —— **真的挂上去了哪几行**（每个 `ctx.plugin` resolve 之后追加）。
   *
   * `mountedRowNames()` 是**证据**那一本，返回 `settledRowNames`——
   * 它的文档一直写着"真的挂上去的行名"，本批之前那句话是**不成立**的。
   *
   * ## ★ 另一个方向（为什么必须有 `mountSettled()`）
   *
   * 修正证据的语义会**引入**一个新的假红：观察者若在窗口里读账，会读到空集 ⇒
   * `ROW_MISSING` ⇒ 自检判未生效 ⇒ 拒绝注册 ⇒ **一个健康的部署起不来**。
   * 所以证据语义与读取时机必须**一起**改：`mountSettled()` 给出"这次挂载
   * settle 了没有"的等待口，观察方（`plugins/runtime-host-row.mjs` 的 `apply`
   * 本来就是 async）先 `await` 它再读。
   *
   *   > 一个"把假绿换成假红"的修法，
   *   > 与一个"什么都没修"的修法，在"产品能不能起来"这件事上是同一个东西。
   *
   * `dispose()` 两本都清——拆掉之后就没有"挂在进程里"的行了，账与挂载同生共死。
   */
  const coveredRowNames = []
  const settledRowNames = []

  /** 当前在飞的那次挂载。`mountSettled()` 等它；`dispose()` 之后复位。 */
  let inFlightMount = null

  return Object.freeze({
    bridge,
    registry: sharedRegistry,
    rows,

    /**
     * 这份装配**在当前进程里真的挂上去了的行名**（`rows.*.name`，逐字等于补丁层声明里的行 id）。
     *
     * 返回的是**快照**（冻结的新数组）：读的人不会因为下一次 `mount()` 把它改成半份。
     * 没有挂载过 / 挂载失败 / 已拆装 / **挂载还在飞** ⇒ 空数组。
     * **空数组不是"挂上了零行"的证据，是"没有任何一行可被证明已经挂上"**。
     *
     * ★ 最后那一项是本批补的：本函数此前返回的是"挂载**发起**时覆盖的行"，
     * 于是 `mount()` 一返回它就已经是满的，而那时一个 `apply` 都还没跑。
     */
    mountedRowNames: () => Object.freeze([...settledRowNames]),

    /**
     * 这次挂载**覆盖**了哪几行（第一刻就写）。
     *
     * 它是诊断读数，**不是**生效证据：它说的是"`mount()` 打算挂这两行"。
     * 把它当证据用就是本批修掉的那个假绿。留它是因为排查时要能分清两种情况：
     * "没发起挂载"（空）与"发起了但没挂成"（覆盖 ≠ 已挂）。
     */
    coveredRowNames: () => Object.freeze([...coveredRowNames]),

    /**
     * 等"当前这次挂载"settle（成功或失败都算 settle）。
     *
     * 没发起过挂载 ⇒ 立刻 resolve（调用方随后会读到空账 ⇒ fail closed，方向正确）。
     * 已经 settle ⇒ 立刻 resolve。还在飞 ⇒ 等它。
     *
     * **永远不 reject**：调用方要的是"可以读了"，不是"挂载成功了"——
     * 成功与否由 `mountedRowNames()` 的内容表达。让这个口把挂载的异常抛给观察者，
     * 会把"账里没有这两行"变成"观察者自己炸了"，而后者排障时看不出是挂载失败。
     */
    mountSettled: () => (inFlightMount === null ? Promise.resolve() : inFlightMount.then(() => {}, () => {})),

    /**
     * 把两行挂到一个 Context 上。
     *
     * 顺序是"先 answerer、后 pre-execute"。**但别把它当成一条因果保证**——
     * 我第一版在这里写着"反过来会在装载窗口里漏掉询问"，断验证证明那句话
     * 站不住：两次 `ctx.plugin` 都 `await` 到底，**根本没有窗口**，
     * 把顺序倒过来全部用例照样绿。
     *
     *   > 一个"顺序无关、却被写成顺序有关"的注释，
     *   > 与一个"顺序真的有关"的实现，在断验证面前是同一个东西——
     *   > 只不过前者会让下一个人去守一条不存在的约束。
     *
     * 顺序只是**约定**（先说"谁能答"，再说"谁会问"）。
     * 真正值得钉住的是另一件事，而且它**可测**：只挂了 pre-execute、
     * 没有 answerer 时，询问会落到 DSH 的兜底 `unavailable` →
     * **工具不执行**（fail closed），而不是放行。
     */
    async mount(ctx) {
      if (ctx === null || typeof ctx.plugin !== 'function') {
        throw assembleError(ASSEMBLE_CODES.NO_CONTEXT, 'mount 需要一个 cordis Context')
      }
      // 覆盖账在这里写（第一个 `await` 之前）——它是**诊断**读数，不是证据。
      coveredRowNames.length = 0
      for (const row of [rows.approvalAnswerer, rows.preExecute, rows.connectorFeedback]) {
        if (typeof row?.name === 'string' && row.name !== '') coveredRowNames.push(row.name)
      }
      settledRowNames.length = 0

      const run = (async () => {
        try {
          mounted.push(await ctx.plugin(rows.approvalAnswerer))
          // ★ 证据逐行追加：**resolve 之后**才算挂上。中途抛 ⇒ 这一行不留痕。
          if (typeof rows.approvalAnswerer?.name === 'string' && rows.approvalAnswerer.name !== '') {
            settledRowNames.push(rows.approvalAnswerer.name)
          }
          mounted.push(await ctx.plugin(rows.preExecute))
          if (typeof rows.preExecute?.name === 'string' && rows.preExecute.name !== '') {
            settledRowNames.push(rows.preExecute.name)
          }
          // ★ F-21 第二半：**有才挂**。没有时连 `ctx.plugin` 都不调——
          //   挂一个"什么都不记"的空行，会让组合树里多一行**看起来装好的**行。
          if (rows.connectorFeedback !== null) {
            mounted.push(await ctx.plugin(rows.connectorFeedback))
            if (typeof rows.connectorFeedback?.name === 'string' && rows.connectorFeedback.name !== '') {
              settledRowNames.push(rows.connectorFeedback.name)
            }
          }
        } catch (error) {
          // 挂了、但没挂成：证据账上不能留下"它挂过"的痕迹（fail closed 的方向是少报）。
          settledRowNames.length = 0
          throw error
        }
        return Object.freeze([...mounted])
      })()

      inFlightMount = run
      return run
    },

    /** 卸载两行。与 `mount` 对称——装配与拆装同生共死。 */
    async dispose() {
      // 反序卸载：后挂的先拆。
      while (mounted.length > 0) {
        const fork = mounted.pop()
        await fork.dispose()
      }
      // 拆完就没有"挂在进程里"的行了；两本账必须跟着清，否则"挂过"会变成单向门。
      coveredRowNames.length = 0
      settledRowNames.length = 0
      inFlightMount = null
    },

    /**
     * 强制面到底挂了几道。**证据是"装上了什么"，不是"配置里写了什么"**。
     * 复用桥自己那份口径，不另写一份——两份口径会漂移。
     */
    enforcementSurfaces: () => bridge.enforcementSurfaces(),
  })
}
