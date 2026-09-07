// T-088 纯函数单测：CalendarView 网格/日期工具（真实执行；TC-S6-01/02/05/07 计算核心）
import { buildCells, dayKey, daysIn, fmtMonth, fmtStart, isAllDay, todayKey, MAX_TITLE } from './calendar-view.node.mjs'
let pass = 0, fail = 0
const P = (n, c, x = '') => { if (c) { pass++; console.log('PASS ' + n + (x ? ' | ' + x : '')) } else { fail++; console.log('FAIL ' + n + (x ? ' | ' + x : '')) } }

// 1) 2026-09 网格（周一起始）：9/1 周二 → lead=1；30 天 → 35 格 5 行
const sep = buildCells(2026, 8)
P('grid 2026-09: 7×N 共 35 格', sep.length === 35 && sep.length % 7 === 0, 'len=' + sep.length)
P('grid 2026-09: 当月 30 格 + 5 格补位', sep.filter(c => c.cur).length === 30 && sep.filter(c => !c.cur).length === 5)
P('grid 2026-09: 月首对齐（9/1 在第 2 列，周一起始）', sep[1].key === '2026-09-01' && sep[1].d === 1 && sep[1].cur, JSON.stringify(sep.slice(0, 3).map(c => c.key)))
P('grid 2026-09: 补位格来自前月 8/31 与次月 10/1..', sep[0].key === '2026-08-31' && !sep[0].cur && sep[sep.length - 4].key === '2026-10-01' && !sep[sep.length - 4].cur)
P('grid 2026-09: 月末 9/30 位置正确', sep.find(c => c.key === '2026-09-30').cur === true && sep.indexOf(sep.find(c => c.key === '2026-09-30')) === 30)

// 2) 今天高亮（TC-S6-01e/07b）：今天标记仅当月当天格；非当月不标
const tk = todayKey() // 依系统时钟
const y = Number(tk.slice(0, 4)), mo = Number(tk.slice(5, 7)) - 1, d = Number(tk.slice(8, 10))
const curGrid = buildCells(y, mo)
const todayCells = curGrid.filter(c => c.today)
P('grid 今天高亮：恰 1 格且为当天 ' + tk, todayCells.length === 1 && todayCells[0].key === tk && todayCells[0].d === d, JSON.stringify(todayCells))
// 其它月份不含 today
const prevM = new Date(y, mo - 1, 1)
const prevCells = buildCells(prevM.getFullYear(), prevM.getMonth())
P('grid 其它月份无今天高亮', prevCells.every(c => c.today === false))
// 边界月跨年：2026-01（1/1 周四 → lead=3）、2026-12（12/1 周二 lead=1）
const jan = buildCells(2026, 0)
const janFirst = new Date(2026, 0, 1).getDay(); const janLead = (janFirst + 6) % 7
P('grid 2026-01 月首对齐（lead=' + janLead + '）', jan[janLead].key === '2026-01-01' && jan.length % 7 === 0, 'lead=' + janLead + ' first=' + jan[janLead].key)
const dec = buildCells(2026, 11)
const decFirst = new Date(2026, 11, 1).getDay(); const decLead = (decFirst + 6) % 7
P('grid 2026-12 月首对齐 + 补位跨年 2027', dec[decLead].key === '2026-12-01' && dec.length % 7 === 0 && dec.some(c => c.key.startsWith('2027-01')), 'tail=' + dec.slice(-2).map(c => c.key).join(','))

// 3) 键/格式辅助（S6-02 新建 start、S6-05 数据键）
P('dayKey/daysIn 2026-09 → 30 天', daysIn(2026, 8) === 30 && dayKey(2026, 8, 5) === '2026-09-05')
P('fmtMonth → 「2026年9月」', fmtMonth(2026, 8) === '2026年9月')
P('isAllDay date-only=true / 带时间=false', isAllDay({ allDay: true, start: '2026-09-05' }) === true && isAllDay({ allDay: false, start: '2026-09-10T10:30' }) === false && isAllDay({ start: '2026-09-05' }) === true)
P('fmtStart 带时间取 HH:mm / 全天空串', fmtStart('2026-09-10T10:30') === '10:30' && fmtStart('2026-09-05') === '')
P('MAX_TITLE=100（与 S5 后端对齐）', MAX_TITLE === 100)

console.log('\n===== GRID-UNIT SUMMARY ===== passed=' + pass + '/' + (pass + fail))
process.exit(fail === 0 ? 0 : 1)
