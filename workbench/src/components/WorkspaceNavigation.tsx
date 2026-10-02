import { useEffect, useState } from 'react'
import { fetchRoster } from '../api'
import { agentKey, groupFor, NAV_GROUPS, SUB_NAV, TASK_VIEWS } from '../navigation'
import type { TaskViewId } from '../navigation'
import type { RosterAgent, SpaceInfo } from '../types'
import { UiIcon } from './UiIcon'

interface Props {
  active: string; scope: string | null; hubMode: boolean; spaces: SpaceInfo[]
  onNavigate: (id: string) => void; onSelectScope: (scope: string | null) => void
  onNewSpace: () => void; onSpaceSettings?: (space: SpaceInfo) => void
  notifyUnread: number; selectedAgent: RosterAgent | null; onPickAgent: (agent: RosterAgent) => void
  taskView: TaskViewId; onTaskView: (view: TaskViewId) => void
  open: boolean; onClose: () => void
  onAgentsRefreshed: (agents: RosterAgent[]) => void
}
const modeLabel = { busy: '进行中', review: '待验收', blocked: '受阻', idle: '空闲' }
export function WorkspaceNavigation(props: Props): React.JSX.Element {
  const { active, scope, hubMode, spaces, onNavigate, onSelectScope, onNewSpace, onSpaceSettings, notifyUnread, selectedAgent, onPickAgent, taskView, onTaskView, open, onClose, onAgentsRefreshed } = props
  const [agents, setAgents] = useState<RosterAgent[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const group = groupFor(active)
  useEffect(() => {
    if (!hubMode || group !== 'agents') return
    let stopped = false
    setLoading(true)
    const load = async (): Promise<void> => {
      try { const rows = await fetchRoster(null); if (!stopped) { setAgents(rows.agents); onAgentsRefreshed(rows.agents); setError('') } }
      catch (e) { if (!stopped) { setAgents([]); setError(e instanceof Error ? e.message : String(e)) } }
      finally { if (!stopped) setLoading(false) }
    }
    void load()
    const timer = window.setInterval(() => void load(), 20000)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [hubMode, group, spaces, onAgentsRefreshed])
  const navigate = (id: string): void => { onNavigate(id); onClose() }
  return <>
    <nav className="app-rail" aria-label="主导航">
      <button className="workspace-brand" title="Legion 协作台" onClick={() => navigate('home')} aria-label="Legion 协作台首页"><img src={`${import.meta.env.BASE_URL}legion-icon.png`} alt="" /></button>
      {NAV_GROUPS.filter(g => g.id !== 'settings').map(g => <button key={g.id} className={`rail-button${group === g.id ? ' selected' : ''}`} title={g.name} aria-label={g.name} aria-current={group === g.id ? 'page' : undefined} onClick={() => navigate(g.target)}><UiIcon name={g.icon} />{g.id === 'activity' && notifyUnread > 0 && <span className="rail-notification" aria-label={`${notifyUnread} 条未读通知`}>{notifyUnread > 99 ? '99+' : notifyUnread}</span>}</button>)}
      <div className="rail-end"><button className={`rail-button${group === 'settings' ? ' selected' : ''}`} title="设置" aria-label="设置" aria-current={group === 'settings' ? 'page' : undefined} onClick={() => navigate('settings-spaces')}><UiIcon name="settings" /></button><span className="workspace-user" title="空间管理员">管</span></div>
    </nav>
    {open && <button className="sidebar-backdrop" aria-label="关闭导航" onClick={onClose} />}
    <aside className={`workspace-sidebar${open ? ' mobile-open' : ''}`} aria-label={`${NAV_GROUPS.find(g => g.id === group)?.name}导航`}>
      <div className="workspace-side-head"><h2>{NAV_GROUPS.find(g => g.id === group)?.name}</h2><button className="ui-icon-button" title="新建空间" aria-label="新建空间" onClick={onNewSpace}>＋</button><button className="ui-icon-button mobile-close" aria-label="关闭导航" onClick={onClose}><UiIcon name="close" /></button></div>
      <div className="workspace-space-picker"><select aria-label="选择工作空间" value={scope ?? ''} onChange={e => onSelectScope(e.target.value || null)}><option value="">全部空间</option>{spaces.map(s => <option key={s.id} value={s.id}>{s.name}{s.private ? ' · 本地' : ''}</option>)}</select></div>
      <div className="workspace-side-scroll">
        {group === 'agents' ? <>
          <label className="directory-search"><UiIcon name="search" /><input aria-label="搜索 Agent 或空间" placeholder="搜索名称、岗位或空间" value={query} onChange={e => setQuery(e.target.value)} /></label>
          {!hubMode && <div className="workspace-empty">连接团队中枢后可查看空间中的 Agent。</div>}
          {loading && <div className="workspace-empty">正在读取 Agent…</div>}
          {error && <div className="workspace-error" role="alert">Agent 列表读取失败：{error}</div>}
          {spaces.filter(s => !scope || s.id === scope).map(space => {
            const list = agents.filter(a => a.scope === space.id && `${a.name} ${a.role} ${space.name}`.toLowerCase().includes(query.toLowerCase()))
            if (query && !list.length) return null
            const folded = collapsed.has(space.id)
            return <section className="directory-group" key={space.id}>
              <div className="directory-group-head"><button aria-expanded={!folded} onClick={() => setCollapsed(previous => { const next = new Set(previous); if (folded) next.delete(space.id); else next.add(space.id); return next })}><span>{folded ? '›' : '⌄'}</span>{space.name}<small>{list.length}</small></button>{onSpaceSettings && <button className="ui-icon-button" aria-label={`${space.name}设置`} onClick={() => onSpaceSettings(space)}><UiIcon name="settings" /></button>}</div>
              {!folded && <div>{list.map(a => { const selected = selectedAgent && agentKey(selectedAgent.scope ?? '', selectedAgent.role) === agentKey(a.scope ?? '', a.role) && active === 'agents'; return <button key={agentKey(a.scope ?? '', a.role)} className={`directory-agent${selected ? ' selected' : ''}`} aria-current={selected ? 'true' : undefined} onClick={() => { onPickAgent(a); onClose() }}><span className="directory-avatar">{a.name.slice(0, 1)}</span><span className="directory-agent-meta"><strong>{a.name}</strong><small className={a.mode === 'blocked' ? 'attention' : ''}>{a.external ? '外部执行者 · 查看任务' : `${modeLabel[a.mode]} · ${a.tasks.length} 个活动任务`}</small></span></button> })}{!list.length && !loading && <div className="workspace-empty">该空间尚无 Agent。</div>}<button className="space-discussion" onClick={() => { onSelectScope(space.id); navigate('chat') }}><UiIcon name="chat" />空间会话</button></div>}
            </section>
          })}
          {query && !agents.some(a => `${a.name} ${a.role} ${spaces.find(s => s.id === a.scope)?.name ?? ''}`.toLowerCase().includes(query.toLowerCase()) && (!scope || a.scope === scope)) && <div className="workspace-empty">没有匹配的 Agent。</div>}
        </> : <>
          {SUB_NAV[group].map(item => <button key={item.id} className={`workspace-subnav${active === item.id ? ' selected' : ''}`} onClick={() => navigate(item.id)} aria-current={active === item.id ? 'page' : undefined}>{item.name}</button>)}
          {group === 'tasks' && <><div className="workspace-side-label">任务视角</div>{TASK_VIEWS.map(view => <button key={view.id} className={`workspace-subnav${active === 'tasks' && taskView === view.id ? ' selected' : ''}`} onClick={() => { onTaskView(view.id); navigate('tasks') }}>{view.name}</button>)}</>}
        </>}
      </div>
      <div className="workspace-side-footer"><strong>Legion 协作台</strong><span>{hubMode ? '团队中枢' : '文件模式'}</span></div>
    </aside>
  </>
}
