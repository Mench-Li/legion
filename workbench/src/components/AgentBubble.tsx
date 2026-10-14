import type { CSSProperties } from 'react'
import type { SceneAgent } from '../scene/sceneState'
import { MOOD_STYLE, STATUS_STYLE } from '../scene/sceneBoard'

/**
 * Agent 头顶的气泡 —— 常驻悬浮，鼠标移上去展开他的**全部任务**。
 *
 * ## 颜色是"他最要紧那件事"的颜色
 *
 * 气泡底色 = `MOOD_STYLE[agent.mode].color`（受阻红 / 待验收黄 / 进行中绿 / 待命蓝），
 * 与看板上同类卡片的颜色**同源**（都取自 `sceneBoard.ts` 那一张表）。
 * 于是"看板上一片红"与"某个人头顶是红的"能立刻对上，不需要第二套心智模型。
 *
 * ## 为什么常驻，而不是只有悬浮才出现
 *
 * 将军要的是"站在场景外一眼扫过去就知道谁在干什么"。只在悬浮时出现的气泡等于没有
 * ——扫视时它不在。所以气泡**常驻**并压到最小（名字 + 气色 + 任务数 + 最要紧那条的标题），
 * 悬浮才展开清单。
 *
 * ## 清单给全部任务，但面板**限高可滚**
 *
 * 一个岗位手上可能有几十件任务。若让面板随任务数长高，它会盖住半个办公室；
 * 若截断成"前 6 条"，就不满足"看到他的所有任务"。取法是**全列出来 + 面板限高滚动**：
 * 一条不缺，且气泡高度有上限。
 */
export function AgentBubble({ agent, expanded, minimal = false, onHoverChange, onSelect }: {
  agent: SceneAgent
  expanded: boolean
  /** 人多的时候只留"名字 + 气色 + 条数"，减少 DOM 节点；悬浮时照常展开。 */
  minimal?: boolean
  onHoverChange: (hovered: boolean) => void
  onSelect: () => void
}): React.JSX.Element {
  const mood = MOOD_STYLE[agent.mode]
  const style = { '--bubble-color': mood.color } as CSSProperties
  const name = agent.name.length > 7 ? `${agent.name.slice(0, 6)}…` : agent.name
  return (
    <div
      className="agent-bubble"
      style={style}
      onPointerEnter={event => { event.stopPropagation(); onHoverChange(true) }}
      onPointerLeave={event => { event.stopPropagation(); onHoverChange(false) }}
      onClick={event => { event.stopPropagation(); onSelect() }}
      title={`${agent.name} · ${mood.label} · ${agent.taskCount} 项任务`}
    >
      <div className="agent-bubble-head">
        <i className="agent-bubble-dot" style={{ background: mood.color }} />
        <span>{name}</span>
        <span className="agent-bubble-mood">{mood.label}</span>
        <span className="agent-bubble-count">{agent.taskCount} 项</span>
      </div>
      {agent.taskCount === 0
        ? (!minimal || expanded) && <div className="agent-bubble-empty">暂无任务，待命</div>
        : expanded
          ? <div className="agent-bubble-panel">
            {agent.tasks.map(task => {
              const taskStyle = STATUS_STYLE[task.status]
              return <div className="agent-bubble-task" key={task.id}>
                <i className="agent-bubble-dot" style={{ background: taskStyle.color }} />
                <b>{taskStyle.label}</b><span>{task.title}</span>
              </div>
            })}
          </div>
          : (!minimal && <div className="agent-bubble-focus">{agent.tasks[0].title}</div>)}
      {expanded && agent.taskCount > 0 && <div className="agent-bubble-more">点击气泡查看任务详情</div>}
    </div>
  )
}

export default AgentBubble
