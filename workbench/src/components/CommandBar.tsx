import { useState } from 'react'
import type { ActivityEvent, BoardData, RosterAgent } from '../types'
import { buildMissions } from '../missions'
import { setPaused } from '../api'
import { toast } from './Toast'
import { NewTaskModal } from './NewTaskModal'
import { SchedulerModal } from './SchedulerModal'
import { HubSchedulerModal } from './HubSchedulerModal'
import { GoalModal } from './GoalModal'
import { ModelConfigModal } from './ModelConfigModal'

interface CommandBarProps {
  board: BoardData | null
  activity: ActivityEvent[]
  labels: Record<string, string>
  paused: boolean
  scope: string | null
  hubMode: boolean
  onPausedChange: () => void
  /** 中枢模式：当前空间目标描述（供发布目标弹窗预填）；无则 null。 */
  currentGoal?: string | null
  /** 中枢模式：当前空间名（发布目标标题用）。 */
  spaceName?: string
  /** 发布空间目标。 */
  onPublishGoal?: (scope: string, objective: string) => Promise<void>
  /** 中枢模式：当前空间编队（模型配置弹窗按它列角色）。 */
  roster?: RosterAgent[] | null
}

function exportDailyReport(board: BoardData, activity: ActivityEvent[], labels: Record<string, string>): void {
  if (!board) return
  const today = new Date().toISOString().slice(0, 10)
  const missions = buildMissions(board, labels)
  const lines: string[] = []
  lines.push(`# 军团日报 · ${today}`)
  lines.push('')
  lines.push(`- 目标：${board.goal.objective}`)
  lines.push(`- 目标进度：${board.goal.progress.done}/${board.goal.progress.total}（${board.goal.progress.percent}%）`)
  lines.push(`- 任务统计：进行中 ${board.columns.reduce((n, c) => n + (c.id === 'in_progress' || c.id === 'in_review' ? c.cards.length : 0), 0)} / 已完成 ${board.totals.done} / 待处理 ${board.totals.open}`)
  lines.push(`- AI 员工：${board.soldiers.length} 名`)
  lines.push('')
  lines.push('## 任务集')
  lines.push('')
  for (const m of missions) {
    lines.push(`- ${m.name}（${m.role}）：${m.percent}% — ${m.done}/${m.total} 完成${m.blocked > 0 ? `，受阻 ${m.blocked}` : ''}`)
  }
  lines.push('')
  lines.push('## 任务明细')
  lines.push('')
  for (const col of board.columns) {
    if (col.cards.length === 0) continue
    lines.push(`### ${col.label}`)
    for (const card of col.cards) {
      lines.push(`- ${card.id} ${card.title}（${labels[card.soldier ?? ''] ?? card.soldier ?? '未指派'}）`)
    }
    lines.push('')
  }
  lines.push('## 实时动态（近 20 条）')
  lines.push('')
  for (const ev of activity.slice(0, 20)) {
    lines.push(`- ${ev.ts} [${ev.kind}] ${ev.taskId ? `[${ev.taskId}] ` : ''}${ev.text}`)
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `军团日报-${today}.md`
  a.click()
  URL.revokeObjectURL(url)
}

export function CommandBar({ board, activity, labels, paused, scope, hubMode, onPausedChange, currentGoal, spaceName, onPublishGoal, roster }: CommandBarProps): React.JSX.Element {
  const [showNew, setShowNew] = useState(false)
  const [showSched, setShowSched] = useState(false)
  const [showGoal, setShowGoal] = useState(false)
  const [showModel, setShowModel] = useState(false)
  const [pauseBusy, setPauseBusy] = useState(false)
  const goalReady = hubMode && scope && onPublishGoal !== undefined

  const openSched = (): void => {
    if (hubMode && scope === null) {
      toast('info', '请先在左侧选择一个具体工作空间，再打开任务调度')
      return
    }
    setShowSched(true)
  }

  const togglePause = async (): Promise<void> => {
    setPauseBusy(true)
    try {
      const res = await setPaused(!paused)
      toast('ok', res.paused ? '⏸ 已全局暂停：守护将停止认领/派工' : '▶ 已继续：守护恢复扫单')
      onPausedChange()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast('err', msg.includes('401') ? '令牌无效或缺失：请在右上角「🔑 令牌」设置' : `操作失败：${msg}`)
    } finally {
      setPauseBusy(false)
    }
  }

  return (
    <>
      <div className="command-bar">
        <button
          className={`btn${paused ? ' primary' : ''}`}
          disabled={pauseBusy}
          onClick={() => void togglePause()}
          title={paused ? '解除全局暂停，守护恢复扫单' : '全局暂停：守护停止认领/派工（写 control.json）'}
        >
          {pauseBusy ? '…' : paused ? '▶ 全部继续' : '⏸ 全部暂停'}
        </button>
        <span className="sep" />
        <button className="btn" onClick={openSched} title={hubMode && scope === null ? '需先选择具体工作空间' : '任务调度：推进/验收/归还/转派'}>
          🗓 任务调度
        </button>
        <button className="btn" disabled={!goalReady} onClick={() => setShowGoal(true)} title={goalReady ? '发布当前空间目标' : '需中枢模式且已选具体工作空间'}>
          🎯 发布目标
        </button>
        <button className="btn" onClick={() => toast('info', '日程/会议不在 legion 引擎内，随第 2 步接入 team-hub 日程表')}>
          📅 安排会议
        </button>
        <button
          className="btn"
          disabled={!goalReady}
          onClick={() => setShowModel(true)}
          title={goalReady ? '给每个智能体(角色)设置默认模型：轻量省 token / 旗舰强推理' : '需中枢模式且已选具体工作空间'}
        >
          ⚙️ 模型配置
        </button>
        <span className="sep" />
        <button className="btn primary" onClick={() => setShowNew(true)}>
          ＋ 新建任务
        </button>
        <button className="btn" onClick={() => exportDailyReport(board!, activity, labels)} disabled={!board}>
          📤 导出日报
        </button>
        <span className="hint">
          {paused ? '⏸ 全局暂停中 · ' : ''}
          {hubMode ? `🧭 中枢分区「${scope ?? '全部'}」· ` : ''}
          数据源 {board ? `已连接 · 更新于 ${new Date(board.generatedAt).toLocaleTimeString()}` : '未连接'}
        </span>
      </div>
      {showNew && <NewTaskModal scope={scope} hubMode={hubMode} onClose={() => setShowNew(false)} />}
      {showSched && (hubMode && scope ? <HubSchedulerModal scope={scope} onClose={() => setShowSched(false)} /> : board ? <SchedulerModal board={board} labels={labels} onClose={() => setShowSched(false)} /> : null)}
      {showGoal && scope && onPublishGoal && (
        <GoalModal scope={scope} spaceName={spaceName ?? scope} current={currentGoal} onClose={() => setShowGoal(false)} onPublish={onPublishGoal} />
      )}
      {showModel && scope && (
        <ModelConfigModal scope={scope} roster={roster ?? null} onClose={() => setShowModel(false)} />
      )}
    </>
  )
}
