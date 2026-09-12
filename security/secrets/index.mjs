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

// 文件访问控制（PRT-509「跨账户与 ACL 加固」）。
//
// DPAPI 保护的是**内容**，不是**文件**：另一个账户仍可复制它、看到里面
// 有哪些引用名（`refs` 的 key 是明文的，能画出"这台机器配了哪些供应商"）。
// 所以文件本身必须只有所有者可读。
//
// `UNVERIFIABLE` 与 `OK` **必须分开**——"查不出来"绝不能被当成"是安全的"，
// 一条这样的检查比没有检查更坏（它会让人相信一件没被验证过的事）。
export {
  ACL_CODES,
  POSIX_OWNER_ONLY_BITS,
  WINDOWS_ALLOWED_PRINCIPALS,
  accessLettersOf,
  evaluateWindowsPrincipals,
  hardenFileAcl,
  inspectFileAcl,
  parseIcacls,
} from './acl.mjs'
