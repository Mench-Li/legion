// runtime/dsh-composition/plugins/approval-answerer.mjs
// ============================================================================
// PRT-214：`legion-enforcement-approval-answerer` 的**插件模块本体**。
//
// ## 它挂在哪 —— 而且**不是**接管 `approval` 服务
//
// 我此前把这一行规划成"`disabled` 掉 base bundle 的 `approval` 行、自己
// `provide('approval', …)`"。**那是错的**，读了 DSH 的源码才发现：
//
//     ApprovalService（packages/interaction/user-approval/src/index.ts）
//       1. 先按 session 策略判：`'never'` → 直接 `'rejected'`，**不问任何人**
//       2. 再 `ctx.waterfall(target, 'approval/request', req, () => 'unavailable')`
//       3. 把 `approval/asked` + `approval/decided` 这一对**审计事件**落进 session
//
// 也就是说 `ApprovalService` 是**策略 + 审计层**，它把判定**委托给 answerer 链**。
// Legion 该做的是加入那条链，不是取代那个服务：
//
//     ctx.on('approval/request', async (req, next) => {
//       return 一个结局   // 认领这次询问
//       // 或
//       return next()     // 让给别人
//     })
//
//   > 一个"自己接管 approval 服务"的实现，
//   > 与一个"接进 answerer 链"的实现，在一个人批准之后看起来是同一个东西——
//   > 只不过前者的审计事件得靠我们自己再写一遍，
//   > 而写第二遍的东西会与 DSH 的那一遍漂移。
//
// 顺带：不接管服务就**没有服务注册冲突**，所以那一行 base bundle 完全不用动。
//
// ## ★ 一个真实的限制：answerer 拿不到工具参数
//
// DSH 递过来的是（`tools/src/index.ts:1696`）：
//
//     { agent, toolName, callId, reason, signal }
//
// **没有 arguments。** 而 team-hub 的权限检查要靠参数算绑定哈希。
// 所以 answerer **不能**自己造出这次审批；它只能：
//
//   ① 按 `callId` 去在飞登记簿里取 `pre-execute` 行留下的投影；
//   ② 取不到就 `next()` **让给别人**（见下）。
//
//   > 一个"没有投影也照样去问审批箱"的实现，
//   > 与一个"人批了、执行时哈希对不上、票据作废"的实现，是同一个东西——
//   > 只不过前者会让每一次批准都白批。
//
// ## ★ 为什么"取不到就 next()"而不是"取不到就 unavailable"
//
// 登记簿里没有这个 `callId`，意思是**这次调用不是 Legion 拦下来的**
// （可能是别的来源发起的询问，或者 pre-execute 行还没装上）。
// 此时**认领**会让 Legion 抢答一切——把一个本来有 TUI/桌面答主的部署
// 变成"什么都答不上来"，而 DSH 的默认兜底恰好也是 `unavailable`，
// 于是这种破坏**在读数上完全看不出来**。
//
//   > 一个"抢答一切、于是把别人能答的问题也答成不可用"的 answerer，
//   > 与一个"根本没接进来"的 answerer，在用户那里是同一个东西——
//   > 只不过前者的用例是绿的，而且它还能把好部署弄坏。
//
// 反过来，**有**投影却问不到 hub（超时 / 不可达）→ 认领并返回 `unavailable`：
// 那是我们的权威范围，spec §6.8 要求 fail closed 且**不得等待**。
// ============================================================================

import { createApprovalAnswerer } from '../enforcement.mjs'
import { IN_FLIGHT } from '../inflight.mjs'

export const APPROVAL_ANSWERER_PLUGIN_VERSION = 1

export const APPROVAL_ANSWERER_PLUGIN_NAME = 'legion-enforcement-approval-answerer'

/** 构造期与运行期的失败码。 */
export const APPROVAL_ANSWERER_CODES = Object.freeze({
  /** 没给 `port`——没有端口就造不出审批，**不兜底**。 */
  NO_PORT: 'APPROVAL_ANSWERER_NO_PORT',
  /** `approval/request` 事件端口不存在（运行时没挂 ApprovalService）。 */
  NO_EVENT_SEAM: 'APPROVAL_ANSWERER_NO_EVENT_SEAM',
})

function answererError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/**
 * 造出这个 Cordis 插件。
 *
 * @param {object} options
 * @param {(projection: object, opts: {onConnected?: Function|null, signal?: AbortSignal|null,
 *   responseTimeoutMs?: number|null}) => Promise<string>} options.port
 *   **必需**：team-hub 审批端口（`createHubApprovalPort` 的返回形状）。
 *   它取**投影**而不是 `{toolName, callId}`——因为绑定哈希要从参数算。
 * @param {object} [options.registry] 在飞登记簿；默认是进程级那一份。
 * @param {number} [options.connectTimeoutMs]
 * @param {number} [options.responseTimeoutMs]
 * @param {boolean} [options.portsPhases] 端口是否自报分阶段。
 * @param {() => number} [options.now]
 * @param {(e: object) => void} [options.onOutcome] 观测点，**不参与判定**。
 * @param {(req: object, projection: object) => boolean} [options.claim]
 *   额外的认领判据（例如只认领某几个工具）。默认全部认领。
 * @returns Cordis 插件对象
 */
export function createApprovalAnswererPlugin({
  port,
  registry = IN_FLIGHT,
  connectTimeoutMs = 2000,
  responseTimeoutMs = 60_000,
  portsPhases = false,
  now = () => Date.now(),
  onOutcome = null,
  claim = null,
} = {}) {
  if (typeof port !== 'function') {
    throw answererError(APPROVAL_ANSWERER_CODES.NO_PORT,
      `${APPROVAL_ANSWERER_PLUGIN_NAME} 需要 port（team-hub 审批端口）。` +
      '**不兜底**：一个"没有端口也能用"的审批只能靠编或者靠放行，而两者都是静默降级')
  }
  if (registry === null || typeof registry?.peek !== 'function') {
    throw answererError(APPROVAL_ANSWERER_CODES.NO_PORT,
      `${APPROVAL_ANSWERER_PLUGIN_NAME} 的 registry 需要 peek(callId)`)
  }

  const plugin = {
    name: APPROVAL_ANSWERER_PLUGIN_NAME,
    // 声明依赖：没有 ApprovalService 就没有人会派发 `approval/request`。
    // 与 hard-floor 同理——**等待要被记录**，而不是靠"挂了但没人叫"。
    inject: ['approval'],

    apply(ctx, config) {
      if (typeof ctx.on !== 'function') {
        throw answererError(APPROVAL_ANSWERER_CODES.NO_EVENT_SEAM,
          `${APPROVAL_ANSWERER_PLUGIN_NAME} 需要 ctx.on`)
      }

      // ★ 复用 `createApprovalAnswerer`，不重写它。
      //
      // 它已经处理好了本行最要紧的几件事：两段式超时（连接慢 ≠ 响应慢）、
      // 超时/异常 → `unavailable`（**不是** `rejected`——故障不是决定）、
      // 闭集外的返回值 → `unavailable`（**不是**放行）。
      //
      // 这里唯一要补的是"它拿不到投影"——由登记簿补上。
      const answerer = createApprovalAnswerer({
        request: async ({ callId, signal, responseTimeoutMs: budget, onConnected }) => {
          const projection = registry.peek(callId)
          if (projection === undefined) {
            // 走到这里说明认领判据与登记簿在对账上不一致。
            // **不猜、不放行**：当作问不到人。
            return 'unavailable'
          }
          return port(projection, {
            onConnected,
            signal,
            responseTimeoutMs: budget ?? null,
          })
        },
        connectTimeoutMs,
        responseTimeoutMs,
        portsPhases,
        now,
        onOutcome,
      })

      const dispose = ctx.on('approval/request', async (req, next) => {
        // ① 没有 callId → 无从对账 → 让给别人（不是我们的询问）。
        const projection = typeof req?.callId === 'string' && req.callId !== ''
          ? registry.peek(req.callId)
          : undefined
        if (projection === undefined) return next()

        // ② 显式放弃认领（部署级配置）。
        if (typeof claim === 'function' && claim(req, projection) !== true) return next()

        // ③ 认领：这是我们拦下来的调用，去问审批箱。
        //
        // ★ **不做第二次闭集兜底。** 我第一版在这里又写了一遍
        //   `APPROVAL_OUTCOMES.includes(outcome) ? outcome : 'unavailable'`，
        //   断验证证明它**永远触发不了**：`createApprovalAnswerer` 已经把闭集外的
        //   返回值归一成 `unavailable`（`enforcement.mjs:543`），而 DSH 那边还会
        //   **再**归一化一次（`user-approval/src/index.ts:281`）。
        //
        //   > 一个"永远不会执行的兜底"，与一个"根本没有兜底"，
        //   > 在它能被触发的那一天之前是同一个东西。
        //
        //   保证只该写在一个地方；写三遍的那两遍不会更安全，只会更难维护。
        return await answerer({
          toolName: req.toolName,
          callId: req.callId,
          reason: req.reason,
          signal: req.signal,
        })
      })

      if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
      else if (typeof ctx.on === 'function') ctx.on('dispose', dispose)

      ctx.logger?.info?.(
        `[${APPROVAL_ANSWERER_PLUGIN_NAME}] v${APPROVAL_ANSWERER_PLUGIN_VERSION} 已加入 answerer 链` +
        `（连接 ${connectTimeoutMs}ms / 响应 ${responseTimeoutMs}ms，`
        + `${typeof claim === 'function' ? '带认领判据' : '认领全部 Legion 拦下的调用'}）`,
      )
    },
  }

  // ★ 诊断用（**不可枚举**）：本行**实际**闭包到的登记簿与端口。
  //
  // 登记簿必须与 `pre-execute` 行是**同一本**——那是两行唯一的会合点，
  // 而"共用"是身份、不是形状。端口则必须是调用方**真的**注入的那一个：
  // 少了这条身份，一个"配置解析对了、端口却在半路被换成另一个"的实现
  // 在形状断言下完全看不出来。
  //
  // 让行自己报出实际拿到的东西，是为了防住"装配方记下自己传了什么、
  // 然后对着那份记录断言"这种绿法。
  //
  // 不可枚举：活对象不能走 `JSON.stringify` / `Object.keys`。
  Object.defineProperty(plugin, 'registry', { value: registry, enumerable: false })
  Object.defineProperty(plugin, 'port', { value: port, enumerable: false })
  return plugin
}

/**
 * ⚠️ **没有可用的默认导出。**
 *
 * hard-floor 可以有 `export default createHardFloorPlugin()`，因为静态下限是一个
 * **常量**（`DEFAULT_HARD_FLOOR`）。本行不行：它需要一个接在 team-hub 上的
 * 审批端口，而那**不能由 YAML 的 `config` 携带**（`PatchOptions.config` 是数据，
 * 不是函数）。
 *
 * 于是有两条路，都需要先定下来，本模块**不替部署猜**：
 *
 *   a) 由 `pre-execute` 行（或一个装配函数）在进程内 `ctx.plugin(createApprovalAnswererPlugin({port}))`；
 *   b) 给一行装一个**从 config 造 hub 客户端**的默认导出（需要 `hubBaseUrl`/`scope`/`actor`），
 *      而那几个值目前没有任何权威来源（见 `docs/STATUS.md` 里 PRT-505 那条未决问题）。
 *
 * 在没有定下来之前，**故意不导出 default**：一个会挂载、却因为没端口而
 * 什么都不做的默认导出，正是本文件头那段话要防的东西——
 * 补丁层里会因此多一行"看起来装好了"的行。
 *
 *   > 一个"挂上了、但什么都没接管"的 answerer，
 *   > 与一个"从来没有被写进补丁层"的 answerer，在组合树上长得一模一样——
 *   > 只不过前者的文件看起来是装好的。
 *
 * 因此 `PATCH_LAYER_ROWS` 里这一行仍然是 `module: null`。
 *
 * PRT-214 组合根补记：**这一行现在有运行期模块了**——`./approval-answerer-row.mjs`。
 * 那条路走的是上面 (a) 的变体：模块的 `default` 导出从组合根（`../root.mjs`）
 * 取装配好的那一行，组合根没装好时在 `apply` 期**抛具名码**，不挂空 listener。
 * 本文件仍然刻意不导出 `default`——能导出 `default` 的必须是那个
 * "要么拿到端口、要么响亮失败"的模块，而不是这个"需要参数才能构造"的工厂。
 */
export const NO_DEFAULT_EXPORT_REASON = Object.freeze({
  code: 'APPROVAL_ANSWERER_NEEDS_RUNTIME_CONFIG',
  detail: '本行需要一个不能由 YAML 携带的 port；本文件刻意不导出 default。'
    + '运行期入口在 ./approval-answerer-row.mjs（由组合根 root.mjs 装配）',
})
