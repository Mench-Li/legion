import { useCallback, useEffect, useRef, useState } from 'react'
import { getToken, hubBase } from '../api'
import { toast } from './Toast'
import { TaskDetailModal } from './TaskDetailModal'
import {
  EMPTY_DRAFT, MAX_CHIPS, MAX_TITLE, WEEKDAYS,
  buildCells, buildWeekCells, conflictSummary, daysIn, dayKey, draftEnd, draftOf, draftRecurrence, draftStart,
  fmtMonth, fmtRange, fmtStart, fmtWeekRange, isAllDay, isRecurring, linkLabel, linkTarget, occKey,
  recurrenceLabel, validateDraft,
} from '../calendar'
import type { CalCell, CalDraft, CalEvent } from '../calendar'

export * from '../calendar'

/**
 * 日程日历（S6 → R-B1 前端面；数据面 = S5 后端契约；P2-5 增强）。
 *
 * 视图：月视图（7×N 网格）+ **周视图**（7 列，每列列出当天全部条目）——P2-5「更完整的视图」。
 * 数据/写源 = team-hub v2（经 serve.mjs /hub 同源代理，hubBase()）：
 *   GET  /api/calendar/events        （scope + 日期窗 [from,to] 闭区间；**重复事件在窗内展开为实例**）
 *   POST /api/calendar/events        （新建：scope/title/start/by 必填；end ≥ start；allDay；taskId/goalId/recurrence）
 *   POST /api/calendar/events/update （P2-5 局部更新：只传要改的字段）
 *   POST /api/calendar/events/delete （删除：mode=series 整串 / occurrence 仅本次 + occurrenceDate）
 *   GET  /api/calendar/conflicts     （P2-5 冲突检测：仅提示，不阻断写入）
 *
 * P2-5 语义（见 docs/REMAINING-TASKS.md P2-5）：
 *   - **时间 = 字面本地时间**：不做时区换算（不转换成 UTC、不套浏览器时区），显示与存储同值。
 *   - **重复 = 简单规则**：日/周/月 + 间隔 + 结束（日期或次数）+ 例外日；实例由后端展开，
 *     删除支持「仅本次」与「整串」。
 *   - **关联 = 双向**：事件可挂 taskId/goalId，点击可从日程跳到任务详情（任务详情侧另有「关联日程」区块）。
 *   - 渲染安全（I-5 / TC-S6-09）：标题/时间一律 React 文本节点，无 dangerouslySetInnerHTML。
 *   - 失败路径（TC-S6-03/08）：hub 不可达 / 校验失败 → toast 错误 + 网格内错误提示与重试，面板不白屏。
 *   - 空态引导（与 ChatView 语义一致，TC-S6-06）：未启中枢 → 引导启动 team-hub；未选空间 → 引导先选空间。
 */
export function CalendarView({ scope, hubMode, onOpenGoal, onGoHome }: {
  scope: string | null
  hubMode: boolean
  /** P2-5 关联跳转：点击带 goalId 的日程 → 切到目标面板（由 App 注入）。 */
  onOpenGoal?: (goalId: string) => void
  /** P2-5 关联跳转：目标面板就在首页（home），没有目标号定位能力时的兜底跳转。 */
  onGoHome?: () => void
}): React.JSX.Element {
  // ── 状态 ──
  const [view, setView] = useState<'month' | 'week'>('month')
  const [cursor, setCursor] = useState<{ y: number; m: number }>(() => {
    const t = new Date()
    return { y: t.getFullYear(), m: t.getMonth() }
  })
  /** 周视图锚点日（YYYY-MM-DD）；切到周视图时初值为今天/当月 1 号。 */
  const [weekAnchor, setWeekAnchor] = useState<string>(() => dayKey(new Date().getFullYear(), new Date().getMonth(), 1))
  const [events, setEvents] = useState<CalEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  /** 弹层：null = 关闭；'create' = 新建；事件对象 = 编辑该事件。 */
  const [editor, setEditor] = useState<CalEvent | 'create' | null>(null)
  const [draft, setDraft] = useState<CalDraft>(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)
  const [conflicts, setConflicts] = useState<Array<{ id: number; title: string; occurrenceDate?: string }>>([])
  const [pendingDelete, setPendingDelete] = useState<CalEvent | null>(null)
  /** 重复事件删除范围：series 整串 / occurrence 仅本次。 */
  const [deleteMode, setDeleteMode] = useState<'series' | 'occurrence'>('series')
  const [deleting, setDeleting] = useState(false)
  /** 拉取序号：月份/空间切换时作废在途响应，防乱序串扰（同 FilesView previewSeq 模式）。 */
  const seqRef = useRef(0)
  /** 空间身份镜像：await 期间用户切走空间 → 丢弃写回（R-A5 语义，同 ChatView scopeRef）。 */
  const scopeRef = useRef<string | null>(null)
  scopeRef.current = scope
  /** 冲突检测请求序号（防抖 + 乱序丢弃）。 */
  const conflictSeqRef = useRef(0)
  /** P2-5 关联跳转：任务详情弹层（复用 TaskDetailModal，与通知中心同一交互）。 */
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null)

  const todayTxt = dayKey(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())

  /** 当前视图要拉取的日期窗。 */
  const windowOf = useCallback((y: number, m: number, v: 'month' | 'week', anchor: string): { from: string; to: string } => {
    if (v === 'week') {
      const cells = buildWeekCells(anchor)
      return { from: cells[0].key, to: cells[6].key }
    }
    return { from: dayKey(y, m, 1), to: dayKey(y, m, daysIn(y, m)) }
  }, [])

  const loadRange = useCallback(async (scopeValue: string, y: number, m: number, v: 'month' | 'week', anchor: string): Promise<void> => {
    const seq = ++seqRef.current
    setLoading(true)
    setLoadError('')
    try {
      const w = windowOf(y, m, v, anchor)
      const data = await hubGet<unknown>(
        '/api/calendar/events?scope=' + encodeURIComponent(scopeValue) + '&from=' + w.from + '&to=' + w.to,
      )
      if (seq !== seqRef.current) return
      setEvents(toEvents(data))
    } catch (e) {
      if (seq !== seqRef.current) return
      setEvents([])
      const msg = '日程加载失败：' + errText(e)
      setLoadError(msg)
      toast('err', msg)
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [windowOf])

  const reload = useCallback((): void => {
    if (scope === null) return
    void loadRange(scope, cursor.y, cursor.m, view, weekAnchor)
  }, [scope, cursor.y, cursor.m, view, weekAnchor, loadRange])

  // 空间/视图/游标变化 → 拉取当前窗
  useEffect(() => {
    if (!hubMode || scope === null) return
    void loadRange(scope, cursor.y, cursor.m, view, weekAnchor)
  }, [hubMode, scope, cursor.y, cursor.m, view, weekAnchor, loadRange])

  // ── 空态引导（与 ChatView 一致）──
  if (!hubMode) {
    return (
      <div className="center-col">
        <div className="panel goal-card">
          <span className="tag">📅 日程日历</span>
          <div style={{ marginTop: 10, fontSize: 13, color: 'var(--muted-2)', lineHeight: 1.8 }}>
            未连接中枢（team-hub）。日程需要中枢提供事件存储与实时广播：
            <div style={{ marginTop: 6 }}>· 启动：<code>node team-hub/server.mjs</code>（默认 127.0.0.1:8787）</div>
            <div>· 或在顶栏把中枢地址设为当前运行实例。</div>
          </div>
        </div>
      </div>
    )
  }
  if (scope === null) {
    return (
      <div className="center-col">
        <div className="panel goal-card">
          <span className="tag">📅 日程日历</span>
          <div style={{ marginTop: 10, fontSize: 13, color: 'var(--muted-2)' }}>
            请先在左侧选择一个工作空间；日程按空间隔离（不同空间互不可见）。
          </div>
        </div>
      </div>
    )
  }

  const scopeValue: string = scope

  // ── 网格数据（只读于 render；按**实例日**分组，重复事件落在各自的实例格）──
  const byDay = new Map<string, CalEvent[]>()
  for (const ev of events) {
    const key = occKey(ev)
    const list = byDay.get(key)
    if (list) list.push(ev)
    else byDay.set(key, [ev])
  }
  for (const list of byDay.values()) {
    list.sort((a, b) => {
      const aa = isAllDay(a) ? 0 : 1
      const bb = isAllDay(b) ? 0 : 1
      if (aa !== bb) return aa - bb // 全天在前
      return String(a.start).localeCompare(String(b.start)) || (a.id ?? 0) - (b.id ?? 0)
    })
  }
  const cells: CalCell[] = view === 'month' ? buildCells(cursor.y, cursor.m) : buildWeekCells(weekAnchor)
  const cellEvents = (c: CalCell): CalEvent[] => byDay.get(c.key) ?? []

  /** 打开新建弹层（默认锚定今天或当前周锚点）。 */
  const openCreate = (prefillDate?: string): void => {
    const d = prefillDate ?? todayTxt
    setDraft({ ...EMPTY_DRAFT, date: d })
    setConflicts([])
    setEditor('create')
  }

  /** 打开编辑弹层：以事件当前值初始化草稿（重复事件用 occKey 作为日期项）。 */
  const openEdit = (ev: CalEvent): void => {
    setDraft(draftOf(ev))
    setConflicts([])
    setEditor(ev)
  }

  /** 冲突检测（去抖 250ms；仅提示、不阻断保存）。 */
  const checkConflicts = useCallback((d: CalDraft): void => {
    const seq = ++conflictSeqRef.current
    const scopeAtCall = scopeRef.current
    if (scopeAtCall === null) return
    if (d.allDay ? !/^\d{4}-\d{2}-\d{2}$/.test(d.date) : !/^\d{4}-\d{2}-\d{2}$/.test(d.date) || !/^\d{2}:\d{2}$/.test(d.startTime)) {
      setConflicts([])
      return
    }
    const start = draftStart(d)
    const end = draftEnd(d)
    const exclude = editor !== null && editor !== 'create' ? editor.id : null
    const path = '/api/calendar/conflicts?scope=' + encodeURIComponent(scopeAtCall)
      + '&start=' + encodeURIComponent(start)
      + (end ? '&end=' + encodeURIComponent(end) : '')
      + (d.allDay ? '&allDay=1' : '')
      + (exclude !== null ? '&excludeId=' + String(exclude) : '')
    setTimeout(() => {
      if (seq !== conflictSeqRef.current) return
      void hubGet<{ conflicts?: Array<{ id: number; title: string; occurrenceDate?: string }> }>(path)
        .then(r => { if (seq === conflictSeqRef.current) setConflicts(Array.isArray(r.conflicts) ? r.conflicts : []) })
        .catch(() => { if (seq === conflictSeqRef.current) setConflicts([]) })
    }, 250)
  }, [editor])

  /** 新建或更新（同一弹层；editor === 'create' → POST 新建，否则 POST update 局部更新）。 */
  const doSave = async (): Promise<void> => {
    const err = validateDraft(draft)
    if (err !== null) {
      toast('err', err)
      return
    }
    const isCreate = editor === 'create'
    const scopeAtCall = scopeRef.current
    const payload: Record<string, unknown> = {
      scope: scopeValue,
      title: draft.title.trim(),
      start: draftStart(draft),
      end: draftEnd(draft),
      allDay: draft.allDay,
      taskId: draft.taskId.trim() || null,
      goalId: draft.goalId.trim() || null,
      recurrence: draftRecurrence(draft),
    }
    setSaving(true)
    try {
      if (isCreate) await hubPost<{ ok?: boolean }>('/api/calendar/events', payload)
      else await hubPost<{ ok?: boolean }>('/api/calendar/events/update', { ...payload, id: (editor as CalEvent).id })
      if (scopeAtCall !== scopeRef.current) return // 空间身份守卫：await 期间切走 → 不回写当前视图
      setEditor(null)
      setConflicts([])
      toast('ok', isCreate ? '日程已创建' : '日程已更新')
      reload()
    } catch (e) {
      if (scopeAtCall !== scopeRef.current) return
      toast('err', (isCreate ? '创建失败：' : '更新失败：') + errText(e))
    } finally {
      setSaving(false)
    }
  }

  /** 删除二次确认（TC-S6-04 / I-6）：重复事件可选「仅本次」/「整串」。 */
  const confirmDelete = async (): Promise<void> => {
    const ev = pendingDelete
    if (!ev || deleting) return
    const scopeAtCall = scopeRef.current
    setDeleting(true)
    try {
      const body: Record<string, unknown> = { id: ev.id, scope: scopeValue, confirm: 'yes', mode: deleteMode }
      if (deleteMode === 'occurrence') body.occurrenceDate = occKey(ev)
      await hubPost<{ ok?: boolean }>('/api/calendar/events/delete', body)
      if (scopeAtCall !== scopeRef.current) return
      const mode = deleteMode
      setPendingDelete(null)
      setDeleteMode('series')
      if (editor !== null && editor !== 'create' && (editor as CalEvent).id === ev.id) setEditor(null)
      toast('ok', mode === 'occurrence' ? '已跳过该次日程（其余保留）' : '日程已删除')
      reload()
    } catch (e) {
      if (scopeAtCall !== scopeRef.current) return
      toast('err', '删除失败：' + errText(e))
    } finally {
      setDeleting(false)
    }
  }

  /** 月份前后翻页（月视图）/ 周前后翻页（周视图）。 */
  const goPrev = (): void => {
    if (view === 'week') setWeekAnchor(shiftDay(weekAnchor, -7))
    else setCursor(c => { const n = new Date(c.y, c.m - 1, 1); return { y: n.getFullYear(), m: n.getMonth() } })
  }
  const goNext = (): void => {
    if (view === 'week') setWeekAnchor(shiftDay(weekAnchor, 7))
    else setCursor(c => { const n = new Date(c.y, c.m + 1, 1); return { y: n.getFullYear(), m: n.getMonth() } })
  }
  const goToday = (): void => {
    const t = new Date()
    setCursor({ y: t.getFullYear(), m: t.getMonth() })
    setWeekAnchor(dayKey(t.getFullYear(), t.getMonth(), t.getDate()))
  }
  /** 月↔周切换：以当前月 1 号/今天为锚点，保持上下文连续。 */
  const switchView = (v: 'month' | 'week'): void => {
    if (v === view) return
    if (v === 'week') {
      const inMonth = todayTxt.slice(0, 7) === dayKey(cursor.y, cursor.m, 1).slice(0, 7)
      setWeekAnchor(inMonth ? todayTxt : dayKey(cursor.y, cursor.m, 1))
    } else {
      const [y, m] = weekAnchor.split('-').map(Number)
      setCursor({ y, m: m - 1 })
    }
    setView(v)
  }

  /** 点击条目：优先跳转关联（任务 → 任务详情弹层；目标 → 切到目标面板并提示），否则打开编辑。 */
  const clickEvent = (ev: CalEvent): void => {
    const target = linkTarget(ev)
    if (target && target.kind === 'task') { setDetailTaskId(target.ref); return }
    if (target && target.kind === 'goal') {
      if (onGoHome) {
        onGoHome()
        toast('ok', '已切到目标面板（关联目标 ' + target.ref + '）')
      } else if (onOpenGoal) onOpenGoal(target.ref)
      else toast('ok', '该日程关联目标 ' + target.ref + '（点开编辑可查看/修改关联）')
      return
    }
    openEdit(ev)
  }

  const titleText = view === 'month' ? fmtMonth(cursor.y, cursor.m) : fmtWeekRange(cells)

  return (
    <div className="center-col">
      <div className="panel goal-card calendar-head">
        <span className="tag">📅 日程日历</span>
        <span style={{ fontSize: 12, color: 'var(--text)' }}>
          {scopeValue}
          <span style={{ color: 'var(--muted-2)', fontSize: 11 }}>
            {' · '}{events.length}{' 条'}{view === 'month' ? '（本月）' : '（本周）'}{' · team-hub（'}{hubBase()}{'）'}
          </span>
        </span>
      </div>

      <div className="panel calendar-main">
        <div className="cal-toolbar">
          <span className="cal-nav">
            <button className="btn mini cal-prev" title={view === 'month' ? '上个月' : '上一周'} onClick={goPrev}>‹</button>
            <button className="btn mini cal-today-btn" title="回到今天" onClick={goToday}>今天</button>
            <button className="btn mini cal-next" title={view === 'month' ? '下个月' : '下一周'} onClick={goNext}>›</button>
          </span>
          <span className="cal-month-label">{titleText}</span>
          <span className="cal-view-switch" style={{ marginLeft: 10 }}>
            <button className={'btn mini' + (view === 'month' ? ' primary' : '')} style={{ marginLeft: 4 }} onClick={() => switchView('month')}>月</button>
            <button className={'btn mini' + (view === 'week' ? ' primary' : '')} style={{ marginLeft: 4 }} onClick={() => switchView('week')}>周</button>
          </span>
          <span style={{ marginLeft: 'auto' }}>
            <button className="btn primary cal-new" onClick={() => openCreate()}>＋ 新建条目</button>
          </span>
        </div>

        <div className="cal-scroll">
          <div className="cal-weekdays">
            {WEEKDAYS.map(w => (
              <div key={w} className="cal-wd">{w}</div>
            ))}
          </div>
          <div className={'cal-grid' + (view === 'week' ? ' cal-grid-week' : '')}>
            {cells.map(cell => (
              <div
                key={cell.key}
                className={'cal-cell' + (cell.cur ? '' : ' dim') + (cell.today ? ' today' : '') + (view === 'week' ? ' cal-cell-week' : '')}
                onDoubleClick={() => { if (cell.cur) openCreate(cell.key) }}
                title={cell.cur ? '双击新建该日条目' : undefined}
              >
                <div className="cal-date-row">
                  <span className={'cal-date' + (cell.today ? ' today' : '')}>{view === 'week' ? cell.key.slice(5) : cell.d}</span>
                  {cell.today && <span className="cal-today-mark">今天</span>}
                  {view === 'week' && cell.cur && (
                    <span
                      className="cal-add"
                      role="button"
                      title="在该日新建"
                      onClick={e => { e.stopPropagation(); openCreate(cell.key) }}
                    >＋</span>
                  )}
                </div>
                {cell.cur && (
                  <div className="cal-chips">
                    {cellEvents(cell).slice(0, view === 'week' ? 50 : MAX_CHIPS).map(ev => (
                      <div
                        key={String(ev.id) + '@' + occKey(ev)}
                        className={'cal-chip' + (isAllDay(ev) ? ' allday' : '')}
                        title={chipTitle(ev)}
                        onClick={e => { e.stopPropagation(); clickEvent(ev) }}
                      >
                        {!isAllDay(ev) && <span className="cal-chip-time">{fmtStart(ev.start)}</span>}
                        <span className="cal-chip-title">{ev.title}</span>
                        {isRecurring(ev) && <span className="cal-chip-flag" title={recurrenceLabel(ev.recurrence)}>🔁</span>}
                        {linkLabel(ev) !== '' && <span className="cal-chip-flag" title={linkLabel(ev)}>🔗</span>}
                        <span
                          className="cal-chip-del"
                          role="button"
                          title="删除此日程"
                          onClick={e => {
                            e.stopPropagation()
                            setDeleteMode(isRecurring(ev) ? 'occurrence' : 'series')
                            setPendingDelete(ev)
                          }}
                        >✕</span>
                      </div>
                    ))}
                    {view === 'month' && cellEvents(cell).length > MAX_CHIPS && (
                      <div className="cal-more">+{cellEvents(cell).length - MAX_CHIPS} 更多</div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          {loading && events.length === 0 && <div className="cal-footnote">⏳ 加载中…</div>}
          {!loading && events.length === 0 && !loadError && (
            <div className="cal-footnote">
              {view === 'month' ? '本月' : '本周'}暂无日程，点「＋ 新建条目」或双击日期格添加（标题 + 日期必填，时间可选）
            </div>
          )}
          {!loading && loadError && (
            <div className="cal-footnote err">
              {loadError}
              <button className="btn mini" style={{ marginLeft: 8 }} onClick={reload}>重试</button>
            </div>
          )}
        </div>

        {/* 关联图例（P2-5：说明条目上的标记含义）*/}
        <div className="cal-footnote" style={{ marginTop: 6 }}>
          🔁 = 重复日程（点开可改规则） · 🔗 = 已关联任务/目标（点击条目直接跳转） · 双击空日期格 = 快速新建
        </div>
      </div>

      {/* 新建 / 编辑弹层（P2-5：统一为同一表单；编辑走局部更新）*/}
      {editor !== null && (
        <div className="modal-mask" onClick={() => { if (!saving) setEditor(null) }}>
          <div className="modal" style={{ minWidth: 460 }} onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              {editor === 'create' ? '＋ 新建日程' : '✎ 编辑日程'}（{scopeValue}）
              <span className="x" onClick={() => { if (!saving) setEditor(null) }}>✕</span>
            </div>
            <div className="modal-body">
              <div className="field" style={{ marginBottom: 10 }}>
                <label>标题（必填，≤{String(MAX_TITLE)} 字符）</label>
                <input
                  value={draft.title}
                  maxLength={MAX_TITLE}
                  placeholder="例如：评审会 / 发布窗口"
                  onChange={e => setDraft(d => ({ ...d, title: e.target.value }))}
                  autoFocus
                />
              </div>
              <div className="field" style={{ marginBottom: 10 }}>
                <label>日期（必填）</label>
                <input
                  type="date"
                  value={draft.date}
                  onChange={e => {
                    const next = { ...draft, date: e.target.value }
                    setDraft(next)
                    checkConflicts(next)
                  }}
                />
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 8 }}>
                <input
                  type="checkbox"
                  checked={draft.allDay}
                  onChange={e => {
                    const next = { ...draft, allDay: e.target.checked, startTime: e.target.checked ? '' : draft.startTime, endTime: e.target.checked ? '' : draft.endTime }
                    setDraft(next)
                    checkConflicts(next)
                  }}
                />
                全天事件（不指定具体时刻）
              </label>
              {!draft.allDay && (
                <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
                  <div className="field" style={{ flex: 1 }}>
                    <label>开始时间（必填）</label>
                    <input
                      type="time"
                      value={draft.startTime}
                      onChange={e => {
                        const next = { ...draft, startTime: e.target.value }
                        setDraft(next)
                        checkConflicts(next)
                      }}
                    />
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label>结束时间（可选）</label>
                    <input
                      type="time"
                      value={draft.endTime}
                      onChange={e => {
                        const next = { ...draft, endTime: e.target.value }
                        setDraft(next)
                        checkConflicts(next)
                      }}
                    />
                  </div>
                </div>
              )}
              {!draft.allDay && draft.startTime && (
                <div style={{ fontSize: 11, color: 'var(--muted-2)', marginBottom: 8 }}>
                  时间区间：{draft.startTime}{draft.endTime ? '–' + draft.endTime : '（未填结束 = 默认 1 小时）'}
                  {' · '}按<b>本地字面时间</b>保存与显示，不做时区换算
                </div>
              )}
              {conflicts.length > 0 && (
                <div
                  className="cal-conflicts"
                  style={{ marginBottom: 10, padding: '6px 8px', borderRadius: 6, background: 'rgba(220,160,40,0.12)', border: '1px solid rgba(220,160,40,0.35)', fontSize: 11.5, color: 'var(--text)' }}
                >
                  ⚠️ {conflictSummary(conflicts)}
                  <div style={{ color: 'var(--muted-2)', marginTop: 3 }}>仅作提示，仍可保存（同一时段允许多条日程）</div>
                </div>
              )}

              <div style={{ borderTop: '1px solid var(--line, rgba(128,128,128,0.25))', margin: '10px 0', paddingTop: 10 }}>
                <div style={{ fontSize: 12, marginBottom: 8, color: 'var(--text)' }}>重复（可选）</div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                  <select
                    value={draft.freq}
                    onChange={e => {
                      const freq = e.target.value as CalDraft['freq']
                      const next = { ...draft, freq }
                      setDraft(next)
                    }}
                    style={{ flex: 1 }}
                  >
                    <option value="">不重复</option>
                    <option value="daily">每天</option>
                    <option value="weekly">每周</option>
                    <option value="monthly">每月</option>
                  </select>
                  {draft.freq !== '' && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                      每
                      <input
                        type="number"
                        min={1}
                        max={99}
                        value={draft.interval}
                        style={{ width: 56 }}
                        onChange={e => setDraft(d => ({ ...d, interval: e.target.value }))}
                      />
                      {draft.freq === 'daily' ? '天' : draft.freq === 'weekly' ? '周' : '月'}
                    </span>
                  )}
                </div>
                {draft.freq !== '' && (
                  <div style={{ display: 'flex', gap: 10 }}>
                    <div className="field" style={{ flex: 1 }}>
                      <label>结束日期（可选）</label>
                      <input type="date" value={draft.until} onChange={e => setDraft(d => ({ ...d, until: e.target.value }))} />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label>或次数（可选）</label>
                      <input
                        type="number"
                        min={1}
                        max={400}
                        placeholder="例如 5"
                        value={draft.count}
                        onChange={e => setDraft(d => ({ ...d, count: e.target.value }))}
                      />
                    </div>
                  </div>
                )}
                {editor !== 'create' && isRecurring(editor as CalEvent) && (
                  <div style={{ fontSize: 11, color: 'var(--muted-2)', marginTop: 6 }}>
                    当前：{recurrenceLabel((editor as CalEvent).recurrence)}
                    {((editor as CalEvent).recurrence?.exdates?.length ?? 0) > 0
                      ? ' · 已跳过：' + String((editor as CalEvent).recurrence?.exdates?.join('、'))
                      : ''}
                  </div>
                )}
              </div>

              <div style={{ borderTop: '1px solid var(--line, rgba(128,128,128,0.25))', margin: '10px 0', paddingTop: 10 }}>
                <div style={{ fontSize: 12, marginBottom: 8, color: 'var(--text)' }}>关联（可选，任务详情会反向显示本日程）</div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <div className="field" style={{ flex: 1 }}>
                    <label>任务号</label>
                    <input placeholder="例如 T-1234" value={draft.taskId} onChange={e => setDraft(d => ({ ...d, taskId: e.target.value }))} />
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label>目标号</label>
                    <input placeholder="例如 G-7" value={draft.goalId} onChange={e => setDraft(d => ({ ...d, goalId: e.target.value }))} />
                  </div>
                </div>
              </div>
            </div>
            <div className="modal-foot">
              {editor !== 'create' && (
                <button
                  className="btn danger"
                  style={{ marginRight: 'auto' }}
                  disabled={saving || deleting}
                  onClick={() => {
                    const ev = editor as CalEvent
                    setDeleteMode(isRecurring(ev) ? 'occurrence' : 'series')
                    setPendingDelete(ev)
                  }}
                >删除…</button>
              )}
              <button className="btn ghost" disabled={saving} onClick={() => setEditor(null)}>取消</button>
              <button className="btn primary" disabled={saving || !draft.title.trim() || !draft.date} onClick={() => void doSave()}>
                {saving ? '保存中…' : editor === 'create' ? '保存' : '保存修改'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除二次确认弹层（TC-S6-04；重复事件可选删除范围）*/}
      {pendingDelete && (
        <div className="modal-mask" onClick={() => { if (!deleting) setPendingDelete(null) }}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              删除日程
              <span className="x" onClick={() => { if (!deleting) setPendingDelete(null) }}>✕</span>
            </div>
            <div className="modal-body">
              <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.7 }}>
                确认删除「{pendingDelete.title}」？
                <div style={{ fontSize: 11, color: 'var(--muted-2)', marginTop: 4 }}>
                  {occKey(pendingDelete)}
                  {' ' + fmtRange(pendingDelete)}
                  {' · 空间 '}{scopeValue}{' · 删除后不可恢复'}
                </div>
              </div>
              {isRecurring(pendingDelete) && (
                <div style={{ marginTop: 10, fontSize: 12 }}>
                  <div style={{ marginBottom: 6, color: 'var(--text)' }}>这是重复日程（{recurrenceLabel(pendingDelete.recurrence)}），要删除：</div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <input type="radio" name="delmode" checked={deleteMode === 'occurrence'} onChange={() => setDeleteMode('occurrence')} />
                    仅本次（{occKey(pendingDelete)}）——其余保留
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input type="radio" name="delmode" checked={deleteMode === 'series'} onChange={() => setDeleteMode('series')} />
                    删除整串（所有重复实例）
                  </label>
                </div>
              )}
            </div>
            <div className="modal-foot">
              <button className="btn ghost" disabled={deleting} onClick={() => setPendingDelete(null)}>取消</button>
              <button className="btn danger" disabled={deleting} onClick={() => void confirmDelete()}>
                {deleting ? '删除中…' : deleteMode === 'occurrence' ? '跳过本次' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* P2-5 关联跳转：任务详情弹层（复用 TaskDetailModal，双向关联的「日程 → 任务」方向）*/}
      {detailTaskId !== null && <TaskDetailModal taskId={detailTaskId} onClose={() => setDetailTaskId(null)} />}
    </div>
  )
}

/** 条目悬停说明：时间区段 + 重复规则 + 关联（P2-5）。 */
function chipTitle(ev: CalEvent): string {
  const parts = [ev.title, fmtRange(ev)]
  if (isRecurring(ev)) parts.push(recurrenceLabel(ev.recurrence))
  const link = linkLabel(ev)
  if (link !== '') parts.push(link)
  return parts.join(' · ')
}

/** 日期偏移（本地分量，避免时区偏移错格）。 */
function shiftDay(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d + delta)
  return dayKey(dt.getFullYear(), dt.getMonth(), dt.getDate())
}

/** GET 请求（经 /hub 同源代理 → team-hub；非 2xx 抛含响应体摘要的错误）。 */
async function hubGet<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers.Authorization = 'Bearer ' + token
  const res = await fetch(hubBase() + path, { headers })
  if (!res.ok) throw new Error(await apiErrText(res, 'GET ' + path))
  return res.json() as Promise<T>
}

/** POST 请求（JSON body；by 缺省 general —— 与 api.ts hubPost 写纪律一致）。 */
async function hubPost<T = { ok: boolean }>(path: string, body: Record<string, unknown>): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = getToken()
  if (token) headers.Authorization = 'Bearer ' + token
  const res = await fetch(hubBase() + path, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body, by: body.by ?? 'general' }),
  })
  if (!res.ok) throw new Error(await apiErrText(res, 'POST ' + path))
  return res.json() as Promise<T>
}

async function apiErrText(res: Response, label: string): Promise<string> {
  const text = await res.text().catch(() => '')
  const head = text.replace(/\s+/g, ' ').trim().slice(0, 160)
  return String(res.status) + (head ? '：' + head : '（' + label + '失败）')
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** GET 响应信封兼容：裸数组 或 {events:[…]}（对齐 S5 实现前不锁死包法）。 */
function toEvents(data: unknown): CalEvent[] {
  if (Array.isArray(data)) return data as CalEvent[]
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>
    if (Array.isArray(d.events)) return d.events as CalEvent[]
    if (Array.isArray(d.items)) return d.items as CalEvent[]
    if (Array.isArray(d.list)) return d.list as CalEvent[]
  }
  return []
}
