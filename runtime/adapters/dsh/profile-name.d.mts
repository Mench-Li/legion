// runtime/adapters/dsh/profile-name.d.mts
// ============================================================================
// profile-name.mjs 的类型声明。
//
// 与 `runtime/adapters/dsh/subagent-client.d.mts` / `provider-readiness.d.mts` 同一口径：
// 本文件**不得** import 任何 `@deepseek-ai/*` 类型 —— 适配器与 DSH 的界线只在 `.mjs`
// 的运行期，类型面用结构化声明表达。
// ============================================================================

/** profile 名的合法性（照抄 DSH 的 `resolveProfileDir` 规则）。 */
export declare function isAcceptableProfileName(value: unknown): value is string

/**
 * 取这个守护所属的 profile 名；取不到返回 `null`。
 *
 * 顺序：`DSH_PROFILE` → `DSH_PROFILE_DIR` 的目录名 → argv 里带 `dsh-desktop-host` 时为 `desktop`。
 */
export declare function resolveProfileName(input?: {
  env?: Record<string, string | undefined>
  argv?: readonly string[]
}): string | null
