// product/update/envelope.mjs
// ============================================================================
// 签名 envelope —— 自动更新设计 §5 的信任根
//
// 托管只有"公开可读"这一个要求（设计 §4）。这句话的另一面是：
// **任何能改托管内容的人都能改清单**。所以"清单是可信的"不能来自 HTTPS、
// 不能来自难以猜中的路径，只能来自一个客户端内置公钥验证过的签名。
//
// ## 签的到底是什么字节
//
// 设计 §5（line 108）规定签名覆盖：
//
//     "legion-update-envelope@1\n" + canonicalJson(payload)    的 UTF-8 字节
//
// 前缀不是装饰。没有它，一个"签名就是 Ed25519(payload)"的协议会让同一份
// payload 的签名在**所有**用途之间通用——一份发行清单的签名可以被拿去当
// 通道清单的签名用，因为验签方看不出区别。前缀把"这是哪种用途"钉进被签的
// 字节里。
//
// ## 为什么签名覆盖规范化结果而不是原文
//
// 原文的字节由发布端决定：多一个空格、换一个键序，就是另一串字节。
// 让签名覆盖 `canonicalJson(payload)` 之后，"同一份 payload"只有一种字节，
// 发布端用什么格式化工具都不影响验签，而**任何语义改动**都会改变结果。
//
// 代价是：验签方必须自己把 canonicalJson 算对，且必须对"重复键"有一个
// 明确立场（见 canonical.mjs 的注释）——本模块的立场是拒绝。
//
// ## 一条容易被忽略的纪律：未知 keyId 也要拒
//
// "找不到公钥就跳过验签"是最省事的实现，而它把"未知密钥"变成了
// "无需签名"。所以 `selectKey` 返回 null 时，本模块的结论是
// `envelope-unknown-key`，而不是 `unsigned`。
// ============================================================================

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto'

import {
  CANONICAL_CODES, DEFAULT_MAX_JSON_BYTES, canonicalBytes, canonicalJson, parseJsonStrict, sha256Hex,
} from './canonical.mjs'

/** 被签字节的固定前缀。用途分离就在这里。 */
export const ENVELOPE_PREFIX = 'legion-update-envelope@1\n'

/** 现有产品版本清单之外的**新增**发行格式（设计 §5）。 */
export const ENVELOPE_FORMATS = Object.freeze({
  FEED: 'legion/update-feed@1',
  RELEASE: 'legion/update-release@1',
  /** 公钥轮换：由旧信任根签名的信任表增量。 */
  TRUST: 'legion/update-trust@1',
})

export const SIGNATURE_ALGORITHM = 'ed25519'

/** Ed25519 签名固定 64 字节；Base64 之后固定 88 字符。 */
export const ED25519_SIGNATURE_BYTES = 64

export const ENVELOPE_CODES = Object.freeze({
  TOO_LARGE: 'envelope-too-large',
  MALFORMED: 'envelope-malformed',
  UNKNOWN_FORMAT: 'envelope-unknown-format',
  UNKNOWN_KEY: 'envelope-unknown-key',
  KEY_EXPIRED: 'envelope-key-expired',
  KEY_REVOKED: 'envelope-key-revoked',
  KEY_NOT_YET_VALID: 'envelope-key-not-yet-valid',
  BAD_SIGNATURE: 'envelope-bad-signature',
  UNSUPPORTED_KEY: 'envelope-unsupported-key',
  EXPIRED: 'envelope-expired',
  NOT_YET_VALID: 'envelope-not-yet-valid',
  BAD_PAYLOAD: 'envelope-bad-payload',
  BAD_CLOCK: 'envelope-clock-skew',
})

export const ENVELOPE_VERDICTS = Object.freeze(['verified', 'rejected'])

const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/

function envelopeError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

// ---------------------------------------------------------------------------
// 密钥与信任表
// ---------------------------------------------------------------------------

/** 生成一对 Ed25519 密钥。发布端脚本用它，客户端**从不**调用它。 */
export function generateReleaseKeyPair({ keyId = null, comment = null } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync(SIGNATURE_ALGORITHM)
  return Object.freeze({
    keyId,
    comment,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  })
}

/** 从 PEM 推出稳定的密钥指纹，用来在离线核对时确认"是不是同一把钥匙"。 */
export function keyFingerprint(publicKeyPem) {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })
  return sha256Hex(der)
}

function normalizeKeyEntry(entry) {
  const entryKeyId = entry?.keyId
  if (typeof entryKeyId !== 'string' || !KEY_ID_RE.test(entryKeyId)) return null
  if (typeof entry.publicKeyPem !== 'string' || !entry.publicKeyPem.includes('PUBLIC KEY')) return null
  let fingerprint
  try { fingerprint = keyFingerprint(entry.publicKeyPem) } catch { return null }
  return Object.freeze({
    keyId: entryKeyId,
    publicKeyPem: entry.publicKeyPem,
    fingerprint,
    algorithm: SIGNATURE_ALGORITHM,
    // 设计 §5：换密钥要先下发预置新公钥，再切换发布签名。因此每个密钥都
    // 有生效窗口，窗口之外**不参与验签**——而不是"没写就永远有效"。
    notBeforeMs: Number.isFinite(entry.notBeforeMs) ? entry.notBeforeMs : null,
    notAfterMs: Number.isFinite(entry.notAfterMs) ? entry.notAfterMs : null,
    revokedAtMs: Number.isFinite(entry.revokedAtMs) ? entry.revokedAtMs : null,
    comment: typeof entry.comment === 'string' ? entry.comment : null,
  })
}

/**
 * 建立信任表。
 *
 * 传入的每一把钥匙都要能真的导出 SPKI 指纹；不能的**直接丢掉并记问题**，
 * 而不是带着 null 指纹进表——"指纹算不出来"和"指纹不匹配"是两件事，
 * 而前者会在某次真实验签里被当成后者。
 */
export function createTrustStore(entries = []) {
  const keys = new Map()
  const problems = []
  for (const raw of entries) {
    const entry = normalizeKeyEntry(raw)
    if (entry === null) { problems.push(`信任表条目不可用：${JSON.stringify(raw?.keyId ?? raw)}`); continue }
    if (keys.has(entry.keyId)) { problems.push(`信任表里 keyId 重复：${entry.keyId}`); continue }
    keys.set(entry.keyId, entry)
  }
  return Object.freeze({
    keys,
    problems: Object.freeze(problems),
    keyIds: Object.freeze([...keys.keys()].sort()),
    get size() { return keys.size },
  })
}

/**
 * 选公钥。**返回 null 一律是拒绝**，不是"跳过验签"。
 *
 * 时钟窗口检查放在这里而不是调用方：一次"密钥已过期但仍然验过"的更新
 * 与一次"签名根本没验"的更新，在结果上没有区别。
 */
export function selectKey(trust, keyId, { nowMs = Date.now(), maxClockSkewMs = 0 } = {}) {
  if (trust === null || typeof trust !== 'object' || !(trust.keys instanceof Map)) {
    return Object.freeze({ ok: false, code: ENVELOPE_CODES.UNKNOWN_KEY, reason: '信任表不可用' })
  }
  const entry = trust.keys.get(keyId)
  if (entry === undefined) {
    return Object.freeze({ ok: false, code: ENVELOPE_CODES.UNKNOWN_KEY, reason: `keyId ${JSON.stringify(keyId)} 不在信任表里` })
  }
  if (entry.revokedAtMs !== null && nowMs >= entry.revokedAtMs) {
    return Object.freeze({ ok: false, code: ENVELOPE_CODES.KEY_REVOKED, reason: `密钥 ${keyId} 已于 ${new Date(entry.revokedAtMs).toISOString()} 吊销` })
  }
  if (entry.notBeforeMs !== null && nowMs + maxClockSkewMs < entry.notBeforeMs) {
    return Object.freeze({ ok: false, code: ENVELOPE_CODES.KEY_NOT_YET_VALID, reason: `密钥 ${keyId} 尚未生效` })
  }
  if (entry.notAfterMs !== null && nowMs - maxClockSkewMs >= entry.notAfterMs) {
    return Object.freeze({ ok: false, code: ENVELOPE_CODES.KEY_EXPIRED, reason: `密钥 ${keyId} 已过期` })
  }
  return Object.freeze({ ok: true, code: null, reason: null, entry })
}

/** 被签字节：固定前缀 + 规范化 payload。签名与验签**只**走这一条路。 */
export function signedBytes(payload) {
  const body = Buffer.from(canonicalJson(payload), 'utf8')
  return Buffer.concat([Buffer.from(ENVELOPE_PREFIX, 'utf8'), body])
}

// ---------------------------------------------------------------------------
// 签名与序列化
// ---------------------------------------------------------------------------

/**
 * 给 payload 打一个签名 envelope。
 *
 * 返回的是**对象**，不是文本：发布端要先把它写进发布目录、再回读核对
 * （设计 §9 第 3 步）。序列化交给 `serializeEnvelope`，两边共用一份实现，
 * 免得"写出去的字节"和"回读校验的字节"是两条代码路径。
 */
export function signEnvelope(payload, { privateKeyPem, keyId } = {}) {
  if (typeof privateKeyPem !== 'string' || privateKeyPem === '') {
    throw envelopeError(ENVELOPE_CODES.BAD_PAYLOAD, 'signEnvelope 需要 privateKeyPem')
  }
  if (typeof keyId !== 'string' || !KEY_ID_RE.test(keyId)) {
    throw envelopeError(ENVELOPE_CODES.BAD_PAYLOAD, `signEnvelope 的 keyId 不合法：${JSON.stringify(keyId)}`)
  }
  const bytes = signedBytes(payload)
  let signature
  try {
    signature = edSign(null, bytes, createPrivateKey(privateKeyPem)).toString('base64')
  } catch (e) {
    throw envelopeError(ENVELOPE_CODES.UNSUPPORTED_KEY, `无法用该私钥签名：${e.message}`)
  }
  return Object.freeze({ payload, keyId, signature })
}

/** envelope 的落盘字节。**唯一**允许的写法：规范化 + 结尾换行。 */
export function serializeEnvelope(envelope) {
  return `${canonicalJson({
    payload: envelope.payload, keyId: envelope.keyId, signature: envelope.signature,
  })}\n`
}

/**
 * 验签。
 *
 * 输入是**字节或文本**（不是已经解析好的对象）：解析必须走严格扫描器，
 * 否则"重复键"这条判据在调用方那里就已经丢了。
 */
export function verifyEnvelope(input, {
  trust,
  nowMs = Date.now(),
  maxBytes = DEFAULT_MAX_JSON_BYTES,
  expectedFormat = null,
  maxClockSkewMs = 0,
  requireExpiry = true,
} = {}) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8')
  if (bytes.length > maxBytes) {
    return reject(ENVELOPE_CODES.TOO_LARGE, `envelope ${bytes.length} 字节，超过上限 ${maxBytes}`)
  }
  let parsed
  try {
    parsed = parseJsonStrict(bytes, { maxBytes })
  } catch (e) {
    // 规范化层能给出的拒绝理由原样带出去：`json-duplicate-key` 与
    // `json-malformed` 对排查的人来说是两件完全不同的事。
    return reject(e.code === CANONICAL_CODES.TOO_LARGE ? ENVELOPE_CODES.TOO_LARGE : ENVELOPE_CODES.MALFORMED,
      `envelope 不是严格 JSON：${e.message}`, { cause: e.code })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return reject(ENVELOPE_CODES.MALFORMED, 'envelope 必须是对象')
  }
  // ★ 只认这三个键。多一个键就是"发布端与客户端对同一份文件的读法不同"，
  //   而签名只覆盖 payload，多出来的键**不受签名保护**。
  const keys = Object.keys(parsed).sort()
  if (keys.length !== 3 || keys.join(',') !== 'keyId,payload,signature') {
    return reject(ENVELOPE_CODES.MALFORMED, `envelope 顶层键必须是 keyId/payload/signature，实际是 ${keys.join(',')}`)
  }
  if (typeof parsed.keyId !== 'string' || !KEY_ID_RE.test(parsed.keyId)) {
    return reject(ENVELOPE_CODES.MALFORMED, 'envelope.keyId 不合法')
  }
  if (typeof parsed.signature !== 'string' || !BASE64_RE.test(parsed.signature)) {
    return reject(ENVELOPE_CODES.MALFORMED, 'envelope.signature 不是 Base64')
  }
  const signature = Buffer.from(parsed.signature, 'base64')
  if (signature.length !== ED25519_SIGNATURE_BYTES) {
    return reject(ENVELOPE_CODES.MALFORMED, `签名长度 ${signature.length}，Ed25519 必须是 ${ED25519_SIGNATURE_BYTES}`)
  }
  if (parsed.payload === null || typeof parsed.payload !== 'object' || Array.isArray(parsed.payload)) {
    return reject(ENVELOPE_CODES.BAD_PAYLOAD, 'envelope.payload 必须是对象')
  }

  const format = parsed.payload.format
  if (typeof format !== 'string' || !Object.values(ENVELOPE_FORMATS).includes(format)) {
    return reject(ENVELOPE_CODES.UNKNOWN_FORMAT, `未知的 payload format：${JSON.stringify(format)}`)
  }
  if (expectedFormat !== null && format !== expectedFormat) {
    return reject(ENVELOPE_CODES.UNKNOWN_FORMAT, `期望 ${expectedFormat}，实际是 ${format}`)
  }

  const selected = selectKey(trust, parsed.keyId, { nowMs, maxClockSkewMs })
  if (!selected.ok) return reject(selected.code, selected.reason)

  let ok = false
  try {
    ok = edVerify(null, signedBytes(parsed.payload), createPublicKey(selected.entry.publicKeyPem), signature)
  } catch (e) {
    return reject(ENVELOPE_CODES.UNSUPPORTED_KEY, `无法用 keyId ${parsed.keyId} 验签：${e.message}`)
  }
  if (ok !== true) {
    return reject(ENVELOPE_CODES.BAD_SIGNATURE, `签名与 keyId ${parsed.keyId} 的公钥不匹配`)
  }

  const window = checkValidityWindow(parsed.payload, { nowMs, maxClockSkewMs, requireExpiry })
  if (!window.ok) return reject(window.code, window.reason)

  return Object.freeze({
    ok: true, verdict: 'verified', code: null, reason: null,
    payload: parsed.payload, keyId: parsed.keyId, format,
    keyFingerprint: selected.entry.fingerprint,
    bytes: bytes.length,
  })
}

function reject(code, reason, extra = {}) {
  return Object.freeze({ ok: false, verdict: 'rejected', code, reason, payload: null, ...extra })
}

/**
 * 有效期判定（设计 §5 line 126）：
 * 「过期清单不授权新的下载或安装；时钟明显异常时提示校正时间。」
 *
 * 时钟异常与"过期"必须分开报：前者要提示用户校正时间，后者要重新签发。
 */
export function checkValidityWindow(payload, { nowMs, maxClockSkewMs = 0, requireExpiry = true } = {}) {
  const issuedAtMs = parseIsoMs(payload?.issuedAt)
  const expiresAtMs = parseIsoMs(payload?.expiresAt)
  if (issuedAtMs === null || (requireExpiry && expiresAtMs === null)) {
    return { ok: false, code: ENVELOPE_CODES.BAD_PAYLOAD, reason: 'payload 缺少合法的 issuedAt/expiresAt' }
  }
  // 明显异常：签发时间比现在晚了一大截。允许一点时钟漂移，但不允许
  // "一份两小时后才会签发的清单"参与更新。
  if (issuedAtMs > nowMs + Math.max(maxClockSkewMs, 15 * 60_000)) {
    return {
      ok: false, code: ENVELOPE_CODES.BAD_CLOCK,
      reason: `清单签发时间 ${payload.issuedAt} 晚于本机时间，请校正系统时间`,
    }
  }
  if (expiresAtMs !== null && nowMs - maxClockSkewMs >= expiresAtMs) {
    return { ok: false, code: ENVELOPE_CODES.EXPIRED, reason: `清单已于 ${payload.expiresAt} 过期` }
  }
  if (expiresAtMs !== null && expiresAtMs <= issuedAtMs) {
    return { ok: false, code: ENVELOPE_CODES.BAD_PAYLOAD, reason: 'expiresAt 不晚于 issuedAt' }
  }
  return { ok: true, code: null, reason: null, issuedAtMs, expiresAtMs }
}

/** 只接受 `Z` 结尾的 ISO 时间：本地时区偏移会让同一份清单在不同机器上过期点不同。 */
export function parseIsoMs(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

// ---------------------------------------------------------------------------
// 公钥轮换（设计 §5 line 128）
// ---------------------------------------------------------------------------

/**
 * 用**现有**信任根签一份信任表增量。
 *
 * 设计 §5 的顺序是硬的：「先通过旧信任根签名的客户端更新预置新公钥，
 * 再切换发布签名」。也就是说新公钥在下发的那一刻**还签发不了它自己**，
 * 必须由旧钥匙担保。
 */
export function signTrustUpdate({
  privateKeyPem, keyId, sequence, issuedAt, expiresAt,
  add = [], revoke = [],
} = {}) {
  return signEnvelope({
    format: ENVELOPE_FORMATS.TRUST,
    sequence,
    issuedAt,
    expiresAt,
    add,
    revoke,
  }, { privateKeyPem, keyId })
}

/**
 * 应用一份信任表增量。
 *
 * 除验签本身之外还有两条必须成立的约束：
 *   · `sequence` 必须**严格递增**（否则可以把信任表回退到吊销之前）；
 *   · 被吊销的 keyId 必须真的在表里（一条"吊销了不存在的钥匙"的记录
 *     多半意味着发布端搞错了对象，静默接受它等于把错误吞掉）。
 */
export function applyTrustUpdate(trust, updateBytes, {
  nowMs = Date.now(), maxBytes = DEFAULT_MAX_JSON_BYTES, lastSequence = 0, maxClockSkewMs = 0,
} = {}) {
  const verified = verifyEnvelope(updateBytes, {
    trust, nowMs, maxBytes, expectedFormat: ENVELOPE_FORMATS.TRUST, maxClockSkewMs,
  })
  if (!verified.ok) return Object.freeze({ ok: false, code: verified.code, reason: verified.reason, trust })

  const payload = verified.payload
  if (!Number.isSafeInteger(payload.sequence) || payload.sequence < 1) {
    return Object.freeze({ ok: false, code: ENVELOPE_CODES.BAD_PAYLOAD, reason: '信任表增量缺少合法 sequence', trust })
  }
  if (payload.sequence <= lastSequence) {
    return Object.freeze({
      ok: false, code: ENVELOPE_CODES.BAD_PAYLOAD,
      reason: `信任表增量 sequence ${payload.sequence} 不大于已接受的 ${lastSequence}（回退被拒）`,
      trust,
    })
  }
  const add = Array.isArray(payload.add) ? payload.add : []
  const revoke = Array.isArray(payload.revoke) ? payload.revoke : []
  const entries = []
  for (const entry of trust.keys.values()) {
    entries.push({
      keyId: entry.keyId, publicKeyPem: entry.publicKeyPem, notBeforeMs: entry.notBeforeMs,
      notAfterMs: entry.notAfterMs, revokedAtMs: entry.revokedAtMs, comment: entry.comment,
    })
  }
  const problems = []
  for (const entry of add) {
    if (entries.some((existing) => existing.keyId === entry?.keyId)) {
      problems.push(`增量想添加一个已存在的 keyId：${entry?.keyId}`)
      continue
    }
    entries.push(entry)
  }
  for (const keyId of revoke) {
    const target = entries.find((entry) => entry.keyId === keyId)
    if (target === undefined) { problems.push(`增量想吊销一个不存在的 keyId：${keyId}`); continue }
    target.revokedAtMs = target.revokedAtMs ?? nowMs
  }
  if (problems.length > 0) {
    return Object.freeze({ ok: false, code: ENVELOPE_CODES.BAD_PAYLOAD, reason: problems.join('；'), trust, problems: Object.freeze(problems) })
  }
  const next = createTrustStore(entries)
  return Object.freeze({
    ok: true, code: null, reason: null, trust: next, sequence: payload.sequence,
    added: Object.freeze(add.map((entry) => entry.keyId)), revoked: Object.freeze([...revoke]),
  })
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

/**
 * 装载期自检：把设计 §5 的四条拒绝判据各真的跑一遍。
 *
 * 用一把**当场生成**的钥匙，而不是内置的发布公钥：自检要验证的是判据，
 * 不是"内置的那把钥匙还能用"。后者是部署事实，会在发布端轮换时变化。
 */
export function selfCheckEnvelope() {
  const problems = []
  const generated = generateReleaseKeyPair({ keyId: 'self-check', comment: '装载期自检' })
  const other = generateReleaseKeyPair({ keyId: 'self-check-other' })
  const nowMs = Date.parse('2026-10-02T00:00:00Z')
  const trust = createTrustStore([{ keyId: 'self-check', publicKeyPem: generated.publicKeyPem }])

  const payload = {
    format: ENVELOPE_FORMATS.FEED, channel: 'stable', platform: 'win32', arch: 'x64',
    sequence: 1, issuedAt: '2026-10-01T00:00:00Z', expiresAt: '2026-10-08T00:00:00Z',
    releaseId: 'r1', productVersion: '1.0.0',
    manifestPath: 'releases/r1/manifest.json', manifestSha256: 'a'.repeat(64),
  }
  const good = signEnvelope(payload, { privateKeyPem: generated.privateKeyPem, keyId: 'self-check' })
  const goodBytes = serializeEnvelope(good)

  const verified = verifyEnvelope(goodBytes, { trust, nowMs })
  if (!verified.ok) problems.push(`合法 envelope 没验过：${verified.code} ${verified.reason}`)

  // 键序变化不影响验签（签名覆盖规范化结果），但语义改动必须被发现。
  const reordered = Buffer.from(JSON.stringify({
    signature: good.signature, payload: payload, keyId: good.keyId,
    // eslint-disable-next-line no-sparse-arrays
  }), 'utf8')
  if (reordered.toString('utf8') === goodBytes) problems.push('自检前提失效：重排后的字节与原文相同')
  const reorderedResult = verifyEnvelope(reordered, { trust, nowMs })
  if (!reorderedResult.ok) problems.push(`键序变化后验签失败（签名覆盖的应是规范化结果）：${reorderedResult.code}`)

  const cases = [
    ['未知 keyId', serializeEnvelope({ ...good, keyId: 'not-in-table' }), ENVELOPE_CODES.UNKNOWN_KEY],
    ['签名不匹配', serializeEnvelope({ ...good, signature: Buffer.alloc(64, 7).toString('base64') }), ENVELOPE_CODES.BAD_SIGNATURE],
    ['重复键', `{"keyId":"self-check","keyId":"self-check","payload":${canonicalJson(payload)},"signature":"${good.signature}"}`, ENVELOPE_CODES.MALFORMED],
    ['过期', serializeEnvelope(signEnvelope({ ...payload, expiresAt: '2026-10-02T00:00:00Z' },
      { privateKeyPem: generated.privateKeyPem, keyId: 'self-check' })), ENVELOPE_CODES.EXPIRED],
    ['未知格式', serializeEnvelope(signEnvelope({ ...payload, format: 'legion/update-feed@2' },
      { privateKeyPem: generated.privateKeyPem, keyId: 'self-check' })), ENVELOPE_CODES.UNKNOWN_FORMAT],
    ['签名长度不对', serializeEnvelope({ ...good, signature: Buffer.alloc(32, 1).toString('base64') }), ENVELOPE_CODES.MALFORMED],
    ['多余顶层键', `${canonicalJson({ ...good, extra: 1 })}\n`, ENVELOPE_CODES.MALFORMED],
    ['用别的私钥签', serializeEnvelope(signEnvelope(payload, { privateKeyPem: other.privateKeyPem, keyId: 'self-check' })), ENVELOPE_CODES.BAD_SIGNATURE],
  ]
  for (const [name, bytes, code] of cases) {
    const result = verifyEnvelope(bytes, { trust, nowMs })
    if (result.ok) problems.push(`「${name}」被接受了`)
    else if (result.code !== code) problems.push(`「${name}」拒绝码是 ${result.code}，期望 ${code}`)
  }

  // 超限输入。
  const oversized = verifyEnvelope(Buffer.alloc(64, 0x20), { trust, nowMs, maxBytes: 32 })
  if (oversized.code !== ENVELOPE_CODES.TOO_LARGE) problems.push('超大 envelope 没有被拒绝')

  // 吊销之后必须立刻失效。
  const revoked = applyTrustUpdate(trust, serializeEnvelope(signTrustUpdate({
    privateKeyPem: generated.privateKeyPem, keyId: 'self-check', sequence: 1,
    issuedAt: '2026-10-01T00:00:00Z', expiresAt: '2026-10-08T00:00:00Z',
    add: [{ keyId: 'next', publicKeyPem: other.publicKeyPem }],
  })), { nowMs, lastSequence: 0 })
  if (!revoked.ok) problems.push(`合法信任表增量没被接受：${revoked.reason}`)
  else {
    if (!revoked.trust.keys.has('next')) problems.push('信任表增量没有加入新公钥')
    const replay = applyTrustUpdate(revoked.trust, serializeEnvelope(signTrustUpdate({
      privateKeyPem: generated.privateKeyPem, keyId: 'self-check', sequence: 1,
      issuedAt: '2026-10-01T00:00:00Z', expiresAt: '2026-10-08T00:00:00Z', add: [],
    })), { nowMs, lastSequence: 1 })
    if (replay.ok) problems.push('信任表增量 sequence 回退没有被拒绝')
  }

  // 未知密钥**不能**退化成"未签名所以放行"。
  const unknown = verifyEnvelope(serializeEnvelope(signEnvelope(payload, {
    privateKeyPem: other.privateKeyPem, keyId: 'ghost',
  })), { trust, nowMs })
  if (unknown.ok || unknown.code !== ENVELOPE_CODES.UNKNOWN_KEY) {
    problems.push('未知 keyId 没有落到 envelope-unknown-key')
  }

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    prefix: ENVELOPE_PREFIX,
    formats: ENVELOPE_FORMATS,
    rejectedCases: cases.length + 1,
    sample: Object.freeze({
      fingerprint: keyFingerprint(generated.publicKeyPem).slice(0, 16),
      signedBytes: signedBytes(payload).length,
      verifiedFormat: verified.format ?? null,
    }),
  })
}

export const ENVELOPE_CHECKED = selfCheckEnvelope()
