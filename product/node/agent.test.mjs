// product/node/agent.test.mjs
// 远程 Agent 通道 S-E：Node 客户端 ↔ 真实网关的端到端。
//
// 这里两端都是**真的**：真的 http.Server + 真网关 + 真 WebSocket + 真账本 +
// **真子进程**执行器。只有 `run-store` 是替身（它记录每一次调用的实参，
// 于是"客户端有没有按规矩上报"变成可直接断言的事实）。
//
// 这组用例是"手机派单 → 电脑执行 → 回报"这条链上唯一一处两端同时在场的地方。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { once } from 'node:events'

import { FRAME_TYPES } from '../../packages/shared/src/node-protocol.mjs'
import { createDeviceStore } from '../../team-hub/device-store.mjs'
import { createNodeGateway } from '../../team-hub/node-gateway.mjs'
import { createNodeAgent } from './agent.mjs'
import { createCommandExecutor } from './executor.mjs'
import { createRunLedger } from './ledger.mjs'

// ── 替身 run-store（记录实参） ──────────────────────────────────────────────

function fakeRunStore({ claimResults = [] } = {}) {
  const calls = { claim: [], transition: [], recordRunEvents: [], release: [], failAndRetry: [], heartbeat: [], getAttempt: [] }
  const attempts = new Map()
  let queue = [...claimResults]
  return {
    calls, attempts,
    push(claimed) { queue.push(claimed) },
    claim({ workerId }) {
      const next = queue.shift()
      calls.claim.push({ workerId })
      if (next === undefined) return { ok: true, claimed: null, reason: 'queue-empty' }
      attempts.set(next.attemptId, { attemptId: next.attemptId, taskId: next.taskId, scope: next.scope, state: 'Leased', workerId, leaseEpoch: next.leaseEpoch })
      return { ok: true, claimed: { ...next, serverTimeMs: Date.now() } }
    },
    heartbeat(args) {
      calls.heartbeat.push(args)
      return { ok: true, attemptId: args.attemptId, leaseEpoch: args.leaseEpoch, leaseExpiresAtMs: Date.now() + 60_000, serverTimeMs: Date.now() }
    },
    transition(args) {
      calls.transition.push(args)
      const row = attempts.get(args.attemptId)
      // `to` = 阶段推进（Node 报它真的在准备/组装/运行）；`outcome` = 终态。
      if (args.to !== undefined && args.to !== null) {
        if (row !== undefined) row.state = args.to
        return { ok: true, attempt: { attemptId: args.attemptId, state: args.to }, idempotent: false, serverTimeMs: Date.now() }
      }
      const mapped = { completed: 'Validating', failed: 'RetryableFailure', outcome_unknown: 'UnknownOutcome', cancelled: 'Cancelled' }[args.outcome]
      if (row !== undefined) row.state = mapped
      return { ok: true, attempt: { attemptId: args.attemptId, state: mapped }, serverTimeMs: Date.now() }
    },
    recordRunEvents({ attemptId, leaseEpoch, events }) {
      calls.recordRunEvents.push({ attemptId, leaseEpoch, events })
      return { ok: true, attemptId, written: events.length, skipped: 0, oversized: 0, total: events.length, serverTimeMs: Date.now() }
    },
    release(args) { calls.release.push(args); return { ok: true } },
    failAndRetry(args) { calls.failAndRetry.push(args); return { ok: true, attempt: { attemptId: args.attemptId, state: 'RetryableFailure' } } },
    getAttempt(id) { calls.getAttempt.push(id); return attempts.get(id) ?? null },
  }
}

async function startHub(claimResults = [], gatewayOptions = {}) {
  const db = new DatabaseSync(':memory:')
  const deviceStore = createDeviceStore({ db, withTx: (fn) => fn() })
  const runStore = fakeRunStore({ claimResults })
  const pairing = deviceStore.createPairingCode({ userId: 'user-1', nodeName: '书桌电脑' })
  const device = deviceStore.redeemPairingCode({ code: pairing.code, platform: 'win32' })
  const gateway = createNodeGateway({ deviceStore, runStore, dispatchPollMs: 30, ...gatewayOptions })
  const server = http.createServer((req, res) => { res.writeHead(404); res.end() })
  gateway.attach(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const stop = async () => {
    gateway.close()
    server.close()
    await once(server, 'close').catch(() => {})
  }
  return { gateway, deviceStore, runStore, device, stop, hubUrl: `ws://127.0.0.1:${server.address().port}/node` }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 等到条件成立，或超时抛错（附上当时的现场）。 */
async function until(predicate, { timeoutMs = 8000, label = '条件', detail = () => '' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(25)
  }
  throw new Error(`等待超时：${label}${detail() ? `；现场：${detail()}` : ''}`)
}

const nodeScript = (body) => createCommandExecutor({ command: process.execPath, args: ['-e', body] })

function makeAgent(hub, { executor, workspaces, backoff } = {}) {
  const ledger = createRunLedger({ file: null })
  const agent = createNodeAgent({
    hubUrl: hub.hubUrl,
    deviceToken: hub.device.deviceToken,
    nodeId: hub.device.nodeId,
    workspaces: workspaces ?? { software: { path: process.cwd() } },
    executor,
    ledger,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    backoff: backoff ?? { baseMs: 20, maxMs: 60, factor: 1.2, jitter: 0 },
  })
  return { agent, ledger }
}

const CLAIM = (over = {}) => ({ attemptId: 'att-1', taskId: 'T-1', scope: 'software', attemptNo: 1, leaseEpoch: 1, leaseExpiresAtMs: Date.now() + 60_000, ...over })

// ── 主链路 ──────────────────────────────────────────────────────────────────

/** 阶段推进与终态都走 `transition`，用 `outcome` 有没有值区分。 */
const terminalCall = (calls) => calls.find((c) => c.outcome !== undefined && c.outcome !== null)
const phaseCalls = (calls) => calls.filter((c) => c.to !== undefined && c.to !== null).map((c) => c.to)

test('派单→执行→进展→终态：整条链走通，且终态用 outcome 直通状态机', async () => {
  const hub = await startHub([CLAIM()])
  const { agent, ledger } = makeAgent(hub, {
    executor: nodeScript(`
      console.log(JSON.stringify({ type: 'progress', kind: 'step', summary: '正在运行测试' }));
      console.log(JSON.stringify({ type: 'result', outcome: 'completed', summary: '测试全过', artifacts: [{ path: 'reports/out.md', hash: 'sha256:aa', size: 10 }] }));
    `),
  })
  agent.start()
  try {
    await until(() => terminalCall(hub.runStore.calls.transition) !== undefined, { label: '终态上报' })
    const terminal = terminalCall(hub.runStore.calls.transition)
    assert.equal(terminal.outcome, 'completed')
    assert.equal(terminal.attemptId, 'att-1')
    assert.equal(terminal.leaseEpoch, 1)
    assert.equal(terminal.workerId, `node:${hub.device.nodeId}`)
    // ★ 阶段必须按状态机要求的顺序上报：跳步会被 Hub 以 TRANSITION_REJECTED 拒掉，
    //   而症状是"有进展但任务永远不结束"。
    assert.deepEqual(phaseCalls(hub.runStore.calls.transition), ['PreparingWorkspace', 'BuildingContext', 'Running'])
    // 进展也到了，且带的是**这次运行**的 epoch。
    const progress = hub.runStore.calls.recordRunEvents.find((c) => c.events.some((e) => e.type === 'node.progress'))
    assert.ok(progress, '应有进展事件')
    assert.equal(progress.leaseEpoch, 1)
    assert.match(progress.events[0].event.summary, /正在运行测试/)
    // 账本收尾。
    assert.equal(ledger.get('att-1').phase, 'finished')
    assert.equal(ledger.get('att-1').outcome, 'completed')
  } finally { agent.stop(); await hub.stop() }
})

test('未配置工作区的空间被具名拒收，并且把租约还回去', async () => {
  const hub = await startHub([CLAIM({ scope: 'someone-else' })])
  const { agent } = makeAgent(hub, { executor: nodeScript(`process.exit(9)`) })
  agent.start()
  try {
    await until(() => hub.runStore.calls.release.length > 0, { label: '拒收后的 release' })
    const release = hub.runStore.calls.release[0]
    assert.match(release.reason, /node-declined/)
    assert.match(release.reason, /NODE_WORKSPACE_NOT_AUTHORIZED/)
    // ★ 静默不接会让任务挂在租约上直到过期——期间它既不在队列也不在运行中。
    assert.equal(hub.runStore.calls.transition.length, 0)
  } finally { agent.stop(); await hub.stop() }
})

test('出境策略在**发送之前**生效：私钥块不会离开这台电脑', async () => {
  const hub = await startHub([CLAIM()])
  const { agent } = makeAgent(hub, {
    executor: nodeScript(`
      const key = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKC', '-----END RSA PRIVATE KEY-----'].join('\\n');
      console.log(JSON.stringify({ type: 'progress', kind: 'note', summary: '部署配置：' + key }));
      console.log(JSON.stringify({ type: 'result', outcome: 'completed', summary: 'ok' }));
    `),
  })
  agent.start()
  try {
    await until(() => hub.runStore.calls.recordRunEvents.some((c) => c.events.some((e) => e.type === 'node.progress')), { label: '进展上报' })
    const progress = hub.runStore.calls.recordRunEvents.find((c) => c.events.some((e) => e.type === 'node.progress'))
    const payload = JSON.stringify(progress.events[0].event)
    assert.ok(!payload.includes('BEGIN RSA PRIVATE KEY'), '私钥块绝不能出现在上报的载荷里')
    assert.match(payload, /已拦下/)
  } finally { agent.stop(); await hub.stop() }
})

test('执行失败走 **failure 帧**（而不是伪造成终态）', async () => {
  const hub = await startHub([CLAIM()])
  const { agent, ledger } = makeAgent(hub, { executor: nodeScript(`process.exit(5)`) })
  agent.start()
  try {
    // ★ 失败**必须**落到 `failAndRetry`。用 `transition{outcome:'failed'}` 也会
    //   把状态改成 RetryableFailure，但**漏掉重试排队与退避**——任务会停在那里，
    //   既不在队列也不在等人工列表里，从任何界面看都只是"失败了"。
    await until(() => hub.runStore.calls.failAndRetry.length > 0, { label: '失败结算' })
    // 阶段推进会走 transition（那是另一件事），但**终态**绝不能用 outcome 走 transition。
    assert.equal(terminalCall(hub.runStore.calls.transition), undefined, '失败不该走带 outcome 的 transition 路径')
    assert.equal(hub.runStore.calls.failAndRetry[0].failureCode, 'EXECUTOR_EXIT_NONZERO')
    assert.equal(ledger.get('att-1').outcome, 'failed')
  } finally { agent.stop(); await hub.stop() }
})

test('取消请求会真的停掉本地执行，并把结果报成 cancelled', async () => {
  const hub = await startHub([CLAIM()])
  const { agent } = makeAgent(hub, {
    executor: nodeScript(`
      console.log(JSON.stringify({ type: 'progress', kind: 'step', summary: '开始长任务' }));
      setTimeout(() => { console.log(JSON.stringify({ type: 'result', outcome: 'completed', summary: '不该到这里' })); }, 30000);
    `),
  })
  agent.start()
  try {
    await until(() => hub.gateway.stats.inFlight > 0, { label: '任务进入在途' })
    const sent = hub.gateway.sendCancel(hub.device.nodeId, { taskId: 'T-1', attemptId: 'att-1', leaseEpoch: 1, reason: '用户从手机取消' })
    assert.equal(sent.sent, true)
    await until(() => terminalCall(hub.runStore.calls.transition) !== undefined, { label: '取消后的终态' })
    assert.equal(terminalCall(hub.runStore.calls.transition).outcome, 'cancelled')
  } finally { agent.stop(); await hub.stop() }
})

test('对离线节点下发取消是具名失败，不是静默丢弃', async () => {
  const hub = await startHub([])
  try {
    const res = hub.gateway.sendCancel('node-not-connected', { taskId: 'T-1', attemptId: 'att-1', leaseEpoch: 1 })
    assert.equal(res.sent, false)
    assert.equal(res.reason, 'node-offline')
  } finally { await hub.stop() }
})

test('设备令牌无效时连不上，且不会无限加速重连', async () => {
  const hub = await startHub([])
  const ledger = createRunLedger({ file: null })
  const agent = createNodeAgent({
    hubUrl: hub.hubUrl,
    deviceToken: 'not-a-real-token',
    nodeId: 'node-x',
    workspaces: { software: { path: process.cwd() } },
    executor: nodeScript(''),
    ledger,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    backoff: { baseMs: 20, maxMs: 40, factor: 2, jitter: 0 },
  })
  agent.start()
  try {
    await sleep(400)
    assert.equal(agent.state.connected, false)
    // 重连发生了，且被退避（不是忙等）。
    assert.ok(agent.state.stats.connects >= 1)
    assert.ok(agent.state.stats.connects < 50, `重连次数应受退避约束，实际 ${agent.state.stats.connects}`)
  } finally { agent.stop(); await hub.stop() }
})

test('重连后把未收尾的尝试对账上去，且对账只带身份不带摘要', async () => {
  const hub = await startHub([])
  const ledger = createRunLedger({ file: null })
  // 伪造一条"上次跑崩了"的未收尾记录。
  ledger.record({ taskId: 'T-old', attemptId: 'att-old', leaseEpoch: 4, phase: 'running' })
  const agent = createNodeAgent({
    hubUrl: hub.hubUrl,
    deviceToken: hub.device.deviceToken,
    nodeId: hub.device.nodeId,
    workspaces: { software: { path: process.cwd() } },
    executor: nodeScript(''),
    ledger,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    heartbeatIntervalMs: 100,
    backoff: { baseMs: 20, maxMs: 40, factor: 1.2, jitter: 0 },
  })
  agent.start()
  try {
    // 网关收到 reconcile 后会读 getAttempt；att-old 不在 Hub 上 → orphan。
    await until(() => hub.runStore.calls.getAttempt.length > 0, { label: '对账发出', detail: () => JSON.stringify(agent.state) })
    assert.equal(hub.runStore.calls.getAttempt[0], 'att-old')
    // 对账之后账本里那条**仍然留着**：Hub 说它是 orphan，本机无权把它当成已解决。
    assert.ok(ledger.unsettled().some((e) => e.attemptId === 'att-old'))
  } finally { agent.stop(); await hub.stop() }
})

test('同一 attempt 的序号跨多次进展单调递增（不会被 Hub 当成重放）', async () => {
  const hub = await startHub([CLAIM()])
  const { agent } = makeAgent(hub, {
    executor: nodeScript(`
      for (let i = 1; i <= 4; i++) console.log(JSON.stringify({ type: 'progress', kind: 'step', summary: '第 ' + i + ' 步' }));
      console.log(JSON.stringify({ type: 'result', outcome: 'completed', summary: 'done' }));
    `),
  })
  agent.start()
  try {
    await until(() => hub.runStore.calls.recordRunEvents.length >= 4, { label: '四条进展' })
    const seqs = hub.runStore.calls.recordRunEvents.flatMap((c) => c.events.map((e) => e.seq))
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), '序号必须单调')
    assert.equal(new Set(seqs).size, seqs.length, '序号不得重复')
  } finally { agent.stop(); await hub.stop() }
})
