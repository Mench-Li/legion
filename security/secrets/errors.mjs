// security/secrets/errors.mjs
// ============================================================================
// 密钥库错误码（PRT-505）
//
// spec §6.7 明确要求把两类失败**分开**：
//   - `SECRET_UNAVAILABLE`：本地凭证库或账户问题（取不到明文）；
//   - `AUTH_FAILED`：供应商拒绝一个**已经成功解析**的凭证。
// 把后者报成前者会让人去查本机密钥库，方向完全错；反之会让人去轮换一个
// 根本没被读到的密钥。这里只负责前者的细分，`AUTH_FAILED` 属 Runtime 适配层。
//
// 内部码比契约码更细（例如「平台不支持」与「文件损坏」都是 `SECRET_UNAVAILABLE`），
// 细分是为了给出可操作的修复指引；对外一律通过 `toRuntimeErrorCode` 收敛。
// ============================================================================

/** 内部码 → Runtime Contract 的标准码（spec §6.1）。 */
export const RUNTIME_CODE_FOR = Object.freeze({
  SECRET_REF_INVALID: 'SECRET_UNAVAILABLE',
  SECRET_VALUE_EMPTY: 'SECRET_UNAVAILABLE',
  SECRET_NOT_FOUND: 'SECRET_UNAVAILABLE',
  SECRET_STORE_UNREADABLE: 'SECRET_UNAVAILABLE',
  SECRET_STORE_UNSUPPORTED_PLATFORM: 'SECRET_UNAVAILABLE',
  SECRET_STORE_UNPROTECTED: 'SECRET_UNAVAILABLE',
  SECRET_STORE_WRITE_FAILED: 'SECRET_UNAVAILABLE',
  SECRET_DECRYPT_FAILED: 'SECRET_UNAVAILABLE',
  SECRET_STORE_CORRUPT: 'SECRET_UNAVAILABLE',
})

/** 每个内部码对应的**用户可操作**文案。 */
export const SECRET_ERROR_HINTS = Object.freeze({
  SECRET_REF_INVALID: '把 secretRef 改成合法引用名（字母数字开头，不含空段或 ".."）。',
  SECRET_VALUE_EMPTY: '密钥值不能为空；如需清除请使用 delete。',
  SECRET_NOT_FOUND: '该 secretRef 在本机密钥库中不存在：重新添加密钥，或把档案指向已有的引用。',
  SECRET_STORE_UNREADABLE: '本机密钥库文件存在但读不出来：检查文件权限与磁盘；必要时从备份恢复。',
  SECRET_STORE_UNSUPPORTED_PLATFORM: '当前平台的受保护密钥库尚未实现：不要退化为明文存储，请改用受支持的系统或等待该平台的支持。',
  SECRET_STORE_UNPROTECTED: '密钥库后端未提供受保护存储（当前为明文后端）：不得用于真实密钥。',
  SECRET_STORE_WRITE_FAILED: '写入密钥库失败：检查磁盘空间与目录权限。',
  SECRET_DECRYPT_FAILED: '密钥无法解密：常见原因是换了 Windows 账户或用另一台机器复制了密钥库文件。请用当前账户重新录入密钥。',
  SECRET_STORE_CORRUPT: '密钥库文件结构损坏：从备份恢复，或清空后重新录入（已录入的密钥无法找回）。',
})

/**
 * 密钥库错误。
 *
 * 刻意**不接受**任意 detail 字符串：调用方很容易顺手把密钥值或密文塞进错误里，
 * 而错误对象会进日志、异常上报与诊断包。这里只允许白名单字段。
 */
export class SecretStoreError extends Error {
  /**
   * @param {string} code 内部码
   * @param {{ref?: string, platform?: string, cause?: string}} [context] 白名单上下文（不得含密钥值或密文）
   */
  constructor(code, context = {}) {
    const hint = SECRET_ERROR_HINTS[code] ?? '未知的密钥库错误。'
    const ref = typeof context.ref === 'string' ? context.ref : null
    const where = ref === null ? '' : `（ref=${ref}）`
    const cause = context.cause === undefined || context.cause === null ? '' : `；原因：${redactCause(context.cause)}`
    super(`${code}${where}：${hint}${cause}`)
    this.name = 'SecretStoreError'
    this.code = code
    this.ref = ref
    /** @type {string} */
    this.runtimeCode = RUNTIME_CODE_FOR[code] ?? 'SECRET_UNAVAILABLE'
  }

  /** 对外（Runtime Contract）使用的标准码。 */
  get runtimeErrorCode() {
    return this.runtimeCode
  }
}

/**
 * 收敛底层 cause 文本：只保留**结构**信息（命令名、退出码、异常类型），
 * 不保留 stdout/stderr 正文——PowerShell 的输出里可能出现被保护的值。
 */
function redactCause(cause) {
  const text = typeof cause === 'string' ? cause : String(cause)
  // 只留「像是什么错」的部分：去掉一切含十六进制长串/疑似密钥的片段
  const cleaned = text
    .replace(/[0-9a-fA-F]{32,}/g, '<redacted>')
    .replace(/(sk-|ghp_|gho_|github_pat_|xox[baprs]-|AKIA|AIza)[A-Za-z0-9_-]{8,}/g, '<redacted>')
  return cleaned.length > 200 ? `${cleaned.slice(0, 200)}…` : cleaned
}

export function isSecretStoreError(value) {
  return value instanceof SecretStoreError || (value !== null && typeof value === 'object' && typeof value.code === 'string' && typeof value.runtimeCode === 'string')
}
