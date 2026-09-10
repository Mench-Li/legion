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

// ═══════════════════════════ P2-5 日程日历增强 ═══════════════════════════
// 时间语义 = 字面本地时间（naive local，零时区换算）；重复 = 简单规则（查询侧展开）；
// 关联 = 双向（事件带 taskId/goalId + 反向查询）。见 docs/REMAINING-TASKS.md P2-5。

describe('P2-5-a 重复规则校验与展开（daily/weekly/monthly + interval + until/count + 例外日）', () => {
  it('规则校验：非法 freq/interval/until+count 同给/exdates 形状 → 400 且零副作用', async () => {
    const S = 'p25-a1'
    const beforeEv = eventCount(), beforeCal = calCount()
    const bad = [
      { recurrence: { freq: 'yearly' }, re: /freq/ },
      { recurrence: { freq: 'daily', interval: 0 }, re: /interval/ },
      { recurrence: { freq: 'daily', interval: 1.5 }, re: /interval/ },
      { recurrence: { freq: 'daily', until: '2026-09-30', count: 5 }, re: /until 与 count/ },
      { recurrence: { freq: 'weekly', exdates: 'not-array' }, re: /exdates/ },
      { recurrence: { freq: 'weekly', exdates: ['garbage'] }, re: /exdates/ },
      { recurrence: 'daily', re: /recurrence/ },
    ]
    for (const c of bad) {
      const r = await post('/api/calendar/events', { scope: S, title: 'x', start: '2026-09-01T09:00', recurrence: c.recurrence, by: 'general' })
      assert.equal(r.status, 400, '400 for ' + JSON.stringify(c.recurrence))
      assert.ok(c.re.test(r.json.error), '错误指明字段：' + r.json.error + ' (期望 ' + c.re + ')')
    }
    assert.equal(eventCount(), beforeEv, '非法规则零落库')
    assert.equal(calCount(), beforeCal, '非法规则零 calendar:* 审计')
  })

  it('daily interval=2 + count：窗内展开正确且受 count 上界约束', async () => {
    const S = 'p25-a2'
    const ev = await postEvent({ scope: S, title: '双日站会', start: '2026-09-01T09:30', end: '2026-09-01T09:45', recurrence: { freq: 'daily', interval: 2, count: 4 }, by: 'general' })
    assert.equal(ev.recurrence.freq, 'daily')
    assert.equal(ev.recurrence.count, 4)
    // count=4 → 09-01/03/05/07（只看前 4 次）
    const all = await get('/api/calendar/events?scope=' + S + '&from=2026-09-01&to=2026-09-30')
    assert.deepEqual(all.json.events.map(e => e.occurrenceDate), ['2026-09-01', '2026-09-03', '2026-09-05', '2026-09-07'])
    assert.ok(all.json.events.every(e => e.recurring === true), '实例标 recurring')
    assert.ok(all.json.events.every(e => e.id === ev.id), '同一 id（展开非复制行）')
    // 窄窗只取窗内实例
    const narrow = await get('/api/calendar/events?scope=' + S + '&from=2026-09-04&to=2026-09-06')
    assert.deepEqual(narrow.json.events.map(e => e.occurrenceDate), ['2026-09-05'])
  })

  it('weekly interval=1 + until：窗左侧开始（事件早于窗）仍能命中', async () => {
    const S = 'p25-a3'
    await postEvent({ scope: S, title: '周会', start: '2026-08-03T10:00', recurrence: { freq: 'weekly', until: '2026-08-31' }, by: 'general' })
    // 8-03/10/17/24/31 周一；窗 8-20..8-26 → 只 8-24
    const w = await get('/api/calendar/events?scope=' + S + '&from=2026-08-20&to=2026-08-26')
    assert.deepEqual(w.json.events.map(e => e.occurrenceDate), ['2026-08-24'], '跨窗前的重复事件仍命中（DB 前缀过滤已改为展开后精确过滤）')
    // until 上界：8-31 之后没有
    const after = await get('/api/calendar/events?scope=' + S + '&from=2026-09-01&to=2026-09-30')
    assert.deepEqual(after.json.events, [])
  })

  it('monthly 日钳制：1/31 每月 → 2/28、4/30（不跳过整月）', async () => {
    const S = 'p25-a4'
    await postEvent({ scope: S, title: '月度结账', start: '2026-01-31T18:00', recurrence: { freq: 'monthly', count: 4 }, by: 'general' })
    const r = await get('/api/calendar/events?scope=' + S + '&from=2026-01-01&to=2026-12-31')
    assert.deepEqual(r.json.events.map(e => e.occurrenceDate), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'])
  })

  it('exdates 例外日：展开时跳过；单次删除仅写例外保留整串', async () => {
    const S = 'p25-a5'
    const ev = await postEvent({ scope: S, title: '每日 09:00', start: '2026-09-01T09:00', recurrence: { freq: 'daily', count: 5, exdates: ['2026-09-03'] }, by: 'general' })
    const r1 = await get('/api/calendar/events?scope=' + S + '&from=2026-09-01&to=2026-09-30')
    assert.deepEqual(r1.json.events.map(e => e.occurrenceDate), ['2026-09-01', '2026-09-02', '2026-09-04', '2026-09-05'], '建时的 exdates 生效')
    // 单次删除 09-02 → 追加例外，规则保留
    const del = await post('/api/calendar/events/delete', { id: ev.id, scope: S, confirm: 'yes', mode: 'occurrence', occurrenceDate: '2026-09-02', by: 'general' })
    assert.equal(del.status, 200, del.text)
    assert.equal(del.json.task.mode, 'occurrence')
    assert.equal(del.json.task.seriesRemoved, false, '整串保留')
    const r2 = await get('/api/calendar/events?scope=' + S + '&from=2026-09-01&to=2026-09-30')
    assert.deepEqual(r2.json.events.map(e => e.occurrenceDate), ['2026-09-01', '2026-09-04', '2026-09-05'])
    // 事件仍在（未被整串删）
    const still = await get('/api/calendar/events?scope=' + S)
    assert.equal(still.json.events.length, 1)
    // 重复删同一实例 → 幂等（不重复追加 exdates）
    const del2 = await post('/api/calendar/events/delete', { id: ev.id, scope: S, confirm: 'yes', mode: 'occurrence', occurrenceDate: '2026-09-02', by: 'general' })
    assert.equal(del2.status, 200)
  })

  it('删除：occurrence 删到最后一个实例 → 整串移除；series 直接整串删除', async () => {
    const S = 'p25-a6'
    const ev = await postEvent({ scope: S, title: '两次的会', start: '2026-09-10T09:00', recurrence: { freq: 'daily', count: 2 }, by: 'general' })
    const d1 = await post('/api/calendar/events/delete', { id: ev.id, scope: S, confirm: 'yes', mode: 'occurrence', occurrenceDate: '2026-09-11', by: 'general' })
    assert.equal(d1.json.task.seriesRemoved, false)
    const d2 = await post('/api/calendar/events/delete', { id: ev.id, scope: S, confirm: 'yes', mode: 'occurrence', occurrenceDate: '2026-09-10', by: 'general' })
    assert.equal(d2.json.task.seriesRemoved, true, '删到空 → 整串移除')
    const gone = await get('/api/calendar/events?scope=' + S)
    assert.deepEqual(gone.json.events, [])
    // 单次事件不支持 occurrence 删除
    const single = await postEvent({ scope: S, title: '单次', start: '2026-09-12T09:00', by: 'general' })
    const bad = await post('/api/calendar/events/delete', { id: single.id, scope: S, confirm: 'yes', mode: 'occurrence', occurrenceDate: '2026-09-12', by: 'general' })
    assert.equal(bad.status, 400)
    assert.ok(/单次事件/.test(bad.json.error))
    // series 删除
    const ds = await post('/api/calendar/events/delete', { id: single.id, scope: S, confirm: 'yes', mode: 'series', by: 'general' })
    assert.equal(ds.json.task.mode, 'series')
    // mode 非法
    const badMode = await post('/api/calendar/events/delete', { id: 1, scope: S, confirm: 'yes', mode: 'nope', by: 'general' })
    assert.equal(badMode.status, 400)
    assert.ok(/mode/.test(badMode.json.error))
  })

  it('展开上限：窗内实例过多 → 抛错（防放大失控），不静默截断', () => {
    assert.throws(
      () => mod.expandCalendarDates({ id: 1, start: '2020-01-01', recurrence: { freq: 'daily', interval: 1 } }, '2020-01-01', '2030-12-31'),
      /实例过多|超出上限/,
    )
  })
})

describe('P2-5-b 事件更新（局部更新 + 越权 + 审计）', () => {
  it('title/时间/全天/关联/重复 局部更新；未传字段不变', async () => {
    const S = 'p25-b1'
    const ev = await postEvent({ scope: S, title: '原标题', start: '2026-09-20T10:00', end: '2026-09-20T11:00', by: 'general' })
    const r = await post('/api/calendar/events/update', { id: ev.id, scope: S, title: '新标题', by: 'general' })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.task.title, '新标题')
    assert.equal(r.json.task.start, '2026-09-20T10:00', '未传 start → 不变')
    assert.equal(r.json.task.end, '2026-09-20T11:00', '未传 end → 不变')
    // 改时间区间 + 全天
    const r2 = await post('/api/calendar/events/update', { id: ev.id, scope: S, start: '2026-09-21T09:00', end: '2026-09-21T12:30', allDay: false, by: 'general' })
    assert.equal(r2.json.task.start, '2026-09-21T09:00')
    assert.equal(r2.json.task.end, '2026-09-21T12:30')
    // 加关联 + 加重复
    const r3 = await post('/api/calendar/events/update', { id: ev.id, scope: S, taskId: 'T-777', goalId: 'G-777', recurrence: { freq: 'weekly', count: 3 }, by: 'general' })
    assert.equal(r3.json.task.taskId, 'T-777')
    assert.equal(r3.json.task.goalId, 'G-777')
    assert.deepEqual(r3.json.task.recurrence, { freq: 'weekly', interval: 1, count: 3 })
    // 清空关联与重复（显式 null）
    const r4 = await post('/api/calendar/events/update', { id: ev.id, scope: S, taskId: null, recurrence: null, by: 'general' })
    assert.equal(r4.json.task.taskId, null)
    assert.equal(r4.json.task.recurrence, null)
    // 审计留痕
    const rows = auditRows('calendar:update').filter(x => x.detail.event === ev.id)
    assert.ok(rows.length >= 4, '每次更新一条 calendar:update 审计：' + rows.length)
    assert.equal(rows[0].member, 'general')
  })

  it('更新校验：无字段/越权/end<start/未知 id → 400 且事件不变', async () => {
    const S = 'p25-b2'
    const ev = await postEvent({ scope: S, title: '守序', start: '2026-09-22T10:00', end: '2026-09-22T11:00', by: 'general' })
    const cases = [
      { body: { id: ev.id, scope: S, by: 'general' }, re: /可更新字段/ },
      { body: { id: ev.id, scope: 'marketing', title: 'x', by: 'general' }, re: /越权/ },
      { body: { id: ev.id, scope: S, start: '2026-09-23T10:00', end: '2026-09-23T09:00', by: 'general' }, re: /end/ },
      { body: { id: ev.id, scope: S, start: '2026-09-24T10:00', by: 'general' }, re: /end 必须 ≥ start/ }, // 旧 end(9-22) < 新 start(9-24)
      { body: { id: 999999, scope: S, title: 'x', by: 'general' }, re: /事件不存在/ },
      { body: { id: ev.id, scope: S, title: 'a'.repeat(101), by: 'general' }, re: /标题过长/ },
      { body: { id: ev.id, scope: S, by: 'general' }, re: /可更新字段/ },
    ]
    for (const c of cases) {
      const r = await post('/api/calendar/events/update', c.body)
      assert.equal(r.status, 400, '400 for ' + JSON.stringify(c.body) + ' → ' + r.text)
      assert.ok(c.re.test(r.json.error), '错误指明原因：' + r.json.error + ' (期望 ' + c.re + ')')
    }
    assert.throws(() => mod.updateCalendarEvent({ scope: S, id: ev.id, title: 'x' }), /缺少操作者身份 by/)
    assert.throws(() => mod.updateCalendarEvent({ id: ev.id, title: 'x', by: 'g' }), /scope/)
    const cur = await get('/api/calendar/events?scope=' + S)
    assert.equal(cur.json.events.length, 1)
    assert.equal(cur.json.events[0].title, '守序', '失败更新零副作用')
    assert.equal(cur.json.events[0].start, '2026-09-22T10:00')
  })
})

describe('P2-5-c 冲突检测（重叠提示，不阻断写入）', () => {
  it('重叠/相邻边界/全天/排除自身/跨重复实例 的判定', async () => {
    const S = 'p25-c1'
    await postEvent({ scope: S, title: 'A 10:00-11:00', start: '2026-10-01T10:00', end: '2026-10-01T11:00', by: 'general' })
    await postEvent({ scope: S, title: 'B 11:00-12:00', start: '2026-10-01T11:00', end: '2026-10-01T12:00', by: 'general' })
    await postEvent({ scope: S, title: 'C 全天', start: '2026-10-01', allDay: true, by: 'general' })
    await postEvent({ scope: S, title: 'D 每日', start: '2026-10-01T10:30', end: '2026-10-01T10:45', recurrence: { freq: 'daily', count: 5 }, by: 'general' })
    // 10:30-10:50 → 与 A（10-11）、C（全天）、D（当日实例）冲突；B（11:00 起）相邻不重叠
    const r = await get('/api/calendar/conflicts?scope=' + S + '&start=2026-10-01T10:30&end=2026-10-01T10:50')
    assert.equal(r.status, 200, r.text)
    const titles = r.json.conflicts.map(c => c.title)
    assert.deepEqual(new Set(titles), new Set(['A 10:00-11:00', 'C 全天', 'D 每日']), '实际：' + JSON.stringify(titles))
    assert.ok(!titles.includes('B 11:00-12:00'), '相邻（11:00 起）不算冲突')
    // 边界相接不算冲突：C 全天与次日 00:00 起的事件
    const r2 = await get('/api/calendar/conflicts?scope=' + S + '&start=2026-10-02T00:00&end=2026-10-02T01:00')
    assert.ok(!r2.json.conflicts.some(c => c.title === 'C 全天'), '全天事件止于 10-02 00:00（左闭右开）')
    assert.ok(!r2.json.conflicts.some(c => c.title === 'D 每日'), 'D 当日实例在 10:30，与 00:00-01:00 窗不重叠')
    // 次日 10:40 → 命中 D 的 10-02 实例（跨日重复实例参与比较）
    const r2b = await get('/api/calendar/conflicts?scope=' + S + '&start=2026-10-02T10:40&end=2026-10-02T10:50')
    assert.ok(r2b.json.conflicts.some(c => c.title === 'D 每日' && c.occurrenceDate === '2026-10-02' && c.recurring === true), 'D 在 10-02 有实例：' + JSON.stringify(r2b.json.conflicts.map(c => c.occurrenceDate + '/' + c.title)))
    // excludeId 排除自身（编辑时用）
    const aId = (await get('/api/calendar/events?scope=' + S)).json.events.find(e => e.title.startsWith('A ')).id
    const r3 = await get('/api/calendar/conflicts?scope=' + S + '&start=2026-10-01T10:00&end=2026-10-01T11:00&excludeId=' + aId)
    assert.ok(!r3.json.conflicts.some(c => c.id === aId), '排除自身后不报自己')
    // 空窗 → 无冲突；跨 space 隔离
    const r4 = await get('/api/calendar/conflicts?scope=' + S + '&start=2026-10-05T03:00&end=2026-10-05T03:30')
    assert.deepEqual(r4.json.conflicts.filter(c => !c.recurring), [], '无重叠')
    const r5 = await get('/api/calendar/conflicts?scope=p25-c-other&start=2026-10-01T10:30&end=2026-10-01T10:50')
    assert.deepEqual(r5.json.conflicts, [], 'scope 隔离')
    // 参数校验
    const bad = await get('/api/calendar/conflicts?start=2026-10-01T10:00')
    assert.equal(bad.status, 400)
    const bad2 = await get('/api/calendar/conflicts?scope=' + S + '&start=2026-10-01T10:00&end=2026-10-01T09:00')
    assert.equal(bad2.status, 400)
    assert.ok(/end/.test(bad2.json.error))
  })

  it('冲突检测不阻断写入：重叠事件可照常创建（仅提示）', async () => {
    const S = 'p25-c2'
    await postEvent({ scope: S, title: '甲', start: '2026-10-10T09:00', end: '2026-10-10T10:00', by: 'general' })
    const ev = await postEvent({ scope: S, title: '乙（重叠）', start: '2026-10-10T09:30', end: '2026-10-10T10:30', by: 'general' })
    assert.ok(ev.id > 0, '重叠仍创建成功')
    const list = await get('/api/calendar/events?scope=' + S)
    assert.equal(list.json.events.length, 2)
  })
})

describe('P2-5-d 任务/目标双向关联', () => {
  it('创建/更新带 taskId+goalId；by-link 正查与反查同口径（含重复展开）', async () => {
    const S = 'p25-d1'
    const ev = await postEvent({ scope: S, title: '任务评审会', start: '2026-11-02T14:00', recurrence: { freq: 'weekly', count: 3 }, taskId: 'T-1234', goalId: 'G-99', by: 'general' })
    assert.equal(ev.taskId, 'T-1234')
    assert.equal(ev.goalId, 'G-99')
    await postEvent({ scope: S, title: '无关事件', start: '2026-11-02T15:00', by: 'general' })
    await postEvent({ scope: S, title: '同目标另一事件', start: '2026-11-03T09:00', goalId: 'G-99', by: 'general' })
    // 按 taskId 查（无窗 = 每条事件一行，不强行展开）
    const byTask = await get('/api/calendar/events/by-link?taskId=T-1234')
    assert.equal(byTask.status, 200, byTask.text)
    assert.equal(byTask.json.events.length, 1, '无窗不展开（避免无界规则爆开）')
    assert.equal(byTask.json.events[0].occurrenceDate, '2026-11-02', 'occurrenceDate = 首次实例日')
    assert.equal(byTask.json.events[0].recurring, true)
    // 带窗 = 展开实例
    const byTaskWin = await get('/api/calendar/events/by-link?taskId=T-1234&from=2026-11-01&to=2026-11-30')
    assert.deepEqual(byTaskWin.json.events.map(e => e.occurrenceDate), ['2026-11-02', '2026-11-09', '2026-11-16'], '重复实例展开')
    assert.ok(byTaskWin.json.events.every(e => e.taskId === 'T-1234'))
    // 按 goalId 查（含两条不同事件）
    const byGoal = await get('/api/calendar/events/by-link?goalId=G-99')
    assert.equal(byGoal.json.events.length, 2, '两条事件各一行')
    const byGoalWin = await get('/api/calendar/events/by-link?goalId=G-99&from=2026-11-01&to=2026-11-30')
    assert.equal(byGoalWin.json.events.length, 4, 'T-1234 的 3 个实例 + 同目标另 1 条')
    // 带窗过滤
    const win = await get('/api/calendar/events/by-link?goalId=G-99&from=2026-11-09&to=2026-11-09')
    assert.deepEqual(win.json.events.map(e => e.title), ['任务评审会'])
    // 校验：必须给 taskId 或 goalId
    const bad = await get('/api/calendar/events/by-link')
    assert.equal(bad.status, 400)
    assert.ok(/taskId 或 goalId/.test(bad.json.error))
    // 空关联 id 视为未关联（不报错，返回空）
    const empty = await get('/api/calendar/events/by-link?taskId=%20')
    assert.equal(empty.status, 400, '空白 taskId → 视为未指定')
    // DAO 级
    assert.throws(() => mod.listCalendarEventsByLink({}), /必须指定/)
    assert.deepEqual(mod.listCalendarEventsByLink({ taskId: 'T-不存在' }), [])
  })

  it('关联 id 形状：空串/null 归一为未关联，超长报错', async () => {
    const S = 'p25-d2'
    const a = await postEvent({ scope: S, title: '空关联', start: '2026-11-05T09:00', taskId: '', goalId: null, by: 'general' })
    assert.equal(a.taskId, null)
    assert.equal(a.goalId, null)
    const r = await post('/api/calendar/events', { scope: S, title: 'x', start: '2026-11-05T09:00', taskId: 'T'.repeat(80), by: 'general' })
    assert.equal(r.status, 400)
    assert.ok(/过长/.test(r.json.error))
  })
})

describe('P2-5-e 时间语义与列表兼容（字面本地时间，零时区换算；单次事件行为不变）', () => {
  it('字面语义：原样存储原样返回；数字时间串不被时区换算（含 Z 后缀同样按字面处理）', async () => {
    const S = 'p25-e1'
    const a = await postEvent({ scope: S, title: '本地时刻', start: '2026-11-10T08:15', end: '2026-11-10T09:45', by: 'general' })
    assert.equal(a.start, '2026-11-10T08:15', '原样存储')
    assert.equal(a.end, '2026-11-10T09:45')
    const b = await postEvent({ scope: S, title: '带 Z 后缀', start: '2026-11-11T08:15Z', by: 'general' })
    assert.equal(b.start, '2026-11-11T08:15Z', '字面保留（不做 UTC 换算：09:15+08:00 那类换算不发生）')
    const list = await get('/api/calendar/events?scope=' + S + '&from=2026-11-10&to=2026-11-11')
    const map = new Map(list.json.events.map(e => [e.title, e]))
    assert.equal(map.get('本地时刻').start, '2026-11-10T08:15')
    assert.equal(map.get('带 Z 后缀').start, '2026-11-11T08:15Z')
    // 全天 date-only 语义不变
    const d = await postEvent({ scope: S, title: '全天', start: '2026-11-12', allDay: true, by: 'general' })
    assert.equal(d.start, '2026-11-12')
    assert.equal(d.end, null)
    assert.equal(d.allDay, true)
    assert.equal(d.occurrenceDate, '2026-11-12')
    assert.equal(d.recurring, false)
  })

  it('旧契约兼容：单次事件列表无窗仍返回全部；新增字段（taskId/goalId/recurrence/occurrenceDate/recurring）形状稳定', async () => {
    const S = 'p25-e2'
    const ev = await postEvent({ scope: S, title: '兼容检查', start: '2026-11-15T10:00', end: '2026-11-15T11:00', meta: { color: 'red' }, by: 'general' })
    for (const k of ['id', 'scope', 'title', 'start', 'end', 'allDay', 'taskId', 'goalId', 'recurrence', 'meta', 'createdAt', 'updatedAt', 'occurrenceDate', 'recurring']) {
      assert.ok(k in ev, '事件对象含字段 ' + k)
    }
    assert.equal(ev.taskId, null)
    assert.equal(ev.goalId, null)
    assert.equal(ev.recurrence, null)
    assert.deepEqual(ev.meta, { color: 'red' })
    const list = await get('/api/calendar/events?scope=' + S)
    assert.equal(list.json.events.length, 1)
    assert.equal(list.json.events[0].occurrenceDate, '2026-11-15', '单次事件的实例日 = 其 start 日期')
  })

  it('老库补列幂等：重复执行 ALTER 不报错（表结构含 taskId/goalId/recurrence）', () => {
    const cols = mod.db.prepare('PRAGMA table_info(calendar_events)').all().map(c => c.name)
    for (const c of ['taskId', 'goalId', 'recurrence']) assert.ok(cols.includes(c), '列存在：' + c)
  })
})
