// runtime/adapters/dsh/subagent-client.mjs
// ============================================================================
// DSH 执行面适配：subagent provider 目录的读取面
//   （名单 / 描述符 / 生效权限模式 / 心跳能力快照）+ 外部 Agent 一次性执行的依赖接线。
//
// 为什么存在
//   PRT-108 棘轮的口径是「产品层不得再新增对 DSH 执行面的直接依赖」。6ae2fedd
//   （staged external agent workflows）那条线在 `plugins/src/index.ts` 上新增了
//   5 个 provider 目录读取点——权限模式探测、外部 Agent 的依赖注入、注册校验、
//   名单枚举、能力快照——把该文件的执行面记号从 6 抬到 11，净超基线 5。
//
//   这 5 个点回答的是「运行时 DSH 注册表现在长什么样」，不含产品语义：它们只取值并
//   原样返回，判定与抛错仍留在调用方。因此正确落点是适配层（唯一允许依赖执行面 API
//   的地方），而不是把产品层的基线抬高到 11。
//
// 单一入口
//   整个文件只有 `subagentsOf()` 取一次执行面服务，其余导出都经它读取。于是
//   「本适配器依赖执行面的哪个面」是一眼可数的一件事，而不是散落各处的隐式依赖。
// ============================================================================
import { executeExternalAgent } from './external-agent.mjs'

/**
 * 取 DSH subagents 服务。
 *
 * 缺服务时**抛错**而不是返回 undefined：这些读取点全部处在「已经决定要派工」的
 * 路径上，静默降级会把「provider 不在册」伪装成「能力为空」，把边界问题变成难查的
 * 行为差异。Cordis 的 inject 声明本应保证它存在，这里只是不假装它一定在。
 */
function subagentsOf(ctx) {
  const service = ctx?.subagents
  if (service === null || service === undefined) {
    throw new Error('DSH subagents 服务未注册：无法读取 provider 目录')
  }
  return service
}

/** 已注册 provider 名（保持 DSH 的注册顺序）。非数组返回值按空目录处理。 */
export function listSubagentProviders(ctx) {
  const names = subagentsOf(ctx).list()
  return Array.isArray(names) ? names.map((name) => String(name)) : []
}

/** 单个 provider 描述符；未注册返回 undefined（调用方据此报「不在册」）。 */
export function subagentProvider(ctx, name) {
  return subagentsOf(ctx).getProvider(name)
}

/**
 * provider 在注册时固定的生效权限模式，**原样**返回运行期报告的值。
 *
 * 刻意不做归一化：`未注册 → undefined` 与 `已注册但没声明 → undefined` 是两种不同的
 * 事实，把它们折叠成同一个哨兵值会悄悄改掉调用方的判据（本适配器等价复盘的实测：
 * 归一化成 `null` 时，`undefined !== null` 变成 `null !== null`，原本会抛的那条
 * 就在"期望值恰好为 null"的分支上不再抛了）。取值留在这里，"读到什么才算合规"
 * 留在调用方。
 */
export function subagentProviderPermissionMode(ctx, name) {
  return subagentProvider(ctx, name)?.permissionMode
}

/**
 * provider 心跳上报用的能力快照。
 *
 * `cancellation` 恒为 true：DSH run handle 提供 `dispose()`，中断是宿主尽力保证的
 * （沿用迁移前的取值，本适配器不做行为变更）。
 */
export function subagentProviderCapabilities(ctx, name) {
  const provider = subagentProvider(ctx, name)
  const caps = provider?.capabilities
  return {
    outputSchema: caps?.outputSchema === true,
    toolFilter: caps?.toolFilter === true,
    cancellation: true,
    ...(typeof provider?.permissionMode === 'string' ? { permissionMode: provider.permissionMode } : {}),
    ...(typeof provider?.systemProxyMode === 'string' ? { systemProxyMode: provider.systemProxyMode } : {}),
  }
}

/**
 * 用同一个宿主上下文执行一次外部 Agent。
 *
 * 调用方不再自己拼 `{ subagents }`——那一步正是上一轮把执行面依赖漏回产品层的地方。
 * `subagents` 放在展开之后，避免 `options` 里的同名字段把它覆盖掉。
 */
export async function executeExternalAgentInContext(ctx, options = {}) {
  return executeExternalAgent({ ...options, subagents: subagentsOf(ctx) })
}
