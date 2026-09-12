// runtime/probe/index.mjs
// ============================================================================
// 模型连通性与能力探测的**执行**面（PRT-504）
//
// 与 `runtime/contracts/model-probe.mjs` 的分工：
//   契约模块 — 怎么分类、怎么判定、缓存多久（纯函数，无 I/O）
//   本模块   — 什么时候去问、怎么问、问完记哪（有 I/O，但**两处依赖可注入**）
//
// 两处注入点是刻意的：
//   `transport`     — 发请求。真实实现走 `fetch`，测试用假 transport 就能覆盖
//                     **全部**失败分类（401/403/404/429/5xx/连不上/TLS/超时），
//                     不需要真的去连任何一个供应商，也不需要网络。
//   `resolveSecret` — 取凭证。契约 §6.7 要求"Runtime 在获得授权后按需解析密钥"，
//                     所以本模块**从不自己读密钥库**：它只知道有一个函数能把
//                     secretRef 换成一次性凭证。这让"密钥从哪来"可以独立演进
//                     （DPAPI / Credential Manager / 未来的 ACL 方案），
//                     也让本模块的测试里根本不存在真实密钥。
//
// ---------------------------------------------------------------------------
// 三条不可让步的性质
//
// ① **凭证不进判定、不进消息、不进缓存。**
//    凭证在 `runTransport` 的局部作用域里传进去，出来时只剩码与耗时。
//    这是 §3.1 那条产品目标的运行时形态：靠评审纪律守不住，靠结构守住。
//    有一条用例把整个缓存与判定序列化后，用 `findPlaintextSecrets` 与
//    真实密钥字面量双重检查。
//
// ② **"探测没做成"不等于"判定为可用"。**
//    transport 抛异常、返回垃圾、resolveSecret 抛异常——全部落到明确的失败码。
//    没有一条路径会因为"出错了"而返回 `ok: true`。
//
// ③ **主动取消与故障分开。**
//    `classifyFailure` 对 `kind: 'abort'` 返回 `null`（不是失败码），
//    于是调用方能区分"我取消了"与"它坏了"。把取消混进故障会让一次正常的
//    取消在审计里看起来像一次连通性事故。
// ============================================================================

import {
  PROBE_TTL_MS,
  NEGATIVE_PROBE_TTL_MS,
  classifyFailure,
  defaultProbeMessage,
  evaluateProbe,
  isProbeFresh,
  probeClassOf,
  probeFingerprint,
  ttlForVerdict,
} from '../contracts/model-probe.mjs'

/** 探测自身抛出的异常类别（与"探测结论是失败"是两件事）。 */
export const PROBE_RAISED = Object.freeze({
  TRANSPORT_MISSING: 'TRANSPORT_INVALID',
  RESOLVER_MISSING: 'RESOLVER_INVALID',
})

/** 缺省最大缓存条目数：探测缓存是**有界**的，否则长跑进程会无上限增长。 */
const DEFAULT_MAX_ENTRIES = 200

/**
 * 把 transport 抛出的异常归一化为 `classifyFailure` 认识的 `kind`。
 *
 * 为什么要归一化而不是直接读 `err.code`：Node 的 `fetch` 在不同失败下抛的
 * 东西不一样（`TypeError: fetch failed` 带 `cause.code`、`AbortError`、
 * 自定义 transport 抛任意值）。分类是**契约**，不能建立在这些形状上——
 * 形状一变，`AUTH_FAILED` 就会静默退化成 `UNCLASSIFIED`。
 *
 * 只有 `AbortError` 被刻意保留为 `abort`：那是唯一的"不是故障"。
 */
export function normalizeTransportError(err) {
  if (err === null || err === undefined) return { kind: 'unknown' }
  if (typeof err === 'object' && err.name === 'AbortError') return { kind: 'abort' }
  if (typeof err === 'object' && err.name === 'TimeoutError') return { kind: 'timeout' }
  const code = typeof err === 'object' ? err.code ?? err.cause?.code : null
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'ECONNREFUSED':
    case 'ECONNRESET':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'EPIPE':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return { kind: 'connect' }
    case 'ETIMEDOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT':
      return { kind: 'timeout' }
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return { kind: 'tls' }
    default:
      break
  }
  const msg = typeof err === 'object' && typeof err.message === 'string' ? err.message : String(err)
  // 证书类失败在部分实现里只有消息没有 code
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b/i.test(msg)) return { kind: 'tls' }
  if (/abort/i.test(msg)) return { kind: 'abort' }
  if (/timeout|timed out/i.test(msg)) return { kind: 'timeout' }
  return { kind: 'unknown' }
}

/**
 * 创建探测执行器。
 *
 * @param {object} deps
 * @param {Function} deps.transport      `async ({profile, credential, signal}) => {kind, status?, capabilities?, modelEcho?, latencyMs?}`
 *                                       返回 `{kind:'http', status:200, ...}` 表示拿到响应。
 * @param {Function} [deps.resolveSecret] `async (secretRef, profile) => credential`。
 *                                       抛异常即视为本地密钥库问题（SECRET_UNAVAILABLE）。
 * @param {Function} [deps.clock]
 */
export function createModelProbe({
  transport,
  resolveSecret,
  clock = () => Date.now(),
  ttlMs = PROBE_TTL_MS,
  negativeTtlMs = NEGATIVE_PROBE_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
} = {}) {
  if (typeof transport !== 'function') {
    throw new TypeError(`createModelProbe 需要 transport 函数（${PROBE_RAISED.TRANSPORT_MISSING}）：` +
      '没有它就无法真的问一次，而"没问过"绝不能被当成"可用"')
  }
  if (resolveSecret !== undefined && typeof resolveSecret !== 'function') {
    throw new TypeError(`resolveSecret 必须是函数或省略（${PROBE_RAISED.RESOLVER_MISSING}）`)
  }

  /** key = `profileId\u0000fingerprint` → { verdict, probedAtMs } */
  const cache = new Map()
  /** 每次真实探测（未命中缓存）都记一条，供诊断与用例断言。 */
  const attempts = []

  function cacheKey(profile) {
    const id = profile !== null && typeof profile === 'object' && typeof profile.id === 'string' ? profile.id : ''
    return `${id}\u0000${probeFingerprint(profile)}`
  }

  function remember(key, verdict) {
    cache.set(key, { verdict, probedAtMs: clock() })
    // LRU-ish：Map 保持插入顺序，超限时删最旧的。
    // 不这么做的话，一个配置页反复试不同 endpoint 会无上限撑大内存。
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value
      cache.delete(oldest)
    }
  }

  /** 归一化 transport 的返回值，得出 `evaluateProbe` 要的 `observed`。 */
  function observedFromTransport(raw, startedAtMs) {
    if (raw === null || raw === undefined || typeof raw !== 'object') {
      return { ok: false, code: 'UNCLASSIFIED', message: 'transport 没有返回可用的观测结果' }
    }
    const latencyMs = typeof raw.latencyMs === 'number' && Number.isFinite(raw.latencyMs)
      ? raw.latencyMs
      : clock() - startedAtMs
    // 空的 capabilities 不算数：见下方"空能力表"的说明
    const caps = raw.capabilities === null || raw.capabilities === undefined ? {} : raw.capabilities
    if (raw.kind === 'http') {
      const status = raw.status
      if (typeof status === 'number' && status >= 200 && status < 300) {
        return { ok: true, latencyMs, capabilities: caps }
      }
      const code = classifyFailure({ kind: 'http', status })
      return { ok: false, code, message: defaultProbeMessage(code), latencyMs }
    }
    const code = classifyFailure({ kind: raw.kind })
    if (code === null) {
      // kind === 'abort'：主动取消。**不是**一次故障判定，因此不缓存、
      // 也不写成某个失败码——调用方自己知道它取消了。
      return { cancelled: true, latencyMs }
    }
    return { ok: false, code, message: raw.message ?? defaultProbeMessage(code), latencyMs }
  }

  async function runProbe(profile, requiredCapabilities) {
    const startedAtMs = clock()
    let credential = null

    // ── 凭证解析：失败 → SECRET_UNAVAILABLE（本地问题），**不是** AUTH_FAILED ──
    const needsCredential = profile !== null && typeof profile === 'object' &&
      profile.secretRef !== null && profile.secretRef !== undefined && profile.secretRef !== ''
    if (needsCredential) {
      if (resolveSecret === undefined) {
        return {
          observed: {
            ok: false,
            code: 'SECRET_UNAVAILABLE',
            message: '该模型档案需要凭证，但本进程没有配置凭证解析器：' +
              '这属于本地配置不完整，不是供应商拒绝（SECRET_UNAVAILABLE ≠ AUTH_FAILED）',
          },
          attempted: false,
        }
      }
      try {
        credential = await resolveSecret(profile.secretRef, profile)
      } catch (err) {
        // 注意这里**不把 err.message 原样带出来**：解析异常里可能带着密钥库
        // 的实现细节甚至片段。给一条可操作的话，原始诊断留给密钥库自己。
        return {
          observed: {
            ok: false,
            code: 'SECRET_UNAVAILABLE',
            message: `${defaultProbeMessage('SECRET_UNAVAILABLE')}（解析器报告：${safeReason(err)}）`,
          },
          attempted: false,
        }
      }
      if (credential === null || credential === undefined || credential === '') {
        return {
          observed: {
            ok: false,
            code: 'SECRET_UNAVAILABLE',
            message: `${defaultProbeMessage('SECRET_UNAVAILABLE')}（解析器返回空）`,
          },
          attempted: false,
        }
      }
    }

    let raw
    try {
      raw = await transport({ profile, credential, signal: null })
    } catch (err) {
      const { kind } = normalizeTransportError(err)
      const code = classifyFailure({ kind })
      if (code === null) {
        return { observed: { cancelled: true, latencyMs: clock() - startedAtMs }, attempted: true }
      }
      return {
        observed: { ok: false, code, message: `${defaultProbeMessage(code)}`, latencyMs: clock() - startedAtMs },
        attempted: true,
      }
    }

    return { observed: observedFromTransport(raw, startedAtMs), attempted: true }
  }

  /**
   * 探测一个模型档案。
   *
   * 返回判定（`evaluateProbe` 的产物）并附 `cached: boolean`。
   * 命中新鲜缓存时**不发请求**：探测是要花钱的。
   */
  async function probe({ profile, requiredCapabilities = [], force = false } = {}) {
    const key = cacheKey(profile)
    const now = clock()

    if (force !== true) {
      const hit = cache.get(key)
      if (hit !== undefined) {
        const ttl = ttlForVerdict(hit.verdict, { ttlMs, negativeTtlMs })
        if (isProbeFresh({ entry: hit, nowMs: now, ttlMs: ttl })) {
          return Object.freeze({ ...hit.verdict, cached: true, ageMs: now - hit.probedAtMs })
        }
        // 过期：删掉，避免"过期但还在表里"的记录被后续逻辑误用
        cache.delete(key)
      }
    }

    const { observed, attempted } = await runProbe(profile, requiredCapabilities)
    if (observed.cancelled === true) {
      attempts.push({ profileId: profile?.id ?? null, probedAtMs: now, attempted, cancelled: true })
      return Object.freeze({
        ok: false,
        code: 'UNCLASSIFIED',
        class: 'unknown',
        message: '探测被主动取消：这不是一次可用的证明，也不是一次故障判定',
        missingCapabilities: Object.freeze([]),
        capabilities: Object.freeze({}),
        latencyMs: observed.latencyMs ?? null,
        cached: false,
        cancelled: true,
      })
    }

    const verdict = evaluateProbe({ observed, required: requiredCapabilities })
    remember(key, verdict)
    attempts.push({ profileId: profile?.id ?? null, probedAtMs: now, attempted, code: verdict.code })
    return Object.freeze({ ...verdict, cached: false })
  }

  function invalidate(profileId) {
    let removed = 0
    for (const key of [...cache.keys()]) {
      if (key.startsWith(`${profileId ?? ''}\u0000`)) {
        cache.delete(key)
        removed += 1
      }
    }
    return removed
  }

  return {
    probe,
    invalidate,
    /** 只读快照：给诊断用，**不含凭证**（缓存里本来就没有）。 */
    inspect() {
      return Object.freeze({
        size: cache.size,
        attempts: attempts.length,
        entries: Object.freeze([...cache.entries()].map(([key, v]) => Object.freeze({
          key,
          probedAtMs: v.probedAtMs,
          ok: v.verdict.ok,
          code: v.verdict.code,
        }))),
      })
    },
    clear() {
      cache.clear()
      attempts.length = 0
    },
  }
}

/**
 * 把任意异常收敛为一句**不含密钥**的原因。
 *
 * 只取错误的 `name` 与一个粗略的类别，**不取 message**：密钥库错误的 message
 * 可能包含被解密的片段、路径或账户名。诊断价值由"哪一类失败"提供，
 * 而不是由原文提供——原文可以在日志受控的地方单独取。
 */
function safeReason(err) {
  if (err === null || err === undefined) return '未知原因'
  const name = typeof err === 'object' && typeof err.name === 'string' ? err.name : typeof err
  if (typeof err === 'object' && err.code !== undefined) return `${name}/${String(err.code)}`
  return String(name)
}

/** 真实 HTTP transport 的**默认能力探测路径**（可被 transport 覆盖）。 */
export const PROBE_PATHS = Object.freeze({
  /** OpenAI 兼容：列模型即可验证连通 + 鉴权，且几乎不花钱 */
  models: '/v1/models',
})
