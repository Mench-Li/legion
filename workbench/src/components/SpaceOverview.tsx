import { useEffect, useState } from 'react'
import { fetchHubTasks, fetchRoster } from '../api'
import type { HubTask, RosterAgent, SpaceInfo } from '../types'
interface Props { scope: string | null; spaces: SpaceInfo[]; hubMode: boolean; scenePicker?: boolean; onSelectSpace: (scope: string) => void; onNavigate: (page: string) => void }
export function SpaceOverview({ scope, spaces, hubMode, scenePicker = false, onSelectSpace, onNavigate }: Props): React.JSX.Element {
  const [data, setData] = useState<{ scope: string | null; tasks: HubTask[]; agents: RosterAgent[] } | null>(null)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let stopped = false
    setError(''); setData(null)
    if (!hubMode) return
    async function load(): Promise<void> {
      try {
        const [tasks, roster] = await Promise.all([fetchHubTasks(scope), fetchRoster(scope)])
        if (!stopped) { setData({ scope, tasks, agents: roster.agents }); setError('') }
      } catch (e) { if (!stopped) setError(e instanceof Error ? e.message : String(e)) }
    }
    void load(); const timer = setInterval(() => void load(), 20000)
    return () => { stopped = true; clearInterval(timer) }
  }, [scope, hubMode, refresh])
  const ready = data?.scope === scope ? data : null
  const shown = scope ? spaces.filter(space => space.id === scope) : spaces
  const tasks = ready?.tasks ?? []
  const agents = ready?.agents.filter(agent => !agent.external) ?? []
  const open = tasks.filter(task => !['done', 'canceled'].includes(task.status))
  function go(space: string, page: string): void { onSelectSpace(space); onNavigate(page) }
  return <section className="space-overview-page">
    <header className="workspace-page-heading"><div><h1>{scenePicker ? '团队场景' : scope ? `${shown[0]?.name ?? scope} · 空间概览` : '全部空间'}</h1><p>{scenePicker ? '选择空间，查看该空间的团队场景。' : '查看各空间的真实任务与注册岗位，进入空间后继续协作。'}</p></div><button className="btn" onClick={() => setRefresh(value => value + 1)}>刷新概览</button></header>
    {!hubMode && <div className="set-notice warn">连接团队中枢后可查看真实空间数据。</div>}
    {error && <div className="set-notice bad" role="alert">空间数据读取失败：{error}</div>}
    <div className="space-overview-metrics">{[['空间', shown.length], ['注册 Agent', agents.length], ['进行中', tasks.filter(t => t.status === 'in_progress').length], ['待验收', tasks.filter(t => t.status === 'in_review').length], ['受阻', tasks.filter(t => t.status === 'blocked').length], ['已完成', tasks.filter(t => t.status === 'done').length]].map(([label, value]) => <div key={label} className="panel"><span>{label}</span><strong>{ready ? value : '—'}</strong></div>)}</div>
    {hubMode && !ready && !error && <p className="workspace-empty">正在读取空间数据…</p>}
    <div className="space-overview-grid">{shown.map(space => {
      const ownTasks = tasks.filter(task => task.scope === space.id)
      const ownAgents = agents.filter(agent => agent.scope === space.id)
      const completed = ownTasks.filter(task => task.status === 'done').length
      const activeTasks = ownTasks.filter(task => !['done', 'canceled'].includes(task.status))
      return <article className="panel space-overview-card" key={space.id} data-space={space.id}><header><div><h2>{space.name}</h2><small>{space.id} · {space.private ? '私有空间' : '共享空间'}</small></div><span className="chip">{ready ? `${ownAgents.length} 个 Agent` : '读取中'}</span></header><p className="space-overview-repo">{space.localDir || '尚未绑定本地仓库'}</p><div className="space-overview-card-stats"><span>待处理 <b>{ready ? activeTasks.length : '—'}</b></span><span>受阻 <b>{ready ? ownTasks.filter(task => task.status === 'blocked').length : '—'}</b></span><span>已完成 <b>{ready ? completed : '—'}</b></span></div><div className="space-overview-card-actions"><button className="btn primary" onClick={() => go(space.id, scenePicker ? 'team-scene' : 'tasks')}>{scenePicker ? '进入团队场景' : '查看任务'}</button><button className="btn" onClick={() => go(space.id, 'agents')}>联系 Agent</button>{!scenePicker && <button className="btn" onClick={() => go(space.id, 'goals')}>目标与进展</button>}</div></article>
    })}</div>
    {!scenePicker && ready && <div className="panel space-overview-attention"><h2>需要关注</h2><p>当前范围有 {open.length} 个未完成任务，其中 {tasks.filter(task => task.status === 'blocked').length} 个受阻、{tasks.filter(task => task.status === 'in_review').length} 个待验收。</p><button className="btn" onClick={() => onNavigate('tasks')}>打开任务中心</button></div>}
    {ready && !shown.length && <div className="workspace-empty">当前没有可显示的空间。</div>}
  </section>
}
