// runtime/adapters/dsh/subagent-start.mjs
// ============================================================================
// DSH 执行面适配：**子 Agent 启动**的两代 API 兼容层
//
// 为什么在这一层
//   `ctx.subagents` 是 DSH 执行面服务，按 PRT-108 棘轮，唯一允许直接碰它的地方是
//   `runtime/adapters/dsh/`（见 `scripts/ci/dsh-boundary.mjs` 的 ADAPTER_PREFIXES）。
//   `plugins/src/` 是产品层：它只该 `import { startChildAgent }`，不出现执行面记号。
//
// 为什么需要兼容层（真实故障，2026-10-20）
//   和 Agent 对话报 `TypeError: ctx.subagents.start is not a function`。
//   根因不是调用写错，而是**编译期类型与运行期服务不是同一代**：
//
//     · `plugins/node_modules/@deepseek-ai/dsh-subagent` 曾经是 0.2.1-alpha.1，
//       服务上只有 `start(name, request)` —— 所以 `tsc` 一路绿灯；
//     · 而真正被宿主加载的是 0.2.1-rc.2，服务上只有
//       `startActivation({ provider, label, request, signal, delivery })`。
//
//   > 一个"编译期通过、运行期缺少方法"的调用，
//   > 在类型检查里与一个正确的调用逐字相同 ——
//   > 区别只在真的去调它的那一次。
//
//   这类差异必须**收在一处**：收在一处，下次换代只改这一个文件；
//   散在四处调用点，就是四处都要记得改，而"记得"不是一种机制。
//
// 两代的形状差异（实测）
//   旧：`start(provider, { label, prompt, parent, signal, … })` → `{ id, localAgent, result, dispose }`
//   新：`startActivation({ provider, label, request: { prompt, parent, … }, signal, delivery })`
//        → `{ childId, messageId?, result, dispose }`
//   本层把它们归一成 `{ id, result, dispose, localAgent }`。
// ============================================================================

/** 该运行期对象支持哪一代 API（按"有没有那个方法"判定，不看类型）。 */
export function subagentStartApi(runtime) {
  if (runtime === null || typeof runtime !== 'object') return 'none'
  if (typeof runtime.startActivation === 'function') return 'startActivation'
  if (typeof runtime.start === 'function') return 'start'
  return 'none'
}

/** 列出该对象上的可调用成员名（错误信息用：让下一个看到"有什么"，而不只是"缺什么"）。 */
export function callableMembers(runtime) {
  if (runtime === null || typeof runtime !== 'object') return []
  return Object.keys(runtime)
    .filter((key) => typeof runtime[key] === 'function')
    .sort()
}

/**
 * 把某个对象上的 `dispose` 归一成"一定能 await、一定不抛"（保留原方法的 this 绑定）。
 * 清理失败不许盖住"子 Agent 已经跑完"这个事实。
 */
function normalizeDispose(owner) {
  return async () => {
    const dispose = owner?.dispose
    if (typeof dispose !== 'function') return
    try {
      await dispose.call(owner)
    } catch {
      // 与 DSH 自己 `dispose().catch(() => undefined)` 同义：清理是尽力而为。
    }
  }
}

/**
 * 启动一个子 Agent，返回归一化句柄。
 *
 * @param runtime `ctx.subagents`（或任何形状相同的对象）
 * @param provider 供应商名（DSH 里 spawn provider 默认注册为 `spawn`）
 * @param request 提示与选项（`label` / `prompt` / `parent` 必填，其余原样透传）
 * @param options `delivery`：`'caller'`（默认；结果交调用方 await）或 `'parent'`（额外发父通知）
 * @returns `{ id, result, dispose, localAgent }`
 */
export async function startChildAgent(runtime, provider, request, options = {}) {
  const api = subagentStartApi(runtime)
  const { label, signal, prompt, parent, ...rest } = request

  if (api === 'startActivation') {
    const activation = await runtime.startActivation({
      provider,
      label,
      // 新代的 request 是 `Omit<SubagentStartRequest, 'label' | 'signal'>`：
      // label 与 signal 提到顶层，其余原样带过去。
      request: { prompt, parent, ...rest },
      signal,
      delivery: options.delivery ?? 'caller',
    })
    // 公开投影是 `{ childId, messageId?, result, dispose }`，没有 localAgent。
    // 万一将来把本地 Agent 放回 `handle.agent`，这里顺手接住 —— 有就带上，没有就诚实留空。
    const handle = activation?.handle
    return {
      id: typeof activation?.childId === 'string' ? activation.childId : null,
      result: activation?.result,
      dispose: normalizeDispose(activation),
      localAgent: handle?.agent,
    }
  }

  if (api === 'start') {
    const run = await runtime.start(provider, { label, prompt, parent, signal, ...rest })
    return {
      id: typeof run?.id === 'string' ? run.id : null,
      result: run?.result,
      dispose: normalizeDispose(run),
      localAgent: run?.localAgent,
    }
  }

  // 两代都没有：把"没有 start"升级成"这里到底有什么"。
  // 前缀是稳定码，便于错误分类器把它归到"宿主版本不匹配"而不是"未知原因"。
  const members = callableMembers(runtime)
  throw new Error(
    'SUBAGENT_API_UNAVAILABLE: ctx.subagents 既没有 startActivation（0.2.1-rc 及以后）'
    + ' 也没有 start（0.2.1-alpha 及以前）；'
    + `现有可调用成员：${members.length === 0 ? '（一个都没有：服务可能未挂载）' : members.join(', ')}`,
  )
}
