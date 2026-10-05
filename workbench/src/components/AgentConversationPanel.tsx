import { useEffect, useState } from 'react'
import { fetchRule, fetchSkills } from '../api'
import type { AgentDetail } from '../api'
import type { RosterAgent } from '../types'

/**
 * 岗位「任务与控制」面板 —— **对话的侧抽屉**，不是第二个聊天界面。
 *
 * 历史与定位（修法 C 的 C2）：
 *   · 这个组件在 `1a1ee3fc` 被加进来时**从没有挂载点**（全仓无人 import），而它自带的 CSS 类
 *     （`.agent-conversation` / `.agent-chat-feed` / …）在 `index.css` 里一个都没有 ⇒ 死代码。
 *   · 它原先还含一套**完整的聊天界面**（feed + compose）。C 的方向是「一个 (空间, 岗位) 只有一条
 *     主对话」，再挂一套聊天界面就等于把"两条会话"从数据层搬到了界面上 —— 所以聊天归 `ChatView`，
 *     这里只保留**它独有的**能力：任务与控制命令、产物、运行记录、空间规范。
 *   · 「回答待决策问题」也留在 `ChatView` 的输入框里（那边才有草稿）；这里只列出问题并指路。
 *
 * ★ 它是**展示型组件**：任务/问题/命令历史全部由 `AgentWorkspace` 注入（`detail`/`busy`/`onControl`）。
 *   挂载点就是 `AgentWorkspace` 已有的那个侧抽屉（`agent-context-drawer`）——**没有新增抽屉按钮**：
 *   那里本来就有「任务清单」抽屉，再加一个会让同一页出现两个"打开侧栏"的入口。一个抽屉、多个页签。
 *
 *   为什么不让它自己轮询：控制按钮的参数（attemptId/leaseEpoch/taskVersion）必须有**唯一**来源。
 *   两个各自 3 秒轮询同一端点的副本 = 两个可能不一致的执行身份，而控制命令拿错身份会被服务端拒
 *   （或更糟——作用到错误的那一轮执行上）。所以详情由 `AgentWorkspace` 单点持有、向下注入。
 *   只有「规范」页自己拉取（一次性，不轮询，与详情无关）。
 *   （`ChatView` 为了意图下拉与待决策条也读同一份详情，但那是**只读**用途，不发控制命令。）
 */
type View = 'controls' | 'artifacts' | 'records' | 'rules'

export function AgentConversationPanel({
  agent, view = 'controls', detail, error, busy, notice, onControl, onOpenTask, onClose,
}: {
  agent: RosterAgent
  view?: View
  /** 由 ChatView 注入的岗位详情（任务/问题/命令历史）。null = 读取中。 */
  detail: AgentDetail | null
  error: string
  busy: boolean
  notice?: string
  /** 下发控制命令（幂等收据与并发参数由 ChatView 统一处理）。 */
  onControl: (type: string, task: AgentDetail['tasks'][number]) => void
  onOpenTask: (id: string) => void
  onClose?: () => void
}): React.JSX.Element {
  const scope = agent.scope ?? 'default'
  const [rules, setRules] = useState('')
  const [skills, setSkills] = useState<Array<{ id: string; name: string }>>([])
  const [rulesError, setRulesError] = useState('')

  // 「规范」页是唯一自取数据的地方：一次性读取，与详情轮询无关。
  useEffect(() => {
    if (view !== 'rules') return
    let active = true
    setRules('')
    setSkills([])
    setRulesError('')
    void Promise.all([fetchRule(scope), fetchSkills({ scope })]).then(([r, s]) => {
      if (!active) return
      setRules(r.content)
      setSkills(s)
    }).catch(e => { if (active) setRulesError(e instanceof Error ? e.message : String(e)) })
    return () => { active = false }
  }, [scope, view])

  const shown = rulesError || error

  if (view === 'rules') {
    return (
      <div className="agent-panel">
        <PanelHead title="空间规范与技能" subtitle={`${agent.name} · ${scope}`} onClose={onClose} />
        <div className="agent-panel-body">
          <p className="agent-note">岗位的实际生效规则以本轮输入快照为准；这里只是空间当前的规范与技能目录，改动影响新执行。</p>
          <pre className="agent-pre">{rules || '尚无空间规范'}</pre>
          <div className="agent-sub">技能目录（{skills.length}）</div>
          {skills.length === 0 && <p className="agent-note">尚无技能。</p>}
          {skills.map(s => <p key={s.id} className="agent-note">{s.name} · {s.id}</p>)}
          {shown && <p className="agent-error" role="alert">{shown}</p>}
        </div>
      </div>
    )
  }

  if (view === 'artifacts') {
    return (
      <div className="agent-panel">
        <PanelHead title="产物" subtitle={`${agent.name} · ${scope}`} onClose={onClose} />
        <div className="agent-panel-body">
          {!detail && !shown && <p className="agent-note">读取中…</p>}
          {detail?.tasks.length === 0 && <p className="agent-note">该岗位还没有任务记录。</p>}
          {detail?.tasks.map(t => (
            <section key={t.id} className="agent-panel-task">
              <div className="agent-panel-task-head">
                <button className="btn ghost" onClick={() => onOpenTask(t.id)}>{t.id} · {t.title}</button>
                <span className="agent-badge">{t.status}</span>
              </div>
              <pre className="agent-pre">{JSON.stringify(t.artifacts, null, 2)}</pre>
            </section>
          ))}
          {shown && <p className="agent-error" role="alert">{shown}</p>}
        </div>
      </div>
    )
  }

  if (view === 'records') {
    return (
      <div className="agent-panel">
        <PanelHead title="运行记录" subtitle={`${agent.name} · ${scope}`} onClose={onClose} />
        <div className="agent-panel-body">
          <p className="agent-note">打开任务可查看实际输入、事件与证据；这里只列执行身份与命令历史。</p>
          {detail?.tasks.length === 0 && <p className="agent-note">该岗位还没有任务记录。</p>}
          {detail?.tasks.map(t => (
            <p key={t.id} className="agent-note">
              <button className="btn ghost" onClick={() => onOpenTask(t.id)}>{t.id}</button>
              {' · '}{t.attempt?.state ?? '无运行记录'}{' · '}{t.runBinding?.run_id ?? '无执行连接'}
            </p>
          ))}
          {detail && detail.commands.length > 0 && <div className="agent-sub">控制命令历史</div>}
          {detail?.commands.map(c => (
            <p key={c.id} className="agent-note">
              {c.task_id} · {CONTROL_LABEL[c.type] ?? c.type} · {c.status}{c.result ? ` · ${c.result}` : ''}
            </p>
          ))}
          {shown && <p className="agent-error" role="alert">{shown}</p>}
        </div>
      </div>
    )
  }

  const openQuestions = detail?.questions.filter(q => q.status === 'open') ?? []
  return (
    <div className="agent-panel">
      <PanelHead title="任务与控制" subtitle={`${agent.name} · ${scope}`} onClose={onClose} />
      <div className="agent-panel-body">
        <div className="agent-status">
          <span className="agent-badge">{detail?.executionState ?? '读取状态中'}</span>
          <span className="agent-note">进度依据已保存记录回答；需要模型答问时要有在线回复守护</span>
        </div>
        {notice && <p className="agent-ok">{notice}</p>}
        {shown && <p className="agent-error" role="alert">{shown}</p>}

        {openQuestions.length > 0 && (
          <>
            <div className="agent-sub">待决策（{openQuestions.length}）</div>
            {openQuestions.map(q => (
              <div key={q.id} className="agent-question">
                <div>{q.task_id} 待决策：{q.body}</div>
                <div className="agent-note">在右侧输入框写下你的决定，再点「回答待决策」提交。</div>
              </div>
            ))}
          </>
        )}

        <div className="agent-sub">任务（{detail?.tasks.length ?? 0}）</div>
        {detail?.tasks.length === 0 && <p className="agent-note">该岗位还没有任务记录。</p>}
        {detail?.tasks.map(t => {
          const terminal = ['done', 'canceled'].includes(t.status)
          const running = t.attempt?.state === 'Running' && t.runBinding !== null
          return (
            <section key={t.id} className="agent-panel-task">
              <div className="agent-panel-task-head">
                <button className="btn ghost" onClick={() => onOpenTask(t.id)}>{t.id} · {t.title}</button>
                <span className="agent-badge">{t.status}</span>
                {t.hold && <span className="agent-badge warn">已暂停调度</span>}
                {t.attempt && <span className="agent-note">本轮 {t.attempt.state}</span>}
              </div>
              <div className="agent-panel-task-controls">
                <button className="btn ghost" onClick={() => onOpenTask(t.id)}>查看任务与证据</button>
                {!t.hold && !terminal && (
                  <button className="btn" disabled={busy} onClick={() => onControl('hold_task', t)}>暂停后续调度</button>
                )}
                {t.hold && t.dispatchHoldOwned && !terminal && (
                  <button className="btn" disabled={busy} onClick={() => onControl('release_hold', t)}>恢复后续调度</button>
                )}
                {running && (
                  <button className="btn" disabled={busy} onClick={() => onControl('stop_run', t)}>停止本次执行</button>
                )}
                {running && !t.hold && t.attempt?.external_effect === 'absent' && (
                  <button className="btn" disabled={busy} onClick={() => onControl('restart_with_feedback', t)}>停止后重新执行</button>
                )}
                {t.attempt?.state === 'Cancelled' && t.runBinding && t.hold && t.dispatchHoldOwned && (
                  <button className="btn" disabled={busy} onClick={() => onControl('resume_with_feedback', t)}>核对后按新要求重跑</button>
                )}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

/** 控制命令的中文名（界面上不出现裸英文枚举）。 */
export const CONTROL_LABEL: Record<string, string> = {
  hold_task: '暂停后续调度',
  release_hold: '恢复后续调度',
  stop_run: '停止本次执行',
  restart_with_feedback: '停止后重新执行',
  resume_with_feedback: '核对后按新要求重跑',
}

function PanelHead({ title, subtitle, onClose }: { title: string; subtitle: string; onClose?: () => void }): React.JSX.Element {
  return (
    <div className="agent-panel-head">
      <span className="tag">{title}</span>
      <span className="agent-note">{subtitle}</span>
      {onClose && <button className="btn ghost" style={{ marginLeft: 'auto' }} onClick={onClose} title="关闭">✕</button>}
    </div>
  )
}
