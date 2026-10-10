import type { SceneAgent } from '../scene/sceneState'
import { AgentAvatar } from '../avatar'

const MODE_TEXT = { idle: '待命', busy: '进行中', review: '待验收', blocked: '受阻' }

export function SceneAgentList({ agents, onAgentClick }: {
  agents: readonly SceneAgent[]; onAgentClick?: (role: string) => void
}): React.JSX.Element {
  return (
    <div className="scene-agent-list" role="list" aria-label="空间员工列表">
      {agents.length === 0 && <span className="scene-empty">这个空间还没有员工，可从空间设置中配置编队。</span>}
      {agents.map(raw => {
        const { key, role, name, avatar, mode, external, focusTitle } = raw
        return (
          <div key={key} role="listitem" className="scene-agent-entry">
          <button type="button" disabled={!onAgentClick} className={`scene-agent-item ${mode}`}
            onClick={() => onAgentClick?.(role)} title={`${name} · ${focusTitle ?? '暂无任务'}`}>
            <span className="scene-agent-avatar"><AgentAvatar token={avatar} /></span>
            <span className="scene-agent-name">{name}</span>
            <span className="scene-agent-mode">{MODE_TEXT[mode]}{external ? ' · 临时' : ''}</span>
          </button>
          </div>
        )
      })}
    </div>
  )
}
