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
 * }}
 */
export function assembleEnforcement({
  context,
  decide,
  requestApproval,
  floor,
  whitelist = null,
  pathScope = null,
  connectTimeoutMs = 2000,
  responseTimeoutMs = 3000,
  approvalConnectTimeoutMs = 2000,
  approvalResponseTimeoutMs = 60_000,
  now = () => Date.now(),
  registry = null,
  onDecision = null,
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

  // ★ **一份**登记簿，两行共用。这是它们唯一的会合点。
  const sharedRegistry = registry ?? createInFlightRegistry()

  const bridge = createEnforcementBridge({
    context,
    ...(floor === undefined ? {} : { floor }),
    decide,
    requestApproval,
    whitelist,
    pathScope,
    connectTimeoutMs,
    responseTimeoutMs,
    approvalConnectTimeoutMs,
    approvalResponseTimeoutMs,
    now,
    ...(onDecision === null ? {} : { onDecision }),
  })

  const rows = Object.freeze({
    preExecute: createPreExecutePlugin({ bridge, registry: sharedRegistry, onDecision }),
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

  return Object.freeze({
    bridge,
    registry: sharedRegistry,
    rows,

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
      mounted.push(await ctx.plugin(rows.approvalAnswerer))
      mounted.push(await ctx.plugin(rows.preExecute))
      return Object.freeze([...mounted])
    },

    /** 卸载两行。与 `mount` 对称——装配与拆装同生共死。 */
    async dispose() {
      // 反序卸载：后挂的先拆。
      while (mounted.length > 0) {
        const fork = mounted.pop()
        await fork.dispose()
      }
    },

    /**
     * 强制面到底挂了几道。**证据是"装上了什么"，不是"配置里写了什么"**。
     * 复用桥自己那份口径，不另写一份——两份口径会漂移。
     */
    enforcementSurfaces: () => bridge.enforcementSurfaces(),
  })
}
