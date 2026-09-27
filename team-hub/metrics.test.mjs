// team-hub/metrics.test.mjs —— S4（R-8 只读聚合与降级口径）
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let mod
let base
let dir

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'legion-t170-metrics-'))
  process.env.TEAM_HUB_DB = join(dir, 'team.db')
  process.env.TEAM_HUB_TOKEN = ''
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
  const ins = mod.db.prepare("INSERT INTO tasks (id, title, status, scope, fixCount) VALUES (?,?,?,?,?)")
  ins.run('T-m1', 'm1', 'todo', 'default', 0)
  ins.run('T-m2', 'm2', 'todo', 'default', 0)
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* noop */ }
  try { mod?.server?.close?.() } catch { /* noop */ }
  try { mod?.db?.close?.() } catch { /* noop */ }
  rmSync(dir, { recursive: true, force: true })
})

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), agent: false,
  })
  const text = await res.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, body: parsed }
}

test('TC-S4-11 缺 repoId 时整组不可读：available=false + reason，value 不为 0', async () => {
  const r = await call('GET', '/api/metrics/repository')
  assert.equal(r.status, 200)
  assert.equal(r.body.available, false)
  assert.ok(typeof r.body.reason === 'string' && r.body.reason.length > 0)
  for (const m of Object.values(r.body.metrics)) {
    assert.equal(m.available, false)
    assert.equal(m.value, null)
    assert.ok(typeof m.reason === 'string' && m.reason.length > 0)
  }
})

test('TC-S4-12/13 发生事件后可读且口径与事件一致；无样本项降级为 reason', async () => {
  // T-m1 预约 src/a.mjs；T-m2 撞车（FILE_CONTENTION）；释放后 T-m2 再约成功（补记等待时长）
  await call('POST', '/api/tasks/T-m1/reservation', { by: 'w', scope: 'default', attemptId: 'a1', epoch: 1, paths: ['src/a.mjs'] })
  await call('POST', '/api/tasks/T-m2/reservation', { by: 'w', scope: 'default', attemptId: 'a2', epoch: 1, paths: ['src/a.mjs'] })
  await call('POST', '/api/tasks/T-m1/reservation/release', { by: 'w', scope: 'default', attemptId: 'a1', epoch: 1 })
  await call('POST', '/api/tasks/T-m2/reservation', { by: 'w', scope: 'default', attemptId: 'a2', epoch: 1, paths: ['src/a.mjs'] })

  const r = await call('GET', '/api/metrics/repository?repoId=scope%3Adefault')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  const keys = Object.keys(r.body.metrics).sort()
  assert.deepEqual(keys, ['integrationConflictRate', 'integrationRecoverySuccessRate', 'manualDecisionRate', 'postIntegrationValidationFailureRate', 'sameFileWriteBlocked', 'waitDurationP50', 'waitDurationP95'])
  assert.equal(r.body.metrics.sameFileWriteBlocked.available, true)
  assert.ok(r.body.metrics.sameFileWriteBlocked.value >= 1)
  assert.equal(r.body.metrics.waitDurationP50.available, true)
  assert.equal(typeof r.body.metrics.waitDurationP50.value, 'number')
  assert.equal(r.body.metrics.waitDurationP50.window.sampleSize >= 1, true)
  assert.ok(typeof r.body.metrics.waitDurationP50.window.formula === 'string')
  // 无集成 job 样本 -> 不可读而非 0
  assert.equal(r.body.metrics.integrationConflictRate.available, false)
  assert.equal(r.body.metrics.integrationConflictRate.value, null)
})

test('TC-S4-14 读面不写库：重复 GET 指标不改变任何事件计数', async () => {
  const before = mod.db.prepare('SELECT COUNT(*) AS n FROM write_intent_events').get().n
  await call('GET', '/api/metrics/repository?repoId=scope%3Adefault')
  await call('GET', '/api/metrics/repository?repoId=scope%3Adefault')
  const after = mod.db.prepare('SELECT COUNT(*) AS n FROM write_intent_events').get().n
  assert.equal(after, before)
})
