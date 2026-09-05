import { useCallback, useEffect, useRef, useState } from 'react'
import { getToken, hubBase } from '../api'
import { toast } from './Toast'

/**
 * 日程日历（S6 ← R-B1，前端面；数据面 = S5 后端契约）。
 * 自研月视图：7×N CSS grid、今天高亮、跨月切换、标题+日期必填新建、删除二次确认。
 * - 数据/写源 = team-hub v2（经 serve.mjs /hub 同源代理，hubBase()）：
 *   GET /api/calendar/events（scope + 日期窗 [from,to] 闭区间，scope=当前空间 → 隔离互不串，TC-S5-03/04）、
 *   POST /api/calendar/events（新建：scope/title/start/by 必填，end 可选 ≥ start，allDay=全天）、
 *   POST /api/calendar/events/delete（删除：{id, confirm:'yes', scope, by}，缺 confirm/越权 400/404 —— TC-S5-07/H-2）。
 * - GET 响应信封兼容解析（裸数组 或 {events:[…]}），对齐 S5 实现前不锁死包法。
 * - 渲染安全（I-5 / TC-S6-09）：标题/时间一律 React 文本节点，无 dangerouslySetInnerHTML。
 * - 失败路径（TC-S6-03/08）：hub 不可达 / 校验失败 → toast 错误、面板不白屏不崩溃；网格内给出错误提示 + 重试。
 * - 空态引导（与 ChatView 语义一致，TC-S6-06）：未启中枢 → 引导启动 team-hub；未选具体空间 → 引导先选空间。
 */
export function CalendarView({ scope, hubMode }: { scope: string | null; hubMode: boolean }): React.JSX.Element {
  // ── 状态 ──
  const [cursor, setCursor] = useState<{ y: number; m: number }>(() => {
    const t = new Date()
    return { y: t.getFullYear(), m: t.getMonth() }
  })
  const [events, setEvents] = useState<CalEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [creating, setCreating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftDate, setDraftDate] = useState('')
  const [draftTime, setDraftTime] = useState('')
  const [pendingDelete, setPendingDelete] = useState<CalEvent | null>(null)
  const [deleting, setDeleting] = useState(false)
  /** 拉取序号：月份/空间切换时作废在途响应，防乱序串显（同 FilesView previewSeq 模式）。 */
  const seqRef = useRef(0)
  /** 空间身份镜像：await 期间用户切走空间 → 丢弃写回（R-A5 语义，同 ChatView scopeRef）。 */
  const scopeRef = useRef<string | null>(null)
  scopeRef.current = scope

  const todayTxt = todayKey()

  // 拉当前月份窗口事件（日期窗 [月初, 月末] 闭区间；scope=当前空间 → 天然隔离）
  const loadMonth = useCallback(async (scopeValue: string, y: number, m: number): Promise<void> => {
    const seq = ++seqRef.current
    setLoading(true)
    setLoadError('')
    try {
      const from = dayKey(y, m, 1)
      const to = dayKey(y, m, daysIn(y, m))
      const data = await hubGet<unknown>(
        '/api/calendar/events?scope=' + encodeURIComponent(scopeValue) + '&from=' + from + '&to=' + to,
      )
      if (seq !== seqRef.current) return // 已被更新的请求取代
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
  }, [])

  useEffect(() => {
    // 空间/月份变化 → 清空并重拉（绝不让旧空间旧月份数据串进当前视图）
    seqRef.current += 1
    setEvents([])
    setLoadError('')
    if (hubMode && scope) {
      void loadMonth(scope, cursor.y, cursor.m)
    } else {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hubMode, scope, cursor.y, cursor.m, loadMonth])

  // ── 引导态（与 ChatView 语义一致）──
  if (!hubMode) {
    return (
      <div className="center-col">
        <div className="panel goal-card">
          <span style={{ color: 'var(--yellow)' }}>📅 日程日历需要 team-hub v2（中枢）</span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            启动 <code>node team-hub/server.mjs</code>（:8787）后本面板自动可用；右上角「🧭 中枢」可指定地址
          </span>
        </div>
      </div>
    )
  }

  if (!scope) {
    return (
      <div className="center-col">
        <div className="panel goal-card">
          <span style={{ color: 'var(--yellow)' }}>📅 请先选择具体工作空间</span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            日程随空间隔离（scope 分区）。在左侧「工作空间」选择一个具体空间后即可查看/新建（「全部空间」视图不可用）
          </span>
        </div>
      </div>
    )
  }

  const scopeValue: string = scope

  // ── 网格数据（只读于 render）──
  const byDay = new Map<string, CalEvent[]>()
  for (const ev of events) {
    const key = ev.start.slice(0, 10)
    const list = byDay.get(key)
    if (list) list.push(ev)
    else byDay.set(key, [ev])
  }
  for (const list of byDay.values()) list.sort((a, b) => a.start.localeCompare(b.start) || (a.id ?? 0) - (b.id ?? 0))
  const cells = buildCells(cursor.y, cursor.m)
  const cellEvents = (c: CalCell): CalEvent[] => byDay.get(c.key) ?? []

  const openCreate = (): void => {
    setDraftTitle('')
    setDraftDate(todayTxt)
    setDraftTime('')
    setCreating(true)
  }

  /** 新建：前端校验（标题+日期必填、时间可选，TC-S6-02/03）→ POST → 成功重拉网格 + toast。 */
  const doCreate = async (): Promise<void> => {
    const title = draftTitle.trim()
    if (!title) {
      toast('err', '请输入日程标题')
      return
    }
    if (title.length > MAX_TITLE) {
      toast('err', '标题过长（上限 ' + String(MAX_TITLE) + ' 字符）')
      return
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draftDate)) {
      toast('err', '请选择日期')
      return
    }
    const time = draftTime.trim()
    if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      toast('err', '时间格式无效（例 09:30；不填 = 全天）')
      return
    }
    const allDay = time.length === 0
    const start = allDay ? draftDate : draftDate + 'T' + time
    const scopeAtCall = scopeRef.current
    setSaving(true)
    try {
      await hubPost<{ ok?: boolean }>('/api/calendar/events', {
        scope: scopeValue,
        title,
        start,
        end: null,
        allDay,
        by: 'general',
      })
      if (scopeAtCall !== scopeRef.current) return // 空间身份守卫：await 期间切走 → 不回写当前视图
      setCreating(false)
      toast('ok', allDay ? '日程已创建（全天）' : '日程已创建')
      void loadMonth(scopeValue, cursor.y, cursor.m)
    } catch (e) {
      if (scopeAtCall !== scopeRef.current) return
      toast('err', '创建失败：' + errText(e))
    } finally {
      setSaving(false)
    }
  }

  /** 删除二次确认（TC-S6-04 / I-6）：点 ✕ → 弹确认；「取消」不发请求，确认后才 POST confirm=yes。 */
  const confirmDelete = async (): Promise<void> => {
    const ev = pendingDelete
    if (!ev || deleting) return
    const scopeAtCall = scopeRef.current
    setDeleting(true)
    try {
      await hubPost<{ ok?: boolean }>('/api/calendar/events/delete', { id: ev.id, scope: scopeValue, confirm: 'yes', by: 'general' })
      if (scopeAtCall !== scopeRef.current) return
      setPendingDelete(null)
      setEvents(prev => prev.filter(x => x.id !== ev.id))
      toast('ok', '日程已删除')
    } catch (e) {
      if (scopeAtCall !== scopeRef.current) return
      toast('err', '删除失败：' + errText(e))
    } finally {
      setDeleting(false)
    }
  }

  const goMonth = (delta: number): void => {
    setCursor(c => {
      const next = new Date(c.y, c.m + delta, 1)
      return { y: next.getFullYear(), m: next.getMonth() }
    })
  }
  const goToday = (): void => {
    const t = new Date()
    setCursor({ y: t.getFullYear(), m: t.getMonth() })
  }

  return (
    <div className="center-col">
      <div className="panel goal-card calendar-head">
        <span className="tag">📅 日程日历</span>
        <span style={{ fontSize: 12, color: 'var(--text)' }}>
          {scopeValue}
          <span style={{ color: 'var(--muted-2)', fontSize: 11 }}>
            {' · '}{events.length}{' 条 · team-hub（'}{hubBase()}{'）'}
          </span>
        </span>
      </div>

      <div className="panel calendar-main">
        <div className="cal-toolbar">
          <span className="cal-nav">
            <button className="btn mini cal-prev" title="上个月" onClick={() => goMonth(-1)}>‹</button>
            <button className="btn mini cal-today-btn" title="回到本月" onClick={goToday}>今天</button>
            <button className="btn mini cal-next" title="下个月" onClick={() => goMonth(1)}>›</button>
          </span>
          <span className="cal-month-label">{fmtMonth(cursor.y, cursor.m)}</span>
          <span style={{ marginLeft: 'auto' }}>
            <button className="btn primary cal-new" onClick={openCreate}>＋ 新建条目</button>
          </span>
        </div>

        <div className="cal-scroll">
          <div className="cal-weekdays">
            {WEEKDAYS.map(w => (
              <div key={w} className="cal-wd">{w}</div>
            ))}
          </div>
          <div className="cal-grid">
            {cells.map(cell => (
              <div key={cell.key} className={'cal-cell' + (cell.cur ? '' : ' dim') + (cell.today ? ' today' : '')}>
                <div className="cal-date-row">
                  <span className={'cal-date' + (cell.today ? ' today' : '')}>{cell.d}</span>
                  {cell.today && <span className="cal-today-mark">今天</span>}
                </div>
                {cell.cur && (
                  <div className="cal-chips">
                    {cellEvents(cell).slice(0, MAX_CHIPS).map(ev => (
                      <div key={ev.id} className="cal-chip" title={ev.title}>
                        {!isAllDay(ev) && <span className="cal-chip-time">{fmtStart(ev.start)}</span>}
                        <span className="cal-chip-title">{ev.title}</span>
                        <span
                          className="cal-chip-del"
                          role="button"
                          title="删除此日程"
                          onClick={e => {
                            e.stopPropagation()
                            setPendingDelete(ev)
                          }}
                        >✕</span>
                      </div>
                    ))}
                    {cellEvents(cell).length > MAX_CHIPS && (
                      <div className="cal-more">+{cellEvents(cell).length - MAX_CHIPS} 更多</div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          {loading && events.length === 0 && <div className="cal-footnote">⏳ 加载中…</div>}
          {!loading && events.length === 0 && !loadError && (
            <div className="cal-footnote">本月暂无日程，点「＋ 新建条目」添加（标题 + 日期必填，时间可选）</div>
          )}
          {!loading && loadError && (
            <div className="cal-footnote err">
              {loadError}
              <button className="btn mini" style={{ marginLeft: 8 }} onClick={() => void loadMonth(scopeValue, cursor.y, cursor.m)}>重试</button>
            </div>
          )}
        </div>
      </div>

      {/* 新建条目弹层 */}
      {creating && (
        <div className="modal-mask" onClick={() => { if (!saving) setCreating(false) }}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              ＋ 新建日程（{scopeValue}）
              <span className="x" onClick={() => { if (!saving) setCreating(false) }}>✕</span>
            </div>
            <div className="modal-body">
              <div className="field" style={{ marginBottom: 10 }}>
                <label>标题（必填，≤{String(MAX_TITLE)} 字符）</label>
                <input
                  value={draftTitle}
                  maxLength={MAX_TITLE}
                  placeholder="例如：评审会 / 发布窗口"
                  onChange={e => setDraftTitle(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="field" style={{ marginBottom: 10 }}>
                <label>日期（必填）</label>
                <input type="date" value={draftDate} onChange={e => setDraftDate(e.target.value)} />
              </div>
              <div className="field">
                <label>时间（可选；不填 = 全天）</label>
                <input type="time" value={draftTime} onChange={e => setDraftTime(e.target.value)} />
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn ghost" disabled={saving} onClick={() => setCreating(false)}>取消</button>
              <button className="btn primary" disabled={saving || !draftTitle.trim() || !draftDate} onClick={() => void doCreate()}>
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除二次确认弹层（TC-S6-04） */}
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
                  {pendingDelete.start.slice(0, 10)}
                  {!isAllDay(pendingDelete) ? ' ' + fmtStart(pendingDelete.start) : '（全天）'}
                  {' · 空间 '}{scopeValue}{' · 删除后不可恢复'}
                </div>
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn ghost" disabled={deleting} onClick={() => setPendingDelete(null)}>取消</button>
              <button className="btn danger" disabled={deleting} onClick={() => void confirmDelete()}>
                {deleting ? '删除中…' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ───────────────────────── 纯函数（网格/日期工具；一律本地时间，避免时区偏移错格）─────────────────────────
/** 与 S5 后端 MAX_CALENDAR_TITLE 对齐的标题上限（TC-S5-05/TC-S6-03②）。 */
export const MAX_TITLE = 100
const MAX_CHIPS = 3 // 单格直显条数上限，超出折叠为「+N 更多」

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

export interface CalEvent {
  id: number
  scope: string
  title: string
  /** 'YYYY-MM-DD'（全天）或 'YYYY-MM-DDTHH:mm[:ss]'（带时间）；日期窗按 start 是否在 [from,to] 闭区间判定（TC-S5-06 口径）。 */
  start: string
  end?: string | null
  allDay?: boolean
  meta?: unknown
  createdAt?: string
  updatedAt?: string
}

export interface CalCell {
  key: string
  /** 是否属于当前展示月（false = 前/后月补位格，置灰、不显示条目）。 */
  cur: boolean
  /** 本地日期是否今天（仅当月格计算，TC-S6-07「回到当月恢复」）。 */
  today: boolean
  d: number
}

function pad2(n: number): string {
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

/** 全天判定：显式 allDay 或 start 无时间部分（date-only，兼容 S5 以 allDay 推断落窗的实现）。 */
export function isAllDay(ev: CalEvent): boolean {
  return ev.allDay === true || String(ev.start).indexOf('T') < 0
}

/** 取 start 时间段文本（'10:00'）；全天/缺省返回 ''。 */
export function fmtStart(start: string): string {
  const ti = start.indexOf('T')
  return ti >= 0 ? start.slice(ti + 1, ti + 6) : ''
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
