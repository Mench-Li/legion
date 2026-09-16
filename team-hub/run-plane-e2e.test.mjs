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
import { createHubContextStage } from '../orchestrator/worker/context-stage.mjs'
import { createWorker, inPlaceStages } from '../orchestrator/worker/main.mjs'
// ★ PRT-214 第二步的**下游两跳**：租约 → RunRequest → 静态下限。
//   这一组用例的要点是**全程用真件**：真的 `server.mjs`、真的库、真的 `claim()`、
//   真的 `defaultRequestFor`、真的 `deriveRunFloorCarrier`、真的 guard 名字空间。
//   任何一处换成替身，这个套件就退化成"它自己跟自己对答案"。
import { defaultRequestFor, deriveRunFloorCarrier, UNSUPPLIED_PERMISSIONS } from '../orchestrator/worker/executor.mjs'
import { createHardFloorGuard } from '../runtime/dsh-composition/enforcement.mjs'

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

/** 操作员视角的 GET（带 token），返回已解析的 JSON。 */
async function operatorGet(path) {
  return (await unpooledFetch(`${base}${path}`, { headers: { authorization: 'Bearer e2e-token' } })).json()
}

/** 操作员视角的 POST（带 token），返回已解析的 JSON。 */
async function operatorPost(path, body) {
  return (await unpooledFetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer e2e-token' },
    body: JSON.stringify(body),
  })).json()
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

/**
 * PRT-411：远程 worker 的 `buildContext` —— 装配与持久化都在 hub 那一侧。
 *
 * 装配需要的数据都在 hub 的库里，所以让 worker 自己读意味着直连 SQLite
 * 或把读取逻辑写第二遍。而 `/api/context-snapshots/assemble` 已经是
 * **装配 + 持久化在同一个请求里**完成的，于是"冻结在 Running 之前"
 * 不是一条靠人记住的约定。
 */
function hubContextStage() {
  return createHubContextStage({
    post: async (path, body) => {
      const r = await fetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer e2e-token' },
        body: JSON.stringify(body),
      })
      return { status: r.status, body: await r.json().catch(() => null) }
    },
    // 权限**必须显式回答**：路由不替调用方决定权限，这里也不猜。
    canRead: () => true,
    clock: () => Date.now(),
  })
}

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

test('① ★★ 引擎的 RunResult 真的走完了整根线：执行侧 → worker → transition → 落库', async () => {
  // 这一条是本批**唯一**能证明"线接上了"的用例，而且它非有不可：
  //
  // 仓储允许"只报结局、没有引擎原文"也算一条记录（`source: 'report-only'`），
  // 否则每一次引擎抛错都会变成 EVIDENCE_MISSING。但这个让步有一个后果——
  // **把 executor → main → hub 那一段 `runResult` 传递整个删掉，别的用例全都不会红**
  // （结局照样报上去，闸门照样通过，只是那一行从 'engine' 悄悄降级成 'report-only'）。
  //
  //   > 一个"引擎原文会一路送到库里"的设计，
  //   > 与一个"引擎原文在半路被丢掉、只是没人发现"的设计，
  //   > 在只断言状态迁移的用例下长得一模一样。
  //
  // 所以这里断言的是**原文本身**：库里必须能读到引擎给的那个对象，
  // 一字不差，且来源是 'engine'。
  onlyTask('e2e-rr')
  const ENGINE_RESULT = {
    runId: 'run-e2e-rr', outcome: 'succeeded', code: null,
    output: '模型说：做完了', usage: { inputTokens: 3, outputTokens: 5 },
  }
  await withWorker({
    hub,
    executor: {
      ...inPlaceStages({ contextStage: hubContextStage() }),
      execute: async () => ({ outcome: 'completed', detail: 'e2e-rr', runResult: ENGINE_RESULT }),
    },
    dataDir: dataDirOf('data-rr'),
    workerId: 'w-e2e-rr',
    heartbeatIntervalMs: 50,
  }, async (w) => {
    const r = await w.tick()
    assert.equal(r.outcome, 'completed', JSON.stringify(r))
    const attemptId = mod.db.prepare('SELECT id FROM run_attempts WHERE task_id = ?').get('e2e-rr').id

    const rows = mod.db.prepare('SELECT source, outcome, result_json FROM run_results WHERE attempt_id = ?').all(attemptId)
    assert.equal(rows.length, 1, '引擎跑过一次就必须有一行运行结果')
    assert.equal(rows[0].source, 'engine',
      '来源必须是 engine。若这里变成 report-only，说明引擎原文在半路被丢掉了——' +
      '而状态迁移仍然全对，只有这一条断言看得出来')
    assert.equal(rows[0].outcome, 'completed', '列上是仓储口径')
    assert.deepEqual(JSON.parse(rows[0].result_json), ENGINE_RESULT,
      '引擎给的 RunResult 必须一字不差地到库：它是"模型当时输出了什么"的唯一凭据')

    // 再从**界面**读一遍：产品读得到的，才算真的交付了
    const got = await operatorGet(`/api/runtime/run-results?attemptId=${encodeURIComponent(attemptId)}`)
    assert.equal(got.runResults.length, 1)
    assert.equal(got.runResults[0].source, 'engine')
    assert.deepEqual(got.runResults[0].result, ENGINE_RESULT)
  })
})

test('② ★★ 返回值失败之后，任务**仍然领得走**（否则它是个"永远领不到的 todo"）', async () => {
  // 上一批量到的缺陷（PRT-309，真 hub + 真 worker）：
  // 执行器**返回** `{outcome:'failed'}`（`run.failed` 终态的常见形态）时，
  // worker 走的是 `transition` 而不是 `fail`，于是这次失败**没有任何人接手**——
  // attempt 停在 `RetryableFailure`、没有新尝试、回收扫描扫不到（它不在
  // `IN_FLIGHT_ATTEMPT_STATES` 里）、人工待办也列不出来（`listHeld` 只收
  // `UnknownOutcome`/`DeadLetter`），而 `task.status` 还是 `todo`。
  //
  //   > 最坏的不是"停在中间态"，是"停在中间态的同时任务状态是 todo"：
  //   > 每个看板都把它算成待办的、还没被领走的任务，而派发器永远领不到它。
  //
  // 这一条用**真 hub + 真 createWorker**（只换执行引擎）钉住那个不变量。
  const id = onlyTask('e2e-returned-fail')
  await withWorker({
    hub,
    executor: {
      ...inPlaceStages({ contextStage: hubContextStage() }),
      execute: async () => ({ outcome: 'failed', detail: '引擎报了 run.failed' }),
    },
    dataDir: dataDirOf('data-rf'),
    workerId: 'w-rf',
    heartbeatIntervalMs: 50,
  }, async (w) => {
    const r = await w.tick()
    assert.equal(r.outcome, 'failed')

    const rows = mod.db.prepare(
      'SELECT attempt_no, state, next_attempt_at_ms, failure_code FROM run_attempts WHERE task_id = ? ORDER BY attempt_no',
    ).all(id)
    assert.equal(rows[0].state, 'RetryableFailure', '首次尝试被终结为失败：这是"它失败了一次"这个事实')
    assert.equal(rows[0].failure_code, 'runtime-unavailable', '失败原因要留痕，否则事后只能猜')
    // ★ 判据一：必须**已经排好**下一次尝试。只有 1 条就说明这次失败没人接手。
    assert.equal(rows.length, 2,
      '失败之后必须有下一次尝试。只有 1 条 = 这次失败只是被记了一笔，没有任何人接手')
    assert.equal(rows[1].state, 'Queued')
    assert.notEqual(rows[1].next_attempt_at_ms, null,
      '排进队列必须带退避时间——退避是**服务端**的队列闸门，不是 worker 自己 sleep')

    // ★ 判据二（决定性）：把退避闸门放开之后，它必须真的**领得走**。
    // 刚失败完直接 claim 会拿到空队列，那是退避在正常工作，不是缺陷；
    // 所以这里只把退避时间抹掉，再问一次队列——这样"能不能领走"与"退避到没到"
    // 就是两个分开的问题，不会因为退避恰好没到而误判成通过。
    mod.db.prepare('UPDATE run_attempts SET next_attempt_at_ms = NULL WHERE task_id = ?').run(id)
    const next = await hub.claim({ workerId: 'w-next' })
    assert.notEqual(next, null, '放开通避之后必须能领到——领不到就说明这个任务被静默停住了')
    assert.equal(next.taskId, id)
  })
})

test('① worker 端到端：认领 → 执行 → 提交，看板投影到 in_review', async () => {
  onlyTask('e2e-2')
  const executed = []
  await withWorker({
    hub,
    executor: { ...inPlaceStages({ contextStage: hubContextStage() }), execute: async (lease) => { executed.push(lease.taskId); return { outcome: 'completed', detail: 'e2e' } } },
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
    executor: { ...inPlaceStages({ contextStage: hubContextStage() }), execute: async () => ({ outcome: 'completed' }) },
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
    executor: { ...inPlaceStages({ contextStage: hubContextStage() }), execute: async () => ({ outcome: 'completed' }) },
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
    executor: { ...inPlaceStages({ contextStage: hubContextStage() }), execute: () => gate.then(() => ({ outcome: 'completed' })) },
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
    executor: { ...inPlaceStages({ contextStage: hubContextStage() }), execute: () => { startedExec(); return gate.then(() => ({ outcome: 'completed' })) } },
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
    executor: { ...inPlaceStages({ contextStage: hubContextStage() }), execute: () => { startedExec(); return gate.then(() => ({ outcome: 'completed' })) } },
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

// ── PRT-309/310/311：真实 hub + 真实 worker 的完整失败链路 ──

/** 认领一条任务并亲手推到 Running（跳过阶段副作用，只测协议与去向）。 */
async function claimAndRun(workerId, taskId, scope = 'default') {
  onlyTask(taskId, { scope })
  const c = await hub.claim({ workerId, scope })
  assert.equal(c.taskId, taskId, `应领到 ${taskId}，实际 ${c?.taskId}`)
  for (const to of ['PreparingWorkspace', 'BuildingContext', 'Running']) {
    // PRT-411：`→ Running` 要求一份已落库的上下文快照。走真实的装配路由——
    // 这样"冻结在 Running 之前"在测试里也是真的被走了一遍，而不是被夹具绕过去。
    if (to === 'Running') await freezeViaHub(c.attemptId, scope)
    await hub.transition({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId, to })
  }
  return c
}

/** 通过真实的 hub 装配路由冻结上下文（带 worker token，不是 operator token）。 */
async function freezeViaHub(attemptId, scope = 'default') {
  const r = await fetch(base + '/api/context-snapshots/assemble', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer e2e-token' },
    body: JSON.stringify({
      attemptId, runId: `run:${attemptId}`, frozenAtMs: Date.now(), scope,
      canReadAll: true, candidates: [],
    }),
  })
  const body = await r.json().catch(() => null)
  assert.equal(r.status, 200, `冻结上下文失败：${r.status} ${JSON.stringify(body)}`)
  return body.snapshotHash
}

test('⑥ 真实 worker 的执行失败会被服务端结算成「重试 + 退避」，而不是停在中间态', async () => {
  onlyTask('e2e-fail')
  await withWorker({
    hub,
    executor: {
      prepareWorkspace: async () => ({ kind: 'in-place' }),
      buildContext: hubContextStage(),
      execute: async () => { throw new Error('执行引擎炸了') },
    },
    dataDir: dataDirOf('data-fail'),
    workerId: 'w-e2e-fail',
    heartbeatIntervalMs: 10000,
  }, async (w) => {
    const r = await w.tick()
    assert.equal(r.outcome, 'failed')
    assert.equal(r.reported, true, '失败必须被服务端结算——只上报不结算会让任务永远停在 RetryableFailure')
    assert.equal(r.error.disposition, 'retry-new-attempt')
    assert.equal(typeof r.error.nextAttemptAtMs, 'number')
  })

  // 服务端侧的真实结果：第 1 次尝试已终结且保留失败原因，第 2 次在队列里等退避
  const body = await operatorGet('/api/runtime/attempt?taskId=e2e-fail')
  assert.equal(body.history.length, 2, '重试必须新建一次尝试，而不是把同一行改回 Queued')
  assert.equal(body.history[0].state, 'RetryableFailure')
  assert.equal(body.history[0].failureCode, 'runtime-unavailable',
    '失败码要如实分类：没打阶段名的话工作区失败会被记成 runtime-unavailable')
  assert.equal(body.history[1].state, 'Queued')
  assert.ok(body.history[0].idempotencyKey === body.history[1].idempotencyKey,
    '两次尝试共用同一个幂等键：换了键，外部系统就无法判断「这是同一次操作的重试」')
  // 退避闸门真的在库里
  const budget = await operatorGet('/api/runtime/budget?taskId=e2e-fail')
  assert.equal(budget.budget.attemptsUsed, 2)
  assert.ok(budget.budget.nextAttemptAtMs > Date.now() - 1000, '退避时刻必须已经写进队列')
})

test('⑥ 反复失败最终进 Dead Letter，并且能在等人工清单里找到（不静默消失）', async () => {
  const workerId = 'w-e2e-dead'
  let c = await claimAndRun(workerId, 'e2e-dead')
  let last = null
  for (let i = 0; i < 12; i++) {
    last = await hub.fail({
      attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId,
      failureCode: 'runtime-unavailable', detail: '一直失败',
    })
    if (last.action === 'dead-letter') break
    // 把退避闸门直接清掉（真实场景里是等它到点），避免用例真 sleep 十几秒
    mod.db.prepare('UPDATE run_attempts SET next_attempt_at_ms = NULL WHERE id = ?').run(last.nextAttempt.attemptId)
    const next = await hub.claim({ workerId })
    assert.equal(next.taskId, 'e2e-dead')
    for (const to of ['PreparingWorkspace', 'BuildingContext', 'Running']) {
      // PRT-411：每一次新尝试同样要先冻结上下文才能进 Running。
      if (to === 'Running') await freezeViaHub(next.attemptId, 'default')
      await hub.transition({ attemptId: next.attemptId, leaseEpoch: next.leaseEpoch, workerId, to })
    }
    c = next
  }
  assert.equal(last.action, 'dead-letter', '必须有终点：无限重试不会报错，它只会永远跑下去')
  assert.match(last.reason, /重试额度已用完/)

  // 关键：它必须出现在等人工清单里。只写进历史的话，从任何界面看这条任务都只是"不见了"。
  const held = await operatorGet('/api/runtime/held?scope=default')
  const mine = held.items.filter((i) => i.taskId === 'e2e-dead')
  assert.equal(mine.length, 1)
  assert.equal(mine[0].state, 'DeadLetter')
  assert.equal(mine[0].isLatest, true)
  // 历史完整保留：试过几次、每次错在哪
  const hist = await operatorGet('/api/runtime/attempt?taskId=e2e-dead')
  assert.equal(hist.history.length, 5, '上限 5 次，一次不多一次不少')
  assert.ok(hist.history.every((a) => a.state === 'RetryableFailure' || a.state === 'DeadLetter'))
})

test('⑦ 等人工的 UnknownOutcome 不会被后续的失败上报偷偷重试（这是它存在的全部意义）', async () => {
  const workerId = 'w-e2e-unknown'
  const c = await claimAndRun(workerId, 'e2e-unknown')
  // 结果不可确认 → 挂起等人工
  const unknown = await hub.transition({
    attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId, outcome: 'outcome_unknown',
  })
  assert.equal(unknown.attempt.state, 'UnknownOutcome')

  // 一个不知道它已挂起的 worker 又报了一次失败。它**不能**变成一次重试。
  const again = await hub.fail({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId, failureCode: 'runtime-unavailable' })
  assert.equal(again.action, 'noop')
  assert.equal(again.reason, 'awaiting-human-reconciliation')
  const hist = await operatorGet('/api/runtime/attempt?taskId=e2e-unknown')
  assert.equal(hist.history.length, 1, '挂起等人工的尝试绝不能因为"又报了一次失败"就重跑——那可能重复付费')

  // 人工对账：确认已发生 → 按成功继续验收
  const resolved = await operatorPost('/api/runtime/resolve', {
    attemptId: c.attemptId, decision: 'external-effect-happened', actor: 'general', note: '对账单确认',
  })
  assert.equal(resolved.attempt.state, 'Validating')
  assert.equal(resolved.attempt.externalEffect, 'confirmed')
  // 处置后不再挂在等人工清单上（否则人会反复处理同一条）
  const held = await operatorGet('/api/runtime/held?scope=default')
  assert.equal(held.items.filter((i) => i.taskId === 'e2e-unknown' && i.isLatest).length, 0)
})

// ════════════════════════════════════════════════════════════════════════════
// ⑧ PRT-214 第二步：**权限档位终于在认领时有了来源**，而且一路走到真 guard
// ════════════════════════════════════════════════════════════════════════════
//
// 这一组要守的是本批之前那个状态的**反面**：
//
//   > 一个"上限的接线全接好了、只是 `permissions` 从来没有来源"的部署，
//   > 与一个"权限档位真的从控制面流到 guard"的部署，
//   > 在只看那几个套件的时候是同一个东西——只不过前者的每一次 Run
//   > 都在派发前停下，而停下这件事在监控上看起来像"权限判定为否"。
//
// 判据分四跳，缺一不可：清单行 → `claim()` → `defaultRequestFor` → 真 guard。
//
// ⚠️ 这一组会往真库里写**新任务**，而本文件是按队首领取的（见 `onlyTask` 的注释）。
//    所以每一步都先用 `onlyTask()` 把队列清干净，否则后面的用例会领到前面留下的任务。

/**
 * 往真库里写一行岗位清单——**走真的生产写入点** `POST /api/agents`。
 *
 * 为什么不用 `mod.contextPlanStore().putEmployeeManifest(...)` 直接写：
 * 那个工厂**没有导出**（`server.mjs` 只在模块内部持有它），而且更重要的是
 * `/api/agents` 就是 PRT-402 认定的**清单生产触发点**——它在一个事务里
 * 同时写编队行与清单行。绕过它去写，用例就少验了"生产真的会写出这一行"。
 */
async function putManifest(role, { allowedTools, deniedTools = [], approvalPolicy = null, scope = 'default' }) {
  const r = await operatorPost('/api/agents', {
    role, name: role, scope, allowedTools, deniedTools, approvalPolicy, by: 'e2e-operator',
  })
  assert.equal(r.ok, true, `写岗位清单失败：${JSON.stringify(r)}`)
  return r
}

/** 一条带岗位的任务（`tasks.role` 是清单的查找键）。 */
function onlyTaskWithRole(id, role) {
  const taskId = onlyTask(id)
  mod.db.prepare('UPDATE tasks SET role = ? WHERE id = ?').run(role, taskId)
  return taskId
}

/**
 * 把 `claim()` 回来的租约补成一份**能过 `defaultRequestFor` 必填校验**的租约。
 *
 * 真实生产里那 6 个字段由 worker 的 `buildContext`（`/api/context-snapshots/assemble`）
 * 装配后再并进请求；这一组用例只关心权限档位那一跳，所以**只补字段**、
 * 不碰本批改动的任何逻辑（`defaultRequestFor` 的必填校验本身也是它自己的行为，
 * 用它当"租约不完整会被拒"的读数正合适）。
 */
function completeLease(claimed) {
  return {
    ...claimed,
    workspaceId: 'ws-e2e', goalId: 'g-e2e', employeeId: 'e2e/employee',
    teamPlanRef: 'tp-e2e', modelProfileRef: 'mp-e2e', workdir: process.cwd(),
  }
}

test('⑧ ★★★★★ 清单行 → `claim()`：租约**真的带上了**这次 Run 的权限档位', async () => {
  await putManifest('e2e-tier', { allowedTools: ['read-file', 'git-push'], approvalPolicy: 'never' })
  onlyTaskWithRole('e2e-tier-1', 'e2e-tier')

  const claimed = await hub.claim({ workerId: 'w-e2e-tier' })
  assert.notEqual(claimed, null)
  assert.equal(claimed.taskId, 'e2e-tier-1')

  // ★ 这三行是本批的全部要点：在此之前 `claim()` 回来的对象上**一个都没有**
  //   （`can-read-authorization-source.test.mjs` 逐键断言过只有 8 个键）。
  assert.deepEqual([...claimed.allowedTools], ['read-file', 'git-push'],
    '租约上没有权限档位——那 worker 那侧就只能具名拒绝，或者自己猜一个')
  assert.deepEqual([...claimed.deniedTools], [])
  assert.equal(claimed.approvalPolicy, 'never', '策略值必须原样带出来，不被这一侧解释')
  // 原有的 8 个键一个都不能少（本批只加不改）。
  for (const k of ['attemptId', 'taskId', 'scope', 'attemptNo', 'leaseEpoch', 'leaseExpiresAtMs', 'state', 'serverTimeMs']) {
    assert.notEqual(claimed[k], undefined, k + ' 不见了——本批只加键，不改原有那 8 个')
  }
})

test('⑧ ★★★★★ 端到端：清单里的 `git-push` 一路变成 guard **真的拒掉**的 `bash`/`pwsh`', async () => {
  await putManifest('e2e-tier2', { allowedTools: ['read-file', 'git-push'], approvalPolicy: 'never' })
  onlyTaskWithRole('e2e-tier-2', 'e2e-tier2')

  const claimed = await hub.claim({ workerId: 'w-e2e-tier2' })
  const request = defaultRequestFor(completeLease(claimed), { associations: {} })
  // 第二跳：租约 → RunRequest.permissions
  assert.equal(request.permissions.preset, 'legion-unattended', 'approvalPolicy=never 应翻成无人值守')
  assert.deepEqual([...request.permissions.tools], ['read-file', 'git-push'])

  // 第三跳：RunRequest → 静态下限。第四跳：下限 → 真 guard。
  const carried = deriveRunFloorCarrier(request, { platform: process.platform })
  assert.equal(carried.state, 'installed', JSON.stringify(carried.payload))
  assert.deepEqual([...carried.payload.floor.denyTools], ['bash', 'pwsh'],
    '下限里不是**执行面**名字——那 guard 一个真工具都拦不住')

  const guard = createHardFloorGuard(carried.payload.floor)
  for (const name of ['bash', 'pwsh']) {
    assert.equal(typeof guard({ name, arguments: {} }), 'string',
      `${name} 没被拒：从清单到 guard 这条线在 ${name} 这一跳断了`)
  }
  // 反向对照：没被禁的执行面名字照常放行（名字名单不是 fail closed）。
  assert.equal(guard({ name: 'read', arguments: {} }), undefined)
  assert.equal(guard({ name: 'write', arguments: {} }), undefined)
})

test('⑧ ★★★★ 没有清单的岗位：租约上**没有**权限字段，而且它 ≠ "什么都不能干"', async () => {
  // 这一条守着本批最容易被"顺手修好"的那个形状问题。
  onlyTaskWithRole('e2e-tier-3', 'e2e-tier-nobody')

  const claimed = await hub.claim({ workerId: 'w-e2e-tier3' })
  assert.notEqual(claimed, null)
  assert.equal(claimed.allowedTools, undefined,
    '没有清单时不许填一份空的 allowedTools——那个形状说的是"这个员工不能用任何工具"')
  assert.equal(claimed.deniedTools, undefined)
  assert.equal(claimed.approvalPolicy, undefined)

  // 下游：落到那个**按引用可辨认**的哨兵上，于是"没给"与"给了空名单"分得开。
  const request = defaultRequestFor(completeLease(claimed), { associations: {} })
  assert.equal(request.permissions, UNSUPPLIED_PERMISSIONS,
    '没有清单时必须落到哨兵上，而不是一份形状相同的 `{preset, tools: []}`')
  const carried = deriveRunFloorCarrier(request, { platform: process.platform })
  assert.equal(carried.state, 'refused', '没有来源的档位必须判成"拒绝"，不是"空下限"')
  assert.deepEqual([...carried.refusals.map((r) => r.code)], ['run-floor-permissions-missing'])
  assert.equal(carried.payload.floor, null)

  // 而"控制面给了一份**空的**允许名单"是**另一个**读数：派得出来，正常跑。
  await putManifest('e2e-tier-empty', { allowedTools: [], approvalPolicy: 'never' })
  onlyTaskWithRole('e2e-tier-4', 'e2e-tier-empty')
  const emptyClaim = await hub.claim({ workerId: 'w-e2e-tier4' })
  assert.deepEqual([...emptyClaim.allowedTools], [], '空允许名单必须原样带出来')
  const emptyReq = defaultRequestFor(completeLease(emptyClaim), { associations: {} })
  assert.notEqual(emptyReq.permissions, UNSUPPLIED_PERMISSIONS)
  const emptyCarried = deriveRunFloorCarrier(emptyReq, { platform: process.platform })
  assert.equal(emptyCarried.state, 'installed', '空允许名单是**合法**的一档，不是"没给"')
  assert.deepEqual([...emptyCarried.payload.floor.denyTools], [])
})

test('⑧ ★★★★ 认不出来的 `approvalPolicy`：具名拒绝，**不猜**是哪个档位', async () => {
  // 控制面那一侧 `approvalPolicy` 是自由文本，执行面认的 preset 是闭集。
  // 这个值只有人能裁决——所以它必须是**具名拒绝**，而不是"顺手当成某个档位"。
  await putManifest('e2e-tier-odd', { allowedTools: ['read-file'], approvalPolicy: 'ask-on-write' })
  onlyTaskWithRole('e2e-tier-5', 'e2e-tier-odd')

  const claimed = await hub.claim({ workerId: 'w-e2e-tier5' })
  assert.equal(claimed.approvalPolicy, 'ask-on-write', '这一侧原样带出，不解释')
  assert.throws(
    () => defaultRequestFor(completeLease(claimed), { associations: {} }),
    (e) => {
      assert.equal(e.code, 'EXECUTOR_APPROVAL_POLICY_UNKNOWN',
        `拒绝码不是那个具名的策略码（收到 ${e.code}）：笼统的接线码会把排障指向错的地方`)
      assert.match(e.message, /ask-on-write/, '消息里要出现那个**具体**的值')
      assert.match(e.message, /ask|never/, '消息里要出现今天认得的那些值')
      return true
    },
  )
})

test('⑧ ★★★ 策略**缺省** → 有人值守（更严的那个），不是无人值守', async () => {
  // 缺省 ≠ "一个认不出来的值"：它是"控制面没有表达偏好"。那时取更严的那个
  // 不可能放宽任何东西；反过来取 `never` 才会静默放宽。
  await putManifest('e2e-tier-quiet', { allowedTools: ['read-file'] })
  onlyTaskWithRole('e2e-tier-6', 'e2e-tier-quiet')

  const claimed = await hub.claim({ workerId: 'w-e2e-tier6' })
  assert.equal(claimed.approvalPolicy, null)
  const request = defaultRequestFor(completeLease(claimed), { associations: {} })
  assert.equal(request.permissions.preset, 'legion-attended',
    '缺省策略取成了无人值守——那是一次静默的放宽')
})
