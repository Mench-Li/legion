import { toast } from './Toast'
import { openKanban } from '../api'
import type { BoardData, SpaceInfo } from '../types'
import { statusCounts } from '../missions'

export interface ModuleDef {
  id: string
  name: string
  icon: string
  badge?: number
}

const MODULES: ModuleDef[] = [
  { id: 'home', name: '首页', icon: '🏠' },
  { id: 'tasks', name: '任务中心', icon: '📋' },
  { id: 'agents', name: '智能体', icon: '🤖' },
  { id: 'files', name: '文件中心', icon: '📁' },
  { id: 'skills', name: '技能中心', icon: '🧩' },
  { id: 'browser', name: '浏览器助手', icon: '🌐' },
  { id: 'chat', name: '对话中心', icon: '💬' },
  { id: 'calendar', name: '日程日历', icon: '📅' },
  { id: 'notify', name: '通知中心', icon: '🔔' },
]

/** v1（serve.mjs，无 scope 分区）时的固定空间列表；中枢模式用 team-hub 真实空间替换。 */
const FALLBACK_WORKSPACES: Array<{ name: string; scope: string | null }> = [
  { name: '我的空间', scope: null },
  { name: '市场部空间', scope: 'marketing' },
  { name: '产品部空间', scope: 'product' },
  { name: '运营部空间', scope: 'ops' },
]

interface SidebarProps {
  board: BoardData | null
  active: string
  scope: string | null
  hubMode: boolean
  spaces: SpaceInfo[]
  onNavigate: (id: string) => void
  onSelectScope: (scope: string | null) => void
  onNewSpace: () => void
  /** 打开某工作空间设置（仓库绑定：本地文件夹 / 远程仓库）。 */
  onSpaceSettings?: (space: SpaceInfo) => void
  /** 当前空间持续执行编排开关。 */
  execEnabled?: boolean
  onToggleExec?: (enabled: boolean) => void
  /** 执行守护是否在线（编排是否真的在跑）。 */
  execDaemonOnline?: boolean
}

export function Sidebar({ board, active, scope, hubMode, spaces, onNavigate, onSelectScope, onNewSpace, onSpaceSettings, execEnabled, onToggleExec, execDaemonOnline }: SidebarProps): React.JSX.Element {
  const counts = board ? statusCounts(board) : null
  const inReview = counts?.inReview ?? 0
  const inProgress = counts?.inProgress ?? 0

  // 中枢模式下工作空间 = 「全部空间」+ team-hub 真实空间（注册名/推导名）；v1 用固定列表
  const workspaces: Array<{ name: string; scope: string | null }> = hubMode && spaces.length > 0
    ? [{ name: '全部空间', scope: null }, ...spaces.map(s => ({ name: s.name, scope: s.id }))]
    : FALLBACK_WORKSPACES

  const badgeFor = (id: string): number | undefined => {
    if (id === 'tasks') return inProgress + inReview
    if (id === 'notify') return inReview
    if (id === 'agents') return board?.soldiers.length
    return undefined
  }

  const clickModule = (mod: ModuleDef): void => {
    if (mod.id === 'home' || mod.id === 'agents' || mod.id === 'skills') {
      onNavigate(mod.id)
      return
    }
    if (mod.id === 'tasks') {
      openKanban()
      return
    }
    toast('info', `模块「${mod.name}」在转型路线图后续步骤接入（当前为独立仪表盘第 1 步）`)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="emblem">⚔</span>
        <span>军团指挥台</span>
      </div>

      <div className="sidebar-section">模块</div>
      {MODULES.map(mod => (
        <div
          key={mod.id}
          className={`nav-item${active === mod.id ? ' active' : ''}`}
          onClick={() => clickModule(mod)}
        >
          <span>{mod.icon}</span>
          <span>{mod.name}</span>
          {badgeFor(mod.id) !== undefined && badgeFor(mod.id)! > 0 && (
            <span className="cnt">{badgeFor(mod.id)}</span>
          )}
        </div>
      ))}

      <div className="sidebar-section">
        <span>工作空间{hubMode ? ' · 真分区' : ''}</span>
        <button className="ws-add" onClick={onNewSpace} title="新建工作空间（team-hub v2）">＋ 新建空间</button>
      </div>
      {workspaces.map(ws => {
        const space = ws.scope !== null ? spaces.find(s => s.id === ws.scope) : null
        const repoTitle = space
          ? `本地文件夹：${space.localDir || '未绑定（沿用平台默认）'}\n远程仓库：${space.remoteUrl || '仅本地 / 不进共享仓库'}`
          : undefined
        return (
          <div
            key={ws.name}
            className={`nav-item${scope === ws.scope ? ' active' : ''}`}
            title={repoTitle}
            onClick={() => onSelectScope(ws.scope)}
          >
            <span>🗂</span>
            <span>{ws.name}</span>
            {space?.private && <span className="local-badge" title="本地/私有空间：仅在本机操作，不进共享 git 仓库">🏠 本地</span>}
            {hubMode && space && onSpaceSettings && (
              <span
                className="ws-gear"
                title="空间设置：名称 / 本地·私有 / 本地文件夹 + 远程仓库"
                onClick={(e) => {
                  e.stopPropagation()
                  onSpaceSettings(space)
                }}
              >
                ⚙
              </span>
            )}
            {hubMode && ws.scope !== null && (
              <span className="cnt" style={{ marginLeft: 'auto', background: 'transparent', color: 'var(--muted-2)' }}>
                {space?.agentCount ?? ''}
              </span>
            )}
          </div>
        )
      })}
      {!hubMode && (
        <div className="nav-item" onClick={onNewSpace} style={{ color: 'var(--muted-2)', fontSize: 11 }}>
          <span>＋</span>
          <span>新建空间（需 team-hub v2 中枢）</span>
        </div>
      )}

      <div className="sidebar-spacer" />

      {hubMode && scope && (
        <div className="exec-panel">
          <div className="exec-head">
            <span>⚡ 持续执行编排</span>
            <button
              className={`toggle${execEnabled ? ' on' : ''}`}
              onClick={() => onToggleExec?.(!execEnabled)}
              title="开启后，分析类阶段任务（需求澄清/方案设计/任务拆分）由 AI 智能体自动执行并提交验收；写码阶段由你点「派 AI 执行」"
            >
              <i />
            </button>
          </div>
          <div className={`exec-status${execEnabled ? ' on' : ''}`}>
            {execEnabled
              ? (execDaemonOnline ? '🟢 执行守护在线 · 正在自动派活' : '🟡 已开启 · 等待执行守护启动（告诉我「启动执行守护」即可）')
              : '⚪ 关闭 · 分析类任务不会自动执行'}
          </div>
        </div>
      )}

      <div className="user-card">
        <div className="user-avatar">⚙</div>
        <div className="user-meta">
          <div className="name">general · 将军</div>
          <div className="role">在线 · 指挥员</div>
        </div>
      </div>
    </aside>
  )
}
