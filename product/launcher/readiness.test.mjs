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

import { expandTemplate, isRetryableProbeCode, probeOnce, readinessResultToDiagnostic, waitForReadiness } from './readiness.mjs'

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
