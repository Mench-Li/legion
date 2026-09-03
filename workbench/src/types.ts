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
  /** 本地/私有空间：数据只在本地，不进共享 git 仓库（界面显示🏠角标）。 */
  private?: boolean
  /** 空间绑定的本地文件夹（该空间对应的本机目录；空 = 未绑定，沿用平台默认仓库）。 */
  localDir?: string
  /** 空间绑定的远程仓库 URL（空 = 仅本地 / 不进共享仓库）。 */
  remoteUrl?: string
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

/** 目录浏览（workbench 自带 /api/fs，同源；照搬 DSH 工作空间的选文件夹逻辑）。 */
export interface DirEntry {
  name: string
  path: string
  /** 目录内含 .git（是该目录的代码仓库）。 */
  isRepo: boolean
}

export interface DirListing {
  path: string
  isRoot: boolean
  parent: string | null
  entries: DirEntry[]
  drives: Array<{ name: string; path: string }>
}

/** git 仓库探测结果（选定的本地文件夹 = 该空间的代码仓库）。 */
export interface RepoInspect {
  isRepo: boolean
  root: string | null
  branch: string | null
  remotes: Array<{ name: string; url: string }>
}

/** 任务边界（做什么/不做什么，scope in/out）。 */
export interface TaskBoundary {
  do: string[]
  dont: string[]
}

/** team-hub v2 单个任务（/api/board 返回，含角色/指派/依赖/版本/内容，供中枢调度与验收）。 */
export interface HubTask {
  id: string
  title: string
  description: string
  acceptance: string[]
  /** 边界：做什么/不做什么（生成任务时自动带，见 team-hub/stage-standards.mjs）。 */
  boundary?: TaskBoundary
  /** 将军逐任务拦截（hold=true 时守护不得自动认领/执行，见 POST /api/hold）。 */
  hold?: boolean
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
/** team-hub v2 对话（S1）：会话条目（/api/chat/conversations）。 */
export interface ChatConversation {
  id: number
  scope: string
  /** space=工作空间会话（默认）；direct=私聊；task=任务讨论。 */
  kind: 'space' | 'direct' | 'task'
  title: string
  participants: string[]
  createdAt: string
  updatedAt: string
  last_message_at: string | null
}

/** team-hub v2 对话：消息条目（/api/chat/messages，作者字段为 author）。 */
export interface ChatMessage {
  id: number
  convId: number
  scope: string
  author: string
  /** text|markdown|system；未知 kind 按纯文本兜底渲染（X-1 未勾选）。 */
  kind: string
  body: string
  meta: Record<string, unknown> | null
  clientTs: string | null
  createdAt: string
}

/** team-hub 审计 SSE 事件（单一 /api/events；chat:* 按其 action 过滤，I8）。 */
export interface HubAuditEvent {
  seq: number
  ts: string
  member: string
  scope: string
  action: string
  taskId: string | null
  detail: Record<string, unknown>
}

/** 文件中心（S3/S4）：目录条目。 */
export interface FileEntry {
  name: string
  type: 'dir' | 'file'
  size: number
  mtime: string
  isRepo?: boolean
  ext?: string
}

/** 文件中心：列表响应。 */
export interface FileListResponse {
  ok: boolean
  root: string
  path: string
  entries: FileEntry[]
}

/** 文件中心：文本预览响应（S3 read）。 */
export interface FilePreview {
  ok: boolean
  name: string
  ext: string
  binary: boolean
  content?: string
  truncated?: boolean
  lineCount?: number
  totalBytes?: number
  message?: string
  error?: string
}

/** 浏览器助手（S6）：/api/web/fetch 响应（白名单结构化字段，无原始 HTML）。 */
export interface WebFetchResult {
  ok: boolean
  finalUrl?: string
  status?: number
  contentType?: string
  title?: string
  text?: string
  excerpt?: string
  links?: string[]
  error?: string
  /** ssrf_blocked | timeout | too_large | protocol_blocked | dns_error | http_4xx | empty_content | unsupported | invalid_url | fetch_error */
  code?: string
}
