// team-hub/handoff-routes.test.mjs
// ============================================================================
// 交接的 HTTP 契约（PRT-308），走**真实的** server.mjs 接线
//
// 上一组（`handoff-store.test.mjs`）用的是注入的假 `createTask`——它验的是
// 运行仓储的事务语义。这一组用的是 server.mjs 注入的**真** `createTask`
// 与**真** `readPipeline`，因此它验的是那条接线本身：
// 后继任务真的进了 `tasks` 表、能被子进程/下一轮扫单领走、字段（role/parent/goalId）
// 与看板看到的一致。
//
// 这条接线最容易错的地方是 `readPipeline` 的返回形状：它返回一个视图对象，
// 而运行仓储要的是 `stages` 数组。传错时 `indexStages` 会因为"不是数组"而抛错
// ——这是**故意**的：把读不出流水线当成"没有岗位"，会让所有任务都被判成链尾。
// ============================================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-handoffroutes-'))
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

/** 给某个 scope 配一条三岗位流水线：analyst → coder → tester（tester 链尾）。 */
function setPipeline(scope, stages) {
  mod.db.prepare('DELETE FROM space_stages WHERE scope = ?').run(scope)
  const ins = mod.db.prepare('INSERT INTO space_stages (scope, role, label, prompt, next, gate, artifact, docs, sort, enabled, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
  stages.forEach((s, i) => ins.run(scope, s.role, s.label, '', s.next, 0, null, null, i, s.enabled === false ? 0 : 1, new Date().toISOString()))
}

/** 建一条任务，并保证此刻队列里只有它（运行面按创建时间取队首）。 */
function onlyTask(id, { scope = 'default', role = 'analyst', goalId = null, acceptance = '[{"kind":"run-completed"}]' } = {}) {
  mod.db.prepare("UPDATE tasks SET status = 'done' WHERE status IN ('todo','backlog')").run()
  mod.db.prepare(
    `INSERT OR REPLACE INTO tasks (id, title, description, priority, status, scope, role, parent, goalId, hold, createdAt, updatedAt, acceptance)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, `【分析】${id}`, '目标描述', 'high', 'todo', scope, role, null, goalId, 0,
    new Date().toISOString(), new Date().toISOString(), acceptance)
  return id
}

/** 领任务 → 推到 Validating → 验收通过（hasNextPost=true）→ HandingOff。 */
async function toHandingOff(id) {
  const claimed = await call('POST', '/api/runtime/claim', { workerId: 'w1' })
  assert.equal(claimed.body.claimed?.taskId, id, `应当领到 ${id}，实际 ${JSON.stringify(claimed.body.claimed)}`)
  const { attemptId, leaseEpoch } = claimed.body.claimed
  for (const to of ['PreparingWorkspace', 'BuildingContext', 'Running']) {
    const r = await call('POST', '/api/runtime/transition', { attemptId, leaseEpoch, workerId: 'w1', to })
    assert.equal(r.body.ok, true, `推进到 ${to} 失败：${JSON.stringify(r.body)}`)
  }
  await call('POST', '/api/runtime/transition', { attemptId, leaseEpoch, workerId: 'w1', outcome: 'completed' })
  const v = await call('POST', '/api/runtime/validate', {
    attemptId, leaseEpoch, actor: 'w1', runResult: { outcome: 'completed', detail: 'exec-ok' }, hasNextPost: true,
  })
  assert.equal(v.body.attempt.state, 'HandingOff', `验收后应当进入 HandingOff：${JSON.stringify(v.body)}`)
  return { attemptId, leaseEpoch }
}

test('① POST /api/runtime/handoff：后继任务真的进了 tasks 表，且能被下一轮领走', async () => {
  setPipeline('default', [
    { role: 'analyst', label: '分析', next: 'coder' },
    { role: 'coder', label: '开发', next: 'tester' },
    { role: 'tester', label: '测试', next: null },
  ])
  const id = onlyTask('ho-1', { goalId: 'G-1' })
  const { attemptId, leaseEpoch } = await toHandingOff(id)

  const r = await call('POST', '/api/runtime/handoff', {
    attemptId, leaseEpoch, actor: 'w1', prevSummary: '✓ 分析完了',
  })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.action, 'handed-off')
  assert.equal(r.body.successorRole, 'coder')

  // 后继必须真的在看板上，字段与"下一岗位"一致
  const successor = mod.db.prepare('SELECT * FROM tasks WHERE id = ?').get(r.body.successorId)
  assert.ok(successor !== undefined, '后继任务必须真的在库里')
  assert.equal(successor.role, 'coder')
  assert.equal(successor.parent, id, 'parent 是交接的幂等键')
  assert.equal(successor.goalId, 'G-1', 'goalId 必须继承')
  assert.equal(successor.priority, 'high', 'priority 必须继承')
  assert.equal(successor.status, 'todo')
  assert.match(successor.description, /\[前序阶段\] 分析（analyst）已完成：✓ 分析完了/)
  assert.match(successor.description, /\[本阶段\] 开发（coder）/)

  // 本尝试收口
  assert.equal(mod.db.prepare('SELECT state FROM run_attempts WHERE id = ?').get(attemptId).state, 'Completed')
  // 交接记录可读
  const hs = await call('GET', `/api/runtime/handoffs?attemptId=${encodeURIComponent(attemptId)}`)
  assert.equal(hs.body.handoffs.length, 1)
  assert.equal(hs.body.handoffs[0].successorRole, 'coder')

  // 最关键的一条：**下一岗位真的能被领走**。交接的全部意义就在这里——
  // 建出一条没人能领的任务等于链断在这里，而库里看起来一切正常。
  mod.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(id)
  const next = await call('POST', '/api/runtime/claim', { workerId: 'w2' })
  assert.equal(next.body.claimed?.taskId, r.body.successorId,
    `下一岗位必须能被领走，实际领到 ${JSON.stringify(next.body.claimed)}`)
})

test('② 重放交接返回同一条后继（HTTP 层）', async () => {
  setPipeline('default', [
    { role: 'analyst', label: '分析', next: 'coder' },
    { role: 'coder', label: '开发', next: null },
  ])
  const id = onlyTask('ho-2')
  const { attemptId, leaseEpoch } = await toHandingOff(id)
  const first = await call('POST', '/api/runtime/handoff', { attemptId, leaseEpoch, actor: 'w1' })
  const replay = await call('POST', '/api/runtime/handoff', { attemptId, leaseEpoch, actor: 'w1' })
  assert.equal(replay.body.action, 'already-handed-off')
  assert.equal(replay.body.successorId, first.body.successorId)
  const n = mod.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE parent = ?').get(id).n
  assert.equal(Number(n), 1, `只应有一条后继，实际 ${n} 条`)
})

test('③ 链断 → 409 HANDOFF_REJECTED，且不收口、不建任务', async () => {
  setPipeline('default', [
    { role: 'analyst', label: '分析', next: 'codeer' },   // 拼错
    { role: 'coder', label: '开发', next: null },
  ])
  const id = onlyTask('ho-3')
  const { attemptId, leaseEpoch } = await toHandingOff(id)
  const r = await call('POST', '/api/runtime/handoff', { attemptId, leaseEpoch, actor: 'w1' })
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.equal(r.body.code, 'HANDOFF_REJECTED')
  assert.match(r.body.error, /codeer/)
  assert.equal(mod.db.prepare('SELECT state FROM run_attempts WHERE id = ?').get(attemptId).state, 'HandingOff')
  assert.equal(Number(mod.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE parent = ?').get(id).n), 0)
})

test('③ 中间岗位被停用 → 链断（与"拼错 next"是同一个故障）', async () => {
  setPipeline('default', [
    { role: 'analyst', label: '分析', next: 'coder' },
    { role: 'coder', label: '开发', next: null, enabled: false },
  ])
  const id = onlyTask('ho-4')
  const { attemptId, leaseEpoch } = await toHandingOff(id)
  const r = await call('POST', '/api/runtime/handoff', { attemptId, leaseEpoch, actor: 'w1' })
  assert.equal(r.status, 409)
  assert.equal(r.body.code, 'HANDOFF_REJECTED')
  assert.match(r.body.error, /不存在或已被停用/)
})

test('④ 只有 HandingOff 上能交接；缺 actor / 过期 epoch 被拒', async () => {
  setPipeline('default', [
    { role: 'analyst', label: '分析', next: 'coder' },
    { role: 'coder', label: '开发', next: null },
  ])
  const id = onlyTask('ho-5')
  const claimed = await call('POST', '/api/runtime/claim', { workerId: 'w1' })
  const { attemptId, leaseEpoch } = claimed.body.claimed
  // 还在 Leased 上就交接 = 跳过"验收通过"
  const early = await call('POST', '/api/runtime/handoff', { attemptId, leaseEpoch, actor: 'w1' })
  assert.equal(early.status, 409)
  assert.equal(early.body.code, 'NOT_HANDING_OFF')

  const noActor = await call('POST', '/api/runtime/handoff', { attemptId, leaseEpoch })
  assert.equal(noActor.status, 400)
  const badEpoch = await call('POST', '/api/runtime/handoff', { attemptId, leaseEpoch: leaseEpoch + 50, actor: 'w1' })
  assert.equal(badEpoch.status, 409)
  assert.equal(badEpoch.body.code, 'LEASE_EPOCH_STALE')
  assert.equal(badEpoch.body.currentEpoch, leaseEpoch)
})

test('⑤ GET /api/runtime/next-post：链中返回 hasNext，链尾返回 false，链断返回 409', async () => {
  const id = onlyTask('ho-6', { role: 'analyst' })
  setPipeline('default', [
    { role: 'analyst', label: '分析', next: 'coder' },
    { role: 'coder', label: '开发', next: null },
  ])
  const mid = await call('GET', `/api/runtime/next-post?taskId=${id}`)
  assert.equal(mid.status, 200)
  assert.equal(mid.body.hasNextPost, true)
  assert.equal(mid.body.nextRole, 'coder')
  assert.equal(mid.body.nextLabel, '开发')

  // 链尾
  const tailTask = onlyTask('ho-7', { role: 'coder' })
  const tail = await call('GET', `/api/runtime/next-post?taskId=${tailTask}`)
  assert.equal(tail.status, 200)
  assert.equal(tail.body.hasNextPost, false)
  assert.equal(tail.body.nextRole, null)

  // 链断：**不是** hasNext:false
  setPipeline('default', [{ role: 'analyst', label: '分析', next: 'ghost' }])
  const broken = await call('GET', `/api/runtime/next-post?taskId=${id}`)
  assert.equal(broken.status, 409, JSON.stringify(broken.body))
  assert.deepEqual(broken.body.brokenEdge, { from: 'analyst', to: 'ghost' })

  // 任务没记岗位：同样 409，不猜
  const noRole = onlyTask('ho-8', { role: null })
  const nr = await call('GET', `/api/runtime/next-post?taskId=${noRole}`)
  assert.equal(nr.status, 409)
  assert.match(nr.body.error, /不默认成链尾/)
})

test('⑤ GET 参数缺失 → 400；任务不存在 → 404', async () => {
  const a = await call('GET', '/api/runtime/next-post')
  assert.equal(a.status, 400)
  const b = await call('GET', '/api/runtime/next-post?taskId=不存在')
  assert.equal(b.status, 404)
  const c = await call('GET', '/api/runtime/handoffs')
  assert.equal(c.status, 400)
})

test('⑥ 没有交接记录就收口 → 409 EVIDENCE_MISSING（HTTP 层）', async () => {
  // 状态机为 `HandingOff → Completed` 声明了 requiresPersist: ['attempt','handoff']。
  // 直接收口等于任务链静默断在这里。
  setPipeline('default', [
    { role: 'analyst', label: '分析', next: 'coder' },
    { role: 'coder', label: '开发', next: null },
  ])
  const id = onlyTask('ho-9')
  const { attemptId, leaseEpoch } = await toHandingOff(id)
  const r = await call('POST', '/api/runtime/transition', {
    attemptId, leaseEpoch, workerId: 'w1', to: 'Completed', context: { hasNextPost: false },
  })
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.equal(r.body.code, 'EVIDENCE_MISSING')
  assert.match(r.body.error, /handoff/)
})
