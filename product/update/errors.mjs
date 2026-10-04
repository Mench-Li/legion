// product/update/errors.mjs
// ============================================================================
// 错误码 → 用户能读的一句话
//
// 设计 §6 line 134 把错误分成两类，这个划分决定了本模块的形态：
//
//   「自动检查失败只留脱敏日志；用户手动检查显示错误和重试按钮。」
//
// 于是同一个失败有两种呈现，而**两种呈现用的是同一份理由文本**。区别只在
// "给不给用户看"。所以理由文本必须：
//
//   · **脱敏**：不含凭据、不含完整 URL 里的查询串、不含本机绝对路径。
//     `describeError` 因此只接受错误码与一段**已经被构造为脱敏**的补充说明，
//     它自己不做字符串清洗（清洗会让人以为传进来的东西是安全的）。
//
//   · **可行动**：每一句话都要能回答"那我该做什么"。`update-manifest-expired`
//     说"清单已过期，请稍后重试或联系管理员重新签发"，而不是"EXPIRED"。
//
// ## 为什么错误码单独一份枚举
//
// 因为界面**按码**决定显示哪个按钮。"过期"和"未知密钥"都该显示重试按钮吗？
// 前者是（等发布端续签），后者不该（重试不会让未知密钥变得已知，它更可能
// 意味着这台机器被投毒了）。把这两个混成一个 `update-failed` 的实现，
// 只能给出一个对两种情况都不对的按钮。
// ============================================================================

/** 客户端自己的错误码（协议件的码由各模块导出，这里只收敛用户可见的那些）。 */
export const UPDATE_CODES_CLIENT = Object.freeze({
  NOT_CONFIGURED: 'update-not-configured',
  CHECK_FAILED: 'update-check-failed',
  MANIFEST_DIGEST_MISMATCH: 'update-manifest-digest-mismatch',
  NO_CANDIDATE: 'update-no-candidate',
  NOT_READY: 'update-not-ready',
  IDENTITY_MISMATCH: 'update-identity-mismatch',
  BUSY: 'update-busy',
  NO_DOWNLOAD: 'update-no-download',
  STALE_OPERATION: 'update-stale-operation',
  CANCELLED: 'update-cancelled',
  NOT_WIRED: 'update-install-not-wired',
  INSTALL_FAILED: 'update-install-failed',
  SPACE: 'update-not-enough-space',
  TASKS_RUNNING: 'update-tasks-running',
  /** 目标版本不支持本机的 Windows build（或读不出本机 build）。 */
  UNSUPPORTED_PLATFORM: 'update-unsupported-platform',
})

/** 错误码 → 是否值得让用户点"重试"。 */
export const RETRYABLE_CODES = Object.freeze([
  'net-offline', 'net-timeout', 'net-idle-timeout', 'net-http-status',
  'envelope-expired', 'envelope-clock-skew',
  'update-check-failed', 'update-not-enough-space', 'update-tasks-running',
  'update-no-download', 'update-not-ready',
])

/** 错误码 → 用户可见的一句话。 */
export const ERROR_TEXT = Object.freeze({
  // —— 网络 ——
  'net-offline': '无法连接更新服务器，请检查网络后重试。',
  'net-timeout': '连接更新服务器超时，请稍后重试。',
  'net-idle-timeout': '更新服务器长时间没有响应，请稍后重试。',
  'net-http-status': '更新服务器返回了错误，请稍后重试；若持续出现请联系管理员。',
  'net-too-large': '更新文件的大小与发布清单不符，已停止下载。请联系管理员。',
  'net-too-small': '更新文件没有下载完整，已停止。请重试。',
  'net-digest-mismatch': '更新文件内容校验失败（可能与发布清单不符或下载被改动），已停止。请联系管理员。',
  'net-cancelled': '下载已取消。',
  'net-redirect': '更新服务器把请求指向了别处，出于安全考虑已停止。请联系管理员。',
  'net-write-failed': '无法写入更新缓存目录，请检查磁盘空间与权限。',

  // —— 签名与信任 ——
  'envelope-unknown-key': '更新清单使用了一个本机不认识的签名密钥，已拒绝。请联系管理员。',
  'envelope-key-expired': '更新清单的签名密钥已过期，已拒绝。请联系管理员。',
  'envelope-key-revoked': '更新清单的签名密钥已被吊销，已拒绝。请联系管理员。',
  'envelope-key-not-yet-valid': '更新清单的签名密钥尚未生效，请稍后重试。',
  'envelope-bad-signature': '更新清单的签名校验失败，已拒绝。请联系管理员。',
  'envelope-unsupported-key': '本机无法使用更新清单的签名密钥，已拒绝。请联系管理员。',
  'envelope-expired': '更新清单已过期，正在等待发布方重新签发。请稍后重试。',
  'envelope-clock-skew': '本机时间与更新服务器相差较大，请校正系统时间后重试。',
  'envelope-malformed': '更新清单格式不正确，已拒绝。请联系管理员。',
  'envelope-too-large': '更新清单过大，已拒绝。请联系管理员。',
  'envelope-unknown-format': '更新清单格式不受支持，已拒绝。请联系管理员。',
  'envelope-bad-payload': '更新清单内容不完整，已拒绝。请联系管理员。',

  // —— 通道 ——
  'feed-sequence-regression': '更新服务器返回了比本机记录更旧的清单，已拒绝。这可能意味着更新服务器被改动，请联系管理员。',
  'feed-sequence-conflict': '更新服务器对同一个发布序号给出了不同内容，已拒绝。请联系管理员。',
  'feed-bad-format': '更新通道清单格式不正确，已拒绝。请联系管理员。',
  'feed-bad-field': '更新通道清单字段不合法，已拒绝。请联系管理员。',
  'feed-bad-path': '更新通道清单里的地址不合法，已拒绝。请联系管理员。',
  'feed-no-channel': '更新服务器上还没有本通道的清单。',
  'feed-older-version': '更新通道指向的版本比本机更旧，不提供降级。',
  'feed-same-version': '当前已是最新版本。',

  // —— 发行清单 ——
  'release-bad-format': '发行清单格式不正确，已拒绝。请联系管理员。',
  'release-bad-path': '发行清单里的文件地址不合法，已拒绝。请联系管理员。',
  'release-bad-field': '发行清单字段不合法，已拒绝。请联系管理员。',
  'release-bad-artifact': '发行清单的产物信息不完整，已拒绝。请联系管理员。',
  'release-bad-digest': '发行清单的摘要不合法，已拒绝。请联系管理员。',
  'release-unsupported-platform': '这个更新不支持本机的系统版本或架构。',
  'release-identity-mismatch': '发行清单与通道清单不是同一个发布，已拒绝。请联系管理员。',
  'release-bad-version-window': '发行清单声明的可升级版本范围不合法，已拒绝。请联系管理员。',
  'release-bad-migration-plan': '发行清单的迁移计划摘要不合法，已拒绝。请联系管理员。',

  // —— 客户端 ——
  'update-not-configured': '本机尚未配置更新地址，检查更新不可用。',
  'update-check-failed': '检查更新失败，请重试。',
  'update-manifest-digest-mismatch': '发行清单与通道清单声明的摘要不一致，已拒绝。请联系管理员。',
  'update-no-candidate': '还没有可用的更新候选，请先检查更新。',
  'update-not-ready': '更新包还没有下载完成。',
  'update-identity-mismatch': '发布方变更了候选版本。为避免安装到未经你确认的版本，本次操作已取消，请重新检查更新。',
  'update-busy': '已有一个下载或安装在进行中，请等待它结束。',
  'update-no-download': '当前没有进行中的下载。',
  'update-stale-operation': '这个下载操作已经结束了。',
  'update-cancelled': '操作已取消。',
  'update-install-not-wired': '安装功能尚未接线。',
  'update-install-failed': '安装更新失败，当前版本仍可继续使用。',
  'update-not-enough-space': '磁盘空间不足，无法安装这个更新。请清理空间后重试。',
  'update-tasks-running': '还有任务正在运行，暂时不能安装更新。',
  'json-too-large': '更新清单过大，已拒绝。',
  'json-duplicate-key': '更新清单格式不正确（重复字段），已拒绝。请联系管理员。',
  'json-malformed': '更新清单格式不正确，已拒绝。请联系管理员。',
  'json-bad-number': '更新清单里含不可表示的数字，已拒绝。请联系管理员。',
  'json-too-deep': '更新清单嵌套过深，已拒绝。请联系管理员。',
  'json-trailing-content': '更新清单尾部有多余内容，已拒绝。请联系管理员。',
  'json-unpaired-surrogate': '更新清单含非法字符，已拒绝。请联系管理员。',
  'json-not-serializable': '更新清单含无法序列化的内容，已拒绝。',
  'host-insecure-origin': '更新地址不是 HTTPS，出于安全考虑已拒绝。请联系管理员。',
  'host-cross-origin': '更新请求被指向了另一个站点，出于安全考虑已拒绝。请联系管理员。',
  'host-bad-cache': '更新服务器的缓存策略不符合要求，可能与发布配置不符。请联系管理员。',
  'host-bad-status': '更新服务器返回了错误状态，请稍后重试。',
  'host-bad-origin': '更新地址配置不正确。请联系管理员。',
})

/**
 * 把错误码渲染成一句用户可读的话。
 *
 * @param {string} code
 * @param {string|null} detail  脱敏后的补充说明；调用方负责"脱敏"这件事。
 */
export function describeError(code, detail = null) {
  const base = ERROR_TEXT[code] ?? '更新过程中出现未知问题，请稍后重试或联系管理员。'
  // 补充说明是可选的，而且**追加**而不是替换：替换会让一句"网络不可达"
  // 变成一句底层错误原文，而后者对用户没有意义、对排查又不完整。
  if (typeof detail !== 'string' || detail.trim() === '') return base
  return `${base}（${detail.trim()}）`
}

export function isRetryable(code) {
  return RETRYABLE_CODES.includes(code)
}

/** 脱敏：日志与界面共用的最小清洗（只处理 URL 与路径这两类）。 */
export function redact(text) {
  if (typeof text !== 'string') return ''
  return text
    // 查询串可能与凭据有关，整段去掉。
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s]*/g, '$1?<redacted>')
    // Windows 与 POSIX 的绝对路径：只留最后一段。
    .replace(/([A-Za-z]:\\[^\s]*\\)([^\s\\]+)/g, '…\\$2')
    .replace(/(\/(?:[^\s/]+\/)+)([^\s/]+)/g, '…/$2')
    .slice(0, 512)
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

export function selfCheckErrors() {
  const problems = []
  // 每个重试码都要有文案；每个文案都要能被 describeError 取到。
  for (const code of RETRYABLE_CODES) {
    if (typeof ERROR_TEXT[code] !== 'string') problems.push(`可重试码 ${code} 没有文案`)
  }
  const unknown = describeError('not-a-real-code')
  if (typeof unknown !== 'string' || unknown === '') problems.push('未知错误码没有兜底文案')
  const withDetail = describeError('net-offline', '连接被拒绝')
  if (!withDetail.includes('连接被拒绝')) problems.push('补充说明没有被带出去')
  // ★ 文案里不能出现"跳过验签""忽略证书"这类会让人降低防护的措辞。
  for (const [code, text] of Object.entries(ERROR_TEXT)) {
    if (/忽略|跳过|关闭(验证|校验)/.test(text)) problems.push(`文案 ${code} 建议了降低防护的做法`)
  }
  // 脱敏：查询串与绝对路径都要被处理。
  if (redact('https://h.example/a/b.json?token=secret').includes('secret')) problems.push('脱敏没有去掉查询串')
  if (redact('C:\\Users\\someone\\AppData\\Local\\legion\\x.json').includes('someone')) problems.push('脱敏没有去掉路径中的用户名')
  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    textCount: Object.keys(ERROR_TEXT).length,
    retryableCount: RETRYABLE_CODES.length,
  })
}

export const ERRORS_CHECKED = selfCheckErrors()
