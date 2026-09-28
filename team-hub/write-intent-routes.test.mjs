// team-hub/write-intent-routes.test.mjs —— S4（R-2 · R-3 · R-7 HTTP 面）
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let mod
let base
let dir
let activeRepoId

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'legion-t170-wroutes-'))
  process.env.TEAM_HUB_DB = join(dir, 'team.db')
  process.env.TEAM_HUB_TOKEN = ''
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
  const ins = mod.db.prepare("INSERT INTO tasks (id, title, status, scope, fixCount) VALUES (?,?,?,?,?)")
  ins.run('T-w1', 'w1', 'todo', 'default', 0)
  ins.run('T-w2', 'w2', 'todo', 'default', 0)
  ins.run('T-w3', 'w3', 'todo', 'other-space', 0)
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
const intent = (taskId, body) => call('POST', '/api/tasks/' + taskId + '/write-intent', body)
const reserve = (taskId, body) => call('POST', '/api/tasks/' + taskId + '/reservation', body)

test('TC-S4-01/02 意图登记 revision CAS：创建 revision=1，过期提交 409', async () => {
  const first = await intent('T-w1', { by: 'planner', scope: 'default', paths: ['src/a.mjs'] })
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.intent.revision, 1)
  const bump = await intent('T-w1', { by: 'planner', scope: 'default', paths: ['src/a.mjs', 'src/b.mjs'], expectedRevision: 1 })
  assert.equal(bump.status, 200)
  assert.equal(bump.body.intent.revision, 2)
  const stale = await intent('T-w1', { by: 'planner', scope: 'default', paths: ['src/c.mjs'], expectedRevision: 1 })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.code, 'REVISION_CONFLICT')
  assert.equal(stale.body.currentRevision, 2)
})

test('TC-S4-03 预约成功写调度状态 reserved；冲突返回 FILE_CONTENTION 且等待不烧重试', async () => {
  const ok = await reserve('T-w1', { by: 'worker', scope: 'default', attemptId: 'a1', epoch: 1, paths: ['src/a.mjs'] })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.equal(ok.body.ok, true)
  activeRepoId = ok.body.reservation.repoId
  assert.equal(mod.db.prepare("SELECT scheduling_state AS s FROM tasks WHERE id='T-w1'").get().s, 'reserved')

  const blocked = await reserve('T-w2', { by: 'worker', scope: 'default', attemptId: 'a2', epoch: 1, paths: ['src/a.mjs'] })
  assert.equal(blocked.status, 200)
  assert.equal(blocked.body.ok, false)
  assert.equal(blocked.body.code, 'FILE_CONTENTION')
  assert.ok(blocked.body.paths.includes('src/a.mjs'))
  assert.equal(blocked.body.holderTaskId, 'T-w1')
  assert.equal(blocked.body.schedulingState, 'waiting-file')
  const t = mod.db.prepare("SELECT status, fixCount, scheduling_state AS s FROM tasks WHERE id='T-w2'").get()
  assert.equal(t.status, 'todo', '等待写入资格不得把任务打成执行失败')
  assert.equal(t.fixCount, 0, '等待不得消耗重试额度')
  assert.equal(t.s, 'waiting-file')
})

test('TC-S4-04 实时冲突视图只读且如实列出占用者；历史提示不冒充实时占用', async () => {
  const r = await call('GET', '/api/repositories/' + encodeURIComponent(activeRepoId) + '/contention')
  assert.equal(r.status, 200)
  assert.equal(r.body.readOnly, true)
  assert.equal(r.body.active.length, 1)
  assert.equal(r.body.active[0].taskId, 'T-w1')
  assert.ok(Array.isArray(r.body.active[0].paths))
  const empty = await call('GET', '/api/repositories/scope%3Anowhere/contention')
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.body.active, [], '没有活跃预约时不得凭历史 patch 编造占用')
})

test('TC-S4-05 epoch 过期释放被拒（409），正确 epoch 释放成功', async () => {
  // T-w1 在 TC-S4-03 里以 epoch=1 预约，这里用过期 epoch=99 释放必须被拒
  const badRelease = await call('POST', '/api/tasks/T-w1/reservation/release', { by: 'worker', scope: 'default', attemptId: 'a1', epoch: 99 })
  assert.equal(badRelease.status, 409)
  assert.equal(badRelease.body.code, 'EPOCH_STALE')
  assert.equal(badRelease.body.currentEpoch, 1)
  const okRelease = await call('POST', '/api/tasks/T-w1/reservation/release', { by: 'worker', scope: 'default', attemptId: 'a1', epoch: 1 })
  assert.equal(okRelease.status, 200)
  assert.equal(okRelease.body.ok, true)
})

test('TC-S4-06 服务端权威：绝对路径 / 非法 ref / 缺 scope 一律 400', async () => {
  const abs = await intent('T-w1', { by: 'planner', scope: 'default', repoId: 'C:/repo/.git', paths: ['src/a.mjs'] })
  assert.equal(abs.status, 400)
  assert.equal(abs.body.code, 'INVALID_REPO')
  const spoof = await intent('T-w1', { by: 'planner', scope: 'default', repoId: 'some-other-repo', paths: ['src/a.mjs'] })
  assert.equal(spoof.status, 400)
  assert.equal(spoof.body.code, 'INVALID_REPO')
  const badRef = await intent('T-w1', { by: 'planner', scope: 'default', targetRef: 'main', paths: ['src/a.mjs'] })
  assert.equal(badRef.status, 400)
  assert.equal(badRef.body.code, 'INVALID_TARGET_REF')
  const noScope = await intent('T-w1', { by: 'planner', paths: ['src/a.mjs'] })
  assert.equal(noScope.status, 400)
  assert.equal(noScope.body.code, 'MISSING_SCOPE')
  const traversal = await intent('T-w1', { by: 'planner', scope: 'default', paths: ['../escape.mjs'] })
  assert.equal(traversal.status, 400)
  assert.equal(traversal.body.code, 'INVALID_PATHS')
  const shellRef = await intent('T-w1', { by: 'planner', scope: 'default', targetRef: 'refs/heads/main; rm -rf /', paths: ['src/a.mjs'] })
  assert.equal(shellRef.status, 400)
})

test('文件域是规划范围的上界；宽目录不能覆盖未授权文件', async () => {
  mod.db.prepare("INSERT INTO tasks (id,title,status,scope,fixCount,fileDomain) VALUES ('T-domain','domain','todo','default',0,?)").run(JSON.stringify(['src/a']))
  const tooWide = await intent('T-domain', { by: 'planner', scope: 'default', paths: [{ path: 'src', type: 'dir' }] })
  assert.equal(tooWide.status, 422)
  assert.equal(tooWide.body.code, 'OUT_OF_FILE_DOMAIN')
  const allowed = await intent('T-domain', { by: 'planner', scope: 'default', paths: [{ path: 'src/a', type: 'dir' }] })
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body))
})

test('不同空间绑定同一物理仓库，不能绕过文件占用；任务 scope 也必须匹配', async () => {
  const other = await reserve('T-w3', { by: 'worker', scope: 'other-space', attemptId: 'a3', epoch: 1, paths: ['src/a.mjs'] })
  assert.equal(other.status, 200)
  assert.equal(other.body.reservation.repoId, activeRepoId)
  const wrongScope = await intent('T-w3', { by: 'planner', scope: 'default', paths: ['src/a.mjs'] })
  assert.equal(wrongScope.status, 403)
  const overlap = await reserve('T-w2', { by: 'worker', scope: 'default', attemptId: 'a2', epoch: 2, paths: ['src/a.mjs'] })
  assert.equal(overlap.body.code, 'FILE_CONTENTION')
  assert.equal(overlap.body.holderTaskId, 'T-w3')
  const live = await call('GET', '/api/tasks/T-w2/contention')
  assert.equal(live.body.code, 'FILE_CONTENTION')
  assert.equal(live.body.holderTaskId, 'T-w3')
})
