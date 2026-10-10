import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchAgentDetails, postAgentCommand } from '../api'
import type { AgentDetail } from '../api'
import type { RosterAgent, SpaceInfo } from '../types'
import { ChatView } from './ChatView'
import { AgentTasksModal } from './AgentTasksModal'
import { AgentConversationPanel, CONTROL_LABEL } from './AgentConversationPanel'
import { TaskDetailModal } from './TaskDetailModal'
import { UiIcon } from './UiIcon'
import { AgentAvatar } from '../avatar'
import { toast } from './Toast'

interface Props {
  agent: RosterAgent | null; hubMode: boolean; spaces: SpaceInfo[]; roster: RosterAgent[] | null
  onModelSettings: () => void; onContactAgent: (scope: string, role: string) => void
}

/** 抽屉页签：控制（默认）/ 任务（原有清单）/ 产物 / 运行记录 / 规范。
 *
 *  为什么把「控制」并进**已有的**那个抽屉、而不是另开一个：`AgentWorkspace` 本来就有
 *  「任务清单」抽屉（`agent-context-drawer` → `AgentTasksModal`）。再加一个抽屉按钮会让同一个
 *  页面上出现两个"打开侧栏"的入口，而它们装的东西高度重叠（都是这个岗位的任务）。
 *  一个抽屉、多个页签是这里唯一不制造歧义的形状。 */
type DrawerTab = 'controls' | 'tasks' | 'artifacts' | 'records' | 'rules'

export function AgentWorkspace({ agent, hubMode, spaces, roster, onModelSettings, onContactAgent }: Props): React.JSX.Element {
  const [tab, setTab] = useState<'chat' | 'tasks'>(agent?.external ? 'tasks' : 'chat')
  const [drawer, setDrawer] = useState(false)
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('controls')
  const [taskId, setTaskId] = useState<string | null>(null)

  // ── C2：岗位详情（任务 / 待决策问题 / 命令历史）——**控制命令的唯一数据源** ──────
  // 每 3 秒重读是必需的：控制命令要带 attemptId / leaseEpoch / taskVersion 做并发保护，
  // 拿界面缓存的旧身份发命令会被服务端拒（或更糟——作用到错误的那一轮执行上）。
  const [detail, setDetail] = useState<AgentDetail | null>(null)
  const [detailError, setDetailError] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  /** 控制命令的幂等收据：同一次提交重发复用同一个 id（内容变了才换）。 */
  const commandRetry = useRef<{ payload: string; id: string } | null>(null)
  const roleRef = useRef<string | null>(null)
  const scope = agent?.scope ?? null
  roleRef.current = agent?.role ?? null

  const loadDetail = useCallback(async (): Promise<void> => {
    if (!hubMode || !scope) return
    try {
      const list = await fetchAgentDetails(scope)
      const role = roleRef.current
      if (role === null) return
      setDetail(list.find(a => a.role === role) ?? null)
      setDetailError('')
    } catch (e) {
      setDetail(null)
      setDetailError(e instanceof Error ? e.message : String(e))
    }
  }, [hubMode, scope])

  useEffect(() => {
    if (!agent || agent.external) { setDetail(null); setDetailError(''); return }
    void loadDetail()
    const timer = setInterval(() => void loadDetail(), 3000)
    return () => clearInterval(timer)
  }, [agent?.role, scope, loadDetail])

  // 换 Agent / 换空间：抽屉页签与待发命令都不能跨岗位残留（旧 taskVersion 会打到别人的任务上）
  useEffect(() => {
    setDrawerTab('controls')
    setDrawer(false)
    setNotice('')
    commandRetry.current = null
  }, [agent?.role, scope])

  /** 下发一条控制命令（暂停/恢复/停止/重跑）。
   *
   *  这几个动作**只有** `/api/agent-commands` 有——它们不是消息，是对调度的指令，
   *  所以不经过聊天通道。参数取自**刚读到的** `t`（不是界面上别处的缓存）。 */
  const control = async (type: string, t: AgentDetail['tasks'][number]): Promise<void> => {
    if (!detail || busy) return
    let resolutionNote: string | undefined
    if (type === 'resume_with_feedback') {
      const note = window.prompt('核对本次运行的工具记录及外部系统，确认没有已发生的外部写入后填写依据。填写后将创建新一轮执行；结果不确定请取消。')
      if (!note?.trim()) return
      resolutionNote = note.trim()
    }
    const roleAtCall = agent?.role ?? null
    const payload = {
      scope: detail.scope, agentId: detail.agentId, taskId: t.id, taskVersion: t.version,
      attemptId: t.attempt?.id, leaseEpoch: t.attempt?.lease_epoch, runId: t.runBinding?.run_id, type,
      ...(resolutionNote === undefined ? {} : { resolutionNote }),
    }
    const encoded = JSON.stringify(payload)
    if (commandRetry.current?.payload !== encoded) commandRetry.current = { payload: encoded, id: crypto.randomUUID() }
    setBusy(true); setNotice('')
    try {
      await postAgentCommand({ ...payload, clientRequestId: commandRetry.current.id })
      if (roleRef.current !== roleAtCall) return // 期间已切到别的 Agent → 丢弃写回
      commandRetry.current = null
      setNotice(`已提交「${CONTROL_LABEL[type] ?? type}」，等待执行方确认。`)
      void loadDetail()
    } catch (e) {
      if (roleRef.current === roleAtCall) toast('err', e instanceof Error ? e.message : String(e))
    } finally {
      if (roleRef.current === roleAtCall) setBusy(false)
    }
  }

  if (!agent || !agent.scope) return <section className="workspace-placeholder"><span className="placeholder-symbol"><UiIcon name="users" /></span><h1>选择一个 Agent</h1><p>按空间找到协作伙伴，点击头像即可进入对应对话。</p>{!hubMode && <p>连接团队中枢后可查看 Agent 与聊天记录。</p>}</section>
  const mode = { busy: '进行中', review: '待验收', blocked: '受阻', idle: '空闲' }[agent.mode]
  const space = spaces.find(s => s.id === agent.scope)
  return <section className="agent-workspace">
    <header className="agent-workspace-header"><span className="directory-avatar"><AgentAvatar token={agent.avatar} /></span><div><h1>{agent.name}</h1><p>{space?.name ?? agent.scope} · {agent.role} · {mode}</p></div><div className="agent-header-actions"><button className="btn" aria-expanded={drawer} onClick={() => setDrawer(v => !v)}><UiIcon name="panel" />任务与控制 {agent.tasks.length}</button><button className="ui-icon-button" aria-label="岗位默认模型" title="岗位默认模型" onClick={onModelSettings}><UiIcon name="settings" /></button></div></header>
    <div className="agent-workspace-tabs" role="tablist" aria-label="Agent 页面"><button id="agent-chat-tab" role="tab" aria-controls="agent-chat-panel" aria-selected={tab === 'chat'} disabled={agent.external} title={agent.external ? '外部执行者尚未注册为独立岗位，当前可查看任务' : undefined} className={tab === 'chat' ? 'selected' : ''} onClick={() => setTab('chat')}>对话</button><button id="agent-tasks-tab" role="tab" aria-controls="agent-tasks-panel" aria-selected={tab === 'tasks'} className={tab === 'tasks' ? 'selected' : ''} onClick={() => setTab('tasks')}>任务</button><span>{agent.external ? '外部执行者 · 可查看任务' : agent.kind}</span></div>
    <div className="agent-workspace-body">
      {!agent.external && <div id="agent-chat-panel" role="tabpanel" aria-labelledby="agent-chat-tab" hidden={tab !== 'chat'} className="agent-chat-pane"><ChatView scope={agent.scope} hubMode={hubMode} spaces={spaces} agent={agent} /></div>}
      {tab === 'tasks' && <div id="agent-tasks-panel" role="tabpanel" aria-labelledby="agent-tasks-tab" className="agent-full-tasks"><AgentTasksModal embedded agent={agent} roster={roster ?? undefined} onClose={() => { if (!agent.external) setTab('chat') }} onOpenTask={setTaskId} /></div>}
      {drawer && (
        <aside className="agent-context-drawer" aria-label="任务与控制">
          <div className="agent-drawer-tabs" role="tablist" aria-label="抽屉页签">
            {DRAWER_TABS.map(([key, label]) => (
              <button key={key} role="tab" aria-selected={drawerTab === key} className={`btn ghost${drawerTab === key ? ' selected' : ''}`} onClick={() => setDrawerTab(key)}>{label}</button>
            ))}
          </div>
          {drawerTab === 'tasks'
            ? <AgentTasksModal embedded agent={agent} roster={roster ?? undefined} onClose={() => setDrawer(false)} onOpenTask={id => { setDrawer(false); setTaskId(id) }} />
            : (
              <AgentConversationPanel
                agent={agent}
                view={drawerTab}
                detail={detail}
                error={detailError}
                busy={busy}
                notice={notice}
                onControl={(type, t) => void control(type, t)}
                onOpenTask={id => { setDrawer(false); setTaskId(id) }}
                onClose={() => setDrawer(false)}
              />
            )}
        </aside>
      )}
    </div>
    {taskId && <TaskDetailModal taskId={taskId} onClose={() => setTaskId(null)} onContactAgent={onContactAgent} />}
  </section>
}

const DRAWER_TABS: ReadonlyArray<readonly [DrawerTab, string]> = [
  ['controls', '控制'],
  ['tasks', '任务清单'],
  ['artifacts', '产物'],
  ['records', '运行记录'],
  ['rules', '规范'],
]
