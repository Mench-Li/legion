/**
 * 子代理启动的**兼容层** —— 一处吸收 DSH 服务 API 的两代差异。
 *
 * ## 为什么要这样一层（真实故障）
 *
 * 2026-10-20：和 Agent 对话报 `TypeError: ctx.subagents.start is not a function`。
 * 根因不是我们调用写错，而是**编译期类型与运行期服务不是同一代**：
 *
 *   · `plugins/node_modules/@deepseek-ai/dsh-subagent` 是 **0.2.1-alpha.1**，
 *     它的服务接口只有 `start(name, request)` —— 所以 `tsc` 一路绿灯；
 *   · 而装在这台机器上、真正被宿主加载的是 **0.2.1-rc.2**，
 *     它的服务接口只有 `startActivation({ provider, label, request, signal, delivery })`，
 *     **没有** `start`。
 *
 *   > 一个"编译期通过、运行期缺少方法"的调用，
 *   > 在类型检查里与一个正确的调用逐字相同 ——
 *   > 区别只在真的去调它的那一次。
 *
 * 也就是说：**`tsc` 绿不能证明"这个方法在那个进程里存在"**。
 *
 * ## 这一层的职责
 *
 *   · 优先 `startActivation`（新），退到 `start`（旧）；
 *   · 把两种返回都归一成 `{ id, result, dispose }`（旧 `SubagentRun.id` / 新 `SubagentActivation.childId`）；
 *   · 两代都没有时，抛一条**说清事实**的错误：方法名 + 该对象上实际有哪些可调用成员。
 *     原来那句 `start is not a function` 只说了"没有 start"，没说"那有什么" ——
 *     而这一层最容易再变一次。
 *
 * ## 为什么类型是结构化的（不 import 那个包的类型）
 *
 * 因为**那个包的类型正是错的那一份**。若继续用它的类型，这一层会被编译器"纠正"回
 * `start(...)`，等于把缺陷写回代码里。所以这里只声明我们真正用到的形状。
 */

/** 子 Agent 的一轮提示（与 DSH 的 `SubagentStartRequest` 对齐的那部分）。 */
export interface ChildPromptRequest {
  /** 面向人的短标签（新 API 把它提到 spec 顶层，旧 API 放在 request 里）。 */
  label: string
  prompt: ReadonlyArray<{ type: 'text'; text: string }>
  parent: unknown
  signal?: AbortSignal
  outputSchema?: unknown
  agentOptions?: unknown
  cwd?: string
  agentPreset?: string
  maxDepth?: number
  /** Legion 自己的扩展键（`runtime/contracts` 里两侧同时定义）；两代 API 都不认，透传即可。 */
  toolFilter?: unknown
}

/**
 * 子 Agent 的结算结果。
 *
 * 只声明**我们真正读的那几个字段**（两代 `SubagentResult` 都有）：
 *   · `stopReason` —— 一定要读（决定成功/失败）；
 *   · `structured` —— 带 `outputSchema` 请求时的结构化结果；
 *   · `output`     —— 最后一条非空助手消息，聊天回复从这里取文本；
 *   · `diagnostic` —— provider 给的失败说明。
 */
export interface ChildResult {
  output?: ReadonlyArray<{ type?: string; text?: string }>
  structured?: unknown
  diagnostic?: string
  stopReason: string
}

/** 归一化之后的子 Agent 句柄。 */
export interface ChildRun {
  /** 子 Agent 的会话 id（旧：`run.id`；新：`activation.childId`）。没有就是 null。 */
  id: string | null
  result: Promise<ChildResult>
  dispose: () => Promise<void>
  /**
   * 进程内子 Agent（旧 API 的 `SubagentRun.localAgent`）。
   *
   * ★ 新 API（`startActivation`）**不对外暴露它**：公开投影只有
   *   `{ childId, messageId, result, dispose }`。所以走新 API 时这里通常是 `undefined`，
   *   调用方那句"集成模式要求本地 Agent 执行拦截"会**照常拒绝**——
   *   那是正确的：它宁可拒绝，也不静默地在没有写保护的情况下跑。
   */
  localAgent?: unknown
}

/**
 * 结果投递方式（新 API 的 `delivery`）：
 *   · `'caller'` —— 结果交给调用方（**我们自己 await**，不要父 Agent 的完成通知）；
 *   · `'parent'` —— 额外给父 Agent 发一条面向模型的完成通知。
 * 本仓四处调用都是"自己等结构化结果"，所以默认 `'caller'`。
 */
export type ChildDelivery = 'caller' | 'parent'

export interface StartChildOptions {
  delivery?: ChildDelivery
}

/** 该运行期对象支持哪一代 API（按"有没有那个方法"判定，不看类型）。 */
export function subagentStartApi(runtime: unknown): 'startActivation' | 'start' | 'none' {
  if (runtime === null || typeof runtime !== 'object') return 'none'
  const anyRuntime = runtime as Record<string, unknown>
  if (typeof anyRuntime.startActivation === 'function') return 'startActivation'
  if (typeof anyRuntime.start === 'function') return 'start'
  return 'none'
}

/** 列出该对象上的可调用成员名（错误信息用：让下一个人一眼看到"有什么"）。 */
export function callableMembers(runtime: unknown): string[] {
  if (runtime === null || typeof runtime !== 'object') return []
  return Object.keys(runtime as Record<string, unknown>)
    .filter((key) => typeof (runtime as Record<string, unknown>)[key] === 'function')
    .sort()
}

/** 把某个对象上的 `dispose` 归一成"一定能 await、一定不抛"（保留原方法的 this 绑定）。 */
function normalizeDispose(owner: unknown): () => Promise<void> {
  return async () => {
    const fn = (owner as { dispose?: unknown } | null | undefined)?.dispose
    if (typeof fn !== 'function') return
    try {
      await (fn as () => unknown).call(owner)
    } catch {
      // 清理失败不该盖住"子 Agent 已经跑完"这个事实（与 DSH 自己 `dispose().catch()` 同义）。
    }
  }
}

/**
 * 启动一个子 Agent，返回归一化句柄。
 *
 * @param runtime `ctx.subagents`（或任何形状相同的对象）
 * @param provider 供应商名（DSH 里默认注册为 `spawn`）
 * @param request 提示与选项
 * @param options `delivery`（默认 `'caller'`：结果给调用方）
 */export async function startChildAgent(
  runtime: unknown,
  provider: string,
  request: ChildPromptRequest,
  options: StartChildOptions = {},
): Promise<ChildRun> {
  const api = subagentStartApi(runtime)
  const anyRuntime = runtime as Record<string, unknown>
  const { label, signal, prompt, parent, ...rest } = request

  if (api === 'startActivation') {
    const activation = await (anyRuntime.startActivation as (spec: unknown) => Promise<Record<string, unknown>>)({
      provider,
      label,
      // 新 API 的 request 是 `Omit<SubagentStartRequest, 'label' | 'signal'>` ——
      // label 与 signal 提到顶层，其余原样带过去（含 Legion 的 toolFilter 扩展）。
      request: { prompt, parent, ...rest },
      signal,
      delivery: options.delivery ?? 'caller',
    })
    // 公开投影没有 localAgent；但万一将来把本地 Agent 放回 `handle.agent`，
    // 这里顺手接住 —— 有就带上，没有就是 undefined（诚实反映能力）。
    const handle = (activation as { handle?: { agent?: unknown } } | null)?.handle
    return {
      id: typeof activation?.childId === 'string' ? activation.childId : null,
      result: activation?.result as Promise<ChildResult>,
      dispose: normalizeDispose(activation),
      localAgent: handle?.agent,
    }
  }

  if (api === 'start') {
    const run = await (anyRuntime.start as (name: string, req: unknown) => Promise<Record<string, unknown>>)(provider, {
      label,
      prompt,
      parent,
      signal,
      ...rest,
    })
    return {
      id: typeof run?.id === 'string' ? run.id : null,
      result: run?.result as Promise<ChildResult>,
      dispose: normalizeDispose(run),
      localAgent: run?.localAgent,
    }
  }

  // 两代都没有：把"没有 start"升级成"这里到底有什么"。
  // 前缀是稳定码，便于分类器把它归到"宿主版本不匹配"而不是"未知原因"。
  const members = callableMembers(runtime)
  throw new Error(
    'SUBAGENT_API_UNAVAILABLE: ctx.subagents 既没有 startActivation（0.2.1-rc 及以后）'
    + ' 也没有 start（0.2.1-alpha 及以前）；'
    + `现有可调用成员：${members.length === 0 ? '（一个都没有：服务可能未挂载）' : members.join(', ')}`,
  )
}
