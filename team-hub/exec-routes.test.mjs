// ============================================================================
// PRT-316 切片 25：自动执行开关与请求队列（`/api/exec` 五条）
//   GET  /api/exec           读开关
//   POST /api/exec           写开关（upsert + audit）
//   GET  /api/exec/queue     该自动执行的任务（排掉已登记的）
//   POST /api/exec/request   登记一个执行请求
//   GET  /api/exec/requests  看已登记（pending）
//
// ★ 本族在搬走之前**一把判据都没有**（`survey-judges2` 对四个路径全报"强判据 0 套"）。
//   形状全部是先量出来的（`probe25-exec.mjs`）：
//     · 读开关**永远 200**（没有这个空间也 200，`enabled:false, updatedAt:null`），不 404
//     · 写开关的**信封与写门面不同**：`{ok:true, task:{…}}`（`handleRun` 那条是摊开的）
//     · 写请求要 `body.by`（非空串，**会 trim**），缺了 400「缺少操作者身份 by」
//     · `enabled` 是**严格** `=== true`：`1` / `'true'` / `'yes'` 全算 **false**
//     · `body.scope` 缺或全空白 → 落到 `readScope(body)` 给的 **`'default'`**
//     · `queue` 三重筛选：描述含 `[auto-goal]` + 状态 todo/in_progress + 角色不在 NON_AUTO_ROLES
//     · `queue` 排掉**已登记**的任务 —— 这是本族最要紧的一条合流
//     · `requests` 返回**裸数组**，每行恰好 `{taskId, scope, createdAt}`（**没有 status**）
// ============================================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let mod
let base
let dbDir

const call = async (method, path, body) => {
  const res = await fetch(base + path, {
    method, agent: false,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  let payload = null
  try { payload = await res.json() } catch { /* 无正文 */ }
  return { status: res.status, body: payload }
}
const W = (body) => ({ by: 'tester', ...body })
const get = (p) => call('GET', p)
const post = (p, body) => call('POST', p, body)

/** 直接落库造任务（走 HTTP 太慢，而且本族守的是 queue 的筛选不是任务的写入）。 */
const seedTask = (id, { description = '', status = 'todo', role = 'planner', scope = 'default' } = {}) => {
  mod.db.prepare('INSERT INTO tasks (id, title, description, status, role, scope) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, id, description, status, role, scope)
}

before(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'legion-execroutes-'))
  process.env.TEAM_HUB_DB = join(dbDir, 'team.db')
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close?.() } catch { /* 已关闭 */ }
  try { mod?.db?.close?.() } catch { /* 已关闭 */ }
  rmSync(dbDir, { recursive: true, force: true })
})

// ── 读开关 ────────────────────────────────────────────────────────────────
test('① 读开关：不带 scope ⇒ 200 `{scope:"", enabled:false, updatedAt:null}`', async () => {
  const r = await get('/api/exec')
  assert.equal(r.status, 200)
  assert.deepEqual(Object.keys(r.body).sort(), ['enabled', 'scope', 'updatedAt'])
  assert.equal(r.body.scope, '')
  assert.equal(r.body.enabled, false)
  assert.equal(r.body.updatedAt, null)
})

test('② 读开关：**没有这个空间也 200**（不是 404 —— 没开过与关着是同一件事）', async () => {
  const r = await get('/api/exec?scope=never-existed')
  assert.equal(r.status, 200, '★ 404 的话前端就得把"没开过"和"空间不存在"分开处理')
  assert.deepEqual(r.body, { scope: 'never-existed', enabled: false, updatedAt: null })
})

// ── 写开关 ────────────────────────────────────────────────────────────────
test('③ 写开关：要 `body.by`，缺了/全空白都 400', async () => {
  const miss = await post('/api/exec', { scope: 's3', enabled: true })
  assert.equal(miss.status, 400)
  assert.match(String(miss.body.error), /by/, '错误信息要点名缺的是 by')
  assert.equal((await post('/api/exec', { by: '   ', scope: 's3', enabled: true })).status, 400)
  // 而且**什么都没写进去**
  assert.equal((await get('/api/exec?scope=s3')).body.enabled, false)
})

test('④ 写开关：回执的信封是 `{ok:true, task:{…}}`（与 `handleRun` 那条**不一样**）', async () => {
  const w = await post('/api/exec', W({ scope: 's4', enabled: true }))
  assert.equal(w.status, 200)
  assert.equal(w.body.ok, true)
  assert.deepEqual(w.body.task, { scope: 's4', enabled: true },
    '★ `handleWrite` 把结果**裹在 `task` 里**；`handleRun` 那条是摊开的（`{ok:true, ...result}`）——' +
    '两个写门面的信封不同，不分别打出来就会照一个去解另一个')
})

test('⑤ 写开关：写完再读，`enabled` 为 true 且 `updatedAt` 变成时间戳', async () => {
  await post('/api/exec', W({ scope: 's5', enabled: true }))
  const r = await get('/api/exec?scope=s5')
  assert.equal(r.body.enabled, true)
  assert.equal(typeof r.body.updatedAt, 'string')
  assert.ok(!Number.isNaN(Date.parse(r.body.updatedAt)), `updatedAt 要是能解析的时间：${r.body.updatedAt}`)
})

test('⑥ ★ 写开关：`enabled` 是**严格** `=== true` —— `1`/`"true"`/`"yes"` 都算 **false**', async () => {
  for (const v of [1, 'true', 'yes', 'on', null, undefined]) {
    await post('/api/exec', W({ scope: 's6', enabled: v }))
    assert.equal((await get('/api/exec?scope=s6')).body.enabled, false,
      `★ enabled=${JSON.stringify(v)} 不是 `+ '`true` 本身 ⇒ 关。宽松判真会让"truthy 的字符串"意外打开自动执行')
  }
  await post('/api/exec', W({ scope: 's6', enabled: true }))
  assert.equal((await get('/api/exec?scope=s6')).body.enabled, true)
})

test('⑦ 写开关：关得掉（upsert 覆盖，不是只能开）', async () => {
  await post('/api/exec', W({ scope: 's7', enabled: true }))
  assert.equal((await get('/api/exec?scope=s7')).body.enabled, true)
  await post('/api/exec', W({ scope: 's7', enabled: false }))
  assert.equal((await get('/api/exec?scope=s7')).body.enabled, false, '★ 关不掉的话这个开关是单向的')
})

test('⑧ 写开关：`body.scope` 缺或全空白 ⇒ 落到 `readScope` 给的 `"default"`', async () => {
  assert.equal((await post('/api/exec', W({ enabled: true }))).body.task.scope, 'default')
  assert.equal((await post('/api/exec', W({ scope: '   ', enabled: true }))).body.task.scope, 'default',
    '★ 全空白要**落到缺省**，不能当成一个名叫空白的空间')
  assert.equal((await get('/api/exec?scope=default')).body.enabled, true)
})

test('⑨ 写开关：`scope` 会 trim（存的不是带空白的那个）', async () => {
  const w = await post('/api/exec', W({ scope: '  s9  ', enabled: true }))
  assert.equal(w.body.task.scope, 's9')
  assert.equal((await get('/api/exec?scope=s9')).body.enabled, true)
})

// ── queue ─────────────────────────────────────────────────────────────────
test('⑩ ★ queue 的三重筛选：`[auto-goal]` + 状态 + 角色不在 NON_AUTO_ROLES', async () => {
  seedTask('q-auto-todo', { description: '[auto-goal] 自动', status: 'todo', role: 'planner', scope: 'qq' })
  seedTask('q-auto-prog', { description: '[auto-goal] 进行中', status: 'in_progress', role: 'writer', scope: 'qq' })
  seedTask('q-coder', { description: '[auto-goal] 写码', status: 'todo', role: 'coder', scope: 'qq' })
  seedTask('q-nogoal', { description: '普通任务', status: 'todo', role: 'planner', scope: 'qq' })
  seedTask('q-done', { description: '[auto-goal] 做完了', status: 'done', role: 'planner', scope: 'qq' })
  const ids = (await get('/api/exec/queue?scope=qq')).body.tasks.map((t) => t.id).sort()
  assert.deepEqual(ids, ['q-auto-prog', 'q-auto-todo'],
    '★ 写码类角色（coder）要排掉 —— 那类由人/另一条链负责；' +
    '没有 `[auto-goal]` 标记的、以及已完成的，都不该进这条队列')
})

test('⑪ queue：带 scope 就是它，不带就是 `"all"`', async () => {
  seedTask('q-other', { description: '[auto-goal] 别的空间', status: 'todo', role: 'planner', scope: 'qq2' })
  const one = await get('/api/exec/queue?scope=qq')
  assert.equal(one.body.scope, 'qq')
  assert.ok(!one.body.tasks.some((t) => t.id === 'q-other'), '带 scope 时不该看见别的空间')
  const all = await get('/api/exec/queue')
  assert.equal(all.body.scope, 'all')
  assert.ok(all.body.tasks.some((t) => t.id === 'q-other'), '不带 scope 是全体')
})

// ── request ───────────────────────────────────────────────────────────────
test('⑫ 登记请求：缺 `taskId` / 空串都 400「缺少参数 taskId」', async () => {
  for (const v of [undefined, '', 123, null]) {
    const r = await post('/api/exec/request', W({ taskId: v }))
    assert.equal(r.status, 400, `taskId=${JSON.stringify(v)} 应当被拒`)
    assert.match(String(r.body.error), /taskId/)
  }
})

test('⑬ 登记请求：未知任务 ⇒ 400 并点名那个 id', async () => {
  const r = await post('/api/exec/request', W({ taskId: 'no-such-task' }))
  assert.equal(r.status, 400)
  assert.match(String(r.body.error), /no-such-task/)
})

test('⑭ 登记请求：成功回执 `{ok:true, task:{taskId, scope, status:"pending"}}`，scope 取自**任务**', async () => {
  const r = await post('/api/exec/request', W({ taskId: 'q-auto-todo' }))
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.task, { taskId: 'q-auto-todo', scope: 'qq', status: 'pending' },
    '★ scope 是从 tasks 表里查出来的、不是请求方给的')
})

test('⑮ ★★ 最要紧的一条合流：登记过的任务**从 queue 里消失**', async () => {
  seedTask('c-1', { description: '[auto-goal] 待登记', status: 'todo', role: 'planner', scope: 'cc' })
  seedTask('c-2', { description: '[auto-goal] 也待登记', status: 'todo', role: 'planner', scope: 'cc' })
  assert.deepEqual((await get('/api/exec/queue?scope=cc')).body.tasks.map((t) => t.id).sort(), ['c-1', 'c-2'])
  await post('/api/exec/request', W({ taskId: 'c-1' }))
  assert.deepEqual((await get('/api/exec/queue?scope=cc')).body.tasks.map((t) => t.id), ['c-2'],
    '★ 不排掉的话，同一件事会被**反复派出去** —— 而"派了两遍"与"派了一遍"在守护那边看起来一样')
})

test('⑯ 登记请求：重复登记是幂等的（ON CONFLICT，不新增行）', async () => {
  seedTask('c-3', { description: '[auto-goal] x', status: 'todo', role: 'planner', scope: 'cc3' })
  await post('/api/exec/request', W({ taskId: 'c-3' }))
  await post('/api/exec/request', W({ taskId: 'c-3' }))
  const rows = mod.db.prepare("SELECT COUNT(*) AS n FROM exec_requests WHERE taskId='c-3'").get()
  assert.equal(rows.n, 1)
})

// ── requests ──────────────────────────────────────────────────────────────
test('⑰ ★ `GET /api/exec/requests` 是**裸数组**，每行恰好 `{taskId, scope, createdAt}`（没有 status）', async () => {
  const r = await get('/api/exec/requests')
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(r.body), '不是 `{ok, requests}` —— 直接是数组')
  assert.ok(r.body.length >= 1)
  assert.deepEqual(Object.keys(r.body[0]).sort(), ['createdAt', 'scope', 'taskId'],
    '★ 三格；`status` **不在**里面 —— 这条端点只看 pending，所以状态是常量、不必回传')
  assert.ok(r.body.every((x) => typeof x.taskId === 'string' && typeof x.scope === 'string' && typeof x.createdAt === 'string'))
})

test('⑱ `requests` 只列 pending（守护消费掉之后就不在这儿了）', async () => {
  seedTask('p-1', { description: '[auto-goal] x', status: 'todo', role: 'planner', scope: 'pp' })
  await post('/api/exec/request', W({ taskId: 'p-1' }))
  assert.ok((await get('/api/exec/requests')).body.some((x) => x.taskId === 'p-1'))
  mod.db.prepare("UPDATE exec_requests SET status='done' WHERE taskId='p-1'").run()
  assert.ok(!(await get('/api/exec/requests')).body.some((x) => x.taskId === 'p-1'),
    '★ 不按 status 筛的话，做完的事会一直在队列里被反复看见')
})

test('⑲ `requests` 按 `createdAt` 升序（先登记的排前面）', async () => {
  mod.db.prepare('DELETE FROM exec_requests').run()
  const ins = mod.db.prepare("INSERT INTO exec_requests (taskId, scope, status, createdAt) VALUES (?, 'z', 'pending', ?)")
  ins.run('r-late', '2026-09-20T10:00:00.000Z')
  ins.run('r-early', '2026-01-01T00:00:00.000Z')
  assert.deepEqual((await get('/api/exec/requests')).body.map((x) => x.taskId), ['r-early', 'r-late'])
})

// ── 已知不对称（钉住现状） ─────────────────────────────────────────────────
test('⑳ ★ `taskId` **不 trim**（与 `by` 会 trim 不对称）—— 一条真缺陷，本片只钉住现状', async () => {
  const r = await post('/api/exec/request', W({ taskId: '   ' }))
  assert.equal(r.status, 400)
  // ★ 判据是 `typeof id !== 'string' || id.length === 0` —— `'   '.length` 是 3，于是放过去查库，
  //   查不到才报"未知任务"。而 `by`（requireMember）是 `by.trim().length === 0` ⇒ 会 trim。
  //   同一个请求体里两个字段，一个 trim 一个不 trim。
  assert.match(String(r.body.error), /未知任务/,
    '★ 现状是「未知任务    」（带空白）而不是「缺少参数 taskId」。' +
    '若这条红了：说明有人给 taskId 加了 trim —— 请把断言改成"缺少参数 taskId"，' +
    '并顺手看看 `by` 那条是否也该与它统一。')
})

test('㉑ 方法位：每条路径只认自己那个方法', async () => {
  const cases = [
    ['POST', '/api/exec/queue'], ['GET', '/api/exec/request'],
    ['POST', '/api/exec/requests'], ['DELETE', '/api/exec'],
    ['DELETE', '/api/exec/requests'], ['PUT', '/api/exec/queue'],
  ]
  for (const [m, p] of cases) {
    assert.equal((await call(m, p)).status, 404, `${m} ${p} 应当 404`)
  }
})
