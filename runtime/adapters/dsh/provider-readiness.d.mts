// runtime/adapters/dsh/provider-readiness.d.mts
// ============================================================================
// provider-readiness.mjs 的类型声明。
//
// 与 `runtime/adapters/dsh/subagent-client.d.mts` 同一口径：本文件**不得** import
// 任何 `@deepseek-ai/*` 类型 —— 适配器与 DSH 的界线只在 `.mjs` 的运行期，
// 类型面用结构化声明表达。
//
// ★ 这里只声明**插件真正用到**的那几个面（`createLocalReadinessDeps` /
//   `createReadinessCache` / `probeProviders`），探测内部用的依赖注入接口
//   （`ReadinessDeps` 之类）刻意不导出到类型面：插件不构造它们，
//   把内部形状钉进类型面只会让"改探测实现"变成一次跨包的类型变更。
// ============================================================================

/** 探测结论的取值。与 `.mjs` 里的 `READINESS_STATE` 一一对应。 */
export type ReadinessState =
  | 'ready'
  | 'missing_cli'
  | 'not_logged_in'
  | 'no_network'
  | 'unprobed'
  | 'unknown'

/** 单个 provider 的探测结论（**不含机器路径、不含凭据**）。 */
export interface ProviderReadiness {
  readonly state: ReadinessState
  /** 面向用户的一句话，含修法。 */
  readonly reason: string
  readonly cli?: string
  readonly auth?: string
  readonly network?: string
  readonly version?: string
  readonly checkedAtMs: number
}

/** 一批 provider 的结论，按 provider 名索引。 */
export type ProviderReadinessTable = Record<string, ProviderReadiness>

/** 本地真实依赖（PATH / HOME / env 都取自运行环境）。 */
export declare function createLocalReadinessDeps(options?: {
  env?: Record<string, string | undefined>
  home?: string | null
  platform?: string
}): Record<string, unknown>

/** 逐个探测；带总截止时间，超时的报 `unknown`（不猜）。 */
export declare function probeProviders(
  names: readonly string[] | null | undefined,
  deps?: unknown,
  options?: { deadlineMs?: number },
): Promise<ProviderReadinessTable>

/**
 * 后台探测 + 读缓存的壳子。
 *
 * ★ `snapshot()` **立刻返回**（可能为 `null` = 本轮还没有读数），刷新在后台 ——
 *   心跳路径靠这一点保证不被探测拖住。
 */
export declare function createReadinessCache(options: {
  probe: (names: string[]) => Promise<ProviderReadinessTable>
  ttlMs?: number
  now?: () => number
  onError?: (error: unknown) => void
}): {
  snapshot(names: readonly string[]): ProviderReadinessTable | null
  settled(): Promise<void>
}
