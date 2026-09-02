export type CardStatus =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'blocked'
  | 'done'
  | 'canceled'

export interface CardComment {
  by: string
  at: string
  text: string
}

export interface Card {
  id: string
  title: string
  description?: string
  priority: 'high' | 'medium' | 'low'
  soldier?: string
  claimedRound?: number | null
  claimedAt?: string | null
  parent?: string | null
  blocks: string[]
  blockedBy: string[]
  version: number
  comments: CardComment[]
  latestComment?: CardComment | null
  evidence: number
  patches: string[]
  artifacts: string[]
  glow: string
  progress?: number | null
  updatedAt: string
}

export interface Column {
  id: CardStatus
  label: string
  cards: Card[]
}

export interface SoldierStats {
  role: string
  inProgress: number
  inReview: number
  done: number
  blocked: number
  total: number
}

export interface GoalProgress {
  total: number
  done: number
  percent: number
}

export interface BoardGoal {
  objective: string
  phase: string
  roundsCompleted: number
  progress: GoalProgress
  progressBar: string
}

export interface BoardData {
  generatedAt: string
  goal: BoardGoal
  totals: { open: number; done: number; total: number; canceled: number }
  columns: Column[]
  soldiers: SoldierStats[]
}

export interface ActivityEvent {
  ts: string
  kind: string
  taskId?: string
  text: string
}

export interface PipelineStage {
  role: string
  label: string
}

export interface ApiConfig {
  auth: boolean
  host: string
  port: number
  pipeline?: {
    name: string | null
    stages: PipelineStage[]
  } | null
  daemon?: unknown
  paused?: boolean
}

/** 服务端 /api/missions 返回的任务集（泳道）条目。 */
export interface MissionTaskItem {
  id: string
  title: string
  status: CardStatus
}

export type MissionStatus = 'running' | 'waiting' | 'blocked' | 'done'

export interface Mission {
  role: string
  name: string
  total: number
  done: number
  inProgress: number
  inReview: number
  blocked: number
  waiting: number
  percent: number
  status: MissionStatus
  tasks: MissionTaskItem[]
}

export interface MissionsResponse {
  generatedAt: string
  scope: string | null
  scopeAware: boolean
  missions: Mission[]
}

/** team-hub v2 团队共享技能（scope-owned + 版本 + 复审）。 */
export interface SkillInfo {
  id: string
  name: string
  description: string
  prompt: string
  scope: string
  owner: string | null
  grants: string[]
  version: number
  status: 'pending' | 'published' | 'rejected'
  contentHash: string
  reviewedAt: string | null
  createdAt: string
  updatedAt: string
}

/** team-hub v2 工作空间专属编队成员（岗位 + 状态/任务实时投影）。 */
export interface RosterAgent {
  role: string
  name: string
  kind: string
  avatar: string
  mode: 'busy' | 'review' | 'blocked' | 'idle'
  chips: Array<{ label: string; cls: string }>
  done: number
  total: number
  external: boolean
  /** 所属空间（「全部空间」视图时区分跨空间智能体）。 */
  scope?: string
  tasks: Array<{ id: string; title: string; status: CardStatus }>
}

/** 智能体默认模型配置（每空间每角色）——执行该角色任务时使用，按复杂度省 token。 */
export interface AgentModelCfg {
  scope: string
  role: string
  provider: string
  model: string
}

/** 候选模型（来自 DSH 部署 settings.yaml 的真实模型），按省 token 策略分档。 */
export interface ModelOption {
  provider: string
  model: string
  name: string
  /** light=轻量省 token；balanced=均衡；heavy=强推理/旗舰；vision=支持图像。 */
  tier: 'light' | 'balanced' | 'heavy' | 'vision'
}

export interface RosterResponse {
  scope: string
  agents: RosterAgent[]
}

/** team-hub v2 工作空间目标（objective + 该空间任务进度）。 */
export interface GoalInfo {
  scope: string
  objective: string | null
  done: number
  total: number
  percent: number
  updatedAt: string | null
}

/** team-hub v2 工作空间（scope 实体，含注册名与编队人数）。 */
export interface SpaceInfo {
  id: string
  name: string
  /** 本地/私有空间：数据只在本地，不进 git 仓库（界面显示🏠角标）。 */
  private?: boolean
  agentCount: number
}

/** team-hub v2 全局智能体目录条目（所有空间编队并集，按 role 去重 + 来源标注）。 */
export interface AgentCatalogItem {
  role: string
  name: string
  kind: string
  avatar: string
  scopes: string[]
}

export interface DaemonInfo {
  role?: string
  intervalMs?: number
  running?: boolean
  lastSweep?: string
  [key: string]: unknown
}

/** team-hub v2 审计条目（某任务/空间的进展时间线：发布/认领/开工/评论/提交/验收）。 */
export interface HubActivity {
  seq: number
  ts: string
  member: string
  scope: string
  action: string
  taskId: string | null
  detail: Record<string, unknown>
}

/** team-hub v2 单个任务（/api/board 返回，含角色/指派/依赖/版本/内容，供中枢调度与验收）。 */
export interface HubTask {
  id: string
  title: string
  description: string
  acceptance: string[]
  priority: string
  status: CardStatus
  version: number
  soldier?: string | null
  role?: string | null
  scope?: string
  blocks: string[]
  blockedBy: string[]
  comments: CardComment[]
  /** 执行者提交的产出证据（isEvidence=true 的评论：by/at/text）。 */
  evidence: Array<{ by: string; at: string; text: string }>
  patches: string[]
  parent?: string | null
  claimedAt?: string | null
  createdAt?: string
  updatedAt?: string
}
