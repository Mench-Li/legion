import { useCallback, useEffect, useRef, useState } from 'react'
import { countNotifyUnread, fetchHubActivity, hubBase, isNotifyAction, notifyReadSeq, setNotifyReadSeq, subscribeHubAudit } from '../api'
import type { NotifyRow } from '../api'
import { toast } from './Toast'
import { TaskDetailModal } from './TaskDetailModal'

/** 面板一次拉取的审计条数（服务端 limit 上限 500；足够覆盖全部未读与展示尾部）。 */
const LIST_LIMIT = 200

/** action → 中文文案（图标 + 动作；与 TaskDetailModal 时间线同源风格，覆盖白名单全集）。 */
const ACTION_UI: Record<string, string> = {
  create: '📝 任务创建',
  claim: '🔒 认领开工',
  transition: '🔄 状态变更',
  advance: '⏩ 推进完成',
  reassign: '🔁 转派',
  hold: '🖐 拦截自动',
  unhold: '🚀 放行自动',
  patch: '🔧 补丁登记',
  evidence: '📦 提交证据',
  artifact: '📦 产物登记',
  'review-note': '🧾 审计批注',
  'test-report': '🧪 测试报告',
  'goal:publish': '🎯 目标发布',
  'goal:slices': '🎯 目标拆解',
  'space:create': '🗂 空间创建',
  'space:update': '🗂 空间更新',
  'space:delete': '🗂 空间删除',
  'space:add-agents': '🗂 智能体入编',
  'model:set': '⚙ 默认模型设置',
  'model:clear': '⚙ 默认模型清除',
  'skill:submit': '🧩 技能提交',
  'skill:review': '🧩 技能复审',
  'skill:grant': '🧩 技能授权',
}

function actionLabel(action: string): string {
  return ACTION_UI[action] ?? ('⚡ ' + action)
}

/** 时间展示（iso → 本地化；坏值原样兜底）。 */
function fmtTime(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  const p = (x: number): string => String(x).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

/** 按 seq 去重并降序（服务端 scope 查询本身降序；SSE 回放/轮询合并时兜底排序）。 */
function dedupeDesc(rows: NotifyRow[]): NotifyRow[] {
  const seen = new Set<number>()
  const out: NotifyRow[] = []
  for (const r of rows) {
    if (seen.has(r.seq)) continue
    seen.add(r.seq)
    out.push(r)
  }
  out.sort((a, b) => b.seq - a.seq)
  return out
}

/**
 * 通知中心（S7 ← R-B2：audit 派生面板，J8-A 纯前端派生，后端零改动）。
 * - 列表 = GET /api/activity?scope=（既有 fetchHubActivity）+ action 白名单（chat:* 默认排除）；
 *   实时增量 = subscribeHubAudit（既有单一 /api/events，I-8）——面板打开时本组件开 1 个 hub
 *   EventSource，与 ChatView 互斥挂载，运行期 hub 事件连接数 ≤ 改造前（无第二连接）；
 *   15s 轮询兜底 SSE 断线窗口（失败静默，下次再试）。
 * - 已读 = localStorage 游标 per scope（notifyReadSeq/setNotifyReadSeq，api.ts）：点击即把游标推到该
 *   条 seq，刷新保持、切空间回来仍在；「已读」纯本地，绝不写 audit（TC-S7-05）。
 * - 跳转：任务类（taskId）→ TaskDetailModal（复用既有导航）；目标类（goal:* 无 taskId）→ 回首页/目标
 *   面板；space/model/skill 类给出明确去向说明（toast）；未知 action 不崩溃。
 * - 渲染安全（I-5 / TC-S7-09）：时间/scope/action/成员全部 React 文本节点，无 dangerouslySetInnerHTML。
 */
export function NotifyView({ scope, hubMode, onUnreadChange, onGoHome }: {
  scope: string | null
  hubMode: boolean
  /** 未读变化上报：徽标随之增减（与 App 侧低频刷新共用同一计数口径 countNotifyUnread）。 */
  onUnreadChange: (count: number) => void
  /** 目标类通知 → 回「首页/目标」面板（CenterPanel 顶部目标卡展示当前空间目标）。 */
  onGoHome: () => void
}): React.JSX.Element {
  const [list, setList] = useState<NotifyRow[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [unread, setUnread] = useState(0)
  /** 已读游标推进后重算未读（list/scope 不变、仅游标变）。 */
  const [cursorTick, setCursorTick] = useState(0)
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null)
  const scopeRef = useRef<string | null>(null)
  scopeRef.current = scope

  const load = useCallback(async (): Promise<void> => {
    const scopeAtCall = scopeRef.current
    if (scopeAtCall === null) return
    setLoading(true)
    setLoadError('')
    try {
      const rows = await fetchHubActivity({ scope: scopeAtCall, limit: LIST_LIMIT })
      // 空间身份守卫：await 期间空间已切走 → 旧空间列表不回写当前视图
      if (scopeAtCall !== scopeRef.current) return
      setList(prev => dedupeDesc([...prev, ...rows.filter(isNotifyAction)]).slice(0, LIST_LIMIT))
    } catch (e) {
      if (scopeAtCall !== scopeRef.current) return
      const msg = e instanceof Error ? e.message : String(e)
      setLoadError(msg)
      toast('err', '通知加载失败：' + msg)
    } finally {
      if (scopeAtCall === scopeRef.current) setLoading(false)
    }
  }, [])

  // scope/hub 变化：重拉列表（未读数随游标与列表重算）
  useEffect(() => {
    if (!hubMode || !scope) {
      setList([])
      setLoadError('')
      return
    }
    let cancelled = false
    setList([])
    setLoading(true)
    setLoadError('')
    fetchHubActivity({ scope, limit: LIST_LIMIT })
      .then(rows => {
        if (cancelled) return
        setList(dedupeDesc(rows.filter(isNotifyAction)).slice(0, LIST_LIMIT))
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
  }, [hubMode, scope])

  // 实时增量 = 既有 subscribeHubAudit（单一 /api/events）：白名单 + 当前空间 + seq 去重（SSE 连上会回放最近 30 条）；
  // 15s 轮询兜底断线窗口（静默失败）
  useEffect(() => {
    if (!hubMode || !scope) return
    const off = subscribeHubAudit(ev => {
      if (!isNotifyAction(ev.action)) return
      if (ev.scope !== scope) return
      setList(prev => {
        if (prev.some(r => r.seq === ev.seq)) return prev
        const next = dedupeDesc([ev, ...prev])
        return next.slice(0, LIST_LIMIT)
      })
    })
    const poll = window.setInterval(() => {
      const cur = scopeRef.current
      if (cur === null) return
      fetchHubActivity({ scope: cur, limit: LIST_LIMIT })
        .then(rows => {
          if (cur !== scopeRef.current) return
          setList(prev => dedupeDesc([...prev, ...rows.filter(isNotifyAction)]).slice(0, LIST_LIMIT))
        })
        .catch(() => undefined)
    }, 15000)
    return () => {
      off()
      window.clearInterval(poll)
    }
  }, [hubMode, scope])

  // 未读 = 白名单内 seq > 本地游标（countNotifyUnread 与侧栏 badge 同口径）
  useEffect(() => {
    setUnread(countNotifyUnread(list, scope))
  }, [list, scope, cursorTick])

  useEffect(() => {
    onUnreadChange(unread)
  }, [unread, onUnreadChange])

  const clickRow = (row: NotifyRow): void => {
    // 点击已读：游标推到该条 seq（只写 localStorage，TC-S7-05 反向断言服务端零新行）
    const cur = notifyReadSeq(scope)
    if (row.seq > cur) {
      setNotifyReadSeq(scope, row.seq)
      setCursorTick(t => t + 1)
    }
    const tid = row.taskId
    // 任务类：复用既有 TaskDetailModal 导航
    if (typeof tid === 'string' && tid.length > 0 && tid !== '*') {
      setDetailTaskId(tid)
      return
    }
    // 目标类（goal:publish 无 taskId）：回首页/目标面板
    if (row.action.startsWith('goal:')) {
      onGoHome()
      toast('info', '🎯 已在目标面板展示当前空间目标')
      return
    }
    // 空间类：给出明确去向（左侧「工作空间」区可见/切换）
    if (row.action.startsWith('space:')) {
      toast('info', '🗂 空间变更已生效：可在左侧「工作空间」区查看与切换')
      return
    }
    // model:/skill: 等：去向说明 + 兜底（未知 action 不崩溃，TC-S7-06）
    if (row.action.startsWith('model:')) {
      toast('info', '⚙ 模型配置已更新：可在智能体面板的「默认模型」中查看')
      return
    }
    if (row.action.startsWith('skill:')) {
      toast('info', '🧩 技能已更新：可在左侧「技能中心」面板查看')
      return
    }
    toast('info', actionLabel(row.action) + '（' + row.action + '）已标记已读')
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
            通知按空间隔离（scope 分区，已读游标 per scope）。在左侧「工作空间」选择一个具体空间后即可查看通知
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="center-col">
      <div className="panel goal-card">
        <span style={{ fontSize: 13, color: 'var(--text)', fontWeight: 600 }}>🔔 通知中心</span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          {scope}
          <span style={{ color: 'var(--muted-2)', fontSize: 11 }}> · audit 派生 · team-hub（{hubBase()}）</span>
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 11 }}>
          <span className="chip">{unread > 0 ? ('🔴 ' + String(unread) + ' 条未读') : '✅ 全部已读'}</span>
          <button className="btn ghost" style={{ marginLeft: 8 }} disabled={loading} onClick={() => void load()} title="重新拉取通知列表">
            {loading ? '⏳' : '↻ 刷新'}
          </button>
        </span>
      </div>

      <div className="panel" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
        <div style={{ maxHeight: 560, overflowY: 'auto' }}>
          {loadError && (
            <div style={{ padding: 16, fontSize: 12, color: 'var(--red)' }}>
              ✕ 通知加载失败：{loadError}
            </div>
          )}
          {loading && list.length === 0 && !loadError && (
            <div style={{ padding: 24, fontSize: 12, color: 'var(--muted-2)', textAlign: 'center' }}>⏳ 加载通知…</div>
          )}
          {!loading && !loadError && list.length === 0 && (
            <div style={{ padding: 24, fontSize: 12, color: 'var(--muted-2)', textAlign: 'center' }}>
              暂无通知（当前空间还没有任务/目标/空间类审计，点击上方「↻ 刷新」重试）
            </div>
          )}
          {list.map(row => {
            const isUnread = row.seq > notifyReadSeq(scope)
            const tid = row.taskId
            const hasTask = typeof tid === 'string' && tid.length > 0 && tid !== '*'
            const clickable = isUnread || hasTask || row.action.startsWith('goal:')
            const rowTip = isUnread ? '点击：标记已读（游标推进到该条，其前更新未读一并已读）'
              : hasTask ? '已读 · 点击查看任务详情'
              : row.action.startsWith('goal:') ? '已读 · 点击查看当前空间目标'
              : '已读'
            return (
              <div
                key={row.seq}
                onClick={() => clickRow(row)}
                title={rowTip}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: '9px 14px',
                  borderBottom: '1px solid var(--line)',
                  cursor: clickable ? 'pointer' : 'default',
                  background: isUnread ? 'rgba(147,197,253,0.07)' : 'transparent',
                }}
                onMouseEnter={e => {
                  if (clickable) (e.currentTarget as HTMLElement).style.background = isUnread ? 'rgba(147,197,253,0.14)' : 'rgba(90,160,255,0.06)'
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLElement).style.background = isUnread ? 'rgba(147,197,253,0.07)' : 'transparent'
                }}
              >
                <span style={{ marginTop: 2 }}>{isUnread ? '🔴' : '⚪'}</span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, color: 'var(--text)', fontWeight: isUnread ? 700 : 400 }}>
                      {actionLabel(row.action)}
                    </span>
                    {tid && typeof tid === 'string' && tid !== '*' && <span className="chip">{tid}</span>}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted-2)', marginTop: 3, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <span>🕒 {fmtTime(row.ts)}</span>
                    <span>🗂 {row.scope}</span>
                    <span>来源 {row.member}</span>
                    <span className="chip" style={{ fontSize: 10 }}>{row.action}</span>
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
