// runtime/adapters/dsh/subagent-client.d.mts
// ============================================================================
// subagent-client.mjs 的类型声明。
//
// 与 `runtime/adapters/dsh/index.d.mts` 同一口径：本文件**不得** import 任何
// `@deepseek-ai/*` 类型——适配器与 DSH 的界线只在 `.mjs` 的运行期，类型面用
// 结构化声明表达，免得把 DSH 类型又漏回插件的类型依赖里。
// ============================================================================
import type { ExternalAgentExecution } from './external-agent.mjs'

/** 本适配器真正读取的 provider 能力位（照抄 DSH SubagentCapabilities 的可读子集）。 */
export interface DshSubagentCapabilities {
  readonly agentOptions: boolean
  readonly outputSchema: boolean
  readonly depthLimit: boolean
  readonly toolFilter: boolean
  readonly persona: boolean
}

/** 本适配器真正读取的 provider 描述符字段。 */
export interface DshSubagentProvider {
  readonly name: string
  readonly capabilities: DshSubagentCapabilities
  /** 注册时固定的生效非交互权限模式；未声明即 undefined。 */
  readonly permissionMode?: string
  /** 注册时固定的生效系统代理模式；未声明即 undefined。 */
  readonly systemProxyMode?: string
}

/** 心跳上报用的 provider 能力快照（与迁移前逐字段一致）。 */
export interface DshSubagentProviderCapabilities {
  readonly outputSchema: boolean
  readonly toolFilter: boolean
  readonly cancellation: boolean
  readonly permissionMode?: string
  readonly systemProxyMode?: string
}

export declare function listSubagentProviders(ctx: unknown): string[]
export declare function subagentProvider(ctx: unknown, name: string): DshSubagentProvider | undefined
/** 原样返回运行期报告的值（可能是 undefined 或非字符串）；不做归一化。 */
export declare function subagentProviderPermissionMode(ctx: unknown, name: string): unknown
export declare function subagentProviderCapabilities(ctx: unknown, name: string): DshSubagentProviderCapabilities
export declare function executeExternalAgentInContext(
  ctx: unknown,
  options?: Record<string, unknown>,
): Promise<ExternalAgentExecution>
