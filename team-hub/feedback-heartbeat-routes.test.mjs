// ============================================================================
// PRT-316 切片 44：用户反馈读端点 + worker 心跳 —— 2 条，全 `exact`
//   GET  /api/task-feedback   PRT-404：用户反馈的**独立读端点**
//   POST /api/heartbeat       S2/R-1 决策 B1：心跳可附带当前选用模型
//
// ★★★ `GET /api/task-feedback` 此前**零判据**，而它身上有两条**纪律**：
//   ① 「任务不存在」与「这个任务没有反馈」是**两件事** ⇒ 前者必须 404，
//      不能回 `{feedback: []}`（那会让两者在调用方那里长得一样）；
//   ② **跨空间越权读取**：任务 id 全库唯一，但拿别空间的 id 来问仍是一次越权读取。
// ============================================================================
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFeedbackHeartbeatRoutes } from './routes/feedback-heartbeat.mjs'

const dir = mkdtempSync(join(tmpdir(), 'legion-feedback-heartbeat-'))
process.env.TEAM_HUB_DB = join(dir, 'team.db')
process.env.TEAM_HUB_TOKEN = ''
const mod = await import('./server.mjs')
await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + mod.server.address().port

const get = async (p) => {
  const res = await fetch(base + p)
  const t = await res.text(); let j; try { j = JSON.parse(t) } catch { j = t }
  return { status: res.status, body: j }
}
const post = async (p, body) => {
  const res = await fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  })
  const t = await res.text(); let j; try { j = JSON.parse(t) } catch { j = t }
  return { status: res.status, body: j }
}

const iso = new Date().toISOString()
const mkTask = (id, { scope = 'default', feedback = [] } = {}) => {
  mod.db.prepare('INSERT OR REPLACE INTO tasks (id,title,priority,status,scope,role,soldier,hold,feedback,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, 'T-' + id, 'medium', 'todo', scope, 'dev', null, 0, JSON.stringify(feedback), iso, iso)
}
const reset = () => { mod.db.prepare('DELETE FROM tasks').run(); mod.db.prepare('DELETE FROM members').run() }
const memberRow = (id) => mod.db.prepare('SELECT * FROM members WHERE id = ?').get(id)

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close?.() } catch { /* 已关 */ }
  try { mod?.db?.close?.() } catch { /* 已关 */ }
  rmSync(dir, { recursive: true, force: true })
})

// ══════════════════════ GET /api/task-feedback ══════════════════════

test('① ★★★ 缺 `taskId` ⇒ 400 `MISSING_PARAM`（不是 404、也不是空数组）', async () => {
  reset()
  const r = await get('/api/task-feedback')
  assert.equal(r.status, 400, JSON.stringify(r.body))
  assert.equal(r.body.ok, false)
  assert.equal(r.body.code, 'MISSING_PARAM', '★★★ 缺参数要报出**参数名**，否则调用方只看到「400」')
  assert.equal(r.body.error, '缺少参数 taskId')
  assert.equal(typeof r.body.serverTimeMs, 'number', '★ 要带 serverTimeMs')
})

test('② ★★ 全空白的 `taskId` 也算缺（源码判的是 `.trim() === \'\'`）', async () => {
  reset()
  for (const v of ['', '   ', '\t', '%20%20']) {
    const r = await get(`/api/task-feedback?taskId=${v}`)
    assert.equal(r.status, 400, `★★ taskId=${JSON.stringify(v)} 应当是 400`)
    assert.equal(r.body.code, 'MISSING_PARAM')
  }
})

test('③ ★★★ 任务不存在 ⇒ **404**，**不许**回 `{feedback: []}`', async () => {
  reset()
  const r = await get('/api/task-feedback?taskId=ghost')
  assert.equal(r.status, 404, JSON.stringify(r.body))
  assert.equal(r.body.code, 'TASK_NOT_FOUND')
  assert.equal(r.body.error, '任务 ghost 不存在')
  assert.equal(r.body.feedback, undefined,
    '★★★ 「任务不存在」与「这个任务没有反馈」是两件事 —— 回空数组会让两者长得一样')
})

test('③b ★★★ 对照：任务存在但**没有反馈** ⇒ 200 + `count: 0`（两件事确实分得开）', async () => {
  reset()
  mkTask('empty', { feedback: [] })
  const r = await get('/api/task-feedback?taskId=empty')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.ok, true)
  assert.equal(r.body.count, 0)
  assert.deepEqual(r.body.feedback, [], '★ 这才是"没有反馈"的样子，与 ③ 的 404 分得开')
})

test('④ ★★★ **跨空间越权读取**：拿别空间的 id 来问 ⇒ 404（不是 200）', async () => {
  reset()
  mkTask('t-in-A', { scope: 'A', feedback: [{ text: '用户要求调整' }] })
  const r = await get('/api/task-feedback?taskId=t-in-A&scope=B')
  assert.equal(r.status, 404, JSON.stringify(r.body))
  assert.equal(r.body.code, 'TASK_NOT_FOUND')
  assert.equal(r.body.error, '任务 t-in-A 不在空间 B 里',
    '★★★ 任务 id 全库唯一，但装配是**按空间**做的 —— 拿别空间的 id 来问就是一次越权读取')
  assert.equal(r.body.feedback, undefined, '★★★ 越权读取**一个字节都不能漏**')
})

test('④b ★★ `scope` 对得上 / 没给 / 给了空白 ⇒ 都放行', async () => {
  reset()
  mkTask('t-A', { scope: 'A', feedback: [{ text: 'f' }] })
  assert.equal((await get('/api/task-feedback?taskId=t-A&scope=A')).status, 200, '★ 对得上')
  assert.equal((await get('/api/task-feedback?taskId=t-A')).status, 200, '★ 没给 scope ⇒ 不校验')
  assert.equal((await get('/api/task-feedback?taskId=t-A&scope=')).status, 200, '★★ 空串不校验（`trim() !== \'\'` 那道闸）')
  assert.equal((await get('/api/task-feedback?taskId=t-A&scope=%20')).status, 200, '★★ 全空白也不校验')
})

test('⑤ ★★ 成功形状：`{ok, taskId, count, feedback, serverTimeMs}`，feedback 是**解析好的数组**', async () => {
  reset()
  mkTask('ok1', { feedback: [{ text: 'a', at: 'x' }, { text: 'b' }] })
  const r = await get('/api/task-feedback?taskId=ok1')
  assert.equal(r.status, 200)
  assert.deepEqual(Object.keys(r.body).sort(), ['count', 'feedback', 'ok', 'serverTimeMs', 'taskId'])
  assert.equal(r.body.count, 2)
  assert.ok(Array.isArray(r.body.feedback), '★★ 不能把 JSON 字符串原样吐出来')
  assert.equal(r.body.feedback[0].text, 'a')
})

test('⑤b ★★ `taskId` 查库前会 `trim()`', async () => {
  reset()
  mkTask('trimme', { feedback: [{ text: 'z' }] })
  const r = await get('/api/task-feedback?taskId=%20trimme%20')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.taskId, 'trimme')
  assert.equal(r.body.count, 1, '★ 前后空格不影响查库')
})

test('⑤c ★★ `feedback` 列是坏 JSON 时回空数组（不是 500）', async () => {
  reset()
  mod.db.prepare('INSERT OR REPLACE INTO tasks (id,title,priority,status,scope,role,soldier,hold,feedback,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run('bad', 'T', 'medium', 'todo', 'default', 'dev', null, 0, 'not-json', iso, iso)
  const r = await get('/api/task-feedback?taskId=bad')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body.feedback, [], '★ parseJson 的回落是空数组')
  assert.equal(r.body.count, 0)
})

// ══════════════════════ POST /api/heartbeat ══════════════════════

test('⑥ ★★★ 心跳成功 ⇒ `{ok:true, task:{member, scope, online:true}}` 且**真的落了 members 表**', async () => {
  reset()
  const r = await post('/api/heartbeat', { by: 'w1', scope: 'A' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body, { ok: true, task: { member: 'w1', scope: 'A', online: true } })
  const row = memberRow('w1')
  assert.ok(row, '★★ 必须真的落库（`touchMember` 的副作用才是这条路由的意义）')
  assert.equal(row.scope, 'A')
  assert.equal(row.online, 1, '★ online 置 1')
  assert.ok(row.lastSeenAt, '★ 要写 lastSeenAt')
})

test('⑦ ★★★ `kind` 非字符串或缺省 ⇒ 记成 unknown', async () => {
  reset()
  await post('/api/heartbeat', { by: 'k1' })
  assert.equal(memberRow('k1').kind, 'unknown', '★★ 缺省是 unknown')
  await post('/api/heartbeat', { by: 'k2', kind: 123 })
  assert.equal(memberRow('k2').kind, 'unknown', '★★ 非字符串也回落到 unknown')
  await post('/api/heartbeat', { by: 'k3', kind: 'worker' })
  assert.equal(memberRow('k3').kind, 'worker', '★ 字符串照用')
})

test('⑧ ★★★ 带 `model` 对象 ⇒ 落成 JSON；否则该列为空', async () => {
  reset()
  await post('/api/heartbeat', { by: 'm1', model: { provider: 'p', model: 'mm' } })
  assert.deepEqual(JSON.parse(memberRow('m1').model), { provider: 'p', model: 'mm' },
    '★★★ 决策 B1：心跳顺带守护当前选用模型')
  // 只有一半也是字符串 ⇒ 仍然落，缺的补空串
  await post('/api/heartbeat', { by: 'm2', model: { model: 'only-model' } })
  assert.deepEqual(JSON.parse(memberRow('m2').model), { provider: '', model: 'only-model' })
  await post('/api/heartbeat', { by: 'm3', model: { provider: 'only-provider' } })
  assert.deepEqual(JSON.parse(memberRow('m3').model), { provider: 'only-provider', model: '' })
})

test('⑧b ★★ `model` 不是对象 / 两个字段都不是字符串 ⇒ 不写 model', async () => {
  reset()
  for (const [id, model] of [['n1', 'a-string'], ['n2', null], ['n3', 42], ['n4', { provider: 1, model: 2 }], ['n5', []]]) {
    await post('/api/heartbeat', { by: id, model })
    assert.equal(memberRow(id).model, null, `★★ model=${JSON.stringify(model)} 不该写进 members.model`)
  }
})

test('⑨ ★★ 重复心跳是**更新**不是新增（`ON CONFLICT(id) DO UPDATE`）', async () => {
  reset()
  await post('/api/heartbeat', { by: 'dup', scope: 'A', kind: 'worker' })
  const n1 = mod.db.prepare('SELECT COUNT(*) c FROM members').get().c
  await post('/api/heartbeat', { by: 'dup', scope: 'B', kind: 'executor' })
  const n2 = mod.db.prepare('SELECT COUNT(*) c FROM members').get().c
  assert.equal(n1, 1); assert.equal(n2, 1, '★★ 同一个 id 不新增行')
  assert.equal(memberRow('dup').scope, 'B', '★ 后一次的值覆盖前一次')
  assert.equal(memberRow('dup').kind, 'executor')
})

test('⑩ ★★ 缺 `by` ⇒ 400「缺少操作者身份 by」（`handleWrite` 的第一道闸）', async () => {
  reset()
  const r = await post('/api/heartbeat', {})
  assert.equal(r.status, 400, JSON.stringify(r.body))
  assert.match(String(r.body.error), /缺少操作者身份 by/)
  const blank = await post('/api/heartbeat', { by: '   ' })
  assert.equal(blank.status, 400, '★★ 全空白也算缺')
})

test('⑩b ★★ `scope` 缺省 ⇒ `default`（不是 undefined/空串）', async () => {
  reset()
  const r = await post('/api/heartbeat', { by: 'sc' })
  assert.equal(r.body.task.scope, 'default')
  assert.equal(memberRow('sc').scope, 'default')
})

// ══════════════════════ 接缝契约 ══════════════════════

const stub = (over = {}) => createFeedbackHeartbeatRoutes({
  json: (res, code, p) => { res.sent = { code, payload: p } },
  db: { prepare: () => ({ get: () => undefined, all: () => [], run: () => {} }) },
  parseJson: () => [],
  handleWrite: async (req, res, run) => { await run({}, 'me', 'default') },
  touchMember: () => {},
  ...over,
})

test('⑪ ★★★ dispatch 契约：GET/POST 各认一条 / `exact` 不退化成 `prefix`', async () => {
  const router = stub()
  const ctx = (p) => ({ path: p, url: new URL('http://x' + p) })
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/task-feedback')), true)
  assert.equal(await router.dispatch({ method: 'POST' }, {}, ctx('/api/heartbeat')), true)
  assert.equal(await router.dispatch({ method: 'POST' }, {}, ctx('/api/task-feedback')), false, '★★ 方法必须对上')
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/heartbeat')), false, '★★ 心跳只有 POST')
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/task-feedbackX')), false, '★ exact 不许退化成 startsWith')
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/nope')), false)
  assert.deepEqual(router.routes.map((r) => `${r.method} ${r.match} ${r.path}`),
    ['GET exact /api/task-feedback', 'POST exact /api/heartbeat'])
  assert.equal(router.id, 'feedback-heartbeat')
})

test('⑫ ★★ 缺注入项 ⇒ **构造时**就抛（fail closed）', async () => {
  const full = { json: () => {}, db: {}, parseJson: () => [], handleWrite: async () => {}, touchMember: () => {} }
  for (const k of Object.keys(full)) {
    const partial = { ...full }
    delete partial[k]
    assert.throws(() => createFeedbackHeartbeatRoutes(partial), /缺注入项/, `★★ 少了 ${k} 必须在构造时就抛`)
  }
})
