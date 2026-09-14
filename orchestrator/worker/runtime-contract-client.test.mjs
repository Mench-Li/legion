// orchestrator/worker/runtime-contract-client.test.mjs
// ============================================================================
// Runtime Contract **客户端适配器**的契约测试（PRT-253 跨进程边界）
//
// 本套件跑的是 worker 那一侧的 `RuntimeAdapter` 实现，对着**真 HTTP 监听器**。
// 两类对端，缺一不可：
//
//   · 用**真服务端**（`runtime/dsh-composition/runtime-contract-server.mjs`）跑来回，
//     证明两侧对同一份协议的理解一致；
//   · 用**手写的坏对端**（`node:http`，故意违约）跑失败语义，
//     因为真服务端**永远不会**产生那些违约的流——而"引擎违约那天会怎样"
//     正是本模块存在的理由。
//
//   > 只对着一个守规矩的对端测"不守规矩时会怎样"，
//   > 测到的是"那个对端很守规矩"。
//
// ★ 重点在第五组：`execute` 的五种结束方式。其中四种必须**抛**，
// 而且 `no-terminal`（对端说完了没说结论）与 `transport-failed`
// （我们没听完）必须是**两个码**——修法相反。
// ============================================================================
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { createFakeRuntimeAdapter } from '../../runtime/contracts/fake-adapter.mjs'
import { RUNTIME_CONTRACT_VERSION } from '../../runtime/contracts/adapter.mjs'
import {
  WIRE_CODES,
  WIRE_NDJSON_CONTENT_TYPE,
  WIRE_ROUTES,
} from '../../runtime/contracts/wire.mjs'
import { createRuntimeContractServer } from '../../runtime/dsh-composition/runtime-contract-server.mjs'
import {
  RUNTIME_CONTRACT_CLIENT_DEFAULT_TIMEOUT_MS,
  RuntimeContractClientError,
  createRuntimeContractAdapter,
  fetchEnforcementVerdict,
} from './runtime-contract-client.mjs'

// ---------------------------------------------------------------- 夹具

const TOKEN = 'prt253-client-token'

const VALID_REQUEST = Object.freeze({
  runId: 'run-cli-1',
  attemptId: 'att-cli-1',
  idempotencyKey: 'idem-cli-1',
  workspaceId: 'ws-1',
  goalId: 'goal-1',
  taskId: 'task-1',
  employeeId: 'emp-1',
  teamPlanRef: 'plan-1',
  contextSnapshotRef: 'snap-1',
  modelProfileRef: 'model-1',
  budget: { maxCostUsd: 1 },
  timeoutMs: 5_000,
  workdir: '/tmp/prt253',
  permissions: { preset: 'legion-unattended', tools: [] },
  expectedOutput: { schema: { type: 'object' }, acceptance: '完成即可' },
})

const EVENT_STARTED = Object.freeze({
  type: 'run.started', runId: 'run-cli-1', seq: 1, at: 1_700_000_000_000,
})

const EVENT_TERMINAL = Object.freeze({
  type: 'run.completed',
  runId: 'run-cli-1',
  seq: 2,
  at: 1_700_000_000_001,
  result: {
    runId: 'run-cli-1',
    attemptId: 'att-cli-1',
    outcome: 'completed',
    code: null,
    output: { status: 'ok' },
    usage: { tokensIn: 1, tokensOut: 2, estimatedCostUsd: 0.001 },
    outcomeUnknown: false,
    userMessage: '运行已完成。',
  },
})

const line = (obj) => `${JSON.stringify(obj)}\n`

/** 一个最小合法适配器（替身；真引擎那一侧不在这里覆盖）。 */
function stubAdapter(overrides = {}) {
  return {
    runtimeContractVersion: RUNTIME_CONTRACT_VERSION,
    async probe() { return { ok: true } },
    async getHealth() {
      return { state: 'ready', contractVersion: RUNTIME_CONTRACT_VERSION, runtimeVersion: 'stub-0.1.0', detail: '测试替身' }
    },
    async getCapabilities() { return { 'usage-reporting': true } },
    async listModels() { return [{ id: 'm1', model: 'stub-1' }] },
    async validateProfile() { return { ok: true, code: null, message: '可用', latencyMs: 1, capabilities: {} } },
    async *execute() { yield EVENT_STARTED; yield EVENT_TERMINAL },
    async cancel() { return { ok: true } },
    async recover() { return { ok: true, outcome: 'unknown' } },
    ...overrides,
  }
}

const OPEN = []
after(async () => {
  const all = OPEN.splice(0)
  await Promise.all(all.map((x) => x().catch(() => undefined)))
})

/** 起一个真服务端 + 真客户端。 */
async function realPeer(input = {}) {
  const server = createRuntimeContractServer({
    adapter: stubAdapter(), token: TOKEN, port: 0, ...input,
  })
  assert.equal(server.ok, true, `服务端没造出来：${server.code}`)
  const l = await server.listen()
  assert.equal(l.ok, true)
  OPEN.push(() => server.close())
  return { server, base: `http://127.0.0.1:${l.port}` }
}

/**
 * 起一个**故意违约**的裸 HTTP 对端。
 *
 * `handler(req, res)` 完全自己写——本套件要的就是"真服务端绝不会做的事"。
 */
async function brokenPeer(handler) {
  const server = createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  OPEN.push(() => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()) }))
  return { server, base: `http://127.0.0.1:${port}` }
}

/** 把一个 client 错误压成一个可比较的读数。 */
async function readingOf(fn) {
  try {
    const value = await fn()
    return { threw: false, code: null, value }
  } catch (e) {
    return { threw: true, code: e?.code ?? null, innerCode: e?.innerCode ?? null, message: e?.message ?? String(e), error: e }
  }
}

// ═══════════════════════════════════════════════ ① 接线

test('① 没有 baseUrl → 当场抛 BAD_WIRING（**不给默认端点**）', () => {
  for (const host of [{}, { baseUrl: '' }, { baseUrl: '   ' }, { baseUrl: null }, { baseUrl: 42 }]) {
    assert.throws(() => createRuntimeContractAdapter(host), (e) => {
      assert.equal(e.code, WIRE_CODES.BAD_WIRING)
      assert.ok(e.message.includes('baseUrl'))
      return true
    }, `host=${JSON.stringify(host)} 不该被接受`)
  }
  // ★ 反向锚："编一个 127.0.0.1:3080" 与"报缺 baseUrl"是完全不同的两件事。
  //   前者会让一个没配的部署去连一个可能属于别人的端口。
})

test('① baseUrl 的尾斜杠被归一（否则会拼出 `//health` 这种只有一半人认得的地址）', async () => {
  const { base } = await realPeer()
  const c = createRuntimeContractAdapter({ baseUrl: `${base}/`, token: TOKEN })
  const h = await c.getHealth()
  assert.equal(h.state, 'ready')
  const c2 = createRuntimeContractAdapter({ baseUrl: `${base}///`, token: TOKEN })
  assert.equal((await c2.getHealth()).state, 'ready')
})

test('① 没有可用的 fetch → BAD_WIRING（在构造期就说清楚，不等第一次请求才炸）', () => {
  const saved = globalThis.fetch
  try {
    // 宿主没有 fetch 的处境（老 Node / 被裁剪的运行时）：构造期具名拒绝，
    // 而不是让每一次读都失败在一个与真因无关的地方。
    globalThis.fetch = undefined
    assert.throws(
      () => createRuntimeContractAdapter({ baseUrl: 'http://127.0.0.1:1', token: TOKEN }),
      (e) => {
        assert.equal(e.code, WIRE_CODES.BAD_WIRING)
        assert.ok(e.message.includes('fetch'), `报错要说清缺的是 fetch：${e.message}`)
        return true
      },
    )
  } finally {
    globalThis.fetch = saved
  }
  // 反向锚：fetch 回来之后同一个 host 就能造出来了（否则上面那条可能只是"什么都造不出来"）。
  const c = createRuntimeContractAdapter({ baseUrl: 'http://127.0.0.1:1', token: TOKEN })
  assert.equal(typeof c.getHealth, 'function')
})

test('① 显式注入的 fetchImpl 会被用（不偷偷去用全局那个）', async () => {
  const calls = []
  const { base } = await realPeer()
  const c = createRuntimeContractAdapter({
    baseUrl: base,
    token: TOKEN,
    fetchImpl: (url, init) => { calls.push(url); return globalThis.fetch(url, init) },
  })
  assert.equal((await c.getHealth()).state, 'ready')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].startsWith(base), true)
})

test('① 适配器满足 RuntimeAdapter 形状（七个方法 + 契约版本）', async () => {
  const { base } = await realPeer()
  const c = createRuntimeContractAdapter({ baseUrl: base, token: TOKEN })
  assert.equal(c.runtimeContractVersion, RUNTIME_CONTRACT_VERSION)
  for (const m of ['getHealth', 'getCapabilities', 'listModels', 'validateProfile', 'execute', 'cancel', 'recover']) {
    assert.equal(typeof c[m], 'function', `缺少方法 ${m}`)
  }
})

// ═══════════════════════════════════════════════ ② 七个方法

test('② 控制类方法逐个来回：health / capabilities / models / validateProfile / cancel / recover', async () => {
  const { base } = await realPeer()
  const c = createRuntimeContractAdapter({ baseUrl: base, token: TOKEN })

  const health = await c.getHealth()
  assert.equal(health.state, 'ready')
  assert.equal(health.contractVersion, RUNTIME_CONTRACT_VERSION)

  assert.deepEqual(await c.getCapabilities(), { 'usage-reporting': true })
  assert.deepEqual(await c.listModels(), [{ id: 'm1', model: 'stub-1' }])
  assert.equal((await c.validateProfile({ id: 'm1' })).ok, true)
  assert.equal((await c.cancel('run-cli-1')).ok, true)
  assert.equal((await c.recover('run-cli-1')).ok, true)
})

test('② `enforcement` 附加端点：把对端的结论**原样**带回来（不做任何填充）', async () => {
  const { base } = await realPeer({
    enforcement: async () => ({ autoExecutionForbidden: false, state: 'enforcement-effective', checks: [{ name: 'a', ok: true }] }),
  })
  const v = await fetchEnforcementVerdict({ baseUrl: base, token: TOKEN })
  assert.equal(v.autoExecutionForbidden, false)
  assert.equal(v.state, 'enforcement-effective')
  assert.deepEqual(v.checks, [{ name: 'a', ok: true }])
})

test('② `enforcement`：对端没有来源 → 抛 ENFORCEMENT_UNAVAILABLE，**不回落成 false**', async () => {
  const { base } = await realPeer() // 没有 enforcement
  const r = await readingOf(() => fetchEnforcementVerdict({ baseUrl: base, token: TOKEN }))
  assert.equal(r.threw, true)
  assert.equal(r.code, WIRE_CODES.ENFORCEMENT_UNAVAILABLE)
  assert.equal(r.error?.result, undefined, '拒绝时不得带出一个"结论"')
})

test('② `enforcement` 没有 baseUrl → BAD_WIRING（不是静默成功）', async () => {
  const r = await readingOf(() => fetchEnforcementVerdict({}))
  assert.equal(r.threw, true)
  assert.equal(r.code, WIRE_CODES.BAD_WIRING)
})

// ═══════════════════════════════════════════════ ③ probe 复用同一套判定

test('③ ★ probe() 用**同一个** probeRuntime() 判定，不在这里另写一套能力规则', async () => {
  // 版本对不上：`probeRuntime` 的既有结论必须原样出现（fail closed）。
  const { base } = await realPeer({
    adapter: stubAdapter({
      async getHealth() { return { state: 'ready', contractVersion: RUNTIME_CONTRACT_VERSION, runtimeVersion: '9.9.9', detail: 'x' } },
    }),
  })
  const c = createRuntimeContractAdapter({ baseUrl: base, token: TOKEN })
  const p = await c.probe()
  assert.equal(p.ok, false, `版本 9.9.9 不该被 probeRuntime() 判为兼容：${JSON.stringify(p)}`)
  assert.equal(typeof p.reason, 'string')
  assert.ok(p.reason.length > 0, '不兼容必须给出**理由**，不能只给一个 false')
})

test('③ ★ probe() 在版本兼容时报 ok，并把对端的健康状态一并带出（两者可分）', async () => {
  // `SUPPORTED_RUNTIME` 的 minVersion 是 0.1.0、supportedMajor 是 0 —— 用 0.1.0。
  const { base } = await realPeer({
    adapter: stubAdapter({
      async getHealth() { return { state: 'degraded', contractVersion: RUNTIME_CONTRACT_VERSION, runtimeVersion: '0.1.0', detail: 'x' } },
      async getCapabilities() {
        return {
          'tool-permission-enforcement': true,
          'cancel-and-timeout': true,
          'structured-result': true,
          'usage-reporting': true,
        }
      },
    }),
  })
  const c = createRuntimeContractAdapter({ baseUrl: base, token: TOKEN })
  const p = await c.probe()
  assert.equal(p.ok, true, `0.1.0 + 四项必需能力该判兼容：${JSON.stringify(p)}`)
  // ★ 两个读数必须可分：「引擎自己说它是 degraded」与「契约协商不过」。
  assert.equal(p.healthState, 'degraded')
})

test('③ probe() 不吞传输失败：连不上时抛出，而不是返回一个"不兼容"', async () => {
  const c = createRuntimeContractAdapter({ baseUrl: 'http://127.0.0.1:1', token: TOKEN })
  const r = await readingOf(() => c.probe())
  assert.equal(r.threw, true)
  // ★ "连不上"与"判定为不兼容"是两件事：前者去看进程，后者去看版本与能力表。
  assert.equal(r.code, WIRE_CODES.UNREACHABLE)
})

// ═══════════════════════════════════════════════ ④ 鉴权与传输（客户端判定的码）

test('④ ★★ 凭证不对 → UNAUTHORIZED，且**对端的码在 innerCode 上**', async () => {
  const { base } = await realPeer()
  const c = createRuntimeContractAdapter({ baseUrl: base, token: 'wrong-token-xyz' })
  const r = await readingOf(() => c.getCapabilities())
  assert.equal(r.threw, true)
  assert.equal(r.code, WIRE_CODES.UNAUTHORIZED)
  assert.equal(r.innerCode, WIRE_CODES.UNAUTHORIZED)
  assert.equal(r.error?.status, 401)
  assert.equal(r.message.includes('wrong-token-xyz'), false, `报错里出现了凭证：${r.message}`)
})

test('④ ★★ 对端**没配** token → innerCode 是 NO_TOKEN（与"你给错了"不同形）', async () => {
  const { base } = await realPeer({ token: null })
  const c = createRuntimeContractAdapter({ baseUrl: base, token: 'anything' })
  const r = await readingOf(() => c.getCapabilities())
  assert.equal(r.threw, true)
  assert.equal(r.innerCode, WIRE_CODES.NO_TOKEN)
  assert.notEqual(r.innerCode, WIRE_CODES.UNAUTHORIZED, '两种处境必须可分：一个去配 token，一个去取对的 token')
})

test('④ 连不上 → UNREACHABLE（**不是** UNAUTHORIZED、**不是** BAD_RESPONSE）', async () => {
  const c = createRuntimeContractAdapter({ baseUrl: 'http://127.0.0.1:1', token: TOKEN })
  const r = await readingOf(() => c.getHealth())
  assert.equal(r.threw, true)
  assert.equal(r.code, WIRE_CODES.UNREACHABLE)
  const three = [WIRE_CODES.UNREACHABLE, WIRE_CODES.UNAUTHORIZED, WIRE_CODES.BAD_RESPONSE]
  assert.equal(new Set(three).size, 3)
})

test('④ 对端答的不是本协议 → BAD_RESPONSE（不尽力解析）', async () => {
  const { base } = await brokenPeer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html>这是一个别的服务</html>')
  })
  const c = createRuntimeContractAdapter({ baseUrl: base, token: TOKEN })
  const r = await readingOf(() => c.getHealth())
  assert.equal(r.threw, true)
  assert.equal(r.code, WIRE_CODES.BAD_RESPONSE)
})

test('④ 对端答了 JSON 但 wireVersion 对不上 → BAD_RESPONSE', async () => {
  const { base } = await brokenPeer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, wireVersion: 999, result: { state: 'ready' } }))
  })
  const c = createRuntimeContractAdapter({ baseUrl: base, token: TOKEN })
  const r = await readingOf(() => c.getHealth())
  assert.equal(r.threw, true)
  // ★ 版本对不上时**不能**把 result 读出来：字段含义可能已经变了。
  assert.equal(r.code, WIRE_CODES.BAD_RESPONSE)
  assert.equal(r.value, undefined)
})

test('④ 控制类请求带超时上界（对端不回时不会永远挂着）', async () => {
  const { base } = await brokenPeer(() => { /* 永不响应 */ })
  const c = createRuntimeContractAdapter({ baseUrl: base, token: TOKEN, requestTimeoutMs: 150 })
  const started = Date.now()
  const r = await readingOf(() => c.getHealth())
  assert.equal(r.threw, true)
  assert.ok(Date.now() - started < 5_000, '上界没有生效')
  assert.equal(typeof RUNTIME_CONTRACT_CLIENT_DEFAULT_TIMEOUT_MS, 'number')
})

// ═══════════════════════════════════════════════ ⑤ execute 的失败语义（核心）

test('⑤ ★ 正常路径：逐个事件 yield 出来，终态是最后一个，且不抛', async () => {
  const { base } = await realPeer()
  const c = createRuntimeContractAdapter({ baseUrl: base, token: TOKEN })
  const seen = []
  for await (const ev of c.execute(VALID_REQUEST)) seen.push(ev.type)
  assert.deepEqual(seen, ['run.started', 'run.completed'])
})

test('⑤ ★★ 服务器**开始前就拒绝**（500 JSON）→ 抛对端的那个码，不是 STREAM_*', async () => {
  const { base } = await realPeer({
    adapter: stubAdapter({ execute() { throw new Error('开始前就炸了') } }),
  })
  const c = createRuntimeContractAdapter({ baseUrl: base, token: TOKEN })
  const r = await readingOf(async () => {
    const out = []
    for await (const ev of c.execute(VALID_REQUEST)) out.push(ev.type)
    return out
  })
  assert.equal(r.threw, true)
  assert.equal(r.code, WIRE_CODES.ADAPTER_THREW)
  assert.ok(r.message.includes('开始前就炸了'))
  // ★ 这条读数与"流读坏了"必须可分：一个是引擎故障，一个是传输故障。
  assert.notEqual(r.code, WIRE_CODES.STREAM_BROKEN)
})

test('⑤ ★★★ 传输中途断掉 → STREAM_BROKEN，`outcomeUnknown` 为真', async () => {
  const { base } = await brokenPeer((req, res) => {
    res.writeHead(200, { 'content-type': WIRE_NDJSON_CONTENT_TYPE })
    res.write(line(EVENT_STARTED))
    setTimeout(() => res.socket?.destroy(), 30)
  })
  const c = createRuntimeContractAdapter({ baseUrl: base, token: TOKEN })
  const seen = []
  const r = await readingOf(async () => {
    for await (const ev of c.execute(VALID_REQUEST)) seen.push(ev.type)
  })
  assert.equal(r.threw, true)
  assert.equal(r.code, WIRE_CODES.STREAM_BROKEN)
  assert.equal(r.error?.outcomeUnknown, true,
    '断流之后这次运行到底发生了什么**不知道**——绝不能读成一次成功')
  // 已经收到的事件仍然被交出去了（这不是"什么都没发生"）。
  assert.deepEqual(seen, ['run.started'])
})

test('⑤ ★★★ 对端**干净关闭**却没有终态 → STREAM_NO_TERMINAL（与断流是**两个码**）', async () => {
  const { base } = await brokenPeer((req, res) => {
    res.writeHead(200, { 'content-type': WIRE_NDJSON_CONTENT_TYPE })
    res.write(line(EVENT_STARTED))
    res.end() // ★ 干净收尾——不是 destroy
  })
  const c = createRuntimeContractAdapter({ baseUrl: base, token: TOKEN })
  const seen = []
  const r = await readingOf(async () => {
    for await (const ev of c.execute(VALID_REQUEST)) seen.push(ev.type)
  })
  assert.equal(r.threw, true)
  assert.equal(r.code, WIRE_CODES.STREAM_NO_TERMINAL)
  assert.notEqual(r.code, WIRE_CODES.STREAM_BROKEN,
    '"对端说完了没说结论"与"我们没听完"必须可分：前者看适配器，后者看网络与进程')
  assert.deepEqual(seen, ['run.started'])
})

test('⑤ ★★ 服务端把违约用**控制帧**说出来时：客户端抛的是**那个码**，不是"畸形行"', async () => {
  // 真服务端在"中途抛"与"没有终态"时都会发控制帧（见服务端套件）。
  const mid = await realPeer({ adapter: stubAdapter({ async *execute() { yield EVENT_STARTED; throw new Error('中途') } }) })
  const c1 = createRuntimeContractAdapter({ baseUrl: mid.base, token: TOKEN })
  const r1 = await readingOf(async () => { for await (const ev of c1.execute(VALID_REQUEST)) void ev })
  assert.equal(r1.code, WIRE_CODES.ADAPTER_THREW)
  assert.notEqual(r1.code, WIRE_CODES.STREAM_MALFORMED)

  const noTerm = await realPeer({ adapter: stubAdapter({ async *execute() { yield EVENT_STARTED } }) })
  const c2 = createRuntimeContractAdapter({ baseUrl: noTerm.base, token: TOKEN })
  const r2 = await readingOf(async () => { for await (const ev of c2.execute(VALID_REQUEST)) void ev })
  assert.equal(r2.code, WIRE_CODES.STREAM_NO_TERMINAL)
  assert.notEqual(r2.code, WIRE_CODES.STREAM_BROKEN,
    '控制帧说的"没有终态"不能被压成"传输失败"——那会丢掉服务端已经知道的那件事')
})

test('⑤ ★★ 一行不是合法 RunEvent → STREAM_MALFORMED（与"断流"、"无终态"都不同）', async () => {
  const { base } = await brokenPeer((req, res) => {
    res.writeHead(200, { 'content-type': WIRE_NDJSON_CONTENT_TYPE })
    res.write(line(EVENT_STARTED))
    res.write('{这不是 JSON\n')
    res.end()
  })
  const c = createRuntimeContractAdapter({ baseUrl: base, token: TOKEN })
  const r = await readingOf(async () => { for await (const ev of c.execute(VALID_REQUEST)) void ev })
  assert.equal(r.threw, true)
  assert.equal(r.code, WIRE_CODES.STREAM_MALFORMED)
})

test('⑤ ★★ 终态之后还有事件 → STREAM_AFTER_TERMINAL（终态必须是最后一个）', async () => {
  const late = { type: 'message.delta', runId: 'run-cli-1', seq: 9, at: 1_700_000_000_002, text: '迟到的' }
  const { base } = await brokenPeer((req, res) => {
    res.writeHead(200, { 'content-type': WIRE_NDJSON_CONTENT_TYPE })
    res.write(line(EVENT_STARTED) + line(EVENT_TERMINAL) + line(late))
    res.end()
  })
  const c = createRuntimeContractAdapter({ baseUrl: base, token: TOKEN })
  const seen = []
  const r = await readingOf(async () => {
    for await (const ev of c.execute(VALID_REQUEST)) seen.push(ev.type)
  })
  assert.equal(r.threw, true)
  assert.equal(r.code, WIRE_CODES.STREAM_AFTER_TERMINAL)
  // 终态之前的两个照旧交出去（"已经发生过的事"不该因为后面违约而消失）。
  assert.deepEqual(seen, ['run.started', 'run.completed'])
})

test('⑤ ★★★ 四种非成功结束方式**两两不同码**（否则上面的断言各自成立也推不出可分）', async () => {
  const mk = (adapterOverrides) => stubAdapter(adapterOverrides)

  const mid = await realPeer({ adapter: mk({ async *execute() { yield EVENT_STARTED; throw new Error('x') } }) })
  const noTerm = await realPeer({ adapter: mk({ async *execute() { yield EVENT_STARTED } }) })
  const broken = await brokenPeer((req, res) => {
    res.writeHead(200, { 'content-type': WIRE_NDJSON_CONTENT_TYPE })
    res.write(line(EVENT_STARTED))
    setTimeout(() => res.socket?.destroy(), 30)
  })
  const malformed = await brokenPeer((req, res) => {
    res.writeHead(200, { 'content-type': WIRE_NDJSON_CONTENT_TYPE })
    res.write('not json at all\n')
    res.end()
  })

  const readings = []
  for (const [label, base] of [['adapter-threw', mid.base], ['no-terminal', noTerm.base], ['transport-failed', broken.base], ['malformed-line', malformed.base]]) {
    const c = createRuntimeContractAdapter({ baseUrl: base, token: TOKEN })
    const r = await readingOf(async () => { for await (const ev of c.execute(VALID_REQUEST)) void ev })
    assert.equal(r.threw, true, `${label} 若没抛，它就被读成了一次成功运行`)
    readings.push({ label, code: r.code })
  }

  assert.deepEqual(readings.map((x) => x.code), [
    WIRE_CODES.ADAPTER_THREW,
    WIRE_CODES.STREAM_NO_TERMINAL,
    WIRE_CODES.STREAM_BROKEN,
    WIRE_CODES.STREAM_MALFORMED,
  ])
  assert.equal(new Set(readings.map((x) => x.code)).size, readings.length,
    `四种结束方式里有两种同码——那它们就是同一个读数：${JSON.stringify(readings)}`)
})

test('⑤ ★★★ "读完了没终态"永远不等于"成功"：一个干净收尾的空流也抛', async () => {
  const { base } = await brokenPeer((req, res) => {
    res.writeHead(200, { 'content-type': WIRE_NDJSON_CONTENT_TYPE })
    res.end() // 零事件、干净收尾
  })
  const c = createRuntimeContractAdapter({ baseUrl: base, token: TOKEN })
  const r = await readingOf(async () => { for await (const ev of c.execute(VALID_REQUEST)) void ev })
  assert.equal(r.threw, true)
  assert.equal(r.code, WIRE_CODES.STREAM_NO_TERMINAL)
})

test('⑤ 响应没有可读流主体 → BAD_RESPONSE（不把整段正文当成一条流）', async () => {
  // Node 的 http 服务器总会给 client 一个 body，所以这里用"状态 200 但内容是
  // 一个 JSON 信封"来逼近：没有 NDJSON 行，读完之后是"没有终态"。
  const { base } = await brokenPeer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, wireVersion: 1, result: { note: '这不是一条流' } }))
  })
  const c = createRuntimeContractAdapter({ baseUrl: base, token: TOKEN })
  const r = await readingOf(async () => { for await (const ev of c.execute(VALID_REQUEST)) void ev })
  assert.equal(r.threw, true)
  // 一个 JSON 信封不是 NDJSON 事件行 → 要么畸形要么无终态，但**绝不**是成功。
  assert.ok([WIRE_CODES.STREAM_MALFORMED, WIRE_CODES.STREAM_NO_TERMINAL].includes(r.code),
    `既不是畸形也不是无终态，那是把一段 JSON 读成了成功：${r.code}`)
})

test('⑤ execute 失败时可重试性说明：`outcomeUnknown` 只在那三种情况下为真', async () => {
  // terminal 路径不抛；其余四种里，"断流"与"无终态"都意味着**不知道**运行结局。
  const broken = await brokenPeer((req, res) => {
    res.writeHead(200, { 'content-type': WIRE_NDJSON_CONTENT_TYPE })
    res.write(line(EVENT_STARTED))
    setTimeout(() => res.socket?.destroy(), 30)
  })
  const c = createRuntimeContractAdapter({ baseUrl: broken.base, token: TOKEN })
  const r = await readingOf(async () => { for await (const ev of c.execute(VALID_REQUEST)) void ev })
  assert.equal(r.error.outcomeUnknown, true)

  // 而"开始前就被拒"不产生 outcomeUnknown：那次运行根本没开始。
  const refused = await realPeer({ adapter: stubAdapter({ execute() { throw new Error('x') } }) })
  const c2 = createRuntimeContractAdapter({ baseUrl: refused.base, token: TOKEN })
  const r2 = await readingOf(async () => { for await (const ev of c2.execute(VALID_REQUEST)) void ev })
  assert.equal(r2.error.outcomeUnknown, false,
    '"根本没开始"与"开始了但不知道结局"必须分开：后者不得自动重试')
})

test('⑤ RuntimeContractClientError 是可识别的类型，且带 code', async () => {
  const c = createRuntimeContractAdapter({ baseUrl: 'http://127.0.0.1:1', token: TOKEN })
  const r = await readingOf(() => c.getHealth())
  assert.equal(r.error instanceof RuntimeContractClientError, true)
  assert.equal(r.error.name, 'RuntimeContractClientError')
  assert.equal(r.error instanceof Error, true)
})

test('⑤ execute 不带凭证 → UNAUTHORIZED，且**引擎一次都没被调到**', async () => {
  const calls = []
  const { base } = await realPeer({
    adapter: stubAdapter({ async *execute() { calls.push('x'); yield EVENT_TERMINAL } }),
  })
  const c = createRuntimeContractAdapter({ baseUrl: base }) // 没有 token
  const r = await readingOf(async () => { for await (const ev of c.execute(VALID_REQUEST)) void ev })
  assert.equal(r.threw, true)
  assert.equal(r.code, WIRE_CODES.UNAUTHORIZED)
  assert.deepEqual(calls, [])
})

test('⑤ 一个真替身的完整运行：事件序列与契约里的终态一一对应', async () => {
  const adapter = createFakeRuntimeAdapter()
  adapter.probe = async () => ({ ok: true })
  const { base } = await realPeer({ adapter })
  const c = createRuntimeContractAdapter({ baseUrl: base, token: TOKEN })
  const seen = []
  for await (const ev of c.execute(VALID_REQUEST)) seen.push(ev.type)
  assert.equal(seen.at(-1), 'run.completed')
  assert.ok(seen.includes('usage.updated'))
  assert.equal(seen.includes('run.started'), true)
})

// ═══════════════════════════════════════════════ ⑥ 静默失败的反向锚

test('⑥ 客户端不会把 **5xx 的 JSON 拒绝** 读成一条流（routeFor 之外的负向对照）', async () => {
  const { base } = await brokenPeer((req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, wireVersion: 1, code: WIRE_CODES.ENFORCEMENT_UNAVAILABLE, message: '没有来源' }))
  })
  const c = createRuntimeContractAdapter({ baseUrl: base, token: TOKEN })
  const r = await readingOf(async () => { for await (const ev of c.execute(VALID_REQUEST)) void ev })
  assert.equal(r.threw, true)
  assert.equal(r.code, WIRE_CODES.ENFORCEMENT_UNAVAILABLE)
  assert.equal(r.innerCode, WIRE_CODES.ENFORCEMENT_UNAVAILABLE)
})

test('⑥ 路由表是共享的：客户端请求的路径就是 WIRE_ROUTES 里那一条', async () => {
  const seenPaths = []
  const { base } = await brokenPeer((req, res) => {
    seenPaths.push(req.url)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, wireVersion: 1, result: {} }))
  })
  const c = createRuntimeContractAdapter({ baseUrl: base, token: TOKEN })
  await c.getHealth()
  await c.getCapabilities()
  await c.listModels()
  await c.validateProfile({ id: 'x' })
  await c.cancel('r')
  await c.recover('r')
  assert.deepEqual(seenPaths, [
    WIRE_ROUTES.getHealth.path,
    WIRE_ROUTES.getCapabilities.path,
    WIRE_ROUTES.listModels.path,
    WIRE_ROUTES.validateProfile.path,
    WIRE_ROUTES.cancel.path,
    WIRE_ROUTES.recover.path,
  ], '两侧各写一份路径字符串，会在改名的当天变成一次静默的 404')
})
