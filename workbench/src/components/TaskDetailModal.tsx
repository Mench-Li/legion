import { useCallback, useEffect, useState } from 'react'
import { execRequest, fetchHubActivity, fetchHubTask, hubClaim, hubComment, hubReassign, hubTransition } from '../api'
import type { HubActivity, HubTask } from '../types'
import { toast } from './Toast'

interface TaskDetailModalProps {
  taskId: string
  onClose: () => void
  /** 任务状态变更后通知上层刷新（任务集/编队）。 */
  onChanged?: () => void
}

const STATUS_PILL: Record<string, string> = {
  backlog: '待批准', todo: '待认领', in_progress: '🟢 进行中', in_review: '🟡 待验收', blocked: '受阻', done: '✅ 已完成', canceled: '已取消',
}

const ACTION_TEXT: Record<string, string> = {
  'goal:publish': '🎯 目标发布（自动建链）',
  claim: '🔒 认领开工',
  transition: '🔄 状态变更',
  advance: '⏩ 推进完成',
  comment: '💬 评论',
  evidence: '📦 提交证据',
  reassign: '🔁 转派',
  'release-stale': '⏳ 租约回收',
}

const STATUS_CN: Record<string, string> = {
  todo: '待认领', in_progress: '进行中', in_review: '待验收', done: '已完成', blocked: '受阻', backlog: '待批准', canceled: '已取消',
}

function fmt(iso?: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleString('zh-CN', { hour12: false })
}

export function TaskDetailModal({ taskId, onClose, onChanged }: TaskDetailModalProps): React.JSX.Element {
  const [task, setTask] = useState<HubTask | null>(null)
  const [timeline, setTimeline] = useState<HubActivity[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      setTask(await fetchHubTask(taskId))
      try {
        setTimeline(await fetchHubActivity({ taskId }))
      } catch {
        setTimeline([])
      }
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [taskId])

  useEffect(() => {
    void load()
  }, [load])

  const act = async (action: () => Promise<unknown>, okText: string): Promise<void> => {
    setBusy(true)
    try {
      await action()
      toast('ok', okText)
      await load()
      onChanged?.()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast('err', msg)
    } finally {
      setBusy(false)
    }
  }

  if (err) {
    return (
      <div className="modal-mask" onClick={onClose}>
        <div className="modal" onClick={e => e.stopPropagation()}>
          <div className="modal-head">任务详情<span className="x" onClick={onClose}>✕</span></div>
          <div className="modal-body" style={{ color: 'var(--red)', fontSize: 13 }}>读取失败：{err}</div>
        </div>
      </div>
    )
  }
  if (!task) {
    return (
      <div className="modal-mask" onClick={onClose}>
        <div className="modal" onClick={e => e.stopPropagation()}>
          <div className="modal-head">任务详情 · {taskId}<span className="x" onClick={onClose}>✕</span></div>
          <div className="modal-body" style={{ color: 'var(--muted-2)', fontSize: 12 }}>加载中…</div>
        </div>
      </div>
    )
  }

  const t = task
  const bindOf = (x: HubTask): string => x.soldier ?? x.role ?? 'general'
  const hasProcess = (t.evidence ?? []).length > 0 || (t.comments ?? []).length > 0 || (t.patches ?? []).length > 0

  const doReview = (): Promise<void> => act(() => hubTransition({ id: t.id, to: 'done', by: 'general', ifVersion: t.version }), `${t.id} 已验收通过 ✓`)
  const doReject = (): Promise<void> => {
    const reason = window.prompt(`打回 ${t.id} 的原因（归还待办）`)
    if (reason === null) return Promise.resolve()
    return act(() => hubTransition({ id: t.id, to: 'todo', by: bindOf(t), ifVersion: t.version }), `${t.id} 已打回`)
  }
  const doStart = (): Promise<void> => act(() => hubTransition({ id: t.id, to: 'in_progress', by: bindOf(t), ifVersion: t.version }), `${t.id} 已开工`)
  const doClaim = (): Promise<void> => act(() => hubClaim(t.id, t.role ?? undefined), `${t.id} 已认领`)
  const doSubmitReview = (): Promise<void> => act(() => hubTransition({ id: t.id, to: 'in_review', by: bindOf(t), ifVersion: t.version }), `${t.id} 已提交验收`)
  const doReturn = (): Promise<void> => act(() => hubTransition({ id: t.id, to: 'todo', by: bindOf(t), ifVersion: t.version }), `${t.id} 已归还待办`)
  const doUnblock = (): Promise<void> => act(() => hubTransition({ id: t.id, to: 'todo', by: bindOf(t), ifVersion: t.version, force: true }), `${t.id} 已解阻`)
  const doComment = (): Promise<void> => {
    const text = window.prompt(`给 ${t.id} 追加评论/过程记录`)
    if (text === null || !text.trim()) return Promise.resolve()
    return act(() => hubComment(t.id, text.trim()), `已记录`)
  }
  const doReassign = (): Promise<void> => {
    const soldier = window.prompt(`转派给哪个智能体（role）？`, t.role ?? '')
    if (soldier === null || !soldier.trim()) return Promise.resolve()
    return act(() => hubReassign(t.id, soldier.trim()), `已转派`)
  }
  const doAskAI = (): Promise<void> => act(() => execRequest(t.id), `${t.id} 已请求 AI 执行——执行守护将认领并干活，过程会沉淀在下方`)

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal task-detail-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <span className="tid-big">{t.id}</span> 任务详情
          <span className="x" onClick={onClose}>✕</span>
        </div>
        <div className="modal-body">
          <div className="td-title">
            <span className={`status-pill ${t.status}`}>{STATUS_PILL[t.status] ?? t.status}</span>
            <span className="td-title-text">{t.title}</span>
          </div>
          <div className="td-meta">
            指派：<b>{bindOf(t)}</b> · 空间：{t.scope ?? '—'} · 优先级：{t.priority} · v{t.version}
            {t.blockedBy.length > 0 ? ` · 依赖：${t.blockedBy.join('、')}` : ''}
            <div style={{ color: 'var(--muted-2)', fontSize: 10.5, marginTop: 2 }}>
              创建 {fmt(t.createdAt)} · 更新 {fmt(t.updatedAt)}
            </div>
          </div>

          {/* AI 执行过程 */}
          <div className="td-section">
            <div className="td-section-title">🤖 AI 执行过程</div>
            {hasProcess ? (
              <>
                {[...(t.evidence ?? []), ...(t.comments ?? [])]
                  .sort((a, b) => (a.at < b.at ? -1 : 1))
                  .map((c, i) => (
                    <div key={i} className="proc-item">
                      <span className="proc-who">{c.by}</span>
                      <span className="proc-at">{fmt(c.at)}</span>
                      <div className="proc-text">{c.text}</div>
                    </div>
                  ))}
                {(t.patches ?? []).length > 0 && <div className="proc-patch">🔧 补丁 {(t.patches ?? []).join('、')}</div>}
              </>
            ) : (
              <div className="proc-empty">
                ⏳ 该任务还没有 AI 执行过程——目前只是状态标记。
                <br />
                AI 智能体认领执行后，它的每一步行动、产出与汇报会实时沉淀在这里（下方时间线 + 过程记录），完成时提交待验收。
              </div>
            )}
          </div>

          {/* 状态时间线 */}
          {timeline.length > 0 && (
            <div className="td-section">
              <div className="td-section-title">⏱ 进展时间线</div>
              <div className="timeline">
                {timeline.map(a => (
                  <div key={a.seq} className="tl-item">
                    <span className="tl-time">{fmt(a.ts)}</span>
                    <span className="tl-act">
                      {ACTION_TEXT[a.action] ?? a.action}
                      {a.action === 'transition' && typeof a.detail?.to === 'string' ? ` → ${STATUS_CN[a.detail.to] ?? a.detail.to}` : ''}
                    </span>
                    <span className="tl-by">· {a.member}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {t.description && (
            <div className="td-section">
              <div className="td-section-title">📋 任务描述</div>
              <div className="detail-text">{t.description}</div>
            </div>
          )}

          <div className="td-section">
            <div className="td-section-title">🎯 验收标准</div>
            {(t.acceptance ?? []).length > 0 ? (
              <ul className="detail-list">{(t.acceptance ?? []).map((a, i) => <li key={i}>{a}</li>)}</ul>
            ) : (
              <div className="detail-warn">未定义验收标准——以任务描述与目标要求判断</div>
            )}
          </div>

          {/* 操作 */}
          <div className="td-actions">
            {t.status === 'todo' && (
              <>
                <button className="btn primary" disabled={busy} onClick={() => void doStart()}>▶ 开工</button>
                <button className="btn" disabled={busy} onClick={() => void doClaim()}>🔒 认领</button>
              </>
            )}
            {t.status === 'in_progress' && (
              <>
                <button className="btn primary" disabled={busy} onClick={() => void doSubmitReview()}>📮 提交验收</button>
                <button className="btn" disabled={busy} onClick={() => void doReturn()}>归还待办</button>
              </>
            )}
            {t.status === 'in_review' && (
              <>
                <button className="btn primary" disabled={busy} onClick={() => void doReview()}>✓ 验收通过</button>
                <button className="btn" disabled={busy} onClick={() => void doReject()}>↩ 打回重做</button>
              </>
            )}
            {t.status === 'blocked' && (
              <button className="btn primary" disabled={busy} onClick={() => void doUnblock()}>解阻</button>
            )}
            {(t.status === 'todo' || t.status === 'in_progress' || t.status === 'blocked') && (
              <button className="btn" disabled={busy} onClick={() => void doAskAI()} title="请求 AI 智能体认领并执行本任务（过程与产出会沉淀到下方）">
                🤖 派 AI 执行
              </button>
            )}
            <button className="btn ghost" disabled={busy} onClick={() => void doComment()}>💬 评论/记录</button>
            <button className="btn ghost" disabled={busy} onClick={() => void doReassign()}>转派</button>
          </div>
        </div>
      </div>
    </div>
  )
}
