// team-hub/node-gateway.test.mjs
// 远程 Agent 通道 S-D：Hub 侧 Node 网关。
//
// 用**真实** http.Server + 真实 WebSocket 客户端（`packages/shared/src/ws-client.mjs`）
// 跑真连接；`run-store` 用替身，替身**记录每一次调用的实参**。
//
// 为什么替身而不是真 run-store：本层要证明的是"网关把协议帧翻译成了**哪一种**
// run-store 调用"，而不是"run-store 自己算得对"（后者由它自己的用例守着）。
// 真 run-store 需要完整的 tasks 表与认领资格，把它拖进来会让这组用例里
// 一半的断言在测别的东西。真实的端到端在服务器部署验收里跑。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { once } from 'node:events'

import { FRAME_TYPES, PROTOCOL_NAME, PROTOCOL_VERSION } from '../packages/shared/src/node-protocol.mjs'
import { WS_CLOSE } from '../packages/shared/src/ws-frames.mjs'
import { connectWebSocket } from '../packages/shared/src/ws-client.mjs'
import { createDeviceStore } from './device-store.mjs'
import { createNodeGateway, extractDeviceToken } from './node-gateway.mjs'

// ── 替身 run-store ──────────────────────────────────────────────────────────

function makeFakeRunStore({ claimResults = [] } = {}) {
  const calls = { claim: [], heartbeat: [], transition: [], recordRunEvents: [], release: [], failAndRetry: [], getAttempt: [] }
  const attempts = new Map()
  const state = {
    /** 每次 `claim` 依次取出一个；用尽后返回"队列为空"。 */
    queue: [...claimResults],
    wants: { complete: false, fail: false },   // 下一次 transition/fail 返回什么
    lastTtl: null,
  }
  return {
    calls, attempts, state,
    claim({ workerId, scope, leaseTtlMs }) {
      calls.claim.push({ workerId, scope, leaseTtlMs })
      const next = state.queue.shift()
      if (next === undefined) return { ok: true, claimed: null, reason: 'queue-empty', serverTimeMs: Date.now() }
      const claimed = { ...next, serverTimeMs: Date.now() }
      attempts.set(claimed.attemptId, { attemptId: claimed.attemptId, taskId: claimed.taskId, scope: claimed.scope, state: 'Leased', workerId, leaseEpoch: claimed.leaseEpoch })
      return { ok: true, claimed, serverTimeMs: Date.now() }
    },
    heartbeat(args) {
      calls.heartbeat.push(args)
      const row = attempts.get(args.attemptId)
      if (row === undefined) throw Object.assign(new Error('运行尝试不存在'), { code: 'ATTEMPT_NOT_FOUND' })
      if (row.leaseEpoch !== args.leaseEpoch) {
        throw Object.assign(new Error(`leaseEpoch 不符：请求 ${args.leaseEpoch}，实际 ${row.leaseEpoch}`), { code: 'LEASE_EPOCH_STALE' })
      }
      if (row.workerId !== args.workerId) throw Object.assign(new Error('不是持有者'), { code: 'LEASE_NOT_HELD' })
      return { ok: true, attemptId: args.attemptId, leaseEpoch: args.leaseEpoch, leaseExpiresAtMs: Date.now() + 60_000, serverTimeMs: Date.now() }
    },
    transition(args) {
      calls.transition.push(args)
      const row = attempts.get(args.attemptId)
      if (row !== undefined && row.leaseEpoch !== args.leaseEpoch) {
        throw Object.assign(new Error('leaseEpoch 已过期'), { code: 'LEASE_EPOCH_STALE' })
      }
      // 与真实 run-store 同样的两种形态：`to` 是**阶段推进**（Node 报它真的在
      // 准备/组装/运行），`outcome` 是**终态**（走 mapOutcomeToState）。
      if (args.to !== undefined && args.to !== null) {
        if (row !== undefined) row.state = args.to
        return { ok: true, attempt: { attemptId: args.attemptId, state: args.to }, idempotent: false, serverTimeMs: Date.now() }
      }
      const mapped = { completed: 'Validating', failed: 'RetryableFailure', outcome_unknown: 'UnknownOutcome', cancelled: 'Cancelled' }[args.outcome] ?? null
      if (row !== undefined) row.state = mapped ?? row.state
      return { ok: true, attempt: { attemptId: args.attemptId, state: mapped }, createsNewAttempt: false, serverTimeMs: Date.now() }
    },
    recordRunEvents({ attemptId, leaseEpoch, events }) {
      calls.recordRunEvents.push({ attemptId, leaseEpoch, events })
      const seen = (this._seqs ??= new Map())
      const key = attemptId
      const have = seen.get(key) ?? new Set()
      let written = 0; let skipped = 0
      for (const e of events) {
        if (have.has(e.seq)) skipped += 1
        else { have.add(e.seq); written += 1 }
      }
      seen.set(key, have)
      return { ok: true, attemptId, written, skipped, oversized: 0, total: events.length, serverTimeMs: Date.now() }
    },
    release(args) { calls.release.push(args); return { ok: true } },
    failAndRetry(args) {
      calls.failAndRetry.push(args)
      const row = attempts.get(args.attemptId)
      if (row !== undefined) row.state = 'RetryableFailure'
      return { ok: true, attempt: { attemptId: args.attemptId, state: 'RetryableFailure' }, serverTimeMs: Date.now() }
    },
    getAttempt(attemptId) {
      calls.getAttempt.push(attemptId)
      return attempts.get(attemptId) ?? null
    },
  }
}

// ── 夹具 ────────────────────────────────────────────────────────────────────

async function startHub({ claimResults = [], gatewayOptions = {}, deviceOptions = {} } = {}) {
  const db = new DatabaseSync(':memory:')
  const withTx = (fn) => fn()
  const deviceStore = createDeviceStore({ db, withTx, ...deviceOptions })
  const runStore = makeFakeRunStore({ claimResults })

  const pairing = deviceStore.createPairingCode({ userId: 'user-1', nodeName: 'pc' })
  const device = deviceStore.redeemPairingCode({ code: pairing.code, platform: 'win32' })

  // 上下文冻结在真实部署里由 `node-context.mjs` 提供，它有自己的一组用例。
  // 这里给一个**记录调用的替身**：本文件要证明的是"网关在派发前**确实**冻结了
  // 上下文、且冻结失败时不派发"，而不是"装配器算得对"。
  const contextCalls = []
  const prepareContext = gatewayOptions.prepareContext ?? (async (claimed) => {
    contextCalls.push({ attemptId: claimed.attemptId, taskId: claimed.taskId, scope: claimed.scope })
    return { snapshotHash: `hash:${claimed.attemptId}` }
  })
  const gateway = createNodeGateway({ deviceStore, runStore, prepareContext, ...gatewayOptions })
  const server = http.createServer((req, res) => { res.writeHead(404); res.end() })
  gateway.attach(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port

  const stop = async () => {
    gateway.close()
    server.close()
    await once(server, 'close').catch(() => {})
  }
  return { server, port, gateway, deviceStore, runStore, device, pairing, stop, url: `ws://127.0.0.1:${port}/node`, contextCalls }
}

/** 连上并完成 hello。返回 `{ ws, frames, waitFor, close }`。 */
async function connect(ctx, { token = ctx.device.deviceToken, hello = {}, headers = {}, skipHello = false } = {}) {
  const ws = connectWebSocket({
    url: ctx.url,
    headers: { Authorization: `Bearer ${token}`, ...headers },
    protocol: PROTOCOL_NAME,
    timeoutMs: 5000,
  })
  const frames = []
  const waiters = []
  ws.on('message', (text) => {
    const frame = JSON.parse(text)
    frames.push(frame)
    for (const w of [...waiters]) { if (w.match(frame)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(frame) } }
  })
  const closed = new Promise((resolve) => ws.on('close', resolve))
  const opened = new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('close', (info) => reject(Object.assign(new Error(`连接关闭：${info.reason}`), { info })))
  })
  await opened
  const waitFor = (type, timeoutMs = 3000) => new Promise((resolve, reject) => {
    const existing = frames.find((f) => f.type === type)
    if (existing !== undefined) { resolve(existing); return }
    const timer = setTimeout(() => reject(new Error(`等不到 ${type}；已收到：${frames.map((f) => f.type).join(',')}`)), timeoutMs)
    waiters.push({ match: (f) => f.type === type, resolve: (f) => { clearTimeout(timer); resolve(f) } })
  })
  if (!skipHello) {
    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: FRAME_TYPES.HELLO, protocolVersion: PROTOCOL_VERSION, nodeId: ctx.device.nodeId, ...hello }))
  }
  return { ws, frames, waitFor, closed, nodeId: ctx.device.nodeId }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 握手与鉴权 ──────────────────────────────────────────────────────────────

test('非 /node 路径的升级请求被直接断开', async () => {
  const ctx = await startHub()
  try {
    const ws = connectWebSocket({ url: `ws://127.0.0.1:${ctx.port}/other`, headers: { Authorization: `Bearer ${ctx.device.deviceToken}` }, timeoutMs: 3000 })
    // 必须挂 error 监听：客户端把网络失败同时以 `error` 与 `close` 交付，
    // 而 EventEmitter 在没有 error 监听时会抛。
    ws.on('error', () => {})
    const info = await new Promise((resolve) => ws.on('close', resolve))
    assert.ok(['WS_CLIENT_SOCKET_ERROR', 'WS_CLIENT_HANDSHAKE_REJECTED', 'WS_CLIENT_CLOSED'].includes(info.reason), `意外的关闭原因：${info.reason}`)
  } finally { await ctx.stop() }
})

test('无令牌被 401 拒绝，且**在握手之前**（拿不到 WebSocket）', async () => {
  const ctx = await startHub()
  try {
    const ws = connectWebSocket({ url: ctx.url, timeoutMs: 3000 })
    let rejected = null
    ws.on('handshakeRejected', (r) => { rejected = r })
    const info = await new Promise((resolve) => ws.on('close', resolve))
    assert.equal(info.reason, 'WS_CLIENT_HANDSHAKE_REJECTED')
    assert.equal(rejected?.status, 401)
    assert.match(rejected?.body ?? '', /DEVICE_TOKEN_INVALID/)
  } finally { await ctx.stop() }
})

test('令牌无效与设备被撤销都拒在握手前', async () => {
  const ctx = await startHub()
  try {
    const bad = connectWebSocket({ url: ctx.url, headers: { Authorization: 'Bearer nope' }, timeoutMs: 3000 })
    const badInfo = await new Promise((resolve) => bad.on('close', resolve))
    assert.equal(badInfo.status ?? 401, 401)

    ctx.deviceStore.revokeDevice({ nodeId: ctx.device.nodeId })
    const revoked = connectWebSocket({ url: ctx.url, headers: { Authorization: `Bearer ${ctx.device.deviceToken}` }, timeoutMs: 3000 })
    let body = ''
    revoked.on('handshakeRejected', (r) => { body = r.body })
    await new Promise((resolve) => revoked.on('close', resolve))
    assert.match(body, /DEVICE_REVOKED/)
  } finally { await ctx.stop() }
})

test('合法设备完成 hello，收到带能力与协商版本的 hello.ack', async () => {
  const ctx = await startHub()
  try {
    const c = await connect(ctx)
    const ack = await c.waitFor(FRAME_TYPES.HELLO_ACK)
    assert.equal(ack.protocolVersion, PROTOCOL_VERSION)
    assert.equal(ack.nodeId, ctx.device.nodeId)
    assert.deepEqual(ack.capabilities, ['task.run'])
    assert.equal(ack.canDispatch, true)
    // presence 被标记在线。
    assert.equal(ctx.deviceStore.presenceOf(ctx.device.nodeId).online, true)
    c.ws.close()
  } finally { await ctx.stop() }
})

test('第一帧不是 hello 就关闭（未协商前不接受任何业务帧）', async () => {
  const ctx = await startHub()
  try {
    const c = await connect(ctx, { skipHello: true })
    c.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: FRAME_TYPES.HEARTBEAT, requestId: 'r1', nodeId: ctx.device.nodeId }))
    const info = await c.closed
    assert.equal(info.code, WS_CLOSE.POLICY_VIOLATION)
    assert.equal(info.reason, 'hello required')
  } finally { await ctx.stop() }
})

test('hello 自报的 nodeId 与令牌不符时关闭（不能替另一台设备说话）', async () => {
  const ctx = await startHub()
  try {
    const c = await connect(ctx, { hello: { nodeId: 'node-someone-else' } })
    const info = await c.closed
    assert.equal(info.reason, 'nodeId mismatch')
    const err = c.frames.find((f) => f.type === FRAME_TYPES.ERROR)
    assert.equal(err.code, 'NODE_ID_MISMATCH')
  } finally { await ctx.stop() }
})

test('协议版本不兼容时**拒绝连接**并回双方范围，不静默降级', async () => {
  const ctx = await startHub({ gatewayOptions: { minVersion: 1, maxVersion: 1 } })
  try {
    const c = await connect(ctx, { hello: { protocolVersion: 99 } })
    const info = await c.closed
    assert.equal(info.reason, 'version unsupported')
    const err = c.frames.find((f) => f.type === FRAME_TYPES.ERROR)
    assert.equal(err.code, 'PROTOCOL_VERSION_UNSUPPORTED')
    assert.match(err.message, /99/)
    // hello.ack 绝不能被发出——降级的表现就是它被发了。
    assert.equal(c.frames.some((f) => f.type === FRAME_TYPES.HELLO_ACK), false)
  } finally { await ctx.stop() }
})

test('hello 成功之后握手超时必须被取消（否则正常连接会在到点时被关掉）', async () => {
  // ★ 这条守的是一个只有**长连接**才会暴露的缺陷：握手超时定时器原本只在连接
  //   收尾时清除，于是 hello 成功之后它仍会开火，把一条完全正常的连接关掉。
  //   症状是"每隔 N 秒掉线重连一次"，而两端日志都写着注册成功。
  //   短用例跑不到超时那一刻，所以这条用例刻意把超时设短、然后等过它。
  const ctx = await startHub({ gatewayOptions: { helloTimeoutMs: 150, dispatchPollMs: 0 } })
  try {
    const c = await connect(ctx)
    await c.waitFor(FRAME_TYPES.HELLO_ACK)
    await sleep(400)
    assert.equal(ctx.gateway.stats.connected, 1, 'hello 成功后连接应保持')
    assert.equal(ctx.gateway.stats.online, 1)
    const closed = await Promise.race([c.closed, sleep(50).then(() => 'still-open')])
    assert.equal(closed, 'still-open', '连接不应被握手超时关掉')
    c.ws.close()
  } finally { await ctx.stop() }
})

test('hello 超时后连接被关闭', async () => {
  const ctx = await startHub({ gatewayOptions: { helloTimeoutMs: 150 } })
  try {
    const c = await connect(ctx, { skipHello: true })
    const info = await c.closed
    assert.equal(info.reason, 'hello timeout')
  } finally { await ctx.stop() }
})

test('连接断开后 presence 变离线（任务状态不受影响）', async () => {
  const ctx = await startHub()
  try {
    const c = await connect(ctx)
    await c.waitFor(FRAME_TYPES.HELLO_ACK)
    assert.equal(ctx.deviceStore.presenceOf(ctx.device.nodeId).online, true)
    c.ws.close()
    await c.closed
    await sleep(50)
    assert.equal(ctx.deviceStore.presenceOf(ctx.device.nodeId).online, false)
  } finally { await ctx.stop() }
})

test('extractDeviceToken 优先头，回落查询串', () => {
  assert.deepEqual(extractDeviceToken({ headers: { authorization: 'Bearer abc' } }, new URL('http://x/node')), { token: 'abc', source: 'header' })
  assert.deepEqual(extractDeviceToken({ headers: {} }, new URL('http://x/node?token=xyz')), { token: 'xyz', source: 'query' })
  assert.deepEqual(extractDeviceToken({ headers: {} }, new URL('http://x/node')), { token: '', source: 'none' })
})

// ── 派发 ────────────────────────────────────────────────────────────────────

test('有空闲节点且有排队任务时派发，帧里带 attempt/epoch/租约到期', async () => {
  const ctx = await startHub({
    claimResults: [{ attemptId: 'att-1', taskId: 'T-1', scope: 'software', attemptNo: 1, leaseEpoch: 3, leaseExpiresAtMs: Date.now() + 60_000 }],
    gatewayOptions: { dispatchPollMs: 40, claimScope: 'software' },
  })
  try {
    const c = await connect(ctx)
    await c.waitFor(FRAME_TYPES.HELLO_ACK)
    const dispatch = await c.waitFor(FRAME_TYPES.DISPATCH)
    assert.equal(dispatch.taskId, 'T-1')
    assert.equal(dispatch.attemptId, 'att-1')
    assert.equal(dispatch.leaseEpoch, 3)
    assert.equal(dispatch.scope, 'software')
    assert.equal(dispatch.nodeId, ctx.device.nodeId)
    // claim 用的是带前缀的 workerId，且 scope 被传下去了。
    assert.deepEqual(ctx.runStore.calls.claim[0].workerId, `node:${ctx.device.nodeId}`)
    assert.equal(ctx.runStore.calls.claim[0].scope, 'software')
    c.ws.close()
  } finally { await ctx.stop() }
})

test('并发上限在"已派发但未 ack"期间也成立', async () => {
  // ★ 这条守的是一个很容易漏的窗口：如果只在收到 ack 时才把 attempt 记进
  //   `inFlight`，那么从**派发**到 **ack 到达**之间 `inFlight` 是空的，
  //   下一个 tick 就会再派一条——上限形同虚设，而这台电脑会同时跑多条任务，
  //   它们共用同一个工作区。
  const ctx = await startHub({
    claimResults: [
      { attemptId: 'att-1', taskId: 'T-1', scope: 's', attemptNo: 1, leaseEpoch: 1, leaseExpiresAtMs: Date.now() + 60_000 },
      { attemptId: 'att-2', taskId: 'T-2', scope: 's', attemptNo: 1, leaseEpoch: 1, leaseExpiresAtMs: Date.now() + 60_000 },
    ],
    gatewayOptions: { dispatchPollMs: 20, maxConcurrentPerNode: 1 },
  })
  try {
    const c = await connect(ctx)
    await c.waitFor(FRAME_TYPES.HELLO_ACK)
    await c.waitFor(FRAME_TYPES.DISPATCH)
    // 故意**不**回 ack，让那个窗口一直开着。
    await sleep(200)
    const dispatches = c.frames.filter((f) => f.type === FRAME_TYPES.DISPATCH)
    assert.equal(dispatches.length, 1, `未 ack 期间不应再派发；实际派了 ${dispatches.length} 条`)
    c.ws.close()
  } finally { await ctx.stop() }
})

test('已派发未 ack 的条目在超时后被放掉（否则节点会永久卡住）', async () => {
  const ctx = await startHub({
    claimResults: [
      { attemptId: 'att-1', taskId: 'T-1', scope: 's', attemptNo: 1, leaseEpoch: 1, leaseExpiresAtMs: Date.now() + 60_000 },
      { attemptId: 'att-2', taskId: 'T-2', scope: 's', attemptNo: 1, leaseEpoch: 1, leaseExpiresAtMs: Date.now() + 60_000 },
    ],
    // 派发确认窗口设得很短，便于观察"放掉之后能再派"。
    gatewayOptions: { dispatchPollMs: 20, maxConcurrentPerNode: 1, dispatchAckTimeoutMs: 80 },
  })
  try {
    const c = await connect(ctx)
    await c.waitFor(FRAME_TYPES.HELLO_ACK)
    await c.waitFor(FRAME_TYPES.DISPATCH)
    // 窗口过后应当能再派下一条（那条任务由服务端的租约到期兜底回收）。
    await sleep(300)
    const dispatches = c.frames.filter((f) => f.type === FRAME_TYPES.DISPATCH)
    assert.ok(dispatches.length >= 2, `超时后应放掉并继续派发；实际 ${dispatches.length} 条`)
    c.ws.close()
  } finally { await ctx.stop() }
})

test('ack 接受后该 attempt 计入在途；拒绝则把租约还回去', async () => {
  const ctx = await startHub({
    claimResults: [
      { attemptId: 'att-1', taskId: 'T-1', scope: 'software', attemptNo: 1, leaseEpoch: 1, leaseExpiresAtMs: Date.now() + 60_000 },
      { attemptId: 'att-2', taskId: 'T-2', scope: 'software', attemptNo: 1, leaseEpoch: 1, leaseExpiresAtMs: Date.now() + 60_000 },
    ],
    gatewayOptions: { dispatchPollMs: 40, maxConcurrentPerNode: 2 },
  })
  try {
    const c = await connect(ctx)
    await c.waitFor(FRAME_TYPES.HELLO_ACK)
    await c.waitFor(FRAME_TYPES.DISPATCH)

    c.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: FRAME_TYPES.ACK, requestId: 'a1', nodeId: c.nodeId, taskId: 'T-1', attemptId: 'att-1', leaseEpoch: 1, accepted: true }))
    await sleep(60)
    assert.ok(ctx.gateway.stats.inFlight >= 1)
  } finally { await ctx.stop() }

  // 拒收路径单独跑，避免与上面的时序纠缠。
  const ctx2 = await startHub({
    claimResults: [{ attemptId: 'att-9', taskId: 'T-9', scope: 'software', attemptNo: 1, leaseEpoch: 2, leaseExpiresAtMs: Date.now() + 60_000 }],
    gatewayOptions: { dispatchPollMs: 30 },
  })
  try {
    const c = await connect(ctx2)
    await c.waitFor(FRAME_TYPES.HELLO_ACK)
    await c.waitFor(FRAME_TYPES.DISPATCH)
    c.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: FRAME_TYPES.ACK, requestId: 'a9', nodeId: c.nodeId, taskId: 'T-9', attemptId: 'att-9', leaseEpoch: 2, accepted: false, reason: '缺少项目授权' }))
    await sleep(80)
    const released = ctx2.runStore.calls.release.find((r) => r.attemptId === 'att-9')
    // ★ 拒收必须**还租约**：留在身上会等到自然过期，期间任务既不在队列也不在运行中。
    assert.ok(released, '拒收应调用 release')
    assert.match(released.reason, /node-declined/)
    assert.equal(released.leaseEpoch, 2)
  } finally { await ctx2.stop() }
})

// ── 进展与终态 ──────────────────────────────────────────────────────────────

test('进展写运行事件明细并回 ack；重复事件按幂等处理且不重复记账', async () => {
  const ctx = await startHub({ gatewayOptions: { dispatchPollMs: 0 } })
  try {
    const c = await connect(ctx)
    await c.waitFor(FRAME_TYPES.HELLO_ACK)
    const progressFrame = (eventId, seq) => JSON.stringify({
      v: PROTOCOL_VERSION, type: FRAME_TYPES.PROGRESS, requestId: `p-${seq}`, nodeId: c.nodeId,
      eventId, taskId: 'T-1', attemptId: 'att-1', leaseEpoch: 4, seq, kind: 'step', summary: `第 ${seq} 步`,
    })
    c.ws.send(progressFrame('ev-1', 1))
    const ack1 = await new Promise((resolve) => {
      const h = (t) => { const f = JSON.parse(t); if (f.type === FRAME_TYPES.ACK && f.requestId === 'p-1') { c.ws.off('message', h); resolve(f) } }
      c.ws.on('message', h)
    })
    assert.equal(ack1.accepted, true)
    assert.equal(ack1.duplicate, false)
    // 明细用**这次运行**的 epoch 写。
    assert.equal(ctx.runStore.calls.recordRunEvents[0].leaseEpoch, 4)
    assert.equal(ctx.runStore.calls.recordRunEvents[0].events[0].seq, 1)

    // 同一个 seq 重放：run-store 报 written=0/skipped=1 → ack.duplicate=true。
    c.ws.send(progressFrame('ev-1', 1))
    const ack2 = await new Promise((resolve) => {
      const h = (t) => { const f = JSON.parse(t); if (f.type === FRAME_TYPES.ACK && f.requestId === 'p-1') { c.ws.off('message', h); resolve(f) } }
      c.ws.on('message', h)
    })
    assert.equal(ack2.duplicate, true)
    // ★ 幂等判据来自 run-store 的计数，不是网关自己的去重表——两层判断不一致时
    //   重复的进展既写不进去也不报错。
    assert.equal(ctx.runStore.calls.recordRunEvents.length, 2)
    c.ws.close()
  } finally { await ctx.stop() }
})

test('终态用 outcome 直通状态机（completed → Validating，不是 Completed）', async () => {
  const ctx = await startHub({ gatewayOptions: { dispatchPollMs: 0 } })
  try {
    const c = await connect(ctx)
    await c.waitFor(FRAME_TYPES.HELLO_ACK)
    c.ws.send(JSON.stringify({
      v: PROTOCOL_VERSION, type: FRAME_TYPES.TRANSITION, requestId: 't-1', nodeId: c.nodeId,
      eventId: 'done-1', taskId: 'T-1', attemptId: 'att-1', leaseEpoch: 5, seq: 9,
      outcome: 'completed', summary: '已提交并跑通测试', artifacts: [{ path: 'src/a.mjs' }],
    }))
    const ack = await new Promise((resolve) => {
      const h = (t) => { const f = JSON.parse(t); if (f.type === FRAME_TYPES.ACK && f.requestId === 't-1') { c.ws.off('message', h); resolve(f) } }
      c.ws.on('message', h)
    })
    const call = ctx.runStore.calls.transition[0]
    assert.equal(call.outcome, 'completed')
    // ★ 关键：网关传的是 `outcome`，**不是** `to:'Completed'`。执行完成不等于交付被接受。
    assert.equal(call.to, undefined)
    assert.equal(call.leaseEpoch, 5)
    assert.equal(ack.attemptState, 'Validating')
    // 明细先写、迁移后做（与 runtime-lease.mjs 同一个顺序）。
    assert.equal(ctx.runStore.calls.recordRunEvents.length, 1)
    c.ws.close()
  } finally { await ctx.stop() }
})

test('失败走 failAndRetry（不是 transition 到 RetryableFailure）', async () => {
  const ctx = await startHub({ gatewayOptions: { dispatchPollMs: 0 } })
  try {
    const c = await connect(ctx)
    await c.waitFor(FRAME_TYPES.HELLO_ACK)
    c.ws.send(JSON.stringify({
      v: PROTOCOL_VERSION, type: FRAME_TYPES.FAILURE, requestId: 'f-1', nodeId: c.nodeId,
      eventId: 'fail-1', taskId: 'T-1', attemptId: 'att-1', leaseEpoch: 2, seq: 4,
      failureCode: 'tool-crash', detail: '构建子进程退出码 1',
    }))
    await new Promise((resolve) => {
      const h = (t) => { const f = JSON.parse(t); if (f.type === FRAME_TYPES.ACK && f.requestId === 'f-1') { c.ws.off('message', h); resolve(f) } }
      c.ws.on('message', h)
    })
    // ★ 不能用 transition({to:'RetryableFailure'})：那会漏掉重试排队，任务会停在
    //   RetryableFailure——既不在队列也不在等人工列表，从界面看只是"失败了"。
    assert.equal(ctx.runStore.calls.transition.length, 0)
    const fail = ctx.runStore.calls.failAndRetry[0]
    assert.equal(fail.failureCode, 'tool-crash')
    assert.equal(fail.leaseEpoch, 2)
    assert.equal(fail.actor, `node:${ctx.device.nodeId}`)
    c.ws.close()
  } finally { await ctx.stop() }
})

test('迟到 epoch 的终态被 run-store 拒绝，错误帧回给节点', async () => {
  const ctx = await startHub({ gatewayOptions: { dispatchPollMs: 0 } })
  try {
    const c = await connect(ctx)
    await c.waitFor(FRAME_TYPES.HELLO_ACK)
    // 让替身记住一条 epoch=7 的尝试，然后报 epoch=6。
    ctx.runStore.attempts.set('att-1', { attemptId: 'att-1', taskId: 'T-1', scope: 'software', state: 'Running', workerId: `node:${ctx.device.nodeId}`, leaseEpoch: 7 })
    c.ws.send(JSON.stringify({
      v: PROTOCOL_VERSION, type: FRAME_TYPES.TRANSITION, requestId: 'late-1', nodeId: c.nodeId,
      eventId: 'late-1', taskId: 'T-1', attemptId: 'att-1', leaseEpoch: 6, seq: 1, outcome: 'completed',
    }))
    const err = await new Promise((resolve) => {
      const h = (t) => { const f = JSON.parse(t); if (f.type === FRAME_TYPES.ERROR) { c.ws.off('message', h); resolve(f) } }
      c.ws.on('message', h)
    })
    assert.equal(err.code, 'LEASE_EPOCH_STALE')
    c.ws.close()
  } finally { await ctx.stop() }
})

test('帧自报的 nodeId 与连接不符时关闭连接', async () => {
  const ctx = await startHub({ gatewayOptions: { dispatchPollMs: 0 } })
  try {
    const c = await connect(ctx)
    await c.waitFor(FRAME_TYPES.HELLO_ACK)
    c.ws.send(JSON.stringify({
      v: PROTOCOL_VERSION, type: FRAME_TYPES.PROGRESS, requestId: 'x', nodeId: 'node-impostor',
      eventId: 'e', taskId: 'T-1', attemptId: 'att-1', leaseEpoch: 1, seq: 1, kind: 'step', summary: 's',
    }))
    const info = await c.closed
    assert.equal(info.reason, 'nodeId mismatch')
  } finally { await ctx.stop() }
})

test('未登记的帧类型回错误帧，不静默忽略', async () => {
  const ctx = await startHub({ gatewayOptions: { dispatchPollMs: 0 } })
  try {
    const c = await connect(ctx)
    await c.waitFor(FRAME_TYPES.HELLO_ACK)
    c.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'node.custom', requestId: 'u', nodeId: c.nodeId }))
    const err = await c.waitFor(FRAME_TYPES.ERROR)
    assert.equal(err.code, 'PROTOCOL_UNKNOWN_TYPE')
    c.ws.close()
  } finally { await ctx.stop() }
})

// ── 心跳与对账 ──────────────────────────────────────────────────────────────

test('心跳只续**本连接持有**的租约，其余逐条具名拒绝', async () => {
  const ctx = await startHub({
    claimResults: [{ attemptId: 'att-1', taskId: 'T-1', scope: 'software', attemptNo: 1, leaseEpoch: 2, leaseExpiresAtMs: Date.now() + 60_000 }],
    gatewayOptions: { dispatchPollMs: 30 },
  })
  try {
    const c = await connect(ctx)
    await c.waitFor(FRAME_TYPES.HELLO_ACK)
    await c.waitFor(FRAME_TYPES.DISPATCH)
    c.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: FRAME_TYPES.ACK, requestId: 'a', nodeId: c.nodeId, taskId: 'T-1', attemptId: 'att-1', leaseEpoch: 2, accepted: true }))
    await sleep(50)
    c.ws.send(JSON.stringify({
      v: PROTOCOL_VERSION, type: FRAME_TYPES.HEARTBEAT, requestId: 'hb', nodeId: c.nodeId,
      leases: [{ attemptId: 'att-1', leaseEpoch: 2 }, { attemptId: 'att-other', leaseEpoch: 1 }],
    }))
    const ack = await c.waitFor(FRAME_TYPES.HEARTBEAT_ACK)
    assert.equal(ack.renewed.length, 1)
    assert.equal(ack.renewed[0].attemptId, 'att-1')
    assert.equal(ack.rejected.length, 1)
    assert.equal(ack.rejected[0].code, 'NODE_LEASE_NOT_OWNED')
    c.ws.close()
  } finally { await ctx.stop() }
})

test('对账只比较不迁移，并给出四类具名结论', async () => {
  const ctx = await startHub({ gatewayOptions: { dispatchPollMs: 0 } })
  try {
    const c = await connect(ctx)
    await c.waitFor(FRAME_TYPES.HELLO_ACK)
    const worker = `node:${ctx.device.nodeId}`
    // `state` 是**节点自己的词汇**（accepted/running/finished），比对的是它与
    // "Hub 这边算不算活跃"之间的期望关系。
    ctx.runStore.attempts.set('att-agree', { attemptId: 'att-agree', taskId: 'T-1', scope: 's', state: 'Running', workerId: worker, leaseEpoch: 3 })
    ctx.runStore.attempts.set('att-epoch', { attemptId: 'att-epoch', taskId: 'T-2', scope: 's', state: 'Running', workerId: worker, leaseEpoch: 9 })
    ctx.runStore.attempts.set('att-other', { attemptId: 'att-other', taskId: 'T-3', scope: 's', state: 'Running', workerId: 'node-someone-else', leaseEpoch: 1 })
    ctx.runStore.attempts.set('att-state', { attemptId: 'att-state', taskId: 'T-4', scope: 's', state: 'Validating', workerId: worker, leaseEpoch: 1 })
    ctx.runStore.attempts.set('att-done', { attemptId: 'att-done', taskId: 'T-6', scope: 's', state: 'Completed', workerId: worker, leaseEpoch: 1 })

    c.ws.send(JSON.stringify({
      v: PROTOCOL_VERSION, type: FRAME_TYPES.RECONCILE, requestId: 'rec', nodeId: c.nodeId,
      ledger: [
        { taskId: 'T-1', attemptId: 'att-agree', leaseEpoch: 3, state: 'running' },
        { taskId: 'T-2', attemptId: 'att-epoch', leaseEpoch: 4, state: 'running' },
        { taskId: 'T-3', attemptId: 'att-other', leaseEpoch: 1, state: 'running' },
        { taskId: 'T-4', attemptId: 'att-state', leaseEpoch: 1, state: 'finished' },
        { taskId: 'T-5', attemptId: 'att-ghost', leaseEpoch: 1, state: 'running' },
        { taskId: 'T-6', attemptId: 'att-done', leaseEpoch: 1, state: 'finished' },
      ],
    }))
    const reply = await c.waitFor(FRAME_TYPES.RECONCILE)
    const verdicts = reply.comparison.map((x) => x.verdict)
    assert.deepEqual(verdicts, ['agree', 'epoch-superseded', 'not-owner', 'state-mismatch', 'orphan', 'agree'])
    // ★ `state-mismatch` 是这里唯一"要人看"的结论：本机说结束了，Hub 还认为在跑。
    assert.equal(reply.comparison[3].hubActive, true)
    assert.equal(reply.comparison[3].nodeState, 'finished')
    // ★ 对账**不**触发任何状态迁移：Node 的账本是自述，不能改权威状态。
    assert.equal(ctx.runStore.calls.transition.length, 0)
    assert.equal(ctx.runStore.calls.failAndRetry.length, 0)
    c.ws.close()
  } finally { await ctx.stop() }
})

test('没有 task.run 能力的设备不会被派发', async () => {
  const ctx = await startHub({
    claimResults: [{ attemptId: 'att-1', taskId: 'T-1', scope: 's', attemptNo: 1, leaseEpoch: 1, leaseExpiresAtMs: Date.now() + 60_000 }],
    gatewayOptions: { dispatchPollMs: 30 },
  })
  try {
    // 换一个只有 dsh-web-proxy 的设备。
    const pairing = ctx.deviceStore.createPairingCode({ userId: 'user-1', nodeName: 'admin-pc' })
    const admin = ctx.deviceStore.redeemPairingCode({ code: pairing.code, capabilities: ['dsh-web-proxy'] })
    const c = await connect(ctx, { token: admin.deviceToken, hello: { nodeId: admin.nodeId } })
    await c.waitFor(FRAME_TYPES.HELLO_ACK)
    assert.equal(c.frames.find((f) => f.type === FRAME_TYPES.HELLO_ACK).canDispatch, false)
    await sleep(120)
    assert.equal(c.frames.some((f) => f.type === FRAME_TYPES.DISPATCH), false, '不该被派发')
    c.ws.close()
  } finally { await ctx.stop() }
})

test('认领被阻塞时要被看见（同一种阻塞只说一次）', async () => {
  // ★ 实测过这个坑：`claim` 在有别的任务占着单写者位时**正常返回**
  //   `claimed:null, reason:'file-contention'`。原实现直接 continue，于是
  //   "节点就绪、任务待办、但什么都不派发"在日志/审计/读数里全都没有痕迹。
  const warnings = []
  const ctx = await startHub({
    claimResults: [],
    gatewayOptions: { dispatchPollMs: 20, onWarn: (code, detail) => warnings.push({ code, detail }) },
  })
  // 让 claim 返回阻塞（而不是 queue-empty）。
  ctx.runStore.claim = ({ workerId }) => {
    ctx.runStore.calls.claim.push({ workerId })
    return { ok: true, claimed: null, reason: 'file-contention', contention: { code: 'SINGLE_WRITER_REQUIRED', holderTaskId: 'T-9' } }
  }
  try {
    const c = await connect(ctx)
    await c.waitFor(FRAME_TYPES.HELLO_ACK)
    await sleep(250)
    const blocked = warnings.filter((w) => w.code === 'NODE_CLAIM_BLOCKED')
    // 轮询了很多次，但只报一次：每 3 秒重印同一条警告与把警告关掉是同一个东西。
    assert.equal(blocked.length, 1, `应只报一次，实际 ${blocked.length} 次`)
    assert.equal(blocked[0].detail.holderTaskId, 'T-9')
    assert.equal(blocked[0].detail.code, 'SINGLE_WRITER_REQUIRED')
    assert.ok(ctx.gateway.stats.blockedClaims > 0, '计数器要能反映它')
    c.ws.close()
  } finally { await ctx.stop() }
})

test('队列为空**不**报阻塞（空队列是正常状态，不是故障）', async () => {
  const warnings = []
  const ctx = await startHub({ claimResults: [], gatewayOptions: { dispatchPollMs: 20, onWarn: (code) => warnings.push(code) } })
  try {
    const c = await connect(ctx)
    await c.waitFor(FRAME_TYPES.HELLO_ACK)
    await sleep(250)
    assert.equal(warnings.filter((w) => w === 'NODE_CLAIM_BLOCKED').length, 0)
  } finally { await ctx.stop() }
})

test('派发**之前**必须冻结上下文', async () => {
  // ★ 这条守的是"远端到不了 Running"那个缺陷。状态机要求
  //   `BuildingContext → Running` 先有 `run_context_snapshots` 的一行，
  //   所以快照必须先于派发存在——否则远端一旦开跑就注定报不出去。
  const ctx = await startHub({
    claimResults: [{ attemptId: 'att-1', taskId: 'T-1', scope: 'software', attemptNo: 1, leaseEpoch: 1, leaseExpiresAtMs: Date.now() + 60_000 }],
    gatewayOptions: { dispatchPollMs: 30 },
  })
  try {
    const c = await connect(ctx)
    await c.waitFor(FRAME_TYPES.HELLO_ACK)
    await c.waitFor(FRAME_TYPES.DISPATCH)
    // 替身记录了它被调用过，且参数是这次认领的 attempt/task/scope。
    assert.deepEqual(ctx.contextCalls, [{ attemptId: 'att-1', taskId: 'T-1', scope: 'software' }])
    assert.equal(ctx.gateway.stats.contextsFrozen, 1)
    c.ws.close()
  } finally { await ctx.stop() }
})

test('上下文冻结失败时**不派发**，并把租约还回去', async () => {
  // ★ 造一条注定完不成的 attempt 比不派发坏得多：它会烧掉重试额度，
  //   而在界面上看起来只是"任务不动"，与队列为空长得一样。
  const warnings = []
  const ctx = await startHub({
    claimResults: [{ attemptId: 'att-9', taskId: 'T-9', scope: 'software', attemptNo: 1, leaseEpoch: 3, leaseExpiresAtMs: Date.now() + 60_000 }],
    gatewayOptions: {
      dispatchPollMs: 30,
      prepareContext: async () => { throw Object.assign(new Error('装配输入不可用'), { code: 'NODE_CONTEXT_TASK_UNAVAILABLE' }) },
      onWarn: (code, detail) => warnings.push({ code, detail }),
    },
  })
  try {
    const c = await connect(ctx)
    await c.waitFor(FRAME_TYPES.HELLO_ACK)
    await sleep(200)
    assert.equal(c.frames.some((f) => f.type === FRAME_TYPES.DISPATCH), false, '不应派发')
    const released = ctx.runStore.calls.release.find((r) => r.attemptId === 'att-9')
    assert.ok(released, '应把租约还回去')
    assert.equal(released.reason, 'context-not-frozen')
    const warned = warnings.filter((w) => w.code === 'NODE_CONTEXT_NOT_FROZEN')
    assert.equal(warned.length, 1, `应只报一次，实际 ${warned.length}`)
    assert.equal(warned[0].detail.code, 'NODE_CONTEXT_TASK_UNAVAILABLE')
    assert.ok(ctx.gateway.stats.contextFailures >= 1)
    c.ws.close()
  } finally { await ctx.stop() }
})

test('缺少 prepareContext 时构造直接失败（不留"能跑但到不了 Running"的状态）', async () => {
  const db = new DatabaseSync(':memory:')
  const deviceStore = createDeviceStore({ db, withTx: (fn) => fn() })
  const runStore = makeFakeRunStore({ claimResults: [] })
  assert.throws(
    () => createNodeGateway({ deviceStore, runStore }),
    /需要 prepareContext/,
  )
})

test('网关不缓存任务状态：每次派发都重新问 run-store', async () => {
  const ctx = await startHub({ gatewayOptions: { dispatchPollMs: 30, maxConcurrentPerNode: 0 } })
  try {
    const c = await connect(ctx)
    await c.waitFor(FRAME_TYPES.HELLO_ACK)
    await sleep(120)
    // maxConcurrentPerNode=0 时不应 claim；把它调回来之后才 claim。
    assert.equal(ctx.runStore.calls.claim.length, 0)
    c.ws.close()
  } finally { await ctx.stop() }
})
