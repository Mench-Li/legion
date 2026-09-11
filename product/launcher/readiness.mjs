// product/launcher/readiness.mjs
// ============================================================================
// 就绪判据（PRT-701 / PRT-703）
//
// 「端口能连」不是就绪。理由不是洁癖：残留的旧实例、别的程序、以及
// 上一次升级前启动的同一个服务，都会让端口能连、甚至让 `/api/config` 返回 200。
// 于是 Launcher 会宣布「team-hub 已就绪」，而实际上跑的是被替换掉的那一版程序。
//
// 因此每条就绪判据有两层：
//   ① `expectStatus`：HTTP 状态码
//   ② `expectJson`  ：**身份断言**——响应 JSON 的若干顶层字段必须等于期望值
//      （`{ port: '{port}' }` 之类；模板由 Launcher 用进程计划里的真实值展开）
//
// 第二层才是真正回答「听到的是不是我们自己」。`/api/config` 恰好同时返回
// `auth` / `db` / `port`（team-hub/server.mjs:4438），因此这条判据不需要新端点。
//
// ## 失败分类决定「要不要继续等」
//
// 把两类失败混成「等超时」会同时产生两个坏结果：真正的配置错误被拖成 60 秒超时，
// 而超时文案只说「未就绪」，指向错误的排查方向。所以：
//   - `connection-refused` / `no-response` → **可重试**：进程可能还在起
//   - `identity-mismatch` / `body-not-json` → **立即失败**：占着端口的不是我们要的东西，
//     再等多久都不会变好，而「重试」这个动作本身在暗示它会变好
// ============================================================================

/** 判据缺失时的默认值。 */
export const DEFAULT_READINESS_TIMEOUT_MS = 30000
export const DEFAULT_READINESS_INTERVAL_MS = 250

/** 可重试的失败码：这些是「还没起来」，不是「起错了」。 */
export const RETRYABLE_PROBE_CODES = Object.freeze(['connection-refused', 'no-response', 'network-error'])

/** 不可重试的失败码：再等也不会变好。 */
export const FATAL_PROBE_CODES = Object.freeze(['identity-mismatch', 'body-not-json', 'http-status-mismatch', 'process-exited'])

export function isRetryableProbeCode(code) {
  return RETRYABLE_PROBE_CODES.includes(code)
}

/** 展开 `{port}` / `{install}` 等占位符；未知占位符原样保留（宁可显示 `{x}` 也不要静默吞掉）。 */
export function expandTemplate(value, vars) {
  if (typeof value === 'string') {
    return value.replace(/\{([a-zA-Z0-9_]+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m))
  }
  if (Array.isArray(value)) return value.map((v) => expandTemplate(v, vars))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = expandTemplate(v, vars)
    return out
  }
  return value
}

function result(code, extra = {}) {
  return Object.freeze({
    ok: code === null,
    code,
    retryable: code === null ? false : isRetryableProbeCode(code),
    ...extra,
  })
}

/**
 * 做一次探测。
 *
 * `fetchImpl` 可注入（用例里不需要起真实服务就能覆盖五种失败形态）。
 * 只读取响应体的一次文本并在本地解析——不要 `res.json()`：
 * 解析失败时要能把**片段**放进诊断，而 `res.json()` 抛出的错误里没有原文。
 */
export async function probeOnce(expected, { fetchImpl = globalThis.fetch, timeoutMs = 5000, signal = null } = {}) {
  if (typeof fetchImpl !== 'function') {
    return result('no-response', { detail: '当前运行环境没有可用的 fetch，无法执行就绪探测' })
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = setTimeout(() => controller?.abort(), timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()
  const onExternalAbort = () => controller?.abort()
  if (signal !== null && controller !== null) signal.addEventListener('abort', onExternalAbort, { once: true })

  let res
  try {
    res = await fetchImpl(expected.url, {
      method: 'GET',
      headers: { accept: 'application/json, text/html;q=0.9, */*;q=0.8' },
      signal: controller?.signal ?? undefined,
      redirect: 'manual',
    })
  } catch (e) {
    clearTimeout(timer)
    if (signal !== null && controller !== null) signal.removeEventListener('abort', onExternalAbort)
    const name = e?.name ?? ''
    const cause = e?.cause?.code ?? e?.code ?? ''
    // AbortError 由我们自己的超时触发 → 无响应；由外部取消触发 → 也归到这里，
    // 但文案不同：外部取消是「用户/Launcher 要求停下」，不是「服务没回」
    if (name === 'AbortError') {
      return result('no-response', { detail: `探测 ${expected.url} 超时（${timeoutMs}ms）` })
    }
    if (cause === 'ECONNREFUSED' || /ECONNREFUSED/.test(String(e?.message ?? ''))) {
      return result('connection-refused', { detail: `连接 ${expected.url} 被拒绝（服务尚未监听）` })
    }
    return result('network-error', { detail: `探测 ${expected.url} 失败：${name || cause || 'unknown'}` })
  }
  clearTimeout(timer)
  if (signal !== null && controller !== null) signal.removeEventListener('abort', onExternalAbort)

  let body = null
  try {
    body = await res.text()
  } catch {
    body = null
  }

  const expectStatus = expected.expectStatus ?? 200
  if (res.status !== expectStatus) {
    return result('http-status-mismatch', {
      detail: `${expected.url} 返回 ${res.status}，期望 ${expectStatus}`,
      status: res.status,
      bodySnippet: snippet(body),
    })
  }

  if (expected.expectJson === undefined || expected.expectJson === null) {
    return result(null, { status: res.status, identity: null })
  }

  let parsed
  try {
    parsed = JSON.parse(body ?? '')
  } catch {
    return result('body-not-json', {
      detail: `${expected.url} 的响应不是 JSON，无法做身份断言`,
      status: res.status,
      bodySnippet: snippet(body),
    })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return result('body-not-json', { detail: `${expected.url} 的响应 JSON 不是对象`, status: res.status, bodySnippet: snippet(body) })
  }

  const mismatches = []
  for (const [key, want] of Object.entries(expected.expectJson)) {
    const got = parsed[key]
    if (got !== want) mismatches.push(`${key}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`)
  }
  if (mismatches.length > 0) {
    return result('identity-mismatch', {
      detail: `${expected.url} 响应来自**其他**进程：${mismatches.join('；')}`
        + '——端口上监听的不是本次启动的实例（常见原因：残留的旧实例、或别的程序占用了该端口）',
      status: res.status,
      bodySnippet: snippet(body),
    })
  }
  return result(null, { status: res.status, identity: Object.keys(expected.expectJson) })
}

function snippet(text) {
  if (typeof text !== 'string') return null
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat
}

/**
 * 轮询直到就绪 / 超时 / 出现不可重试失败。
 *
 * `sleep` 与 `now` 可注入：判据本身必须能在不等待真实时间的前提下被验证
 * （一个 30s 超时的用例会让整套 CI 慢到没人愿意跑它）。
 * `isProcessAlive` 可注入：进程已经退出时没必要把 30 秒等满——
 * 「等一个已经死掉的进程」是最常见也最浪费时间的假超时。
 */
export async function waitForReadiness(expected, {
  timeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
  intervalMs = DEFAULT_READINESS_INTERVAL_MS,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  isProcessAlive = null,
  probeTimeoutMs = 5000,
  signal = null,
} = {}) {
  const startedAt = now()
  const deadline = startedAt + timeoutMs
  const attempts = []
  let last = null

  for (;;) {
    if (signal?.aborted === true) {
      return Object.freeze({ ok: false, code: 'cancelled', attempts, elapsedMs: now() - startedAt, last, retryable: false })
    }
    if (typeof isProcessAlive === 'function' && isProcessAlive() === false) {
      return Object.freeze({
        ok: false,
        code: 'process-exited',
        attempts,
        elapsedMs: now() - startedAt,
        last,
        retryable: false,
        detail: '被探测的进程已经退出：不必继续等待就绪',
      })
    }
    last = await probeOnce(expected, { fetchImpl, timeoutMs: probeTimeoutMs, signal })
    attempts.push({ at: now() - startedAt, code: last.code, detail: last.detail ?? null })
    if (last.ok === true) {
      return Object.freeze({ ok: true, code: null, attempts, elapsedMs: now() - startedAt, last, retryable: false })
    }
    if (last.retryable !== true) {
      return Object.freeze({ ok: false, code: last.code, attempts, elapsedMs: now() - startedAt, last, retryable: false })
    }
    if (now() >= deadline) {
      return Object.freeze({
        ok: false,
        code: 'readiness-timeout',
        attempts,
        elapsedMs: now() - startedAt,
        last,
        retryable: false,
        detail: `${timeoutMs}ms 内未就绪：最后一次探测为 ${last.code}${last.detail === null || last.detail === undefined ? '' : `（${last.detail}）`}`,
      })
    }
    // 不要睡过 deadline：睡 250ms 越过终点会让「30s 超时」实际变成 30.25s，
    // 而超时值是要写进配置 Schema 的承诺。
    const remaining = deadline - now()
    await sleep(Math.max(1, Math.min(intervalMs, remaining)))
  }
}

/**
 * 把 `waitForReadiness` 的结果转成 `ProcessDiagnostic` 形态。
 * `verified` 标记区分「声明过的判据」与「本次真实量到的判据」——
 * 清单里的判据在真正跑过一次之前都只能算声明。
 */
export function readinessResultToDiagnostic(processKey, readiness, outcome) {
  if (outcome.ok === true) {
    return Object.freeze({
      severity: 'warn',
      code: 'READINESS_VERIFIED',
      process: processKey,
      message: `进程 ${processKey} 就绪：${readiness.url} 在 ${outcome.elapsedMs}ms 内满足判据`
        + `${readiness.expectJson === undefined ? '' : `（身份断言：${Object.keys(readiness.expectJson).join(', ')}）`}`,
      elapsedMs: outcome.elapsedMs,
      attempts: outcome.attempts.length,
    })
  }
  return Object.freeze({
    severity: 'error',
    code: outcome.code === 'readiness-timeout' ? 'READINESS_TIMEOUT'
      : outcome.code === 'process-exited' ? 'PROCESS_EXITED_BEFORE_READY'
        : outcome.code === 'identity-mismatch' ? 'READINESS_IDENTITY_MISMATCH'
          : 'READINESS_FAILED',
    process: processKey,
    message: `进程 ${processKey} 未就绪（${outcome.code}）：${outcome.detail ?? outcome.last?.detail ?? '无详情'}`,
    elapsedMs: outcome.elapsedMs,
    attempts: outcome.attempts.length,
    probeCode: outcome.code,
  })
}
