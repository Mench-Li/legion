import { useState } from 'react'
import { getToken, hubBase, setHubBase, setToken } from '../api'
import type { RosterAgent, SpaceInfo } from '../types'
import { AgentWorkflowConfigurator } from './AgentWorkflowConfigurator'
import { ModelConfigModal } from './ModelConfigModal'
import { AccountPanel } from './AccountPanel'
import { DevicePanel } from './DevicePanel'

interface Props {
  active: string; scope: string | null; spaces: SpaceInfo[]; roster: RosterAgent[] | null
  hubMode: boolean; execEnabled: boolean; execDaemonOnline: boolean
  onToggleExec: (enabled: boolean) => void
  onNewSpace: () => void; onSpaceSettings: (space: SpaceInfo) => void
}
export function WorkspaceSettings(props: Props): React.JSX.Element {
  const { active, scope, spaces, roster, hubMode, execEnabled, execDaemonOnline, onToggleExec, onNewSpace, onSpaceSettings } = props
  const [hub, setHub] = useState(hubBase)
  const [token, setTokenDraft] = useState(getToken)
  if (active === 'settings-spaces') return <div className="workspace-settings-page"><div className="workspace-page-heading"><div><h1>空间管理</h1><p>管理协作空间、仓库绑定与场景。</p></div><button className="btn primary" onClick={onNewSpace}>＋ 新建空间</button></div><div className="settings-space-list">{spaces.map(s => <div key={s.id} className="panel settings-space-row"><div><strong>{s.name}</strong><p>{s.id} · {s.agentCount} 个 Agent · {s.private ? '本地 / 私有' : '共享空间'}</p><small>{s.localDir || '尚未绑定本地文件夹'}</small></div><button className="btn" onClick={() => onSpaceSettings(s)}>空间设置</button></div>)}{!spaces.length && <div className="workspace-empty">尚无空间，连接团队中枢或新建空间。</div>}</div></div>
  if (active === 'settings-connections') return <div className="workspace-settings-page"><div className="workspace-page-heading"><div><h1>连接与令牌</h1><p>设置团队中枢地址与写操作凭证。</p></div></div>
    <AccountPanel />
    <DevicePanel />
    <section className="panel settings-card"><label>团队中枢地址<input value={hub} onChange={e => setHub(e.target.value)} placeholder="http://127.0.0.1:8787" /></label><label>写操作令牌<input type="password" autoComplete="off" value={token} onChange={e => setTokenDraft(e.target.value)} /></label><button className="btn primary" onClick={() => { if (hub.trim()) setHubBase(hub.trim()); else localStorage.removeItem('legion.workbench.hub'); setToken(token.trim()); window.location.reload() }}>保存并重新连接</button></section></div>
  if (active === 'settings-models') return <div className="workspace-settings-page"><ModelConfigModal embedded scope={hubMode ? scope ?? '' : ''} roster={roster} onClose={() => undefined} /></div>
  if (!hubMode || !scope) return <div className="workspace-placeholder"><h1>{active === 'settings-workflow' ? 'Agent 工作流' : '持续执行'}</h1><p>请连接团队中枢，并选择一个具体工作空间。</p></div>
  if (active === 'settings-workflow') return <div className="workspace-settings-page"><div className="workspace-page-heading"><div><h1>Agent 工作流</h1><p>配置空间岗位、工具、节点与执行阶段。</p></div></div><AgentWorkflowConfigurator scope={scope} /></div>
  return <div className="workspace-settings-page"><div className="workspace-page-heading"><div><h1>持续执行</h1><p>控制空间编排与全局任务调度。</p></div></div><section className="panel settings-card"><h2>持续执行编排</h2><label className="settings-toggle"><input type="checkbox" checked={execEnabled} onChange={e => onToggleExec(e.target.checked)} />自动派发分析类阶段任务</label><p>需求澄清、方案设计与任务拆分可自动执行；写码阶段从任务详情派 AI 执行。</p><p className="settings-runtime-status">{execEnabled ? execDaemonOnline ? '执行守护在线' : '已开启 · 等待执行守护' : '持续执行已关闭'}</p></section></div>
}
