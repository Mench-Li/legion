import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchHubActivity, hubBase, markAllNotifyRead, markNotifyRead, notifyReadState, subscribeHubAudit,
} from '../api'
import type { HubSseStatus, NotifyItem } from '../api'
import {
  NOTIFY_CATEGORY_LABEL, NOTIFY_PRIORITY_LABEL, applyReadState, categoryCounts, filterItems,
  highestSeq, mergeNotifyItems, shouldRefill, toNotifyItems, unreadCount,
} from '../notify'
import type { NotifyCategory } from '../notify'
import { toast } from './Toast'
import { TaskDetailModal } from './TaskDetailModal'

/** 面板一次拉取的审计条数（服务端 limit 上限 500；足够覆盖全部未读与展示尾部）。 */
const LIST_LIMIT = 200

/** 时间展示（iso → 本地化；坏值原样兜底）。 */
function fmtTime(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  const p = (x: number): string => String(x).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

/** 优先级视觉：high 红、normal 常规、low 灰。 */
const PRIORITY_STYLE: Record<string, { color: string; dot: string }> = {
  high: { color: 'var(--red)', dot: '🔴' },
  normal: { color: 'var(--text)', dot: '🔵' },
  low: { color: 'var(--muted)', dot: '⚪' },
}

/** 跳转去向说明（供 title 提示与 toast 文案；与 notify.jumpOf 的 kind 一一对应）。 */
const JUMP_HINT: Record<string, string> = {
  task: '打开任务详情',
  goal: '回目标面板',
  space: '空间变更已生效（左侧「工作空间」）',
  model: '模型配置已更新（智能体面板「默认模型」）',
  skill: '技能已更新（左侧「技能中心」）',
  none: '已标记已读',
}

/**
 * 通知中心（S7 ← R-B2：audit 派生面板，后端零改动；P2-4 增强）。
 * - 列表 = GET /api/activity?scope=（既有 fetchHubActivity）→ 白名单 + 统一通知模型（./notify.ts）；
 *   实时增量 = subscribeHubAudit（既有单一 /api/events，I-8）——面板打开时本组件开 1 个 hub
 *   EventSource，与 ChatView 互斥挂载，运行期 hub 事件连接数 ≤ 改造前（无第二连接）。
 * - **分类**：任务/目标/空间/模型/技能（页签过滤 + 各类未读计数）。
 * - **优先级**：high（拦截/转派/测试报告/目标关键节点/进入 blocked·in_review）/normal/low。
 * - **批量已读**：行多选 +「标记选中已读」+「全部已读」；已读状态 = 本地游标 + 显式 seq 集合
 *   （applyMarkRead 压实），绝不写 audit（TC-S7-05 反向断言服务端零新行）。
 * - **跳转协议**：统一 jumpOf → task/goal/space/model/skill/none，按 kind 分发（未知兜底 toast）。
 * - **去重与断线恢复**：seq 去重降序；SSE 重连（onStatus.reconnected）或检测到 seq 缺口
 *   （shouldRefill，基于未过滤的全量水位）时立即重拉列表；15s 轮询兜底断线窗口。
 * - 渲染安全（I-5）：时间/scope/action/成员全部 React 文本节点，无 dangerouslySetInnerHTML。
 */
export function NotifyView({ scope, hubMode, onUnreadChange, onGoHome }: {
  scope: string | null
  hubMode: boolean
  /** 未读变化上报：徽标随之增减（与 App 侧低频刷新共用同一计数口径）。 */
  onUnreadChange: (count: number) => void
  /** 目标类通知 → 回「首页/目标」面板（CenterPanel 顶部目标卡展示当前空间目标）。 */
  onGoHome: () => void
}): React.JSX.Element {
  const [items, setItems] = useState<NotifyItem[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [category, setCategory] = useState<NotifyCategory | null>(null)
  const [onlyUnread, setOnlyUnread] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [sse, setSse] = useState<HubSseStatus | null>(null)
  const [refills, setRefills] = useState(0)
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null)
  const scopeRef = useRef<string | null>(null)
  scopeRef.current = scope
  /** 未过滤的全局 seq 水位（缺口判据；见 notify.shouldRefill）。 */
  const watermarkRef = useRef(0)

  /** 以「已读状态重算」的方式并入新行（保留已读态、seq 去重降序、截断）。 */
  const ingest = useCallback((rows: Awaited<ReturnType<typeof fetchHubActivity>>, scopeAtCall: string): void => {
    const fresh = toNotifyItems(rows, notifyReadState(scopeAtCall))
    setItems(prev => mergeNotifyItems(applyReadState(prev, notifyReadState(scopeAtCall)), fresh, LIST_LIMIT))
  }, [])

  const load = useCallback(async (): Promise<void> => {
    const scopeAtCall = scopeRef.current
    if (scopeAtCall === null) return
    setLoading(true)
    setLoadError('')
    try {
      const rows = await fetchHubActivity({ scope: scopeAtCall, limit: LIST_LIMIT })
      // 空间身份守卫：await 期间空间已切走 → 旧空间列表不回写当前视图
      if (scopeAtCall !== scopeRef.current) return
      ingest(rows, scopeAtCall)
      if (rows.length > 0) watermarkRef.current = Math.max(watermarkRef.current, highestSeq(rows))
    } catch (e) {
      if (scopeAtCall !== scopeRef.current) return
      const msg = e instanceof Error ? e.message : String(e)
      setLoadError(msg)
      toast('err', '通知加载失败：' + msg)
    } finally {
      if (scopeAtCall === scopeRef.current) setLoading(false)
    }
  }, [ingest])

  // scope/hub 变化：重拉列表（切换空间同时清空选择与水位）
  useEffect(() => {
    if (!hubMode || !scope) {
      setItems([])
      setLoadError('')
      return
    }
    let cancelled = false
    setItems([])
    setSelected(new Set())
    setCategory(null)
    setLoading(true)
    setLoadError('')
    watermarkRef.current = 0
    fetchHubActivity({ scope, limit: LIST_LIMIT })
      .then(rows => {
        if (cancelled) return
        ingest(rows, scope)
        watermarkRef.current = highestSeq(rows)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        const msg = e instanceof Error ? e.message : String(e)
        setLoadError(msg)
        toast('err', '通知加载失败：' + msg)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [hubMode, scope, ingest])

  // 实时增量 + 断线恢复：
  // ① SSE 帧：全量水位先更新（缺口判据用未过滤流），再按当前空间并入白名单条目；
  // ② 重连成功（opens>1）或检测到 seq 跳变 → 立即重拉补齐（不等 15s 轮询）；
  // ③ 15s 轮询兜底（静默失败）。
  useEffect(() => {
    if (!hubMode || !scope) return
    const refill = (): void => {
      const cur = scopeRef.current
      if (cur === null) return
      fetchHubActivity({ scope: cur, limit: LIST_LIMIT })
        .then(rows => {
          if (cur !== scopeRef.current) return
          ingest(rows, cur)
          setRefills(n => n + 1)
        })
        .catch(() => undefined)
    }
    const off = subscribeHubAudit(ev => {
      // 缺口检测：seq > 水位+1 说明中间帧丢失（先判后更新水位）
      if (shouldRefill(watermarkRef.current, [ev])) {
        watermarkRef.current = Math.max(watermarkRef.current, ev.seq)
        refill()
      } else {
        watermarkRef.current = Math.max(watermarkRef.current, ev.seq)
      }
      if (ev.scope !== scopeRef.current) return
      setItems(prev => mergeNotifyItems(prev, toNotifyItems([ev], notifyReadState(ev.scope)), LIST_LIMIT))
    }, {
      scope,
      onStatus: st => {
        setSse(st)
        // 首次之后的 open = 断线重连成功 → 立即补齐断线窗口
        if (st.state === 'reconnected') refill()
      },
    })
    const poll = window.setInterval(() => {
      const cur = scopeRef.current
      if (cur === null) return
      fetchHubActivity({ scope: cur, limit: LIST_LIMIT })
        .then(rows => {
          if (cur !== scopeRef.current) return
          ingest(rows, cur)
        })
        .catch(() => undefined)
    }, 15000)
    return () => {
      off()
      window.clearInterval(poll)
    }
  }, [hubMode, scope, ingest])

  // 未读 = read=false 的条数（与侧栏 badge 同口径）
  const unread = useMemo(() => unreadCount(items), [items])
  const counts = useMemo(() => categoryCounts(items), [items])
  const visible = useMemo(() => filterItems(items, category, onlyUnread), [items, category, onlyUnread])

  useEffect(() => {
    onUnreadChange(unread)
  }, [unread, onUnreadChange])

  /** 批量标记已读（含单条）：写本地状态 → 重算列表 read 位 → 清空选择。 */
  const markRead = (seqs: number[]): void => {
    if (seqs.length === 0) return
    markNotifyRead(scope, seqs)
    setItems(prev => applyReadState(prev, notifyReadState(scope)))
    setSelected(new Set())
  }

  const markAll = (): void => {
    const max = highestSeq(items)
    if (max <= 0) return
    markAllNotifyRead(scope, max)
    setItems(prev => applyReadState(prev, notifyReadState(scope)))
    setSelected(new Set())
    toast('info', '🔔 已把当前空间通知全部标记为已读（本地状态，服务端零写入）')
  }

  const toggleSelect = (seq: number): void => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(seq)) next.delete(seq)
      else next.add(seq)
      return next
    })
  }

  /** 点击行：先标记已读，再按统一跳转协议分发。 */
  const clickRow = (it: NotifyItem): void => {
    if (!it.read) markRead([it.seq])
    switch (it.jump.kind) {
      case 'task':
        setDetailTaskId(it.jump.ref)
        return
      case 'goal':
        onGoHome()
        toast('info', '🎯 已在目标面板展示当前空间目标')
        return
      case 'space':
      case 'model':
      case 'skill':
        toast('info', it.label + '：' + JUMP_HINT[it.jump.kind])
        return
      default:
        toast('info', it.label + '（' + it.action + '）已标记已读')
    }
  }

  if (!hubMode) {
    return (
      <div className="center-col">
        <div className="panel goal-card">
          <span style={{ color: 'var(--yellow)' }}>🔔 通知中心需要 team-hub v2（中枢）</span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            通知 = 中枢审计派生（audit）。启动 <code>node team-hub/server.mjs</code>（:8787）后本面板自动可用
          </span>
        </div>
      </div>
    )
  }

  if (!scope) {
    return (
      <div className="center-col">
        <div className="panel goal-card">
          <span style={{ color: 'var(--yellow)' }}>🔔 请先选择具体工作空间</span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            通知按空间隔离（scope 分区，已读状态 per scope）。在左侧「工作空间」选择一个具体空间后即可查看通知
          </span>
        </div>
      </div>
    )
  }

  const sseText = sse === null ? '未连接'
    : sse.state === 'open' ? '实时已连接'
    : sse.state === 'reconnected' ? '已重连补齐'
    : sse.state === 'reconnecting' ? '重连中…'
    : '连接已关闭'

  return (
    <div className="center-col">
      <div className="panel goal-card" style={{ flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, color: 'var(--text)', fontWeight: 600 }}>🔔 通知中心</span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          {scope}
          <span style={{ color: 'var(--muted-2)', fontSize: 11 }}> · audit 派生 · team-hub（{hubBase()}）</span>
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 11, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="chip" title={'SSE 连接状态（缺口补齐 ' + String(refills) + ' 次）'}>
            {sse?.state === 'open' || sse?.state === 'reconnected' ? '🟢 ' : '🟡 '}{sseText}
          </span>
          <span className="chip">{unread > 0 ? ('🔴 ' + String(unread) + ' 条未读') : '✅ 全部已读'}</span>
          <button className="btn ghost" disabled={loading} onClick={() => void load()} title="重新拉取通知列表">↻ 刷新</button>
        </span>
      </div>

      <div className="panel" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
          <button
            className="btn ghost"
            style={{ fontWeight: category === null ? 700 : 400 }}
            onClick={() => setCategory(null)}
          >全部 {items.length}</button>
          {(Object.keys(NOTIFY_CATEGORY_LABEL) as NotifyCategory[]).map(c => (
            <button
              key={c}
              className="btn ghost"
              style={{ fontWeight: category === c ? 700 : 400, opacity: counts[c].total === 0 ? 0.5 : 1 }}
              title={NOTIFY_CATEGORY_LABEL[c] + '：共 ' + String(counts[c].total) + ' 条，未读 ' + String(counts[c].unread)}
              onClick={() => setCategory(c)}
            >
              {NOTIFY_CATEGORY_LABEL[c]} {counts[c].total}{counts[c].unread > 0 ? (' 🔴' + String(counts[c].unread)) : ''}
            </button>
          ))}
          <label style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={onlyUnread} onChange={e => setOnlyUnread(e.target.checked)} />仅未读
          </label>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button className="btn ghost" disabled={selected.size === 0} onClick={() => markRead([...selected])}>
              标记选中已读{selected.size > 0 ? ('（' + String(selected.size) + '）') : ''}
            </button>
            <button className="btn ghost" disabled={unread === 0} onClick={markAll} title="把当前空间通知全部标记已读（仅本地状态）">全部已读</button>
          </span>
        </div>

        <div style={{ maxHeight: 520, overflowY: 'auto' }}>
          {loadError && (
            <div style={{ padding: 16, fontSize: 12, color: 'var(--red)' }}>✕ 通知加载失败：{loadError}</div>
          )}
          {loading && items.length === 0 && !loadError && (
            <div style={{ padding: 24, fontSize: 12, color: 'var(--muted-2)', textAlign: 'center' }}>⏳ 加载通知…</div>
          )}
          {!loading && !loadError && visible.length === 0 && (
            <div style={{ padding: 24, fontSize: 12, color: 'var(--muted-2)', textAlign: 'center' }}>
              {items.length === 0
                ? '暂无通知（当前空间还没有任务/目标/空间类审计，点击上方「↻ 刷新」重试）'
                : '当前筛选条件下没有通知（切回「全部」或取消「仅未读」）'}
            </div>
          )}
          {visible.map(it => {
            const ps = PRIORITY_STYLE[it.priority]
            const rowTip = (it.read ? '已读 · ' : '未读 · 点击标记已读 · ') + JUMP_HINT[it.jump.kind]
            return (
              <div
                key={it.id}
                onClick={() => clickRow(it)}
                title={rowTip}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 14px',
                  borderBottom: '1px solid var(--line)', cursor: 'pointer',
                  background: it.read ? 'transparent' : 'rgba(147,197,253,0.07)',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = it.read ? 'rgba(90,160,255,0.06)' : 'rgba(147,197,253,0.14)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = it.read ? 'transparent' : 'rgba(147,197,253,0.07)' }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(it.seq)}
                  onClick={e => e.stopPropagation()}
                  onChange={() => toggleSelect(it.seq)}
                  title="选中后可批量标记已读"
                  style={{ marginTop: 3 }}
                />
                <span style={{ marginTop: 2 }} title={'优先级：' + NOTIFY_PRIORITY_LABEL[it.priority]}>{ps.dot}</span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, color: it.read ? 'var(--text)' : ps.color, fontWeight: it.read ? 400 : 700 }}>
                      {it.label}
                    </span>
                    <span className="chip" style={{ fontSize: 10 }}>{NOTIFY_CATEGORY_LABEL[it.category]}</span>
                    {it.priority === 'high' && <span className="chip" style={{ fontSize: 10, color: 'var(--red)' }}>高优先级</span>}
                    {it.taskId && <span className="chip">{it.taskId}</span>}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted-2)', marginTop: 3, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <span>🕒 {fmtTime(it.ts)}</span>
                    <span>🗂 {it.scope}</span>
                    <span>来源 {it.member}</span>
                    <span className="chip" style={{ fontSize: 10 }}>{it.action}</span>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
      {detailTaskId && <TaskDetailModal taskId={detailTaskId} onClose={() => setDetailTaskId(null)} />}
    </div>
  )
}
