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

/**
 * 就绪判据的**种类**。
 *
 *   · `http`   —— 对进程监听的端口发一次请求（team-hub / workbench / 白板）；
 *   · `stdout` —— 在**我们自己 spawn 的那个子进程**的输出里找一行；
 *   · `none`   —— 无端口进程（orchestrator），立刻算就绪。
 *
 * ★ 为什么需要 `stdout`（PRT-251 续 ③ §4）：
 *
 * DSH 的 Web 面对**任何未认证请求**都答同一个最小的 401
 * （`packages/client/connection/src/browser-auth.ts` 的 `authorizeIndex()`：
 * "every other request receives the same minimal 401 response"）。
 * 于是「端口通了 + `/` 返回 200」这条判据在 DSH 上**永远不可能通过**，
 * 而 401 又落进 `FATAL_PROBE_CODES` 的 `http-status-mismatch`
 * ⇒ 不可重试、立刻熔断。反过来更坏：如果那个端口后面恰好是**别的**对 `/`
 * 答 200 的服务，这条判据会**通过**。两个方向都是错的。
 *
 * DSH 自己给出的、被它**明确设计为**给 supervisor 用的信号是 stdout 上那一行
 * `dsh web: <url>`（`packages/bundle/web-app/src/index.ts`：
 * "The URL line and browser handoff are readiness signals: **supervisors RPC as
 * soon as they observe the line**"）。
 *
 * 而且它比 HTTP 探测**更强**：那行文字来自**我们 spawn 的那个进程本身**，
 * 那是一份身份证明；而对一个端口发请求不是——谁都可以在那个端口上听着。
 * 这正是 `readiness.mjs` 文件头说的那件事在 DSH 这一侧的答案：
 * team-hub 有 `/api/config` 可以做身份断言，DSH **没有**等价物，
 * 它的身份恰恰在"这是我儿子说的"这件事上。
 */
export const READINESS_KINDS = Object.freeze(['http', 'stdout', 'none'])

/** `expectMatch` 可以是正则，也可以是一段正则**源码**（清单里更易读、可序列化）。 */
function toMatchRegExp(spec) {
  if (spec instanceof RegExp) return spec
  if (typeof spec !== 'string' || spec === '') return null
  try { return new RegExp(spec) } catch { return null }
}

/** 从匹配到的片段里取出端口；取不到就返回 `null`（**不猜**一个默认端口）。 */
function portFromMatch(match, group = 1) {
  const raw = Array.isArray(match) ? match[group] : null
  if (typeof raw !== 'string') return null
  const m = /:(\d{1,5})(?=[/?#]|$)/.exec(raw)
  return m === null ? null : Number(m[1])
}

/**
 * 按行收集子进程输出，供 `stdout` 判据读取。
 *
 * ⚠️ **它收的是原始文本，所以读数里绝不能把它整段带走**：
 * DSH 那一行是 `dsh web: http://127.0.0.1:3081/?token=<启动令牌>`，
 * 而共享的 `redactText()` 的「URL 内嵌凭证」只认 `user:pass@` 形态、
 * **不认查询串里的 token**（`runtime/contracts/redact-patterns.mjs`）。
 * 于是把整行放进诊断，等于把一枚浏览器凭证搬进日志、状态与诊断包。
 * `probeStdoutOnce()` 因此只报「哪条模式匹配上了」+「端口对不对」。
 *
 * 有界：只留最近 `maxLines` 行、单行超过 `maxLineBytes` 截断。
 * 无界的行缓冲会把一个"输出很多的子进程"变成一次内存事故，
 * 而那种事故的表现是启动器自己被 OOM 杀掉——比就绪失败难查得多。
 */
export function createLineCollector({ maxLines = 200, maxLineBytes = 4096 } = {}) {
  const streams = new Map()   // `${key}\u0000${stream}` → { lines, tail }

  function slotFor(key, stream) {
    const id = `${key}\u0000${stream}`
    let slot = streams.get(id)
    if (slot === undefined) {
      slot = { lines: [], tail: '' }
      streams.set(id, slot)
    }
    return slot
  }

  return Object.freeze({
    push(key, stream, chunk) {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk ?? '').toString('utf8')
      const slot = slotFor(key, stream)
      slot.tail += text
      for (;;) {
        const nl = slot.tail.indexOf('\n')
        if (nl < 0) break
        const line = slot.tail.slice(0, nl).replace(/\r$/, '')
        slot.tail = slot.tail.slice(nl + 1)
        slot.lines.push(line.length > maxLineBytes ? `${line.slice(0, maxLineBytes)}…` : line)
        if (slot.lines.length > maxLines) slot.lines.shift()
      }
      // 没有换行的尾巴也要有界：一个只写不换行的进程否则会把它撑到内存里。
      if (slot.tail.length > maxLineBytes) slot.tail = slot.tail.slice(0, maxLineBytes)
    },
    linesFor(key, stream = 'stdout') {
      return streams.get(`${key}\u0000${stream}`)?.lines ?? []
    },
    /**
     * 丢掉某个进程已收集的输出。
     *
     * **必须在每次 spawn 之前调用**：重启后新实例的就绪判据如果被上一代留下的
     * 那一行满足，就是一次假就绪——而"上一代的 `dsh web:` 还在缓冲里"
     * 与"这一代真的起来了"在读数上是同一个东西。
     */
    clear(key) {
      for (const id of [...streams.keys()]) {
        if (id.startsWith(`${key}\u0000`)) streams.delete(id)
      }
    },
  })
}

/**
 * 做一次 `stdout` 判据探测。
 *
 * 与 `probeOnce()` 同形（同一套失败码词汇），但读的是**行缓冲**而不是网络。
 *
 * ★ 读数里**不含匹配到的那一行**（理由见 `createLineCollector`）：
 * 只有"哪条模式匹配上了"、以及从里面取出来的端口。
 */
export function probeStdoutOnce(expected, { lines = [], plannedPort = null } = {}) {
  const re = toMatchRegExp(expected.expectMatch)
  if (re === null) {
    return result('readiness-declaration-invalid', {
      detail: `就绪判据的 expectMatch 不是一个能编译的正则：${JSON.stringify(expected.expectMatch)}`
        + '——清单写错了，等下去也不会变好',
    })
  }
  const pattern = re.source
  for (const line of lines) {
    re.lastIndex = 0
    const m = re.exec(line)
    if (m === null) continue
    const reportedPort = portFromMatch(m, expected.portGroup ?? 1)
    // ★ 端到端那一条：DSH 报告的端口必须是**计划里那个**。
    //   它同时是「`--port` 真的到达了它」的机器判据（PRT-251 续 ③ 的整条链）。
    //   `plannedPort === 0` 是"让 OS 挑一个"（DSH 明确支持），那时不比对。
    if (plannedPort !== null && plannedPort !== 0 && reportedPort !== null
      && String(reportedPort) !== String(plannedPort)) {
      return result('identity-mismatch', {
        detail: `子进程报告的端口是 ${reportedPort}，而计划里是 ${plannedPort}`
          + '——端口参数没有真的到达它（`--port` 那条链断了）',
        port: reportedPort,
        matchedPattern: pattern,
      })
    }
    return result(null, { identity: [`stdout:/${pattern}/`], port: reportedPort, matchedPattern: pattern })
  }
  return result('no-response', {
    detail: `等待 ${expected.stream ?? 'stdout'} 上出现 /${pattern}/（已收集 ${lines.length} 行）`,
    matchedPattern: pattern,
  })
}

/**
 * 轮询直到 `probe()` 通过 / 超时 / 出现不可重试失败。
 *
 * ★ 这是**唯一**的等待循环：`http` 与 `stdout` 两种判据都走它。
 * 两套循环会长出两套超时语义（`readiness.mjs` 文件头那条「不要睡过 deadline」
 * 的约束只会在其中一套上被想起来），而"两种判据对 30 秒的理解不一样"
 * 是那种只有到现场才会发现的漂移。
 */
export async function waitForProbe(probe, {
  timeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
  intervalMs = DEFAULT_READINESS_INTERVAL_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  isProcessAlive = null,
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
    last = await probe({ signal })
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
 * `http` 判据的轮询入口：**保留同名**，于是既有调用点与既有判据一个字都不用改，
 * 而实现已收敛到上面那个**唯一**的 `waitForProbe()`。
 *
 * 它为什么不是循环本身：`http` 与 `stdout` 两套循环会长出两套超时语义，
 * 而「不要睡过 deadline」那条约束只会在其中一套上被想起来——
 * "两种判据对 30 秒的理解不一样"是那种只有到现场才会发现的漂移。
 *
 * `sleep` / `now` 可注入：判据必须能在不等待真实时间的前提下被验证。
 * `isProcessAlive` 可注入：进程已经退出时没必要把 30 秒等满。
 */
export async function waitForReadiness(expected, {
  fetchImpl = globalThis.fetch,
  probeTimeoutMs = 5000,
  ...rest
} = {}) {
  return waitForProbe(
    ({ signal }) => probeOnce(expected, { fetchImpl, timeoutMs: probeTimeoutMs, signal }),
    rest,
  )
}

/**
 * `stdout` 判据的等待。
 *
 * `lines` 是一个**取数函数**而不是一个数组：每轮重新取，
 * 传数组会让循环永远看着第一次快照，于是"等一行还没出现的话"
 * 会一直等到超时——而它看起来像"进程没起来"。
 */
export async function waitForStdoutReadiness(expected, { lines = () => [], plannedPort = null, ...rest } = {}) {
  return waitForProbe(
    () => probeStdoutOnce(expected, { lines: lines(), plannedPort }),
    rest,
  )
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
 * 「判据**真的量过了**、并且过了」那一个码。
 *
 * 导出它，是因为它不只属于本模块：`tray-wiring.mjs` 要用它回答
 * 「workbench 这个地址算不算一次**观测**」——只有见过这个码的地址才准交给浏览器。
 *
 *   > 一个"由生产方写死、消费方再抄一遍"的码，
 *   > 与一个"只有生产方写死"的码，在生产方不改它的那些天里是同一个东西——
 *   > 只不过前者会在生产方改名时，让消费方那道闸**永远为真**：
 *   > 「打开 Workbench」从此恒灰，而没有任何东西报错。
 *
 * `product/config-schema.mjs` 里也登记着这个字面量，所以改名本来就要动两处；
 * 现在消费方改成引用，**改名的落点从三处收回到两处**。
 */
export const READINESS_VERIFIED_CODE = 'READINESS_VERIFIED'

/**
 * 把 `waitForReadiness` 的结果转成 `ProcessDiagnostic` 形态。
 * `verified` 标记区分「声明过的判据」与「本次真实量到的判据」——
 * 清单里的判据在真正跑过一次之前都只能算声明。
 *
 * ★ `stdout` 判据没有 URL，所以这里必须能说清"量的是什么"：
 * 报成 `stdout:/<模式>/`，**不报匹配到的那一行**（那一行里可能有凭证，
 * 理由见 `createLineCollector`）。一个报 `null` 的诊断在排查时等于没有信息。
 */
export function readinessResultToDiagnostic(processKey, readiness, outcome) {
  const subject = readiness?.url ?? (readiness?.kind === 'stdout'
    ? `${readiness.stream ?? 'stdout'}:/${readiness.matchedPattern ?? readiness.expectMatch ?? '?'}/`
    : null) ?? '（未声明的判据）'
  if (outcome.ok === true) {
    return Object.freeze({
      severity: 'warn',
      code: READINESS_VERIFIED_CODE,
      process: processKey,
      message: `进程 ${processKey} 就绪：${subject} 在 ${outcome.elapsedMs}ms 内满足判据`
        + `${readiness.expectJson === undefined ? '' : `（身份断言：${Object.keys(readiness.expectJson).join(', ')}）`}`
        + `${readiness.kind === 'stdout' && outcome.last?.port != null ? `（它报告的端口：${outcome.last.port}）` : ''}`,
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
