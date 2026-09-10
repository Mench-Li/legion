/**
 * calendar.ts — 日程日历的**纯函数与类型**（P2-5：从 CalendarView.tsx 抽出，便于 node:test 直测）。
 *
 * 设计约束（与后端 team-hub 契约对齐，docs/TEST_CASES.md TC-S5-*、docs/REMAINING-TASKS.md P2-5）：
 * - **无 DOM、无 React、无 IO**：本模块只做日期/文本/校验计算，可被 Node（--experimental-strip-types）
 *   直接导入测试；组件（CalendarView.tsx）从这里取用，不再自带逻辑。
 * - **一律本地字面时间（naive local）**：日期算术只用 Y-M-D 分量与本地 Date，绝不引入 UTC 偏移，
 *   以免出现「格错一天」；这也与后端「字面本地时间、零时区换算」的语义一致。
 */

/** 与后端 MAX_CALENDAR_TITLE 对齐的标题上限（TC-S5-05 / TC-S6-03②）。 */
export const MAX_TITLE = 100
/** 单格直显条数上限，超出折叠为「+N 更多」。 */
export const MAX_CHIPS = 3

export const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

/** 重复频率（与后端 recurrence.freq 同构）。 */
export type CalRecurFreq = 'daily' | 'weekly' | 'monthly'

/** 重复规则（简单重复：日/周/月 + 间隔 + 结束条件 + 例外日；后端 parseRecurrence 同构）。 */
export interface CalRecurrence {
  freq: CalRecurFreq
  interval: number
  /** 结束日期（YYYY-MM-DD）；与 count 二选一。 */
  until?: string
  /** 次数上限；与 until 二选一。 */
  count?: number
  /** 例外日（被跳过的实例日）。 */
  exdates?: string[]
}

export interface CalEvent {
  id: number
  scope: string
  title: string
  /** 'YYYY-MM-DD'（全天）或 'YYYY-MM-DDTHH:mm[:ss]'（带时间）。 */
  start: string
  end?: string | null
  allDay?: boolean
  /** P2-5：关联的任务 / 目标（null = 未关联）。 */
  taskId?: string | null
  goalId?: string | null
  /** P2-5：重复规则（null = 单次事件）。 */
  recurrence?: CalRecurrence | null
  /** P2-5：本次展开的实例日（列表带窗时由后端给出；缺省回退 start 日期）。 */
  occurrenceDate?: string
  /** P2-5：是否重复事件的实例。 */
  recurring?: boolean
  meta?: unknown
  createdAt?: string
  updatedAt?: string
}

export interface CalCell {
  key: string
  /** 是否属于当前展示范围（false = 补位格，置灰、不显示条目）。 */
  cur: boolean
  /** 本地日期是否今天。 */
  today: boolean
  d: number
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 本地日期键 'YYYY-MM-DD'。 */
export function dayKey(y: number, m: number, d: number): string {
  return String(y) + '-' + pad2(m + 1) + '-' + pad2(d)
}

export function daysIn(y: number, m: number): number {
  return new Date(y, m + 1, 0).getDate()
}

export function todayKey(): string {
  const t = new Date()
  return dayKey(t.getFullYear(), t.getMonth(), t.getDate())
}

export function fmtMonth(y: number, m: number): string {
  return String(y) + '年' + String(m + 1) + '月'
}

/** 当月 7×N 网格（周一起始，月首前补位/月末后补位，行数 = ceil((补位+当月天数)/7)）。 */
export function buildCells(y: number, m: number): CalCell[] {
  const firstDow = new Date(y, m, 1).getDay() // 0=周日
  const lead = (firstDow + 6) % 7 // 周一前补位格数
  const total = daysIn(y, m)
  const tk = todayKey()
  const out: CalCell[] = []
  const py = m === 0 ? y - 1 : y // 上个月
  const pm = m === 0 ? 11 : m - 1
  const prevTotal = daysIn(py, pm)
  for (let i = lead - 1; i >= 0; i -= 1) {
    const d = prevTotal - i
    out.push({ key: dayKey(py, pm, d), cur: false, today: false, d })
  }
  for (let d = 1; d <= total; d += 1) {
    const key = dayKey(y, m, d)
    out.push({ key, cur: true, today: key === tk, d })
  }
  const ny = m === 11 ? y + 1 : y // 下个月
  const nm = m === 11 ? 0 : m + 1
  let d = 1
  while (out.length % 7 !== 0) {
    out.push({ key: dayKey(ny, nm, d), cur: false, today: false, d })
    d += 1
  }
  return out
}

/** 周视图 7 格：以 anchor（YYYY-MM-DD，任意日）所在周的周一为起点（P2-5 更完整视图）。 */
export function buildWeekCells(anchor: string): CalCell[] {
  const [y, m, d] = anchor.split('-').map(Number)
  const base = new Date(y, m - 1, d)
  const dow = base.getDay() // 0=周日
  const back = (dow + 6) % 7 // 回退到周一
  const tk = todayKey()
  const out: CalCell[] = []
  for (let i = 0; i < 7; i += 1) {
    const dt = new Date(y, m - 1, d - back + i)
    const key = dayKey(dt.getFullYear(), dt.getMonth(), dt.getDate())
    out.push({ key, cur: true, today: key === tk, d: dt.getDate() })
  }
  return out
}

/** 周视图标题：'2026年9月1日 – 9月7日'（跨月/跨年时各自带年月）。 */
export function fmtWeekRange(cells: CalCell[]): string {
  if (cells.length !== 7) return ''
  const a = cells[0].key
  const b = cells[6].key
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  if (ay !== by) return `${ay}年${am}月${ad}日 – ${by}年${bm}月${bd}日`
  if (am !== bm) return `${ay}年${am}月${ad}日 – ${bm}月${bd}日`
  return `${ay}年${am}月${ad}–${bd}日`
}

/**
 * 实例日（P2-5）：优先用后端展开给出的 occurrenceDate（重复事件的实例日），
 * 缺省回退 start 的日期前缀（单次事件 / 未展开的响应）。
 */
export function occKey(ev: CalEvent): string {
  const o = ev.occurrenceDate
  if (typeof o === 'string' && o.length >= 10) return o.slice(0, 10)
  return String(ev.start).slice(0, 10)
}

/** 全天判定：显式 allDay 或 start 无时间部分（date-only）。 */
export function isAllDay(ev: CalEvent): boolean {
  return ev.allDay === true || String(ev.start).indexOf('T') < 0
}

/** 取 start 时间段文本（'10:00'）；全天/缺省返回 ''。 */
export function fmtStart(start: string): string {
  const ti = start.indexOf('T')
  return ti >= 0 ? start.slice(ti + 1, ti + 6) : ''
}

/** 时间区段文本（P2-5）：'10:00–11:30' / '10:00' / '全天'。 */
export function fmtRange(ev: CalEvent): string {
  if (isAllDay(ev)) return '全天'
  const s = fmtStart(ev.start)
  const e = ev.end ? fmtStart(String(ev.end)) : ''
  return e && e !== s ? s + '–' + e : s
}

/** 是否为重复事件（规则存在或后端标记 recurring）。 */
export function isRecurring(ev: CalEvent): boolean {
  return ev.recurring === true || (ev.recurrence !== null && ev.recurrence !== undefined)
}

/** 重复规则文案（P2-5 UI）：'每天' / '每 2 周' / '每月 · 至 2026-12-31' / '每天 · 共 5 次'（含例外数）。 */
export function recurrenceLabel(rec: CalRecurrence | null | undefined): string {
  if (!rec) return '不重复'
  const unit = rec.freq === 'daily' ? '天' : rec.freq === 'weekly' ? '周' : '月'
  const base = rec.interval === 1 ? '每' + unit : '每 ' + String(rec.interval) + ' ' + unit
  const parts = [base]
  if (rec.until) parts.push('至 ' + rec.until)
  if (rec.count) parts.push('共 ' + String(rec.count) + ' 次')
  if (rec.exdates && rec.exdates.length > 0) parts.push('已跳过 ' + String(rec.exdates.length) + ' 天')
  return parts.join(' · ')
}

/** 关联文案：'🔗 T-12 / G-3'、'🔗 T-12'、''（无关联）。 */
export function linkLabel(ev: CalEvent): string {
  const parts: string[] = []
  if (ev.taskId) parts.push(String(ev.taskId))
  if (ev.goalId) parts.push(String(ev.goalId))
  return parts.length > 0 ? '🔗 ' + parts.join(' / ') : ''
}

/** 关联跳转目标（任务优先，其次目标）——与通知中心 jumpOf 的「动作域优先」不同：
 *  日程的关联是**显式字段**，任务号更具体，故任务优先。 */
export function linkTarget(ev: CalEvent): { kind: 'task' | 'goal'; ref: string } | null {
  if (ev.taskId && String(ev.taskId).trim().length > 0) return { kind: 'task', ref: String(ev.taskId).trim() }
  if (ev.goalId && String(ev.goalId).trim().length > 0) return { kind: 'goal', ref: String(ev.goalId).trim() }
  return null
}

/** 草稿（新建/编辑弹层的表单态）。 */
export interface CalDraft {
  title: string
  date: string
  startTime: string
  endTime: string
  allDay: boolean
  taskId: string
  goalId: string
  /** 重复频率；'' = 不重复。 */
  freq: '' | CalRecurFreq
  interval: string
  until: string
  count: string
}

export const EMPTY_DRAFT: CalDraft = {
  title: '', date: '', startTime: '', endTime: '', allDay: false,
  taskId: '', goalId: '', freq: '', interval: '1', until: '', count: '',
}

/** 由事件生成编辑草稿（编辑弹层初始化）。 */
export function draftOf(ev: CalEvent): CalDraft {
  const allDay = isAllDay(ev)
  const rec = ev.recurrence ?? null
  return {
    title: ev.title,
    date: occKey(ev),
    startTime: allDay ? '' : fmtStart(ev.start),
    endTime: !allDay && ev.end ? fmtStart(String(ev.end)) : '',
    allDay,
    taskId: ev.taskId ?? '',
    goalId: ev.goalId ?? '',
    freq: rec ? rec.freq : '',
    interval: rec ? String(rec.interval) : '1',
    until: rec?.until ?? '',
    count: rec?.count !== undefined ? String(rec.count) : '',
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/** 日期字符串是否合法**且真实存在**（与后端 parseCalendarTime 的回环校验同口径：拒 2026-13-01 / 2026-02-30）。 */
export function isValidDateStr(s: string): boolean {
  if (!DATE_RE.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  if (m < 1 || m > 12) return false
  const dt = new Date(y, m - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
}

/** 表单校验（纯函数，返回错误文案或 null）：与后端 400 语义对齐的前置拦截。 */
export function validateDraft(d: CalDraft): string | null {
  const title = d.title.trim()
  if (!title) return '请输入日程标题'
  if (title.length > MAX_TITLE) return '标题过长（上限 ' + String(MAX_TITLE) + ' 字符）'
  if (!DATE_RE.test(d.date)) return '请选择日期'
  if (!isValidDateStr(d.date)) return '日期无效（须为真实存在的 YYYY-MM-DD）'
  if (d.allDay) {
    if (d.freq !== '' && d.until !== '' && !isValidDateStr(d.until)) return '结束日期格式无效（YYYY-MM-DD）'
    return validateRecurrence(d)
  }
  if (!TIME_RE.test(d.startTime)) return '开始时间格式无效（例 09:30）'
  if (d.endTime && !TIME_RE.test(d.endTime)) return '结束时间格式无效（例 11:00）'
  if (d.endTime && d.endTime < d.startTime) return '结束时间不得早于开始时间'
  return validateRecurrence(d)
}

/** 重复部分校验：间隔/次数的整数与范围，until 与 count 二选一。 */
function validateRecurrence(d: CalDraft): string | null {
  if (d.freq === '') return null
  const interval = Number(d.interval)
  if (!Number.isInteger(interval) || interval < 1 || interval > 99) return '重复间隔必须是 1-99 的整数'
  if (d.until !== '' && !isValidDateStr(d.until)) return '重复结束日期格式无效（YYYY-MM-DD）'
  if (d.until !== '' && d.count.trim() !== '') return '重复的「结束日期」与「次数」只能填一个'
  if (d.count.trim() !== '') {
    const c = Number(d.count)
    if (!Number.isInteger(c) || c < 1 || c > 400) return '重复次数必须是 1-400 的整数'
  }
  return null
}

/** 由草稿生成 start/end 字符串（全天 = date-only；带时间 = date+T HH:mm）。 */
export function draftStart(d: CalDraft): string {
  return d.allDay ? d.date : d.date + 'T' + d.startTime
}

export function draftEnd(d: CalDraft): string | null {
  if (d.allDay) return null
  return d.endTime ? d.date + 'T' + d.endTime : null
}

/** 由草稿生成 recurrence 入参（'' freq → null = 清空重复）。 */
export function draftRecurrence(d: CalDraft): CalRecurrence | null {
  if (d.freq === '') return null
  const out: CalRecurrence = { freq: d.freq, interval: Number(d.interval) || 1 }
  if (d.until !== '') out.until = d.until
  if (d.count.trim() !== '') out.count = Number(d.count)
  return out
}

/** 重叠提示文案（P2-5 冲突检测展示；仅提示、不阻断写入）。 */
export function conflictSummary(conflicts: Array<{ title: string; occurrenceDate?: string }>): string {
  if (conflicts.length === 0) return ''
  const head = conflicts.slice(0, 3).map(c => c.title + (c.occurrenceDate ? '（' + c.occurrenceDate + '）' : '')).join('、')
  return conflicts.length > 3 ? '与 ' + String(conflicts.length) + ' 项日程重叠：' + head + ' 等' : '与 ' + String(conflicts.length) + ' 项日程重叠：' + head
}

/** 默认时间区间提示（后端冲突检测对缺省 end 的假设：1 小时）。 */
export const DEFAULT_DURATION_MIN = 60
