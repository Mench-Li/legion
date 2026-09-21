// product/launcher/readiness.test.mjs
// ============================================================================
// PRT-701 / PRT-703 就绪判据的判据。
//
// 这一组的重点全在「失败怎么归类」：
//   - `connection-refused` 是**还早**，要继续等；
//   - `identity-mismatch` 是**错了**，再等也不会变好。
// 把两者都当「等超时」会得到两个坏结果：真正的配置错误被拖成 60 秒，
// 而超时文案把排查方向指向「服务太慢」。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createLineCollector,
  expandTemplate,
  isRetryableProbeCode,
  probeOnce,
  probeStdoutOnce,
  readinessResultToDiagnostic,
  waitForReadiness,
  waitForStdoutReadiness,
} from './readiness.mjs'

/** 构造一个返回固定响应的假 fetch。 */
function fakeFetch(response, { throwError = null } = {}) {
  const calls = { count: 0 }
  const fn = async () => {
    calls.count += 1
    if (throwError !== null) throw throwError
    return {
      status: response.status ?? 200,
      text: async () => (typeof response.body === 'string' ? response.body : JSON.stringify(response.body)),
    }
  }
  return { fn, calls }
}

/** 依次返回一组响应的假 fetch（用于轮询场景）。 */
function scriptedFetch(sequence) {
  const calls = { count: 0 }
  const fn = async () => {
    const item = sequence[Math.min(calls.count, sequence.length - 1)]
    calls.count += 1
    if (item.throwError !== undefined) throw item.throwError
    return {
      status: item.status ?? 200,
      text: async () => (typeof item.body === 'string' ? item.body : JSON.stringify(item.body)),
    }
  }
  return { fn, calls }
}

// ---------------------------------------------------------------- probeOnce

test('probeOnce：状态码不符 → http-status-mismatch（不可重试），且带响应片段', async () => {
  const { fn } = fakeFetch({ status: 502, body: 'hub proxy error: connect ECONNREFUSED' })
  const r = await probeOnce({ url: 'http://127.0.0.1:1/x', expectStatus: 200 }, { fetchImpl: fn })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'http-status-mismatch')
  assert.equal(r.retryable, false)
  assert.equal(r.status, 502)
  assert.match(r.bodySnippet, /hub proxy error/)
})

test('probeOnce：身份断言不符 → identity-mismatch，且文案指向「不是我们的实例」', async () => {
  const { fn } = fakeFetch({ status: 200, body: { auth: false, db: 'x', port: 8787 } })
  const r = await probeOnce({ url: 'http://127.0.0.1:1/api/config', expectStatus: 200, expectJson: { port: 51814 } }, { fetchImpl: fn })
  assert.equal(r.code, 'identity-mismatch')
  assert.equal(r.retryable, false)
  assert.match(r.detail, /期望 51814，实际 8787/)
  assert.match(r.detail, /不是本次启动的实例/)
})

test('probeOnce：身份断言通过 → ok，并回报断言了哪些键', async () => {
  const { fn } = fakeFetch({ status: 200, body: { auth: false, db: 'x', port: 51814 } })
  const r = await probeOnce({ url: 'http://127.0.0.1:1/api/config', expectJson: { port: 51814 } }, { fetchImpl: fn })
  assert.equal(r.ok, true)
  assert.equal(r.code, null)
  assert.deepEqual(r.identity, ['port'])
})

test('probeOnce：响应不是 JSON → body-not-json（不可重试，不能让身份断言静默跳过）', async () => {
  const { fn } = fakeFetch({ status: 200, body: '<html>ok</html>' })
  const r = await probeOnce({ url: 'http://127.0.0.1:1/x', expectJson: { ok: true } }, { fetchImpl: fn })
  assert.equal(r.code, 'body-not-json')
  assert.equal(r.retryable, false)
  assert.match(r.bodySnippet, /html/)
})

test('probeOnce：未声明 expectJson 时不解析响应体（HTML 页面也能算就绪）', async () => {
  const { fn } = fakeFetch({ status: 200, body: '<html>x</html>' })
  const r = await probeOnce({ url: 'http://127.0.0.1:1/' }, { fetchImpl: fn })
  assert.equal(r.ok, true)
  assert.equal(r.identity, null)
})

test('probeOnce：连接被拒 → connection-refused（可重试）', async () => {
  const err = new Error('fetch failed')
  err.cause = { code: 'ECONNREFUSED' }
  const { fn } = fakeFetch({}, { throwError: err })
  const r = await probeOnce({ url: 'http://127.0.0.1:1/' }, { fetchImpl: fn })
  assert.equal(r.code, 'connection-refused')
  assert.equal(r.retryable, true)
})

test('probeOnce：真实 undici 的「连接被拒」形态也能识别（不是只认我们伪造的 cause.code）', async () => {
  // 真实错误是 TypeError('fetch failed') + cause{ code:'ECONNREFUSED' }，
  // 但**只在真端口上**才是这个形态：undici 对 1/9 这类端口直接判 "bad port"，
  // 得到一个没有 code 的 cause。用例若用固定端口就会测到那个特例，
  // 于是「连接被拒 → 可重试」这条判据在真实场景下从未被验证。
  const { reserveEphemeralPort } = await import('./ports.mjs')
  const port = await reserveEphemeralPort() // 分配后立刻放开：确定无人监听
  const r = await probeOnce({ url: `http://127.0.0.1:${port}/` }, { fetchImpl: globalThis.fetch, timeoutMs: 3000 })
  assert.equal(r.code, 'connection-refused')
  assert.equal(r.retryable, true)
})

test('probeOnce：超时（AbortError）→ no-response（可重试）', async () => {
  const err = new Error('aborted')
  err.name = 'AbortError'
  const { fn } = fakeFetch({}, { throwError: err })
  const r = await probeOnce({ url: 'http://127.0.0.1:1/' }, { fetchImpl: fn, timeoutMs: 5 })
  assert.equal(r.code, 'no-response')
  assert.equal(r.retryable, true)
})

test('probeOnce：没有可用 fetch 时如实说「无法探测」，不假装通过', async () => {
  // 显式传 null（而不是 undefined）：`{ fetchImpl: undefined }` 会命中默认参数
  // `globalThis.fetch`，于是这条用例会去发一次真实请求，测的就不是它想测的东西。
  const r = await probeOnce({ url: 'http://127.0.0.1:1/' }, { fetchImpl: null })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'no-response')
  assert.match(r.detail, /没有可用的 fetch/)
})

// ---------------------------------------------------------------- waitForReadiness

test('waitForReadiness：先拒后通 → 成功，并记录每一次尝试', async () => {
  const err = new Error('fetch failed')
  err.cause = { code: 'ECONNREFUSED' }
  const { fn, calls } = scriptedFetch([
    { throwError: err },
    { throwError: err },
    { status: 200, body: { ok: true } },
  ])
  const slept = []
  let t = 0
  const r = await waitForReadiness({ url: 'http://x/', expectJson: { ok: true } }, {
    fetchImpl: fn,
    sleep: async (ms) => { slept.push(ms); t += ms },
    now: () => t,
    intervalMs: 100,
    timeoutMs: 5000,
  })
  assert.equal(r.ok, true)
  assert.equal(calls.count, 3)
  assert.deepEqual(r.attempts.map((a) => a.code), ['connection-refused', 'connection-refused', null])
  assert.deepEqual(slept, [100, 100])
})

test('waitForReadiness：身份不符立刻返回，**不做任何重试与等待**', async () => {
  const { fn, calls } = scriptedFetch([{ status: 200, body: { port: 8787 } }])
  let slept = 0
  let t = 0
  const r = await waitForReadiness({ url: 'http://x/', expectJson: { port: 1 } }, {
    fetchImpl: fn,
    sleep: async (ms) => { slept += 1; t += ms },
    now: () => t,
    timeoutMs: 60000,
  })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'identity-mismatch')
  assert.equal(calls.count, 1, '身份不符只探一次：重试这个动作本身在暗示它会变好')
  assert.equal(slept, 0)
})

test('waitForReadiness：一直拒绝 → readiness-timeout，且最后一次原因在详情里', async () => {
  const err = new Error('fetch failed')
  err.cause = { code: 'ECONNREFUSED' }
  const { fn } = scriptedFetch([{ throwError: err }])
  let t = 0
  const r = await waitForReadiness({ url: 'http://x/' }, {
    fetchImpl: fn,
    sleep: async (ms) => { t += ms },
    now: () => t,
    intervalMs: 200,
    timeoutMs: 1000,
  })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'readiness-timeout')
  assert.match(r.detail, /最后一次探测为 connection-refused/)
  assert.ok(r.attempts.length >= 5, `实际尝试 ${r.attempts.length} 次`)
})

test('waitForReadiness：不睡过 deadline（30s 的承诺不能变成 30.25s）', async () => {
  const err = new Error('fetch failed')
  err.cause = { code: 'ECONNREFUSED' }
  const { fn } = scriptedFetch([{ throwError: err }])
  const slept = []
  let t = 0
  const r = await waitForReadiness({ url: 'http://x/' }, {
    fetchImpl: fn,
    sleep: async (ms) => { slept.push(ms); t += ms },
    now: () => t,
    intervalMs: 250,
    timeoutMs: 300,
  })
  assert.equal(r.code, 'readiness-timeout')
  assert.ok(Math.max(...slept) <= 250)
  assert.ok(t <= 300 + 1, `实际经过 ${t}ms`)
})

test('waitForReadiness：进程已退出则不必把超时等满（最常见的假超时）', async () => {
  const err = new Error('fetch failed')
  err.cause = { code: 'ECONNREFUSED' }
  const { fn, calls } = scriptedFetch([{ throwError: err }])
  let t = 0
  let probes = 0
  const r = await waitForReadiness({ url: 'http://x/' }, {
    fetchImpl: fn,
    sleep: async (ms) => { t += ms },
    now: () => t,
    intervalMs: 50,
    timeoutMs: 60000,
    isProcessAlive: () => { probes += 1; return probes <= 2 },
  })
  assert.equal(r.code, 'process-exited')
  assert.ok(t < 1000, `实际等了 ${t}ms`)
  assert.ok(calls.count <= 3)
})

test('waitForReadiness：外部取消 → cancelled，不再探测', async () => {
  const controller = new AbortController()
  const err = new Error('fetch failed')
  err.cause = { code: 'ECONNREFUSED' }
  const { fn } = scriptedFetch([{ throwError: err }])
  let t = 0
  const r = await waitForReadiness({ url: 'http://x/' }, {
    fetchImpl: fn,
    sleep: async (ms) => { t += ms; controller.abort() },
    now: () => t,
    intervalMs: 50,
    timeoutMs: 60000,
    signal: controller.signal,
  })
  assert.equal(r.code, 'cancelled')
})

// ---------------------------------------------------------------- 诊断转换

test('readinessResultToDiagnostic：就绪是 warn（不是错误），未就绪是 error 且码按原因分派', () => {
  const ok = readinessResultToDiagnostic('team-hub', { url: 'http://x/api/config', expectJson: { port: 1 } },
    { ok: true, code: null, attempts: [1, 2], elapsedMs: 320 })
  assert.equal(ok.severity, 'warn')
  assert.equal(ok.code, 'READINESS_VERIFIED')
  assert.equal(ok.attempts, 2)
  assert.match(ok.message, /320ms/)
  assert.match(ok.message, /身份断言：port/)

  const mismatch = readinessResultToDiagnostic('workbench', { url: 'http://x/' },
    { ok: false, code: 'identity-mismatch', attempts: [1], elapsedMs: 12, last: { detail: '来自其他进程' } })
  assert.equal(mismatch.code, 'READINESS_IDENTITY_MISMATCH')
  assert.match(mismatch.message, /来自其他进程/)

  const timeout = readinessResultToDiagnostic('x', { url: 'http://x/' },
    { ok: false, code: 'readiness-timeout', attempts: [], elapsedMs: 30000, detail: '30s 内未就绪' })
  assert.equal(timeout.code, 'READINESS_TIMEOUT')

  const exited = readinessResultToDiagnostic('x', { url: 'http://x/' }, { ok: false, code: 'process-exited', attempts: [], elapsedMs: 5 })
  assert.equal(exited.code, 'PROCESS_EXITED_BEFORE_READY')
})

test('expandTemplate / isRetryableProbeCode：占位符与重试分类的口径', () => {
  assert.equal(expandTemplate('{install}/x/{port}', { install: 'C:\\L', port: 1 }), 'C:\\L/x/1')
  assert.equal(expandTemplate('{unknown}', {}), '{unknown}', '未知占位符原样保留，不静默吞掉')
  assert.deepEqual(expandTemplate({ a: '{port}' }, { port: 2 }), { a: '2' })
  assert.equal(isRetryableProbeCode('connection-refused'), true)
  assert.equal(isRetryableProbeCode('identity-mismatch'), false)
  assert.equal(isRetryableProbeCode(null), false)
})

// ============================================================================
// PRT-251 续 ③ §4：`kind: 'stdout'` 就绪判据
//
// 这个判据存在的**唯一理由**由下面 ★★★★★ 那条钉着：DSH 的 Web 面对任何
// 未认证请求都答 401，所以「端口通了 + `/` 返回 200」在 DSH 上永远不成立；
// 而对 `/` 答 200 的服务又能让那条判据**通过**——两个方向都是错的。
// ============================================================================

// ★ 子进程的源码**内联在这里**，运行时写进临时目录。
//
//   一开始它放在 `scratch/` 下——那是**未跟踪**的目录。一个依赖未跟踪文件的用例
//   在本机全绿、在 CI（或任何干净检出）上**必然找不到它**：
//
//     > 一个只在作者机器上跑得过的用例，
//     > 与一个没写的用例，在"CI 到底验了什么"这件事上是同一个东西——
//     > 只不过前者的报告是绿的。
//
//   `runtime-contract-wiring.test.mjs` 的替身也是这么处理的（写进临时目录）。
const CHILD_SRC = `
import { createServer } from 'node:http'
const port = Number(process.argv[2] ?? 0)
const secret = process.argv[3] ?? 'S3CRET-LAUNCH-TOKEN'
const server = createServer((req, res) => {
  // 与 DSH 一致：**任何**未认证请求都得到同一个最小的 401。
  // 连 \`/\` 也是——这正是旧判据 \`path:'/', expectStatus:200\` 的死因。
  res.writeHead(401, { 'content-type': 'text/plain' })
  res.end('unauthorized')
})
server.listen(port, '127.0.0.1', () => {
  const actual = server.address().port
  process.stdout.write('booting…\\n')
  process.stdout.write('dsh web: http://127.0.0.1:' + actual + '/?token=' + secret + '\\n')
})
process.on('SIGTERM', () => { server.close(() => process.exit(0)) })
`

/** 把子进程源码写进一个新的临时目录，返回其路径与清理函数。 */
function writeChildScript() {
  const dir = mkdtempSync(join(tmpdir(), 'legion-readiness-child-'))
  const file = join(dir, 'dsh-like.mjs')
  writeFileSync(file, CHILD_SRC)
  return { file, done: () => rmSync(dir, { recursive: true, force: true }) }
}

/**
 * 起一个**真的子进程**：它像 DSH 那样做两件事——
 *   ① 在 `/` 上答 **401**（未认证一律最小 401）；
 *   ② 在 stdout 上打出 `dsh web: http://127.0.0.1:<真实端口>/?token=<凭证>`。
 *
 * 一个探针同时具备这两面，才能把「为什么不能探测 HTTP」与「为什么 stdout 可以」
 * 放在**同一次真实启动**上比出来——分成两个伪造对象的话，
 * 两条判据的差别就只是我在测试里写的两段文字。
 */
function startDshLikeChild({ port = 0, secret = 'S3CRET-LAUNCH-TOKEN' } = {}) {
  const script = writeChildScript()
  const child = spawn(process.execPath, [script.file, String(port), secret], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const collector = createLineCollector()
  child.stdout.on('data', (c) => collector.push('runtime', 'stdout', c))
  child.stderr.on('data', (c) => collector.push('runtime', 'stderr', c))
  return { child, collector, done: script.done }
}

/** 等子进程报出端口（它监听成功后才打那一行）。 */
function waitForReportedPort(collector, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const began = Date.now()
    const tick = () => {
      const r = probeStdoutOnce(
        { expectMatch: '^dsh web:\\s+(https?://\\S+)', portGroup: 1 },
        { lines: collector.linesFor('runtime', 'stdout') },
      )
      if (r.ok === true) return resolve(r.port)
      if (Date.now() - began > timeoutMs) return reject(new Error('子进程一直没有报出端口'))
      setTimeout(tick, 50)
    }
    tick()
  })
}

/** 杀掉子进程、等它退出、清掉临时目录。 */
async function disposeChild(child, done) {
  child.kill()
  await new Promise((r) => child.once('exit', r))
  done()
}

test('⑯ ★★★★★ 真子进程：stdout 判据认得那一行，而 HTTP 判据对**同一个进程**永远不通过', async () => {
  const { child, collector, done } = startDshLikeChild()
  try {
    const url = await waitForReportedPort(collector)

    // ── 方向一：stdout 判据 ────────────────────────────────────────────
    const viaStdout = await waitForStdoutReadiness(
      { expectMatch: '^dsh web:\\s+(https?://\\S+)', portGroup: 1 },
      {
        lines: () => collector.linesFor('runtime', 'stdout'),
        plannedPort: url,
        timeoutMs: 5000,
        intervalMs: 20,
      },
    )
    assert.equal(viaStdout.ok, true, '真子进程打了那一行，stdout 判据却没通')
    assert.equal(viaStdout.last.port, url, '判据取到的端口不是它报的那个')

    // ── 方向二：HTTP 判据对**同一个**进程 ─────────────────────────────
    const viaHttp = await waitForReadiness(
      { url: `http://127.0.0.1:${url}/`, expectStatus: 200 },
      { timeoutMs: 3000, intervalMs: 20, probeTimeoutMs: 1000 },
    )
    assert.equal(viaHttp.ok, false, '对 / 答 401 的进程被判成就绪了——那 DSH 之外的东西也能冒充它')
    assert.equal(viaHttp.code, 'http-status-mismatch')
    // ★ 最要紧的一格：401 **不可重试** ⇒ 旧判据在真实 DSH 上不是"慢"，是**立刻熔断**。
    //   把这一格单独钉住，是因为"它只是会超时"与"它会立刻熔断"在
    //   "启动失败"这个读数上一样，而排查方向完全不同。
    assert.equal(viaHttp.retryable, false, '401 被判成可重试了——那它会被拖满 120 秒才失败')

    // ── 方向三：**凭证不许进诊断/状态** ─────────────────────────────────
    //   `redactText()` 的「URL 内嵌凭证」只认 `user:pass@`，**不认 `?token=`**，
    //   所以保护只能来自"我们根本不把那一行带出来"（详见用例 ㉑）。
    const diag = readinessResultToDiagnostic('runtime',
      { kind: 'stdout', url: null, stream: 'stdout', matchedPattern: '^dsh web:\\s+(https?://\\S+)' },
      viaStdout)
    assert.ok(!JSON.stringify(diag).includes('S3CRET-LAUNCH-TOKEN'),
      `诊断里带出了启动令牌：${JSON.stringify(diag)}`)
    // 注意是 `stdout:/<模式>/`（单斜杠 + 模式自身的 `^`），不是 `stdout://`——
    // 写成后者这条断言会恒假，而它看起来仍在"检查诊断文案"。
    assert.match(diag.message, /stdout:\/\^/, '诊断必须说清量的是哪条模式（报 null 等于没信息）')
    assert.equal(diag.severity, 'warn')
  } finally {
    await disposeChild(child, done)
  }
})

test('⑰ ★★★ 子进程报告的端口与计划不符 ⇒ identity-mismatch（`--port` 那条链的机器判据）', async () => {
  const { child, collector, done } = startDshLikeChild()
  try {
    const url = await waitForReportedPort(collector)
    // 计划里是另一个端口 ⇒ 说明 `--port` **没有**到达它。
    // 这一格是 ③ 整条链的落点：不是"我们看到 argv 里有 --port"，
    // 而是"它按那个端口起来了"。
    const wrong = await waitForStdoutReadiness(
      { expectMatch: '^dsh web:\\s+(https?://\\S+)', portGroup: 1 },
      { lines: () => collector.linesFor('runtime', 'stdout'), plannedPort: url + 1, timeoutMs: 2000, intervalMs: 20 },
    )
    assert.equal(wrong.ok, false, '端口对不上却判成就绪了')
    assert.equal(wrong.code, 'identity-mismatch')
    assert.equal(wrong.retryable, false, '端口对不上是"错了"，不是"还早"——等下去不会变好')
    assert.match(wrong.last.detail, /没有真的到达它/)

    // 反面控制：同一个读数，端口写对就通过。否则上面那条可能只是"它一直失败"。
    const right = await waitForStdoutReadiness(
      { expectMatch: '^dsh web:\\s+(https?://\\S+)', portGroup: 1 },
      { lines: () => collector.linesFor('runtime', 'stdout'), plannedPort: url, timeoutMs: 2000, intervalMs: 20 },
    )
    assert.equal(right.ok, true, '端口写对反而不通——那上面那条不是在验端口')
  } finally {
    await disposeChild(child, done)
  }
})

test('⑱ ★★★ 重启后**不认上一代的那一行**（否则假就绪：上一代报过 ≠ 这一代起来了）', () => {
  const collector = createLineCollector()
  const crit = { expectMatch: '^dsh web:\\s+(https?://\\S+)', portGroup: 1 }

  collector.push('runtime', 'stdout', 'dsh web: http://127.0.0.1:3081/?token=OLD\n')
  assert.equal(probeStdoutOnce(crit, { lines: collector.linesFor('runtime', 'stdout') }).ok, true)

  // Launcher 在每次 spawn 之前调它。
  collector.clear('runtime')
  const after = probeStdoutOnce(crit, { lines: collector.linesFor('runtime', 'stdout') })
  assert.equal(after.ok, false, '上一代留的那一行还在——重启后的就绪是假的')
  assert.equal(after.code, 'no-response')
  assert.equal(after.retryable, true, '还没说话是"还早"，要接着等')

  // 新的一代说话之后，只认新的那行（端口也要跟着变）
  collector.push('runtime', 'stdout', 'dsh web: http://127.0.0.1:3099/?token=NEW\n')
  const fresh = probeStdoutOnce(crit, { lines: collector.linesFor('runtime', 'stdout'), plannedPort: 3099 })
  assert.equal(fresh.ok, true)
  assert.equal(fresh.port, 3099)
})

test('⑲ ★★ 行缓冲有界（一个只写不换行的子进程不许把它撑成内存事故）', () => {
  const collector = createLineCollector({ maxLines: 3, maxLineBytes: 64 })
  for (let i = 0; i < 10; i += 1) collector.push('p', 'stdout', `line-${i}\n`)
  const lines = collector.linesFor('p', 'stdout')
  assert.equal(lines.length, 3, '只留最近 maxLines 行')
  assert.deepEqual(lines, ['line-7', 'line-8', 'line-9'], '留的必须是**最近**的，不是最早的')

  // 没有换行的尾巴也要有界
  collector.push('q', 'stdout', 'x'.repeat(500))
  assert.equal(collector.linesFor('q', 'stdout').length, 0, '没有换行就不该冒充一整行')
  // 再来一个换行，那一行必须是**被截断**的（长度有界）
  collector.push('q', 'stdout', '\n')
  const got = collector.linesFor('q', 'stdout')
  assert.equal(got.length, 1)
  assert.ok(got[0].length <= 65, `单行没有截断：${got[0].length}`)
})

test('⑳ ★★ 清单里 runtime 的就绪判据是 stdout，**不再是**对 `/` 的 200 断言', async () => {
  const { PROCESS_SPECS } = await import('../process-manifest.mjs')
  const runtime = PROCESS_SPECS.find((p) => p.key === 'runtime')
  assert.equal(runtime.readiness.kind, 'stdout',
    'runtime 又变回 HTTP 判据了——那它在真实 DSH 上永远不可能通过')
  // 反面：其余带端口的进程**仍然**是 http（别把这条改法扩散出去）
  const hub = PROCESS_SPECS.find((p) => p.key === 'team-hub')
  assert.equal(hub.readiness.kind, 'http')
  // 判据必须能表达"那一行"：正则要能编译，且不把别的行也算进来
  const re = new RegExp(runtime.readiness.expectMatch)
  assert.match('dsh web: http://127.0.0.1:3081/?token=abc', re)
  // ★ DSH 里紧挨着的那一行也以 `dsh web: ` 开头（源码 line 274，
  //   开浏览器时打的提示），而且它在 `printUrl` 为假、`handoffBrowser` 为真时
  //   **仍然会打**。判据若只锚 `^dsh web:` 而不要求后面跟 URL，
  //   就会在"URL 那一行没打出来"的时候被这一行满足——**假就绪**。
  assert.doesNotMatch('dsh web: opening the default browser; pass --no-open to disable', re,
    '把开浏览器的提示行当成就绪了——那一行在 URL 行没打出来时也会出现')
  assert.doesNotMatch('listening on 3081', re, '别的行不该满足它')
  // 带 LAN 后缀时取的是**前一个**（回环）URL，不是 LAN 那个
  const withLan = re.exec('dsh web: http://127.0.0.1:3081/?token=abc (LAN: http://10.0.0.5:3081/?token=abc)')
  assert.equal(withLan[1], 'http://127.0.0.1:3081/?token=abc')
})

test('㉑ ★★★★ 读数里**不许**带出匹配到的那一行（启动令牌不能随诊断/状态外泄）', async () => {
  const collector = createLineCollector()
  const secret = 'S3CRET-LAUNCH-TOKEN'
  collector.push('runtime', 'stdout', `dsh web: http://127.0.0.1:3081/?token=${secret}\n`)

  const crit = { expectMatch: '^dsh web:\\s+(https?://\\S+)', portGroup: 1 }
  const r = probeStdoutOnce(crit, { lines: collector.linesFor('runtime', 'stdout'), plannedPort: 3081 })
  assert.equal(r.ok, true)
  assert.ok(!JSON.stringify(r).includes(secret),
    `探针读数里带出了启动令牌：${JSON.stringify(r)}`)

  // ★ 这一条不是多余的：共享的 `redactText()` 的「URL 内嵌凭证」
  //   只认 `user:pass@` 形态，**不认查询串里的 `?token=`**
  //   （`runtime/contracts/redact-patterns.mjs` 的 `SECRET_VALUE_PATTERNS`）。
  //   所以"日志脱敏"那道闸**拦不住**这一行——保护只能来自
  //   "我们根本不把它带出来"。下面这条断言把那个事实钉住，
  //   免得有人以为"反正有脱敏"而把整行加进诊断。
  const { redactText } = await import('../../runtime/contracts/redact-patterns.mjs')
  const redacted = redactText(`dsh web: http://127.0.0.1:3081/?token=${secret}`)
  assert.ok(redacted.text.includes(secret),
    '脱敏居然认了 `?token=`——那这条用例的前提变了，请重新评估上面那条断言')

  // 诊断文案里同样不许有它。
  // 注意要补 `attempts`/`elapsedMs`：`readinessResultToDiagnostic` 吃的是
  // **等待结果**的形态（`waitForProbe` 的产物），而 `probeStdoutOnce` 只是
  // 一轮探测——把后者直接喂进去会 TypeError，而那条错误看起来像
  // "诊断函数坏了"，不是"我喂错了形状"。
  const diag = readinessResultToDiagnostic('runtime',
    { kind: 'stdout', url: null, stream: 'stdout', matchedPattern: crit.expectMatch },
    { ...r, attempts: [1], elapsedMs: 0 })
  assert.ok(!JSON.stringify(diag).includes(secret), '诊断里带出了启动令牌')
})

test('㉒ ★★★ Launcher 在**每次 spawn 之前**清掉那个进程的行缓冲（源级钉子）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./launcher.mjs', import.meta.url), 'utf8')

  // ★ 为什么这条是**源级**的：`outputLines.clear(proc.key)` 的调用点在 `start()`
  //   的 spawn 循环里，要行为化地验它，得让一个真的 DSH 先报一次就绪、
  //   再崩掉、再重启——那需要一份真的 DSH 检出与几十秒。
  //   而它**必须**被某个东西钉住：删掉那一句时，
  //   套件里其余用例**全绿**（`createLineCollector.clear` 自己有用例，
  //   但"有没有人调它"是另一件事）。
  //
  //   > 一个能力齐全、测试全绿、而没有任何生产代码调用它的函数，
  //   > 与一个不存在的函数，在部署上是同一个东西。
  const loopAt = src.indexOf('for (const proc of waveProcs) {')
  assert.ok(loopAt > 0, '锚点漂了：找不到 spawn 循环，这条用例会验不到东西')
  const spawnLoop = src.slice(loopAt, loopAt + 1200)
  assert.match(spawnLoop, /outputLines\.clear\(proc\.key\)/,
    'spawn 循环里没有清行缓冲——重启后会拿上一代那一行当成就绪')
  assert.match(spawnLoop, /\.start\(\)/,
    '锚点漂了：这段已经不是 spawn 循环，请重新对准（否则这条用例在验一段无关的代码）')
})
