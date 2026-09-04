// team-hub/calendar.test.mjs — 日程日历「事件」契约测试（对齐 docs/TEST_CASES.md TC-S5-01..12 / TASK_BREAKDOWN S5，R-B1 数据面）。
// 运行：node team-hub/calendar.test.mjs（沙箱 spawn 受限时直跑等效；宿主环境可 node --test team-hub/calendar.test.mjs）
// 通过 TEAM_HUB_DB 指向临时库，动态 import server.mjs（import 不占端口，见 isMain 守卫）；
// HTTP 路由层用例把导出的 server 绑定 127.0.0.1 随机端口（files-api.test.mjs 同法），覆盖 GET/POST 契约、400 语义、SSE 广播。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as httpMod from 'node:http'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-cal-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let mod
let dbFile
let base = ''
const openCollectors = []

before(async () => {
  dbFile = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_DB = dbFile
  mod = await import('./server.mjs')
  // 进程内 HTTP 路由：监听随机端口（不 spawn、不占固定端口）
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
})

after(() => {
  for (const req of openCollectors) { try { req.destroy() } catch { /* 已关闭 */ } }
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close() } catch { /* 已关闭 */ }
  try { mod?.db?.close() } catch { /* 已关闭 */ }
  rmSync(tmpRoot, { recursive: true, force: true })
})

/** HTTP 助手：返回 { status, json, text }。 */
async function httpJson(method, path, { body, headers = {} } = {}) {
  const init = { method, headers }
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body)
  const res = await fetch(base + path, init)
  const text = await res.text()
  let json = null
  try { json = text.length > 0 ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}
const post = (path, body) => httpJson('POST', path, { body, headers: { 'content-type': 'application/json' } })
const get = (path) => httpJson('GET', path)

/** 审计快照（action 过滤），供 calendar:* 留痕形状断言。 */
function auditRows(actionPrefix) {
  return mod.db.prepare('SELECT seq, member, scope, action, taskId, detail FROM audit ORDER BY seq ASC').all()
    .filter(r => actionPrefix === undefined || r.action.startsWith(actionPrefix))
    .map(r => ({ ...r, detail: JSON.parse(r.detail) }))
}
const calCount = () => mod.db.prepare("SELECT COUNT(*) AS c FROM audit WHERE action LIKE 'calendar:%'").get().c
const eventCount = () => mod.db.prepare('SELECT COUNT(*) AS c FROM calendar_events').get().c

/** 创建事件（HTTP POST /api/calendar/events，断言 200 + 返回事件体）。 */
async function postEvent(body) {
  const r = await post('/api/calendar/events', body)
  assert.equal(r.status, 200, 'POST /api/calendar/events 200：' + r.text)
  assert.equal(r.json.ok, true)
  assert.ok(r.json.task && typeof r.json.task.id === 'number', 'handleWrite 信封 {ok,task}，事件在 task 下')
  return r.json.task
}

/** SSE 订阅收集器：连接后忽略旧回放，等匹配 live 帧（≤5s）。 */
function sseCollector() {
  const seen = []
  let closed = false
  const req = httpMod.get(base + '/api/events', (res) => {
    let buf = ''
    res.on('data', (d) => {
      buf += d.toString()
      const frames = buf.split('\n\n')
      buf = frames.pop()
      for (const f of frames) {
        const m = /^data: (.+)$/m.exec(f)
        if (!m) continue
        try { const ev = JSON.parse(m[1]); if (ev && ev.action) seen.push(ev) } catch { /* 忽略 */ }
      }
    })
  })
  req.on('error', () => { closed = true })
  openCollectors.push(req)
  return {
    seen,
    waitFor(pred, timeoutMs = 5000) {
      return new Promise((resolve) => {
        const t0 = Date.now()
        const tick = () => {
          const hit = seen.find(pred)
          if (hit) return resolve(hit)
          if (Date.now() - t0 > timeoutMs) return resolve(null)
          setTimeout(tick, 25)
        }
        tick()
      })
    },
    close() { if (!closed) { try { req.destroy() } catch { /* 已关闭 */ } } },
  }
}

describe('TC-S5-01/09 calendar_events 建表幂等 + 旧库自动建表', () => {
  it('TC-S5-01 新库 import 后表与索引存在；同库二次 import 幂等不报错', async () => {
    const tables = mod.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name)
    assert.ok(tables.includes('calendar_events'), '自动建 calendar_events 表')
    const cols = mod.db.prepare('PRAGMA table_info(calendar_events)').all().map(c => c.name)
    for (const c of ['id', 'scope', 'title', 'start', 'end', 'all_day', 'meta', 'createdAt', 'updatedAt']) assert.ok(cols.includes(c), '列 ' + c)
    const idx = mod.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='calendar_events'").all().map(i => i.name)
    assert.ok(idx.includes('idx_calendar_scope_start'), 'scope+start 索引存在')
    // 同库二次 import（server.mjs 模块级 CREATE TABLE IF NOT EXISTS 幂等）：
    // 只断言结构（不写 audit——seq 为单写实例游标，避免同文件双写实例游标冲突，chat.test 迁移用例同法用独立库文件）
    const m2 = await import('./server.mjs?same-db=' + Date.now())
    assert.ok(m2.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='calendar_events'").get(), '再 import 后表仍在')
    const m2cols = m2.db.prepare('PRAGMA table_info(calendar_events)').all().map(c => c.name)
    assert.ok(m2cols.includes('title') && m2cols.includes('start'), '再 import 结构完整')
    m2.db.close()
  })

  it('TC-S5-09 旧库（tasks/skills/chat 存量、无 calendar 表）import 自动建表且事件可用、存量无损', async () => {
    const oldFile = join(tmpRoot, 'old-team.db')
    const old = new DatabaseSync(oldFile)
    old.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT DEFAULT '', acceptance TEXT DEFAULT '[]', boundary TEXT DEFAULT '[]', priority TEXT DEFAULT 'medium', status TEXT NOT NULL DEFAULT 'backlog', version INTEGER NOT NULL DEFAULT 1, soldier TEXT, scope TEXT DEFAULT 'default', comments TEXT DEFAULT '[]', evidence TEXT DEFAULT '[]', patches TEXT DEFAULT '[]', createdAt TEXT, updatedAt TEXT)")
    old.prepare('INSERT INTO tasks (id, title, status, scope, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)')
      .run('T-OLD', '存量任务', 'todo', 'software', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    old.exec("CREATE TABLE skills (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', prompt TEXT DEFAULT '', scope TEXT DEFAULT 'default', owner TEXT, grants TEXT DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1, status TEXT DEFAULT 'pending', contentHash TEXT DEFAULT '', reviewedAt TEXT, createdAt TEXT, updatedAt TEXT)")
    old.prepare('INSERT INTO skills (id, name, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)')
      .run('legacy', '存量技能', 'published', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    old.exec("CREATE TABLE conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL DEFAULT 'default', title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'space', participants TEXT DEFAULT '[]', createdAt TEXT, updatedAt TEXT, last_message_at TEXT)")
    old.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conv_id INTEGER NOT NULL, scope TEXT NOT NULL DEFAULT 'default', author TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text', body TEXT NOT NULL, meta TEXT DEFAULT '{}', client_ts TEXT, createdAt TEXT)")
    old.prepare('INSERT INTO conversations (scope, title, kind, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)')
      .run('software', '存量会话', 'space', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    old.close()

    process.env.TEAM_HUB_DB = oldFile
    const m2 = await import('./server.mjs?migration=' + Date.now())
    const tables = m2.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name)
    assert.ok(tables.includes('calendar_events'), '旧库 import 自动建 calendar_events 表')
    const ev = m2.createCalendarEvent({ scope: 'software', title: '迁移后新事件', start: '2026-08-21T09:30', by: 'general' })
    assert.equal(ev.title, '迁移后新事件')
    const list = m2.listCalendarEvents({ scope: 'software', from: '2026-08-20', to: '2026-08-22' })
    assert.equal(list.length, 1)
    assert.equal(m2.db.prepare("SELECT title FROM tasks WHERE id = 'T-OLD'").get().title, '存量任务')
    assert.equal(m2.getSkill('legacy').status, 'published')
    assert.equal(m2.db.prepare('SELECT COUNT(*) AS c FROM conversations').get().c, 1, 'chat 存量数据无损')
    m2.db.close()
  })
})

describe('TC-S5-02 POST 创建 → 200 字段形状 + 落库 + audit calendar:create', () => {
  it('创建合法事件 → 200 事件含 id/scope/title/start/end=null/allDay=false/createdAt/updatedAt；库中可查；audit 形状正确', async () => {
    const beforeAudit = calCount()
    const ev = await postEvent({ scope: 'software', title: '评审会', start: '2026-08-20T10:00', by: 'general' })
    assert.equal(typeof ev.id, 'number')
    assert.equal(ev.scope, 'software')
    assert.equal(ev.title, '评审会')
    assert.equal(ev.start, '2026-08-20T10:00')
    assert.equal(ev.end, null)
    assert.equal(ev.allDay, false)
    assert.ok(ev.createdAt && ev.updatedAt, 'createdAt/updatedAt 有值')
    assert.deepEqual(ev.meta, {}, 'meta 默认空对象')
    const row = mod.db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(ev.id)
    assert.ok(row && row.title === '评审会' && row.scope === 'software', '事件落库')
    const calRows = auditRows('calendar:').filter(r => r.seq > beforeAudit)
    assert.equal(calRows.length, 1, '恰新增一条 calendar:* 审计')
    assert.equal(calRows[0].action, 'calendar:create')
    assert.equal(calRows[0].member, 'general')
    assert.equal(calRows[0].scope, 'software')
    assert.equal(calRows[0].taskId, null)
    assert.equal(calRows[0].detail.event, ev.id)
    assert.equal(calRows[0].detail.title, '评审会')
  })
})

describe('TC-S5-03 scope 过滤 + 日期窗闭区间 + 排序', () => {
  it('GET /api/calendar/events?scope=&from=&to= 仅该 scope + 窗内闭区间 + start asc 稳定排序', async () => {
    const S = 's5-03'
    await postEvent({ scope: S, title: 'd-01', start: '2026-07-01T09:00', by: 'general' })
    await postEvent({ scope: S, title: 'a-05', start: '2026-07-05T09:00', by: 'general' })
    await postEvent({ scope: S, title: 'c-05b', start: '2026-07-05T10:00', by: 'general' })
    await postEvent({ scope: S, title: 'e-31', start: '2026-07-31T09:00', by: 'general' })
    await postEvent({ scope: 'other-scope', title: '外部事件', start: '2026-07-06T09:00', by: 'general' })
    const all = await get('/api/calendar/events?scope=' + S)
    assert.equal(all.status, 200)
    assert.equal(all.json.scope, S)
    assert.ok(all.json.events.every(e => e.scope === S), 'scope 过滤：仅 S 事件')
    assert.ok(!all.json.events.some(e => e.title === '外部事件'), '不含其它 scope 事件')
    assert.equal(all.json.events.length, 4)
    const win = await get('/api/calendar/events?scope=' + S + '&from=2026-07-05&to=2026-07-10')
    assert.deepEqual(win.json.events.map(e => e.title), ['a-05', 'c-05b'], '日期窗 [07-05,07-10] 含边界、start asc 排序')
  })

  it('同日同 start 的事件按 id asc 稳定排序', async () => {
    const S = 's5-03tie'
    const e1 = await postEvent({ scope: S, title: 'tie-1', start: '2026-07-08T08:00', by: 'general' })
    const e2 = await postEvent({ scope: S, title: 'tie-2', start: '2026-07-08T08:00', by: 'general' })
    const win = await get('/api/calendar/events?scope=' + S)
    assert.deepEqual(win.json.events.map(e => e.id), [e1.id, e2.id].sort((a, b) => a - b), '同 start 按 id 稳定')
  })
})

describe('TC-S5-04 scope 隔离互不可见 + 跨 scope 写不串', () => {
  it('两 scope 各建事件后交叉查询互不可见；事件 scope = 请求 scope', async () => {
    const a = await postEvent({ scope: 's5-04a', title: 'A 空间事件', start: '2026-08-10T09:00', by: 'general' })
    const b = await postEvent({ scope: 's5-04b', title: 'B 空间事件', start: '2026-08-11T09:00', by: 'general' })
    assert.equal(a.scope, 's5-04a')
    assert.equal(b.scope, 's5-04b')
    const la = await get('/api/calendar/events?scope=s5-04a')
    const lb = await get('/api/calendar/events?scope=s5-04b')
    assert.ok(la.json.events.some(e => e.title === 'A 空间事件'))
    assert.ok(!la.json.events.some(e => e.title === 'B 空间事件'), 'A 列表不含 B 事件')
    assert.ok(lb.json.events.some(e => e.title === 'B 空间事件'))
    assert.ok(!lb.json.events.some(e => e.title === 'A 空间事件'), 'B 列表不含 A 事件（反向）')
  })
})

describe('TC-S5-05 非法输入矩阵 → 400 零落库零 audit', () => {
  it('缺 by / title 空 / title 101 / start 缺 / start 非法 / end<start / scope 缺 → 全部 400 且零落库零 calendar 审计', async () => {
    const S = 's5-05'
    const beforeCal = calCount()
    const beforeEv = eventCount()
    const cases = [
      { body: { scope: S, title: 'x', start: '2026-08-20T10:00' }, re: /by/ },                    // ① 缺 by
      { body: { scope: S, title: '   ', start: '2026-08-20T10:00', by: 'general' }, re: /title/ }, // ② title 空
      { body: { scope: S, title: 'a'.repeat(101), start: '2026-08-20T10:00', by: 'general' }, re: /标题过长/ }, // ③ title=101
      { body: { scope: S, title: 'x', by: 'general' }, re: /start/ },                            // ④ start 缺
      { body: { scope: S, title: 'x', start: '2026-13-99', by: 'general' }, re: /start/ },        // ⑤ 月份非法
      { body: { scope: S, title: 'x', start: 'garbage', by: 'general' }, re: /start/ },           // ⑤ 完全非法
      { body: { scope: S, title: 'x', start: '2026-08-20T10:00', end: '2026-08-19T09:00', by: 'general' }, re: /end/ }, // ⑥ end<start
      { body: { title: 'x', start: '2026-08-20T10:00', by: 'general' }, re: /scope/ },            // ⑦ scope 缺
      { body: { scope: 42, title: 'x', start: '2026-08-20T10:00', by: 'general' }, re: /scope/ }, // ⑦ scope 非字符串
    ]
    for (const c of cases) {
      const r = await post('/api/calendar/events', c.body)
      assert.equal(r.status, 400, '400 for ' + JSON.stringify(c.body))
      assert.ok(r.json && r.json.error, '错误信息可读')
      assert.ok(c.re.test(r.json.error), '错误指明字段：' + r.json.error + ' (期望 ' + c.re + ')')
    }
    assert.equal(eventCount(), beforeEv, '零落库')
    assert.equal(calCount(), beforeCal, '无 calendar:* 审计新增')
  })
})

describe('TC-S5-06 日期窗边界 + allDay date-only', () => {
  it('start 恰在 from/to / 前一日 / 后一日 / allDay date-only → 闭区间正确', async () => {
    const S = 's5-06'
    await postEvent({ scope: S, title: '边界-前一日', start: '2026-08-19T23:59', by: 'general' })
    await postEvent({ scope: S, title: '边界-起日', start: '2026-08-20T00:00', by: 'general' })
    await postEvent({ scope: S, title: '全天-0821', start: '2026-08-21', allDay: true, by: 'general' })
    await postEvent({ scope: S, title: '边界-终日', start: '2026-08-26T23:59', by: 'general' })
    await postEvent({ scope: S, title: '边界-后一日', start: '2026-08-27T00:00', by: 'general' })
    const win = await get('/api/calendar/events?scope=' + S + '&from=2026-08-20&to=2026-08-26')
    const titles = win.json.events.map(e => e.title)
    assert.deepEqual(new Set(titles), new Set(['边界-起日', '全天-0821', '边界-终日']), '闭区间含 20/21(allDay)/26，不含 19/27')
    const allDay = win.json.events.find(e => e.title === '全天-0821')
    assert.equal(allDay.allDay, true)
    assert.equal(allDay.end, null)
  })
})

describe('TC-S5-07 删除契约：confirm / scope 越权 / 成功 + audit calendar:delete', () => {
  it('缺 confirm / confirm 非 yes / scope 越权 / 未知 id → 400 且事件仍在；confirm=yes + scope 匹配 → 200 且 audit', async () => {
    const S = 's5-07'
    const ev = await postEvent({ scope: S, title: '待删事件', start: '2026-08-25T14:00', by: 'general' })
    const del = (body) => post('/api/calendar/events/delete', body)
    // ① 缺 confirm
    const r1 = await del({ id: ev.id, scope: S, by: 'general' })
    assert.equal(r1.status, 400)
    assert.ok(/confirm/.test(r1.json.error))
    // ② confirm 非 yes
    const r2 = await del({ id: ev.id, scope: S, confirm: 'nope', by: 'general' })
    assert.equal(r2.status, 400)
    assert.ok(/confirm/.test(r2.json.error))
    // ③ scope 越权（事件属 S，用别的 scope 删）
    const r3 = await del({ id: ev.id, scope: 'marketing', confirm: 'yes', by: 'general' })
    assert.equal(r3.status, 400)
    assert.ok(/越权/.test(r3.json.error))
    // ③b 未知 id
    const r4 = await del({ id: 999999, scope: S, confirm: 'yes', by: 'general' })
    assert.equal(r4.status, 400)
    assert.ok(/事件不存在/.test(r4.json.error))
    // 事件仍在（①②③ 均零副作用）
    const still = await get('/api/calendar/events?scope=' + S)
    assert.ok(still.json.events.some(e => e.id === ev.id), '拒绝后事件仍在')
    const beforeAudit = calCount()
    // ④ 合法删除
    const ok = await del({ id: ev.id, scope: S, confirm: 'yes', by: 'general' })
    assert.equal(ok.status, 200)
    assert.equal(ok.json.task.deleted, true)
    assert.equal(ok.json.task.event, ev.id)
    const after = await get('/api/calendar/events?scope=' + S)
    assert.ok(!after.json.events.some(e => e.id === ev.id), '删除后列表不含该事件')
    const calRows = auditRows('calendar:').filter(r => r.seq > beforeAudit)
    assert.equal(calRows.length, 1)
    assert.equal(calRows[0].action, 'calendar:delete')
    assert.equal(calRows[0].member, 'general')
    assert.equal(calRows[0].scope, S)
    assert.equal(calRows[0].detail.event, ev.id)
  })
})

describe('TC-S5-08 写走 handleWrite：audit 经 /api/activity 可查 + SSE /api/events 广播', () => {
  it('订阅 /api/events 期间 POST 创建 → ≤5s 收到 calendar:create live 帧；GET /api/activity?scope= 可查 calendar:*', async () => {
    const S = 's5-08'
    const marker = 'SSE-' + Date.now()
    const collector = sseCollector()
    try {
      const ev = await postEvent({ scope: S, title: marker, start: '2026-08-22T08:00', by: 'general' })
      const live = await collector.waitFor((e) => e.action === 'calendar:create' && e.member === 'general' && e.detail && e.detail.title === marker)
      assert.ok(live, '≤5s 收到 SSE calendar:create 帧')
      assert.equal(live.scope, S)
      assert.equal(live.detail.event, ev.id)
      // /api/activity?scope= 可查 calendar:* 审计（curl 冒烟同口径）
      const act = await get('/api/activity?scope=' + S)
      assert.equal(act.status, 200)
      assert.ok(act.json.some(r => r.action === 'calendar:create' && r.member === 'general' && r.detail && r.detail.title === marker), '/api/activity?scope= 含 calendar:create')
      // 删除也走 handleWrite → SSE calendar:delete + activity 可查
      const collector2 = sseCollector()
      try {
        const d = await post('/api/calendar/events/delete', { id: ev.id, scope: S, confirm: 'yes', by: 'general' })
        assert.equal(d.status, 200)
        const liveDel = await collector2.waitFor((e) => e.action === 'calendar:delete' && e.detail && e.detail.event === ev.id)
        assert.ok(liveDel, '≤5s 收到 SSE calendar:delete 帧')
        const act2 = await get('/api/activity?scope=' + S)
        assert.ok(act2.json.some(r => r.action === 'calendar:delete' && r.detail && r.detail.event === ev.id), '/api/activity?scope= 含 calendar:delete')
      } finally { collector2.close() }
    } finally { collector.close() }
  })
})

describe('TC-S5-11 合法边界：title 恰 100 / end 省略 / allDay / end=start / meta', () => {
  it('title=100 恰好 200；end 可省=null；allDay:true 存 1 返 true；end=start 允许；meta 往返', async () => {
    const S = 's5-11'
    const t100 = await postEvent({ scope: S, title: 'a'.repeat(100), start: '2026-08-23T08:00', by: 'general' })
    assert.equal(t100.title.length, 100)
    const noEnd = await postEvent({ scope: S, title: 'end-省略', start: '2026-08-23T09:00', by: 'general' })
    assert.equal(noEnd.end, null)
    const allDay = await postEvent({ scope: S, title: '全天事件', start: '2026-08-24', allDay: true, by: 'general' })
    assert.equal(allDay.allDay, true)
    assert.equal(allDay.start, '2026-08-24')
    const zero = await postEvent({ scope: S, title: '零长时段', start: '2026-08-25T10:00', end: '2026-08-25T10:00', by: 'general' })
    assert.equal(zero.end, '2026-08-25T10:00', 'end=start 允许（零长时段）')
    const meta = await postEvent({ scope: S, title: '带 meta', start: '2026-08-26T10:00', meta: { source: 'panel', color: 'blue' }, by: 'general' })
    assert.deepEqual(meta.meta, { source: 'panel', color: 'blue' })
    const list = await get('/api/calendar/events?scope=' + S)
    assert.equal(list.json.events.length, 5)
  })
})

describe('DAO 级直测（chat.test.mjs 同法：函数级 create/list/delete/解析）', () => {
  it('createCalendarEvent 校验（缺 by/scope/title/非法时间/超长）与 listCalendarEvents 窗过滤直接可用', () => {
    assert.throws(() => mod.createCalendarEvent({ scope: 'dao', title: 'x', start: '2026-08-20T10:00' }), /缺少操作者身份 by/)
    assert.throws(() => mod.createCalendarEvent({ title: 'x', start: '2026-08-20T10:00', by: 'g' }), /scope/)
    assert.throws(() => mod.createCalendarEvent({ scope: 'dao', title: '', start: '2026-08-20T10:00', by: 'g' }), /title/)
    assert.throws(() => mod.createCalendarEvent({ scope: 'dao', title: 'x', start: '2026-02-30', by: 'g' }), /日期不存在/)
    assert.throws(() => mod.createCalendarEvent({ scope: 'dao', title: 'x', start: '2026-08-20T25:00', by: 'g' }), /小时/)
    assert.equal(mod.MAX_CALENDAR_TITLE, 100)
    const p = mod.parseCalendarTime('2026-08-20', 'start')
    assert.equal(p.date, '2026-08-20')
    assert.equal(p.key, Date.UTC(2026, 7, 20))
    assert.throws(() => mod.parseCalendarTime('2026-8-20', 'start'), /非法/)
  })

  it('listCalendarEvents 参数校验：from 晚于 to / 非法窗参数抛错', () => {
    assert.throws(() => mod.listCalendarEvents({ scope: 'x', from: '2026-09-01', to: '2026-08-01' }), /from 不得晚于 to/)
    assert.throws(() => mod.listCalendarEvents({ scope: 'x', from: 'not-a-date' }), /from/)
    // 合法空窗返回空数组
    assert.deepEqual(mod.listCalendarEvents({ scope: 'dao-empty', from: '2026-01-01', to: '2026-01-02' }), [])
  })
})
