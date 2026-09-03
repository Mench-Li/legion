import { useEffect, useState } from 'react'
import { fetchHubActivity, fetchHubTasks, hubClaim, hubComment, hubHold, hubReassign, hubTransition } from '../api'
import type { CardStatus, HubActivity, HubTask } from '../types'
import { toast } from './Toast'

interface HubSchedulerModalProps {
  scope: string
  onClose: () => void
}

const GROUP_LABEL: Record<CardStatus, string> = {
  in_progress: '🟢 进行中',
  in_review: '🟡 待验收',
  blocked: '🔴 受阻',
  todo: '⚪ 待认领',
  backlog: '⚪ 待批准',
  done: '✅ 已完成',
  canceled: '⛔ 已取消',
}

const GROUP_ORDER: CardStatus[] = ['in_review', 'in_progress', 'blocked', 'todo', 'backlog']

function who(t: HubTask): string {
  return t.soldier ?? t.role ?? '未指派'
}

function fmt(iso?: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleString('zh-CN', { hour12: false })
}

/** 士兵 ❓ 提问待将军确认：最后一条评论以 ❓ 开头（守护标记待答复），将军答复后消失。 */
function askOpen(t: HubTask): boolean {
  const cs = t.comments ?? []
  if (cs.length === 0) return false
  return (cs[cs.length - 1].text ?? '').startsWith('❓')
}

/** 审计动作 → 进展文案（小时间线）。 */
const ACTION_TEXT: Record<string, string> = {
  'goal:publish': '🎯 目标发布（自动建链）',
  claim: '🔒 认领开工',
  transition: '🔄 状态变更',
  advance: '⏩ 推进完成',
  comment: '💬 评论',
  evidence: '📦 提交证据',
  reassign: '🔁 转派',
  hold: '🖐 拦截自动',
  unhold: '🚀 放行',
  'release-stale': '⏳ 租约回收',
  'space:create': '🗂 建空间',
}

const STATUS_CN: Record<string, string> = {
  todo: '待认领', in_progress: '进行中', in_review: '待验收', done: '已完成', blocked: '受阻', backlog: '待批准', canceled: '已取消',
}

export function HubSchedulerModal({ scope, onClose }: HubSchedulerModalProps): React.JSX.Element {
  const [tasks, setTasks] = useState<HubTask[]>([])
  const [activities, setActivities] = useState<HubActivity[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loadErr, setLoadErr] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    try {
      const list = await fetchHubTasks(scope)
      setTasks(list)
      // 该空间审计时间线（任务级进展历史）
      try {
        setActivities(await fetchHubActivity({ scope }))
      } catch {
        setActivities([])
      }
      // 待验收任务默认展开，方便直接看内容再决定验收/打回
      setExpanded(prev => {
        const next = new Set(prev)
        for (const t of list) if (t.status === 'in_review') next.add(t.id)
        return next
      })
      setLoadErr(null)
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope])

  const toggle = (id: string): void => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const act = async (action: () => Promise<unknown>, okText: string): Promise<void> => {
    try {
      await action()
      toast('ok', okText)
      await load()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast('err', msg)
    }
  }

  /** 已绑定任务的流转 by 必须是绑定者（soldier），否则服务端拒绝。 */
  const bindOf = (t: HubTask): string => t.soldier ?? t.role ?? 'general'

  const review = (t: HubTask): Promise<void> => act(() => hubTransition({ id: t.id, to: 'done', by: 'general', ifVersion: t.version }), `${t.id} 已验收通过 ✓`)
  const reject = (t: HubTask): Promise<void> => {
    const reason = window.prompt(`打回 ${t.id} 的原因（将把任务归还待办）`)
    if (reason === null) return Promise.resolve()
    return act(() => hubTransition({ id: t.id, to: 'todo', by: bindOf(t), ifVersion: t.version }), `${t.id} 已打回：${reason.trim() || '无理由'}`)
  }
  const returnTodo = (t: HubTask): Promise<void> => act(() => hubTransition({ id: t.id, to: 'todo', by: bindOf(t), ifVersion: t.version }), `${t.id} 已归还待办`)
  const unblock = (t: HubTask): Promise<void> => act(() => hubTransition({ id: t.id, to: 'todo', by: bindOf(t), ifVersion: t.version, force: true }), `${t.id} 已解阻`)
  const submitReview = (t: HubTask): Promise<void> => act(() => hubTransition({ id: t.id, to: 'in_review', by: bindOf(t), ifVersion: t.version }), `${t.id} 已提交验收`)
  const start = (t: HubTask): Promise<void> => act(() => hubTransition({ id: t.id, to: 'in_progress', by: bindOf(t), ifVersion: t.version }), `${t.id} 已开工`)
  const claim = (t: HubTask): Promise<void> => act(() => hubClaim(t.id, t.role ?? undefined), `${t.id} 已认领（${t.role ?? 'general'}）`)
  const comment = (t: HubTask): Promise<void> => {
    const text = window.prompt(`给 ${t.id} 追加评论`)
    if (text === null || !text.trim()) return Promise.resolve()
    return act(() => hubComment(t.id, text.trim()), `${t.id} 评论已追加`)
  }
  const reassign = (t: HubTask): Promise<void> => {
    const soldier = window.prompt(`转派 ${t.id} 给哪个智能体（role）？`, t.role ?? '')
    if (soldier === null || !soldier.trim()) return Promise.resolve()
    return act(() => hubReassign(t.id, soldier.trim()), `${t.id} 已转派给 ${soldier.trim()}`)
  }
  const holdTask = (t: HubTask): Promise<void> => act(() => hubHold(t.id, true), `${t.id} 已拦截：守护不再自动认领/执行`)
  const unholdTask = (t: HubTask): Promise<void> => act(() => hubHold(t.id, false), `${t.id} 已放行：恢复自动交接`)

  const groups = GROUP_ORDER.map(status => ({
    status,
    items: tasks.filter(t => t.status === status),
  })).filter(g => g.items.length > 0)
  const doneCount = tasks.filter(t => t.status === 'done').length
  const reviewCount = tasks.filter(t => t.status === 'in_review').length

  const renderDetail = (t: HubTask): React.JSX.Element => {
    const hasAccept = (t.acceptance ?? []).length > 0
    const hasEvidence = (t.evidence ?? []).length > 0 || (t.patches ?? []).length > 0
    const timeline = activities.filter(a => a.taskId === t.id)
    return (
      <div className="task-detail">
        {timeline.length > 0 && (
          <div className="detail-row">
            <b>⏱ 进展时间线</b>
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
          <div className="detail-row">
            <b>📋 任务描述</b>
            <div className="detail-text">{t.description}</div>
          </div>
        )}
        <div className="detail-row">
          <b>🎯 验收标准</b>
          {hasAccept ? (
            <ul className="detail-list">
              {(t.acceptance ?? []).map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          ) : (
            <div className="detail-warn">未定义验收标准（发布时未填 acceptance）——请以任务描述与目标要求判断</div>
          )}
        </div>
        {(t.boundary && ((t.boundary.do ?? []).length > 0 || (t.boundary.dont ?? []).length > 0)) && (
          <div className="detail-row">
            <b>🚧 边界（做什么 / 不做什么）</b>
            {(t.boundary.do ?? []).map((x, i) => (
              <div key={`bd-do-${i}`} className="bd-item do">✅ {x}</div>
            ))}
            {(t.boundary.dont ?? []).map((x, i) => (
              <div key={`bd-dont-${i}`} className="bd-item dont">🚫 {x}</div>
            ))}
          </div>
        )}
        <div className="detail-row">
          <b>📦 执行者产出 / 证据</b>
          {hasEvidence ? (
            <>
              {(t.evidence ?? []).map((e, i) => (
                <div key={`e${i}`} className="detail-item">
                  <span className="meta">[{e.by}] {fmt(e.at)}</span>
                  <div className="detail-text">{e.text}</div>
                </div>
              ))}
              {(t.patches ?? []).length > 0 && (
                <div className="detail-text" style={{ color: 'var(--cyan)', fontSize: 11 }}>
                  🔧 补丁 {t.patches.length} 份：{(t.patches ?? []).join('、')}
                </div>
              )}
            </>
          ) : (
            <div className="detail-warn">⚠ 执行者没有提交任何产出/证据（无说明、无补丁）——没有内容无法验收，请「评论」要求补充，或直接「打回」</div>
          )}
        </div>
        {(t.comments ?? []).length > 0 && (
          <div className="detail-row">
            <b>💬 评论</b>
            {(t.comments ?? []).map((c, i) => (
              <div key={`c${i}`} className="detail-item">
                <span className="meta">[{c.by}] {fmt(c.at)}</span>
                <div className="detail-text">{c.text}</div>
              </div>
            ))}
          </div>
        )}
        {(t.blocks ?? []).length > 0 && (
          <div className="detail-row" style={{ fontSize: 11, color: 'var(--muted)' }}>
            此任务解锁：{t.blocks.join('、')}
          </div>
        )}
      </div>
    )
  }

  const actionsFor = (t: HubTask): React.JSX.Element | null => {
    switch (t.status) {
      case 'in_review':
        return (
          <>
            <button className="btn mini primary" onClick={() => void review(t)}>✓ 验收通过</button>
            <button className="btn mini" onClick={() => void reject(t)}>↩ 打回重做</button>
          </>
        )
      case 'in_progress':
        return (
          <>
            <button className="btn mini primary" onClick={() => void submitReview(t)}>提交验收</button>
            <button className="btn mini" onClick={() => void returnTodo(t)}>归还待办</button>
          </>
        )
      case 'blocked':
        return <button className="btn mini" onClick={() => void unblock(t)}>解阻</button>
      case 'todo':
        return (
          <>
            <button className="btn mini primary" onClick={() => void start(t)}>开工</button>
            <button className="btn mini" onClick={() => void claim(t)}>认领</button>
          </>
        )
      default:
        return null
    }
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          🗓 中枢任务调度 · {scope}
          <span className="x" onClick={onClose}>✕</span>
        </div>
        <div className="modal-body">
          <div className="sched-summary">
            共 {tasks.length} 任务 · 待验收 {reviewCount} / 进行中 {tasks.filter(t => t.status === 'in_progress').length} / 受阻 {tasks.filter(t => t.status === 'blocked').length} / 待认领 {tasks.filter(t => t.status === 'todo').length} / 已完成 {doneCount}
          </div>
          {loadErr && <div style={{ color: 'var(--red)', fontSize: 12, padding: '8px 0' }}>读取失败：{loadErr}</div>}
          {reviewCount > 0 && (
            <div className="review-tip">
              🔎 验收前请先看该任务下方「📦 执行者产出/证据」与「🎯 验收标准」：符合才「验收通过」；无产出/不合格请「打回重做」并写明原因。
            </div>
          )}
          {groups.length === 0 && !loadErr && (
            <div style={{ color: 'var(--muted-2)', fontSize: 12 }}>该空间暂无任务（发布目标后自动生成阶段任务链）</div>
          )}
          {groups.map(g => (
            <div key={g.status} className="sched-group">
              <h5>
                {GROUP_LABEL[g.status]} <span style={{ color: 'var(--muted-2)' }}>({g.items.length})</span>
              </h5>
              {g.items.map(t => (
                <div key={t.id} className={`hub-card${expanded.has(t.id) ? ' open' : ''}`}>
                  <div className="hub-head" onClick={() => toggle(t.id)}>
                    <span className="caret">{expanded.has(t.id) ? '▾' : '▸'}</span>
                    <div className="t">
                      <div className="task-line">
                        <span className="tid">{t.id}</span>
                        <span className="tt">{t.title}</span>
                      </div>
                      <div className="meta">
                        {askOpen(t) ? '❓ 待将军确认 · ' : ''}{t.hold ? '🖐 将军拦截 · ' : ''}{who(t)} · v{t.version}
                        {t.blockedBy.length > 0 ? ` · 依赖 ${t.blockedBy.join(',')}` : ''} · 更新 {fmt(t.updatedAt)}
                      </div>
                    </div>
                  </div>
                  {expanded.has(t.id) && (
                    <>
                      {renderDetail(t)}
                      <div className="hub-actions">
                        {actionsFor(t)}
                        <button className="btn mini ghost" onClick={() => void comment(t)}>💬 评论</button>
                        <button className="btn mini ghost" onClick={() => void reassign(t)}>转派</button>
                        {t.status !== 'done' && t.status !== 'canceled' && (
                          t.hold
                            ? <button className="btn mini primary" onClick={() => void unholdTask(t)}>🚀 放行</button>
                            : <button className="btn mini ghost" onClick={() => void holdTask(t)}>🖐 拦截</button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  )
}
