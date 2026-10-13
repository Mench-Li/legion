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

/** 凭据从哪来。**修法随它而变**，所以结论里必须带上它。 */
export type AuthMode = 'subscription' | 'api-settings' | 'env' | 'none' | 'not-required'

/** 凭据模式的取值表（运行期同名导出的类型面）。 */
export declare const AUTH_MODE: Readonly<Record<string, AuthMode>>

/** 单个 provider 的探测结论（**不含机器路径、不含凭据**）。 */
export interface ProviderReadiness {
  readonly state: ReadinessState
  /** 面向用户的一句话，含修法。 */
  readonly reason: string
  readonly cli?: string
  readonly auth?: string
  /**
   * 凭据模式（2026-10-13 加）。
   *
   * ★ 它区分的是**同样是"有凭据"的两种完全不同用法**：订阅态 OAuth、与 CLI 配置里的
   *   API 模式。第一版没区分，于是把 API 模式的用户判成"没登录"并叫他去 `/login` ——
   *   那条建议对他是**有害的**（会把他刻意配好的东西顶掉）。
   */
  readonly authMode?: AuthMode
  /** 探过的端点 host（只到 host：不含路径与查询串）。 */
  readonly endpointHost?: string
  readonly network?: string
  readonly version?: string
  readonly checkedAtMs: number
}

/** 一批 provider 的结论，按 provider 名索引。 */
export type ProviderReadinessTable = Record<string, ProviderReadiness>

/**
 * 真正要探测的名字 = **注册表里的** ∪ **规格表里已知的**。
 *
 * ★ 必须并上规格表：注册表为空时若只探注册表，就会探出一个空集，
 *   于是心跳发出一个空的 `providers`、服务端整份丢掉 ⇒ **读数永远不出现而全程零报错**。
 *   而 `spawn` 随进程内跑，永远可用，用不着注册表告诉我们。
 */
export declare function readinessProbeTargets(names?: readonly string[] | null): string[]

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
