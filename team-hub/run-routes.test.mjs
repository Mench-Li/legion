// team-hub/run-routes.test.mjs
// ============================================================================
// 运行面 HTTP 契约（PRT-302/303/313）
//
// 这一组走**真实 HTTP**，而不是直接调仓储：路由层是 worker 唯一看得见的那一层，
// 它的每一处偏差都会让 worker 的判断失效，而这类偏差在仓储单测里完全看不见：
//
//   - 错误码有没有传到响应体里？worker 靠 `LEASE_EPOCH_STALE` 决定「停手」，
//     靠 `LEASE_EXPIRED` 决定「加快」。如果路由把它吞成一个笼统的 409，
//     worker 只能靠文案猜，而文案会变。
//   - `leaseExpiresAtMs` 是不是服务端算的？worker 拿它安排心跳节奏。
//   - 回收接口有没有强制要求「哪些状态已越过外部写边界」？
//     这个字段是防重复副作用的最后一道人工确认，路由层漏掉它就等于没有。
//
// 与 pipeline.test.mjs 同构：临时库 + 真实 listen(0)，跑完关掉。
// ============================================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-runroutes-'))
let mod
let base = ''

before(async () => {
  process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_TOKEN = ''
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close() } catch { /* 已关闭 */ }
  try { mod?.db?.close() } catch { /* 已关闭 */ }
  rmSync(tmpRoot, { recursive: true, force: true })
})

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, body: parsed }
}

/** 直接往库里插一条看板任务（运行面只领取 status=todo 且未 hold 的任务）。 */
function insertTask(id, { status = 'todo', scope = 'default', hold = 0 } = {}) {
  mod.db.prepare(
    'INSERT OR REPLACE INTO tasks (id, title, priority, status, scope, hold, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?)',
  ).run(id, id, 'medium', status, scope, hold, new Date().toISOString(), new Date().toISOString())
  return id
}

/**
 * 只留这一条待办任务，其余标成已完成。
 *
 * 这个文件共用**一个真实库**，而领取是按创建时间取队首的；
 * 于是「我这里插入的任务会被领走」在前面的用例留下一条未领取的 todo 时就不成立。
 * 让每个用例自己声明「此刻队列里只该有这一条」，比维护全局顺序可靠得多。
 */
function onlyTask(id, opts = {}) {
  mod.db.prepare("UPDATE tasks SET status = 'done' WHERE status IN ('todo','backlog')").run()
  return insertTask(id, opts)
}

test('① 能力发现位：/api/config 报出 runPlane（否则 worker 只能靠 404 猜）', async () => {
  const r = await call('GET', '/api/config')
  assert.equal(r.status, 200)
  assert.equal(r.body.runPlane, true)
})

test('① 领取：返回 attemptId / leaseEpoch / 服务端算出的到期时间', async () => {
  insertTask('rt-1')
  const r = await call('POST', '/api/runtime/claim', { workerId: 'w1' })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.claimed.taskId, 'rt-1')
  assert.equal(r.body.claimed.attemptNo, 1)
  assert.equal(r.body.claimed.leaseEpoch, 1)
  assert.equal(r.body.claimed.leaseExpiresAtMs > r.body.claimed.serverTimeMs, true)
  assert.equal(r.body.claimed.leaseExpiresAtMs - r.body.claimed.serverTimeMs, 120000, '到期时间由服务端时钟算出')
})

test('① 队列空返回 200 + claimed:null（不是 404：没事可做不是错误）', async () => {
  const r = await call('POST', '/api/runtime/claim', { workerId: 'w-empty', scope: 'no-such-scope' })
  assert.equal(r.status, 200)
  assert.equal(r.body.claimed, null)
  assert.equal(r.body.reason, 'queue-empty')
})

test('① 缺 workerId → 400 且报出参数名与具名码', async () => {
  const r = await call('POST', '/api/runtime/claim', {})
  assert.equal(r.status, 400)
  assert.equal(r.body.code, 'WORKER_REQUIRED')
  assert.match(r.body.error, /workerId/)
})

test('① 缺 attemptId → 400 且报出参数名', async () => {
  const r = await call('POST', '/api/runtime/heartbeat', { workerId: 'w1', leaseEpoch: 1 })
  assert.equal(r.status, 400)
  assert.equal(r.body.code, 'MISSING_PARAM')
  assert.match(r.body.error, /attemptId/)
})

test('② 心跳续租：到期时间前进', async () => {
  insertTask('rt-2')
  const c = (await call('POST', '/api/runtime/claim', { workerId: 'w2' })).body.claimed
  const hb = await call('POST', '/api/runtime/heartbeat', { attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w2' })
  assert.equal(hb.status, 200)
  assert.equal(hb.body.leaseExpiresAtMs >= c.leaseExpiresAtMs, true)
  assert.equal(hb.body.serverTimeMs > 0, true)
})

test('② 心跳遇到过期 epoch：409 + 具名码 + **当前** epoch（worker 才能判断该停手）', async () => {
  insertTask('rt-3')
  const c = (await call('POST', '/api/runtime/claim', { workerId: 'w3' })).body.claimed
  const r = await call('POST', '/api/runtime/heartbeat', { attemptId: c.attemptId, leaseEpoch: c.leaseEpoch + 7, workerId: 'w3' })
  assert.equal(r.status, 409)
  assert.equal(r.body.code, 'LEASE_EPOCH_STALE')
  assert.equal(r.body.currentEpoch, c.leaseEpoch, '必须回报真实 epoch，否则 worker 只能无限重试')
  assert.equal(r.body.currentWorkerId, 'w3')
})

test('② 心跳遇到别人持有：409 + LEASE_NOT_HELD', async () => {
  insertTask('rt-4')
  const c = (await call('POST', '/api/runtime/claim', { workerId: 'w4' })).body.claimed
  const r = await call('POST', '/api/runtime/heartbeat', { attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w-impostor' })
  assert.equal(r.status, 409)
  assert.equal(r.body.code, 'LEASE_NOT_HELD')
})

test('③ 提交结果：outcome 走状态机；completed 落到 Validating，并投影到看板', async () => {
  insertTask('rt-5')
  const c = (await call('POST', '/api/runtime/claim', { workerId: 'w5' })).body.claimed
  for (const to of ['PreparingWorkspace', 'BuildingContext', 'Running']) {
    const r = await call('POST', '/api/runtime/transition', {
      attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w5', to,
    })
    assert.equal(r.status, 200, JSON.stringify(r.body))
  }
  const done = await call('POST', '/api/runtime/transition', {
    attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w5', outcome: 'completed', context: { detail: '产物已登记' },
  })
  assert.equal(done.status, 200)
  assert.equal(done.body.attempt.state, 'Validating')
  assert.equal(done.body.taskStatus, 'in_review')
  const board = mod.db.prepare('SELECT status FROM tasks WHERE id = ?').get('rt-5')
  assert.equal(board.status, 'in_review', '执行面状态必须投影到看板，否则用户看到的与真实的不一致')
})

test('③ 非法迁移：409 + 仓储码 + 状态机码（两个字段各有各的读者）', async () => {
  insertTask('rt-6')
  const c = (await call('POST', '/api/runtime/claim', { workerId: 'w6' })).body.claimed
  const r = await call('POST', '/api/runtime/transition', {
    attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w6', to: 'Completed', context: { hasNextPost: false },
  })
  assert.equal(r.status, 409)
  assert.equal(r.body.code, 'TRANSITION_REJECTED')
  assert.equal(r.body.stateMachineCode, 'ILLEGAL_TRANSITION')
  assert.match(r.body.error, /不是合法迁移/)
})

test('③ 未知名义不得被当成成功：400 + 明确说「不做默认」', async () => {
  insertTask('rt-7')
  const c = (await call('POST', '/api/runtime/claim', { workerId: 'w7' })).body.claimed
  const r = await call('POST', '/api/runtime/transition', {
    attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w7', outcome: 'looks-fine-to-me',
  })
  // 400 而不是 409：这是**请求**给了一个不认识的结果名义（调用方改一下就行），
  // 与「状态冲突，你得停手」是两件事。码也分开：UNKNOWN_OUTCOME vs LEASE_EPOCH_STALE。
  assert.equal(r.status, 400)
  assert.equal(r.body.code, 'UNKNOWN_OUTCOME')
  assert.match(r.body.error, /不做默认/)
  const row = mod.db.prepare('SELECT state FROM run_attempts WHERE id = ?').get(c.attemptId)
  assert.equal(row.state, 'Leased', '被拒的迁移不得留下半个状态')
})

test('③ 不存在的尝试 → 404（不是 409：调用方的请求本身指错了对象）', async () => {
  const r = await call('POST', '/api/runtime/transition', {
    attemptId: 'att:nope:1', leaseEpoch: 1, workerId: 'w1', to: 'PreparingWorkspace',
  })
  assert.equal(r.status, 404)
  assert.equal(r.body.code, 'ATTEMPT_NOT_FOUND')
})

test('④ 放弃租约后任务可被再次领取（不丢任务）', async () => {
  onlyTask('rt-8')
  const c = (await call('POST', '/api/runtime/claim', { workerId: 'w8' })).body.claimed
  const rel = await call('POST', '/api/runtime/release', {
    attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w8', reason: 'SIGTERM',
  })
  assert.equal(rel.status, 200)
  assert.equal(rel.body.attempt.state, 'RetryableFailure')
  // 释放后旧 epoch 的写入必须被拒（否则「先释放再提交」会成功）
  const late = await call('POST', '/api/runtime/transition', {
    attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: 'w8', outcome: 'completed',
  })
  assert.equal(late.status, 409)
  assert.equal(late.body.code, 'LEASE_EPOCH_STALE')
})

test('④ 回收必须显式给出「已越过外部写边界的状态」（缺了就拒绝）', async () => {
  const r = await call('POST', '/api/runtime/recover', {})
  assert.equal(r.status, 400)
  assert.equal(r.body.code, 'EXTERNAL_EFFECT_UNKNOWN')
  assert.match(r.body.error, /不能猜/)
  const empty = await call('POST', '/api/runtime/recover', { externalEffectPossibleStates: [] })
  assert.equal(empty.status, 400, '空数组同样不可接受：它等价于「全都安全重试」')
})

test('④ 回收：未越过边界 → 新建尝试；越过边界 → 挂起等人工', async () => {
  // 安全的一条：还没到 Running
  onlyTask('rt-9')
  const safe = (await call('POST', '/api/runtime/claim', { workerId: 'w9' })).body.claimed
  assert.equal(safe.taskId, 'rt-9')
  await call('POST', '/api/runtime/transition', { attemptId: safe.attemptId, leaseEpoch: safe.leaseEpoch, workerId: 'w9', to: 'PreparingWorkspace' })
  // 危险的一条：已 Running（可能已经产生外部副作用）
  insertTask('rt-10')
  const risky = (await call('POST', '/api/runtime/claim', { workerId: 'w9' })).body.claimed
  assert.equal(risky.taskId, 'rt-10')
  for (const to of ['PreparingWorkspace', 'BuildingContext', 'Running']) {
    await call('POST', '/api/runtime/transition', { attemptId: risky.attemptId, leaseEpoch: risky.leaseEpoch, workerId: 'w9', to })
  }
  // 把租约推到过期（直接改库：路由不提供「伪造时间」的入口，这正是设计意图）
  const past = Date.now() - 1000
  mod.db.prepare('UPDATE run_attempts SET lease_expires_at_ms = ? WHERE id IN (?, ?)').run(past, safe.attemptId, risky.attemptId)

  const r = await call('POST', '/api/runtime/recover', { externalEffectPossibleStates: ['Running', 'Validating', 'HandingOff'] })
  assert.equal(r.status, 200)
  assert.equal(r.body.scanned, 2)
  const byId = Object.fromEntries(r.body.recovered.map((x) => [x.attemptId, x.action]))
  assert.equal(byId[safe.attemptId], 'retry-new-attempt')
  assert.equal(byId[risky.attemptId], 'mark-unknown-outcome')
  // 回显判据，便于事后核对「当时用的是哪套边界」
  assert.deepEqual(r.body.externalEffectPossibleStates, ['Running', 'Validating', 'HandingOff'])

  // 安全的可以再被领走；危险的不行
  const next = await call('POST', '/api/runtime/claim', { workerId: 'w-next' })
  assert.equal(next.body.claimed.taskId, 'rt-9')
  assert.equal(next.body.claimed.attemptNo, 2, '回收后排的是**新的一次尝试**，第 1 次的历史保留')
  assert.equal(mod.db.prepare('SELECT state FROM run_attempts WHERE id = ?').get(risky.attemptId).state, 'UnknownOutcome')
})

test('⑤ 诊断端点：一次尝试的历史与事件流可查（「试过几次、每次错在哪」）', async () => {
  const r = await call('GET', '/api/runtime/attempt?taskId=rt-9')
  assert.equal(r.status, 200)
  assert.equal(r.body.history.length, 2, 'rt-9 已经有两次尝试：失败的第 1 次 + 回收后的第 2 次')
  assert.equal(r.body.history[0].attemptNo, 1)
  assert.equal(r.body.history[0].state, 'RetryableFailure')
  assert.equal(r.body.history[0].leaseEpoch, 2, '第 1 次尝试的 epoch 在回收时被推进（旧持有者因此收到 STALE 而不是「迁移非法」）')
  assert.equal(r.body.history[1].attemptNo, 2)

  const one = await call(`GET`, `/api/runtime/attempt?attemptId=${r.body.history[0].attemptId}`)
  assert.equal(one.status, 200)
  assert.equal(one.body.attempt.attemptId, r.body.history[0].attemptId)
  assert.ok(one.body.events.length >= 2)
  assert.equal(one.body.events[1].toState, 'Leased')
  assert.deepEqual(one.body.events[1].requiresPersist, ['attempt', 'lease'], '「副作用之前必须先落库什么」要留在证据里')
})

test('⑤ 诊断端点缺参数 → 400，不存在的尝试 → 404', async () => {
  const noParam = await call('GET', '/api/runtime/attempt')
  assert.equal(noParam.status, 400)
  const missing = await call('GET', '/api/runtime/attempt?attemptId=att:nope:9')
  assert.equal(missing.status, 404)
})

test('⑥ 运行面总览：状态计数 + 过期租约数（诊断页与告警的数据源）', async () => {
  const r = await call('GET', '/api/runtime/status')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(Object.keys(r.body.byState).length, 13, '13 个已登记状态一个不缺')
  assert.equal(typeof r.body.expiredLeases, 'number')
  assert.equal(typeof r.body.serverTimeMs, 'number')
  assert.ok(r.body.byState.UnknownOutcome >= 1, '等人工的任务必须出现在总览里')
})

test('⑥ 运行面不影响看板既有路径：/api/claim 仍然按成员语义工作', async () => {
  insertTask('rt-board')
  const r = await call('POST', '/api/claim', { id: 'rt-board', by: 'general', soldier: 'soldier-1' })
  assert.equal(r.status, 200)
  assert.equal(r.body.task.status, 'in_progress')
  assert.equal(r.body.task.soldier, 'soldier-1')
  // 看板认领过的任务不会再被运行面领取（已经不在 todo）
  const runClaim = await call('POST', '/api/runtime/claim', { workerId: 'w-board', scope: 'default' })
  assert.notEqual(runClaim.body.claimed?.taskId, 'rt-board')
})
