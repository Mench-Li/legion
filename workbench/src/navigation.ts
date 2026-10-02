export type WorkspaceGroup = 'home' | 'agents' | 'tasks' | 'resources' | 'activity' | 'settings'
export const NAV_GROUPS: Array<{ id: WorkspaceGroup; name: string; icon: string; target: string }> = [
  { id: 'home', name: '概览', icon: 'grid', target: 'home' },
  { id: 'agents', name: 'Agent', icon: 'users', target: 'agents' },
  { id: 'tasks', name: '任务', icon: 'list', target: 'tasks' },
  { id: 'resources', name: '资源', icon: 'folder', target: 'files' },
  { id: 'activity', name: '动态', icon: 'bell', target: 'notify' },
  { id: 'settings', name: '设置', icon: 'settings', target: 'settings-spaces' },
]
export const SUB_NAV: Record<WorkspaceGroup, Array<{ id: string; name: string }>> = {
  home: [{ id: 'home', name: '空间概览' }, { id: 'goals', name: '目标与进展' }, { id: 'team-scene', name: '团队场景' }],
  agents: [],
  tasks: [{ id: 'tasks', name: '任务中心' }, { id: 'calendar', name: '日程日历' }],
  resources: [{ id: 'files', name: '文件中心' }, { id: 'skills', name: '技能中心' }, { id: 'rules', name: '规范' }],
  activity: [{ id: 'notify', name: '通知中心' }, { id: 'activity-feed', name: '实时动态' }, { id: 'snapshots', name: '上下文快照' }],
  settings: [{ id: 'settings-spaces', name: '空间管理' }, { id: 'settings-execution', name: '持续执行' }, { id: 'settings-workflow', name: 'Agent 工作流' }, { id: 'settings-models', name: '模型与凭证' }, { id: 'settings-connections', name: '连接与令牌' }, { id: 'browser', name: '浏览器助手' }],
}
export function groupFor(active: string): WorkspaceGroup {
  if (active === 'chat') return 'agents'
  return NAV_GROUPS.find(g => g.id === active || SUB_NAV[g.id].some(s => s.id === active))?.id ?? 'home'
}
export function agentKey(scope: string, role: string): string { return JSON.stringify([scope, role]) }
export const TASK_VIEWS = [
  { id: 'all', name: '全部' }, { id: 'busy', name: '工作中' },
  { id: 'decide', name: '待我决定' }, { id: 'todo', name: '待办' }, { id: 'done', name: '已完成' },
] as const
export type TaskViewId = typeof TASK_VIEWS[number]['id']
