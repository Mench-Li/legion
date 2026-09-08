import type { ActivityEvent, AgentCatalogItem, AgentModelCfg, ApiConfig, BoardData, CardStatus, ChatAttachmentRef, ChatConversation, ChatHealthInfo, ChatMessage, DirListing, FileListResponse, FilePreview, GoalInfo, GoalStatus, HubActivity, HubAuditEvent, HubDocContent, HubTask, MissionsResponse, ModelOption, OverlapGroup, RepoInspect, RosterResponse, SkillInfo, SpaceInfo, WebFetchResult } from './types'

/**
 * 数据源地址解析：?api= 查询参数优先，其次 localStorage，最后默认 4820。
 * serve.mjs 默认端口 4820（读开放、写需令牌）。
 */
const DEFAULT_API = 'http://127.0.0.1:4820'

export function apiBase(): string {
  const fromQuery = new URLSearchParams(window.location.search).get('api')
  if (fromQuery) return fromQuery.replace(/\/+$/, '')
  return localStorage.getItem('legion.workbench.api') ?? DEFAULT_API
}

export function setApiBase(base: string): void {
  localStorage.setItem('legion.workbench.api', base.replace(/\/+$/, ''))
}

/**
 * team-hub v2（SQLite 任务池，真 scope 分区）地址。任务集/空间面板优先走它：
 * ?hub= 查询参数 > localStorage > 默认 8787。探测不到时回退 serve.mjs 的 v1 接口。
 */
const DEFAULT_HUB = '/hub'

export function hubBase(): string {
  const fromQuery = new URLSearchParams(window.location.search).get('hub')
  if (fromQuery) return fromQuery.replace(/\/+$/, '')
  return localStorage.getItem('legion.workbench.hub') ?? DEFAULT_HUB
}

export function setHubBase(base: string): void {
  localStorage.setItem('legion.workbench.hub', base.replace(/\/+$/, ''))
}

/** 探测 team-hub v2 是否可达（2.5s 超时，不影响主流程）。 */
export async function probeHub(timeoutMs = 2500): Promise<boolean> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${hubBase()}/api/config`, { signal: ctrl.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export function getToken(): string {
  return localStorage.getItem('legion.workbench.token') ?? ''
}

export function setToken(token: string): void {
  localStorage.setItem('legion.workbench.token', token)
}

function authHeaders(): Record<string, string> {
  const token = getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

export async function fetchConfig(): Promise<ApiConfig> {
  return readJson<ApiConfig>(await fetch(`${apiBase()}/api/config`))
}

export async function fetchBoard(): Promise<BoardData> {
  return readJson<BoardData>(await fetch(`${apiBase()}/api/board`))
}

export async function fetchActivity(limit = 60): Promise<ActivityEvent[]> {
  return readJson<ActivityEvent[]>(await fetch(`${apiBase()}/api/activity?limit=${limit}`))
}

/**
 * 服务端任务集聚合视图（serve.mjs ≥ 转型第 2 步）。旧版服务端没有该接口时
 * 抛错（404），由调用方回退到客户端聚合（missions.ts buildMissions）。
 */
export async function fetchMissions(scope?: string | null): Promise<MissionsResponse> {
  const qs = scope ? `?scope=${encodeURIComponent(scope)}` : ''
  return readJson<MissionsResponse>(await fetch(`${apiBase()}/api/missions${qs}`))
}

/** 全局暂停/继续：写 serve.mjs 的 control.json，守护每轮扫单前读取。 */
export async function setPaused(paused: boolean): Promise<{ ok: boolean; paused: boolean }> {
  const res = await fetch(`${apiBase()}/api/${paused ? 'pause' : 'resume'}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: '{}',
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${res.status}${text ? `：${text}` : ''}`)
  }
  return res.json() as Promise<{ ok: boolean; paused: boolean }>
}

/**
 * 订阅看板变化。serve.mjs 的 SSE 在每次写操作后推送完整 board.json。
 * 返回取消订阅函数；EventSource 自带断线重连。
 */
export function subscribeBoard(onBoard: (board: BoardData) => void): () => void {
  const es = new EventSource(`${apiBase()}/api/board/events`)
  es.onmessage = (ev) => {
    try {
      onBoard(JSON.parse(ev.data) as BoardData)
    } catch {
      /* 忽略损坏帧，保留上一次看板 */
    }
  }
  return () => es.close()
}

/** 订阅实时动态（守护生命周期事件流），新事件逐个回调。 */
export function subscribeActivity(onEvent: (event: ActivityEvent) => void): () => void {
  const es = new EventSource(`${apiBase()}/api/activity/events`)
  es.onmessage = (ev) => {
    try {
      onEvent(JSON.parse(ev.data) as ActivityEvent)
    } catch {
      /* 忽略损坏帧 */
    }
  }
  return () => es.close()
}

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`POST ${path} ${res.status}${text ? `：${text}` : ''}`)
  }
  return res.json().catch(() => undefined)
}

export interface NewTaskInput {
  title: string
  description?: string
  acceptance?: string[]
  priority?: string
}

export function createTask(input: NewTaskInput): Promise<unknown> {
  return post('/api/create', input)
}

/** team-hub v2：真实分区下的任务集聚合（scopeAware=true）。 */
export async function fetchHubMissions(scope?: string | null): Promise<MissionsResponse> {
  const qs = scope ? `?scope=${encodeURIComponent(scope)}` : ''
  return readJson<MissionsResponse>(await fetch(`${hubBase()}/api/missions${qs}`))
}

/** team-hub v2：真实存在的分区列表（tasks + members 的 distinct scope）。 */
export async function fetchHubScopes(): Promise<string[]> {
  const resp = await readJson<{ scopes: string[] }>(await fetch(`${hubBase()}/api/scopes`))
  return resp.scopes
}

/** team-hub v2：工作空间列表（spaces 注册名 + 既有 scope 推导合并）。 */
export async function fetchSpaces(): Promise<SpaceInfo[]> {
  const resp = await readJson<{ spaces: SpaceInfo[] }>(await fetch(`${hubBase()}/api/spaces`))
  return resp.spaces
}

/** team-hub v2：新建/更新工作空间（幂等 upsert）。local=true 标记为本地/私有空间；
 *  repo.localDir/remoteUrl = 该空间绑定的本地文件夹 + 远程仓库（remoteUrl 空 = 仅本地/不进共享仓库）。 */
export function createSpace(
  id: string,
  name: string,
  local = false,
  repo?: { localDir?: string; remoteUrl?: string },
): Promise<unknown> {
  return hubPost('/api/spaces', {
    id, name, private: local,
    localDir: repo?.localDir?.trim() ?? '',
    remoteUrl: repo?.remoteUrl?.trim() ?? '',
  })
}

/** team-hub v2：更新工作空间属性（名称/私有/本地文件夹/远程仓库）——与 /api/spaces 幂等 upsert 同源。 */
export function updateSpaceConfig(input: {
  id: string
  name?: string
  private?: boolean
  localDir?: string
  remoteUrl?: string
}): Promise<unknown> {
  return hubPost('/api/spaces', {
    id: input.id,
    name: input.name?.trim() || input.id,
    private: input.private ?? false,
    localDir: input.localDir?.trim() ?? '',
    remoteUrl: input.remoteUrl?.trim() ?? '',
  })
}

export interface SpaceDeleteImpactCounts {
  tasks: number
  roster: number
  agentModels: number
  execRequests: number
  skills: number
  goal: number
  execState: number
  conversations: number
  messages: number
  calendarEvents: number
  members: number
}

export interface SpaceDeleteImpact {
  id: string
  counts: SpaceDeleteImpactCounts
  running: { tasks: Array<{ id: string; title: string; status: string }> }
}

/** team-hub v2（R-3/S7/S8）：删除预检——返回该空间将影响的数据面计数 + 在办任务（只读、不产生审计）。 */
export async function fetchSpaceImpact(id: string): Promise<SpaceDeleteImpact> {
  return readJson<SpaceDeleteImpact>(await fetch(`${hubBase()}/api/spaces/impact?id=${encodeURIComponent(id)}`))
}

/** team-hub v2（R-3/S8）：删除工作空间（级联 11 表 + spaces 行；confirm=delete-space:<id>；软件受保护由后端拒绝）。 */
export function deleteSpace(id: string): Promise<unknown> {
  return hubPost('/api/spaces/delete', { id, confirm: `delete-space:${id}` })
}

/** team-hub v2（R-2/S4）：读取全局规范层（rules；未设置返回空 content）。 */
export async function fetchRule(scope: string): Promise<{ scope: string; content: string; updatedAt: string | null }> {
  const resp = await readJson<{ rules: { scope: string; content: string; updatedAt: string | null } }>(await fetch(`${hubBase()}/api/rules?scope=${encodeURIComponent(scope)}`))
  return resp.rules
}

/** team-hub v2（R-2/S4）：保存全局规范层（写纪律 by=general 由 hubPost 注入；审计 rules:update + SSE）。 */
export function saveRule(scope: string, content: string): Promise<unknown> {
  return hubPost('/api/rules', { scope, content })
}

/** team-hub v2：读取指定空间目标（objective + 该空间任务进度）。 */

export async function fetchGoal(scope: string | null): Promise<GoalInfo> {
  const qs = scope ? `?scope=${encodeURIComponent(scope)}` : ''
  return readJson<GoalInfo>(await fetch(`${hubBase()}/api/goal${qs}`))
}

/** team-hub v2：发布目标——每次**新建**一个目标并生成其独立阶段任务链；与既有目标并存，互不取消。 */
export function publishGoal(scope: string, objective: string, mode?: 'chain' | 'slice'): Promise<unknown> {
  return hubPost('/api/goal', mode ? { scope, objective, mode } : { scope, objective })
}

/** team-hub v2：目标状态迁移（仅将军）：active ↔ paused；done/canceled 为终态（cancel 会取消该目标未开工的链任务）。 */
export function setGoalStatus(scope: string, goalId: string, status: GoalStatus): Promise<unknown> {
  return hubPost('/api/goal/status', { scope, id: goalId, status })
}

/** team-hub v2：更新目标共享上下文（仅将军）。contextVersion 服务端 +1；守护下一派工按新版本对齐（在跑 worker 不打断）。 */
export function setGoalContext(scope: string, goalId: string, text: string): Promise<unknown> {
  return hubPost('/api/goal/context', { scope, id: goalId, text })
}

/** team-hub v2：全局智能体目录（选人入编用）。 */
export async function fetchAgents(): Promise<AgentCatalogItem[]> {
  const resp = await readJson<{ agents: AgentCatalogItem[] }>(await fetch(`${hubBase()}/api/agents`))
  return resp.agents
}

/** 工作台自带 /api/fs（同源，仅回环可访问）：起始目录与盘符（照搬 DSH 工作空间的选文件夹逻辑）。 */
export async function fetchFsHome(): Promise<{ home: string; drives: Array<{ name: string; path: string }> }> {
  return readJson(await fetch('/api/fs/home'))
}

/** 工作台自带 /api/fs：列一个目录层级（选文件夹用）。 */
export async function fetchDirListing(path?: string): Promise<DirListing> {
  const qs = path ? `?path=${encodeURIComponent(path)}` : ''
  return readJson(await fetch(`/api/fs/list${qs}`))
}

/** 工作台自带 /api/fs：git 探测——选中目录是不是代码仓库、其远程仓库（remote）列表。 */
export function inspectDirectory(path: string): Promise<RepoInspect> {
  return fetch('/api/fs/inspect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  }).then(res => readJson<RepoInspect>(res))
}

/** team-hub v2：新建智能体（写入指定空间编队，role 已存在则刷新名称/形象）。 */
export function createAgent(input: { role: string; name: string; kind?: string; avatar?: string; scope?: string }): Promise<unknown> {
  return hubPost('/api/agents', input)
}

/** team-hub v2：选人入编——把全局目录中的若干智能体（按 role）复制进该空间编队。 */
export function addSpaceAgents(spaceId: string, roles: string[]): Promise<unknown> {
  return hubPost(`/api/spaces/${encodeURIComponent(spaceId)}/agents`, { roles })
}

/** team-hub v2：工作空间专属编队（岗位 + 状态/任务实时投影，含未入编队的活跃执行者）。 */
export async function fetchRoster(scope?: string | null): Promise<RosterResponse> {
  const qs = scope ? `?scope=${encodeURIComponent(scope)}` : ''
  return readJson<RosterResponse>(await fetch(`${hubBase()}/api/roster${qs}`))
}

/** team-hub v2：在工作台当前空间（scope）内新建任务；by 固定为 general（工作台代理身份）。 */
export async function createHubTask(input: NewTaskInput, scope?: string | null): Promise<unknown> {
  return hubPost('/api/create', { ...input, scope: scope ?? 'default' })
}

/** team-hub v2：某空间的全部任务（/api/board，含角色/指派/依赖/版本），供中枢调度。 */
export async function fetchHubTasks(scope: string | null): Promise<HubTask[]> {
  const qs = scope ? `?scope=${encodeURIComponent(scope)}` : ''
  return readJson<HubTask[]>(await fetch(`${hubBase()}/api/board${qs}`))
}

/** team-hub v2：单任务完整详情（任务详情视图）。 */
export async function fetchHubTask(id: string): Promise<HubTask> {
  return readJson<HubTask>(await fetch(`${hubBase()}/api/task?id=${encodeURIComponent(id)}`))
}

/** team-hub v2：某空间/某任务的审计时间线（进展历史）。taskId 优先，其次 scope；limit 可选（服务端上限 500）。 */
export async function fetchHubActivity(opts: { scope?: string | null; taskId?: string; goalId?: string | null; limit?: number } = {}): Promise<HubActivity[]> {
  const qs = new URLSearchParams()
  if (opts.taskId) qs.set('taskId', opts.taskId)
  else if (opts.goalId) qs.set('goalId', opts.goalId)
  else if (opts.scope) qs.set('scope', opts.scope)
  if (opts.limit !== undefined) qs.set('limit', String(opts.limit))
  if (qs.size === 0) qs.set('limit', '100')
  return readJson<HubActivity[]>(await fetch(`${hubBase()}/api/activity?${qs.toString()}`))
}

/** team-hub v2（S3 内容通道）：取某任务某产物条目对应的文件内容（md 按 text/markdown 语义）。
 * i 缺省取最新一条（兼容既有语义）；404/403/越界/二进制等错误由服务端 {error} 文案透传。 */
export async function fetchHubDocContent(taskId: string, index?: number): Promise<HubDocContent> {
  const qs = new URLSearchParams({ task: taskId })
  if (typeof index === 'number') qs.set('i', String(index))
  const res = await fetch(`${hubBase()}/api/artifact/content?${qs.toString()}`)
  let body: unknown = null
  try { body = await res.json() } catch { /* 非 JSON 响应 */ }
  if (!res.ok) {
    const err = (body !== null && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string')
      ? (body as { error: string }).error
      : res.statusText
    throw new Error(`${res.status} ${err}`)
  }
  return body as HubDocContent
}

/** team-hub v2：持续执行编排开关状态。 */
export async function fetchExec(scope: string | null): Promise<{ scope: string; enabled: boolean }> {
  const qs = scope ? `?scope=${encodeURIComponent(scope)}` : ''
  return readJson<{ scope: string; enabled: boolean }>(await fetch(`${hubBase()}/api/exec${qs}`))
}

/** team-hub v2：开/关该空间持续执行编排。 */
export function setExec(scope: string, enabled: boolean): Promise<unknown> {
  return hubPost('/api/exec', { scope, enabled })
}

/** team-hub v2：点「派 AI 执行」→ 请求执行守护认领该任务。 */
export function execRequest(taskId: string): Promise<unknown> {
  return hubPost('/api/exec/request', { taskId })
}

/** team-hub v2：将军逐任务拦截/放行自动交接（hold=true 时守护不得自动认领执行）。 */
export function hubHold(taskId: string, hold: boolean): Promise<unknown> {
  return hubPost('/api/hold', { id: taskId, hold })
}

/** team-hub v2：该空间的智能体默认模型配置。 */
export async function fetchAgentModels(scope: string | null): Promise<AgentModelCfg[]> {
  const qs = scope ? `?scope=${encodeURIComponent(scope)}` : ''
  return readJson<AgentModelCfg[]>(await fetch(`${hubBase()}/api/models${qs}`))
}

/** team-hub v2：保存某角色默认模型。 */
export function saveAgentModel(scope: string, role: string, provider: string, model: string): Promise<unknown> {
  return hubPost('/api/models', { scope, role, provider, model })
}

/** team-hub v2：清除某角色默认模型（回到平台默认路由）。 */
export function clearAgentModel(scope: string, role: string): Promise<unknown> {
  return hubPost('/api/models/clear', { scope, role })
}

/** DSH 部署可用模型候选（来源：~/.dsh/settings.yaml 各 provider.models）。 */
export const MODEL_OPTIONS: ModelOption[] = [
  { provider: 'custom-ds', model: 'deepseek-v4-flash-openai', name: 'DeepSeek V4 Flash', tier: 'light' },
  { provider: 'custom-ds', model: 'deepseek-v4-pro-openai', name: 'DeepSeek V4 Pro', tier: 'heavy' },
  { provider: 'custom-ds', model: 'deepseek-v4-flash-vision-openai', name: 'DeepSeek V4 Flash 视觉', tier: 'vision' },
  { provider: 'custom-gpt', model: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', tier: 'heavy' },
  { provider: 'custom-gpt', model: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', tier: 'balanced' },
  { provider: 'custom-gpt', model: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', tier: 'balanced' },
  { provider: 'zai-coding-cn', model: 'glm-5.3-flash', name: 'GLM-5.3 Flash', tier: 'light' },
  { provider: 'zai-coding-cn', model: 'glm-5-turbo', name: 'GLM-5-Turbo', tier: 'light' },
  { provider: 'zai-coding-cn', model: 'glm-5.1', name: 'GLM-5.1', tier: 'balanced' },
  { provider: 'zai-coding-cn', model: 'glm-5.2', name: 'GLM-5.2', tier: 'heavy' },
  { provider: 'zai-coding-cn', model: 'glm-5v-turbo', name: 'GLM-5V-Turbo', tier: 'vision' },
]

/** 模型按档位分组展示标签。 */
export const MODEL_TIER_TEXT: Record<string, string> = {
  light: '⚡ 轻量（省 token）',
  balanced: '🔶 均衡',
  heavy: '🟣 旗舰/强推理',
  vision: '👁 视觉',
}

/** team-hub v2：状态流转（todo→in_progress→in_review→done / 打回 / 解阻）。by 默认 general，任务已绑定时应传绑定者 soldier。 */
export function hubTransition(input: { id: string; to: CardStatus; ifVersion?: number; force?: boolean; by?: string }): Promise<unknown> {
  return hubPost('/api/transition', input)
}

/** team-hub v2：认领任务（指派给某智能体 soldier；缺省为 by=general）。 */
export function hubClaim(id: string, soldier?: string): Promise<unknown> {
  return hubPost('/api/claim', { id, ...(soldier ? { soldier } : {}) })
}

/** team-hub v2：转派任务给另一智能体。 */
export function hubReassign(id: string, soldier: string): Promise<unknown> {
  return hubPost('/api/reassign', { id, soldier })
}

/** team-hub v2：任务评论。 */
export function hubComment(id: string, text: string): Promise<unknown> {
  return hubPost('/api/comment', { id, text })
}

/** team-hub v2：L3 跨任务改动重叠检测（scope 内改到同一文件的任务分组；id 过滤出涉及本任务的分组）。 */
export async function fetchHubOverlaps(scope?: string | null, id?: string): Promise<{ scope: string; groups: OverlapGroup[] }> {
  const qs = new URLSearchParams()
  if (scope) qs.set('scope', scope)
  if (id) qs.set('id', id)
  const res = await fetch(`${hubBase()}/api/overlaps?${qs.toString()}`, { headers: authHeaders() })
  if (!res.ok) throw new Error(`overlaps ${res.status}`)
  return res.json()
}

/** team-hub v2：审计批注（file='*'=整体结论；verdict=ok|issue|clear 清除）。 */
export function hubReviewNote(id: string, file: string, verdict: 'ok' | 'issue' | 'clear', note = ''): Promise<unknown> {
  return hubPost('/api/review-notes', { id, file, verdict, note })
}

async function hubPost(path: string, body: Record<string, unknown>): Promise<unknown> {
  // 写请求带超时（20s）：防止代理/中枢无响应时界面无限"卡住"（发布目标等操作无感知失败）。
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20_000)
  let res: Response
  try {
    res = await fetch(`${hubBase()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ ...body, by: body.by ?? 'general' }),
      signal: ctrl.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    if (e instanceof DOMException && e.name === 'AbortError') throw new Error(`请求超时（20s）：中枢 ${hubBase()} 无响应，请确认 team-hub 已启动`)
    throw new Error(`无法连接中枢 ${hubBase()}${path}（网络/代理错误），请检查 team-hub 状态`)
  }
  clearTimeout(timer)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${res.status}${text ? `：${text}` : ''}`)
  }
  return res.json().catch(() => undefined)
}

/** team-hub v2：技能列表。includePending=true 时含待审/被拒（仅 member=general 复审视角，服务端收口）。 */
export async function fetchSkills(opts: { scope?: string | null; includePending?: boolean; member?: string } = {}): Promise<SkillInfo[]> {
  const qs = new URLSearchParams()
  if (opts.scope) qs.set('scope', opts.scope)
  if (opts.member) qs.set('member', opts.member)
  if (opts.includePending) qs.set('include', 'pending')
  return readJson<SkillInfo[]>(await fetch(`${hubBase()}/api/skills${qs.size ? `?${qs.toString()}` : ''}`))
}

/** team-hub v2：提交技能（新技能/内容变更 → pending 待复审，不自动发布）。支持多部件完整技能包。 */
export function registerSkill(input: {
  id: string
  name: string
  description?: string
  prompt?: string
  main?: string
  config?: string
  scripts?: { name: string; content: string }[]
  cases?: { name: string; content: string }[]
  scope?: string
}): Promise<unknown> {
  return hubPost('/api/skills/register', input)
}

/** team-hub v2：复审技能（pending → publish | reject，general 为复审者）。 */
export function reviewSkill(id: string, action: 'publish' | 'reject'): Promise<unknown> {
  return hubPost('/api/skills/review', { id, action })
}

/** team-hub v2：给技能授权（成员 id 或 scope:xxx）。 */
export function grantSkill(id: string, grants: string[]): Promise<unknown> {
  return hubPost('/api/skills/grant', { id, grants })
}

/** team-hub v2：撤销技能授权（过滤式幂等写回；general 门禁由后端强制）。 */
export function revokeSkill(id: string, targets: string[]): Promise<unknown> {
  return hubPost('/api/skills/revoke', { id, targets })
}

export interface TransitionInput {
  id: string
  to: CardStatus
  by: string
  ifVersion?: number
  force?: boolean
}

export function transitionTask(input: TransitionInput): Promise<unknown> {
  return post('/api/transition', input)
}

export function commentTask(input: { id: string; by: string; text: string }): Promise<unknown> {
  return post('/api/comment', input)
}

export function rejectTask(input: { id: string; by: string; reason: string }): Promise<unknown> {
  return post('/api/reject', input)
}

/** 打开 serve.mjs 自带的经典看板（独立页面），任务中心/浏览器的真实落点。 */
export function openKanban(): void {
  window.open(apiBase(), '_blank', 'noopener')
}
// ───────────────────────── 对话中心（S2 ← S1 team-hub /api/chat/*）─────────────────────────

/** team-hub v2：某空间会话列表（最新活跃在前；无 scope 时全量）。 */
export async function fetchChatConversations(scope?: string | null): Promise<ChatConversation[]> {
  const qs = scope ? `?scope=${encodeURIComponent(scope)}` : ''
  const resp = await readJson<{ conversations: ChatConversation[] }>(await fetch(`${hubBase()}/api/chat/conversations${qs}`))
  return resp.conversations
}

export interface NewConversationInput {
  scope: string
  title: string
  kind?: 'space' | 'direct' | 'task'
  participants?: string[]
}

/** team-hub v2：新建会话（写纪律：by=general 由 hubPost 注入；审计 chat:create + SSE）。 */
export function createChatConversation(input: NewConversationInput): Promise<ChatConversation> {
  return hubPost('/api/chat/conversations', {
    scope: input.scope,
    title: input.title,
    kind: input.kind ?? 'space',
    participants: input.participants ?? [],
  }).then(res => (res as { task: ChatConversation }).task)
}

/** team-hub v2：会话消息（升序；before = 上一页最旧 id 游标）。 */
export async function fetchChatMessages(conv: number, opts: { before?: number; limit?: number } = {}): Promise<ChatMessage[]> {
  const qs = new URLSearchParams({ conv: String(conv) })
  if (opts.limit) qs.set('limit', String(opts.limit))
  if (opts.before) qs.set('before', String(opts.before))
  const resp = await readJson<{ messages: ChatMessage[] }>(await fetch(`${hubBase()}/api/chat/messages?${qs.toString()}`))
  return resp.messages
}

/** team-hub v2：发消息（body 校验在后端：kind ∈ text|markdown|system、≤8000 字符、scope=会话 scope）。
 * S3/S8：attachmentIds 可选——先 PUT /api/chat/attachments 上传（staged）拿到 id 后随消息绑定（服务端同事务置 sent；
 * meta.attachments=[{id,fileName,size}] 只存引用，文件全文绝不进 body/meta）。 */
export function postChatMessage(input: { conv: number; body: string; kind?: string; clientTs?: string; attachmentIds?: number[] }): Promise<ChatMessage> {
  return hubPost('/api/chat/messages', {
    conv: input.conv,
    body: input.body,
    kind: input.kind ?? 'text',
    clientTs: input.clientTs ?? '',
    attachmentIds: input.attachmentIds && input.attachmentIds.length > 0 ? input.attachmentIds : undefined,
  }).then(res => (res as { task: ChatMessage }).task)
}

/** team-hub v2（S3/S8）：上传对话附件（raw UTF-8 文本 → staged，服务端护栏黑名单/大小/UTF-8 fatal）。
 * 返回 {id,fileName,size} 引用；绑定由 postChatMessage(attachmentIds) 完成。 */
export async function uploadChatAttachment(input: { scope: string; fileName: string; content: Blob | string }): Promise<ChatAttachmentRef> {
  const qs = new URLSearchParams({ scope: input.scope, fileName: input.fileName, by: 'general' })
  const body = typeof input.content === 'string' ? new Blob([input.content], { type: 'text/plain;charset=utf-8' }) : input.content
  const res = await fetch(`${hubBase()}/api/chat/attachments?${qs.toString()}`, {
    method: 'PUT',
    headers: authHeaders(),
    body,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let errText = ''
    try { errText = (JSON.parse(text) as { error?: string }).error ?? '' } catch { errText = text }
    throw new Error(`${res.status}${errText ? `：${errText}` : ''}`)
  }
  return res.json() as Promise<ChatAttachmentRef>
}

/** team-hub v2（S2/S7）：对话健康聚合（只读：守护在线/回复开关/模型解析链/最近失败）。端点缺失 → 抛错由调用方灰态处理。 */
export async function fetchChatHealth(scope: string): Promise<ChatHealthInfo> {
  return readJson<ChatHealthInfo>(await fetch(`${hubBase()}/api/chat/health?scope=${encodeURIComponent(scope)}`))
}

/** team-hub 审计 SSE：单一 /api/events（I8），订阅方按 action 过滤 chat:*。断线自动重连。 */
export function subscribeHubAudit(onEvent: (event: HubAuditEvent) => void): () => void {
  const es = new EventSource(`${hubBase()}/api/events`)
  es.onmessage = (ev) => {
    try {
      onEvent(JSON.parse(ev.data) as HubAuditEvent)
    } catch {
      /* 忽略损坏帧 */
    }
  }
  return () => es.close()
}

// ── R-4（S9/S11）对话 AI 回复：重试 + 每空间回复设置 ──
/** team-hub v2：重试一条失败（meta.aiStatus=failed）的消息（服务端重置为 awaiting；已 replied 拒绝）。 */
export function retryChatReply(msgId: number): Promise<ChatMessage> {
  return hubPost('/api/chat/replies/retry', { msgId }).then(res => (res as { task: ChatMessage }).task)
}

export interface ChatReplySettings {
  scope: string
  enabled: boolean
  model: string | null
  identity: string | null
  systemHint: string | null
  updatedAt: string | null
}

/** team-hub v2：读取某空间 AI 回复设置（未设置默认 enabled=true）。 */
export async function fetchChatReplySettings(scope: string): Promise<ChatReplySettings> {
  return readJson<ChatReplySettings>(await fetch(`${hubBase()}/api/chat/reply-settings?scope=${encodeURIComponent(scope)}`))
}

/** team-hub v2：保存某空间 AI 回复设置（enabled 省略 = true）。 */
export function saveChatReplySettings(input: { scope: string; enabled?: boolean; model?: string; identity?: string; systemHint?: string }): Promise<unknown> {
  return hubPost('/api/chat/reply-settings', input)
}

// ───────────────────────── 文件中心（S5 ← S3/S4 serve.mjs /api/files，同源）─────────────────────────

async function filesGet<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<T>
}

/** 文件中心：列出 scope 空间 local_dir 下某相对目录。path='' = 根。 */
export function fetchFileList(scope: string, path = ''): Promise<FileListResponse> {
  const qs = new URLSearchParams({ scope, path })
  return filesGet<FileListResponse>(`/api/files/list?${qs.toString()}`)
}

export function fetchFilePreview(scope: string, path: string): Promise<FilePreview> {
  const qs = new URLSearchParams({ scope, path })
  return filesGet<FilePreview>(`/api/files/read?${qs.toString()}`)
}

export function fileDownloadUrl(scope: string, path: string): string {
  const qs = new URLSearchParams({ scope, path })
  return `/api/files/download?${qs.toString()}`
}

interface FilesErrorPayload {
  error?: string
}

async function filesWrite<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const body = await res.json().catch(() => null) as FilesErrorPayload | null
    const err = new Error(body?.error ?? `${res.status} ${res.statusText}`) as Error & { status?: number }
    err.status = res.status
    throw err
  }
  return res.json() as Promise<T>
}

export interface FilesWriteOk {
  ok: boolean
  path?: string
  file?: { name: string; size: number; mtime: string }
  created?: boolean
  deleted?: boolean
  from?: string
  to?: string
}

export function filesUpload(scope: string, path: string, data: Blob, overwrite = false): Promise<FilesWriteOk> {
  const qs = new URLSearchParams({ scope, path, ...(overwrite ? { overwrite: '1' } : {}) })
  return filesWrite<FilesWriteOk>(`/api/files/upload?${qs.toString()}`, { method: 'PUT', body: data })
}

export function filesMkdir(scope: string, path: string): Promise<FilesWriteOk> {
  return filesWrite<FilesWriteOk>('/api/files/mkdir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope, path }) })
}

export function filesRename(scope: string, from: string, to: string): Promise<FilesWriteOk> {
  return filesWrite<FilesWriteOk>('/api/files/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope, from, to }) })
}

export function filesDelete(scope: string, path: string, confirm: 'yes'): Promise<FilesWriteOk> {
  return filesWrite<FilesWriteOk>('/api/files/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope, path, confirm }) })
}

// ───────────────────────── 技能安装（技能仓库：本地目录 / GitHub → 候选 → 导入；同源 /api/skills）─────────────────────────

/** 扫描后得到的单枚技能候选（从目录/仓库解析出的 bundle，未注册）。 */
export interface SkillCandidate {
  id: string
  name: string
  description: string
  main: string
  config: string
  scripts: { name: string; content: string }[]
  cases: { name: string; content: string }[]
  sourceDir?: string
}

/** 扫描本地目录（scope 工作区内的相对路径）→ 候选列表（不写入中枢）。 */
export async function scanSkillsDir(scope: string, path: string): Promise<SkillCandidate[]> {
  const res = await fetch('/api/skills/scan-dir', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, path }),
  })
  const body = await res.json().catch(() => null) as { candidates?: SkillCandidate[]; error?: string } | null
  if (!res.ok || !body) throw new Error(body?.error ?? `扫描失败：${res.status} ${res.statusText}`)
  return body.candidates ?? []
}

/** 从 GitHub 仓库拉取（归档到受控缓存再扫描）→ 候选列表（不写入中枢）。 */
export async function scanSkillsGithub(scope: string, url: string): Promise<{ candidates: SkillCandidate[]; archiveDir?: string }> {
  const res = await fetch('/api/skills/scan-github', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, url }),
  })
  const body = await res.json().catch(() => null) as { candidates?: SkillCandidate[]; archiveDir?: string; error?: string } | null
  if (!res.ok || !body) throw new Error(body?.error ?? `拉取失败：${res.status} ${res.statusText}`)
  return { candidates: body.candidates ?? [], archiveDir: body.archiveDir }
}

/** 把选中的技能候选注册到中枢（→ pending 待复审）。 */
export async function importSkillCandidates(scope: string, candidates: SkillCandidate[]): Promise<{ results: { id: string; ok: boolean; error?: string; version?: number }[] }> {
  const res = await fetch('/api/skills/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, candidates }),
  })
  const body = await res.json().catch(() => null) as ({ results: { id: string; ok: boolean; error?: string; version?: number }[]; error?: string }) | null
  if (!res.ok || !body) throw new Error(body?.error ?? `导入失败：${res.status} ${res.statusText}`)
  return body
}

/** 技能来源（每个空间绑定的团队技能仓库，存于 team-hub）。 */
export interface SkillSource {
  scope: string
  url: string
  branch: string
  updatedAt?: string | null
}

/** 读取某空间的技能来源（team-hub GET /api/skill-source）。 */
export async function getSkillSource(scope: string): Promise<SkillSource> {
  const res = await fetch(`${hubBase()}/api/skill-source?scope=${encodeURIComponent(scope)}`)
  const body = await res.json().catch(() => null) as { source?: SkillSource; error?: string } | null
  if (!res.ok || !body) throw new Error(body?.error ?? `获取技能来源失败：${res.status} ${res.statusText}`)
  return body.source ?? { scope, url: '', branch: '' }
}

/** 保存某空间的技能来源（team-hub POST /api/skill-source）。 */
export function saveSkillSource(scope: string, url: string, branch: string): Promise<unknown> {
  return hubPost('/api/skill-source', { scope, url, branch })
}

/** 一键拉取同步（workbench POST /api/skills/sync）：扫描来源仓库，按其返回的冲突策略注册/跳过。 */
export interface SkillSyncReport {
  added: { id: string; name: string; version?: number; error?: string }[]
  updated: { id: string; name: string; fromVersion: number; toVersion?: number }[]
  unchanged: { id: string; name: string; version: number }[]
  skipped: { id: string; name: string; version?: number; error?: string }[]
  foreign: { id: string; name: string; scope: string }[]
}

export interface SkillSyncResult {
  ok: boolean
  strategy: 'upgrade' | 'skip'
  candidates: number
  report: SkillSyncReport
  source: SkillSource
}

export async function syncSkills(scope: string, url: string, branch: string, strategy: 'upgrade' | 'skip'): Promise<SkillSyncResult> {
  const res = await fetch('/api/skills/sync', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, url, branch, strategy }),
  })
  const body = await res.json().catch(() => null) as (SkillSyncResult & { error?: string }) | null
  if (!res.ok || !body) throw new Error(body?.error ?? `同步失败：${res.status} ${res.statusText}`)
  return body
}

// ───────────────────────── 浏览器助手（S7 ← S6 serve.mjs /api/web/fetch，同源）─────────────────────────

export async function webFetchPage(input: { url: string; maxBytes?: number; timeoutMs?: number }): Promise<WebFetchResult> {
  const res = await fetch('/api/web/fetch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = await res.json().catch(() => null) as WebFetchResult | null
  if (body && typeof body.ok === 'boolean') return body
  throw new Error(`浏览器助手请求失败：${res.status} ${res.statusText}`)
}

// ───────────────────────── 通知中心（S7 ← R-B2：audit 派生，零新表零新端点）─────────────────────────

/**
 * 通知 action 白名单（R-B2 / TC-S7-02/03 / R-15）：任务生命周期 + 目标/空间/模型/技能类入列。
 * chat:* 一律默认排除（防刷屏）；progress（进度中间态）、comment（任务讨论，走对话中心）、
 * release-stale（租约回收）、exec:*（开关回声）等高频/系统噪音不入列。
 * 注：白名单是对动作类型的收窄；scope 过滤 + 列表拉取仍走既有 GET /api/activity（唯一列表源）。
 */
const NOTIFY_ACTIONS = new Set<string>([
  'create', 'claim', 'transition', 'advance', 'reassign', 'hold', 'unhold',
  'patch', 'evidence', 'artifact', 'review-note', 'test-report',
  'goal:publish', 'goal:slices', 'goal:pause', 'goal:resume', 'goal:done', 'goal:cancel', 'goal:context',
  'space:create', 'space:update', 'space:delete', 'space:add-agents',
  'model:set', 'model:clear',
  'skill:submit', 'skill:review', 'skill:grant',
])

/** 是否通知白名单 action（chat:* 等一律不入列，TC-S7-03）。 */
export function isNotifyAction(action: unknown): boolean {
  return typeof action === 'string' && NOTIFY_ACTIONS.has(action)
}

/** 通知列表行 = 审计条目（seq 有序；time/scope/action/taskId/member/detail 即列表所需字段）。 */
export type NotifyRow = HubActivity

const notifyReadKey = (scope: string | null): string => `legion.notify.read.${scope ?? '__all__'}`

/**
 * 已读游标读取（localStorage per scope）。「已读」是纯本地语义：绝不写 audit、绝不新增写接口
 * （TC-S7-04/05：点击已读 → 刷新保持、切空间回来仍在；反向断言服务端零新行）。
 */
export function notifyReadSeq(scope: string | null): number {
  const raw = Number(localStorage.getItem(notifyReadKey(scope)) ?? 0)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
}

/** 已读游标推进（单调递增：只把游标推到「已点开的最后一条 seq」，只写 localStorage）。
 *  游标仅本机有效、跨标签页/跨浏览器不同步（R-15 v1 接受；需服务端已读持久时走 J8-B）。 */
export function setNotifyReadSeq(scope: string | null, seq: number): void {
  const cur = notifyReadSeq(scope)
  if (seq > cur) localStorage.setItem(notifyReadKey(scope), String(Math.floor(seq)))
}

/** 通知未读计数：白名单内且 seq 在已读游标之后（侧栏 badge 与通知面板共用同一口径）。 */
export function countNotifyUnread(rows: NotifyRow[], scope: string | null): number {
  const cursor = notifyReadSeq(scope)
  let n = 0
  for (const row of rows) {
    if (isNotifyAction(row.action) && row.seq > cursor) n += 1
  }
  return n
}
