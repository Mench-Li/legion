// product/index.mjs
// ============================================================================
// 产品层公共出口（PRT-258）
//
// 阶段 2.5 冻结的四份契约在这里暴露：目录布局、进程清单、配置优先级、密钥接口
// （密钥接口在 `security/secrets/`，属 PRT-254/505，落地后同样从这里再导出）。
// 阶段 5/7 只做增量扩展，不重新设计——同一交付物不做两遍。
//
// 本目录被 `scripts/ci/dsh-boundary.mjs` 判为 **must-be-zero**：
// 产品层不得出现任何 DSH 执行面记号，执行面只能从 `runtime/adapters/dsh/` 进入。
// ============================================================================

export {
  CONFIG_LAYER_LABELS,
  CONFIG_LAYERS,
  DIAGNOSTIC_SEVERITIES,
  DIR_ROLES,
  LEGION_ENV,
  WRITABLE_ROLES,
  assertConfigWritable,
  assertLayoutUsable,
  defaultProductHome,
  findPlaintextSecretsInConfig,
  hasBlockingDiagnostic,
  isPathInside,
  layoutDiagnostics,
  mergeConfigLayers,
  normalizePath,
  pathApi,
  pathsOverlap,
  provenanceOf,
  resolveLayout,
  samePath,
} from './paths.mjs'

export {
  DEFAULT_PORTS,
  LOOPBACK_HOSTS,
  MANIFEST_KNOWN_GAPS,
  PROCESS_KEYS,
  PROCESS_MANIFEST_VERSION,
  PROCESS_SPECS,
  entryAbsolutePath,
  entryEscapesInstall,
  hasBlockingProcessDiagnostic,
  materializeProcessPlan,
  specFor,
  splitCommandLine,
  startupWaves,
  validateProcessPlan,
} from './process-manifest.mjs'
