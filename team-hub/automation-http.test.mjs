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

// ══════════════════════════════════════════════════════════════════════════════
// ④ PRT-316 切片 7：automation 族搬进 `routes/automation.mjs` 之后的**缝上契约**
//
// 为什么补：破验 15 条变异，第一轮咬住 10 条、漏网 1 条（另有 3 条锚点写错）。
//
//   ★★ 漏网的那条是**真缺口**，而且缺口很具体：
//      「`calendar` 从纯投影变成顺手落库（改成调 `automationTick`）」没被咬住。
//
//      既有用例 ① 确实盯着这条性质（"打 50 次，运行表一行都不多"），
//      但它用的计划是 `{ kind: 'daily', hour: 9, minute: 0 }` ——
//      它的 `nextRunAtMs` 在**未来**，于是 `materializeDue({ nowMs: Date.now() })`
//      **什么都不物化**。那一次 tick 是个**空操作**。
//
//      > 一个"从不写库的投影"，与一个"每次都调一次写库、只是恰好没东西可写"的投影，
//      > 在测试用的那条计划**不在点**的时候是同一个东西。
//
//      ⇒ 判据不能再依赖"这条计划恰好在不在点"，而要**直接问**：
//        "这一条路由碰过任何写方法吗？"—— 用注入桩问，与计划到不到点无关。
//
//   ▲ 三条锚点写错（K5/K6/K7 的 `authorized` 护栏）：生成器把体整体缩进 +2，
//     我按原文的 6 空格缩进写的锚点全部失配。教训与切片 6 的 K6 同一条：
//     报"锚点没命中"与报"漏网"退出码相同、含义相反 —— 都**不算**测过。
//
// ▲ 既有 9 例仍在**真 hub** 上验（不替换、不删除）。
// ▲ 追加而非新建文件：`git ls-files "*.test.mjs"` 的条数被 `boundary-facts` 钉着。
// ══════════════════════════════════════════════════════════════════════════════

import { createAutomationRoutes } from './routes/automation.mjs'

/** 会记录调用的假 `automationStore` + 假 `automationTick`。 */
function autoSpy(over = {}) {
  const calls = []
  const SCHED = { id: 's1', scope: 'software', spec: { kind: 'daily', hour: 9, minute: 0 }, nextRunAtMs: 1, enabled: true }
  const store = {
    summary: (a) => { calls.push(['summary', a]); return { schedules: 0 } },
    listSchedules: (a) => { calls.push(['listSchedules', a]); return [] },
    createSchedule: (a) => { calls.push(['createSchedule', a]); return { ...SCHED, id: a.id } },
    updateSchedule: (a) => { calls.push(['updateSchedule', a]); return SCHED },
    scheduleOf: (id) => { calls.push(['scheduleOf', id]); return id === 'nope' ? null : SCHED },
    runsOf: (a) => { calls.push(['runsOf', a]); return [] },
    // 写方法（投影端点一个都不许碰）
    materializeDue: (a) => { calls.push(['materializeDue', a]); return { ok: true, results: [] } },
  }
  Object.assign(store, over.store ?? {})
  const sent = []
  const deps = {
    json: (_res, code, obj) => { sent.push([code, obj]) },
    authorized: () => true,
    handleRun: async (_req, _res, fn) => {
      const out = await fn({ id: 's1', scope: 'software', name: 'n', timezone: 'UTC', by: 'me' }, 'me')
      sent.push([200, out])
      return out
    },
    requireString: (b, k) => {
      const v = b?.[k]
      if (typeof v !== 'string' || v.trim() === '') { const e = new Error(`缺少参数 ${k}`); e.code = 'MISSING_PARAM'; throw e }
      return v
    },
    automationStore: store,
    projectOccurrences: (sched, o) => { calls.push(['projectOccurrences', o]); return [{ atMs: 1 }] },
    automationTick: (a) => { calls.push(['automationTick', a]); return { ok: true, results: [], wired: true, tasksCreated: 0 } },
    AUTOMATION_ERRORS: { SCHEDULE_NOT_FOUND: 'SCHEDULE_NOT_FOUND', BAD_CALENDAR_WINDOW: 'BAD_CALENDAR_WINDOW' },
  }
  Object.assign(deps, over.deps ?? {})
  const fam = createAutomationRoutes(deps)
  const dispatch = (method, target) => {
    const url = new URL(`http://x${target}`)
    return fam.dispatch({ method, headers: {} }, {}, { path: url.pathname, url })
  }
  return { dispatch, calls, sent }
}
const names = (calls) => calls.map((c) => c[0])
const last = (calls, n) => calls.filter((c) => c[0] === n).at(-1)

test('④ ★★ K1 的正解：`calendar` 是纯投影 —— 一个**写方法**都不许碰（与计划到不到点无关）', async () => {
  const WRITES = ['materializeDue', 'createSchedule', 'updateSchedule']
  const s = autoSpy()
  assert.equal(await s.dispatch('GET', '/api/automation/calendar?id=s1'), true)
  assert.equal(s.sent.at(-1)?.[0], 200, JSON.stringify(s.sent))
  const touched = names(s.calls).filter((n) => WRITES.includes(n))
  assert.deepEqual(touched, [],
    `投影端点碰了写方法 ${touched.join(',')} —— "日历只做投影"不是风格，是它的判据`)
  // ★ 连 `automationTick` 也不许调：那是"显式物化"的入口，投影不该有它。
  assert.equal(names(s.calls).includes('automationTick'), false,
    '投影端点调了 automationTick —— 它就是那个会落库的门')
  // 正面：它确实去查了计划、确实算了投影（否则"什么都没碰"是空过）
  assert.ok(last(s.calls, 'scheduleOf'), 'calendar 没有查计划')
  assert.ok(last(s.calls, 'projectOccurrences'), 'calendar 没有算投影')
  assert.equal(s.sent.at(-1)[1].projected, true, '投影端点没有声明 projected')
})

test('④ 七条路由各自接到正确的方法上（正向 + 反向：不许串到别的动作）', async () => {
  const table = [
    ['GET', '/api/automation/summary', 'summary'],
    ['GET', '/api/automation/schedules', 'listSchedules'],
    ['POST', '/api/automation/schedules', 'createSchedule'],
    ['POST', '/api/automation/schedules/update', 'updateSchedule'],
    ['GET', '/api/automation/calendar?id=s1', 'scheduleOf'],
    ['GET', '/api/automation/runs', 'runsOf'],
  ]
  for (const [m, p, fn] of table) {
    const s = autoSpy()
    assert.equal(await s.dispatch(m, p), true, `${m} ${p} 没被本族接住`)
    assert.ok(last(s.calls, fn), `${m} ${p} 没有走到 ${fn}（走了 ${names(s.calls).join(',') || '无'}）`)
  }
  // tick 走的是**注入的 `automationTick`**，不是自己再实现一遍物化。
  const t = autoSpy()
  assert.equal(await t.dispatch('POST', '/api/automation/tick'), true)
  assert.ok(last(t.calls, 'automationTick'), 'tick 没有走注入的 automationTick')
  assert.equal(names(t.calls).includes('materializeDue'), false,
    'tick 直接调了 materializeDue —— 那就绕过了"与生产定时器共用同一个函数"')
})

test('④ 四条带 authorized 的路由：未授权 401 且**不查仓储**', async () => {
  for (const p of ['/api/automation/summary', '/api/automation/schedules',
    '/api/automation/calendar?id=s1', '/api/automation/runs']) {
    const s = autoSpy({ deps: { authorized: () => false } })
    assert.equal(await s.dispatch('GET', p), true)
    assert.equal(s.sent.at(-1)?.[0], 401, `${p} 没有 401：${JSON.stringify(s.sent)}`)
    assert.deepEqual(s.calls, [], `${p} 在未授权时仍然查了仓储`)
  }
})

test('④ 两条写路由**不**做 authorized 前置（它们走 handleRun 自己的鉴权）', async () => {
  // 记录既有事实：写路由与其他族一致，鉴权在 `handleRun` 里，不在路由头上。
  // 钉住它是为了区分"我搬错了"与"本来就这样"。
  for (const p of ['/api/automation/schedules', '/api/automation/schedules/update', '/api/automation/tick']) {
    const s = autoSpy({ deps: { authorized: () => false } })
    await s.dispatch('POST', p)
    assert.notEqual(s.sent.at(-1)?.[0], 401, `${p} 在路由头做了 401 —— 与既有语义不符`)
  }
})

test('④ ★ 记录既有不对称：`scope` 与 `enabled` 对**空串**的处理不同（本片不改，只钉住）', async () => {
  // `?scope=` 走 `scope !== null && scope.length > 0 ? scope : null` ⇒ **null**（等于没筛）；
  // `?enabled=` 走 `enabledRaw === null ? null : (enabledRaw === '1' || enabledRaw === 'true')`
  // ⇒ **false**（等于"只看停用的"）。两条判据对"空串"给出了不同的答案。
  //
  // ★ 这是搬运**之前**就有的行为，不是本片引入的。本片只搬路由、不改语义，
  //   所以把它钉成契约 —— 否则下一个人会把 `scope` 的 `length > 0` 顺手复制到 `enabled`，
  //   而那是行为变更（`?enabled=` 会从"只看停用的"变成"不看状态"）。
  const cases = [
    ['', { scope: null, enabled: null }],
    ['?scope=&enabled=', { scope: null, enabled: false }],
    ['?scope=software&enabled=1', { scope: 'software', enabled: true }],
    ['?scope=software&enabled=true', { scope: 'software', enabled: true }],
    ['?scope=software&enabled=0', { scope: 'software', enabled: false }],
    ['?scope=software&enabled=nope', { scope: 'software', enabled: false }],
  ]
  for (const [q, want] of cases) {
    const s = autoSpy()
    await s.dispatch('GET', `/api/automation/schedules${q}`)
    const a = last(s.calls, 'listSchedules')[1]
    assert.equal(a.scope, want.scope, `scope 解析：${q || '(无参)'} 得到 ${JSON.stringify(a.scope)}`)
    assert.equal(a.enabled, want.enabled, `enabled 解析：${q || '(无参)'} 得到 ${JSON.stringify(a.enabled)}`)
  }
  // summary 的 scope 同样是"空串 ⇒ null"
  const sm = autoSpy()
  await sm.dispatch('GET', '/api/automation/summary?scope=')
  assert.equal(last(sm.calls, 'summary')[1].scope, null, 'summary 把空 scope 当成了一个真作用域')
  // ★ runs 的 scheduleId / scope / state 三条也都是"空串 ⇒ null"。
  //   这一条是破验 K15 指出的缺口：原判据只验了"`runsOf` 被调用"，
  //   没验**传进去的是什么** —— 于是 `scheduleId: scheduleId` （不折 null）
  //   照样全绿，而空串会被当成一个真的计划 id 去筛。
  for (const q of ['?scheduleId=&scope=&state=', '']) {
    const rn = autoSpy()
    await rn.dispatch('GET', `/api/automation/runs${q}`)
    const a = last(rn.calls, 'runsOf')[1]
    for (const k of ['scheduleId', 'scope', 'state']) {
      assert.equal(a[k], null, `runs 的 ${k}：${q || '(无参)'} 得到 ${JSON.stringify(a[k])}，应为 null`)
    }
    assert.equal(a.limit, 200, 'runs 的 limit 缺省应为 200')
  }
  const rn2 = autoSpy()
  await rn2.dispatch('GET', '/api/automation/runs?scheduleId=s1&scope=software&state=scheduled&limit=5')
  const a2 = last(rn2.calls, 'runsOf')[1]
  assert.equal(a2.scheduleId, 's1')
  assert.equal(a2.scope, 'software')
  assert.equal(a2.state, 'scheduled')
  assert.equal(a2.limit, 5)
})

test('④ ★ `update` 的 payload 三态：不改 / 显式清掉 / 换掉 —— 三者**必须可分**', async () => {
  // 原文的注释逐字写了这件事：
  //   用 `body.payload ?? null` 会让"清掉"与"不改"同形——用户想把一条计划从
  //   "建任务"改成"只提醒"，调用返回成功，而计划继续建任务。
  const missing = autoSpy()
  await missing.dispatch('POST', '/api/automation/schedules/update')
  assert.equal('payload' in last(missing.calls, 'updateSchedule')[1], false,
    '不传 payload ⇒ 键**不该出现**（出现就等于"清掉"）')
  const cleared = autoSpy()
  await cleared.dispatch('POST', '/api/automation/schedules/update')
  // 桩的 handleRun 给的 body 里没有 payload，所以上面两条都等于"不传"。
  // 显式传 null 的路径用下面的 deps 覆盖来验。
  const withNull = autoSpy({ deps: { handleRun: async (_q, _s, fn) => { const o = await fn({ id: 's1', payload: null }, 'me'); sentPushNull(o) } } })
  function sentPushNull(o) { withNull.sent.push([200, o]) }
  await withNull.dispatch('POST', '/api/automation/schedules/update')
  assert.ok('payload' in last(withNull.calls, 'updateSchedule')[1], '显式 null 没有被当成"清掉"')
  assert.equal(last(withNull.calls, 'updateSchedule')[1].payload, null)
  // 反向控制：`?? null` 那种实现会让"不传"也带上 payload 键
  assert.equal('payload' in last(cleared.calls, 'updateSchedule')[1], false)
})

test('④ ★★ K6/K7 的正解：建计划时**每一个**必填字段都必须过 `requireString`', async () => {
  // 这一条是破验指出来的真缺口：既有用例 ③ 只喂了"时区**值**写错"，
  // 走的是**仓储**的具名拒绝；它从没喂过"时区**整个没给**"。
  // 于是把 `timezone: requireString(body,'timezone')` 改成 `timezone: body.timezone`
  // 之后，`undefined` 被静默交给仓储，而**没有任何用例说过这件事**。
  //
  //   > 一个"字段写错被拒"，与一个"字段没写也被拒"，
  //   > 在用例只喂过前者的时候是同一个东西。
  //
  // 判据：逐个删掉一个必填字段 ⇒ 必须 400 MISSING_PARAM，且**一次仓储调用都不能发生**。
  const REQUIRED = ['id', 'scope', 'name', 'timezone']
  const BASE = { id: 's1', scope: 'software', name: 'n', timezone: 'UTC' }
  for (const drop of REQUIRED) {
    const body = { ...BASE }
    delete body[drop]
    const s = autoSpy({ deps: {
      handleRun: async (_q, _r, fn) => {
        try {
          const out = await fn(body, 'me')
          s.sent.push([200, out])
        } catch (e) {
          s.sent.push([400, { ok: false, error: String(e.message), code: e.code ?? null }])
        }
      },
    } })
    await s.dispatch('POST', '/api/automation/schedules')
    assert.equal(s.sent.at(-1)?.[0], 400, `缺 ${drop} 没有被拒，响应：${JSON.stringify(s.sent.at(-1))}`)
    assert.equal(s.sent.at(-1)[1].code, 'MISSING_PARAM', `缺 ${drop} 的错误码不是 MISSING_PARAM`)
    assert.deepEqual(s.calls, [], `缺 ${drop} 却已经碰了仓储（${names(s.calls).join(',')}）`)
  }
  // ★ 正面控制：四个字段都给的时候必须**建得成**。
  //   没有它，"一律拒绝"也能让上面四条通过。
  const ok = autoSpy()
  await ok.dispatch('POST', '/api/automation/schedules')
  assert.equal(ok.sent.at(-1)?.[0], 200, `四字段齐全却没建成：${JSON.stringify(ok.sent)}`)
  assert.ok(last(ok.calls, 'createSchedule'), '四字段齐全却没调 createSchedule')
  const args = last(ok.calls, 'createSchedule')[1]
  assert.equal(args.id, 's1')
  assert.equal(args.scope, 'software')
  assert.equal(args.name, 'n')
  assert.equal(args.timezone, 'UTC')
  // `enabled` 缺省 ⇒ true（不传即启用）；`enabled: false` ⇒ false
  assert.equal(args.enabled, true, '不传 enabled 时默认值不是 true')
})

test('④ 缺参数走 requireString 的具名拒绝，而不是静默 undefined', async () => {
  const s = autoSpy()
  // 桩的 body 有 id/scope/name/timezone，所以这里要换成缺 name 的
  const bad = autoSpy({ deps: {
    handleRun: async (_q, _r, fn) => {
      try { await fn({ id: 's1', scope: 'software' }, 'me') } catch (e) {
        bad.sent.push([400, { ok: false, code: e.code ?? null }]); return
      }
      bad.sent.push([200, {}])
    },
  } })
  await bad.dispatch('POST', '/api/automation/schedules')
  assert.equal(bad.sent.at(-1)?.[0], 400, '缺 name 没有被拒')
  assert.equal(bad.sent.at(-1)[1].code, 'MISSING_PARAM')
  assert.equal(names(bad.calls).includes('createSchedule'), false, '参数不全却已经建了计划')
  void s
})

test('④ 段的边界：别的命名空间不许被本族吃掉', async () => {
  const s = autoSpy()
  for (const [m, p] of [['GET', '/api/automation'], ['GET', '/api/automationX'],
    ['GET', '/api/automation/schedules/x'], ['DELETE', '/api/automation/schedules']]) {
    assert.equal(await s.dispatch(m, p), false, `${m} ${p} 被本族接住了 —— 它不该归 automation 管`)
  }
})
