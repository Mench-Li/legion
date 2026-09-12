// runtime/contracts/index.d.mts
// ============================================================================
// Runtime Contract 类型声明（PRT-101/102/103）。
//
// 本文件**不得** import 任何 `@deepseek-ai/*` 类型：契约必须独立于 Cordis/DSH，
// 否则「用内存 Fake Adapter 完成全部 Orchestrator 测试」这条完成标准不成立
// （spec §6.1）。`dsh-boundary.mjs` 对 `runtime/contracts/` 施加 must-be-zero 判定。
// ============================================================================

// ---------------------------------------------------------------- errors

/** 标准错误码（spec §6.1）。 */
export type RuntimeErrorCode =
  | 'RUNTIME_UNAVAILABLE'
  | 'RUNTIME_NOT_READY'
  | 'UNSUPPORTED_CAPABILITY'
  | 'SECRET_UNAVAILABLE'
  | 'AUTH_FAILED'
  | 'MODEL_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'BUDGET_EXCEEDED'
  | 'CONTEXT_TOO_LARGE'
  | 'TOOL_DENIED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'RUNTIME_CRASHED'
  | 'OUTCOME_UNKNOWN'
  | 'INVALID_RESULT'
  | 'SCHEMA_MIGRATION_FAILED'

export type Retryability = 'auto' | 'conditional' | 'manual' | 'never'
export type AuditLevel = 'notice' | 'warn' | 'error'

export interface ErrorCatalogEntry {
  readonly retryability: Retryability
  readonly requires: string | null
  readonly auditLevel: AuditLevel
  /** 面向客户的文案，不得出现 DSH/Cordis 词汇。 */
  readonly userMessage: string
}

export declare const ERROR_CATALOG: Readonly<Record<RuntimeErrorCode, ErrorCatalogEntry>>
export declare const ERROR_CODES: readonly RuntimeErrorCode[]
export declare const RETRYABILITY: Readonly<Record<'AUTO' | 'CONDITIONAL' | 'MANUAL' | 'NEVER', Retryability>>
export declare const RETRY_REQUIRES: Readonly<Record<string, string>>
export declare const AUDIT_LEVEL: Readonly<Record<'NOTICE' | 'WARN' | 'ERROR', AuditLevel>>

export interface RetryContext {
  readonly confirmedNoExternalEffect?: boolean
  readonly recoveryJudgment?: boolean
  readonly explicitFallback?: boolean
  readonly taskPolicyAllowsNewAttempt?: boolean
  readonly runtimeReady?: boolean
}

export declare class RuntimeContractError extends Error {
  readonly code: RuntimeErrorCode
  readonly outcomeUnknown: boolean
  readonly details: Record<string, unknown>
  readonly userMessage: string
  constructor(code: RuntimeErrorCode, message: string, options?: { outcomeUnknown?: boolean; details?: object })
}

export declare function describeError(code: RuntimeErrorCode): ErrorCatalogEntry
export declare function isKnownErrorCode(code: string): boolean
export declare function isRetryable(code: RuntimeErrorCode, context?: RetryContext): { retryable: boolean; reason: string }
export declare function isOutcomeUnknownLike(code: RuntimeErrorCode): boolean

// ---------------------------------------------------------------- model

export interface ModelLimits {
  readonly maxTokens?: number
  readonly maxContextTokens?: number
  readonly maxCostUsdPerRun?: number
}

export interface ModelProfile {
  readonly id: string
  readonly displayName: string
  readonly runtimeType: string
  readonly provider: string
  readonly model: string
  readonly endpoint?: string | null
  /** 本机密钥库引用名，**不是**密钥本身。 */
  readonly secretRef?: string | null
  readonly reasoningEffort?: 'low' | 'medium' | 'high'
  readonly limits?: ModelLimits
}

export interface ModelDescriptor {
  readonly id: string
  readonly displayName: string
  readonly runtimeType: string
  readonly provider: string
  readonly model: string
  readonly endpoint: string | null
  readonly reasoningEffort: string
  readonly limits: ModelLimits
  /** 只暴露「有无凭证」，不暴露引用名本身。 */
  readonly hasCredential: boolean
}

export interface ValidationResult {
  readonly ok: boolean
  readonly code: RuntimeErrorCode | null
  readonly message: string
  readonly latencyMs: number | null
  readonly capabilities: Record<string, unknown> | null
}

export declare function findPlaintextSecrets(value: unknown, path?: string): string[]
export declare function validateProfile(profile: unknown): { ok: boolean; errors: string[]; value: ModelProfile | null }
export declare function toModelDescriptor(profile: ModelProfile): ModelDescriptor
export declare function validationResult(input: {
  ok: boolean
  code?: RuntimeErrorCode | null
  message?: string
  latencyMs?: number | null
  capabilities?: Record<string, unknown> | null
}): ValidationResult

// ------------------------------------------------- 模型连通性与能力探测（PRT-504）

/** 探测失败码。`UNCLASSIFIED` 的存在是刻意的：分不出来就要说出来。 */
export type ProbeCode =
  | 'SECRET_UNAVAILABLE'
  | 'SECRET_REF_MISSING'
  | 'AUTH_FAILED'
  | 'ENDPOINT_UNREACHABLE'
  | 'TLS_FAILED'
  | 'RATE_LIMITED'
  | 'MODEL_NOT_FOUND'
  | 'PROVIDER_ERROR'
  | 'BAD_RESPONSE'
  | 'TIMEOUT'
  | 'CAPABILITY_MISSING'
  | 'UNCLASSIFIED'

/** 失败**处置类别**——调用方的下一动作由它决定，而不是由具体码决定。 */
export type ProbeClass = 'fail-closed' | 'config' | 'transient' | 'unknown'

/** 能力项，封闭集合。 */
export type ModelCapability = 'chat' | 'tools' | 'vision' | 'json' | 'long-context' | 'reasoning'

/** 传输层事实（由 transport 或执行器归一化后给出）。 */
export type ProbeFailureKind = 'http' | 'connect' | 'tls' | 'timeout' | 'parse' | 'abort' | 'unknown'

export interface ProbeObserved {
  readonly ok: boolean
  /** 失败时的码。 */
  readonly code?: ProbeCode
  readonly message?: string
  readonly latencyMs?: number | null
  readonly capabilities?: Partial<Record<ModelCapability, unknown>>
}

export interface ProbeVerdict {
  readonly ok: boolean
  readonly code: ProbeCode | 'OK'
  readonly class: ProbeClass | null
  readonly message: string
  readonly missingCapabilities: readonly ModelCapability[]
  readonly capabilities: Partial<Record<ModelCapability, true>>
  readonly latencyMs: number | null
  /** 由执行器附加：这次判定是否来自缓存。 */
  readonly cached?: boolean
  /** 由执行器附加：这次探测是否被主动取消（取消不是失败码）。 */
  readonly cancelled?: boolean
  readonly ageMs?: number
}

export declare const PROBE_CODES: readonly ProbeCode[]
export declare const PROBE_CLASSES: readonly ProbeClass[]
export declare const PROBE_VERDICT_CODES: readonly (ProbeCode | 'OK')[]
export declare const PROBE_CODE_CLASS: Readonly<Record<ProbeCode, ProbeClass>>
export declare const MODEL_CAPABILITIES: readonly ModelCapability[]
export declare const PROBE_TTL_MS: number
export declare const NEGATIVE_PROBE_TTL_MS: number

export declare function classifyHttpStatus(status: unknown): ProbeCode
/** `kind: 'abort'` 返回 `null`——主动取消需要单独的表达，不是失败分类。 */
export declare function classifyFailure(input?: { kind?: ProbeFailureKind; status?: number }): ProbeCode | null
export declare function probeClassOf(code: unknown): ProbeClass
export declare function defaultProbeMessage(code: ProbeCode | string): string
export declare function normalizeCapabilities(raw: unknown): Partial<Record<ModelCapability, true>>
export declare function validateRequiredCapabilities(required?: unknown): {
  ok: boolean
  errors: string[]
  value: readonly ModelCapability[] | null
}
export declare function evaluateProbe(input?: {
  observed?: ProbeObserved | null
  required?: readonly ModelCapability[] | null
}): ProbeVerdict
export declare function probeFingerprint(profile: unknown): string
export declare function isProbeFresh(input?: { entry?: unknown; nowMs?: number; ttlMs?: number }): boolean
export declare function ttlForVerdict(
  verdict: unknown,
  opts?: { ttlMs?: number; negativeTtlMs?: number },
): number

// ---------------------------------------------------------------- run

export type RunEventType =
  | 'run.started'
  | 'model.selected'
  | 'message.delta'
  | 'tool.requested'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'usage.updated'
  | 'artifact.produced'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'run.outcome_unknown'

export type TerminalEventType = 'run.completed' | 'run.failed' | 'run.cancelled' | 'run.outcome_unknown'
export type RunOutcome = 'completed' | 'failed' | 'cancelled' | 'outcome_unknown'

export interface RunBudget {
  readonly maxCostUsd?: number
  readonly maxTokens?: number
}

/** 权限档位：preset 名 + 工具白名单。 */
export interface RunPermissions {
  readonly preset: string
  readonly tools: readonly string[]
  readonly [extra: string]: unknown
}

export interface ExpectedOutput {
  readonly schema: unknown
  readonly acceptance: string
}

export interface RunRequest {
  readonly runId: string
  readonly attemptId: string
  readonly idempotencyKey: string
  readonly workspaceId: string
  readonly goalId: string
  readonly taskId: string
  readonly employeeId: string
  /** 冻结的团队方案引用。 */
  readonly teamPlanRef: string
  /** 冻结的上下文快照引用。 */
  readonly contextSnapshotRef: string
  readonly modelProfileRef: string
  /**
   * 运行预算。**必填**，与 `RUN_REQUEST_REQUIRED` 一致。
   *
   * 允许传 `{}`——那表示「显式声明本次运行没有数值上限」，
   * 与「忘了写」是两回事。要求显式给出字段，是为了让无预算运行
   * 成为一个**已做出的决定**而不是一次疏忽。
   * （此前这里标为可选，与运行期校验器矛盾：TypeScript 调用方可以合法地
   * 省略 budget，然后在运行时被拒——声明与强制必须一致。）
   */
  readonly budget: RunBudget
  readonly timeoutMs: number
  readonly workdir: string
  /** 环境变量**白名单**（不是全量环境）。 */
  readonly env?: readonly string[]
  readonly permissions: RunPermissions
  readonly expectedOutput: ExpectedOutput
}

export interface RunUsage {
  readonly tokensIn: number
  readonly tokensOut: number
  readonly estimatedCostUsd: number | null
}

export interface RunResult {
  readonly runId: string
  readonly attemptId: string
  readonly outcome: RunOutcome
  readonly code: RuntimeErrorCode | null
  readonly output: unknown
  readonly usage: RunUsage | null
  /** 外部副作用是否可能已生效但未确认；为 true 时禁止自动重试写入。 */
  readonly outcomeUnknown: boolean
  readonly userMessage: string
}

export interface RunEvent {
  readonly type: RunEventType
  readonly runId: string
  readonly seq: number
  readonly at: number
  readonly result?: RunResult
  readonly code?: RuntimeErrorCode | null
  readonly [extra: string]: unknown
}

export interface CancelResult {
  readonly runId: string
  readonly accepted: true
  readonly alreadyTerminal: boolean
  readonly terminalType: TerminalEventType | null
}

export type RecoveryDecision = 'retry-new-attempt' | 'resume-same-run' | 'outcome-unknown' | 'already-terminal'

export interface RecoveryResult {
  readonly runId: string
  readonly decision: RecoveryDecision
  readonly reason: string
  readonly resumable: boolean
  /** 恒为 false：recover 只给判断，不修改 Task 状态（spec §6.1）。 */
  readonly mutatesTaskState: false
}

export declare const RUN_EVENT_TYPES: readonly RunEventType[]
export declare const TERMINAL_EVENT_TYPES: readonly TerminalEventType[]
export declare const RUN_REQUEST_REQUIRED: readonly string[]
export declare const TERMINAL_TO_OUTCOME: Readonly<Record<TerminalEventType, RunOutcome>>

export declare function isKnownEventType(type: string): boolean
export declare function isTerminalEventType(type: string): boolean
export declare function createSeqAllocator(start?: number): () => number
export declare function validateRunRequest(req: unknown): { ok: boolean; errors: string[]; value: RunRequest | null }
export declare function validateRunEvent(event: unknown): { ok: boolean; errors: string[] }
export declare function assertTerminalContract(events: readonly RunEvent[]): {
  ok: boolean
  errors: string[]
  terminal: RunEvent | null
  outcome: RunOutcome | null
}

export interface TerminalArbiter {
  commit(event: RunEvent, at?: number): { committed: boolean; outcome: RunOutcome | null; reason: string }
  get(runId: string): { event: RunEvent; outcome: RunOutcome; committedAt: number } | null
  isTerminal(runId: string): boolean
  diagnostics(): Array<{ runId: string; event: RunEvent; reason: string }>
}

export declare function createTerminalArbiter(): TerminalArbiter
export declare function deriveToolEffectIdempotencyKey(input: {
  workspaceId: string
  taskId: string
  attemptId: string
  callId: string
  canonicalOperationHash: string
}): string
export declare function cancelResult(input: {
  runId: string
  alreadyTerminal?: boolean
  terminalType?: TerminalEventType | null
}): CancelResult
export declare function recoveryResult(input: {
  runId: string
  decision: RecoveryDecision
  reason?: string
  resumable?: boolean
}): RecoveryResult

// ---------------------------------------------------------------- adapter

export type RuntimeHealthState = 'starting' | 'ready' | 'degraded' | 'unavailable' | 'incompatible' | 'upgrading'

export interface RuntimeHealth {
  readonly state: RuntimeHealthState
  readonly contractVersion: number
  readonly runtimeVersion: string | null
  readonly detail: string
  readonly productState: string
}

export interface RuntimeCapabilities {
  readonly [capability: string]: boolean
}

export interface RuntimeAdapter {
  readonly runtimeContractVersion: number
  getHealth(): Promise<RuntimeHealth>
  getCapabilities(): Promise<RuntimeCapabilities>
  listModels(): Promise<ModelDescriptor[]>
  validateProfile(profile: ModelProfile): Promise<ValidationResult>
  execute(request: RunRequest): AsyncIterable<RunEvent>
  cancel(runId: string): Promise<CancelResult>
  recover(runId: string): Promise<RecoveryResult>
}

export declare const RUNTIME_CONTRACT_VERSION: 1
export declare const ADAPTER_METHODS: readonly string[]
export declare const RUNTIME_HEALTH_STATES: readonly RuntimeHealthState[]
export declare const REQUIRED_CAPABILITIES: readonly string[]
export declare const OPTIONAL_CAPABILITIES: readonly string[]
export declare const HEALTH_BEHAVIOR: Readonly<
  Record<RuntimeHealthState, { productState: string; claimNewTasks: boolean; detail: string }>
>

export declare function assertAdapter(adapter: unknown): { ok: boolean; errors: string[] }
export declare function checkCompatibility(input: {
  adapterContractVersion: number
  capabilities: RuntimeCapabilities
  supportedContractVersion?: number
}): {
  compatible: boolean
  code: RuntimeErrorCode | null
  userMessage: string | null
  reason: string
  missingRequired: string[]
}
export declare function canClaimTasks(healthState: RuntimeHealthState | string): boolean
export declare function runtimeHealth(input: {
  state: RuntimeHealthState
  contractVersion?: number
  runtimeVersion?: string | null
  detail?: string
}): RuntimeHealth

// ---------------------------------------------------------------- fake adapter

export type FakeScenario =
  | 'success'
  | 'failure'
  | 'auth-failed'
  | 'rate-limited'
  | 'secret-unavailable'
  | 'budget-exceeded'
  | 'context-too-large'
  | 'invalid-result'
  | 'timeout'
  | 'crash'
  | 'outcome-unknown'
  | 'cancelled'
  | 'no-terminal'

export interface FakeRuntimeAdapter extends RuntimeAdapter {
  setScenario(runId: string, scenario: FakeScenario): void
  setEventScript(runId: string, events: RunEvent[]): void
  setHealth(state: RuntimeHealthState): void
  readonly calls: ReadonlyArray<{ name: string; at: number; payload?: unknown }>
  callCount(name: string): number
  settledType(runId: string): TerminalEventType | null
  reset(): void
}

export declare function createFakeRuntimeAdapter(options?: {
  now?: () => number
  capabilities?: Partial<RuntimeCapabilities>
  health?: RuntimeHealthState
  models?: ModelDescriptor[]
  defaultScenario?: FakeScenario
  planFor?: (request: RunRequest) => FakeScenario | { kind: FakeScenario } | null
}): FakeRuntimeAdapter

export declare const FAKE_SCENARIOS: Readonly<Record<FakeScenario, { terminal: TerminalEventType | null; code: RuntimeErrorCode | null }>>
export declare const INJECTABLE_ERROR_CODES: readonly RuntimeErrorCode[]
