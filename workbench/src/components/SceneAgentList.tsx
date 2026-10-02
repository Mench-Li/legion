import type { SceneAgent } from '../scene/sceneState'

const MODE_TEXT = { idle: '待命', busy: '进行中', review: '待验收', blocked: '受阻' }

export function SceneAgentList({ agents, onAgentClick }: {
  agents: readonly SceneAgent[]; onAgentClick?: (role: string, scope?: string) => void
}): React.JSX.Element {
  return (
    <div className="scene-agent-list" role="list" aria-label="空间员工列表">
      {agents.length === 0 && <span className="scene-empty">这个空间还没有员工，可从空间设置中配置编队。</span>}
      {agents.map(agent => (
        <div key={agent.key} role="listitem" className="scene-agent-entry">
        <button type="button" disabled={!onAgentClick} className={`scene-agent-item ${agent.mode}`}
          onClick={() => onAgentClick?.(agent.role,agent.scope)} title={`${agent.name} · ${agent.focusTitle ?? '暂无任务'}`}>
          <span className="scene-agent-avatar">{agent.avatar}</span>
          <span className="scene-agent-name">{agent.name}</span>
          <span className="scene-agent-mode">{MODE_TEXT[agent.mode]}{agent.external ? ' · 临时' : ''}</span>
        </button>
        </div>
      ))}
    </div>
  )
}
