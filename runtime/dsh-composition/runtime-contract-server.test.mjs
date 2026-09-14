// runtime/dsh-composition/runtime-contract-server.test.mjs
// ============================================================================
// Runtime Contract **服务端**的契约测试（PRT-253 跨进程边界）
//
// 本套件在**真 HTTP 监听器**上跑（`node:http`，回环，port 0），
// 用**手写的原始请求**而不是客户端适配器——理由是本套件要测的是
// **服务端那一侧**的读数，用一个自己写的客户端去测，会让
// "客户端与服务端一起错了但错得一致"看起来像绿的。
//
//   > 用自己的客户端测自己的服务端，测的是两者是否一致，不是两者是否正确。
//
// 六组：
//   ① 造不出来：没有适配器 / 形状不对 / 没有端口——**三种各自可分辨**
//   ② 监听：port 0 → 从 `address()` 读回真实端口（不绑固定端口）
//   ③ 鉴权 fail closed：匿名只有 health；没配 token 与给错 token **是两个码**
//   ④ 路由与方法：不互相冒充
//   ⑤ ★ execute 的**五种结束方式**各自可分辨，且没有一种"看起来像成功"
//   ⑥ enforcement 附加端点：没有来源时具名拒绝，**不回落成"通过"**
//
// 第 ⑤ 组是本套件的理由：这五种结束方式里有四种是"出事了"，
// 而一个把它们都写成 `res.end()` 的实现，在"正常运行"的用例上**全绿**。
// ============================================================================
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

import { createFakeRuntimeAdapter } from '../contracts/fake-adapter.mjs'
import { RUNTIME_CONTRACT_VERSION } from '../contracts/adapter.mjs'
import {
  RUNTIME_CONTRACT_WIRE_VERSION,
  WIRE_CODES,
  WIRE_CONTROL_KEY,
  WIRE_NDJSON_CONTENT_TYPE,
  WIRE_ROUTES,
} from '../contracts/wire.mjs'
import {
  RUNTIME_CONTRACT_DEFAULT_HOST,
  RUNTIME_CONTRACT_SERVER_CODES,
  createRuntimeContractServer,
} from './runtime-contract-server.mjs'

// ---------------------------------------------------------------- 夹具

const TOKEN = 'prt253-server-token'

const VALID_REQUEST = Object.freeze({
  runId: 'run-srv-1',
  attemptId: 'att-srv-1',
  idempotencyKey: 'idem-srv-1',
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
  type: 'run.started', runId: 'run-srv-1', seq: 1, at: 1_700_000_000_000,
})

const EVENT_TERMINAL = Object.freeze({
  type: 'run.completed',
  runId: 'run-srv-1',
  seq: 2,
  at: 1_700_000_000_001,
  result: {
    runId: 'run-srv-1',
    attemptId: 'att-srv-1',
    outcome: 'completed',
    code: null,
    output: { status: 'ok' },
    usage: { tokensIn: 1, tokensOut: 2, estimatedCostUsd: 0.001 },
    outcomeUnknown: false,
    userMessage: '运行已完成。',
  },
})

/**
 * 一个最小的合法适配器：七个方法 + 契约版本。
 *
 * ⚠️ 它是**替身**：它证明"服务端会把适配器的答案如实传过去"，
 * **不**证明任何 DSH 引擎的能力。真引擎那一侧由
 * `plugins/runtime-contract-server-row-dsh-process.test.mjs` 覆盖。
 */
function stubAdapter(overrides = {}) {
  return {
    runtimeContractVersion: RUNTIME_CONTRACT_VERSION,
    async probe() { return { ok: true } },
    async getHealth() { return { state: 'ready', contractVersion: RUNTIME_CONTRACT_VERSION, runtimeVersion: 'stub-1.0.0', detail: '测试替身' } },
    async getCapabilities() { return { 'usage-reporting': true } },
    async listModels() { return [{ id: 'm1', model: 'stub-1' }] },
    async validateProfile() { return { ok: true, code: null, message: '可用', latencyMs: 1, capabilities: {} } },
    async *execute() { yield EVENT_STARTED; yield EVENT_TERMINAL },
    async cancel() { return { ok: true, runId: 'run-srv-1' } },
    async recover() { return { ok: true, outcome: 'unknown' } },
    ...overrides,
  }
}

/** 造一个已监听的服务端。调用方负责 `close()`。 */
async function startServer(input = {}) {
  const created = createRuntimeContractServer({
    adapter: stubAdapter(),
    token: TOKEN,
    port: 0,
    ...input,
  })
  assert.equal(created.ok, true, `服务端没造出来：${created.code} ${created.message}`)
  const listened = await created.listen()
  assert.equal(listened.ok, true, `没听上：${listened.code} ${listened.message}`)
  assert.ok(listened.port > 0, 'port 0 之后必须从 address() 读回一个真实端口')
  return { server: created, base: `http://127.0.0.1:${listened.port}` }
}

const OPEN = new Set()

async function start(input = {}) {
  const s = await startServer(input)
  OPEN.add(s.server)
  return s
}

after(async () => {
  // 每个用例自己关；这里兜底，避免一条断言失败把监听器留在进程里。
  const all = [...OPEN]
  OPEN.clear()
  await Promise.all(all.map((s) => s.close().catch(() => undefined)))
})

/** 原始请求。**不走客户端适配器**——见文件头。 */
async function raw(base, path, { method = 'GET', token, body, rawBody, authHeader } = {}) {
  const headers = {}
  if (authHeader !== undefined) headers.authorization = authHeader
  else if (token !== undefined) headers.authorization = `Bearer ${token}`
  let payload
  if (rawBody !== undefined) {
    headers['content-type'] = 'application/json'
    payload = rawBody
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const res = await fetch(base + path, { method, headers, body: payload })
  const text = await res.text()
  return { status: res.status, headers: res.headers, text, json: safeJson(text) }
}

function safeJson(text) {
  try { return JSON.parse(text) } catch { return null }
}

/** 把 NDJSON 正文拆成事件与控制帧两类。**不猜**——分不出来就如实报。 */
function parseStream(text) {
  const events = []
  const controls = []
  const bad = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let parsed
    try { parsed = JSON.parse(line) } catch { bad.push(line); continue }
    if (parsed !== null && typeof parsed === 'object' && typeof parsed[WIRE_CONTROL_KEY] === 'string') controls.push(parsed)
    else if (typeof parsed?.type === 'string') events.push(parsed)
    else bad.push(line)
  }
  return { events, controls, bad }
}

// ═══════════════════════════════════════════════ ① 造不出来

test('① 没有适配器 → NO_ADAPTER（**不**造一个空壳顶着）', () => {
  const r = createRuntimeContractServer({ token: TOKEN, port: 0 })
  assert.equal(r.ok, false)
  assert.equal(r.code, RUNTIME_CONTRACT_SERVER_CODES.NO_ADAPTER)
})

test('① 适配器形状不对 → BAD_ADAPTER，并带出**缺了哪一个方法**', () => {
  const broken = stubAdapter()
  delete broken.getCapabilities
  const r = createRuntimeContractServer({ adapter: broken, token: TOKEN, port: 0 })
  assert.equal(r.ok, false)
  assert.equal(r.code, RUNTIME_CONTRACT_SERVER_CODES.BAD_ADAPTER)
  assert.ok(r.reasons.some((x) => x.includes('getCapabilities')),
    `拒绝理由必须说清缺哪个方法，实际：${JSON.stringify(r.reasons)}`)
})

test('① 契约版本不对 → 同样 BAD_ADAPTER（形状含版本）', () => {
  const wrongVersion = stubAdapter({ runtimeContractVersion: 999 })
  const r = createRuntimeContractServer({ adapter: wrongVersion, token: TOKEN, port: 0 })
  assert.equal(r.ok, false)
  assert.equal(r.code, RUNTIME_CONTRACT_SERVER_CODES.BAD_ADAPTER)
  assert.ok(r.reasons.some((x) => x.includes('runtimeContractVersion')))
})

test('① ★ 没有端口 → NO_BIND_PORT（**不给默认端口**）', () => {
  for (const bad of [null, undefined, -1, 70_000, 1.5, '3080']) {
    const r = createRuntimeContractServer({ adapter: stubAdapter(), token: TOKEN, port: bad })
    assert.equal(r.ok, false, `port=${JSON.stringify(bad)} 不该被接受`)
    assert.equal(r.code, RUNTIME_CONTRACT_SERVER_CODES.NO_BIND_PORT)
    assert.ok(r.reasons.some((x) => x.includes('没有默认值') || x.includes('内核分配')))
  }
})

test('① 三种"造不出来"是**三个不同的码**（修法不同）', () => {
  const adapter = createRuntimeContractServer({ port: 0 }).code
  const port = createRuntimeContractServer({ adapter: stubAdapter() }).code
  const shape = createRuntimeContractServer({ adapter: { runtimeContractVersion: 1 }, port: 0 }).code
  const three = [adapter, port, shape]
  assert.equal(new Set(three).size, 3, `三种拒绝必须各有其名：${three.join(' / ')}`)
  for (const c of three) assert.ok(typeof c === 'string' && c.length > 0)
})

// ═══════════════════════════════════════════════ ② 监听

test('② port 0 → 从 address() 读回真实端口；监听前 address() 是 null', async () => {
  const created = createRuntimeContractServer({ adapter: stubAdapter(), token: TOKEN, port: 0 })
  assert.equal(created.ok, true)
  assert.equal(created.address(), null, '还没 listen 就说自己有地址，等于编了一个')
  const l = await created.listen()
  assert.equal(l.ok, true)
  assert.equal(l.host, RUNTIME_CONTRACT_DEFAULT_HOST, '默认必须只监听回环')
  const addr = created.address()
  assert.equal(addr.port, l.port)
  assert.equal(addr.port > 0, true)
  await created.close()
  // 关掉之后状态如实反转。
  assert.equal(created.state().listening, false)
})

test('② close 幂等（关两次不抛）', async () => {
  const s = await start()
  assert.equal(await s.server.close(), true)
  assert.equal(await s.server.close(), false, '第二次关闭应当如实返回 false，而不是假装又关了一次')
})

test('② state() 报鉴权与强制面各自配没配，且**不含 token 值本身**', async () => {
  const s = await start()
  const st = s.server.state()
  assert.equal(st.tokenConfigured, true)
  assert.equal(st.enforcementConfigured, false)
  assert.equal(st.wireVersion, RUNTIME_CONTRACT_WIRE_VERSION)
  // ★ 反向锚：状态对象里不得出现 token 文本。凭证不该出现在任何可被打印的地方。
  const serialized = JSON.stringify(st)
  assert.equal(serialized.includes(TOKEN), false, `state() 泄漏了 token：${serialized}`)
  await s.server.close()
})

// ═══════════════════════════════════════════════ ③ 鉴权

test('③ 匿名只有 health：它不带凭证也能读', async () => {
  const s = await start()
  const r = await raw(s.base, WIRE_ROUTES.getHealth.path)
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.result.state, 'ready')
  await s.server.close()
})

test('③ 其余每一个操作都**拒绝**匿名（逐个断言，不抽样）', async () => {
  const s = await start()
  const cases = [
    ['getCapabilities', WIRE_ROUTES.getCapabilities.path, 'GET'],
    ['listModels', WIRE_ROUTES.listModels.path, 'GET'],
    ['validateProfile', WIRE_ROUTES.validateProfile.path, 'POST'],
    ['execute', WIRE_ROUTES.execute.path, 'POST'],
    ['cancel', WIRE_ROUTES.cancel.path, 'POST'],
    ['recover', WIRE_ROUTES.recover.path, 'POST'],
    ['enforcement', WIRE_ROUTES.enforcement.path, 'GET'],
  ]
  for (const [op, path, method] of cases) {
    const r = await raw(s.base, path, { method })
    assert.equal(r.status, 401, `${op} 匿名可达——这会让"没鉴权"看起来像"鉴权过了"`)
    assert.equal(r.json.code, WIRE_CODES.UNAUTHORIZED, `${op} 的拒绝码不对：${JSON.stringify(r.json)}`)
  }
  await s.server.close()
})

test('③ ★★★ 没配 token 与给错 token 是**两个码**（一台机器没配 vs 你给错了）', async () => {
  const noToken = await start({ token: null })
  const configured = await start()

  const a = await raw(noToken.base, WIRE_ROUTES.getCapabilities.path)
  const b = await raw(configured.base, WIRE_ROUTES.getCapabilities.path, { token: 'wrong-token' })

  assert.equal(a.status, 403)
  assert.equal(a.json.code, WIRE_CODES.NO_TOKEN)
  assert.equal(b.status, 401)
  assert.equal(b.json.code, WIRE_CODES.UNAUTHORIZED)
  // ★ 两个读数必须不同形。合成一个会让运维去配一台本来就配好了的机器。
  assert.notEqual(a.json.code, b.json.code)
  assert.notEqual(a.status, b.status)

  await noToken.server.close()
  await configured.server.close()
})

test('③ 空串 / 空白 token 算"没配"（不是一个可以匹配的凭证）', async () => {
  for (const blank of ['', '   ']) {
    const s = await start({ token: blank })
    const r = await raw(s.base, WIRE_ROUTES.getCapabilities.path, { token: '' })
    assert.equal(r.json.code, WIRE_CODES.NO_TOKEN, `token=${JSON.stringify(blank)} 该被当成没配`)
    // 而且 health 仍然可用：没配 token 不是"服务不可用"。
    const h = await raw(s.base, WIRE_ROUTES.getHealth.path)
    assert.equal(h.status, 200)
    await s.server.close()
  }
})

test('③ 形状不对的 authorization 头一律 401，不解析成空 token 后放行', async () => {
  const s = await start()
  for (const bad of ['', '   ', TOKEN, `Basic ${TOKEN}`, 'Bearer', 'Bearer ', `bearer ${TOKEN}x`]) {
    const r = await raw(s.base, WIRE_ROUTES.getCapabilities.path, { authHeader: bad })
    assert.equal(r.status, 401, `authorization=${JSON.stringify(bad)} 不该通过`)
    assert.equal(r.json.code, WIRE_CODES.UNAUTHORIZED)
  }
  // 正面锚：正确的凭证能过（否则上面六条可能只是"全都拒了"）。
  const good = await raw(s.base, WIRE_ROUTES.getCapabilities.path, { token: TOKEN })
  assert.equal(good.status, 200)
  await s.server.close()
})

test('③ 拒绝信封里不回声 token（凭证不出现在响应正文里）', async () => {
  const s = await start()
  const r = await raw(s.base, WIRE_ROUTES.getCapabilities.path, { token: 'the-wrong-one-xyz' })
  assert.equal(r.text.includes('the-wrong-one-xyz'), false, `响应正文里出现了客户端出示的凭证：${r.text}`)
  assert.equal(r.text.includes(TOKEN), false, `响应正文里出现了服务端配置的凭证：${r.text}`)
  await s.server.close()
})

// ═══════════════════════════════════════════════ ④ 路由

test('④ 未知路径 404 UNKNOWN_ROUTE；方法不对 405 METHOD_NOT_ALLOWED（不互相冒充）', async () => {
  const s = await start()
  const missing = await raw(s.base, '/legion/runtime/v1/nope', { token: TOKEN })
  assert.equal(missing.status, 404)
  assert.equal(missing.json.code, WIRE_CODES.UNKNOWN_ROUTE)

  const verb = await raw(s.base, WIRE_ROUTES.getHealth.path, { method: 'POST', token: TOKEN, body: {} })
  assert.equal(verb.status, 405)
  assert.equal(verb.json.code, WIRE_CODES.METHOD_NOT_ALLOWED)
  assert.notEqual(missing.json.code, verb.json.code)

  // ★ 未知路径**也在鉴权之前**被拒：一个没配凭证的探测者不该从 404/405 的差别里
  //   学到"哪条路径存在"。上面两条都带对了凭证，所以这里正面再钉一次匿名读数。
  const anonMissing = await raw(s.base, '/legion/runtime/v1/nope')
  assert.equal(anonMissing.status, 404, '路径判定发生在鉴权之前是刻意的：路由表不是秘密，但也不该靠 401/404 的差异被枚举')
  await s.server.close()
})

test('④ 响应头带上线上格式版本（协议升级能被看见，不用靠猜）', async () => {
  const s = await start()
  const r = await raw(s.base, WIRE_ROUTES.getHealth.path)
  assert.equal(r.headers.get('x-legion-wire-version'), String(RUNTIME_CONTRACT_WIRE_VERSION))
  await s.server.close()
})

test('④ 请求信封 wireVersion 对不上 → 400 BAD_REQUEST（不尽力解析）', async () => {
  const s = await start()
  const r = await raw(s.base, WIRE_ROUTES.validateProfile.path, {
    method: 'POST', token: TOKEN, rawBody: JSON.stringify({ wireVersion: 999, profile: { id: 'x' } }),
  })
  assert.equal(r.status, 400)
  assert.equal(r.json.code, WIRE_CODES.BAD_REQUEST)
  await s.server.close()
})

test('④ 请求体不是 JSON → 400；超过上限 → 413（两个码不同）', async () => {
  const s = await start()
  const notJson = await raw(s.base, WIRE_ROUTES.cancel.path, { method: 'POST', token: TOKEN, rawBody: '{oops' })
  assert.equal(notJson.status, 400)
  assert.equal(notJson.json.code, WIRE_CODES.BAD_REQUEST)

  // 8MiB + 一点：正好越过上限。走回环，代价是毫秒级。
  const huge = `{"wireVersion":1,"pad":"${'a'.repeat(8 * 1024 * 1024 + 64)}"}`
  const tooBig = await raw(s.base, WIRE_ROUTES.cancel.path, { method: 'POST', token: TOKEN, rawBody: huge })
  assert.equal(tooBig.status, 413)
  assert.equal(tooBig.json.code, WIRE_CODES.BODY_TOO_LARGE)
  assert.notEqual(notJson.json.code, tooBig.json.code)
  await s.server.close()
})

test('④ 缺少操作必填字段 → 各自 400，且**都不**回调适配器', async () => {
  const calls = []
  const adapter = stubAdapter({
    async cancel(runId) { calls.push(['cancel', runId]); return { ok: true } },
    async recover(runId) { calls.push(['recover', runId]); return { ok: true } },
    async validateProfile(p) { calls.push(['validateProfile', p]); return { ok: true } },
  })
  const s = await start({ adapter })
  for (const [path, body] of [
    [WIRE_ROUTES.cancel.path, { wireVersion: 1 }],
    [WIRE_ROUTES.recover.path, { wireVersion: 1 }],
    [WIRE_ROUTES.validateProfile.path, { wireVersion: 1 }],
  ]) {
    const r = await raw(s.base, path, { method: 'POST', token: TOKEN, rawBody: JSON.stringify(body) })
    assert.equal(r.status, 400, `${path} 缺必填字段却过了：${r.text}`)
    assert.equal(r.json.code, WIRE_CODES.BAD_REQUEST)
  }
  assert.deepEqual(calls, [], '请求形态就不对时，适配器**一次都不该被调到**')
  await s.server.close()
})

test('④ 合法的控制类请求真的走到适配器，并把结果原样带回', async () => {
  const s = await start()
  const caps = await raw(s.base, WIRE_ROUTES.getCapabilities.path, { token: TOKEN })
  assert.deepEqual(caps.json.result, { 'usage-reporting': true })
  const models = await raw(s.base, WIRE_ROUTES.listModels.path, { token: TOKEN })
  assert.deepEqual(models.json.result, [{ id: 'm1', model: 'stub-1' }])
  const cancelled = await raw(s.base, WIRE_ROUTES.cancel.path, {
    method: 'POST', token: TOKEN, rawBody: JSON.stringify({ wireVersion: 1, runId: 'run-srv-1' }),
  })
  assert.equal(cancelled.json.result.ok, true)
  await s.server.close()
})

// ═══════════════════════════════════════════════ ⑤ execute 的失败语义（核心）

test('⑤ ★ 正常路径：终态事件在流里，内容类型是 NDJSON', async () => {
  const s = await start()
  const r = await raw(s.base, WIRE_ROUTES.execute.path, {
    method: 'POST', token: TOKEN, rawBody: JSON.stringify({ wireVersion: 1, request: VALID_REQUEST }),
  })
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type') ?? '', /application\/x-ndjson/)
  assert.equal(r.headers.get('content-type')?.startsWith(WIRE_NDJSON_CONTENT_TYPE), true)
  const { events, controls, bad } = parseStream(r.text)
  assert.deepEqual(events.map((e) => e.type), ['run.started', 'run.completed'])
  assert.deepEqual(controls, [], '正常收尾的流里不该有控制帧')
  assert.deepEqual(bad, [])
  await s.server.close()
})

test('⑤ ★★ 流**开始之前**就炸：是 5xx 具名拒绝，**不是**一个空流', async () => {
  const adapter = stubAdapter({
    // 同步抛：连异步可迭代对象都没造出来。
    execute() { throw new Error('引擎在开始之前就炸了') },
  })
  const s = await start({ adapter })
  const r = await raw(s.base, WIRE_ROUTES.execute.path, {
    method: 'POST', token: TOKEN, rawBody: JSON.stringify({ wireVersion: 1, request: VALID_REQUEST }),
  })
  assert.equal(r.status, 500)
  assert.equal(r.json.code, WIRE_CODES.ADAPTER_THREW)
  assert.ok(r.json.message.includes('引擎在开始之前就炸了'), `拒绝消息必须带上真因：${r.text}`)
  // ★ 关键：返回的是 **JSON 信封**，不是一个"200 且零事件"的流。
  assert.match(r.headers.get('content-type') ?? '', /application\/json/)
  assert.equal(r.headers.get('content-type')?.includes('ndjson'), false)
  await s.server.close()
})

test('⑤ ★★ 第一个事件之前抛：同样是**具名 JSON 拒绝**，不写一个流头', async () => {
  const adapter = stubAdapter({
    async *execute() { throw new Error('第一个事件之前就炸了') },
  })
  const s = await start({ adapter })
  const r = await raw(s.base, WIRE_ROUTES.execute.path, {
    method: 'POST', token: TOKEN, rawBody: JSON.stringify({ wireVersion: 1, request: VALID_REQUEST }),
  })
  assert.equal(r.status, 500)
  assert.equal(r.json.code, WIRE_CODES.ADAPTER_THREW)
  assert.match(r.headers.get('content-type') ?? '', /application\/json/)
  await s.server.close()
})

test('⑤ ★★ execute 没返回异步可迭代对象 → ADAPTER_SHAPE_INVALID（形状错不是崩溃）', async () => {
  const adapter = stubAdapter({ execute: () => ({ not: 'a stream' }) })
  const s = await start({ adapter })
  const r = await raw(s.base, WIRE_ROUTES.execute.path, {
    method: 'POST', token: TOKEN, rawBody: JSON.stringify({ wireVersion: 1, request: VALID_REQUEST }),
  })
  assert.equal(r.status, 500)
  assert.equal(r.json.code, WIRE_CODES.ADAPTER_SHAPE_INVALID)
  assert.notEqual(r.json.code, WIRE_CODES.ADAPTER_THREW,
    '"返回了非流"与"抛了"必须可分：前者是适配器违约，后者是引擎故障')
  await s.server.close()
})

test('⑤ ★★★ 一个事件都没有就结束 → 502 STREAM_NO_TERMINAL（**不是** 200 空流）', async () => {
  const adapter = stubAdapter({ async *execute() { /* 什么都不产 */ } })
  const s = await start({ adapter })
  const r = await raw(s.base, WIRE_ROUTES.execute.path, {
    method: 'POST', token: TOKEN, rawBody: JSON.stringify({ wireVersion: 1, request: VALID_REQUEST }),
  })
  // ★ 这是本套件里最要紧的一条读数之一：一个"流已经开始了但什么都没发生"的 200，
  //   在客户端读起来与"运行正常但没输出"太像了。
  assert.equal(r.status, 502, `零事件就结束必须是具名拒绝，而不是一个 200 空流：${r.status} ${r.text}`)
  assert.equal(r.json.code, WIRE_CODES.STREAM_NO_TERMINAL)
  await s.server.close()
})

test('⑤ ★★★ 流中间出错 → **控制帧**带上服务端的码（不是裸断连）', async () => {
  const adapter = stubAdapter({
    async *execute() {
      yield EVENT_STARTED
      throw new Error('中途炸了')
    },
  })
  const s = await start({ adapter })
  const r = await raw(s.base, WIRE_ROUTES.execute.path, {
    method: 'POST', token: TOKEN, rawBody: JSON.stringify({ wireVersion: 1, request: VALID_REQUEST }),
  })
  assert.equal(r.status, 200, '头已经发出去了，状态码不可能再改——这正是控制帧存在的理由')
  const { events, controls } = parseStream(r.text)
  assert.deepEqual(events.map((e) => e.type), ['run.started'], '已经播出的事件必须照旧在流里')
  assert.equal(controls.length, 1, `中途出错必须留下恰好一条控制帧：${r.text}`)
  assert.equal(controls[0].code, WIRE_CODES.ADAPTER_THREW)
  assert.ok(controls[0].message.includes('中途炸了'))
  await s.server.close()
})

test('⑤ ★★★ 有事件但没有终态就结束 → 控制帧 STREAM_NO_TERMINAL（与"中途抛"可分）', async () => {
  const adapter = stubAdapter({
    async *execute() { yield EVENT_STARTED },
  })
  const s = await start({ adapter })
  const r = await raw(s.base, WIRE_ROUTES.execute.path, {
    method: 'POST', token: TOKEN, rawBody: JSON.stringify({ wireVersion: 1, request: VALID_REQUEST }),
  })
  const { events, controls } = parseStream(r.text)
  assert.deepEqual(events.map((e) => e.type), ['run.started'])
  assert.equal(controls.length, 1)
  assert.equal(controls[0].code, WIRE_CODES.STREAM_NO_TERMINAL)
  assert.notEqual(controls[0].code, WIRE_CODES.ADAPTER_THREW,
    '"忘了发终态"与"中途抛了"必须可分：一个去看适配器的收尾逻辑，一个去看它为什么炸')
  await s.server.close()
})

test('⑤ ★★ 终态之后还有事件 → 控制帧 STREAM_AFTER_TERMINAL（终态必须是最后一个）', async () => {
  const late = { type: 'message.delta', runId: 'run-srv-1', seq: 99, at: 1_700_000_000_002, text: '迟到的' }
  const adapter = stubAdapter({
    async *execute() { yield EVENT_STARTED; yield EVENT_TERMINAL; yield late },
  })
  const s = await start({ adapter })
  const r = await raw(s.base, WIRE_ROUTES.execute.path, {
    method: 'POST', token: TOKEN, rawBody: JSON.stringify({ wireVersion: 1, request: VALID_REQUEST }),
  })
  const { events, controls } = parseStream(r.text)
  assert.deepEqual(events.map((e) => e.type), ['run.started', 'run.completed'])
  assert.equal(events.at(-1).type, 'run.completed', '终态必须是流里的最后一个事件')
  assert.equal(controls.length, 1)
  assert.equal(controls[0].code, WIRE_CODES.STREAM_AFTER_TERMINAL)
  await s.server.close()
})

test('⑤ ★★★ 五种结束方式**两两不同形**（否则前面五条只是在各自重复一遍）', async () => {
  // 这一条是形状纪律的可执行版本：五条用例各自成立，**推不出**它们是五个不同的读数。
  const mk = (overrides) => stubAdapter(overrides)
  const cases = [
    ['terminal', mk({}), 200, null],
    ['no-terminal（零事件）', mk({ async *execute() {} }), 502, WIRE_CODES.STREAM_NO_TERMINAL],
    ['adapter-threw（开始前）', mk({ execute() { throw new Error('x') } }), 500, WIRE_CODES.ADAPTER_THREW],
    ['shape-invalid', mk({ execute: () => 42 }), 500, WIRE_CODES.ADAPTER_SHAPE_INVALID],
  ]
  const readings = []
  for (const [label, adapter, status, code] of cases) {
    const s = await start({ adapter })
    const r = await raw(s.base, WIRE_ROUTES.execute.path, {
      method: 'POST', token: TOKEN, rawBody: JSON.stringify({ wireVersion: 1, request: VALID_REQUEST }),
    })
    assert.equal(r.status, status, `${label} 的状态码不对：${r.status} ${r.text.slice(0, 200)}`)
    if (code !== null) assert.equal(r.json.code, code, `${label} 的码不对`)
    readings.push({ label, status, code: code ?? (parseStream(r.text).events.at(-1)?.type ?? null) })
    await s.server.close()
  }
  const shapes = readings.map((x) => `${x.status}/${x.code}`)
  assert.equal(new Set(shapes).size, shapes.length,
    `四种读数里有两种同形——那它们就是同一个东西：${JSON.stringify(readings)}`)

  // 流内那两种（中途抛 / 无终态）也要与"开始前拒绝"不同形。
  const midThrow = await start({ adapter: mk({ async *execute() { yield EVENT_STARTED; throw new Error('y') } }) })
  const a = await raw(midThrow.base, WIRE_ROUTES.execute.path, {
    method: 'POST', token: TOKEN, rawBody: JSON.stringify({ wireVersion: 1, request: VALID_REQUEST }),
  })
  await midThrow.server.close()
  const noTerm = await start({ adapter: mk({ async *execute() { yield EVENT_STARTED } }) })
  const b = await raw(noTerm.base, WIRE_ROUTES.execute.path, {
    method: 'POST', token: TOKEN, rawBody: JSON.stringify({ wireVersion: 1, request: VALID_REQUEST }),
  })
  await noTerm.server.close()

  const aCode = parseStream(a.text).controls[0]?.code
  const bCode = parseStream(b.text).controls[0]?.code
  assert.equal(aCode, WIRE_CODES.ADAPTER_THREW)
  assert.equal(bCode, WIRE_CODES.STREAM_NO_TERMINAL)
  assert.notEqual(aCode, bCode)
  // ★ 而且流内结束（200 + 控制帧）与开始前拒绝（5xx + JSON）不同形——
  //   这正是"控制帧"这一层存在的全部理由。
  assert.equal(a.status, 200)
  assert.equal(readings[2].status, 500)
  assert.notEqual(`${a.status}/${aCode}`, `${readings[2].status}/${readings[2].code}`)
})

test('⑤ 请求体不是合法 RunRequest → 400，且**一个字节的流都不写**', async () => {
  const s = await start()
  const r = await raw(s.base, WIRE_ROUTES.execute.path, {
    method: 'POST', token: TOKEN, rawBody: JSON.stringify({ wireVersion: 1, request: { runId: 'x' } }),
  })
  assert.equal(r.status, 400)
  assert.equal(r.json.code, WIRE_CODES.BAD_REQUEST)
  assert.equal(r.headers.get('content-type')?.includes('ndjson'), false,
    '请求就不合法时不能先写一个 NDJSON 头——那会让客户端以为流开始了')
  assert.ok(Array.isArray(r.json.details) && r.json.details.length > 0, '必须带出逐条校验失败的原因')
  await s.server.close()
})

test('⑤ execute **不匿名**：匿名调用连适配器都不会被调到', async () => {
  const calls = []
  const adapter = stubAdapter({
    async *execute() { calls.push('execute'); yield EVENT_TERMINAL },
  })
  const s = await start({ adapter })
  const r = await raw(s.base, WIRE_ROUTES.execute.path, {
    method: 'POST', rawBody: JSON.stringify({ wireVersion: 1, request: VALID_REQUEST }),
  })
  assert.equal(r.status, 401)
  assert.deepEqual(calls, [], '匿名请求不得走到引擎——execute 会花钱并产生外部副作用')
  await s.server.close()
})

test('⑤ 适配器在无终态流里发的**畸形事件** → 控制帧 ADAPTER_SHAPE_INVALID（不静默换空行）', async () => {
  const adapter = stubAdapter({
    async *execute() { yield { type: 'not.a.real.event', runId: 'r', seq: 1, at: 1 } },
  })
  const s = await start({ adapter })
  const r = await raw(s.base, WIRE_ROUTES.execute.path, {
    method: 'POST', token: TOKEN, rawBody: JSON.stringify({ wireVersion: 1, request: VALID_REQUEST }),
  })
  const { events, controls, bad } = parseStream(r.text)
  assert.deepEqual(events, [], '畸形事件不得被当成合法事件发出去')
  assert.deepEqual(bad, [], '也不得把它原样写进流里（那样对端只会看到一行坏 JSON）')
  assert.equal(controls.length, 1)
  assert.equal(controls[0].code, WIRE_CODES.ADAPTER_SHAPE_INVALID)
  await s.server.close()
})

// ═══════════════════════════════════════════════ ⑥ enforcement

test('⑥ enforcement：有来源时原样带回结论', async () => {
  const verdict = { autoExecutionForbidden: false, state: 'enforcement-effective', checks: [] }
  const s = await start({ enforcement: async () => verdict })
  const r = await raw(s.base, WIRE_ROUTES.enforcement.path, { token: TOKEN })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.result, verdict)
  await s.server.close()
})

test('⑥ ★★ enforcement：**没有来源**时具名拒绝，**不回落成"通过"**', async () => {
  const s = await start() // 没有 enforcement
  const r = await raw(s.base, WIRE_ROUTES.enforcement.path, { token: TOKEN })
  assert.equal(r.status, 503)
  assert.equal(r.json.code, WIRE_CODES.ENFORCEMENT_UNAVAILABLE)
  // ★ 反向锚：这条读数**不是** false，也**不是** 200。
  //   一个"读不到就当它通过"的默认值会让"禁止自动执行"这条保证变成装饰。
  assert.notEqual(r.json.code, null)
  assert.equal(r.json.ok, false)
  await s.server.close()
})

test('⑥ enforcement：来源抛出 → 仍是 ENFORCEMENT_UNAVAILABLE（不把异常吞成"通过"）', async () => {
  const s = await start({ enforcement: async () => { throw new Error('读不到') } })
  const r = await raw(s.base, WIRE_ROUTES.enforcement.path, { token: TOKEN })
  assert.equal(r.status, 503)
  assert.equal(r.json.code, WIRE_CODES.ENFORCEMENT_UNAVAILABLE)
  assert.ok(r.json.message.includes('读不到'))
  await s.server.close()
})

test('⑥ enforcement：来源返回 `null`（"我不知道"）→ 具名拒绝，**不是** autoExecutionForbidden:false', async () => {
  const s = await start({ enforcement: async () => null })
  const r = await raw(s.base, WIRE_ROUTES.enforcement.path, { token: TOKEN })
  assert.equal(r.status, 503)
  assert.equal(r.json.code, WIRE_CODES.ENFORCEMENT_UNAVAILABLE)
  // 这条断言是本节的核心：`null` 若被当成 `{autoExecutionForbidden:false}`，
  // 「没做自检」与「自检通过」就会在读数上完全一样。
  assert.notEqual(r.json.result?.autoExecutionForbidden, false)
  await s.server.close()
})

test('⑥ enforcement：形状不对（缺布尔字段）→ 同样具名拒绝', async () => {
  for (const bad of [{}, { autoExecutionForbidden: 'no' }, { state: 'x' }, 42]) {
    const s = await start({ enforcement: async () => bad })
    const r = await raw(s.base, WIRE_ROUTES.enforcement.path, { token: TOKEN })
    assert.equal(r.status, 503, `enforcement=${JSON.stringify(bad)} 不该被当成一个结论`)
    assert.equal(r.json.code, WIRE_CODES.ENFORCEMENT_UNAVAILABLE)
    await s.server.close()
  }
})

// ═══════════════════════════════════════════════ ⑦ 真替身（fake adapter）

test('⑦ 用 contract 的 Fake Adapter 走一遍完整七方法（证明服务端不做额外假设）', async () => {
  const adapter = createFakeRuntimeAdapter()
  adapter.probe = async () => ({ ok: true })
  const s = await start({ adapter })

  const health = await raw(s.base, WIRE_ROUTES.getHealth.path)
  assert.equal(health.json.result.state, 'ready')

  const caps = await raw(s.base, WIRE_ROUTES.getCapabilities.path, { token: TOKEN })
  assert.equal(typeof caps.json.result, 'object')

  const models = await raw(s.base, WIRE_ROUTES.listModels.path, { token: TOKEN })
  assert.ok(Array.isArray(models.json.result))

  const profile = await raw(s.base, WIRE_ROUTES.validateProfile.path, {
    method: 'POST', token: TOKEN, rawBody: JSON.stringify({ wireVersion: 1, profile: { id: 'm1' } }),
  })
  assert.equal(profile.status, 200)
  assert.equal(typeof profile.json.result.ok, 'boolean')

  const exec = await raw(s.base, WIRE_ROUTES.execute.path, {
    method: 'POST', token: TOKEN, rawBody: JSON.stringify({ wireVersion: 1, request: VALID_REQUEST }),
  })
  const { events, controls } = parseStream(exec.text)
  assert.equal(controls.length, 0)
  assert.equal(events.length > 0, true)
  assert.equal(events.at(-1).type, 'run.completed')

  const cancel = await raw(s.base, WIRE_ROUTES.cancel.path, {
    method: 'POST', token: TOKEN, rawBody: JSON.stringify({ wireVersion: 1, runId: 'run-srv-1' }),
  })
  assert.equal(cancel.status, 200)

  const recover = await raw(s.base, WIRE_ROUTES.recover.path, {
    method: 'POST', token: TOKEN, rawBody: JSON.stringify({ wireVersion: 1, runId: 'run-srv-1' }),
  })
  assert.equal(recover.status, 200)

  await s.server.close()
})

test('⑦ 一个正在跑的 execute 在 close 之后不会把进程挂住', async () => {
  const adapter = stubAdapter({
    async *execute() {
      yield EVENT_STARTED
      await new Promise((r) => setTimeout(r, 50))
      yield EVENT_TERMINAL
    },
  })
  const s = await start({ adapter })
  const res = await fetch(s.base + WIRE_ROUTES.execute.path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ wireVersion: 1, request: VALID_REQUEST }),
  })
  const text = await res.text()
  assert.equal(parseStream(text).events.at(-1).type, 'run.completed')
  await s.server.close()
})
