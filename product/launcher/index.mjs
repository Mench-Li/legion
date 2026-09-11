// product/launcher/index.mjs
// ============================================================================
// Product Launcher 公共出口（PRT-251 / PRT-703 / PRT-704 第一实现）
//
// 本目录被 `scripts/ci/dsh-boundary.mjs` 判为 **must-be-zero**：
// 启动器不得出现任何 DSH 执行面记号。执行面（DSH Runtime）是一个**受监督的子进程**，
// 通过产品配置里的命令行启动；它不因为是 DSH 而获得任何特殊通道。
//
// 本目录**只有一个文件读宿主环境**：`allowlist.mjs` 的调用方（Launcher 创建处）传入
// `baseEnv`。白名单构造保证宿主环境不会整份流进子进程。
// ============================================================================

export { buildChildEnv, isSecretLikeKey, secretSurfaceOf, OS_ESSENTIAL_ENV } from './allowlist.mjs'
export { canBind, checkPorts, reserveEphemeralPort, somethingIsListening } from './ports.mjs'
export {
  DEFAULT_READINESS_INTERVAL_MS,
  DEFAULT_READINESS_TIMEOUT_MS,
  FATAL_PROBE_CODES,
  RETRYABLE_PROBE_CODES,
  expandTemplate,
  isRetryableProbeCode,
  probeOnce,
  readinessResultToDiagnostic,
  waitForReadiness,
} from './readiness.mjs'
export {
  DEFAULT_BACKOFF,
  SUPERVISOR_STATES,
  createSupervisedProcess,
  createSupervisor,
  defaultKillTree,
} from './supervisor.mjs'
export {
  PRODUCT_STATE_TEXT,
  createLauncher,
  expandExpectation,
  measureReadiness,
  productStateOf,
  startResultIsBlocking,
} from './launcher.mjs'
