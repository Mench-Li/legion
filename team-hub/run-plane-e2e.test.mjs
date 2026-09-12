// team-hub/run-plane-e2e.test.mjs
// ============================================================================
// 运行面端到端：真实 team-hub + 真实 worker 客户端（PRT-301/302/303/313 的接线）
//
// 这一组存在的唯一理由：**两半各自全绿，合起来仍然是错的。**
// 上一批交付 worker 时，它的 hub 客户端把 `{ok, claimed}` 信封整个当成 claim 对象用；
// 仓储与 worker 的单测都发现不了这件事，因为各自都自洽：
//   - 仓储单测直接调函数，不经过 HTTP 信封；
//   - worker 单测用假 hub，假 hub 返回的就是「已经解包」的形状。
// 合起来的后果是：**任务被服务端领走（状态 Leased、租约在跑），
// 而 worker 以为队列是空的**——这条任务被领走却永远没人做，
// 只能等租约过期才被回收，而回收日志里看不出是谁领的。
//
// 因此这里不 mock 中间的协议：真实 listen(0) 的 team-hub、真实的
// createHubClient、真实的 createWorker，只是把执行引擎换成一个假的。
// ============================================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHubClient } from '../orchestrator/worker/run.mjs'
import { createWorker, inPlaceStages } from '../orchestrator/worker/main.mjs'

/**
 * 不带连接池的 fetch 实现（只给测试用）。
 *
 * 为什么不用全局 `fetch`：它背后的 undici 连接池会把 keep-alive 连接留着，
 * 而当测试里 `server.closeAllConnections()` 把服务端连接砍掉之后，
 * 池里那两个 socket 会**永久**挂在事件循环上——所有用例都通过、`after()` 也跑完了，
 * 进程就是不退出（实测卡死超过 90s；用 `process._getActiveHandles()` 逐轮 dump，
 * 清理后剩下的正是两个没有 remote 信息的 Socket，且没有 Schema 里的其它 handle）。
 *
 * 这是**测试脚手架**的问题，不是产品代码的问题：生产里的 worker 是长驻进程，
 * 连接池正是它想要的。因此在测试这一侧指定 `agent: false`（每次请求一条短连接），
 * 而不是为了跑测试去改产品的 HTTP 客户端行为。
 */
function unpooledFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      agent: false,
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json: async () => JSON.parse(text),
        })
      })
    })
    req.on('error', reject)
    if (init.body !== undefined) req.write(init.body)
    req.end()
  })
}

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-runplane-'))
let mod
let base = ''
let hub

before(async () => {
  process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_TOKEN = 'e2e-token'
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
  hub = createHubClient({ baseUrl: base, token: 'e2e-token', fetchImpl: unpooledFetch })
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close() } catch { /* 已关闭 */ }
  try { mod?.db?.close() } catch { /* 已关闭 */ }
  rmSync(tmpRoot, { recursive: true, force: true })
})

function insertTask(id, { status = 'todo', scope = 'default' } = {}) {
  mod.db.prepare(
    'INSERT OR REPLACE INTO tasks (id, title, priority, status, scope, hold, createdAt, updatedAt) VALUES (?,?,?,?,?,0,?,?)',
  ).run(id, id, 'medium', status, scope, new Date().toISOString(), new Date().toISOString())
  return id
}

const dataDirOf = (name) => join(tmpRoot, name)

/**
 * 只留这一条待办任务，其余一律标成已完成。
 *
 * 为什么必须这么做：这个文件是**有状态**的（一个真实库，前面用例留下的 todo 任务
 * 还在队列里），而领取是按优先级/时间取队首的。于是「我的 worker 会领到 e2e-7」
 * 这个假设在前面的用例留下一条未领取的 todo 时就不成立了——它领到的是更早那条。
 * 这个 bug 表现为 `attemptNo` 期望 2 实际 1，而真正的原因与 attempt 编号毫无关系。
 *
 * 与其在每个用例里小心翼翼地维持全局顺序，不如让每个用例**自己声明**
 * 「此刻队列里只该有这一条」。
 */
function onlyTask(id, opts = {}) {
  mod.db.prepare("UPDATE tasks SET status = 'done' WHERE status IN ('todo','backlog')").run()
  return insertTask(id, opts)
}

/**
 * 起一个 worker，并保证用例失败也不会把它留着。
 *
 * 一个被留下的 worker 会**永远**每 intervalMs 醒一次（心跳循环会自己续上下一次 sleep），
 * 于是 `node --test` 跑完所有断言也不退出。这个后果比失败本身更难查：
 * 挂住时控制台停在半路，看不到 `ℹ fail N` 那一行，
 * 于是一个断言失败被伪装成「测试卡住」。这正是本次调试踩到的坑。
 */
async function withWorker(options, fn) {
  const w = createWorker(options)
  try {
    return await fn(w)
  } finally {
    await w.stop({ reason: 'test-cleanup' })
  }
}

test('① 客户端解包：claim 返回的是 claim 对象本身，不是 HTTP 信封', async () => {
  onlyTask('e2e-1')
  const claimed = await hub.claim({ workerId: 'w-e2e' })
  assert.notEqual(claimed, null)
  assert.equal(claimed.taskId, 'e2e-1')
  // 这两个字段是后续 heartbeat/transition 的唯一凭据；缺一个就整条链路走不通
  assert.equal(typeof claimed.attemptId, 'string')
  assert.equal(claimed.leaseEpoch, 1)
  assert.equal(typeof claimed.leaseExpiresAtMs, 'number')
})

test('① worker 端到端：认领 → 执行 → 提交，看板投影到 in_review', async () => {
  onlyTask('e2e-2')
  const executed = []
  await withWorker({
    hub,
    executor: { ...inPlaceStages(), execute: async (lease) => { executed.push(lease.taskId); return { outcome: 'completed', detail: 'e2e' } } },
    dataDir: dataDirOf('data-a'),
    workerId: 'w-e2e-a',
    heartbeatIntervalMs: 50,
  }, async (w) => {
    const r = await w.tick()
    assert.equal(r.outcome, 'completed', JSON.stringify(r))
    assert.deepEqual(executed, ['e2e-2'])
    assert.equal(w.counters.claimed, 1)
    assert.equal(w.counters.completed, 1)
    // 关键：状态真的落到了库里，而不是只出现在 worker 的计数里
    const row = mod.db.prepare('SELECT state, worker_id FROM run_attempts WHERE task_id = ?').get('e2e-2')
    assert.equal(row.state, 'Validating', '执行完成 → 待验收（执行完成不等于交付被接受）')
    assert.equal(row.worker_id, 'w-e2e-a')
    assert.equal(mod.db.prepare('SELECT status FROM tasks WHERE id = ?').get('e2e-2').status, 'in_review')
  })
})

test('① 队列空时 worker 如实报 idle，不谎报「执行了一条」（信封误读的原始症状）', async () => {
  await withWorker({
    hub,
    executor: { ...inPlaceStages(), execute: async () => ({ outcome: 'completed' }) },
    dataDir: dataDirOf('data-b'),
    workerId: 'w-e2e-b',
  }, async (w) => {
    const r = await w.tick()
    assert.equal(r.acted, false)
    assert.equal(r.reason, 'queue-empty')
    assert.equal(w.counters.claimed, 0)
  })
})

test('① claim 缺少 attemptId 被当成协议错误，而不是空队列（任务被领走却没人做）', async () => {
  await withWorker({
    hub: { claim: async () => ({ taskId: 'ghost', leaseEpoch: 1 }) },
    executor: { ...inPlaceStages(), execute: async () => ({ outcome: 'completed' }) },
    dataDir: dataDirOf('data-c'),
    workerId: 'w-e2e-c',
  }, async (w) => {
    const r = await w.tick()
    assert.equal(r.acted, false)
    assert.equal(r.reason, 'claim-protocol-error')
    assert.match(w.snapshot().lastError.message, /协议不匹配/)
    assert.equal(w.counters.claimed, 0)
  })
})

test('② 心跳端到端：租约被真实续租（服务端算时间，不是 worker 自报）', async () => {
  onlyTask('e2e-3')
  let release
  const gate = new Promise((r) => { release = r })
  let beats = 0
  let enoughBeats
  const enough = new Promise((r) => { enoughBeats = r })
  const countingHub = {
    claim: (...a) => hub.claim(...a),
    transition: (...a) => hub.transition(...a),
    release: (...a) => hub.release(...a),
    async heartbeat(arg) {
      const r = await hub.heartbeat(arg)
      beats += 1
      if (beats >= 2 && enoughBeats !== null) { const f = enoughBeats; enoughBeats = null; f() }
      return r
    },
  }
  await withWorker({
    hub: countingHub,
    executor: { ...inPlaceStages(), execute: () => gate.then(() => ({ outcome: 'completed' })) },
    dataDir: dataDirOf('data-d'),
    workerId: 'w-e2e-d',
    heartbeatIntervalMs: 40,
  }, async (w) => {
    const tick = w.tick()
    await enough // 事件驱动：不 sleep 猜「200ms 应该够两次心跳了」
    assert.equal(w.snapshot().leaseMayBeLost, false)
    const row = mod.db.prepare('SELECT lease_expires_at_ms FROM run_attempts WHERE task_id = ?').get('e2e-3')
    assert.ok(row.lease_expires_at_ms > Date.now() + 60000, '续租后到期时间应当在前方')
    release()
    await tick
  })
})

test('③ epoch 拒写端到端：被回收后旧 worker 提交结果被拒，且收到 STALE + 真实 epoch', async () => {
  onlyTask('e2e-4')
  const first = await hub.claim({ workerId: 'w-old' })
  assert.equal(first.taskId, 'e2e-4')
  // 把租约推过期（不通过 HTTP：路由不提供伪造时间的入口，这正是设计意图）
  mod.db.prepare('UPDATE run_attempts SET lease_expires_at_ms = ? WHERE id = ?').run(Date.now() - 1, first.attemptId)
  const recovered = await hub.recover({
    externalEffectPossibleStates: ['Running', 'Validating'],
  })
  assert.equal(recovered.recovered.length, 1)
  assert.equal(recovered.recovered[0].action, 'retry-new-attempt')

  // 旧 worker 提交结果 → 必须被拒，而且它得知道为什么
  await assert.rejects(
    () => hub.transition({ attemptId: first.attemptId, leaseEpoch: first.leaseEpoch, workerId: 'w-old', outcome: 'completed' }),
    (e) => {
      assert.equal(e.code, 'LEASE_EPOCH_STALE', `实际错误：${e.message}`)
      assert.equal(e.currentEpoch, 2, '必须回报真实 epoch：worker 才能判断出「我该停手」')
      return true
    },
  )
  const row = mod.db.prepare('SELECT state, outcome FROM run_attempts WHERE id = ?').get(first.attemptId)
  assert.equal(row.state, 'RetryableFailure')
  assert.equal(row.outcome, null)
  // 新尝试可被真实 worker 领走（不丢任务）
  const second = await hub.claim({ workerId: 'w-new' })
  assert.equal(second.taskId, 'e2e-4')
  assert.equal(second.attemptNo, 2)
  await hub.release({ attemptId: second.attemptId, leaseEpoch: second.leaseEpoch, workerId: 'w-new', reason: 'test' })
})

test('③ worker 收到 STALE 后停止心跳并如实记录（不再徒劳重试）', async () => {
  onlyTask('e2e-5')
  const logs = []
  let release
  const gate = new Promise((r) => { release = r })
  let startedExec
  const started = new Promise((r) => { startedExec = r })
  let firstHeartbeat
  const heartbeats = new Promise((r) => { firstHeartbeat = r })
  // 同步靠**事件**，不靠 sleep 猜时间：固定次数的轮询在机器繁忙时会变成随机失败，
  // 而一个随机失败的用例最终会被当成噪声忽略——那还不如没有。
  const syncHub = {
    claim: (...a) => hub.claim(...a),
    transition: (...a) => hub.transition(...a),
    release: (...a) => hub.release(...a),
    async heartbeat(arg) {
      const r = await hub.heartbeat(arg)
      if (firstHeartbeat !== null) { const f = firstHeartbeat; firstHeartbeat = null; f() }
      return r
    },
  }
  await withWorker({
    hub: syncHub,
    executor: { ...inPlaceStages(), execute: () => { startedExec(); return gate.then(() => ({ outcome: 'completed' })) } },
    dataDir: dataDirOf('data-e'),
    workerId: 'w-e2e-e',
    heartbeatIntervalMs: 30,
    logger: (l) => logs.push(l),
  }, async (w) => {
    const tick = w.tick()
    await started
    await heartbeats
    // statusPath 是 worker 的公开 getter；快照里没有它（快照是给状态文件/CLI 用的数据）
    assert.ok(w.statusPath.endsWith('worker.status.json'), `statusPath=${w.statusPath}`)
    // 服务端侧把这条尝试的 epoch 推前，模拟「已被别人接管」
    const row = mod.db.prepare('SELECT id, lease_epoch FROM run_attempts WHERE task_id = ?').get('e2e-5')
    mod.db.prepare('UPDATE run_attempts SET lease_epoch = ? WHERE id = ?').run(row.lease_epoch + 1, row.id)

    await waitForLeaseLoss(w)
    assert.ok(w.snapshot().leaseMayBeLost, 'lease 丢失必须被记录，而不能只体现在日志里')
    assert.ok(w.counters.heartbeatFailures >= 1)
    assert.match(logs.join('\n'), /不再是持有者/)
    release({ outcome: 'completed' })
    await tick
  })
})

/**
 * 等到 worker 记录到「lease 可能已丢失」为止。
 *
 * 这里用轮询是可以的（目标是**外部**可观测的副作用），但上限必须充裕：
 * 它是一条超时线，不是时间假设。此前写成「最多 100 次 × 20ms = 2s」，
 * 在 CI 上与其它测试文件并发时就会偶尔超时——那种偶发失败最容易被误当成噪声。
 */
async function waitForLeaseLoss(w, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (!w.snapshot().leaseMayBeLost && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('④ 未配置执行引擎时一次都不认领：HTTP 层面也不得发出 claim', async () => {
  onlyTask('e2e-6')
  let claims = 0
  const countingHub = {
    claim: async (arg) => { claims += 1; return hub.claim(arg) },
    heartbeat: hub.heartbeat, transition: hub.transition, release: hub.release,
  }
  await withWorker({
    hub: countingHub,
    executor: null,
    dataDir: dataDirOf('data-f'),
    workerId: 'w-e2e-f',
  }, async (w) => {
    const r = await w.tick()
    assert.equal(r.reason, 'no-executor')
    assert.equal(claims, 0, '没有执行引擎时一次 claim 都不能发（否则会把重试额度烧光）')
  })
  // 任务仍在 todo，等待真正能执行它的 worker
  assert.equal(mod.db.prepare('SELECT status FROM tasks WHERE id = ?').get('e2e-6').status, 'todo')
})

test('⑤ 优雅停止：释放真实租约，任务随后可被另一个 worker 领走', async () => {
  onlyTask('e2e-7')
  let release
  const gate = new Promise((r) => { release = r })
  let startedExec
  const started = new Promise((r) => { startedExec = r })
  const w = createWorker({
    hub,
    executor: { ...inPlaceStages(), execute: () => { startedExec(); return gate.then(() => ({ outcome: 'completed' })) } },
    dataDir: dataDirOf('data-g'),
    workerId: 'w-e2e-g',
    heartbeatIntervalMs: 10000,
  })
  const tick = w.tick()
  try {
    // 等执行**真的开始**再停止：用 sleep 猜时间在机器繁忙时会随机失败
    await started
    const stopped = await w.stop({ reason: 'SIGTERM' })
    assert.equal(stopped.ok, true)
    assert.equal(stopped.released.ok, true, `释放失败：${JSON.stringify(stopped.released)}`)
    // 释放后任务立刻可被别的 worker 接手（不必等租期自然过期）
    const next = await hub.claim({ workerId: 'w-takeover' })
    assert.equal(next.taskId, 'e2e-7')
    assert.equal(next.attemptNo, 2, '接手的是**新的一次尝试**：第 1 次的历史必须保留')
    release({ outcome: 'completed' })
    await tick
    await hub.release({ attemptId: next.attemptId, leaseEpoch: next.leaseEpoch, workerId: 'w-takeover', reason: 'test' })
  } finally {
    // 断言失败也必须让执行放行，否则 tick 永远挂着、心跳循环永远续期，进程不退出
    release({ outcome: 'completed' })
    await w.stop({ reason: 'test-cleanup' })
    await tick
  }
})

test('⑤ 认证：不带 token 的 worker 请求被拒（运行面不是匿名可写的）', async () => {
  const bad = createHubClient({ baseUrl: base, token: 'wrong-token' })
  await assert.rejects(() => bad.claim({ workerId: 'w-anon' }), (e) => {
    assert.equal(e.status, 401)
    return true
  })
})
