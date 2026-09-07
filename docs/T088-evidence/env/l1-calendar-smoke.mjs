// T-088 L1：日历契约真实进程冒烟（隔离 hub :8791，临时库）
// 响应信封：写接口一律 {ok:true, task:<result>}（handleWrite），GET events = {scope, events:[…]}
const BASE = process.env.HUB || 'http://127.0.0.1:8791'
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ' + name + (extra ? ' | ' + extra : '')) } else { fail++; console.log('FAIL ' + name + (extra ? ' | ' + extra : '')) } }
const j = async (path, opt) => {
  const res = await fetch(BASE + path, opt)
  const text = await res.text()
  let body = null; try { body = JSON.parse(text) } catch { body = text }
  return { status: res.status, body }
}
const post = (p, b) => j(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
const eventsOf = b => (b && (Array.isArray(b) ? b : b.events)) || []
const sleep = ms => new Promise(r => setTimeout(r, ms))
// 自净：清掉历史冒烟残留（前序失败轮可能遗留），保证可重复运行
for (const sc of ['software', 'marketing']) {
  try {
    const gg = await j('/api/calendar/events?scope=' + sc + '&from=2000-01-01&to=2100-01-01')
    for (const e of eventsOf(gg.body)) {
      if (String(e.title).startsWith('L1冒烟')) {
        await post('/api/calendar/events/delete', { id: e.id, scope: sc, confirm: 'yes', by: 'tester' }).catch(() => {})
      }
    }
  } catch { /* 忽略 */ }
}
console.log('L1-sweep: 旧残留清理完成')


try {
  const cfg = await j('/api/config')
  ok('L1-cfg 隔离自检：端口+临时库', cfg.status === 200 && String(cfg.body.db).includes('t088-hub-') && String(cfg.body.db).includes('hub.db'), 'db=' + cfg.body.db)

  const s1 = await post('/api/spaces', { id: 'software', name: '软件部空间', by: 'tester' })
  const s2 = await post('/api/spaces', { id: 'marketing', name: '市场部空间', by: 'tester' })
  ok('L1-spaces 注册 software/marketing 200', s1.status === 200 && s2.status === 200, 's1=' + s1.status + ' (' + (s1.body.error || '') + ') s2=' + s2.status)
  const sp = await j('/api/spaces')
  ok('L1-spaces 列表含两空间', sp.status === 200 && Array.isArray(sp.body.spaces) && sp.body.spaces.length >= 2, 'count=' + (sp.body.spaces || []).length)

  const mk = { scope: 'software', title: 'L1冒烟-技术评审', start: '2026-09-10T10:00', end: null, allDay: false, by: 'tester' }
  const c1 = await post('/api/calendar/events', mk)
  const ev = c1.body && c1.body.task
  ok('L1-create 200 信封{ok,task}', c1.status === 200 && c1.body.ok === true && ev && ev.id > 0, 'status=' + c1.status + ' body=' + JSON.stringify(c1.body).slice(0, 160))
  ok('L1-create 字段形状', ev && ev.scope === 'software' && ev.title === mk.title && ev.start === mk.start && ev.allDay === false)
  const evId = ev && ev.id

  const g1 = await j('/api/calendar/events?scope=software&from=2026-09-01&to=2026-09-30')
  ok('L1-get 日期窗命中 09-10', g1.status === 200 && eventsOf(g1.body).some(e => e.title === 'L1冒烟-技术评审'), 'n=' + eventsOf(g1.body).length)
  const g2 = await j('/api/calendar/events?scope=software&from=2026-10-01&to=2026-10-31')
  ok('L1-get 窗外(10月)不含', g2.status === 200 && eventsOf(g2.body).length === 0)

  const m1 = await post('/api/calendar/events', { scope: 'marketing', title: 'L1冒烟-市场发布会', start: '2026-09-20', by: 'tester', allDay: true })
  const mev = m1.body && m1.body.task
  ok('L1-create allDay(date-only) 200', m1.status === 200 && mev && (mev.allDay === true || String(mev.start).indexOf('T') < 0))
  const gs = await j('/api/calendar/events?scope=software&from=2026-09-01&to=2026-09-30')
  const gm = await j('/api/calendar/events?scope=marketing&from=2026-09-01&to=2026-09-30')
  const tS = JSON.stringify(gs.body), tM = JSON.stringify(gm.body)
  ok('L1-scope 隔离反向(software 无市场)', tS.includes('技术评审') && !tS.includes('市场发布会'))
  ok('L1-scope 隔离反向(marketing 无软件)', tM.includes('市场发布会') && !tM.includes('技术评审'))

  const bad1 = await post('/api/calendar/events', { scope: 'software', title: '缺by', start: '2026-09-11', by: '' })
  const bad2 = await post('/api/calendar/events', { scope: 'software', title: '', start: '2026-09-11', by: 'tester' })
  const bad3 = await post('/api/calendar/events', { scope: 'software', title: 'x'.repeat(101), start: '2026-09-11', by: 'tester' })
  const bad4 = await post('/api/calendar/events', { scope: 'software', title: '时间乱', start: 'garbage', by: 'tester' })
  const bad5 = await post('/api/calendar/events', { scope: 'software', title: 'end<start', start: '2026-09-12T09:00', end: '2026-09-12T08:00', by: 'tester' })
  ok('L1-bad 缺by→400', bad1.status === 400, 's=' + bad1.status)
  ok('L1-bad 空标题→400', bad2.status === 400)
  ok('L1-bad 标题101→400', bad3.status === 400)
  ok('L1-bad 非法时间→400', bad4.status === 400)
  ok('L1-bad end<start→400', bad5.status === 400)
  const g3 = await j('/api/calendar/events?scope=software&from=2026-09-01&to=2026-09-30')
  ok('L1-bad 零落库(仅1条软件标题)', eventsOf(g3.body).filter(e => String(e.title).startsWith('L1冒烟')).length === 1, 'n=' + eventsOf(g3.body).length)

  const d1 = await post('/api/calendar/events/delete', { id: evId, scope: 'software', by: 'tester' })
  ok('L1-delete 缺confirm→400', d1.status === 400)
  const d2 = await post('/api/calendar/events/delete', { id: evId, scope: 'marketing', confirm: 'yes', by: 'tester' })
  ok('L1-delete scope越权→400/404', d2.status === 400 || d2.status === 404, 's=' + d2.status)
  const d3 = await post('/api/calendar/events/delete', { id: evId, scope: 'software', confirm: 'yes', by: 'tester' })
  ok('L1-delete confirm=yes→200', d3.status === 200 && d3.body.ok === true)
  const g4 = await j('/api/calendar/events?scope=software&from=2026-09-01&to=2026-09-30')
  ok('L1-delete 后 GET 不含', !JSON.stringify(g4.body).includes('L1冒烟-技术评审'))

  const act = await j('/api/activity?scope=software')
  const rows = Array.isArray(act.body) ? act.body : (act.body && act.body.rows) || []
  const calRows = rows.filter(r => String(r.action || r.kind || '').startsWith('calendar:'))
  ok('L1-audit calendar:create+delete 行', calRows.some(r => String(r.action).includes('calendar:create')) && calRows.some(r => String(r.action).includes('calendar:delete')), 'actions=' + calRows.map(r => r.action).join(','))

  // SSE 实时帧（复用 /api/events 单一流）：订阅期间 POST → ≤6s 收 calendar:create
  let sseOk = false
  try {
    const ctrl = new AbortController()
    const res = await fetch(BASE + '/api/events', { signal: ctrl.signal })
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    const timer = setTimeout(() => ctrl.abort(), 7000)
    const pump = async () => {
      try {
        const { value, done } = await reader.read()
        if (done) return
        if (dec.decode(value, { stream: true }).includes('calendar:create')) { sseOk = true; return }
        await pump()
      } catch { /* aborted */ }
    }
    const p = pump()
    const c2 = await post('/api/calendar/events', { scope: 'software', title: 'L1冒烟-SSE事件', start: '2026-09-15', by: 'tester', allDay: true })
    await p
    clearTimeout(timer)
    try { ctrl.abort(); await reader.cancel().catch(() => {}) } catch { /* */ }
    ok('L1-SSE /api/events 收 calendar:create ≤7s', sseOk && c2.status === 200, 'sseOk=' + sseOk)
  } catch (e) { ok('L1-SSE /api/events 收 calendar:create', false, 'err=' + e.message) }
} catch (e) {
  console.log('FATAL: ' + (e && e.stack || e))
  fail++
}

console.log('\n===== L1 SUMMARY ===== passed=' + pass + '/' + (pass + fail))
process.exit(fail === 0 ? 0 : 1)