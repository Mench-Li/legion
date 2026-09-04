import { useCallback, useEffect, useState } from 'react'
import { execRequest, fetchHubActivity, fetchHubOverlaps, fetchHubTask, fetchHubTasks, hubClaim, hubComment, hubHold, hubReassign, hubReviewNote, hubTransition } from '../api'
import type { AuditPatch, HubActivity, HubTask, OverlapGroup, ReviewNote } from '../types'
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
  patch: '🔧 补丁登记',
  artifact: '📦 产物登记',
  'review-note': '🧾 审计批注',
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

/** 改动类型徽标文字。 */
const AUDIT_ST: Record<string, string> = { A: '新增', M: '修改', D: '删除', R: '重命名', C: '复制', U: '未合并' }

/** 把整份 unified diff 按文件切成段：{path → 该文件的 hunks 文本}，用于逐文件展开审计。 */
function splitDiffByFile(diff: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = []
  let cur: { file: string; text: string[] } | null = null
  for (const line of diff.split('\n')) {
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
    if (m) {
      if (cur) out.push({ file: cur.file, text: cur.text.join('\n') })
      cur = { file: m[2], text: [line] }
    } else if (cur) {
      cur.text.push(line)
    } else {
      out.push({ file: '', text: line })
    }
  }
  if (cur) out.push({ file: cur.file, text: cur.text.join('\n') })
  return out
}

/** 归一化补丁条目的 files：新版结构化数组 / 旧版逗号字符串 → 行数据。 */
function normPatchFiles(p: AuditPatch | string): Array<{ path: string; status: string; add: number; del: number }> {
  if (typeof p === 'string') return []
  if (Array.isArray(p.files)) return p.files
  if (typeof p.files === 'string') {
    return p.files.split(',').map(s => s.trim()).filter(Boolean).map(path => ({ path, status: 'M', add: 0, del: 0 }))
  }
  return []
}

/** 某文件/整体的最新批注。 */
function noteOf(notes: ReviewNote[] | undefined, file: string): ReviewNote | undefined {
  const hits = (notes ?? []).filter(n => n.file === file)
  return hits.length > 0 ? hits[hits.length - 1] : undefined
}

/** L3 重叠任务状态点色。 */
const OVERLAP_DOT: Record<string, string> = {
  in_progress: 'var(--green)', in_review: 'var(--yellow)', blocked: 'var(--red)',
  todo: 'var(--muted-2)', backlog: 'var(--muted-2)', done: 'var(--muted-2)', canceled: 'var(--muted-2)',
}
const OVERLAP_ST: Record<string, string> = {
  in_progress: '进行中', in_review: '待验收', blocked: '受阻',
  todo: '待认领', backlog: '待批准', done: '已完成', canceled: '已取消',
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
  const [auditOpen, setAuditOpen] = useState<Record<string, boolean>>({})
  const [overlaps, setOverlaps] = useState<OverlapGroup[]>([])

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
      // L3：本任务涉及的跨任务改动重叠（同一文件被其他任务改动）
      try {
        const ov = await fetchHubOverlaps(t.scope ?? null, taskId)
        setOverlaps(ov.groups)
      } catch {
        setOverlaps([])
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
  // 已由执行守护（soldier-auto）派工/认领过：AI 正在或已经跑过，不要重复点「派 AI 执行」
  const daemonInvolved = (t.comments ?? []).some(c => c.by === 'soldier-auto') || (t.evidence ?? []).some(e => e.by === 'soldier-auto')
  // 进行中且已有认领者（soldier 非空 = 已被某智能体/守护认领开工）→ 视为已派工在跑
  const aiRunning = t.status === 'in_progress' && (daemonInvolved || (t.soldier !== null && t.soldier !== undefined))

  // —— L1/L2 审计工作台状态 ——
  // —— L1/L2 审计工作台（patchObjs 在 t 绑定后派生；其余在渲染内按补丁计算）——
  const patchObjs = (t.patches ?? []).filter((p): p is AuditPatch => typeof p !== 'string')
  const canAudit = t.status === 'in_review' || t.status === 'done'
  const overall = noteOf(t.reviewNotes, '*')
  const openFile = (f: string): void => setAuditOpen(prev => ({ ...prev, [f]: !prev[f] }))
  const markAudit = (file: string, verdict: 'ok' | 'issue'): Promise<void> => {
    const note = verdict === 'issue' ? window.prompt(`问题说明（将随打回原因一并交付下一轮 worker）`, '') ?? '' : ''
    return act(() => hubReviewNote(t.id, file, verdict, note), `已批注 ${file === '*' ? '整体' : file}：${verdict === 'ok' ? 'OK ✓' : '有问题 ✘'}`)
  }
  const clearAudit = (file: string): Promise<void> => act(() => hubReviewNote(t.id, file, 'clear', ''), `已清除 ${file} 的批注`)

  const doReview = (): Promise<void> => act(() => hubTransition({ id: t.id, to: 'done', by: 'general', ifVersion: t.version }), `${t.id} 已验收通过 ✓`)
  const doReject = (): Promise<void> => {
    const reason = window.prompt(`打回 ${t.id} 的原因（归还待办）`)
    if (reason === null) return Promise.resolve()
    const issues = (t.reviewNotes ?? []).filter(n => n.verdict === 'issue')
    const noteLines = issues.map(n => `- ${n.file === '*' ? '整体' : n.file}${n.note ? `：${n.note}` : ''}`)
    const body = noteLines.length > 0
      ? `↩ 打回重做：${reason.trim()}\n📋 审计批注（按文件）：\n${noteLines.join('\n')}`
      : `↩ 打回重做：${reason.trim()}`
    return act(async () => {
      await hubComment(t.id, body)
      await hubTransition({ id: t.id, to: 'todo', by: bindOf(t), ifVersion: t.version })
    }, `${t.id} 已打回（批注已交付下一轮 worker）`)
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
                {(t.patches ?? []).filter(p => typeof p === 'string').length > 0 && (
                  <div className="proc-patch">🔧 补丁 {(t.patches ?? []).filter(p => typeof p === 'string').join('、')}</div>
                )}
              </>
            ) : t.status === 'in_progress' ? (
              <div className="proc-empty">
                🟢 任务已在进行中，AI worker 正在执行（通常 5–15 分钟）——每轮派工/完成/异常会实时沉淀到此处。
                {!aiRunning && (
                  <>
                    <br />
                    若该任务是手工开工、尚未派 AI，可点下方「🤖 派 AI 执行」。
                  </>
                )}
              </div>
            ) : (
              <div className="proc-empty">
                ⏳ 该任务还没有 AI 执行过程——目前只是状态标记。
                <br />
                AI 智能体认领执行后，它的每一步行动、产出与汇报会实时沉淀在这里（下方时间线 + 过程记录），完成时提交待验收。
              </div>
            )}
          </div>

          {/* 审计工作台：改动文件 × diff × 批注 × 测试/产物证据（L1+L2，Codex 式任务收尾审计） */}
          {(patchObjs.length > 0 || (t.artifacts ?? []).length > 0 || t.testReport) && (
            <div className="td-section">
              <div className="td-section-title">
                🧾 审计：改动 × 证据
                {canAudit && <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--muted-2)' }}>（验收前逐文件过一遍，问题 ✘ 会随打回交付）</span>}
              </div>

              {/* L3：本任务文件与空间内其他任务的改动重叠（并行合入风险） */}
              {overlaps.length > 0 && (
                <div style={{ margin: '4px 0 8px', padding: '8px 10px', borderRadius: 6, background: 'rgba(246,191,38,.07)', border: '1px solid rgba(246,191,38,.28)' }}>
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--yellow)', marginBottom: 4 }}>
                    ⚠ 并行改动重叠（L3）：下列文件同时被其他任务改动——验收/合入时注意顺序与语义冲突
                  </div>
                  {overlaps.map(g => {
                    const mine = g.tasks.filter(x => x.id === t.id)
                    const others = g.tasks.filter(x => x.id !== t.id)
                    const live = others.some(x => x.status === 'in_progress' || x.status === 'in_review')
                    return (
                      <div key={g.file} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 11, lineHeight: 1.7 }}>
                        <code style={{ flex: 1, minWidth: 0, color: live ? 'var(--yellow)' : 'var(--text)', wordBreak: 'break-all' }} title={g.file}>{g.file}</code>
                        {mine.map(x => <span key={x.id} className="ov-chip" style={{ color: 'var(--yellow)' }}>◉ {x.id}（本任务）</span>)}
                        {others.map(x => (
                          <span key={x.id} className="ov-chip" style={{ whiteSpace: 'nowrap' }} title={`${x.title}\n${OVERLAP_ST[x.status] ?? x.status}`}>
                            <span className="st-dot" style={{ background: OVERLAP_DOT[x.status] }} /> {x.id} · {OVERLAP_ST[x.status] ?? x.status}
                          </span>
                        ))}
                      </div>
                    )
                  })}
                </div>
              )}

              {/* 测试报告（D7' 机器闸门 / 结构化报告） */}
              {t.testReport && (
                <div className={`tr-card ${t.testReport.passed ? 'pass' : 'fail'}`}>
                  <span className="tr-badge">{t.testReport.passed ? '✅ 测试通过' : '❌ 测试失败'}</span>
                  {t.testReport.summary && <div className="tr-summary">{t.testReport.summary}</div>}
                  {!t.testReport.passed && (t.testReport.failures ?? []).map((f, i) => (
                    <div key={i} className="tr-fail">
                      <b>{f.name}</b>
                      {f.repro && <div className="tr-repro">复现：{f.repro}</div>}
                      {f.log && <pre className="tr-log">{f.log.slice(0, 1200)}</pre>}
                    </div>
                  ))}
                  <div className="tr-meta">{t.testReport.by} · {fmt(t.testReport.at)}</div>
                </div>
              )}

              {/* 产物 */}
              {(t.artifacts ?? []).length > 0 && (
                <div style={{ margin: '6px 0' }}>
                  {(t.artifacts ?? []).map((a, i) => (
                    <div key={i} className="proc-item" style={{ borderBottom: 'none' }}>
                      <span className="proc-who">📦 产物</span>
                      <span className="proc-at">{a.kind}</span>
                      <div className="proc-text">
                        {a.kind === 'url'
                          ? <a href={a.path} target="_blank" rel="noreferrer">{a.title || a.path}</a>
                          : <span>{a.title ? `${a.title} — ` : ''}<code>{a.path}</code></span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* 补丁记录（最新一轮优先；多轮补齐可见） */}
              {[...patchObjs].reverse().map((p, idx) => {
                const files = normPatchFiles(p)
                const sections = p.diff ? splitDiffByFile(p.diff) : []
                const at = idx === 0 ? '（最新）' : ''
                return (
                  <div key={`${p.at}-${idx}`} style={{ marginBottom: 6 }}>
                    {patchObjs.length > 1 && (
                      <div style={{ fontSize: 10.5, color: 'var(--muted-2)', margin: '4px 0' }}>
                        第 {patchObjs.length - idx} 轮补丁 {at} · {p.by} · {fmt(p.at)}
                      </div>
                    )}
                    {p.summary && <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>✏️ {p.summary}</div>}
                    {files.length === 0 && !p.diff && (
                      <div className="detail-warn">（无结构化 diff 记录——本轮未进入隔离 worktree 或旧格式）</div>
                    )}
                    {files.map(f => {
                      const note = noteOf(t.reviewNotes, f.path)
                      const open = !!auditOpen[f.path]
                      const sec = sections.find(s => s.file === f.path)
                      return (
                        <div key={f.path}>
                          <div className="audit-row" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 12 }}>
                            <span className={`audit-st ${f.status}`} title={AUDIT_ST[f.status] ?? f.status}>{AUDIT_ST[f.status] ?? f.status}</span>
                            <code style={{ flex: 1, color: 'var(--text)' }}>{f.path}</code>
                            <span style={{ color: 'var(--muted-2)', fontSize: 10.5 }}>
                              {f.add > 0 && <span style={{ color: 'var(--green)' }}>+{f.add}</span>}
                              {f.del > 0 && <span style={{ color: 'var(--red)' }}> −{f.del}</span>}
                            </span>
                            {note && note.verdict === 'ok' && <span style={{ color: 'var(--green)', fontSize: 10.5 }}>✓ OK</span>}
                            {note && note.verdict === 'issue' && <span style={{ color: 'var(--red)', fontSize: 10.5 }} title={note.note}>✘ 有问题{note.note ? '：' + note.note.slice(0, 80) : ''}</span>}
                            {canAudit && (
                              <>
                                <button className="btn mini" onClick={() => void markAudit(f.path, 'ok')} title="审计通过该文件">✓</button>
                                <button className="btn mini" onClick={() => void markAudit(f.path, 'issue')} title="该文件有问题（打回时交付下一轮）">✘</button>
                                {note && <button className="btn mini ghost" onClick={() => void clearAudit(f.path)} title="清除批注">✕</button>}
                              </>
                            )}
                            {sec && (
                              <button className="btn mini ghost" onClick={() => openFile(f.path)} title="展开/收起 diff">
                                {open ? '▴ 收起 diff' : '▾ 查看 diff'}
                              </button>
                            )}
                          </div>
                          {open && sec && (
                            <pre className="audit-diff">{sec.text.slice(0, 6000)}{sec.text.length > 6000 ? '\n…（diff 过长已截断）' : ''}</pre>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )
              })}

              {/* 整体结论 */}
              {canAudit && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, paddingTop: 6, borderTop: '1px solid var(--line, rgba(255,255,255,.06))' }}>
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>整体结论：</span>
                  {overall && overall.verdict === 'ok' && <span style={{ color: 'var(--green)', fontSize: 11.5 }}>✓ 通过{overall.note ? `：${overall.note}` : ''}（{overall.by} · {fmt(overall.at)}）</span>}
                  {overall && overall.verdict === 'issue' && <span style={{ color: 'var(--red)', fontSize: 11.5 }}>✘ 有问题{overall.note ? `：${overall.note}` : ''}</span>}
                  <button className="btn mini" onClick={() => void markAudit('*', 'ok')} title="整体验收通过">✓ 验收通过</button>
                  <button className="btn mini" onClick={() => void markAudit('*', 'issue')} title="整体有问题（打回交付说明）">✘ 有问题</button>
                  {overall && <button className="btn mini ghost" onClick={() => void clearAudit('*')}>清除</button>}
                </div>
              )}
              {!canAudit && (t.reviewNotes ?? []).length > 0 && (
                <div style={{ marginTop: 6, fontSize: 10.5, color: 'var(--muted-2)' }}>已保存批注 {(t.reviewNotes ?? []).length} 条（进入待验收/完成后可继续批注）</div>
              )}
            </div>
          )}

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
              t.status === 'in_progress' && aiRunning ? (
                <button className="btn ghost" disabled title="该任务已认领并派 AI 执行中——完成/异常会自动更新，无需重复派发">
                  🤖 AI 执行中（已派工）
                </button>
              ) : (
                <button className="btn" disabled={busy} onClick={() => void doAskAI()} title="请求 AI 智能体认领并执行本任务（过程与产出会沉淀到下方）">
                  🤖 派 AI 执行
                </button>
              )
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
