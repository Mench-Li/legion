import { useState } from 'react'
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
 * ——扫视时它不在。所以气泡**常驻**并压到最小（名字 + 气色 + 任务数 + 最要紧那条的编号），
 * 悬浮才展开清单。
 *
 * ## 只写编号，完整内容在悬浮时出现（将军 2026-10-14）
 *
 *   > 「显示任务编号即可，悬停时展示完整任务内容」
 *
 * 于是每一行是 `T-123`（编号 + 状态点），鼠标移到那一行上才把**完整标题**顶出来。
 * 这样做同时解决了两件事：一行只占一个编号的宽度（再多任务也列得下），
 * 以及"扫视时不被长标题糊住"——标题往往是一整句话。
 *
 * ⚠ 顶出来的标题是**原地展开**（不是浏览器原生 tooltip）：原生 tooltip 有 1 秒左右延迟、
 *   且在 3D 覆盖层里位置不可控；而这里的每一行本来就是 DOM，直接给一行更可靠、也能判据化。
 *
 * ## 清单给全部任务，但面板**限高可滚**
 *
 * 一个岗位手上可能有几十件任务。若让面板随任务数长高，它会盖住半个办公室；
 * 若截断成"前 6 条"，就不满足"看到他的所有任务"。取法是**全列出来 + 面板限高滚动**：
 * 一条不缺，且气泡高度有上限。
 *
 * ★ 传进来的 `agent.tasks` **已经滤掉了已完成/已取消**（见 `sceneBoard.SCENE_HIDDEN_STATUSES`），
 *   所以这里的"全部"= 全部**还没结束**的任务。历史去任务中心看。
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
  /** 当前鼠标停在哪一条任务上（决定把哪一条的完整标题顶出来）。 */
  const [hoverTask, setHoverTask] = useState<string | null>(null)
  return (
    <div
      className="agent-bubble"
      style={style}
      onPointerEnter={event => { event.stopPropagation(); onHoverChange(true) }}
      onPointerLeave={event => { event.stopPropagation(); setHoverTask(null); onHoverChange(false) }}
      onClick={event => { event.stopPropagation(); onSelect() }}
      title={`${agent.name} · ${mood.label} · ${agent.taskCount} 项进行中任务`}
    >
      <div className="agent-bubble-head">
        <i className="agent-bubble-dot" style={{ background: mood.color }} />
        <span>{name}</span>
        <span className="agent-bubble-mood">{mood.label}</span>
        <span className="agent-bubble-count">{agent.taskCount} 项</span>
      </div>
      {agent.taskCount === 0
        ? (!minimal || expanded) && <div className="agent-bubble-empty">暂无进行中的任务</div>
        : expanded
          ? <div className="agent-bubble-panel">
            {agent.tasks.map(task => {
              const taskStyle = STATUS_STYLE[task.status]
              const open = hoverTask === task.id
              return <div className={`agent-bubble-task ${open ? 'open' : ''}`} key={task.id}
                onPointerEnter={event => { event.stopPropagation(); setHoverTask(task.id) }}
                onPointerLeave={event => { event.stopPropagation(); setHoverTask(current => (current === task.id ? null : current)) }}
              >
                <i className="agent-bubble-dot" style={{ background: taskStyle.color }} />
                <b style={{ color: taskStyle.color }}>{task.id}</b>
                <span className="agent-bubble-task-state">{taskStyle.label}</span>
                {/* 完整标题：只在鼠标停在这一行时出现 */}
                {open && <span className="agent-bubble-task-title">{task.title}</span>}
              </div>
            })}
          </div>
          : (!minimal && <div className="agent-bubble-focus">{agent.tasks[0].id}</div>)}
      {expanded && agent.taskCount > 0 && <div className="agent-bubble-more">移上某一行看完整内容 · 点击气泡查看任务详情</div>}
    </div>
  )
}

export default AgentBubble
