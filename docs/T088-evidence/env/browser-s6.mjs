// T-088 L2 浏览器闭环（真实浏览器 + 真实 team-hub :8791 联调）
// 覆盖 TC-S6-01..09（hub 断连恢复 TC-S6-03③/08 走 GATE 门与外部配合）
import { launchChrome, newPage, cdp, waitFor, evalJS } from './cdp.mjs'

const HUB = 'http://127.0.0.1:8791'
const APP = 'http://127.0.0.1:5273/'
let pass = 0, fail = 0
const P = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ' + name + (extra ? ' | ' + extra : '')) } else { fail++; console.log('FAIL ' + name + (extra ? ' | ' + extra : '')) } }

const hubFetch = async (p, opt) => { const r = await fetch(HUB + p, opt); const t = await r.text(); let b = null; try { b = JSON.parse(t) } catch { b = t } return { status: r.status, body: b } }
const hubPost = (p, body) => hubFetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

// ── 工具表达式 ──
const CLICK_TEXT = (sel, text) => `(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => e.textContent.includes(${JSON.stringify(text)})); if (!el) return false; el.click(); return true })()`
const toastExpr = kind => `(() => { const ts = [...document.querySelectorAll('.toast-host .toast' + (${JSON.stringify(kind)} ? '.' + ${JSON.stringify(kind)} : '')).map(e => e.textContent.trim()); return ts })()`
const gridInfo = `(() => {
  const cells = [...document.querySelectorAll('.cal-grid .cal-cell')]
  return {
    count: cells.length,
    curCount: cells.filter(c => !c.classList.contains('dim')).length,
    weekdays: [...document.querySelectorAll('.cal-wd')].map(e => e.textContent),
    label: (document.querySelector('.cal-month-label') || {}).textContent || '',
    todayDate: (() => { const t = document.querySelector('.cal-cell .cal-date.today'); return t ? t.textContent : null })(),
    todayMark: !!document.querySelector('.cal-today-mark'),
    dates: cells.map(c => c.querySelector('.cal-date').textContent),
  }
})()`

const sleep = ms => new Promise(r => setTimeout(r, ms))

try {
  // 0) 预清理：删除两个空间全部日历事件（幂等可重复）
  for (const sc of ['software', 'marketing']) {
    const g = await hubFetch('/api/calendar/events?scope=' + sc + '&from=2000-01-01&to=2100-01-01')
    const evs = (g.body && (Array.isArray(g.body) ? g.body : g.body.events)) || []
    for (const e of evs) await hubPost('/api/calendar/events/delete', { id: e.id, scope: sc, confirm: 'yes', by: 'tester' }).catch(() => {})
  }
  console.log('browser: 预清理完成')

  const chrome = await launchChrome()
  console.log('browser: chrome up (pid=' + chrome.pid + ')')
  const page = await newPage(APP)
  const c = await cdp(page.webSocketDebuggerUrl)

  // 1) 应用启动（读真实 board :4820 + hubMode 探测 → :5273/hub 代理 → :8791）
  await waitFor(c, "!!document.querySelector('.sidebar') && !document.body.innerText.includes('正在连接数据源')", 25000, 'app boot')
  await waitFor(c, "document.body.innerText.includes('软件部空间')", 20000, 'hub spaces loaded')
  P('B00 应用启动 + 中枢探测(hubMode)成功', true, '侧栏可见且含 hub 空间列表')
  await evalJS(c, 'window.__t088marker = 1')
  P('B00b 页面加载未整页刷新基线', await evalJS(c, 'window.__t088marker === 1') === true)

  // 2) TC-S6-01：未选空间点「日程日历」→ 引导（真实面板非 toast 占位）
  P('B01 点击日程日历模块', await evalJS(c, CLICK_TEXT('.sidebar .nav-item', '日程日历')) === true)
  await waitFor(c, "document.body.innerText.includes('请先选择具体工作空间')", 8000, 'calendar no-scope guide')
  P('S6-01a 未选空间 → 引导「请先选择具体工作空间」（非 toast 占位）', true)

  // 3) 选 software 空间 → 面板真实渲染
  P('B02 选择软件部空间', await evalJS(c, CLICK_TEXT('.sidebar .nav-item', '软件部空间')) === true)
  await waitFor(c, "!!document.querySelector('.cal-grid')", 10000, 'cal-grid mounts')
  const g1 = await evalJS(c, gridInfo)
  const labelOk = g1.label === '2026年9月'
  const wdOk = JSON.stringify(g1.weekdays) === JSON.stringify(['一', '二', '三', '四', '五', '六', '日'])
  const todayOk = g1.todayDate === '5' && g1.todayMark
  // 期望网格独立推导（周一起始）：2026-09：9/1 为周二 → lead=1；总格数 35
  const y = 2026, m = 8 // JS month 0-based（9月）
  const firstDow = new Date(y, m, 1).getDay(); const lead = (firstDow + 6) % 7
  const total = new Date(y, m + 1, 0).getDate()
  const rows = Math.ceil((lead + total) / 7)
  const expectCells = rows * 7
  P('S6-01b 真实月视图面板：7×N 网格', g1.count === expectCells && g1.count % 7 === 0 && g1.curCount === total,
    'cells=' + g1.count + '(期望' + expectCells + ') cur=' + g1.curCount + '(期望' + total + ') rows=' + rows)
  P('S6-01c 星期头 一二三四五六日 + 月标签 2026年9月', wdOk && labelOk, JSON.stringify(g1.weekdays) + ' label=' + g1.label)
  P('S6-01d 月首/月尾周对齐（9/1 位于第 ' + (lead + 1) + ' 列）', g1.dates[lead] === '1', 'lead=' + lead + ' dates[lead]=' + g1.dates[lead])
  P('S6-01e 今天格高亮（5 号 today + 「今天」标记）', todayOk, 'todayDate=' + g1.todayDate + ' mark=' + g1.todayMark)

  // 4) TC-S6-02：新建（标题+日期必填，时间可选）
  await evalJS(c, CLICK_TEXT('.btn', '＋ 新建条目'))
  await waitFor(c, "!!document.querySelector('.modal input')", 5000, 'create modal')
  await evalJS(c, `(() => { const inp = document.querySelector('.modal input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(inp, '验收评审会'); inp.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await evalJS(c, `(() => { const inp = document.querySelector('.modal input[type=date]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(inp, '2026-09-05'); inp.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await sleep(300)
  const saveEnabled = await evalJS(c, `(() => { const b = [...document.querySelectorAll('.modal-foot .btn')].find(x => x.textContent.includes('保存')); return b && !b.disabled })()`)
  P('S6-02a 合法输入放行（保存可用）', saveEnabled === true)
  await evalJS(c, `(() => { const b = [...document.querySelectorAll('.modal-foot .btn')].find(x => x.textContent.includes('保存')); b.click(); return true })()`)
  await waitFor(c, "!!document.querySelector('.cal-cell .cal-chip-title')", 8000, 'chip appears')
  await sleep(600)
  const toastsOk = await evalJS(c, toastExpr('ok'))
  const chipOn5 = await evalJS(c, `(() => { const cell = [...document.querySelectorAll('.cal-cell')].find(c => c.querySelector('.cal-date').textContent === '5' && !c.classList.contains('dim')); return cell ? [...cell.querySelectorAll('.cal-chip-title')].map(e => e.textContent) : [] })()`)
  const noReload = await evalJS(c, 'window.__t088marker === 1')
  P('S6-02b 全天条目入今天格(5号) 标题可见', chipOn5.includes('验收评审会'), 'chips=' + JSON.stringify(chipOn5))
  P('S6-02c toast 成功「日程已创建（全天）」', toastsOk.some(t => t.includes('日程已创建')), JSON.stringify(toastsOk))
  P('S6-02d 无整页刷新', noReload === true)

  // 带时间条目 9/10 10:30
  await evalJS(c, CLICK_TEXT('.btn', '＋ 新建条目'))
  await waitFor(c, "!!document.querySelector('.modal input')", 5000, 'create modal2')
  await evalJS(c, `(() => { const inp = document.querySelector('.modal input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(inp, '技术方案评审'); inp.dispatchEvent(new Event('input', { bubbles: true })); const d = document.querySelector('.modal input[type=date]'); set.call(d, '2026-09-10'); d.dispatchEvent(new Event('input', { bubbles: true })); const t = document.querySelector('.modal input[type=time]'); set.call(t, '10:30'); t.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await sleep(300)
  await evalJS(c, `(() => { const b = [...document.querySelectorAll('.modal-foot .btn')].find(x => x.textContent.includes('保存')); b.click(); return true })()`)
  await waitFor(c, "document.body.innerText.includes('技术方案评审')", 8000, 'timed chip')
  const chipOn10 = await evalJS(c, `(() => { const cell = [...document.querySelectorAll('.cal-cell')].find(c => c.querySelector('.cal-date').textContent === '10' && !c.classList.contains('dim')); return cell ? [...cell.querySelectorAll('.cal-chip')].map(e => e.textContent) : [] })()`)
  P('S6-02e 带时间条目 9/10 10:30 入格（含时间显示）', chipOn10.some(t => t.includes('10:30') && t.includes('技术方案评审')), JSON.stringify(chipOn10))

  // 5) TC-S6-03①/② 前端校验：空标题/101 字
  await evalJS(c, CLICK_TEXT('.btn', '＋ 新建条目'))
  await waitFor(c, "!!document.querySelector('.modal input')", 5000, 'create modal3')
  const emptyTitleSaveDisabled = await evalJS(c, `(() => { const b = [...document.querySelectorAll('.modal-foot .btn')].find(x => x.textContent.includes('保存')); return b ? b.disabled : null })()`)
  P('S6-03① 空标题 → 保存禁用（前端阻止）', emptyTitleSaveDisabled === true, 'disabled=' + emptyTitleSaveDisabled)
  await evalJS(c, `(() => { const inp = document.querySelector('.modal input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(inp, 'x'.repeat(101)); inp.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await sleep(250)
  const overToast = await evalJS(c, `(() => { const b = [...document.querySelectorAll('.modal-foot .btn')].find(x => x.textContent.includes('保存')); b.click(); return true })()`)
  await sleep(500)
  const errToasts = await evalJS(c, toastExpr('err'))
  P('S6-03② 标题101字 → 前端拦截 toast（不产生坏条目）', errToasts.some(t => t.includes('标题过长')), JSON.stringify(errToasts))
  await evalJS(c, `(() => { const b = [...document.querySelectorAll('.modal-foot .btn')].find(x => x.textContent.includes('取消')); b.click(); return true })()`)
  await sleep(300)
  const afterOverLen = await evalJS(c, `document.querySelectorAll('.cal-chip-title').length`)
  const evCount = await (async () => { const g = await hubFetch('/api/calendar/events?scope=software&from=2026-09-01&to=2026-09-30'); return ((g.body && g.body.events) || []).length })()
  P('S6-03②b 无坏条目落库（服务端仍 2 条）', evCount === 2, 'serverEvents=' + evCount)

  // 6) TC-S6-04 删除二次确认
  await evalJS(c, `(() => { const chip = [...document.querySelectorAll('.cal-cell .cal-chip')].find(ch => ch.textContent.includes('验收评审会')); const x = chip && chip.querySelector('.cal-chip-del'); if (x) x.click(); return !!x })()`)
  await waitFor(c, "document.body.innerText.includes('确认删除「验收评审会」')", 5000, 'delete modal')
  P('S6-04a 点删除 → 弹二次确认', true)
  await evalJS(c, `(() => { const b = [...document.querySelectorAll('.modal-foot .btn')].find(x => x.textContent.includes('取消')); b.click(); return true })()`)
  await sleep(400)
  const stillThere = await evalJS(c, `[...document.querySelectorAll('.cal-chip-title')].some(e => e.textContent === '验收评审会')`)
  P('S6-04b 取消 → 无删除、条目仍在', stillThere === true)
  await evalJS(c, `(() => { const chip = [...document.querySelectorAll('.cal-cell .cal-chip')].find(ch => ch.textContent.includes('验收评审会')); chip.querySelector('.cal-chip-del').click(); return true })()`)
  await waitFor(c, "document.body.innerText.includes('确认删除「验收评审会」')", 5000, 'delete modal2')
  await evalJS(c, `(() => { const b = [...document.querySelectorAll('.modal-foot .btn')].find(x => x.textContent.includes('确认删除')); b.click(); return true })()`)
  await waitFor(c, "![...document.querySelectorAll('.cal-chip-title')].some(e => e.textContent === '验收评审会')", 8000, 'chip removed')
  await sleep(300)
  const delToasts = await evalJS(c, toastExpr('ok'))
  P('S6-04c 确认(confirm=yes) → 条目消失 + toast 成功', delToasts.some(t => t.includes('日程已删除')), JSON.stringify(delToasts))

  // 7) TC-S6-05 刷新持久（数据来自 GET /api/calendar/events）
  await c.send('Page.reload', { ignoreCache: true })
  await waitFor(c, "!!document.querySelector('.sidebar') && document.body.innerText.includes('软件部空间')", 25000, 'reload boot')
  await evalJS(c, 'window.__t088marker = 2')
  await evalJS(c, CLICK_TEXT('.sidebar .nav-item', '软件部空间'))
  await evalJS(c, CLICK_TEXT('.sidebar .nav-item', '日程日历'))
  await waitFor(c, "!!document.querySelector('.cal-grid') && document.querySelectorAll('.cal-chip-title').length > 0", 12000, 'chips after reload')
  const afterReload = await evalJS(c, `[...document.querySelectorAll('.cal-chip-title')].map(e => e.textContent)`)
  const lsHasEvents = await evalJS(c, `JSON.stringify(localStorage).includes('技术方案评审') || JSON.stringify(localStorage).includes('验收评审会')`)
  P('S6-05 刷新后条目仍在（技术方案评审；非 localStorage）', afterReload.includes('技术方案评审') && afterReload.length === 1 && lsHasEvents === false, JSON.stringify(afterReload) + ' lsHasEvents=' + lsHasEvents)

  // 8) TC-S6-06 空间隔离
  await evalJS(c, CLICK_TEXT('.sidebar .nav-item', '市场部空间'))
  await waitFor(c, "!!document.querySelector('.cal-grid')", 10000, 'marketing grid')
  await sleep(700)
  const mktEmpty = await evalJS(c, `[...document.querySelectorAll('.cal-chip-title')].map(e => e.textContent)`)
  P('S6-06a marketing 看不到 software 条目（空）', mktEmpty.length === 0 && JSON.stringify(mktEmpty).indexOf('技术方案评审') < 0, JSON.stringify(mktEmpty))
  // marketing 建一条
  await evalJS(c, CLICK_TEXT('.btn', '＋ 新建条目'))
  await waitFor(c, "!!document.querySelector('.modal input')", 5000, 'mkt modal')
  await evalJS(c, `(() => { const inp = document.querySelector('.modal input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(inp, '市场发布会'); inp.dispatchEvent(new Event('input', { bubbles: true })); const d = document.querySelector('.modal input[type=date]'); set.call(d, '2026-09-05'); d.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await sleep(250)
  await evalJS(c, `(() => { const b = [...document.querySelectorAll('.modal-foot .btn')].find(x => x.textContent.includes('保存')); b.click(); return true })()`)
  await waitFor(c, "document.body.innerText.includes('市场发布会')", 8000, 'mkt chip')
  // 切回 software
  await evalJS(c, CLICK_TEXT('.sidebar .nav-item', '软件部空间'))
  await waitFor(c, "!!document.querySelector('.cal-grid')", 10000, 'back software')
  await sleep(800)
  const swBack = await evalJS(c, `[...document.querySelectorAll('.cal-chip-title')].map(e => e.textContent)`)
  P('S6-06b 切回 software 数据仍在且无 market 条目', swBack.includes('技术方案评审') && !swBack.includes('市场发布会'), JSON.stringify(swBack))
  await evalJS(c, CLICK_TEXT('.sidebar .nav-item', '市场部空间'))
  await sleep(800)
  const mktBack = await evalJS(c, `[...document.querySelectorAll('.cal-chip-title')].map(e => e.textContent)`)
  P('S6-06c marketing 显示自身条目', mktBack.includes('市场发布会') && !mktBack.includes('技术方案评审'), JSON.stringify(mktBack))
  // 全部空间 → 引导
  await evalJS(c, CLICK_TEXT('.sidebar .nav-item', '全部空间'))
  await sleep(500)
  const allGuide = await evalJS(c, "document.body.innerText.includes('请先选择具体工作空间')")
  P('S6-06d 全部空间/未选 → 引导非白屏', allGuide === true)

  // 9) TC-S6-07 跨月切换
  await evalJS(c, CLICK_TEXT('.sidebar .nav-item', '软件部空间'))
  await waitFor(c, "!!document.querySelector('.cal-grid')", 10000, 'software grid')
  await sleep(600)
  await evalJS(c, `document.querySelector('.cal-prev').click()`)
  await sleep(900)
  const aug = await evalJS(c, gridInfo)
  const augTotal = new Date(2026, 7, 0).getDate() // 8月 31
  const augFirstDow = new Date(2026, 7, 1).getDay(); const augLead = (augFirstDow + 6) % 7
  const augRows = Math.ceil((augLead + augTotal) / 7)
  P('S6-07a 上月切换 → 2026年8月 网格正确（7×' + augRows + '）', aug.label === '2026年8月' && aug.count === augRows * 7 && aug.curCount === augTotal, 'label=' + aug.label + ' cells=' + aug.count)
  const augHasToday = await evalJS(c, "!!document.querySelector('.cal-today-mark')")
  P('S6-07b 非当月 → 今天高亮不显示', augHasToday === false)
  const sepHasChips = await evalJS(c, `[...document.querySelectorAll('.cal-chip-title')].map(e => e.textContent)`)
  P('S6-07c 8月视图无 9 月条目', sepHasChips.length === 0, JSON.stringify(sepHasChips))
  await evalJS(c, `document.querySelector('.cal-next').click()`)
  await sleep(900)
  const sep2 = await evalJS(c, gridInfo)
  const todayBack = sep2.todayDate === '5' && sep2.todayMark
  const chipsBack = await evalJS(c, `[...document.querySelectorAll('.cal-chip-title')].map(e => e.textContent)`)
  P('S6-07d 回到当月 → 今天高亮恢复 + 条目复原', sep2.label === '2026年9月' && todayBack === true && chipsBack.includes('技术方案评审'), JSON.stringify(sep2) + ' chips=' + JSON.stringify(chipsBack))
  // 今天按钮：去 10 月再回
  await evalJS(c, `document.querySelector('.cal-next').click()`)
  await sleep(800)
  const oct = await evalJS(c, gridInfo)
  P('S6-07e 下月 → 2026年10月', oct.label === '2026年10月', oct.label)
  await evalJS(c, `document.querySelector('.cal-today-btn').click()`)
  await sleep(900)
  const sep3 = await evalJS(c, gridInfo)
  P('S6-07f 「今天」按钮回到本月且高亮恢复', sep3.label === '2026年9月' && sep3.todayDate === '5' && sep3.todayMark)

  // 10) TC-S6-09 XSS 标题纯文本（服务端注入样本 → 前端渲染）
  const xssTitle = '<img src=x onerror=window.__xss=1>注入样本'
  await hubPost('/api/calendar/events', { scope: 'software', title: xssTitle, start: '2026-09-18', by: 'tester', allDay: true })
  await evalJS(c, `document.querySelector('.cal-today-btn').click()`) // 触发重拉
  await sleep(900)
  const xssChip = await evalJS(c, `(() => { const ch = [...document.querySelectorAll('.cal-chip-title')].find(e => e.textContent.includes('注入样本')); if (!ch) return null; const cell = ch.closest('.cal-cell'); return { text: ch.textContent, imgInCell: !!cell.querySelector('img'), imgInChip: !!ch.closest('.cal-chip').querySelector('img'), xssFired: window.__xss === 1 } })()`)
  P('S6-09 XSS 标题按纯文本渲染（无 img 元素、无脚本执行）', xssChip !== null && xssChip.text.includes('<img') && xssChip.imgInCell === false && xssChip.xssFired !== true, JSON.stringify(xssChip))

  // 11) 等外部配合的 GATE：hub 断连 → 保存失败 toast / 面板不崩 → hub 恢复 → 重试成功（TC-S6-03③/TC-S6-08）
  // 打开新建弹层并填好合法值，等待 hub 被外部杀掉
  await evalJS(c, CLICK_TEXT('.btn', '＋ 新建条目'))
  await waitFor(c, "!!document.querySelector('.modal input')", 5000, 'gate modal')
  await evalJS(c, `(() => { const inp = document.querySelector('.modal input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(inp, '断连重试条目'); inp.dispatchEvent(new Event('input', { bubbles: true })); const d = document.querySelector('.modal input[type=date]'); set.call(d, '2026-09-06'); d.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  console.log('GATE:HUB_DOWN_REQ')
  // 等 hub 不可达（外部 kill 中）
  let hubDown = false
  for (let i = 0; i < 60; i++) { try { await hubFetch('/api/config'); await sleep(300) } catch { hubDown = true; break } }
  P('GATE-check hub 已不可达（外部已 kill）', hubDown === true)
  // 停 hub 后点保存 → toast 错误、面板不白屏不崩溃
  await evalJS(c, `(() => { const b = [...document.querySelectorAll('.modal-foot .btn')].find(x => x.textContent.includes('保存')); b.click(); return true })()`)
  await sleep(1200)
  const errT = await evalJS(c, toastExpr('err'))
  const gridAlive = await evalJS(c, "!!document.querySelector('.cal-grid')")
  P('S6-08a hub 不可达保存 → toast 错误', errT.some(t => t.includes('创建失败') || t.includes('失败')), JSON.stringify(errT))
  P('S6-08b 面板不白屏不崩溃（网格仍在、弹层仍在）', gridAlive === true && (await evalJS(c, "!!document.querySelector('.modal')")) === true)
  // 停 hub 后切月 → 错误行 + 重试按钮（不崩溃）
  await evalJS(c, `document.querySelector('.cal-prev').click()`)
  await sleep(1200)
  const errLine = await evalJS(c, "!!document.querySelector('.cal-footnote.err') && document.body.innerText.includes('日程加载失败')")
  P('S6-08c hub 不可达切月 → 错误提示行（不白屏）', errLine === true)
  console.log('GATE:HUB_UP_REQ')
  // 等 hub 恢复（外部重启）
  let hubUp = false
  for (let i = 0; i < 120; i++) { try { const r = await hubFetch('/api/config'); if (r.status === 200) { hubUp = true; break } } catch { /* retry */ } await sleep(500) }
  P('GATE-check hub 已恢复可达', hubUp === true)
  // 回到当月 + 重试：点重试按钮先恢复加载
  await evalJS(c, `(() => { const b = [...document.querySelectorAll('.cal-footnote.err .btn')].find(x => x.textContent.includes('重试')); if (b) b.click(); return true })()`)
  await sleep(1200)
  // 弹层应仍在 → 再点保存
  const modalStill = await evalJS(c, "!!document.querySelector('.modal input')")
  if (modalStill) {
    await evalJS(c, `(() => { const b = [...document.querySelectorAll('.modal-foot .btn')].find(x => x.textContent.includes('保存')); b.click(); return true })()`)
    await waitFor(c, "!![...document.querySelectorAll('.cal-chip-title')].some(e => e.textContent === '断连重试条目')", 10000, 'retry chip')
    await sleep(400)
    const okT = await evalJS(c, toastExpr('ok'))
    P('S6-08d hub 恢复后重试保存成功（条目入格 + toast）', okT.some(t => t.includes('日程已创建')), JSON.stringify(okT))
  } else {
    // 弹层被关：重新走一遍新建
    await evalJS(c, CLICK_TEXT('.btn', '＋ 新建条目'))
    await waitFor(c, "!!document.querySelector('.modal input')", 5000, 'reopen modal')
    await evalJS(c, `(() => { const inp = document.querySelector('.modal input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(inp, '断连重试条目'); inp.dispatchEvent(new Event('input', { bubbles: true })); const d = document.querySelector('.modal input[type=date]'); set.call(d, '2026-09-06'); d.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await sleep(250)
    await evalJS(c, `(() => { const b = [...document.querySelectorAll('.modal-foot .btn')].find(x => x.textContent.includes('保存')); b.click(); return true })()`)
    await waitFor(c, "!![...document.querySelectorAll('.cal-chip-title')].some(e => e.textContent === '断连重试条目')", 10000, 'retry chip2')
    await sleep(400)
    const okT2 = await evalJS(c, toastExpr('ok'))
    P('S6-08d hub 恢复后重试保存成功（条目入格 + toast）', okT2.some(t => t.includes('日程已创建')), JSON.stringify(okT2))
  }

  try { c.close() } catch {}
  try { chrome.kill() } catch {}
} catch (e) {
  console.log('FATAL: ' + (e && e.stack ? e.stack : String(e)))
  fail++
}
console.log('\n===== BROWSER SUMMARY ===== passed=' + pass + '/' + (pass + fail))
process.exit(fail === 0 ? 0 : 1)
