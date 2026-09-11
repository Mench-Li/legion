// runtime/contracts/index.mjs
// ============================================================================
// Runtime Contract 唯一出口。
//
// 下游（Orchestrator、Runtime Manager、各 Adapter）一律从这里取契约符号，
// 不直接深入子模块——这样契约重组时只需改一处。
//
// 语言选择说明：本目录用 `.mjs` 运行时 + `index.d.mts` 类型声明，而不是纯 `.ts`。
// 与仓库既有约定一致（`plugins/config-schema.mjs` + `.d.mts`、
// `team-hub/server.mjs` + `server.d.mts`）：测试用 `node --test` 直接 import，
// 不需要 `--experimental-strip-types`，也不会让契约模块在运行时带上编译步骤。
// 契约的核心价值是「双方都能无摩擦地引用」，运行时可加载性是其中一半。
// ============================================================================

export {
  ERROR_CATALOG,
  ERROR_CODES,
  RETRYABILITY,
  RETRY_REQUIRES,
  AUDIT_LEVEL,
  RuntimeContractError,
  describeError,
  isKnownErrorCode,
  isOutcomeUnknownLike,
  isRetryable,
} from './errors.mjs'

export {
  MODEL_PROFILE_FIELDS,
  findPlaintextSecrets,
  toModelDescriptor,
  validateProfile,
  validationResult,
} from './model.mjs'

export {
  RUN_EVENT_TYPES,
  RUN_REQUEST_REQUIRED,
  TERMINAL_EVENT_TYPES,
  TERMINAL_TO_OUTCOME,
  assertTerminalContract,
  cancelResult,
  createSeqAllocator,
  createTerminalArbiter,
  deriveToolEffectIdempotencyKey,
  isKnownEventType,
  isTerminalEventType,
  recoveryResult,
  validateRunEvent,
  validateRunRequest,
} from './run.mjs'

export {
  ADAPTER_METHODS,
  HEALTH_BEHAVIOR,
  OPTIONAL_CAPABILITIES,
  REQUIRED_CAPABILITIES,
  RUNTIME_CONTRACT_VERSION,
  RUNTIME_HEALTH_STATES,
  assertAdapter,
  canClaimTasks,
  checkCompatibility,
  runtimeHealth,
} from './adapter.mjs'

export { FAKE_SCENARIOS, INJECTABLE_ERROR_CODES, createFakeRuntimeAdapter } from './fake-adapter.mjs'
