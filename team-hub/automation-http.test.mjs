// team-hub/automation-http.test.mjs
// ============================================================================
// F-16 的**接线**判据：真 hub 进程 + 真 HTTP。
//
// `automation-store.test.mjs` 验的是仓储语义（22 例全绿）。它全绿也可能
// **没有任何 HTTP 面能走到那些函数**——而那正是本仓反复记过的形状：
//
//   > 一个"能力齐全、用例全绿、而没有任何调用方能走到"的模块，
//   > 与一个不存在的模块，在部署上是同一个东西。
//
// 这一组只钉三件**只有真接线才有**的事：
//   ① `GET /api/automation/calendar` 是**纯投影** —— 连真 HTTP 打 50 次，
//      `automation_runs` 一行都不多；
//   ② `POST /api/automation/tick` 物化出运行，并且**与生产定时器共用
//      同一个函数**（结构级对照：两处漂移的表现是"手动对、自动错"）；
//   ③ 建计划/改计划/查运行历史的形状对得上，且错误码是具名的。
// ============================================================================
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-auto-http-'))
let mod
let base = ''
const TOKEN = 'auto-e2e-token'
const TZ = 'Asia/Shanghai'

before(async () => {
  process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_TOKEN = TOKEN
  process.env.TEAM_HUB_HOST = '127.0.0.1'
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

const auth = { authorization: `Bearer ${TOKEN}` }

async function post(path, body) {
  const r = await fetch(base + path, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}
async function get(path) {
  const r = await fetch(base + path, { headers: auth })
  return { status: r.status, body: await r.json().catch(() => null) }
}
const runCount = () => mod.db.prepare('SELECT COUNT(*) AS n FROM automation_runs').get().n

let seq = 0
/**
 * `makeSchedule` 默认**带** payload —— 即"到点要建一张可领的任务卡"。
 *
 * 把它作为默认是有意的：不带 payload 的计划（纯提醒型）是**例外**，
 * 而它自己有一条用例（④b）专门盯着"不许建占位任务"。
 * 反过来把"不建任务"做成默认，会让绝大多数计划到点后什么也不发生，
 * 而那种"沉默"正是本组用例要防的东西。
 */
const PAYLOAD = Object.freeze({ title: '计划触发的巡检', description: '由计划自动创建', role: 'soldier', priority: 'medium' })

async function makeSchedule(overrides = {}) {
  seq += 1
  const id = `sched-${seq}`
  const r = await post('/api/automation/schedules', {
    id, scope: 'software', name: `计划 ${seq}`,
    spec: { kind: 'daily', hour: 9, minute: 0 }, timezone: TZ,
    // 标题带 id，避免多条计划的卡在 `tasks` 里同名而互相干扰断言。
    payload: { ...PAYLOAD, title: `${PAYLOAD.title} ${id}` },
    ...overrides,
  })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  return r.body.schedule
}

test('① ★ `GET /api/automation/calendar` 是纯投影：打 50 次，运行表一行都不多', async () => {
  const s = await makeSchedule()
  assert.equal(runCount(), 0)
  const from = Date.now()
  for (let i = 0; i < 50; i += 1) {
    const r = await get(`/api/automation/calendar?id=${s.id}&fromMs=${from}&toMs=${from + 30 * 24 * 3600 * 1000}`)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.projected, true, '投影端点没有声明 projected —— 读的人分不出"算出来的"与"真跑过的"')
    assert.ok(r.body.occurrences.length >= 29 && r.body.occurrences.length <= 31, `投影出 ${r.body.occurrences.length} 个`)
  }
  assert.equal(runCount(), 0,
    '翻日历产生了运行行 —— 一个"把视图当成计划"的日历，会让"上个月跑了 400 次"里'
    + '有 380 次是**有人翻过日历**')
})

test('② 投影端点：未知计划 404 + 具名码；坏窗口 400；缺 id 400', async () => {
  const none = await get('/api/automation/calendar?id=nope')
  assert.equal(none.status, 404)
  assert.equal(none.body.code, 'SCHEDULE_NOT_FOUND')
  const noId = await get('/api/automation/calendar')
  assert.equal(noId.status, 400)
  assert.equal(noId.body.code, 'MISSING_PARAM')
  const s = await makeSchedule()
  const badWindow = await get(`/api/automation/calendar?id=${s.id}&fromMs=100&toMs=100`)
  assert.equal(badWindow.status, 400)
  assert.equal(badWindow.body.code, 'BAD_CALENDAR_WINDOW')
})

test('③ 建计划：时区写错被**具名拒绝**（不静默回落服务器时区）', async () => {
  const r = await post('/api/automation/schedules', {
    id: 'sched-badtz', scope: 'software', name: 'x',
    spec: { kind: 'daily', hour: 9, minute: 0 }, timezone: 'Asia/Shangai',
  })
  assert.equal(r.status, 400, JSON.stringify(r.body))
  assert.equal(r.body.code, 'BAD_TIMEZONE')
  // 反向对照：库里没有留下任何一行。
  assert.equal(mod.db.prepare("SELECT COUNT(*) AS n FROM automation_schedules WHERE id = 'sched-badtz'").get().n, 0)
})

test('④ ★ tick 物化 + skip-on-overlap 走真 HTTP，并且**与定时器共用同一个函数**', async () => {
  const s = await makeSchedule({ spec: { kind: 'interval', everyMs: 60_000 }, overlapPolicy: 'skip' })
  // 用接口把"现在"拨到下一次到点之后：`nowMs` 是显式入参，
  // 而不是读服务器时钟——一条依赖真实时间的用例会在某天凌晨偶发失败。
  const at = s.nextRunAtMs + 1000
  const first = await post('/api/automation/tick', { nowMs: at })
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.ok, true)
  const made = first.body.results.find((x) => x.action === 'materialized')
  assert.ok(made !== undefined, `没物化：${JSON.stringify(first.body.results)}`)
  // ★ `wired: true` 的含义是"物化出来的运行**有机会**被执行"，
  //   不是"它们都跑起来了"——真正的执行仍要 worker 去认领那些任务。
  assert.equal(first.body.wired, true,
    'tick 没有接线 —— 物化出来的运行是 scheduled，而没有任何东西会去跑它们：'
    + '一个"记录了一堆没人执行的运行"的日历与一个真正的调度器，'
    + '在运行历史里长得一样，都是每天一行')
  assert.equal(first.body.tasksCreated, 1,
    '这条计划配了 payload，物化时应该建出恰好一张任务卡')
  // ★ 运行行必须被追到那张具体的任务卡上（`task_id`）。
  assert.ok(made.taskId === undefined || made.taskId === null || typeof made.taskId === 'string')
  const boundRun = mod.db.prepare('SELECT task_id AS t FROM automation_runs WHERE id = ?').get(made.runId)
  assert.ok(typeof boundRun.t === 'string' && boundRun.t.length > 0,
    '运行行没有 task_id —— 这张卡从"计划触发"来的这件事在任务上没有任何痕迹')
  const task = mod.db.prepare('SELECT * FROM tasks WHERE id = ?').get(boundRun.t)
  assert.ok(task !== undefined, 'task_id 指向了一张不存在的任务卡')
  assert.equal(task.status, 'todo', '计划建出来的任务必须是**可领取**的（todo），否则 worker 永远看不到它')
  assert.equal(task.scope, s.scope, '任务的 scope 必须取**计划的** scope')
  assert.equal(task.title, `${PAYLOAD.title} ${s.id}`, '任务标题没有用计划里的 payload')
  // ★ 幂等：再 tick 一次（同一个时刻）不会建出第二张卡。
  const again = await post('/api/automation/tick', { nowMs: at })
  assert.equal(again.body.tasksCreated, 0,
    '重复 tick 又建了一张卡 —— 物化是幂等的，建任务也必须幂等')
  assert.equal(mod.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE title = ?').get(`${PAYLOAD.title} ${s.id}`).n, 1)

  // 让它变成 running（占住这条计划），再 tick 一次 → 应该 skip + 留行。
  mod.db.prepare("UPDATE automation_runs SET state = 'running' WHERE id = ?").run(made.runId)
  const after = mod.db.prepare('SELECT next_run_at_ms AS n FROM automation_schedules WHERE id = ?').get(s.id).n
  const second = await post('/api/automation/tick', { nowMs: after + 1000 })
  assert.equal(second.body.results[0].action, 'skipped-overlap')
  const skipped = await get(`/api/automation/runs?scheduleId=${s.id}&state=skipped`)
  assert.equal(skipped.body.runs.length, 1)
  assert.equal(skipped.body.runs[0].skipReason, 'overlap',
    '重叠时没有留下原因 —— "它没被触发"与"它被跳过了"在历史里长得一样')

  // ★ 结构级对照：定时器与路由必须走同一个函数。
  const src = readFileSync(join(HERE, 'server.mjs'), 'utf8')
  assert.match(src, /setInterval\(\(\) => \{ automationTick\(\) \}, 30000\)\.unref\(\)/,
    'isMain 下没有调度定时器 —— 计划到点后没有任何人会去物化它，'
    + '而"有没有人打开页面"不能是那个条件')
  assert.match(src, /automationStore\.materializeDue/, '没有调用仓储的物化入口')
  // ★ 建任务必须走 `createTask()` 那个**唯一**的对外入口，不许自己拼 INSERT。
  //   任务的验收标准、目标归属、状态词表校验都在那里；绕过它去写
  //   `tasks` 表就是让第二份校验规则开始漂移。
  const tickFn = src.slice(src.indexOf('function automationTick'), src.indexOf('function automationTick') + 3000)
  assert.match(tickFn, /createTask\(\{/, 'automationTick 没有通过 createTask() 建任务')
  assert.equal(/INSERT\s+INTO\s+tasks/i.test(tickFn), false,
    'automationTick 自己拼了 INSERT INTO tasks —— 第二份校验规则会开始漂移')
})

test('④b ★ 没配 payload 的计划只物化、**不建占位任务**（纯提醒型是合法用法）', async () => {
  const s = await post('/api/automation/schedules', {
    id: 'sched-nopayload', scope: 'software', name: '只提醒',
    spec: { kind: 'interval', everyMs: 60_000 }, timezone: 'UTC',
    // 刻意不给 payload
  })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  assert.equal(s.body.schedule.payload, null, '没给 payload 却造出了一个模板')
  const before = mod.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n
  const t = await post('/api/automation/tick', { nowMs: s.body.schedule.nextRunAtMs + 1000 })
  assert.equal(t.body.ok, true)
  const made = t.body.results.find((x) => x.action === 'materialized' && x.scheduleId === 'sched-nopayload')
  assert.ok(made !== undefined, '这条计划没有被物化')
  assert.equal(t.body.tasksCreated, 0, '没配 payload 的计划建出了任务')
  assert.equal(mod.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, before,
    '建了一个标题为空的占位任务 —— worker 领到它只能靠猜，'
    + '而"计划没配 payload"与"计划配了一个空任务"在任务板上同形')
})

test('④c ★ payload 非法在**建计划时**就被具名拒绝（不留孤儿运行行）', async () => {
  const bad = await post('/api/automation/schedules', {
    id: 'sched-badpayload', scope: 'software', name: 'x',
    spec: { kind: 'interval', everyMs: 60_000 }, timezone: 'UTC',
    payload: { title: '   ' },   // 空标题
  })
  assert.equal(bad.status, 400, JSON.stringify(bad.body))
  assert.equal(bad.body.code, 'BAD_SCHEDULE_PAYLOAD')
  assert.equal(mod.db.prepare("SELECT COUNT(*) AS n FROM automation_schedules WHERE id = 'sched-badpayload'").get().n, 0,
    '坏模板的计划被建出来了 —— 到点后它会物化出一批永远建不出任务的孤儿运行行')
  // 未知键被**丢掉并报出来**，不做 payload 透传。
  const dropped = await post('/api/automation/schedules', {
    id: 'sched-drop', scope: 'software', name: 'y',
    spec: { kind: 'interval', everyMs: 60_000 }, timezone: 'UTC',
    payload: { title: 'ok', status: 'done', evil: true },
  })
  assert.equal(dropped.status, 200, JSON.stringify(dropped.body))
  assert.deepEqual(dropped.body.schedule.payload.droppedKeys.sort(), ['evil', 'status'],
    '未知键既没有生效也没有被报出来 —— payload 透传会开一条绕过建任务入口的路'
    + '（`payload.status="done"` 会直接写进任务行，跳过后面的状态校验）')
  assert.equal(dropped.body.schedule.payload.status, undefined)
})

test('⑤ 运行历史与汇总走真 HTTP，含未登记状态', async () => {
  const all = await get('/api/automation/runs')
  assert.equal(all.status, 200)
  assert.ok(Array.isArray(all.body.runs))
  assert.ok(all.body.runs.length >= 2)

  let sum = await get('/api/automation/summary')
  assert.equal(sum.status, 200)
  for (const s of ['scheduled', 'running', 'awaiting-approval', 'completed', 'failed', 'skipped', 'cancelled']) {
    assert.equal(typeof sum.body.byState[s], 'number', `汇总里缺 ${s}`)
  }
  assert.equal(typeof sum.body.overdue, 'number', 'overdue 不在汇总里 —— 它是"调度循环没在跑"的唯一证据')

  // 塞一行坏状态：`settled` 必须变 false（只按已知终态判定会让它读成"全都安定"）。
  mod.db.prepare(
    `INSERT INTO automation_runs (id, schedule_id, scope, planned_at_ms, state, created_at_ms, updated_at_ms)
     VALUES ('bad:http', 'sched-bad', 'software', 1, 'mutated', 0, 0)`,
  ).run()
  sum = await get('/api/automation/summary')
  assert.deepEqual([...sum.body.unrecognizedStates], ['mutated'])
  assert.equal(sum.body.settled, false)
  mod.db.prepare("DELETE FROM automation_runs WHERE id = 'bad:http'").run()
})

test('⑥ 改计划：停用后不再被物化；策略非法被具名拒绝', async () => {
  const s = await makeSchedule({ spec: { kind: 'interval', everyMs: 60_000 } })
  const off = await post('/api/automation/schedules/update', { id: s.id, enabled: false })
  assert.equal(off.status, 200)
  assert.equal(off.body.schedule.enabled, false)
  assert.equal(off.body.schedule.nextRunAtMs, null,
    '停用了但 next_run_at_ms 还在 —— 一个已经不算数的到点时刻会让扫描一直看见它')
  // ★ 断言必须**按这条计划**数，不能数全表：tick 会把**所有**到点的计划
  //   一起物化，而本文件前面几条用例建的计划在"10 天后"同样到点。
  //   数全表时，"这条停用的计划被物化了"会因为**别人的**计划而红，
  //   而红的位置指向一个与真实原因无关的地方。
  const runsFor = (id) => mod.db.prepare('SELECT COUNT(*) AS n FROM automation_runs WHERE schedule_id = ?').get(id).n
  const before = runsFor(s.id)
  const tick = await post('/api/automation/tick', { nowMs: Date.now() + 10 * 24 * 3600 * 1000 })
  assert.equal(tick.status, 200)
  assert.equal(runsFor(s.id), before, '停用的计划被物化了')

  const bad = await post('/api/automation/schedules/update', { id: s.id, overlapPolicy: 'whatever' })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.code, 'BAD_OVERLAP_POLICY')

  const unknown = await post('/api/automation/schedules/update', { id: 'nope' })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.body.code, 'SCHEDULE_NOT_FOUND')
})

test('⑦ 未授权一律 401（读面也不例外）', async () => {
  for (const path of ['/api/automation/summary', '/api/automation/schedules', '/api/automation/runs', '/api/automation/calendar?id=x']) {
    const r = await fetch(base + path)
    assert.equal(r.status, 401, `${path} 没有鉴权`)
  }
  const p = await fetch(base + '/api/automation/tick', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(p.status, 401)
})
