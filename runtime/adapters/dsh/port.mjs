// runtime/adapters/dsh/port.mjs
// ============================================================================
// DSH 宿主端口（PRT-201/202）
//
// ## 为什么适配器不 import 引擎包
//
// `scripts/ci/dsh-boundary-baseline.json` 已经把 `runtime/adapters/dsh/` 列为
// 允许的适配器位置——也就是说适配器**有权**直接 import DSH 包。本实现**故意不用**这个权利。
//
// 理由：一旦 import，适配器就只能在装了 DSH 的环境里被测试或加载。
// 而阶段 1 最重要的成果恰恰是「不启动 DSH 即可测完整编排」
// （`runtime/contracts/fake-adapter.test.mjs`）。若适配器只能在 DSH 在场时加载，
// 那这条能力在最需要它的地方——适配器自己的测试——就失效了：
// 我们会失去对「DSH 挂死/abort 无效/返回畸形结果」这些**真实故障**的覆盖能力，
// 因为这些故障无法用真 DSH 稳定复现。
//
// 所以耦合方式改为**注入端口**：适配器只认识下面这几个方法，
// 由 `runtime/dsh-composition/`（PRT-214）负责把引擎的 subagents 与
// 默认模型服务接到端口上。端口是窄的、可假的、可脚本化的。
//
// 副作用（正面）：`runtime/adapters/dsh/` 的 DSH token 数保持为 0，
// 棘轮里那条 `adapterPrefixes` 豁免实际未被消耗——**豁免存在但不用**，
// 比「用了豁免然后讨论是否合理」更安全。
//
// ## 端口契约（唯一与 DSH 形状相关的约定）
//
//   currentModelSelection(): { provider, model, endpoint?, reasoningEffort?, limits? }
//   startRun(provider, options): { result: Promise<RunOutcomeLike>, dispose(): Promise<void>,
//                                  events?: AsyncIterable<{ type, ... }> }
//   probeRuntime(): { version, capabilities }
//
// `startRun` 的选项形状照抄既有生产调用（plugins/src/index.ts:1255）：
//   { label, prompt: [{type:'text',text}], parent, signal, outputSchema }
//
// ## `result` 可能永不结算
//
// plugins/src/index.ts:2241 现场注释原文：「subagent 可能挂死且 run.result 永不结算
// （abort 不保证杀死子代理）」。这不是理论风险，是已发生的生产故障。
// 因此端口约定：`result` 是**可能不结算**的 promise，适配器必须自带看门狗
// （见 index.mjs 的 WATCHDOG_GRACE_MS 与 execute 实现）。
// ============================================================================

/** 端口必须提供的方法。缺一个就是接线错误，不是「能力缺失」。 */
export const REQUIRED_PORT_METHODS = Object.freeze(['startRun', 'probeRuntime'])

/** 端口可选提供的方法。缺失时适配器降级，不报错。 */
export const OPTIONAL_PORT_METHODS = Object.freeze(['currentModelSelection', 'subscribeRun', 'listModels'])

export class DshPortError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DshPortError'
  }
}

/**
 * 校验注入的宿主端口。
 *
 * **fail closed**：端口形状不对时必须立刻失败并说明缺什么，
 * 而不是等到第一次 execute 时才在深处抛 `undefined is not a function`。
 * 后者会让「接线错误」看起来像「运行时崩溃」，误导排障方向。
 */
export function assertHostPort(host) {
  const errors = []
  if (host === null || typeof host !== 'object') {
    return { ok: false, errors: ['宿主端口必须是对象'] }
  }
  for (const m of REQUIRED_PORT_METHODS) {
    if (typeof host[m] !== 'function') errors.push(`宿主端口缺少必需方法：${m}`)
  }
  if (host.currentModelSelection !== undefined && typeof host.currentModelSelection !== 'function') {
    errors.push('currentModelSelection 存在但不是函数')
  }
  if (host.subscribeRun !== undefined && typeof host.subscribeRun !== 'function') {
    errors.push('subscribeRun 存在但不是函数')
  }
  return { ok: errors.length === 0, errors }
}

/**
 * 归一化 `startRun` 的返回值。
 *
 * 只做**形状**校验，不碰语义：`result` 必须是 thenable，`dispose` 必须是函数。
 * 缺 `dispose` 时**不**报错——但那意味着我们会泄漏子代理，所以记进 `warnings`
 * 由调用方决定（生产上 dispose 是可选的清理，缺了要能看见）。
 */
export function normalizeRunHandle(raw) {
  const warnings = []
  if (raw === null || typeof raw !== 'object') {
    throw new DshPortError(`startRun 未返回句柄（收到 ${raw === null ? 'null' : typeof raw}）`)
  }
  if (typeof raw.result?.then !== 'function') {
    throw new DshPortError('startRun 句柄缺少可等待的 result')
  }
  let dispose = null
  if (typeof raw.dispose === 'function') {
    dispose = raw.dispose.bind(raw)
  } else {
    warnings.push('startRun 句柄缺少 dispose：子代理可能无法回收')
  }
  return {
    result: raw.result,
    dispose,
    events: raw.events ?? null,
    warnings,
  }
}

/**
 * 安全 dispose（清理失败绝不能盖掉真正的执行结果）。
 *
 * 生产调用点写的是 `await run.dispose().catch(() => undefined)`
 * （plugins/src/index.ts:1265）——同一个意图：dispose 的异常只记录，不上抛。
 */
export async function safeDispose(handle, onWarning) {
  if (handle?.dispose === null || handle?.dispose === undefined) return false
  try {
    await handle.dispose()
    return true
  } catch (err) {
    if (typeof onWarning === 'function') onWarning(`dispose 失败：${err?.message ?? String(err)}`)
    return false
  }
}
