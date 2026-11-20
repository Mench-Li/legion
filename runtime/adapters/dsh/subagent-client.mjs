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
  const service = subagentsOf(ctx)
  // ★ 2026-11-20（BUG-050-c）：这一代 `ctx.subagents` **没有 `list()`** —— provider
  //   目录不再是"全局可枚举表"（`registerProvider`/`getProvider` 还在，但列不出来；
  //   会话目录改按 Agent 树走：`listDescendants`/`namesOf`）。
  //   从前这里直接 `.list()` ⇒ TypeError ⇒ 被上游的 try/catch 吞掉 ⇒ `providers: []`
  //   ⇒ "形状变了"与"真的一个都没有"在读数上**长得一模一样**（与 BUG-017 同形）。
  //   所以这里显式区分：**列不出来就是列不出来**，返回空数组，另由
  //   `subagentProviderCatalogMode` 把这个事实说出来。
  if (typeof service.list !== 'function') return []
  const names = service.list()
  return Array.isArray(names) ? names.map((name) => String(name)) : []
}

/**
 * 本机的 provider 目录**能不能枚举**：`'list'`（全局表可枚举）或 `'unavailable'`
 * （这一代按 Agent 树组织，没有全局列表）。
 *
 * 为什么需要它：节点心跳把"观测到的 provider"报给中枢，而中枢的就绪判据是
 * 声明 ⊆ 观测。**列不出来**时上报空数组，等于宣称"我一个 provider 都没有" ——
 * 那会把一条"读不到"的读数固化成一条"没有"的结论（正是 BUG-050-a 的现场）。
 * 至少要让日志能区分这两件事。
 */
export function subagentProviderCatalogMode(ctx) {
  const service = subagentsOf(ctx)
  return typeof service.list === 'function' ? 'list' : 'unavailable'
}

/**
 * **观测到的** provider 名（BUG-050-d）：能枚举就枚举，不能枚举就**逐个问** `getProvider`。
 *
 * ## 为什么不能只接受"枚举不到 ⇒ 空数组"
 *
 * 这一代 `ctx.subagents` 没有 `list()`（目录按 Agent 树走），于是
 * "读不到"被上报成 `providers: []`，中枢据此判断"声明 ⊆ 观测"必然失败 ⇒
 * 节点永久 `incompatible`（050-a 那条现场的另一半）。而**注册表其实是好的**：
 * `getProvider('spawn')` 拿得到，`providers_json` 的就绪度也报 `spawn: ready`。
 *
 *   > 一个"列不出来"的目录，
 *   > 与一个"空目录"，在 `[]` 这个读数上是同一个东西 ——
 *   > 区别只在有人照着它做判定的那一次。
 *
 * 所以：能枚举就枚举（快、全）；不能枚举就对**候选名单**逐个问，只认问到的。
 * 候选由调用方给（本机已知的 provider 规格 + 自己配置里要用的那个）。
 *
 * @param extraNames 候选名（去重、去空白；问不到的一律不报）
 */
export function observedSubagentProviders(ctx, extraNames = []) {
  const service = subagentsOf(ctx)
  if (typeof service.list === 'function') {
    const names = service.list()
    return Array.isArray(names) ? names.map((name) => String(name)) : []
  }
  if (typeof service.getProvider !== 'function') return []
  const out = []
  for (const raw of extraNames ?? []) {
    const name = typeof raw === 'string' ? raw.trim() : ''
    if (name === '' || out.includes(name)) continue
    let found
    try { found = service.getProvider(name) } catch { found = undefined }
    if (found !== undefined && found !== null) out.push(name)
  }
  return out
}

/** 单个 provider 描述符；未注册返回 undefined（调用方据此报「不在册」）。 */
export function subagentProvider(ctx, name) {
  return subagentsOf(ctx).getProvider(name)
}

/** DSH providers expose effective settings either directly or in their config. */
function permissionModeOf(provider) {
  return provider?.permissionMode ?? provider?.config?.permissionMode
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
  return permissionModeOf(subagentProvider(ctx, name))
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
  const permissionMode = permissionModeOf(provider)
  return {
    outputSchema: caps?.outputSchema === true,
    toolFilter: caps?.toolFilter === true,
    cancellation: true,
    ...(typeof permissionMode === 'string' ? { permissionMode } : {}),
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
