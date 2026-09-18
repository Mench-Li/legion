// runtime/dsh-composition/plugins/connector-feedback.mjs
// ============================================================================
// F-21 的**第二半**：把 DSH 的 `tools/result` 接到
// `runtime/connectors/outcome-port.mjs` 的监听器上。
//
// ## 为什么这必须是**单独一行**，不是挂在 pre-execute 那一行上
//
// 两行订阅的是**不同的事件**，语义也不同（`packages/core/tools/src/index.ts`）：
//
//   · `:146 'tools/pre-execute'` —— `@mode waterfall`，**判定**：放行 / 拒绝 / 问人；
//   · `:191 'tools/result'`      —— `@mode emit`，**观测**：
//     "Observe the frozen, lossless-JSON final outcome.
//      Listener failures are contained."
//
// 把两者塞进一行会有两个后果，都不报错：
//
//   1. "这一行挂上了"变得**含混**——它到底接管了判定、还是只接管了记录？
//      而 `enforcementSurfaces()` 是按**面**记账的，不是按行；
//   2. 卸载语义变了：只想要判定的人会连记录一起卸掉（或反过来）。
//
//   > 一个"判定与记录在同一行"的强制面，
//   > 与一个"记录器随判定器一起被卸掉"的强制面，在组合树上长得一模一样——
//   > 只不过后者的熔断器会**永远合闸**，而没有任何一行会报这件事。
//
// ## 它为什么**不**做任何判定
//
// 本行**只**观测。`tools/result` 是 `emit`，没有返回值，所以它在结构上
// 改不了这次调用——这正是记录器要的方向（见 `outcome-port.mjs` 文件头：
// 一个能拒绝工具调用的失败记录器，会在连接器抖动的第一次就把它自己的观测
// 变成一次新的失败）。
//
// ## 生命周期：`ctx.effect`，与 pre-execute 那一行同一口径
//
// `ctx.on` 返回的 disposer 交给 `ctx.effect()`；没有 `ctx.effect` 时退到
// `ctx.on('dispose', …)`。**不依赖宿主帮我们收**：一个"靠宿主兜住"的
// 订阅会在热重载时留下第二个监听器，于是每次结果被记**两遍**——
// 而两遍失败会让熔断器比它该有的速度**快一倍**地跳闸。
// @module runtime/dsh-composition/plugins/connector-feedback
// ============================================================================

/** 改动绑定方式时递增。 */
export const CONNECTOR_FEEDBACK_PLUGIN_VERSION = 1

export const CONNECTOR_FEEDBACK_PLUGIN_NAME = 'legion-enforcement-connector-feedback'

/** 构造期的失败码。 */
export const CONNECTOR_FEEDBACK_CODES = Object.freeze({
  /** 没给 listener，或者给的 listener 不是函数。 */
  NO_LISTENER: 'CONNECTOR_FEEDBACK_NO_LISTENER',
  /** `tools/result` 事件端口不存在。 */
  NO_EVENT_SEAM: 'CONNECTOR_FEEDBACK_NO_EVENT_SEAM',
})

function feedbackError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/**
 * 造出这个 Cordis 插件。
 *
 * @param {object} options
 * @param {(exec: object, result: unknown) => void} options.listener
 *   **必需**：`createOutcomeListener()` 的返回值。
 *   本行不自己造它——它需要连接器登记表与"这次调用属于哪条连接器"的解析器，
 *   那些都是**运行时**配置（与 pre-execute 那一行需要桥同理）。
 * @returns Cordis 插件对象
 * @throws {Error} `NO_LISTENER` —— 构造期就拒
 */
export function createConnectorFeedbackPlugin({ listener } = {}) {
  // ★ 构造期 fail closed：一个"没有 listener 也能挂上"的行只能靠静默丢弃，
  //   而"挂了但什么都没记"与"从没挂过"在 `enforcementSurfaces()` 里同形。
  //   注意这与桥那边**分工不同**：桥报的是 `enforcementSurfaces().connectorFeedback`，
  //   本行报的是"我到底挂上了没有"——两者都要能答，且要**分得开**。
  if (typeof listener !== 'function') {
    throw feedbackError(CONNECTOR_FEEDBACK_CODES.NO_LISTENER,
      `${CONNECTOR_FEEDBACK_PLUGIN_NAME} 需要一个 listener（createOutcomeListener 的返回值），` +
      `收到 ${listener === null ? 'null' : typeof listener}。` +
      '**不兜底**：一个"没有 listener 也能挂上"的行，' +
      '与一个"从来没有被写进补丁层"的行，在组合树上长得一模一样')
  }

  const plugin = {
    name: CONNECTOR_FEEDBACK_PLUGIN_NAME,
    // 与 pre-execute / answerer 两行同理：依赖**声明式**表达，
    // 让 DSH 的挂载审计把 `N row(s) did not activate` 报出来。
    inject: ['tools'],

    apply(ctx) {
      if (typeof ctx.on !== 'function') {
        throw feedbackError(CONNECTOR_FEEDBACK_CODES.NO_EVENT_SEAM,
          `${CONNECTOR_FEEDBACK_PLUGIN_NAME} 需要 ctx.on`)
      }

      // ★ `tools/result` 是 **emit**：没有 `next()`，返回值被忽略。
      //   签名与 `tools/pre-execute` 的水瀑**不同**——写成 `(exec, next)`
      //   会拿到一个 `undefined` 的 next，然后每次结果都试图调它并抛；
      //   而那个异常会被 DSH 兜住（契约承诺"listener failures are contained"），
      //   于是**什么都记不上、也什么都不报**。
      const dispose = ctx.on('tools/result', (exec, result) => {
        // 本行不 try/catch：`createOutcomeListener` 已经承诺永不抛
        // （并用它自己的 ④ 组用例钉住了）。在这里再包一层只会掩盖
        // "那个承诺破了"——而那是必须被看见的事。
        listener(exec, result)
      })

      if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
      else if (typeof ctx.on === 'function') ctx.on('dispose', dispose)

      ctx.logger?.info?.(
        `[${CONNECTOR_FEEDBACK_PLUGIN_NAME}] v${CONNECTOR_FEEDBACK_PLUGIN_VERSION} 已挂上连接器反馈面`
        + '（tools/result 是 emit：只观测、不判定、不改结果）',
      )
    },
  }

  // ★ 诊断用（**不可枚举**）：与另两行同一条理由——让"实际闭包到了什么"
  //   可被断言，而不是让装配方对着自己传的参数断言。
  Object.defineProperty(plugin, 'listener', { value: listener, enumerable: false })
  return plugin
}

/**
 * ⚠️ **本文件没有 `default` 导出**，理由与 `pre-execute.mjs` 完全相同：
 * 本行需要一条带连接器登记表的 listener，而 `PatchOptions.config` 是数据
 * 不是函数——YAML 装不下它。真正的挂载由装配方负责。
 */
export const NO_DEFAULT_EXPORT_REASON = Object.freeze({
  code: 'CONNECTOR_FEEDBACK_NEEDS_RUNTIME_CONFIG',
  detail: '本行需要一条带连接器登记表与解析器的 listener；那些不能由 YAML 携带，'
    + '因此本文件刻意不导出 default。运行期入口应由组合根装配。',
})
