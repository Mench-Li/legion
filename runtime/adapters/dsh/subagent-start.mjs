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

  // ── provider 不在册 ⇒ 具名报错（BUG-050-b）──────────────────────────────
  //
  // 现场（2026-11-20 本机）：DSH 的子 Agent 注册表在一次启动后读成空，
  // 而守护照常按 `config.provider`（`spawn`）派工 —— DSH 内部于是抛
  //
  //     TypeError: Cannot read properties of undefined (reading 'id')
  //
  // 这句话既不指名 provider，也不说"本机现在有哪些"，更看不出根因是"注册表空了"。
  // 任务被连试三次后置 blocked，而全链路唯一的线索就是这句 TypeError。
  //
  //   > 一个"provider 不在册"的失败，
  //   > 与一个"provider 内部崩溃"的失败，在 TypeError 面前是同一句话——
  //   > 而它们的修法完全不同。
  //
  // 所以在真正调用之前先查一次注册表（只在运行期确实支持查询时才查，
  // 不替旧版服务编造能力）。
  if (runtime !== null && typeof runtime === 'object' && typeof runtime.getProvider === 'function') {
    let registered
    try { registered = runtime.getProvider(provider) } catch { registered = undefined }
    if (registered === undefined || registered === null) {
      let available = []
      try { available = typeof runtime.list === 'function' ? (runtime.list() ?? []) : [] } catch { available = [] }
      const names = Array.isArray(available) ? available.map((name) => String(name)) : []
      throw Object.assign(
        new Error(`SUBAGENT_PROVIDER_UNREGISTERED: ${provider}`
          + `（本机 ctx.subagents 已注册：${names.length === 0 ? '（空 —— 一个 provider 都没有：执行面服务在，但注册表是空的）' : names.join('、')}）`),
        { code: 'SUBAGENT_PROVIDER_UNREGISTERED' },
      )
    }
  }

  if (api === 'startActivation') {
    // ── 第二/第三代的**参数形状**不同（BUG-050-c，2026-11-20 实测）─────────
    //
    // 这个兼容层原本只认一种形状：`{ provider, label, request: { prompt, parent, … }, signal, delivery }`
    // ——那是 0.2.1-rc 那代的 `startActivation(spec)`，prompt/parent 包在 `request` 里。
    //
    // 而**装在这台机器上的这一代**（`ctx.subagents` 同时提供 `registerProvider` /
    // `rootOf` / `namesOf` / `sendMessage` / `drainDescendants`）的 spec 是**扁平的**：
    // `{ provider, label, prompt, parent, signal, delivery, … }`。
    //
    // 于是"方法存在、参数形状不同"又踩了一次（与文件头那次一模一样的形状）：
    // 把 `{request:{prompt,parent}}` 交给扁平那代的实现 ⇒ 它读 `spec.parent.id` ⇒
    //   TypeError: Cannot read properties of undefined (reading 'id')
    // 而 `派工失败` 的评论里只有这句 TypeError（这就是 050-b 那条现场）。
    //
    //   > 一个"方法签名对了、参数形状没对上"的调用，
    //   > 与一个"方法不存在"的调用，在 `is not a function` 面前是两件事，
    //   > 在 `reading 'id'` 面前是同一件事。
    //
    // 判据用**这一代独有**的方法（`registerProvider`）：它不参与启动，只在"注册表是
    // 全局枚举"的那一代里存在。旧 rc 代没有它，仍走嵌套形状。
    const flatSpec = typeof runtime.registerProvider === 'function' || typeof runtime.namesOf === 'function'
    const activation = await runtime.startActivation(flatSpec
      // 第三代：prompt / parent 与 provider / label 同级。
      ? { provider, label, prompt, parent, signal, delivery: options.delivery ?? 'caller', ...rest }
      // 第二代（0.2.1-rc）：request 是 `Omit<SubagentStartRequest, 'label' | 'signal'>`。
      : { provider, label, request: { prompt, parent, ...rest }, signal, delivery: options.delivery ?? 'caller' })
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
