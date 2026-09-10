/**
 * calendar-ui.test.mjs — 日程日历前端纯函数回归（P2-5）。
 *
 * 覆盖 workbench/src/calendar.ts（从 CalendarView.tsx 抽出、DOM-free）：
 *   实例日归组、时间区段文本、周视图网格与标题、重复文案、关联跳转、草稿生成/校验/入参拼装、冲突提示。
 * 运行：node --test --experimental-strip-types workbench/scripts/calendar-ui.test.mjs
 * 说明：这些是**前端展示与前端校验**口径；后端契约（展开/冲突/更新/关联）见 team-hub/calendar.test.mjs。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_DRAFT, MAX_TITLE,
  buildCells, buildWeekCells, conflictSummary, draftEnd, draftOf, draftRecurrence, draftStart,
  fmtMonth, fmtRange, fmtStart, fmtWeekRange, isAllDay, isRecurring, linkLabel, linkTarget,
  occKey, recurrenceLabel, validateDraft,
} from '../src/calendar.ts'

const ev = (o) => ({ id: 1, scope: 's', title: 'T', start: '2026-09-01T10:00', ...o })

test('实例日归组：优先 occurrenceDate（重复实例），缺省回退 start 日期', () => {
  assert.equal(occKey(ev({})), '2026-09-01')
  assert.equal(occKey(ev({ occurrenceDate: '2026-09-08' })), '2026-09-08')
  assert.equal(occKey(ev({ start: '2026-09-01', allDay: true })), '2026-09-01')
  // 异常值兜底：occurrenceDate 过短 → 回退 start
  assert.equal(occKey(ev({ occurrenceDate: '2026' })), '2026-09-01')
})

test('全天判定与时间文本：全天 / 单点 / 区间', () => {
  assert.equal(isAllDay(ev({ start: '2026-09-01', allDay: true })), true)
  assert.equal(isAllDay(ev({ start: '2026-09-01' })), true, 'date-only 视为全天')
  assert.equal(isAllDay(ev({})), false)
  assert.equal(fmtStart('2026-09-01T09:30:15'), '09:30', '秒被截断')
  assert.equal(fmtStart('2026-09-01'), '')
  assert.equal(fmtRange(ev({ start: '2026-09-01', allDay: true })), '全天')
  assert.equal(fmtRange(ev({})), '10:00', '无 end → 仅起点')
  assert.equal(fmtRange(ev({ end: '2026-09-01T11:30' })), '10:00–11:30')
  assert.equal(fmtRange(ev({ end: '2026-09-01T10:00' })), '10:00', 'end == start → 不重复显示')
})

test('周视图网格：以锚点所在周的周一为起点，跨月/跨年正确', () => {
  const w = buildWeekCells('2026-09-03') // 周四
  assert.equal(w.length, 7)
  assert.deepEqual(w.map(c => c.key), [
    '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06',
  ])
  assert.ok(w.every(c => c.cur === true), '周视图 7 格都属当前范围')
  // 跨年：2027-01-01 是周五 → 周一为 2026-12-28
  const w2 = buildWeekCells('2027-01-01')
  assert.equal(w2[0].key, '2026-12-28')
  assert.equal(w2[6].key, '2027-01-03')
  // 锚点就是周一 → 不回退
  const w3 = buildWeekCells('2026-08-31')
  assert.equal(w3[0].key, '2026-08-31')
})

test('周视图标题与月标题：跨月/同年/跨年三种写法', () => {
  assert.equal(fmtMonth(2026, 8), '2026年9月')
  assert.equal(fmtWeekRange(buildWeekCells('2026-09-03')), '2026年8月31日 – 9月6日', '跨月带两段月份')
  assert.equal(fmtWeekRange(buildWeekCells('2026-09-10')), '2026年9月7–13日', '同月省略重复月份')
  assert.equal(fmtWeekRange(buildWeekCells('2026-12-31')), '2026年12月28日 – 2027年1月3日', '跨年带两段年份')
  assert.equal(fmtWeekRange([]), '', '长度非 7 → 空串兜底')
})

test('月网格：网格总格数为 7 的倍数且当月天数齐全（回归既有 buildCells 语义）', () => {
  const c = buildCells(2026, 8) // 2026-09：9/1 周二
  assert.equal(c.length % 7, 0)
  assert.equal(c.filter(x => x.cur).length, 30)
  assert.equal(c[0].key, '2026-08-31', '周一起始 → 首位是上月 8/31')
})

test('重复标识与文案：不重复 / 每天 / 每 2 周 / 含结束条件 / 含例外数', () => {
  assert.equal(isRecurring(ev({})), false)
  assert.equal(isRecurring(ev({ recurring: true })), true, '后端展开标记')
  assert.equal(isRecurring(ev({ recurrence: { freq: 'daily', interval: 1 } })), true, '规则存在')
  assert.equal(recurrenceLabel(null), '不重复')
  assert.equal(recurrenceLabel({ freq: 'daily', interval: 1 }), '每天')
  assert.equal(recurrenceLabel({ freq: 'weekly', interval: 2 }), '每 2 周')
  assert.equal(recurrenceLabel({ freq: 'monthly', interval: 1, until: '2026-12-31' }), '每月 · 至 2026-12-31')
  assert.equal(recurrenceLabel({ freq: 'daily', interval: 1, count: 5 }), '每天 · 共 5 次')
  assert.equal(
    recurrenceLabel({ freq: 'daily', interval: 1, count: 5, exdates: ['2026-09-03', '2026-09-04'] }),
    '每天 · 共 5 次 · 已跳过 2 天',
  )
})

test('关联：文案与跳转目标（任务优先，其次目标）', () => {
  assert.equal(linkLabel(ev({})), '')
  assert.equal(linkLabel(ev({ taskId: 'T-12' })), '🔗 T-12')
  assert.equal(linkLabel(ev({ taskId: 'T-12', goalId: 'G-3' })), '🔗 T-12 / G-3')
  assert.equal(linkLabel(ev({ goalId: 'G-3' })), '🔗 G-3')
  assert.deepEqual(linkTarget(ev({})), null)
  assert.deepEqual(linkTarget(ev({ taskId: 'T-12', goalId: 'G-3' })), { kind: 'task', ref: 'T-12' }, '任务号更具体 → 优先')
  assert.deepEqual(linkTarget(ev({ goalId: 'G-3' })), { kind: 'goal', ref: 'G-3' })
  assert.deepEqual(linkTarget(ev({ taskId: '  ' })), null, '空白视为未关联')
  assert.deepEqual(linkTarget(ev({ taskId: ' T-9 ' })), { kind: 'task', ref: 'T-9' }, '两侧空白被裁剪')
})

test('草稿生成：由事件还原表单（全天/时间/重复/关联）', () => {
  const d1 = draftOf(ev({ start: '2026-09-01', allDay: true }))
  assert.equal(d1.date, '2026-09-01')
  assert.equal(d1.allDay, true)
  assert.equal(d1.startTime, '', '全天 → 时间留空')
  assert.equal(d1.freq, '')
  const d2 = draftOf(ev({
    start: '2026-09-01T10:00', end: '2026-09-01T11:00', taskId: 'T-1', goalId: 'G-2',
    recurrence: { freq: 'weekly', interval: 2, until: '2026-10-01' },
  }))
  assert.equal(d2.startTime, '10:00')
  assert.equal(d2.endTime, '11:00')
  assert.equal(d2.taskId, 'T-1')
  assert.equal(d2.goalId, 'G-2')
  assert.equal(d2.freq, 'weekly')
  assert.equal(d2.interval, '2')
  assert.equal(d2.until, '2026-10-01')
  assert.equal(d2.count, '', '未设 count → 空串（表单可编辑）')
  // 重复事件的编辑日期取**实例日**（编辑某一次的实例）
  const d3 = draftOf(ev({ occurrenceDate: '2026-09-08', recurring: true, recurrence: { freq: 'weekly', interval: 1, count: 3 } }))
  assert.equal(d3.date, '2026-09-08')
  assert.equal(d3.count, '3')
})

test('表单校验：标题/日期/时间/区间/重复四类错误', () => {
  const ok = { ...EMPTY_DRAFT, title: '会', date: '2026-09-01', startTime: '10:00' }
  assert.equal(validateDraft(ok), null)
  assert.equal(validateDraft({ ...ok, title: '   ' }), '请输入日程标题')
  assert.equal(validateDraft({ ...ok, title: 'x'.repeat(MAX_TITLE + 1) }), '标题过长（上限 100 字符）')
  assert.equal(validateDraft({ ...ok, date: '' }), '请选择日期')
  assert.equal(validateDraft({ ...ok, date: '2026/09/01' }), '请选择日期', '格式不符即拒')
  assert.equal(validateDraft({ ...ok, date: '2026-13-01' }), '日期无效（须为真实存在的 YYYY-MM-DD）', '月份越界')
  assert.equal(validateDraft({ ...ok, date: '2026-02-30' }), '日期无效（须为真实存在的 YYYY-MM-DD）', '不存在的日期')
  assert.equal(validateDraft({ ...ok, startTime: '' }), '开始时间格式无效（例 09:30）')
  assert.equal(validateDraft({ ...ok, startTime: '25:00' }), '开始时间格式无效（例 09:30）')
  assert.equal(validateDraft({ ...ok, endTime: '9:00' }), '结束时间格式无效（例 11:00）')
  assert.equal(validateDraft({ ...ok, endTime: '09:00' }), '结束时间不得早于开始时间')
  assert.equal(validateDraft({ ...ok, endTime: '10:00' }), null, '首尾相接允许')
  // 全天：不校验时间
  assert.equal(validateDraft({ ...EMPTY_DRAFT, title: 'x', date: '2026-09-01', allDay: true }), null)
})

test('表单校验：重复参数（间隔/结束条件二选一/次数范围）', () => {
  const base = { ...EMPTY_DRAFT, title: 'x', date: '2026-09-01', startTime: '10:00', freq: 'daily' }
  assert.equal(validateDraft(base), null)
  assert.equal(validateDraft({ ...base, interval: '0' }), '重复间隔必须是 1-99 的整数')
  assert.equal(validateDraft({ ...base, interval: '1.5' }), '重复间隔必须是 1-99 的整数')
  assert.equal(validateDraft({ ...base, interval: '100' }), '重复间隔必须是 1-99 的整数')
  assert.equal(validateDraft({ ...base, until: '2026-13-01' }), '重复结束日期格式无效（YYYY-MM-DD）')
  assert.equal(validateDraft({ ...base, until: '2026-12-01', count: '5' }), '重复的「结束日期」与「次数」只能填一个')
  assert.equal(validateDraft({ ...base, count: '0' }), '重复次数必须是 1-400 的整数')
  assert.equal(validateDraft({ ...base, count: '401' }), '重复次数必须是 1-400 的整数')
  assert.equal(validateDraft({ ...base, count: '5' }), null)
})

test('入参拼装：start/end/recurrence 三件套（全天与带时刻、清空重复）', () => {
  const timed = { ...EMPTY_DRAFT, title: 'x', date: '2026-09-01', startTime: '10:00', endTime: '11:30' }
  assert.equal(draftStart(timed), '2026-09-01T10:00')
  assert.equal(draftEnd(timed), '2026-09-01T11:30')
  assert.equal(draftRecurrence(timed), null, '未选频率 → null（后端据此清空重复）')
  const allday = { ...EMPTY_DRAFT, title: 'x', date: '2026-09-01', allDay: true }
  assert.equal(draftStart(allday), '2026-09-01', '全天 → date-only')
  assert.equal(draftEnd(allday), null)
  const noEnd = { ...EMPTY_DRAFT, date: '2026-09-01', startTime: '10:00' }
  assert.equal(draftEnd(noEnd), null, '未填结束 → null（后端按 1 小时参与冲突检测）')
  assert.deepEqual(
    draftRecurrence({ ...timed, freq: 'weekly', interval: '2', until: '2026-10-01' }),
    { freq: 'weekly', interval: 2, until: '2026-10-01' },
  )
  assert.deepEqual(
    draftRecurrence({ ...timed, freq: 'daily', interval: '', count: '3' }),
    { freq: 'daily', interval: 1, count: 3 },
    '间隔空值兜底为 1',
  )
})

test('冲突提示文案：0 项为空串；1-3 项列全；>3 项折叠为「等」', () => {
  assert.equal(conflictSummary([]), '')
  assert.equal(conflictSummary([{ title: 'A' }]), '与 1 项日程重叠：A')
  assert.equal(
    conflictSummary([{ title: 'A', occurrenceDate: '2026-09-01' }, { title: 'B' }]),
    '与 2 项日程重叠：A（2026-09-01）、B',
  )
  assert.equal(
    conflictSummary([{ title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' }]),
    '与 4 项日程重叠：A、B、C 等',
  )
})
