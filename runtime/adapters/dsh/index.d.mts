// runtime/adapters/dsh/index.d.mts
// ============================================================================
// DshRuntimeAdapter 类型声明（PRT-201～PRT-209）
//
// 与 `runtime/contracts/index.d.mts` 一样，本文件**不得** import 任何
// `@deepseek-ai/*` 类型：适配器与 DSH 的唯一契约是 `DshHostPort`，
// 由 `runtime/dsh-composition/`（PRT-214）把引擎的 subagents 服务接上去。
// ============================================================================
import type {
  CancelResult,
  ModelDescriptor,
  ModelProfile,
  RecoveryResult,
  RunEvent,
  RunRequest,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeHealth,
  ValidationResult,
} from '../../contracts/index.mjs'

/**
 * `subagents.start` 的选项形状（照抄既有生产调用点的最小子集）。
 * 只声明我们真正传入的字段；引擎支持更多选项不是本契约的一部分。
 */
export interface DshStartRunOptions {
  readonly label: string
  readonly prompt: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>
  readonly signal: AbortSignal
  readonly outputSchema?: unknown
}

/** `startRun` 返回的句柄。`result` 可能**永不结算**（见 port.mjs 文件头）。 */
export interface DshRunHandle {
  readonly result: Promise<{ readonly stopReason?: string; readonly structured?: unknown; readonly usage?: unknown }>
  dispose?(): Promise<void>
  /** 可选：宿主提供的事件流。不提供时不合成任何细粒度事件。 */
  readonly events?: AsyncIterable<{ readonly type: string } & Record<string, unknown>>
}

/** 注入的 DSH 宿主端口。`currentModelSelection` 与 `listModels` 至少提供一个。 */
export interface DshHostPort {
  /** 当前默认模型选择。缺省时 `listModels()` 返回空数组。 */
  currentModelSelection?(): {
    id?: string
    displayName?: string
    provider: string
    model?: string
    endpoint?: string | null
    secretRef?: string | null
    reasoningEffort?: 'low' | 'medium' | 'high'
    limits?: object
  } | null
  startRun(provider: string, options: DshStartRunOptions): Promise<DshRunHandle>
  probeRuntime(): Promise<{ version?: string; capabilities?: Record<string, unknown> }>
  listModels?(): Promise<ModelProfile[]> | ModelProfile[]
}

export declare const REQUIRED_PORT_METHODS: readonly string[]
export declare const OPTIONAL_PORT_METHODS: readonly string[]

export declare class DshPortError extends Error {}

export declare function assertHostPort(host: unknown): { ok: boolean; errors: string[] }
export declare function normalizeRunHandle(raw: unknown): {
  result: Promise<unknown>
  dispose: (() => Promise<void>) | null
  events: AsyncIterable<unknown> | null
  warnings: string[]
}
export declare function safeDispose(handle: { dispose?: (() => Promise<void>) | null } | null, onWarning?: (m: string) => void): Promise<boolean>

/** 看起来会产生外部副作用的工具名模式（用于超时后的重试安全判定）。 */
export declare const WRITE_TOOL_RE: RegExp
export declare function mayHaveExternalEffect(request: Pick<RunRequest, 'permissions'>): boolean

export declare const WATCHDOG_GRACE_MS: number
export declare const CANCEL_GRACE_MS: number

export interface DshAdapterInternals {
  readonly lateResults: ReadonlyArray<{ runId: string; at: number; lateResult: unknown }>
  activeRuns(): string[]
  settledCount(): number
  probe(): RuntimeProbeResult | null
  lateResultsList(): ReadonlyArray<{ runId: string; at: number; lateResult: unknown }>
}

export interface RuntimeProbeResult {
  readonly ok: boolean
  readonly version: string | null
  readonly capabilities: Readonly<Record<string, boolean>>
  readonly requiredMissing: readonly string[]
  readonly optionalPresent?: readonly string[]
  readonly prerelease?: boolean
  readonly reason: string
}

/** 适配器：契约接口 + 两个显式入口（探测、协商）。 */
export interface DshRuntimeAdapter extends RuntimeAdapter {
  /** 主动探测运行时并缓存（PRT-209 / PRT-215 的入口）。 */
  probe(): Promise<RuntimeProbeResult>
  /** 按当前探测结果做契约协商。 */
  checkCompatibilityNow(): Promise<{
    compatible: boolean
    code: string | null
    userMessage: string
    reason: string
    missingRequired: readonly string[]
  }>
  /** 诊断入口（测试与排障用；不属于产品契约）。 */
  readonly _internals: DshAdapterInternals
}

export declare function createDshRuntimeAdapter(
  host: DshHostPort,
  options?: {
    now?: () => number
    watchdogGraceMs?: number
    cancelGraceMs?: number
    pricing?: { asOf: string; currency: string; models: Readonly<Record<string, { inPerMTok: number; outPerMTok: number }>> }
    runtimePolicy?: { supportedMajor: number; minVersion: string }
    maxTrackedRuns?: number
  },
): DshRuntimeAdapter

export declare const DEFAULT_ADAPTER_OPTIONS: Readonly<{
  now: () => number
  watchdogGraceMs: number
  cancelGraceMs: number
  pricing: unknown
  runtimePolicy: undefined
  maxTrackedRuns: number
}>

// ---- 子模块 ----

export declare const ERROR_PATTERNS: ReadonlyArray<{ code: string; re: RegExp; why: string }>
export declare const STOP_REASON_MAP: Readonly<Record<string, string>>
export declare function errorFingerprint(err: unknown): string
export declare function classifyDshError(
  err: unknown,
  options?: { abortedBy?: 'timeout' | 'caller' | null },
): { code: string; unknown: boolean; detail: string; why: string }
export declare function classifyStopReason(stopReason: unknown): { code: string | null; unknown: boolean; detail: string }
export declare function toContractError(classification: { code: string; detail?: string; why?: string }, options?: { runId?: string; outcomeUnknown?: boolean }): Error
export declare function retryVerdict(code: string, context?: object): { retryable: boolean; reason: string }

export declare const SENSITIVE_KEY_RE: RegExp
export declare const SECRET_VALUE_PATTERNS: ReadonlyArray<{ re: RegExp; why: string; replace?: string }>
export declare const REDACTED = '[已脱敏]'
export declare function redactText(text: unknown): { text: string; hits: string[] }
export declare function redactValue(input: unknown, options?: { maxDepth?: number; maxStringLength?: number; onUnserializable?: string }): {
  value: unknown
  redacted: string[]
  truncated: number
}
export declare function redactJson(input: unknown, options?: object): { json: string; redacted: string[] }

export declare const SUPPORTED_TYPES: readonly string[]
export declare function validateStructured(schema: unknown, value: unknown): { ok: boolean; errors: string[] }
export declare function validateExpectedOutput(expectedOutput: unknown): { ok: boolean; errors: string[] }

export declare const PRICING: Readonly<{ asOf: string; currency: string; models: Readonly<Record<string, { inPerMTok: number; outPerMTok: number }>> }>
export declare const USAGE_FIELD_ALIASES: Readonly<Record<string, readonly string[]>>
export declare function collectUsage(result: unknown, options?: { pricing?: object; model?: string | null }): { tokensIn: number | null; tokensOut: number | null; estimatedCostUsd: number | null } | null
export declare function estimateCostUsd(input: { model?: string | null; tokensIn?: number; tokensOut?: number; pricing?: object }): number | null
export declare function createDurationTracker(now?: () => number): {
  start(key: string): number
  elapsedMs(key: string): number | null
  stop(key: string): number | null
  running(): string[]
}
export declare function checkBudget(input: { budget?: { maxTokens?: number; maxCostUsd?: number }; usage?: { tokensIn: number; tokensOut: number; estimatedCostUsd: number | null } | null }): { kind: string; limit: number; used: number | null; message: string } | null

export declare const DSH_EVENT_MAP: Readonly<Record<string, string>>
export declare function mapDshEvent(raw: unknown): { type: string; unmapped: boolean; payload: Record<string, unknown>; redactedPaths?: string[] }
export declare function createEventEmitter(input: {
  runId: string
  now?: () => number
  startSeq?: number
  terminalTypes?: readonly string[]
}): {
  emit(type: string, extra?: object): RunEvent | null
  emitMapped(mapped: { type: string; payload: Record<string, unknown> }, extra?: object): RunEvent | null
  terminalType(): string | null
  isTerminal(): boolean
  lateTerminals(): ReadonlyArray<{ type: string; at: number; reason: string }>
}
export declare function terminalTypeFor(stopReason: unknown, classification: { code: string | null }): string

export declare const SUPPORTED_RUNTIME: Readonly<{ supportedMajor: number; minVersion: string; note: string }>
export declare function parseVersion(text: unknown): { major: number; minor: number; patch: number; prerelease: string | null } | null
export declare function compareVersion(a: { major: number; minor: number; patch: number }, b: { major: number; minor: number; patch: number }): number
export declare function checkRuntimeVersion(version: unknown, policy?: object): { compatible: boolean; parsed: object | null; reason: string; prerelease: boolean }
export declare function probeRuntime(host: DshHostPort, policy?: object): Promise<RuntimeProbeResult>

export type { CancelResult, ModelDescriptor, ModelProfile, RecoveryResult, RunEvent, RunRequest, RuntimeAdapter, RuntimeCapabilities, RuntimeHealth, ValidationResult }
