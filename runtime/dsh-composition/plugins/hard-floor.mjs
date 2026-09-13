// runtime/dsh-composition/plugins/hard-floor.mjs
// ============================================================================
// PRT-214：`legion-enforcement-hard-floor` 的**插件模块本体**。
//
// 在此之前，`legion-host.patch.yml` 里那一行只有 `module: null`——
// 声明说"这里该插一行静态下限"，而没有任何东西可插。
// 本文件就是那一行要加载的东西。
//
// ## 它挂在哪
//
// DSH 的 `ToolRuntime.guard()`，原文（`packages/core/tools/src/index.ts:1090`）：
//
//     Register a **monotonic** guard after the extensible `tools/pre-execute`
//     waterfall. … Any matching guard may deny by returning a reason,
//     while **no guard can force-allow a call another guard denied**.
//
// 这条契约与 spec §6.8 对下限的要求逐字对应，也是 `patch-layer.mjs` 早就写下的
// 那句「guard 只有降级语义、没有 allow 语义」的**实现依据**：
//
//   · **同步**：`guard` 是同步检查，不能 await。把它变成异步会让「最终」这个
//     语义消失——后面的 listener 又能翻案了。
//   · **只降级**：返回 `string`（拒绝理由）或 `undefined`（不动）。
//     永远没有「允许」这个返回值，因此顺序无关。
//   · **不受审批影响**：下限不看批准。能被批准的就不叫下限。
//
// 判定逻辑**不在这里**——它就是 `enforcement.mjs` 的 `createHardFloorGuard`，
// 与 `composePreExecuteFloor` 用的是**同一个**调用结果。本文件只做绑定。
//
//   > 两份"同一个下限"的实现，
//   > 与一个"下限会在 pre-execute 与 guard 之间漂移"的实现，是同一个东西——
//   > 而漂移的那一天只表现为"这次怎么被拒了"。
//
// ## 为什么是薄绑定而不是把逻辑搬过来
//
// `createHardFloorGuard` 有它自己的用例（路径规范化、无 cwd 时拒绝、工具名 nfc）。
// 把逻辑复制进插件，会让那批用例守着一份**不再被执行**的副本——
// 而插件里那份没有任何东西守着。
// ============================================================================

import { DEFAULT_HARD_FLOOR, createHardFloorGuard } from '../enforcement.mjs'

/** 改动绑定方式/默认值来源时递增。 */
export const HARD_FLOOR_PLUGIN_VERSION = 1

/** 本插件对外可见的失败码（构造期抛，不是运行期）。 */
export const HARD_FLOOR_CODES = Object.freeze({
  /** `guard` 端口不存在——运行时没有挂 ToolRuntime，或挂载顺序不对。 */
  NO_GUARD_SEAM: 'HARD_FLOOR_NO_GUARD_SEAM',
  /** 配置里的 floor 不是普通对象。 */
  BAD_FLOOR: 'HARD_FLOOR_BAD_FLOOR',
})

export const HARD_FLOOR_PLUGIN_NAME = 'legion-enforcement-hard-floor'

function hardFloorError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/**
 * 造出这个 Cordis 插件。
 *
 * @param {object} [options]
 * @param {object} [options.floor] 静态下限。默认 `DEFAULT_HARD_FLOOR`。
 * @param {(e: {phase: string, toolName: string, reason: string|null}) => void} [options.onGuard]
 *   每次 guard 被调用时的观测点。**只观测，不参与判定**——
 *   一个能改变判定的观测点等于把判定搬到了两个地方。
 * @returns Cordis 插件对象（default export 就是 `createHardFloorPlugin()` 的结果）。
 */
export function createHardFloorPlugin({ floor = DEFAULT_HARD_FLOOR, onGuard = null } = {}) {
  if (floor === null || typeof floor !== 'object' || Array.isArray(floor)) {
    throw hardFloorError(HARD_FLOOR_CODES.BAD_FLOOR,
      `hard floor 需要普通对象作为上下限配置，收到 ${floor === null ? 'null' : Array.isArray(floor) ? 'array' : typeof floor}`)
  }

  return {
    name: HARD_FLOOR_PLUGIN_NAME,

    // ★ 必须声明 `inject: ['tools']`。
    //
    // 我第一版**没有**声明它，理由是"想在 apply 里自己检查端口在不在，
    // 免得进 waiting"——那是个错误的判断，而且错得很典型：**Cordis 根本不允许**
    // 不声明就按属性访问服务，当场抛
    //
    //     cannot get property "tools" without inject
    //
    // 于是那一版在真运行时下**一行都挂不上**。我当时的理由（"多一层等待就多一种
    // 挂载了却没激活"）本身是对的，但结论反了：正因为 waiting 与成功挂载在
    // 组合树上长得像，才更应该**声明式**地表达依赖，让 DSH 的挂载审计
    // 把 `N row(s) did not activate` 报出来——那是 `reconcilePatchLayer()`
    // 的 `ROW_NOT_ACTIVATED` 判据在读的东西。
    //
    //   > 一个"自己偷偷检查端口、于是永远不进 waiting"的插件，
    //   > 与一个"正确声明了依赖、等待被如实记录"的插件，在坏接线时是同一个东西——
    //   > 只不过前者的失败发生在运行时，而没有任何审计会报它。
    inject: ['tools'],
    apply(ctx, config) {
      const effectiveFloor = config?.floor ?? floor

      // 端口必须在**形状上**也对。
      //
      // `inject: ['tools']` 保证的是"存在一个叫 tools 的服务"，不是"它长得像
      // ToolRuntime"。名字对而形状不对（另一个部署提供了同名的别的东西）时，
      // 什么也不拦——而不拦的下限比不存在的下限更危险，因为组合树里看得见它。
      if (ctx.tools === undefined || typeof ctx.tools.guard !== 'function') {
        throw hardFloorError(HARD_FLOOR_CODES.NO_GUARD_SEAM,
          `${HARD_FLOOR_PLUGIN_NAME} 需要 ctx.tools.guard；` +
          `服务存在但 guard 不是函数（${typeof ctx.tools?.guard}）。**不静默降级**：` +
          '一个什么都不拦的下限比没有下限更危险，因为组合树里看得见它')
      }

      const guard = createHardFloorGuard(effectiveFloor)

      const wrapped = onGuard === null ? guard : (execution) => {
        const reason = guard(execution)
        onGuard({
          toolName: typeof execution?.name === 'string' ? execution.name : null,
          reason: typeof reason === 'string' ? reason : null,
        })
        return reason
      }

      // `guard()` 返回它自己的 disposer，但它挂的是 **ToolRuntime 的** fiber
      // （实现里是 `this.layers.effect(this.ctx, …)`）。
      // 于是**本插件**卸载时它不会自动消失——必须由我们把那个 disposer
      // 交给本行自己的 effect 作用域。
      //
      //   > 一个"卸载了插件而 guard 还在拦"的实现，
      //   > 与一个"disable 掉这一行却没有任何效果"的实现，是同一个东西。
      const dispose = ctx.tools.guard(wrapped)
      if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
      else if (typeof dispose === 'function') ctx.on('dispose', dispose)

      ctx.logger?.info?.(
        `[${HARD_FLOOR_PLUGIN_NAME}] v${HARD_FLOOR_PLUGIN_VERSION} 已挂上静态下限：` +
        `${(effectiveFloor.denyTools ?? []).length} 个禁止工具、` +
        `${(effectiveFloor.denyPathPrefixes ?? []).length} 个禁止路径前缀`,
      )
    },
  }
}

/** 补丁层那一行加载的就是它。 */
export default createHardFloorPlugin()
