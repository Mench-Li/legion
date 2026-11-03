// team-hub/task-report-routes.test.mjs
// ============================================================================
// F2 · `POST /api/tasks/:id/report` 的 HTTP 契约（设计稿 §3 F2 / DEC-2）
//
// 守护以后只调这一个写口：状态、待答问题、审计一次落盘。
// 这里钉的是"调用方看得见的东西"：
//   ① 200 + {ok, task, question, auditSeq, duplicated}
//   ② 同 reportId 重投 ⇒ duplicated:true，问题 id 不变
//   ③ 已有未答问题再报 ⇒ 409 + code
//   ④ 缺 reportId ⇒ 400 + code
//   ⑤ 写完之后任务真的"停派"（F2 的闸在 SQL 层生效）
// ============================================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let mod
let base
let dbDir

const req = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method, agent: false,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let payload = null
  try { payload = await res.json() } catch { /* 无正文 */ }
  return { status: res.status, body: payload }
}
const mkTask = async (title = '报告宿主') =>
  (await req('POST', '/api/create', { title, by: 'general' })).body.task.id
const report = (id, body) => req('POST', `/api/tasks/${id}/report`, { by: 'soldier-coder', ...body })

before(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'legion-taskreport-'))
  process.env.TEAM_HUB_DB = join(dbDir, 'team.db')
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close() } catch { /* 已关闭 */ }
  try { mod?.db?.close?.() } catch { /* 已关闭 */ }
  rmSync(dbDir, { recursive: true, force: true })
})

test('① blocked + question：一次调用落三样，回执带 question 与 auditSeq', async () => {
  const id = await mkTask()
  const r = await report(id, {
    reportId: 'r-1', status: 'blocked', summary: '卡在口径',
    question: { body: '验收口径 A 还是 B？', options: ['A', 'B'] },
  })

  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.task.id, id)
  assert.ok(r.body.question?.id, '★ 问题行要建出来')
  assert.equal(r.body.duplicated, false)
  assert.equal(typeof r.body.auditSeq, 'number')

  const row = mod.db.prepare('SELECT report_state FROM tasks WHERE id=?').get(id)
  assert.equal(row.report_state, 'blocked')
})

test('② 同 reportId 重投 ⇒ duplicated，问题 id 不变', async () => {
  const id = await mkTask()
  const payload = { reportId: 'r-2', status: 'blocked', question: { body: '口径？' } }
  const a = await report(id, payload)
  const b = await report(id, payload)

  assert.equal(a.body.duplicated, false)
  assert.equal(b.body.duplicated, true)
  assert.equal(b.body.question.id, a.body.question.id)
  const count = mod.db.prepare("SELECT COUNT(*) c FROM agent_questions WHERE task_id=? AND status='open'").get(id).c
  assert.equal(count, 1)
})

test('③ 已有未答问题时再报新问题 ⇒ 409 + code', async () => {
  const id = await mkTask()
  await report(id, { reportId: 'r-3', status: 'blocked', question: { body: '第一个' } })
  const r = await report(id, { reportId: 'r-4', status: 'blocked', question: { body: '第二个' } })

  assert.equal(r.status, 409)
  assert.equal(r.body.code, 'REPORT_QUESTION_ALREADY_OPEN')
})

test('④ 缺 reportId ⇒ 400 + code（没有幂等键就无法判重投）', async () => {
  const id = await mkTask()
  const r = await report(id, { status: 'done', summary: '改完了' })
  assert.equal(r.status, 400)
  assert.equal(r.body.code, 'REPORT_ID_REQUIRED')
})

test('⑤ 报完之后任务真的停派（F2 的闸在 SQL 层生效）', async () => {
  const id = await mkTask()
  await report(id, { reportId: 'r-5', status: 'blocked', question: { body: '谁来决定？' } })

  const { buildClaimableTaskSql } = await import('./claim-policy.mjs')
  const ids = mod.db.prepare(buildClaimableTaskSql().replace('{scope}', '')).all().map((r) => r.id)
  assert.equal(ids.includes(id), false, '★ 有未答问题的任务不该出现在候选里')
})

test('⑥ applyTransition：一次请求把状态也推进（守护不必再单独发 transition）', async () => {
  const id = await mkTask()
  const r = await report(id, {
    reportId: 'r-6', status: 'blocked', question: { body: '口径？' }, applyTransition: true,
  })

  assert.equal(r.status, 200)
  assert.equal(r.body.transition, 'blocked')
  assert.equal(mod.db.prepare('SELECT status FROM tasks WHERE id=?').get(id).status, 'blocked')
})

test('⑦ dropped + applyTransition ⇒ canceled（不打扰人，但账要留）', async () => {
  const id = await mkTask()
  const r = await report(id, { reportId: 'r-7', status: 'dropped', summary: '已无必要', applyTransition: true })

  assert.equal(r.body.transition, 'canceled')
  assert.equal(mod.db.prepare('SELECT status FROM tasks WHERE id=?').get(id).status, 'canceled')
  const actions = mod.db.prepare("SELECT action FROM audit WHERE taskId=?").all(id).map((x) => x.action)
  assert.ok(actions.includes('drop'), '★ 不打扰 ≠ 不留痕')
})
