// runtime/adapters/dsh/subagent-start.d.mts
//
// `subagent-start.mjs` 的类型声明（本仓适配层的既有约定：`X.mjs` + `X.d.mts`，
// 因为 `plugins/src/*.ts` 以 NodeNext 解析 `.mjs` 时需要有配套声明才拿得到类型）。
//
// ★ 这里刻意**不 import** `@deepseek-ai/dsh-subagent` 的类型：
//   那个包的类型正是"可能描述另一代运行时"的东西（2026-10-20 那次故障的根因）。
//   本适配层只声明自己真正用到的形状，于是它不会因为依赖换代而编译失败 ——
//   两代差异在这里被**吸收**，而不是被类型系统假装不存在。

/** 子 Agent 的一轮提示（对齐 DSH `SubagentStartRequest` 的那部分）。 */
export interface ChildPromptRequest {
  /** 面向人的短标签（新代提到 spec 顶层，旧代放在 request 里）。 */
  label: string
  prompt: ReadonlyArray<{ type: 'text'; text: string }>
  parent: unknown
  signal?: AbortSignal
  outputSchema?: unknown
  agentOptions?: unknown
  cwd?: string
  agentPreset?: string
  maxDepth?: number
  /** Legion 自己的扩展键；两代 API 都不认，原样透传。 */
  toolFilter?: unknown
}

/** 子 Agent 的结算结果：只声明我们真正读的字段（两代都有）。 */
export interface ChildResult {
  output?: ReadonlyArray<{ type?: string; text?: string }>
  structured?: unknown
  diagnostic?: string
  stopReason: string
}

/** 归一化之后的子 Agent 句柄。 */
export interface ChildRun {
  /** 旧代 `run.id` / 新代 `activation.childId`；取不到就是 null。 */
  id: string | null
  result: Promise<ChildResult>
  dispose: () => Promise<void>
  /**
   * 进程内子 Agent（旧代 `SubagentRun.localAgent`）。
   *
   * ★ 新代 `startActivation` **不对外暴露它**：公开投影只有
   *   `{ childId, messageId, result, dispose }`。所以走新代时这里通常是 `undefined`，
   *   调用方那句"集成模式要求本地 Agent 执行拦截"会照常拒绝 ——
   *   那是正确的：它宁可拒绝，也不静默地在没有写保护的情况下跑。
   */
  localAgent?: unknown
}

/** 结果投递方式：`caller` 结果给调用方；`parent` 额外发父 Agent 完成通知。 */
export type ChildDelivery = 'caller' | 'parent'

/** `startChildAgent` 的可选项。 */
export interface StartChildOptions {
  delivery?: ChildDelivery
}

/** 该运行期对象支持哪一代 API。 */
export function subagentStartApi(runtime: unknown): 'startActivation' | 'start' | 'none'

/** 该对象上的可调用成员名（错误信息用）。 */
export function callableMembers(runtime: unknown): string[]

/** 启动一个子 Agent（归一化两代差异）。 */
export function startChildAgent(
  runtime: unknown,
  provider: string,
  request: ChildPromptRequest,
  options?: StartChildOptions,
): Promise<ChildRun>
