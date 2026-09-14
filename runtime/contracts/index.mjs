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
  MODEL_CAPABILITIES,
  NEGATIVE_PROBE_TTL_MS,
  PROBE_CLASSES,
  PROBE_CODES,
  PROBE_CODE_CLASS,
  PROBE_TTL_MS,
  PROBE_VERDICT_CODES,
  classifyFailure,
  classifyHttpStatus,
  defaultProbeMessage,
  evaluateProbe,
  isProbeFresh,
  normalizeCapabilities,
  probeClassOf,
  probeFingerprint,
  ttlForVerdict,
  validateRequiredCapabilities,
} from './model-probe.mjs'

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

export {
  CONTEXT_SNAPSHOT_DOMAIN,
  CONTEXT_SNAPSHOT_SCHEMA_VERSION,
  CONTEXT_SOURCE_TYPES,
  EXCLUSION_REASONS,
  INVENTORY_OUTCOMES,
  SOURCE_TRUST,
  TOKEN_ESTIMATOR_KINDS,
  createContextSource,
  createExclusion,
  createSourceInventory,
  createSourceInventoryEntry,
  createTokenMeasurement,
  freezeContextSnapshot,
  computeSnapshotHash,
  verifySnapshotHash,
  orderSources,
  assertAccounting,
  snapshotCanonicalJson,
} from './context.mjs'
export { canonicalJson, canonicalScalar, domainSeparatedHash, nfc } from './canonical.mjs'
export { FAKE_SCENARIOS, INJECTABLE_ERROR_CODES, createFakeRuntimeAdapter } from './fake-adapter.mjs'

// PRT-253 跨进程边界：Runtime Contract 的**线上表示**（路由 / 信封 / NDJSON 帧 /
// 失败语义 / 鉴权比较）。它是契约的一部分，因此与其余契约符号同一个出口——
// 两侧各 import 一份，就不会出现"服务端与客户端各有一份协议"。
export {
  RUNTIME_CONTRACT_WIRE_VERSION,
  WIRE_ADAPTER_OPERATIONS,
  WIRE_ANONYMOUS_OPERATIONS,
  WIRE_AUTH_HEADER,
  WIRE_AUTH_SCHEME,
  WIRE_BASE_PATH,
  WIRE_CODES,
  WIRE_CONTROL_FRAMES,
  WIRE_CONTROL_KEY,
  WIRE_CONTRACT_CHECKED,
  WIRE_CONTRACT_VERSION,
  WIRE_ENDING_FAILURE_CODE,
  WIRE_ENDING_YIELDS_OUTCOME,
  WIRE_EXECUTE_ENDINGS,
  WIRE_JSON_CONTENT_TYPE,
  WIRE_MAX_BODY_BYTES,
  WIRE_NDJSON_CONTENT_TYPE,
  WIRE_OPERATIONS,
  WIRE_ROUTES,
  assertWireCoversContract,
  decodeEventLine,
  encodeControlFrame,
  encodeEventLine,
  isAnonymousOperation,
  isControlFrame,
  isWireKnownEventType,
  isWireTerminalEvent,
  parseAuthorization,
  readEnvelope,
  readRequestEnvelope,
  routeFor,
  tokensMatch,
  wireRefusal,
  wireRequest,
  wireSuccess,
} from './wire.mjs'
