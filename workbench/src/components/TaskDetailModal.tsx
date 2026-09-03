import { useCallback, useEffect, useState } from 'react'
import { execRequest, fetchHubActivity, fetchHubTask, fetchHubTasks, hubClaim, hubComment, hubHold, hubReassign, hubTransition } from '../api'
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
  hold: '🖐 拦截自动',
  unhold: '🚀 放行',
  'release-stale': '⏳ 租约回收',
}

const STATUS_CN: Record<string, string> = {
  todo: '待认领', in_progress: '进行中', in_review: '待验收', done: '已完成', blocked: '受阻', backlog: '待批准', canceled: '已取消',
}

const PRIO_LABEL: Record<string, string> = { high: 'P0', medium: 'P1', low: 'P2' }

const ROLE_LABEL: Record<string, string> = {
  requirement: '需求分析', researcher: '方案搜索', breaker: '任务拆解', 'test-designer': '测试设计',
  coder: '编码实现', reviewer: '代码审查', tester: '测试执行', devops: '部署运维',
}

function fmt(iso?: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleString('zh-CN', { hour12: false })
}

/** 子任务「内容」：优先取描述首行（拆解时写的一句话），退化为标题。 */
function childContent(c: HubTask): string {
  if (!c.description) return c.title
  const first = c.description.split('\n')[0].trim()
  return first.length > 0 ? first : c.title
}

/** 子任务「完成判定锚点」：优先取验收标准首条（拆解时写的完成口径），退化为边界或一句话。 */
function childAnchor(c: HubTask): string {
  if (c.acceptance && c.acceptance.length > 0) return c.acceptance[0]
  if (c.boundary?.do && c.boundary.do.length > 0) return c.boundary.do[0]
  return c.title
}

function runAgentOf(c: HubTask): string {
  return c.soldier ?? c.role ?? 'general'
}

/** 从描述中读取显式「波次：N」标记；若未标记，从 blockedBy 深度计算。 */
function childWave(c: HubTask, all: HubTask[]): number {
  const m = (c.description ?? '').match(/波次[:：]\s*(\d+)/)
  if (m) return Number(m[1])
  const deps = (c.blockedBy ?? []).map(b => all.find(x => x.id === b)).filter(Boolean) as HubTask[]
  if (deps.length === 0) return 1
  return 1 + Math.max(...deps.map(d => childWave(d, all)))
}

function childDeps(c: HubTask): string {
  const deps = c.blockedBy ?? []
  if (deps.length === 0) return '无'
  return '← ' + deps.join(', ')
}

export function TaskDetailModal({ taskId, onClose, onChanged }: TaskDetailModalProps): React.JSX.Element {
  const [task, setTask] = useState<HubTask | null>(null)
  const [timeline, setTimeline] = useState<HubActivity[]>([])
  const [children, setChildren] = useState<HubTask[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const t = await fetchHubTask(taskId)
      setTask(t)
      if (t.scope) {
        try {
          const all = await fetchHubTasks(t.scope)
          setChildren(all.filter(x => x.parent === taskId))
        } catch {
          setChildren([])
        }
      } else {
        setChildren([])
      }
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
  // 士兵 ❓ 提问待将军确认：最后一条评论以 ❓ 开头（守护标记待答复），将军答复后自动消失
  const askOpen = (): boolean => {
    const cs = t.comments ?? []
    if (cs.length === 0) return false
    return (cs[cs.length - 1].text ?? '').startsWith('❓')
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
  const doHold = (): Promise<void> => act(() => hubHold(t.id, true), `${t.id} 已拦截：守护不再自动认领/执行`)
  const doUnhold = (): Promise<void> => act(() => hubHold(t.id, false), `${t.id} 已放行：恢复自动交接`)
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
            {t.hold && <span className="status-pill hold">✋ 将军拦截中</span>}
            {askOpen() && <span className="status-pill ask">❓ 待将军确认</span>}
            <span className="td-title-text">{t.title}</span>
          </div>
          <div className="td-meta">
            指派：<b>{bindOf(t)}</b> · 空间：{t.scope ?? '—'} · 优先级：{t.priority} · v{t.version}
            {t.hold ? ' · 🖐 已拦截自动交接（守护跳过本任务）' : ''}
            {t.blockedBy.length > 0 ? ` · 依赖：${t.blockedBy.join('、')}` : ''}
            <div style={{ color: 'var(--muted-2)', fontSize: 10.5, marginTop: 2 }}>
              创建 {fmt(t.createdAt)} · 更新 {fmt(t.updatedAt)}
            </div>
          </div>

          {/* 拆解子任务 × 派工总览（父任务拆解出的子任务，由真实子任务卡驱动） */}
          {children.length > 0 && (
            <div className="td-section">
              <div className="td-section-title">🧩 拆解子任务 × 派工（{children.length}）</div>
              <div className="bd-summary">
                <div className="bd-row bd-head">
                  <span className="bd-prio">优先</span>
                  <span className="bd-id">子任务</span>
                  <span className="bd-content">内容</span>
                  <span className="bd-dep">依赖 / 波次</span>
                  <span className="bd-agent">自动运行智能体</span>
                  <span className="bd-anchor">完成判定锚点</span>
                  <span className="bd-status">状态</span>
                </div>
                {[...children]
                  .sort((a, b) => {
                    const pr = (PRIO_LABEL[a.priority] ?? 'P9').localeCompare(PRIO_LABEL[b.priority] ?? 'P9')
                    return pr !== 0 ? pr : a.id.localeCompare(b.id)
                  })
                  .map((c) => {
                    const wave = childWave(c, children)
                    return (
                      <div className="bd-row" key={c.id}>
                        <span className="bd-prio">{PRIO_LABEL[c.priority] ?? c.priority}</span>
                        <span className="bd-id">{c.id}</span>
                        <span className="bd-content" title={c.title}>{childContent(c)}</span>
                        <span className="bd-dep">
                          <span className="bd-wave">波{wave}</span>
                          <span className="bd-dep-list">{childDeps(c)}</span>
                        </span>
                        <span className="bd-agent">{ROLE_LABEL[runAgentOf(c)] ?? runAgentOf(c)}</span>
                        <span className="bd-anchor" title={c.acceptance?.join('\n') ?? ''}>{childAnchor(c)}</span>
                        <span className={`bd-status ${c.status}`}>{STATUS_PILL[c.status] ?? c.status}</span>
                      </div>
                    )
                  })}
              </div>
            </div>
          )}

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

          <div className="td-section">
            <div className="td-section-title">🚧 边界（做什么 / 不做什么）</div>
            {(t.boundary && ((t.boundary.do ?? []).length > 0 || (t.boundary.dont ?? []).length > 0)) ? (
              <>
                {(t.boundary.do ?? []).map((x, i) => (
                  <div key={`bd-do-${i}`} className="bd-item do">✅ {x}</div>
                ))}
                {(t.boundary.dont ?? []).map((x, i) => (
                  <div key={`bd-dont-${i}`} className="bd-item dont">🚫 {x}</div>
                ))}
              </>
            ) : (
              <div className="detail-warn">未定义边界——默认只做本任务范围、不越权、不 push（见描述与纪律）</div>
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
            {t.status !== 'done' && t.status !== 'canceled' && (
              t.hold ? (
                <button className="btn primary" disabled={busy} onClick={() => void doUnhold()} title="恢复自动交接：守护将按岗位认领并执行">
                  🚀 放行
                </button>
              ) : (
                <button className="btn" disabled={busy} onClick={() => void doHold()} title="将军拦截：守护不再自动认领/执行本任务，直到放行">
                  🖐 拦截自动
                </button>
              )
            )}
            <button className="btn ghost" disabled={busy} onClick={() => void doComment()}>💬 评论/记录</button>
            <button className="btn ghost" disabled={busy} onClick={() => void doReassign()}>转派</button>
          </div>
        </div>
      </div>
    </div>
  )
}
