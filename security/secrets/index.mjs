// security/secrets/index.mjs
// ============================================================================
// 密钥库公共出口（PRT-505 / PRT-258 第四份契约）
//
// 本目录被 `scripts/ci/dsh-boundary.mjs` 判为 **must-be-zero**：
// 密钥层不得出现任何 DSH 执行面记号，也不读 `process.env`——
// 密钥不该出现在环境变量里，配置面也不该多出不可扫描的读取点。
// ============================================================================

export {
  LEGION_SECRET_NAMESPACE,
  SECRET_REF_MAX_LENGTH,
  SECRET_REF_RE,
  assertSecretRef,
  isLegionSecretRef,
  isSecretRef,
} from './ref.mjs'

export {
  RUNTIME_CODE_FOR,
  SECRET_ERROR_HINTS,
  SecretStoreError,
  isSecretStoreError,
} from './errors.mjs'

export {
  DPAPI_SCHEME,
  POWERSHELL_CANDIDATES,
  probeDpapi,
  protectValue,
  resolvePowershell,
  unprotectValue,
} from './dpapi.mjs'

export {
  AUDIT_ACTIONS,
  PROTECTION_SCHEMES,
  SECRET_META_FIELDS,
  SECRET_STORE_VERSION,
  assertProtectedStore,
  createDpapiProtector,
  createProductSecretStore,
  createProtector,
  createSecretStore,
  fileBackend,
  memoryBackend,
  nullProtector,
} from './store.mjs'
