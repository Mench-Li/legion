// product/index.mjs
// ============================================================================
// 产品层公共出口（PRT-258）
//
// 阶段 2.5 冻结的四份契约：目录布局、进程清单、配置优先级在这里暴露；
// 第四份（密钥库接口）在 `security/secrets/index.mjs`，**刻意不从本文件再导出**：
// 一个「顺手什么都导出」的 barrel 会把能拿明文的代码带进每一个只需要进程清单的
// 消费者里，而密钥泄漏不需要谁犯错，只需要它出现在作用域里。
//
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

// 脱敏诊断包（PRT-710）。spec §6.7 把「诊断包」与提示词、日志、异常、审计、
// 能力包并列，作为**密钥不得出现的地方**。
//
// 这里导出的是**产品级能力**（Launcher / 界面调它），不是密钥库的访问口——
// 本模块刻意只依赖脱敏模式表，`security/secrets/*` 一行都不 import：
// 一个只负责"把东西带出去"的模块，没有任何理由持有打开密钥库的能力。
export {
  DEFAULT_LIMITS,
  DIAG_CODES,
  DIAG_STATUSES,
  HITS_CAVEAT,
  STRUCTURAL_EXCLUSIONS,
  buildManifest,
  defaultCandidates,
  exportDiagnosticPackage,
  flattenName,
  planPackage,
  structuralExclusionFor,
  verifyWrittenFiles,
} from './diagnostics/redact-package.mjs'
