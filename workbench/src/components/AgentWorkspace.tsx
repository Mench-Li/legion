import { useState } from 'react'
import type { RosterAgent, SpaceInfo } from '../types'
import { ChatView } from './ChatView'
import { AgentTasksModal } from './AgentTasksModal'
import { TaskDetailModal } from './TaskDetailModal'
import { UiIcon } from './UiIcon'
interface Props {
  agent: RosterAgent | null; hubMode: boolean; spaces: SpaceInfo[]; roster: RosterAgent[] | null
  onModelSettings: () => void; onContactAgent: (scope: string, role: string) => void
}
export function AgentWorkspace({ agent, hubMode, spaces, roster, onModelSettings, onContactAgent }: Props): React.JSX.Element {
  const [tab, setTab] = useState<'chat' | 'tasks'>(agent?.external ? 'tasks' : 'chat')
  const [drawer, setDrawer] = useState(false)
  const [taskId, setTaskId] = useState<string | null>(null)
  if (!agent || !agent.scope) return <section className="workspace-placeholder"><span className="placeholder-symbol"><UiIcon name="users" /></span><h1>选择一个 Agent</h1><p>按空间找到协作伙伴，点击头像即可进入对应对话。</p>{!hubMode && <p>连接团队中枢后可查看 Agent 与聊天记录。</p>}</section>
  const mode = { busy: '进行中', review: '待验收', blocked: '受阻', idle: '空闲' }[agent.mode]
  const space = spaces.find(s => s.id === agent.scope)
  return <section className="agent-workspace">
    <header className="agent-workspace-header"><span className="directory-avatar">{agent.name.slice(0, 1)}</span><div><h1>{agent.name}</h1><p>{space?.name ?? agent.scope} · {agent.role} · {mode}</p></div><div className="agent-header-actions"><button className="btn" aria-expanded={drawer} onClick={() => setDrawer(v => !v)}><UiIcon name="panel" />任务清单 {agent.tasks.length}</button><button className="ui-icon-button" aria-label="岗位默认模型" title="岗位默认模型" onClick={onModelSettings}><UiIcon name="settings" /></button></div></header>
    <div className="agent-workspace-tabs" role="tablist" aria-label="Agent 页面"><button id="agent-chat-tab" role="tab" aria-controls="agent-chat-panel" aria-selected={tab === 'chat'} disabled={agent.external} title={agent.external ? '外部执行者尚未注册为独立岗位，当前可查看任务' : undefined} className={tab === 'chat' ? 'selected' : ''} onClick={() => setTab('chat')}>对话</button><button id="agent-tasks-tab" role="tab" aria-controls="agent-tasks-panel" aria-selected={tab === 'tasks'} className={tab === 'tasks' ? 'selected' : ''} onClick={() => setTab('tasks')}>任务</button><span>{agent.external ? '外部执行者 · 可查看任务' : agent.kind}</span></div>
    <div className="agent-workspace-body">
      {!agent.external && <div id="agent-chat-panel" role="tabpanel" aria-labelledby="agent-chat-tab" hidden={tab !== 'chat'} className="agent-chat-pane"><ChatView scope={agent.scope} hubMode={hubMode} spaces={spaces} agent={agent} /></div>}
      {tab === 'tasks' && <div id="agent-tasks-panel" role="tabpanel" aria-labelledby="agent-tasks-tab" className="agent-full-tasks"><AgentTasksModal embedded agent={agent} roster={roster ?? undefined} onClose={() => { if (!agent.external) setTab('chat') }} onOpenTask={setTaskId} /></div>}
      {drawer && <aside className="agent-context-drawer" aria-label="Agent 关联任务"><AgentTasksModal embedded agent={agent} roster={roster ?? undefined} onClose={() => setDrawer(false)} onOpenTask={setTaskId} /></aside>}
    </div>
    {taskId && <TaskDetailModal taskId={taskId} onClose={() => setTaskId(null)} onContactAgent={onContactAgent} />}
  </section>
}
