// product/update/health.test.mjs
// ============================================================================
// 健康验证的回归 —— 以及"派生接得上真实进程清单"这条**跨模块**判据
//
// 这个文件里最值钱的用例是「用真实 `PROCESS_SPECS` 派生一遍」。
// 它守的不是本模块的逻辑，而是**两个文件之间的契约**：
// `process-manifest.mjs` 用 `{teamHubPort}` 这样的占位符写就绪判据，
// 而本模块负责展开它。
//
// 写这一节时真的踩到了：`expandStrict` 只处理字符串，而调用点传进去的是
// `{ port: '{teamHubPort}' }` 这个**对象**——于是"严格展开"一次都没发生，
// 期望端口号是字面量 `"{teamHubPort}"`。自检（当时还在模块里）抓住了它。
//
// 现在那条判据在这里，原因见 `health.mjs` 自检末尾的注释：它需要 import
// 进程清单，而那份清单又会 import `runtime/contracts/`——一份"为了自检"
// 引入的依赖与一条真实依赖在打包闭包里长得一样。
// ============================================================================

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  HEALTH_CODES, HEALTH_LIMITS, HEALTH_PROTOCOL, LOOPBACK_HOSTS, checkUrl, compareSubset,
  createHealthProbe, expandStrict, healthSpecFromProcesses, validateHealthSpec,
} from './health.mjs'
import { DEFAULT_PORTS, PROCESS_SPECS } from '../process-manifest.mjs'

function spec(checks) {
  return { protocol: HEALTH_PROTOCOL, checks }
}

function check(overrides = {}) {
  return { name: 'x', host: '127.0.0.1', port: 8787, path: '/api/config', ...overrides }
}

// ---------------------------------------------------------------------------
// ① 只允许回环
// ---------------------------------------------------------------------------

test('★ 非回环主机一律拒绝（helper 不该获得对外发请求的能力）', () => {
  const rejected = [
    'evil.example',
    'localhost.evil.example',   // 前缀伪装
    '127.0.0.1.evil.example',   // 后缀伪装
    '10.0.0.1',
    '0.0.0.0',
    '169.254.169.254',          // 云元数据
    '192.168.1.1',
    '::ffff:127.0.0.1',         // IPv4 映射写法：**不在**白名单里
  ]
  for (const host of rejected) {
    const result = validateHealthSpec(spec([check({ host })]))
    assert.equal(result.ok, false, `${host} 被接受了`)
    assert.equal(result.code, HEALTH_CODES.NON_LOOPBACK, `${host} 的错误码是 ${result.code}`)
  }
})

test('回环的三种写法都接受', () => {
  for (const host of LOOPBACK_HOSTS) {
    assert.equal(validateHealthSpec(spec([check({ host })])).ok, true, `${host} 被拒了`)
  }
})

test('URL 由校验过的字段拼出来，IPv6 加方括号', () => {
  assert.equal(checkUrl(check()), 'http://127.0.0.1:8787/api/config')
  assert.equal(checkUrl(check({ host: '::1', port: 80, path: '/' })), 'http://[::1]:80/')
})

// ---------------------------------------------------------------------------
// ② 路径 / 端口 / 超时 / 条数
// ---------------------------------------------------------------------------

test('★ 路径必须绝对、不含穿越与编码', () => {
  for (const path of ['relative', '/a/../b', '/a%2e%2e', '/a\\b', '/'.repeat(600)]) {
    const result = validateHealthSpec(spec([check({ path })]))
    assert.equal(result.ok, false, `路径被接受了：${JSON.stringify(path).slice(0, 40)}`)
  }
  for (const path of ['/', '/api/config', '/healthz', '/a/b/c?x=1']) {
    assert.equal(validateHealthSpec(spec([check({ path })])).ok, true, `路径被拒了：${path}`)
  }
  // 空/缺省路径是**合法的**，落到 `/`：就绪判据里"根路径"是常见情形，
  // 而要求每一处都写 `'/'` 只会让调用方多写一个字符。
  const defaulted = validateHealthSpec(spec([check({ path: undefined })]))
  assert.equal(defaulted.ok, true)
  assert.equal(defaulted.checks[0].path, '/')
})

test('端口必须是 1–65535 的整数', () => {
  for (const port of [0, -1, 65536, 1.5, '80', null, undefined]) {
    assert.equal(validateHealthSpec(spec([check({ port })])).ok, false, `端口被接受了：${JSON.stringify(port)}`)
  }
  for (const port of [1, 80, 8787, 65535]) {
    assert.equal(validateHealthSpec(spec([check({ port })])).ok, true, `端口被拒了：${port}`)
  }
})

test('超时窗口有上下限（没有超时的健康检查不是"更宽松"，而是"会挂起"）', () => {
  for (const timeoutMs of [0, 10, HEALTH_LIMITS.maxTimeoutMs + 1]) {
    assert.equal(validateHealthSpec(spec([check({ timeoutMs })])).ok, false, `超时被接受了：${timeoutMs}`)
  }
})

test('条数上限：一次健康检查不该变成一次端口扫描', () => {
  assert.equal(validateHealthSpec(spec([])).ok, false)
  const many = Array.from({ length: HEALTH_LIMITS.maxChecks + 1 }, (_, i) => check({ name: `c${i}` }))
  const result = validateHealthSpec(spec(many))
  assert.equal(result.ok, false)
  assert.equal(result.code, HEALTH_CODES.TOO_MANY_CHECKS)
})

test('断言字段的形状也要校验', () => {
  assert.equal(validateHealthSpec(spec([check({ expectJson: 'not-an-object' })])).ok, false)
  assert.equal(validateHealthSpec(spec([check({ expectMatch: '(' })])).ok, false, '非法正则应被拒')
  assert.equal(validateHealthSpec(spec([check({ expectJson: { port: 1 }, expectMatch: '^dsh web:' })])).ok, true)
})

// ---------------------------------------------------------------------------
// ③ 探针行为
// ---------------------------------------------------------------------------

/** 一个按 URL 返回响应的 fetch 替身。 */
function fetchStub(routes) {
  const calls = []
  async function stub(url, options = {}) {
    calls.push({ url, options })
    const route = routes[url]
    if (route === undefined) throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' })
    if (typeof route === 'function') return route(url, options)
    return {
      status: route.status ?? 200,
      async text() { return route.text ?? '' },
    }
  }
  stub.calls = calls
  return stub
}

test('全部通过 → ok: true', async () => {
  const fetchImpl = fetchStub({
    'http://127.0.0.1:8787/api/config': { status: 200, text: JSON.stringify({ auth: true, db: 'x', port: 8787 }) },
    'http://127.0.0.1:8080/healthz': { status: 200, text: JSON.stringify({ ok: true }) },
  })
  const probe = createHealthProbe(spec([
    check({ name: 'team-hub', expectJson: { port: 8787 } }),
    check({ name: 'whiteboard', port: 8080, path: '/healthz', expectJson: { ok: true } }),
  ]), { fetchImpl })
  assert.equal(probe.ok, true, probe.reason)
  const result = await probe.probe(null)
  assert.equal(result.ok, true, result.detail)
  assert.match(result.detail, /team-hub:ok/)
})

test('★ 身份断言：端口不符即不健康（只检查 200 会认下旧实例）', async () => {
  // 旧的实例还活着并应答 200，但它的 port 字段不是我们这次启动的端口。
  const fetchImpl = fetchStub({
    'http://127.0.0.1:8787/api/config': { status: 200, text: JSON.stringify({ port: 9999 }) },
  })
  const probe = createHealthProbe(spec([check({ name: 'team-hub', expectJson: { port: 8787 } })]), { fetchImpl })
  const result = await probe.probe(null)
  assert.equal(result.ok, false, '端口不符被判为健康')
  assert.match(result.detail, /port 期望 8787，实际 9999/)
})

test('状态码不符 → 不健康，且理由带实际状态', async () => {
  const fetchImpl = fetchStub({ 'http://127.0.0.1:8787/api/config': { status: 503, text: '' } })
  const probe = createHealthProbe(spec([check()]), { fetchImpl })
  const result = await probe.probe(null)
  assert.equal(result.ok, false)
  assert.match(result.detail, /HTTP 503，期望 200/)
})

test('连不上 → 不健康（未监听的服务就是没起来）', async () => {
  const fetchImpl = fetchStub({})
  const probe = createHealthProbe(spec([check()]), { fetchImpl })
  const result = await probe.probe(null)
  assert.equal(result.ok, false)
  assert.match(result.detail, /连不上/)
})

test('expectMatch 用正则断言响应体（例如 DSH 的 URL 行）', async () => {
  const fetchImpl = fetchStub({
    'http://127.0.0.1:3080/': { status: 200, text: 'dsh web: http://127.0.0.1:3080/ ready' },
  })
  const okProbe = createHealthProbe(spec([check({ port: 3080, path: '/', expectMatch: '^dsh web:\\s+(https?://\\S+)' })]), { fetchImpl })
  assert.equal((await okProbe.probe(null)).ok, true)
  const badProbe = createHealthProbe(spec([check({ port: 3080, path: '/', expectMatch: '^nope' })]), { fetchImpl })
  const bad = await badProbe.probe(null)
  assert.equal(bad.ok, false)
  assert.match(bad.detail, /不匹配/)
})

test('★ 超时：挂住的检查必须被判为不健康，而不是让升级一直等', async () => {
  const fetchImpl = fetchStub({
    // 一个永不 resolve 的请求，通过 signal 感知取消。
    'http://127.0.0.1:8787/api/config': (url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
      }, { once: true })
    }),
  })
  const probe = createHealthProbe(spec([check({ timeoutMs: 1000 })]), { fetchImpl })
  const result = await probe.probe(null)
  assert.equal(result.ok, false)
  assert.match(result.detail, /没有响应/)
})

test('一项失败就把整体判为不健康，且理由列出每一失败项', async () => {
  const fetchImpl = fetchStub({
    'http://127.0.0.1:8787/api/config': { status: 200, text: JSON.stringify({ port: 8787 }) },
    'http://127.0.0.1:8080/healthz': { status: 500, text: '' },
  })
  const probe = createHealthProbe(spec([
    check({ name: 'team-hub', expectJson: { port: 8787 } }),
    check({ name: 'whiteboard', port: 8080, path: '/healthz' }),
  ]), { fetchImpl })
  const result = await probe.probe(null)
  assert.equal(result.ok, false)
  assert.match(result.detail, /1\/2 项未通过/)
  assert.match(result.detail, /whiteboard/)
})

test('★ 规格不合法时给出的是"恒不健康"的探针，而不是 null', () => {
  const bad = createHealthProbe({ protocol: 'nope', checks: [] })
  assert.equal(bad.ok, false)
  // 返回 null 会让调用方落回"没有探针"分支，而这两种情况的处置不同：
  // 这是明确的配置错误，应当以"不健康"落地。
  assert.equal(typeof bad.probe, 'function')
})

test('外部取消（回滚时）能让探针立刻结束', async () => {
  const fetchImpl = fetchStub({
    'http://127.0.0.1:8787/api/config': (url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      }, { once: true })
    }),
  })
  const probe = createHealthProbe(spec([check({ timeoutMs: 30_000 })]), { fetchImpl })
  const controller = new AbortController()
  const pending = probe.probe(controller.signal)
  controller.abort()
  const result = await pending
  assert.equal(result.ok, false)
})

// ---------------------------------------------------------------------------
// ④ 子集比较
// ---------------------------------------------------------------------------

test('子集比较：多出的字段不算不符，缺的/值不对的算', () => {
  assert.equal(compareSubset({ a: 1 }, { json: { a: 1, b: 2 }, text: '' }), null)
  assert.match(compareSubset({ a: 1 }, { json: { a: 2 }, text: '' }), /a 期望 1，实际 2/)
  assert.match(compareSubset({ a: 1 }, { json: {}, text: '' }), /a 期望 1，实际 undefined/)
  assert.match(compareSubset({ a: 1 }, { json: null, text: 'x' }), /不是 JSON/)
  assert.match(compareSubset({ a: { b: 1 } }, { json: { a: 1 }, text: '' }), /a 应当是对象/)
  assert.match(compareSubset({ a: [1, 2] }, { json: { a: [1] }, text: '' }), /长度/)
  assert.equal(compareSubset({ a: [1] }, { json: { a: [1, 2] }, text: '' }), null)
})

// ---------------------------------------------------------------------------
// ⑤ 占位符展开
// ---------------------------------------------------------------------------

test('★ 展开必须严格且递归', () => {
  assert.equal(expandStrict('{port}', { port: 8787 }), 8787, '整串占位符要保留原类型（数字）')
  assert.equal(expandStrict('http://h:{port}/x', { port: 80 }), 'http://h:80/x')
  assert.deepEqual(expandStrict({ port: '{p}' }, { p: 80 }), { port: 80 }, '嵌在对象里也要展开')
  assert.deepEqual(expandStrict({ a: [{ p: '{p}' }] }, { p: 80 }), { a: [{ p: 80 }] }, '嵌在数组里也要展开')
  assert.equal(expandStrict(42, { p: 80 }), 42)
  assert.throws(() => expandStrict('{unknown}', { p: 80 }), /未知上下文变量/)
  assert.throws(() => expandStrict({ port: '{unknown}' }, { p: 80 }), /未知上下文变量/)
})

// ---------------------------------------------------------------------------
// ⑥ 与真实进程清单的契约（本文件最重要的用例）
// ---------------------------------------------------------------------------

test('★ 用真实 PROCESS_SPECS 派生：每一项都合法，且身份断言被展开成数字', () => {
  const derived = healthSpecFromProcesses({ processes: PROCESS_SPECS, ports: DEFAULT_PORTS })
  assert.equal(derived.ok, true, derived.reason ?? '')
  assert.ok(derived.spec.checks.length >= 3, `只派生出 ${derived.spec.checks.length} 项检查`)

  for (const item of derived.spec.checks) {
    const validation = validateHealthSpec(spec([item]))
    assert.equal(validation.ok, true, `派生出的 ${item.name} 不合法：${validation.reason}`)
  }
  // ★ workbench 的身份断言是 `{ port: '{teamHubPort}' }`——占位符嵌在对象里。
  //   这里要求它被展开成**数字**（不是字符串，也不是字面占位符）。
  const workbench = derived.spec.checks.find((item) => item.name === 'workbench')
  assert.ok(workbench !== undefined, '没有从进程清单派生出 workbench 的检查')
  assert.equal(typeof workbench.expectJson?.port, 'number',
    `workbench 的端口断言没有被展开成数字：${JSON.stringify(workbench.expectJson?.port)}`)
  assert.equal(workbench.expectJson.port, DEFAULT_PORTS['team-hub'])
})

test('★ 就绪判据引用了未知占位符 → 派生失败，而不是留下字面量', () => {
  // 这一条用**合成**的进程定义来隔离"展开失败"这个行为：真实清单里
  // `{teamHubPort}` 的来源与 team-hub 的端口绑定，缺端口会先在
  // "没有可用端口"那一条上失败（见下一个用例）。
  //
  // 它要证明的是：一份"引用了不存在变量"的就绪判据**不会**被静默接受。
  // 留下字面量 `{nonexistent}` 的后果是断言永远不成立——而它看起来是
  // 配置好的。
  const derived = healthSpecFromProcesses({
    processes: [{
      key: 'x',
      portKey: 'x',
      readiness: { kind: 'http', path: '/h', expectStatus: 200, expectJson: { port: '{nonexistent}' } },
    }],
    ports: { x: 1234 },
  })
  assert.equal(derived.ok, false, '未知占位符没有被报成派生失败')
  assert.match(derived.reason, /无法展开/)
  assert.match(derived.reason, /nonexistent/)
  assert.equal(derived.spec, null)
})

test('★ 端口缺读数时派生**失败**，而不是产出一份坏规格', () => {
  // team-hub 的端口读不出来 → 它的检查派生不出来。
  const derived = healthSpecFromProcesses({
    processes: PROCESS_SPECS,
    ports: { workbench: 5173, whiteboard: 8080 },
  })
  assert.equal(derived.ok, false, '缺端口读数时派生成功了')
  assert.match(derived.reason, /team-hub/)
  assert.equal(derived.spec, null)
})

test('派生只收 http 类就绪判定，不编造其它进程的检查', () => {
  const derived = healthSpecFromProcesses({
    processes: [
      { key: 'a', readiness: { kind: 'http', path: '/x', expectStatus: 200 }, defaultPort: 1000 },
      { key: 'b', readiness: { kind: 'none' }, defaultPort: 1001 },
      { key: 'c', readiness: { kind: 'stdout', expectMatch: '^x' }, defaultPort: 1002 },
      { key: 'd' },
    ],
    ports: {},
  })
  assert.equal(derived.ok, true, derived.reason ?? '')
  assert.deepEqual(derived.spec.checks.map((item) => item.name), ['a'])
})
