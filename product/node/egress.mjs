// product/node/egress.mjs
// ============================================================================
// 出境策略（远程 Agent 通道 S-E 之一）
//
// 用户已确认的边界：**只传结构化进展与摘要**，不上传完整源码、环境变量、
// 凭据和完整终端日志。
//
// ## 为什么这层必须住在 Node 侧，而不是"服务端收到后再脱敏"
//
// `team-hub/agent-conversations.mjs` 确实在入库前调 `redactValue`，但那是
// **服务端**的兜底。服务端收到的东西已经出过电脑了：跨境、过网线、进日志、
// 进备份。此后再脱敏保护不了传输前的内容，也保护不了"服务端配置错了"那一天。
//
// 所以这一层是**第一道**，服务端那道是第二道。两道做同一件事不是重复：
// 第一道决定"什么允许离开"，第二道决定"什么不允许入库"。
//
// ## 两个手段，强度不同
//
// 1. **结构白名单**（强）：只让明确列出的字段通过。这比"过滤黑名单"可靠得多
//    ——黑名单要枚举所有危险形态，漏一个就漏一个；白名单只需要枚举**我们真正
//    要传的那几个字段**，而它们是有限的、由我们自己定义的。
//    所以即使调用方手滑把整个 `task` 对象交给了 `projectProgress`，多出来的
//    字段也进不去。
// 2. **内容过滤**（弱，但是必要的兜底）：字段名对不代表字段值安全——
//    `summary` 里完全可能被人贴进一段带私钥的日志。
//
// 承认第 2 条是"弱"的很重要：它是启发式的，不可能证明安全。
// 把它写成"已经安全了"会让第一道白名单松懈，而第一道才是真正承重的那道。
// ============================================================================
import { redactValue } from '../../runtime/adapters/dsh/redact.mjs'

export const EGRESS_LIMITS = Object.freeze({
  /** 一条进展摘要的上限。比协议上限（4000）更紧：这是产品策略，不是协议约束。 */
  summaryChars: 1200,
  /** `detail` 这类补充信息的上限。 */
  detailChars: 400,
  /** 产物条数上限。 */
  artifacts: 20,
  /** 单个产物的路径长度上限。 */
  artifactPathChars: 300,
  /** 一段文本里允许的最大行数；超过按"终端日志"处置。 */
  textLines: 40,
  /** 一段文本里允许的 `KEY=VALUE` 形态上限；超过按"环境变量转储"处置。 */
  envAssignments: 3,
})

export const EGRESS_CODES = Object.freeze({
  TRUNCATED: 'EGRESS_TRUNCATED',
  REDACTED: 'EGRESS_REDACTED',
  ENV_DUMP: 'EGRESS_ENV_DUMP_SUSPECTED',
  LOG_DUMP: 'EGRESS_LOG_DUMP_SUSPECTED',
  BLOB: 'EGRESS_BINARY_BLOB_SUSPECTED',
  DROPPED_FIELD: 'EGRESS_FIELD_NOT_ALLOWED',
})

/** 结构白名单：每个出境帧允许携带的字段。**这是本模块最强的保证。** */
export const EGRESS_FIELDS = Object.freeze({
  progress: Object.freeze(['kind', 'summary', 'detail']),
  terminal: Object.freeze(['outcome', 'summary', 'artifacts']),
  failure: Object.freeze(['failureCode', 'detail']),
  ledger: Object.freeze(['taskId', 'attemptId', 'leaseEpoch', 'state', 'atMs']),
})

/** 私钥块。这类内容出现即整段丢弃，不做局部替换——半段私钥与整段一样不能用。 */
const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/
/**
 * 疑似 base64/二进制大块：连续的 base64 字符。
 *
 * ★ 只按"连续 200 个 base64 字符"判定是**不够**的：`'x'.repeat(2000)` 也满足，
 * 而一段全是同一个字符的文本更像"被截断的占位符"或"一条长 ID"，不像二进制。
 * 把长标识符或长哈希当成二进制丢掉，会让正常的排障信息莫名其妙地消失。
 * 所以额外要求字符类别**混合**（至少两类）——真实的 base64 必然大小写数字混用。
 */
const BLOB_RUN_RE = /[A-Za-z0-9+/]{200,}={0,2}/

function looksLikeBlob(text) {
  const m = BLOB_RUN_RE.exec(text)
  if (m === null) return false
  const kinds = new Set()
  for (const ch of m[0]) {
    if (ch >= 'a' && ch <= 'z') kinds.add('l')
    else if (ch >= 'A' && ch <= 'Z') kinds.add('u')
    else if (ch >= '0' && ch <= '9') kinds.add('d')
    else kinds.add('s')
  }
  return kinds.size >= 2
}
/** `KEY=VALUE` 形态，用于识别环境变量转储。 */
const ENV_ASSIGN_RE = /(^|\s)([A-Z][A-Z0-9_]{2,})=(\S+)/g

/**
 * 单段文本的体检。
 *
 * 返回 `{ ok, notices, text }`：`ok:false` 表示**整段不该出境**（调用方应换成
 * 一条说明，而不是发一段被剪切的东西——剪切后的私钥块前半段仍然是私钥）。
 */
export function inspectText(raw, { limits = EGRESS_LIMITS, field = 'text' } = {}) {
  const notices = []
  if (typeof raw !== 'string') return { ok: true, notices, text: '' }
  let text = raw

  if (PRIVATE_KEY_RE.test(text)) {
    return { ok: false, notices: [{ code: EGRESS_CODES.REDACTED, field, reason: '文本包含私钥块，整段未出境' }], text: '[已拦下：包含私钥块]' }
  }
  const envHits = text.match(ENV_ASSIGN_RE) ?? []
  if (envHits.length > limits.envAssignments) {
    // 3 条以上 `KEY=VALUE` 更像一段 `env` 输出，而不是"提到一个变量名"。
    return { ok: false, notices: [{ code: EGRESS_CODES.ENV_DUMP, field, reason: `文本含 ${envHits.length} 处 KEY=VALUE，疑似环境变量转储` }], text: '[已拦下：疑似环境变量转储]' }
  }
  if (looksLikeBlob(text)) {
    return { ok: false, notices: [{ code: EGRESS_CODES.BLOB, field, reason: '文本含疑似二进制/base64 大块' }], text: '[已拦下：疑似二进制内容]' }
  }
  const lines = text.split('\n')
  if (lines.length > limits.textLines) {
    // 长文本按"终端日志"处置：只留头尾。保留头尾而不是只留头部，是因为
    // **错误通常出现在末尾**，而只留头部会让"它怎么失败的"永远看不到。
    const head = lines.slice(0, Math.floor(limits.textLines / 2))
    const tail = lines.slice(-Math.floor(limits.textLines / 2))
    text = [...head, `…[省略 ${lines.length - limits.textLines} 行]…`, ...tail].join('\n')
    notices.push({ code: EGRESS_CODES.LOG_DUMP, field, reason: `文本 ${lines.length} 行，已收敛为头尾各 ${Math.floor(limits.textLines / 2)} 行` })
  }
  if (text.length > limits.summaryChars) {
    text = `${text.slice(0, limits.summaryChars)}…[截断，原 ${text.length} 字符]`
    notices.push({ code: EGRESS_CODES.TRUNCATED, field, reason: `超过 ${limits.summaryChars} 字符` })
  }
  // 最后过一遍既有的密钥模式表（与服务端入库前**同一个来源**，见 redact-patterns.mjs）。
  const { value, redacted } = redactValue({ text })
  if (redacted.length > 0) notices.push({ code: EGRESS_CODES.REDACTED, field, reason: `命中密钥模式：${redacted.length} 处` })
  return { ok: true, notices, text: value.text }
}

/**
 * 按白名单投影一个对象。
 *
 * 不在白名单里的键**被丢掉并如实记账**（`droppedFields`），不静默丢弃：
 * "某个字段没传出去"与"那个字段本来就是空的"在对面看起来一样，
 * 而前者是接线错误，后者是正常状态。
 */
export function projectFields(source, allowed, { field = 'record' } = {}) {
  const out = {}
  const droppedFields = []
  if (source === null || typeof source !== 'object') return { out, droppedFields, notices: [] }
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) { droppedFields.push(key); continue }
    out[key] = source[key]
  }
  const notices = droppedFields.length === 0 ? [] : [{
    code: EGRESS_CODES.DROPPED_FIELD, field,
    reason: `字段不在出境白名单内，未发送：${droppedFields.join(', ')}`,
  }]
  return { out, droppedFields, notices }
}

/** 进展帧的出境投影。 */
export function projectProgress(input, { limits = EGRESS_LIMITS } = {}) {
  const { out, droppedFields, notices: dropNotices } = projectFields(input, EGRESS_FIELDS.progress, { field: 'progress' })
  const notices = [...dropNotices]
  const inspected = inspectText(out.summary, { limits, field: 'summary' })
  notices.push(...inspected.notices)
  if (out.detail !== undefined) {
    const d = inspectText(typeof out.detail === 'string' ? out.detail : JSON.stringify(out.detail), { limits: { ...limits, summaryChars: limits.detailChars }, field: 'detail' })
    notices.push(...d.notices)
    if (d.ok) out.detail = d.text
    else delete out.detail
  }
  // 整段被拦下时 `inspected.text` 已经是一句说明（"已拦下：…"），于是这里
  // **不需要**分支：进展帧照发，但内容换成了一句能读的说明。丢掉整帧会让
  // 手机看到一个没有进展的运行，而"它被拦下了"本身是有用的进展。
  return { value: { ...out, summary: inspected.text }, droppedFields, notices }
}

/** 终态帧的出境投影。产物只传**引用**（路径 + 哈希），不传内容。 */
export function projectTerminal(input, { limits = EGRESS_LIMITS } = {}) {
  const { out, droppedFields, notices: dropNotices } = projectFields(input, EGRESS_FIELDS.terminal, { field: 'terminal' })
  const notices = [...dropNotices]
  if (out.summary !== undefined) {
    const s = inspectText(out.summary, { limits, field: 'summary' })
    notices.push(...s.notices)
    out.summary = s.text
  }
  if (Array.isArray(out.artifacts)) {
    const kept = out.artifacts.slice(0, limits.artifacts).map((a) => {
      if (a === null || typeof a !== 'object') return null
      // 产物**路径**是允许出境的（它正是"引用"本身），但只保留路径/哈希/大小，
      // 内容一律不在这里出现——`content` 这类键根本不在白名单里。
      const item = {}
      if (typeof a.path === 'string') {
        const p = inspectText(a.path, { limits: { ...limits, summaryChars: limits.artifactPathChars, textLines: 1, envAssignments: 999 }, field: 'artifact.path' })
        item.path = p.text
        notices.push(...p.notices)
      }
      if (typeof a.hash === 'string') item.hash = a.hash.slice(0, 128)
      if (Number.isSafeInteger(a.size)) item.size = a.size
      return Object.keys(item).length === 0 ? null : item
    }).filter((x) => x !== null)
    if (out.artifacts.length > limits.artifacts) {
      notices.push({ code: EGRESS_CODES.TRUNCATED, field: 'artifacts', reason: `产物 ${out.artifacts.length} 条，只保留前 ${limits.artifacts} 条` })
    }
    out.artifacts = kept
  }
  return { value: out, droppedFields, notices }
}

/** 失败帧的出境投影。 */
export function projectFailure(input, { limits = EGRESS_LIMITS } = {}) {
  const { out, droppedFields, notices: dropNotices } = projectFields(input, EGRESS_FIELDS.failure, { field: 'failure' })
  const notices = [...dropNotices]
  if (out.detail !== undefined) {
    const d = inspectText(typeof out.detail === 'string' ? out.detail : JSON.stringify(out.detail), { limits: { ...limits, summaryChars: limits.detailChars }, field: 'detail' })
    notices.push(...d.notices)
    if (d.ok) out.detail = d.text
    else delete out.detail
  }
  return { value: out, droppedFields, notices }
}

/**
 * 账本条目的出境投影。
 *
 * 账本只允许出现身份与状态（`taskId`/`attemptId`/`leaseEpoch`/`state`/`atMs`），
 * **不允许**出现摘要或路径：对账要的是"这条尝试我当时做到哪一步"，
 * 不是"我当时做了什么"。把摘要塞进来会让对账变成一个绕过进展策略的旁路。
 */
export function projectLedger(entries, { limits = EGRESS_LIMITS } = {}) {
  const notices = []
  const list = Array.isArray(entries) ? entries : []
  // ★ **先筛后截**，不是先截后筛。先截后筛的后果是：一批里混了 3 条缺身份的
  //   坏行，实际发出去的就会比上限**少 3 条**，而调用方以为发满了。
  const valid = list
    .map((e) => projectFields(e, EGRESS_FIELDS.ledger, { field: 'ledger' }).out)
    .filter((e) => typeof e.attemptId === 'string' && typeof e.taskId === 'string')
  const value = valid.slice(0, Math.min(valid.length, 500))
  if (valid.length > value.length) {
    notices.push({ code: EGRESS_CODES.TRUNCATED, field: 'ledger', reason: `账本 ${valid.length} 条，只发前 ${value.length} 条` })
  }
  if (list.length > valid.length) {
    notices.push({ code: EGRESS_CODES.DROPPED_FIELD, field: 'ledger', reason: `账本 ${list.length - valid.length} 条缺身份，未发送` })
  }
  return { value, notices }
}

/** 把一串 notice 压成一行可读的诊断（写本地日志用，**不**出境）。 */
export function describeNotices(notices) {
  if (!Array.isArray(notices) || notices.length === 0) return ''
  const byCode = new Map()
  for (const n of notices) byCode.set(n.code, (byCode.get(n.code) ?? 0) + 1)
  return [...byCode.entries()].map(([code, n]) => `${code}×${n}`).join(', ')
}
