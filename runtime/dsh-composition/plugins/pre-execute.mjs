// runtime/dsh-composition/plugins/pre-execute.mjs
// ============================================================================
// PRT-214：`legion-enforcement-pre-execute` 的**插件模块本体**。
//
// ## 它挂在哪
//
// `ctx.on('tools/pre-execute')` —— DSH 的**瀑布**，签名
// （`packages/core/tools/src/index.ts:144`）：
//
//     'tools/pre-execute'(exec, next): Promise<PreToolDecision>
//     PreToolDecision = { kind:'allow' } | { kind:'deny', reason } | { kind:'ask', reason? }
//
// 判定逻辑**不在这里**：它就是 `tool-request.mjs` 的
// `createEnforcementBridge({...}).preExecute`——投影、路径范围、岗位白名单、
// 策略端口、禁止改写参数，全都在那一处，而且那条桥已有一整套用例。
// 本文件只做三件事：绑定、**认领策略**、以及把投影放进在飞登记簿。
//
// ## ★★ 认领策略：`allow` **要让路**，不能认领
//
// 瀑布的语义是"谁先返回非 `next()`，谁就认领这次调用"。
// 于是 `allow` 有两种写法，行为完全不同：
//
//     return { kind: 'allow' }   // 认领并放行 —— 后面的 listener 再也说不出话
//     return next()              // 不认领 —— 后面的 listener 照样可以拒绝
//
// 本行取**后者**。
//
//   > 一个"自己就把 allow 定案了"的强制面，
//   > 与一个"把后面的门全部关掉"的强制面，是同一个东西——
//   > 只不过前者把自己说成是"放行"，而它实际干的是"闭嘴"。
//
// 这与 hard floor 那条"guard 只有降级语义、没有 allow 语义"是同一条原则的
// 另一面：**强制面永远不该成为某个东西被允许的原因**。
//
// 而 `deny` / `ask` 必须认领——那是我们真的有话要说。
//
// ## ★ 为什么 ask 时要把投影放进登记簿
//
// DSH 把 `ask` 交给审批服务时只递五个字段（`tools/src/index.ts:1696`），
// **没有 arguments**。而 team-hub 的权限检查要靠参数算绑定哈希。
// 所以本行（唯一拿得到完整 `exec` 的角色）必须把投影留下，
// 由 `plugins/approval-answerer.mjs` 按 `callId` 取回。
//
//   > 一个"没有参数也算得出主体"的审批，
//   > 与一个"人批了却在执行时不匹配"的审批，在审计里是同一个东西——
//   > 只不过前者会让每一次批准都白批。
// ============================================================================

import { IN_FLIGHT } from '../inflight.mjs'

export const PRE_EXECUTE_PLUGIN_VERSION = 1

export const PRE_EXECUTE_PLUGIN_NAME = 'legion-enforcement-pre-execute'

/** 构造期的失败码。 */
export const PRE_EXECUTE_CODES = Object.freeze({
  /** 没给 bridge，或者给的 bridge 上没有 `preExecute`。 */
  NO_BRIDGE: 'PRE_EXECUTE_NO_BRIDGE',
  /** `tools/pre-execute` 事件端口不存在。 */
  NO_EVENT_SEAM: 'PRE_EXECUTE_NO_EVENT_SEAM',
})

function preExecuteError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/**
 * 造出这个 Cordis 插件。
 *
 * @param {object} options
 * @param {object} options.bridge **必需**：`createEnforcementBridge()` 的返回值。
 *   本插件不自己造桥——桥需要 Legion 身份（scope/actor/action）、策略端口、
 *   岗位白名单，那些都是**运行时**配置。造桥是装配方的责任（见 `assemble.mjs`）。
 * @param {object} [options.registry] 在飞登记簿；默认进程级那一份
 *   （必须与 answerer 那一行用的是**同一份**，否则两个缝合点对不上账）。
 * @param {(e: object) => void} [options.onDecision] 观测点，**不参与判定**。
 * @returns Cordis 插件对象
 */
export function createPreExecutePlugin({ bridge, registry = IN_FLIGHT, onDecision = null } = {}) {
  if (bridge === null || typeof bridge !== 'object' || typeof bridge.preExecute !== 'function') {
    throw preExecuteError(PRE_EXECUTE_CODES.NO_BRIDGE,
      `${PRE_EXECUTE_PLUGIN_NAME} 需要 createEnforcementBridge() 的返回值。` +
      '**不兜底**：一个"没有桥也能挂上"的 listener 只能靠放行或靠编判定，而两者都是静默降级')
  }
  if (registry === null || typeof registry?.put !== 'function') {
    throw preExecuteError(PRE_EXECUTE_CODES.NO_BRIDGE,
      `${PRE_EXECUTE_PLUGIN_NAME} 的 registry 需要 put(callId, projection)`)
  }

  const plugin = {
    name: PRE_EXECUTE_PLUGIN_NAME,
    // 声明依赖：`ctx.on` 是 Context 自己带的，但 `tools` 服务必须已经在场，
    // 否则我们这个 listener 挂在一个没有派发点的瀑布上。
    // 与另两行同理——**等待要被 DSH 的挂载审计记录**。
    inject: ['tools'],

    apply(ctx, config) {
      if (typeof ctx.on !== 'function') {
        throw preExecuteError(PRE_EXECUTE_CODES.NO_EVENT_SEAM,
          `${PRE_EXECUTE_PLUGIN_NAME} 需要 ctx.on`)
      }
      const effectiveBridge = config?.bridge ?? bridge

      const dispose = ctx.on('tools/pre-execute', async (exec, next) => {
        const decision = await effectiveBridge.preExecute(exec)

        // ★ `allow` → **让路**（见文件头）。这不是"什么都不做"：
        //   `next()` 让后面每一道门照常说话，而 `{kind:'allow'}` 会让它们闭嘴。
        if (decision?.kind === 'allow') {
          onDecision?.({ exec, decision, claimed: false })
          return next()
        }

        // `ask`：**必须**留下投影，否则 answerer 那一行算不出绑定哈希。
        //
        // ⚠️ 这段分支在**真桥**下够不着：`createEnforcementBridge` 的 `decide` 包装
        // 在 `projectionFor` 失败时就已经返回 `deny` 了，所以走到这里的 `ask`
        // 必然带着一条投影成功的调用。它是**契约守卫**，不是常规路径——
        // 而它守的是一旦桥的语义变了就会发生的事：
        //
        //   > 一个"ask 却没留下投影"的 pre-execute 行，
        //   > 与一个"审批永远问不到人、于是永远不生效"的强制面，是同一个东西——
        //   > 只不过前者不会报错，它只会**静默地不再拦任何东西**。
        //
        // 用一条**假的、故意违约的桥**直接测它（见 pre-execute.test.mjs）——
        // 那样它才是活代码，而不是一段没人跑过、也没人会发现的兜底。
        if (decision?.kind === 'ask') {
          const got = effectiveBridge.projectionFor(exec)
          if (got.ok) {
            registry.put(exec.callId, got.projection)
          } else {
            onDecision?.({ exec, decision, claimed: true, projectionFailed: got.code, projectionMessage: got.message })
            return {
              kind: 'deny',
              reason: `无法投影这次调用（${got.code}），因此无法形成可核销的审批：${got.message}`,
            }
          }
        }

        onDecision?.({ exec, decision, claimed: true })
        return decision
      })

      if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
      else if (typeof ctx.on === 'function') ctx.on('dispose', dispose)

      ctx.logger?.info?.(
        `[${PRE_EXECUTE_PLUGIN_NAME}] v${PRE_EXECUTE_PLUGIN_VERSION} 已挂上策略门`
        + `（allow 让路 / deny·ask 认领；ask 时把投影写进在飞登记簿）`,
      )
    },
  }

  // ★ 诊断用（**不可枚举**）：本行**实际**闭包到的桥与登记簿。
  //
  // 装配方与用例要断言"两行共用同一本登记簿"，而"共用"是**身份**。
  // 让行自己报出它实际拿到的东西，是为了防住一种很安静的错法：
  // 装配方**记下自己传了什么**、然后对着那份记录断言——
  // 那样即使真的传了两本登记簿进去，用例也照样绿。
  //
  //   > 一个"记录了我传了什么"的诊断，
  //   > 与一个"记录了行实际拿到什么"的诊断，在传错参数时是同一个东西——
  //   > 只不过前者的用例是绿的。
  //
  // 不可枚举：这是**活对象**，不该被 `JSON.stringify` / `Object.keys` /
  // 任何"显示整行"的路径带出去。
  Object.defineProperty(plugin, 'bridge', { value: bridge, enumerable: false })
  Object.defineProperty(plugin, 'registry', { value: registry, enumerable: false })
  return plugin
}

/**
 * ⚠️ **本文件没有 `default` 导出**，理由与 `approval-answerer.mjs` 完全相同：
 *
 * 本行需要一条 `createEnforcementBridge(...)` 造出来的桥，而桥的参数里
 * 有 Legion 身份（`scope` / `actor` / `action`）、策略端口 `decide`、
 * 岗位白名单 `whitelist`、路径范围 `pathScope`。那些都是**函数或运行时数据**，
 * 而 `PatchOptions.config` 是数据不是函数 —— YAML 装不下它们。
 *
 * 因此 `PATCH_LAYER_ROWS` 里这一行仍然是 `module: null`，
 * 真正的挂载由装配方负责（`runtime/dsh-composition/assemble.mjs`）：
 *
 *   > 一个"能在 YAML 里写出来、于是挂上了、但没有桥"的 listener，
 *   > 与一个"从来没有被写进补丁层"的 listener，在组合树上长得一模一样——
 *   > 只不过前者的文件看起来是装好的。
 *
 * PRT-214 组合根补记：**这一行现在有运行期模块了**，只是它在另一个文件里——
 * `./pre-execute-row.mjs`。那个文件的 `default` 导出从组合根（`../root.mjs`）
 * 取那一行；组合根没装好时它在 `apply` 期**抛具名码**，不会挂一个空 listener。
 * 所以本文件仍然刻意不导出 `default`：能导出 `default` 的必须是那个
 * "要么拿到桥、要么响亮失败"的模块，而不是这个"需要参数才能构造"的工厂。
 */
export const NO_DEFAULT_EXPORT_REASON = Object.freeze({
  code: 'PRE_EXECUTE_NEEDS_RUNTIME_CONFIG',
  detail: '本行需要一条带 Legion 身份与策略端口的桥；那些不能由 YAML 携带，'
    + '因此本文件刻意不导出 default。运行期入口在 ./pre-execute-row.mjs（由组合根 root.mjs 装配）',
})
