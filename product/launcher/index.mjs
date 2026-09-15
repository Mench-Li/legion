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

// PRT-257：DSH 强制面覆盖层。`resolveDshOverlay` 是"该不该把 `--patch` 交给
// runtime"的唯一判定点——运维脚本要单独问这个问题时走这里，不要自己拼路径。
export {
  DSH_OVERLAY_CODES,
  DSH_OVERLAY_FLAG,
  DSH_OVERLAY_PROCESS_KEY,
  DSH_OVERLAY_RELPATH,
  DSH_OVERLAY_VERSION,
  overlayArgsFor,
  overlayRelpathOf,
  resolveDshOverlay,
} from './dsh-overlay.mjs'

// PRT-708：系统托盘的三层。以前这里一条都没有——`tray.mjs` / `tray-wiring.mjs`
// 只被各自的用例 import 过，于是"这个功能存不存在"在产品这一层无从判断。
//
// ★ `attachLauncherTray` 是**生产入口**（`cli.mjs` 的启动路径就是调它），
//   `nativeIconSupport` 是那个**三态**读数（`true` / `false` / `null`）。
//   诊断面板要按 `null` 显示"还没起过宿主"而不是"不支持"——两者的修法不同，
//   所以这里导出的是探测函数本身，不是一个快照常量。
export {
  TRAY_WIRING_CODES,
  attachLauncherTray,
  createLauncherTray,
  iconNoticeOf,
  nativeIconSupport,
} from './tray-wiring.mjs'
export {
  TRAY_ICON_CODES,
  createTrayIconHost,
  probeTrayIconSupport,
  resolveTrayShell,
} from './tray-icon.mjs'
export { TRAY_CODES, createTray } from './tray.mjs'
