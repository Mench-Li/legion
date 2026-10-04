// product/update/health.mjs
// ============================================================================
// 新版本健康验证 —— 设计 §8 第 8 步那半句「服务健康验证」
//
// 原文（第 8 步）：「新 Launcher 保持维护模式，运行固定迁移计划、运行时补丁
// 自检和服务健康验证。此阶段不开放业务写入或自动认领。」
//
// ## 为什么探针必须是**声明式**的
//
// 健康探针在 `product/upgrade/switchover.mjs` 里的类型是一个**函数**：
//
//     (signal: AbortSignal) => Promise<{ ok: boolean, detail?: string }>
//
// 而 helper 是一个**独立进程**，它的输入是磁盘上的 JSON 事务文件。函数跨不过
// 进程边界——于是"新版本健康吗"这个问题在 helper 里没有表达式，而之前的实现
// 因此退化成"没有探针 → 不提交"（fail-closed，安全但等于升级永远停在验证那一步，
// 见 helper.mjs 里 helper-health-unverified 的注释）。
//
// 解法不是"允许事务文件带一段可执行代码"（那等于把 helper 变成一个任意代码
// 执行器），而是把探针**降级成数据**：一组对**本机回环地址**的 HTTP 检查。
// 这些检查描述的是"我刚启动的那几个服务在不在、是不是我的实例"——
// 正是"服务健康验证"要回答的问题。
//
// ## 只允许回环地址，这一条不是可选的
//
// 设计 §7 line 152 把渲染进程的暴露面限定为「无任意 URL」。事务文件由主进程
// 写、渲染进程影响不到它，但 helper 是权限最高的一段代码（它替换程序目录、
// 改数据库）。一个"helper 可以去 fetch 任意 URL"的规格，等于给这段代码加了
// 一个"对外发起任意请求"的能力——而它需要的只是问本机的几个已知端口。
//
// 所以 `validateHealthSpec` 只接受：
//   · `host` 是 `127.0.0.1` / `::1` / `localhost` 之一；
//   · 协议只有 `http:`（回环上的 TLS 没有意义，而允许 `https:` 会让
//     "证书校验失败怎么办"成为一个新问题）；
//   · 路径是**绝对路径且不含 `..`**（避免在回环上打到别的服务的别处）；
//   · 端口是 1–65535 的整数；
//   · 检查条数有上限（一个"一万个检查"的规格会把升级变成一次端口扫描）。
//
// ## 每一项都要能回答"我怎么知道这是我自己的实例"
//
// `team-hub` 的 readiness 里有一条 `expectJson: { port: '{port}' }`，注释写得
// 很清楚：断言端口一致才能区分「我们自己的实例」与「上一次升级前留下的旧实例
// 或别的程序占了同一个端口」。所以本模块支持 `expectJson`，而它**不是**可选
// 装饰——一个只检查"200 就健康"的探针会在旧实例还活着时报健康。
// ============================================================================

import { readFileSync } from 'node:fs'

export const HEALTH_PROTOCOL = 'legion/update-health@1'

/** 回环主机白名单。**不做 DNS 解析**：`localhost` 之外的任何名字都不放行。 */
export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', '::1', 'localhost'])

export const HEALTH_CODES = Object.freeze({
  BAD_SPEC: 'health-bad-spec',
  NO_CHECKS: 'health-no-checks',
  TOO_MANY_CHECKS: 'health-too-many-checks',
  NON_LOOPBACK: 'health-non-loopback',
  BAD_PATH: 'health-bad-path',
  BAD_PORT: 'health-bad-port',
  BAD_TIMEOUT: 'health-bad-timeout',
  UNREACHABLE: 'health-unreachable',
  BAD_STATUS: 'health-bad-status',
  BODY_MISMATCH: 'health-body-mismatch',
  TIMEOUT: 'health-timeout',
})

/** 上限。都是为了"不要让一次健康检查变成一次扫描"。 */
export const HEALTH_LIMITS = Object.freeze({
  maxChecks: 16,
  maxTimeoutMs: 60_000,
  minTimeoutMs: 1_000,
  maxBodyBytes: 256 * 1024,
  maxPathLength: 512,
})

function problem(code, message, index = null) {
  return Object.freeze({ code, message, index })
}

/**
 * 从 `product/process-manifest.mjs` 的进程定义派生健康检查。
 *
 * ★ 用**同一份**声明，而不是在别处再写一遍"哪个服务的哪个路径算健康"。
 *   两处声明会漂移，而漂移的表现是"升级成功之后用户发现某个服务是坏的"
 *   ——也就是健康检查通过了它本该拦住的东西。
 *
 * ★ 占位符展开必须是**严格**的，这与 `launcher.mjs` 的 `expandExpectation`
 *   同一条理由：`workbench` 的就绪判据是 `expectJson: { port: '{teamHubPort}' }`，
 *   而一个"未知占位符原样保留"的展开会得到期望值 `"{teamHubPort}"`——
 *   一个**永远不可能成立**的断言，同时它还能顺利通过规格校验。
 *
 *      > 一个把 `{teamHubPort}` 当成期望端口号的健康检查，
 *      > 与一个"这项检查永远失败"的健康检查，是同一个东西——
 *      > 只不过前者看起来是配置好的。
 *
 *   所以这里（与 Launcher 一样）对未知变量**报错**，并且把错误交给调用方：
 *   派生失败时调用方必须走"没有探针"那条 fail-closed 路径，而不是拿一份
 *   带字面占位符的规格去提交升级。
 *
 * @param {object} args
 * @param {ReadonlyArray<object>} args.processes  进程定义（含 `readiness`）
 * @param {Record<string, number>} args.ports     实际端口（key → port）
 * @param {string} [args.host]
 * @param {Record<string, string|number>} [args.vars] 额外上下文（`dataDir`/`install` 等）
 */
export function healthSpecFromProcesses({ processes, ports = {}, host = '127.0.0.1', vars = {} } = {}) {
  const checks = []
  const problems = []
  // 与 `launcher.mjs` 用**同一组**上下文变量名（`teamHubPort` 而不是
  // `team-hub`）：两份清单里的占位符是同一批，展开用不同的名字只会在
  // 某一处悄悄失效。
  const teamHubPort = ports['team-hub'] ?? null
  const context = { teamHubPort, ...ports, ...vars }

  for (const process of processes ?? []) {
    const readiness = process?.readiness
    // 只收 http 类的就绪判定。`kind: 'none'` 的进程（例如某些模式下的白板）
    // 与 `stdout` 类的进程**不进**健康检查：一条"不需要 HTTP 就绪"的声明
    // 不等于"它坏了也无所谓"，而是"它的就绪信号不在 HTTP 上"——那种情况下
    // 编造一个 HTTP 检查比不检查更糟。
    if (readiness?.kind !== 'http') continue
    const port = typeof process.portKey === 'string' ? ports[process.portKey] : process.defaultPort
    if (!Number.isSafeInteger(port)) {
      problems.push(problem(HEALTH_CODES.BAD_PORT, `进程 ${process.key} 没有可用端口，无法派生健康检查`))
      continue
    }
    let expectJson
    if (readiness.expectJson !== undefined) {
      try {
        expectJson = expandStrict(readiness.expectJson, { ...context, port })
      } catch (error) {
        problems.push(problem(HEALTH_CODES.BODY_MISMATCH, `进程 ${process.key} 的就绪判据无法展开：${error?.message ?? error}`))
        continue
      }
    }
    checks.push({
      name: process.key,
      host,
      port,
      path: readiness.path ?? '/',
      method: 'GET',
      expectStatus: readiness.expectStatus ?? 200,
      ...(expectJson === undefined ? {} : { expectJson }),
      ...(readiness.expectMatch === undefined ? {} : { expectMatch: readiness.expectMatch }),
    })
  }

  if (problems.length > 0) {
    return Object.freeze({
      ok: false, code: problems[0].code, reason: problems[0].message,
      problems: Object.freeze(problems), spec: null,
    })
  }
  return Object.freeze({
    ok: true, code: null, reason: null, problems: Object.freeze([]),
    spec: Object.freeze({ protocol: HEALTH_PROTOCOL, checks: Object.freeze(checks) }),
  })
}

/**
 * 严格的占位符展开 —— 语义与 `launcher.mjs` 的 `expandExpectation` 一致。
 *
 * 整串就是一个占位符时返回**原类型**的值（`{ port: '{port}' }` 要得到数字
 * `8787`，而不是字符串 `"8787"`：Launcher 的文件头记着一次真实教训——
 * 字符串与数字严格比较永远不成立，一次误报的 `identity-mismatch` 会把
 * 一个类型问题伪装成一条安全问题）。
 *
 * ★ 必须**递归**走进对象与数组。
 *
 *   就绪判据的形状是 `{ port: '{teamHubPort}' }`——占位符嵌在对象里，
 *   而不是整串就是占位符。一个"只处理字符串、其它原样返回"的实现会把它
 *   整块原样送出去，于是期望端口号是字符串 `"{teamHubPort}"`。
 *   这正是本次实现过程中真的踩到的一步：函数签名看起来对（它确实也只该
 *   处理字符串），但调用点是 `expectJson` 这个对象，于是"严格展开"一次
 *   都没发生——而**只有自检里那条用真实进程清单派生的断言**发现了它。
 */
export function expandStrict(value, vars) {
  if (typeof value === 'string') {
    const whole = /^\{([a-zA-Z0-9_]+)\}$/.exec(value)
    if (whole !== null) {
      const resolved = vars[whole[1]]
      if (resolved === null || resolved === undefined) {
        throw new Error(`期望值「${value}」引用了未知上下文变量 {${whole[1]}}：它会让断言永远不成立`)
      }
      return resolved
    }
    return value.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, name) => {
      const resolved = vars[name]
      if (resolved === null || resolved === undefined) {
        throw new Error(`期望值「${value}」引用了未知上下文变量 {${name}}：它会让断言永远不成立`)
      }
      return String(resolved)
    })
  }
  if (Array.isArray(value)) return value.map((item) => expandStrict(item, vars))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value)) out[key] = expandStrict(value[key], vars)
    return out
  }
  return value
}

/**
 * 校验一份健康检查规格。
 *
 * 每一条判据都在文件头解释了"不这样会怎样"。
 */
export function validateHealthSpec(spec) {
  const problems = []
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    return Object.freeze({
      ok: false, code: HEALTH_CODES.BAD_SPEC, reason: '健康检查规格必须是对象',
      problems: Object.freeze([problem(HEALTH_CODES.BAD_SPEC, '健康检查规格必须是对象')]), checks: null,
    })
  }
  if (spec.protocol !== HEALTH_PROTOCOL) {
    problems.push(problem(HEALTH_CODES.BAD_SPEC, `protocol 必须是 ${HEALTH_PROTOCOL}，实际 ${JSON.stringify(spec.protocol)}`))
  }
  if (!Array.isArray(spec.checks) || spec.checks.length === 0) {
    problems.push(problem(HEALTH_CODES.NO_CHECKS, 'checks 必须是非空数组'))
  } else if (spec.checks.length > HEALTH_LIMITS.maxChecks) {
    problems.push(problem(HEALTH_CODES.TOO_MANY_CHECKS,
      `checks 有 ${spec.checks.length} 项，超过上限 ${HEALTH_LIMITS.maxChecks}（一次健康检查不该变成一次端口扫描）`))
  }

  const checks = []
  for (const [index, raw] of (Array.isArray(spec.checks) ? spec.checks : []).entries()) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push(problem(HEALTH_CODES.BAD_SPEC, '检查项必须是对象', index))
      continue
    }
    const name = typeof raw.name === 'string' && raw.name !== '' ? raw.name : `check-${index}`
    // ★ 只允许回环。见文件头：helper 是权限最高的一段代码，不给它对外发起
    //   任意请求的能力。
    if (!LOOPBACK_HOSTS.includes(raw.host)) {
      problems.push(problem(HEALTH_CODES.NON_LOOPBACK,
        `检查 ${name} 的 host=${JSON.stringify(raw.host)} 不是回环地址（只允许 ${LOOPBACK_HOSTS.join(' / ')}）`, index))
      continue
    }
    if (!Number.isSafeInteger(raw.port) || raw.port < 1 || raw.port > 65535) {
      problems.push(problem(HEALTH_CODES.BAD_PORT, `检查 ${name} 的 port=${JSON.stringify(raw.port)} 不是 1–65535 的整数`, index))
      continue
    }
    const path = typeof raw.path === 'string' && raw.path !== '' ? raw.path : '/'
    if (!path.startsWith('/') || path.includes('..') || path.includes('%') || path.includes('\\')
      || path.length > HEALTH_LIMITS.maxPathLength) {
      problems.push(problem(HEALTH_CODES.BAD_PATH, `检查 ${name} 的 path=${JSON.stringify(path)} 不合法`, index))
      continue
    }
    const timeoutMs = raw.timeoutMs === undefined ? 10_000 : raw.timeoutMs
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < HEALTH_LIMITS.minTimeoutMs || timeoutMs > HEALTH_LIMITS.maxTimeoutMs) {
      problems.push(problem(HEALTH_CODES.BAD_TIMEOUT,
        `检查 ${name} 的 timeoutMs=${JSON.stringify(raw.timeoutMs)} 不在 ${HEALTH_LIMITS.minTimeoutMs}–${HEALTH_LIMITS.maxTimeoutMs} 之间`, index))
      continue
    }
    const expectStatus = raw.expectStatus === undefined ? 200 : raw.expectStatus
    if (!Number.isSafeInteger(expectStatus) || expectStatus < 100 || expectStatus > 599) {
      problems.push(problem(HEALTH_CODES.BAD_STATUS, `检查 ${name} 的 expectStatus=${JSON.stringify(raw.expectStatus)} 不是状态码`, index))
      continue
    }
    if (raw.expectJson !== undefined) {
      if (raw.expectJson === null || typeof raw.expectJson !== 'object' || Array.isArray(raw.expectJson)) {
        problems.push(problem(HEALTH_CODES.BODY_MISMATCH, `检查 ${name} 的 expectJson 必须是对象（要断言的字段子集）`, index))
        continue
      }
    }
    if (raw.expectMatch !== undefined && typeof raw.expectMatch !== 'string') {
      problems.push(problem(HEALTH_CODES.BODY_MISMATCH, `检查 ${name} 的 expectMatch 必须是字符串（正则）`, index))
      continue
    }
    if (typeof raw.expectMatch === 'string') {
      try { new RegExp(raw.expectMatch) } catch (error) {
        problems.push(problem(HEALTH_CODES.BODY_MISMATCH, `检查 ${name} 的 expectMatch 不是合法正则：${error?.message ?? error}`, index))
        continue
      }
    }
    checks.push(Object.freeze({
      name, host: raw.host, port: raw.port, path, method: 'GET', expectStatus, timeoutMs,
      ...(raw.expectJson === undefined ? {} : { expectJson: raw.expectJson }),
      ...(raw.expectMatch === undefined ? {} : { expectMatch: raw.expectMatch }),
    }))
  }

  if (problems.length > 0) {
    const first = problems[0]
    return Object.freeze({
      ok: false, code: first.code, reason: first.message, problems: Object.freeze(problems), checks: null,
    })
  }
  return Object.freeze({
    ok: true, code: null, reason: null, problems: Object.freeze([]),
    checks: Object.freeze(checks),
  })
}

/** URL 由校验过的字段拼出来——**不**接受一个现成的 URL 字符串。 */
export function checkUrl(check) {
  const host = check.host === '::1' ? '[::1]' : check.host
  return `http://${host}:${check.port}${check.path}`
}

/**
 * 把一份**已校验**的规格变成一个探针函数。
 *
 * 返回的函数就是 `product/upgrade/switchover.mjs` 的 `probeHealth` 需要的那种
 * `(signal) => Promise<{ok, detail}>`。所以"声明式"与"函数式"在 helper 里
 * 接上的方式只有一处。
 */
export function createHealthProbe(spec, {
  fetchImpl = globalThis.fetch,
  readFileImpl = (path) => readFileSync(path, 'utf8'),
  timeoutMs = null,
} = {}) {
  const validated = validateHealthSpec(spec)
  if (validated.ok !== true) {
    // ★ 规格不合法时返回一个**恒为不健康**的探针，而不是 null。
    //   返回 null 会让调用方落回"没有探针"分支，而那个分支的处置是
    //   `helper-health-unverified`（"没有证据"）；这里的情况不同：
    //   我们**有**一份规格，只是它是坏的 —— 那是一次明确的配置错误，
    //   应当以"不健康"落地（并尝试回退）。
    return Object.freeze({
      ok: false, code: validated.code, reason: validated.reason,
      probe: async () => Object.freeze({ ok: false, detail: `健康检查规格不合法：${validated.reason}` }),
    })
  }
  const checks = validated.checks
  const probe = async (signal = null) => {
    const failures = []
    const details = []
    for (const check of checks) {
      const budget = Number.isSafeInteger(timeoutMs) ? Math.min(timeoutMs, check.timeoutMs) : check.timeoutMs
      const outcome = await runCheck(check, { fetchImpl, signal, timeoutMs: budget })
      if (outcome.ok) details.push(`${check.name}:ok`)
      else { failures.push(`${check.name}: ${outcome.reason}`); details.push(`${check.name}:FAIL`) }
    }
    if (failures.length === 0) {
      return Object.freeze({ ok: true, detail: details.join(' ') })
    }
    return Object.freeze({ ok: false, detail: `${failures.length}/${checks.length} 项未通过 —— ${failures.join('；')}` })
  }
  return Object.freeze({ ok: true, code: null, reason: null, probe })
}

async function runCheck(check, { fetchImpl, signal, timeoutMs }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onExternalAbort = () => controller.abort()
  if (signal !== null && signal !== undefined) {
    if (signal.aborted) onExternalAbort()
    else signal.addEventListener('abort', onExternalAbort, { once: true })
  }
  try {
    const response = await fetchImpl(checkUrl(check), {
      method: check.method,
      redirect: 'manual',
      // 回环上的健康检查不该走任何缓存。
      headers: { 'cache-control': 'no-store' },
      signal: controller.signal,
    })
    if (response.status !== check.expectStatus) {
      return { ok: false, reason: `HTTP ${response.status}，期望 ${check.expectStatus}` }
    }
    if (check.expectJson !== undefined || check.expectMatch !== undefined) {
      const body = await readBoundedBody(response)
      if (body === null) return { ok: false, reason: `响应体超过 ${HEALTH_LIMITS.maxBodyBytes} 字节或读不出来` }
      if (check.expectJson !== undefined) {
        const mismatch = compareSubset(check.expectJson, body)
        if (mismatch !== null) return { ok: false, reason: mismatch }
      }
      if (check.expectMatch !== undefined) {
        if (!new RegExp(check.expectMatch).test(body.text)) {
          return { ok: false, reason: `响应体不匹配 ${check.expectMatch}` }
        }
      }
    }
    return { ok: true, reason: null }
  } catch (error) {
    const code = controller.signal.aborted ? HEALTH_CODES.TIMEOUT : HEALTH_CODES.UNREACHABLE
    return {
      ok: false,
      reason: code === HEALTH_CODES.TIMEOUT
        ? `超过 ${timeoutMs} 毫秒没有响应`
        : `连不上 ${checkUrl(check)}：${error?.message ?? error}`,
    }
  } finally {
    clearTimeout(timer)
    if (signal !== null && signal !== undefined) signal.removeEventListener('abort', onExternalAbort)
  }
}

async function readBoundedBody(response) {
  try {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > HEALTH_LIMITS.maxBodyBytes) return null
    let json = null
    try { json = JSON.parse(text) } catch { json = null }
    return { text, json }
  } catch {
    return null
  }
}

/**
 * 断言 `expected` 是 `actual` 的一个子集。
 *
 * 子集而不是相等：`/api/config` 的真实响应里还有别的字段，而"它多给了什么"
 * 不是升级该关心的事。关心的是**我们依赖的那几个**对不对。
 */
export function compareSubset(expected, actual) {
  if (actual.json === null) return '响应体不是 JSON，而规格要求断言 JSON 字段'
  const walk = (want, got, path) => {
    if (want !== null && typeof want === 'object' && !Array.isArray(want)) {
      if (got === null || typeof got !== 'object' || Array.isArray(got)) return `${path} 应当是对象`
      for (const key of Object.keys(want)) {
        const problemText = walk(want[key], got[key], path === '' ? key : `${path}.${key}`)
        if (problemText !== null) return problemText
      }
      return null
    }
    if (Array.isArray(want)) {
      if (!Array.isArray(got)) return `${path} 应当是数组`
      if (got.length < want.length) return `${path} 长度 ${got.length} 小于期望 ${want.length}`
      for (let i = 0; i < want.length; i += 1) {
        const problemText = walk(want[i], got[i], `${path}[${i}]`)
        if (problemText !== null) return problemText
      }
      return null
    }
    if (want !== got) return `${path} 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`
    return null
  }
  return walk(expected, actual.json, '')
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

export function selfCheckHealth() {
  const problems = []

  // ① 非回环一律拒（这是本模块最重要的一条）。
  for (const host of ['evil.example', '10.0.0.1', '0.0.0.0', '169.254.169.254', 'localhost.evil.example', '127.0.0.1.evil.example']) {
    const result = validateHealthSpec({ protocol: HEALTH_PROTOCOL, checks: [{ name: 'x', host, port: 80, path: '/' }] })
    if (result.ok) problems.push(`非回环主机被接受了：${host}`)
    else if (result.code !== HEALTH_CODES.NON_LOOPBACK) problems.push(`非回环主机的码是 ${result.code}`)
  }
  // 回环的三种写法都要过。
  for (const host of LOOPBACK_HOSTS) {
    if (!validateHealthSpec({ protocol: HEALTH_PROTOCOL, checks: [{ name: 'x', host, port: 8787, path: '/api/config' }] }).ok) {
      problems.push(`回环主机被拒了：${host}`)
    }
  }

  // ② 路径与端口。
  for (const check of [
    { path: 'relative' }, { path: '/a/../b' }, { path: '/a%2e%2e' }, { path: '/a\\b' }, { path: '/'.repeat(600) },
  ]) {
    if (validateHealthSpec({ protocol: HEALTH_PROTOCOL, checks: [{ name: 'x', host: '127.0.0.1', port: 80, ...check }] }).ok) {
      problems.push(`非法路径被接受了：${JSON.stringify(check.path).slice(0, 40)}`)
    }
  }
  for (const port of [0, -1, 65536, 1.5, '80', null]) {
    if (validateHealthSpec({ protocol: HEALTH_PROTOCOL, checks: [{ name: 'x', host: '127.0.0.1', port, path: '/' }] }).ok) {
      problems.push(`非法端口被接受了：${JSON.stringify(port)}`)
    }
  }

  // ③ 条数上限与空列表。
  if (validateHealthSpec({ protocol: HEALTH_PROTOCOL, checks: [] }).ok) problems.push('空 checks 被接受了')
  const many = Array.from({ length: HEALTH_LIMITS.maxChecks + 1 }, (_, i) => ({ name: `c${i}`, host: '127.0.0.1', port: 80, path: '/' }))
  if (validateHealthSpec({ protocol: HEALTH_PROTOCOL, checks: many }).ok) problems.push('超出条数上限被接受了')

  // ④ 超时窗口。
  for (const timeoutMs of [0, 10, HEALTH_LIMITS.maxTimeoutMs + 1]) {
    if (validateHealthSpec({ protocol: HEALTH_PROTOCOL, checks: [{ name: 'x', host: '127.0.0.1', port: 80, path: '/', timeoutMs }] }).ok) {
      problems.push(`非法超时被接受了：${timeoutMs}`)
    }
  }

  // ⑤ 规格不合法时返回的是"恒不健康"的探针，而不是 null。
  const bad = createHealthProbe({ protocol: 'nope', checks: [] })
  if (bad.ok !== false) problems.push('非法规格被判为可用')
  if (typeof bad.probe !== 'function') problems.push('非法规格没有给出探针函数（调用方会落回"没有探针"分支）')

  // ⑥ 子集比较。
  if (compareSubset({ a: 1 }, { json: { a: 1, b: 2 }, text: '' }) !== null) problems.push('子集比较：多出的字段不该算不符')
  if (compareSubset({ a: 1 }, { json: { a: 2 }, text: '' }) === null) problems.push('子集比较：字段值不符没有被发现')
  if (compareSubset({ a: 1 }, { json: null, text: 'x' }) === null) problems.push('子集比较：非 JSON 响应没有被发现')

  // ⑦ URL 由校验过的字段拼出来。
  if (checkUrl({ host: '127.0.0.1', port: 8787, path: '/api/config' }) !== 'http://127.0.0.1:8787/api/config') {
    problems.push(`checkUrl 不对：${checkUrl({ host: '127.0.0.1', port: 8787, path: '/api/config' })}`)
  }
  if (checkUrl({ host: '::1', port: 80, path: '/' }) !== 'http://[::1]:80/') problems.push('IPv6 回环地址没有加方括号')

  // ⑧ 占位符展开必须严格：未知变量报错，整串占位符保留原类型。
  if (expandStrict('{port}', { port: 8787 }) !== 8787) problems.push('整串占位符没有保留原类型')
  if (expandStrict('http://h:{port}/x', { port: 80 }) !== 'http://h:80/x') problems.push('内嵌占位符没有展开')
  let threw = false
  try { expandStrict('{teamHubPort}', { port: 8787 }) } catch { threw = true }
  if (!threw) problems.push('未知占位符被静默保留了（会变成永远不成立的断言）')
  // ★ 展开必须**递归**走进对象：就绪判据的形状是 `{ port: '{x}' }`，占位符
  //   嵌在对象里。一个只处理字符串的实现会把它整块原样送出去。
  if (expandStrict({ port: '{p}' }, { p: 80 }).port !== 80) {
    problems.push('嵌套在对象里的占位符没有被展开')
  }
  if (expandStrict([{ port: '{p}' }], { p: 80 })[0].port !== 80) {
    problems.push('嵌套在数组里的占位符没有被展开')
  }

  // ⚠️ 「用真实进程清单派生一遍」的那条判据**不在这里**。
  //
  //   它要 import `product/process-manifest.mjs`，而那个文件又 import
  //   `runtime/contracts/model.mjs`——于是本模块（被 helper 的闭包包含）
  //   会多拖一条跨目录依赖进"独立受控目录"。一个"为了自检"而引入的依赖，
  //   和一条真实依赖在打包闭包里长得一样。
  //
  //   那条判据在 `health.test.mjs` 里：它是**跨模块接线**的检证，属于测试，
  //   不属于模块自己的不变量。

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    protocol: HEALTH_PROTOCOL,
    loopbackHosts: LOOPBACK_HOSTS,
    limits: HEALTH_LIMITS,
  })
}

export const HEALTH_CHECKED = selfCheckHealth()
