import type { ActivityEvent, AgentCatalogItem, AgentModelCfg, ApiConfig, BoardData, CardStatus, ChatAttachmentRef, ChatConversation, ChatHealthInfo, ChatMessage, DirListing, FileListResponse, FilePreview, GoalInfo, GoalStatus, HubActivity, HubAuditEvent, HubDocContent, HubTask, MissionsResponse, ModelOption, OverlapGroup, RepoInspect, RosterResponse, SkillInfo, SpaceInfo, WebFetchResult, WebHistoryResponse, WebMetaResponse, WebShotResult } from './types'
import { subscribeHubEventStream } from './hubEventStream.ts'
import { HubError, hubErrorFromBody } from './hub-errors.ts'

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

function withAuthHeaders(headers?: HeadersInit): Headers {
  const merged = new Headers(headers)
  for (const [key, value] of Object.entries(authHeaders())) merged.set(key, value)
  return merged
}

/**
 * hub GET 统一携带已存 token（P2-2 读面同步：远程受保护中枢的读接口/SSE 必须带 token）。
 * 探测 /api/config 不走本函数（hubBase 可达性探测保持匿名；服务端对 config 能力发现放行）。
 */
function hubGet(path: string): Promise<Response> {
  return fetch(`${hubBase()}${path}`, { headers: authHeaders() })
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
  return readJson<MissionsResponse>(await hubGet(`/api/missions${qs}`))
}

/** team-hub v2：真实存在的分区列表（tasks + members 的 distinct scope）。 */
export async function fetchHubScopes(): Promise<string[]> {
  const resp = await readJson<{ scopes: string[] }>(await hubGet('/api/scopes'))
  return resp.scopes
}

/** team-hub v2：工作空间列表（spaces 注册名 + 既有 scope 推导合并）。 */
export async function fetchSpaces(): Promise<SpaceInfo[]> {
  const resp = await readJson<{ spaces: SpaceInfo[] }>(await hubGet('/api/spaces'))
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
  return readJson<SpaceDeleteImpact>(await hubGet(`/api/spaces/impact?id=${encodeURIComponent(id)}`))
}

/** team-hub v2（R-3/S8）：删除工作空间（级联 11 表 + spaces 行；confirm=delete-space:<id>；软件受保护由后端拒绝）。 */
export function deleteSpace(id: string): Promise<unknown> {
  return hubPost('/api/spaces/delete', { id, confirm: `delete-space:${id}` })
}

/** team-hub v2（R-2/S4）：读取全局规范层（rules；未设置返回空 content）。 */
export async function fetchRule(scope: string): Promise<{ scope: string; content: string; updatedAt: string | null }> {
  const resp = await readJson<{ rules: { scope: string; content: string; updatedAt: string | null } }>(await hubGet(`/api/rules?scope=${encodeURIComponent(scope)}`))
  return resp.rules
}

/** team-hub v2（R-2/S4）：保存全局规范层（写纪律 by=general 由 hubPost 注入；审计 rules:update + SSE）。 */
export function saveRule(scope: string, content: string): Promise<unknown> {
  return hubPost('/api/rules', { scope, content })
}

/** team-hub v2：读取指定空间目标（objective + 该空间任务进度）。 */

export async function fetchGoal(scope: string | null): Promise<GoalInfo> {
  const qs = scope ? `?scope=${encodeURIComponent(scope)}` : ''
  return readJson<GoalInfo>(await hubGet(`/api/goal${qs}`))
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
  const resp = await readJson<{ agents: AgentCatalogItem[] }>(await hubGet('/api/agents'))
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
  return readJson<RosterResponse>(await hubGet(`/api/roster${qs}`))
}

/** team-hub v2：在工作台当前空间（scope）内新建任务；by 固定为 general（工作台代理身份）。 */
export async function createHubTask(input: NewTaskInput, scope?: string | null): Promise<unknown> {
  return hubPost('/api/create', { ...input, scope: scope ?? 'default' })
}

/** team-hub v2：某空间的全部任务（/api/board，含角色/指派/依赖/版本），供中枢调度。 */
export async function fetchHubTasks(scope: string | null): Promise<HubTask[]> {
  const qs = scope ? `?scope=${encodeURIComponent(scope)}` : ''
  return readJson<HubTask[]>(await hubGet(`/api/board${qs}`))
}

/** team-hub v2：单任务完整详情（任务详情视图）。 */
export async function fetchHubTask(id: string): Promise<HubTask> {
  return readJson<HubTask>(await hubGet(`/api/task?id=${encodeURIComponent(id)}`))
}

/** team-hub v2：某空间/某任务的审计时间线（进展历史）。taskId 优先，其次 scope；limit 可选（服务端上限 500）。 */
export async function fetchHubActivity(opts: { scope?: string | null; taskId?: string; goalId?: string | null; limit?: number } = {}): Promise<HubActivity[]> {
  const qs = new URLSearchParams()
  if (opts.taskId) qs.set('taskId', opts.taskId)
  else if (opts.goalId) qs.set('goalId', opts.goalId)
  else if (opts.scope) qs.set('scope', opts.scope)
  if (opts.limit !== undefined) qs.set('limit', String(opts.limit))
  if (qs.size === 0) qs.set('limit', '100')
  return readJson<HubActivity[]>(await hubGet(`/api/activity?${qs.toString()}`))
}

/** team-hub v2（S3 内容通道）：取某任务某产物条目对应的文件内容（md 按 text/markdown 语义）。
 * i 缺省取最新一条（兼容既有语义）；404/403/越界/二进制等错误由服务端 {error} 文案透传。 */
export async function fetchHubDocContent(taskId: string, index?: number): Promise<HubDocContent> {
  const qs = new URLSearchParams({ task: taskId })
  if (typeof index === 'number') qs.set('i', String(index))
  const res = await hubGet(`/api/artifact/content?${qs.toString()}`)
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
  return readJson<{ scope: string; enabled: boolean }>(await hubGet(`/api/exec${qs}`))
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
  return readJson<AgentModelCfg[]>(await hubGet(`/api/models${qs}`))
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

/** 关联日程行（P2-5 双向关联：任务详情展示用；calendar.ts 的 CalEvent 兼容子集）。 */
export interface LinkedCalendarEvent {
  id: number
  scope: string
  title: string
  start: string
  end?: string | null
  allDay?: boolean
  taskId?: string | null
  goalId?: string | null
  recurring?: boolean
  occurrenceDate?: string
}

/**
 * P2-5 双向关联：查询某任务/目标关联的日程（team-hub `/api/calendar/events/by-link`）。
 * 带 from/to → 重复事件展开为实例；不带 → 每条事件一行（首次实例日）。
 * 读失败时由调用方决定降级（详情面板显示「暂无关联日程」），与 fetchHubOverlaps 同风格。
 */
export async function fetchHubCalendarByLink(opts: { taskId?: string; goalId?: string; from?: string; to?: string }): Promise<LinkedCalendarEvent[]> {
  const qs = new URLSearchParams()
  if (opts.taskId) qs.set('taskId', opts.taskId)
  if (opts.goalId) qs.set('goalId', opts.goalId)
  if (opts.from) qs.set('from', opts.from)
  if (opts.to) qs.set('to', opts.to)
  const res = await fetch(`${hubBase()}/api/calendar/events/by-link?${qs.toString()}`, { headers: authHeaders() })
  if (!res.ok) throw new Error(`calendar by-link ${res.status}`)
  const data = (await res.json()) as { events?: LinkedCalendarEvent[] }
  return Array.isArray(data.events) ? data.events : []
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
    // **保留结构**，不再压成一句字符串。PRT-252 返回的 `code`/`field`/`hint`/
    // `candidates` 过去在这一行被丢掉——于是后端那些**有测试守着**的字段
    // 在到达界面之前就没了（"后端加了码、前端还是笼统提示"）。
    // 消息形态不变（`${status}：...`）；JSON 响应时改用可读的 `error` 字段，
    // 不再是整段 JSON 原样上屏（见 hub-errors.ts 文件头 ①）。
    const text = await res.text().catch(() => '')
    let parsed: unknown = null
    try { parsed = text ? JSON.parse(text) : null } catch { parsed = null }
    throw hubErrorFromBody(res.status, text, parsed)
  }
  return res.json().catch(() => undefined)
}

/** team-hub v2：技能列表。includePending=true 时含待审/被拒（仅 member=general 复审视角，服务端收口）。 */export async function fetchSkills(opts: { scope?: string | null; includePending?: boolean; member?: string } = {}): Promise<SkillInfo[]> {
  const qs = new URLSearchParams()
  if (opts.scope) qs.set('scope', opts.scope)
  if (opts.member) qs.set('member', opts.member)
  if (opts.includePending) qs.set('include', 'pending')
  return readJson<SkillInfo[]>(await hubGet(`/api/skills${qs.size ? `?${qs.toString()}` : ''}`))
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

export interface PermissionRequest {
  requestId: string
  scope: string
  actor: string
  action: string
  target: string
  status: string
  operation?: Record<string, unknown>
}

export function fetchPermissionInbox(scope?: string | null): Promise<PermissionRequest[]> {
  const qs = scope ? `?scope=${encodeURIComponent(scope)}` : ''
  return hubGet(`/api/permissions/inbox${qs}`).then(async res => (await readJson<{ requests: PermissionRequest[] }>(res)).requests)
}

export function decidePermission(requestId: string, decision: 'approve' | 'deny', reason?: string): Promise<unknown> {
  return hubPost('/api/permissions/decide', { requestId, decision, reason })
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
  const resp = await readJson<{ conversations: ChatConversation[] }>(await hubGet(`/api/chat/conversations${qs}`))
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
  const resp = await readJson<{ messages: ChatMessage[] }>(await hubGet(`/api/chat/messages?${qs.toString()}`))
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
  return readJson<ChatHealthInfo>(await hubGet(`/api/chat/health?scope=${encodeURIComponent(scope)}`))
}

/** team-hub 审计 SSE：统一信封校验、scope 过滤、持久游标与 EventSource 重连。 */
export function subscribeHubAudit(
  onEvent: (event: HubAuditEvent) => void,
  options: { scope?: string; storage?: Storage; onStatus?: (status: HubSseStatus) => void } = {},
): () => void {
  return subscribeHubEventStream(`${hubBase()}/api/events`, onEvent, {
    scope: options.scope,
    storage: options.storage,
    token: getToken() || undefined,
    onStatus: options.onStatus,
  })
}

/** SSE 订阅状态（P2-4 实时连接可观测性）。 */
export interface HubSseStatus {
  state: 'open' | 'reconnected' | 'reconnecting' | 'closed'
  /** 打开次数：1 = 首次，>1 = 断线后重连成功。 */
  opens: number
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
  return readJson<ChatReplySettings>(await hubGet(`/api/chat/reply-settings?scope=${encodeURIComponent(scope)}`))
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
  const res = await fetch(url, { ...init, headers: withAuthHeaders(init.headers) })
  if (!res.ok) {
    const body = await res.json().catch(() => null) as (FilesErrorPayload & { received?: number }) | null
    const err = new Error(body?.error ?? `${res.status} ${res.statusText}`) as Error & { status?: number; received?: number }
    err.status = res.status
    // P2-7：分片端点在 409（offset 不匹配）/400（未收齐）时回传服务端真实进度——前端据此**续传**而非从头再传
    if (typeof body?.received === 'number') err.received = body.received
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
  /** P2-7：跳过（策略 skip 且目标已存在）——未落盘 */
  skipped?: boolean
  /** P2-7：本次生效的冲突策略（服务端回传，前端据此提示） */
  strategy?: UploadStrategy
  /** P2-7：请求名（rename 策略下 file.name 才是实际落盘名） */
  requestedName?: string
}

/** P2-7 上传冲突策略（与 serve.mjs UPLOAD_STRATEGIES 一致，服务端为权威）。 */
export type UploadStrategy = 'ask' | 'overwrite' | 'skip' | 'rename'

export function filesUpload(scope: string, path: string, data: Blob, strategy: UploadStrategy = 'ask'): Promise<FilesWriteOk> {
  const qs = new URLSearchParams({ scope, path, strategy })
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

// ───────────────────────── P2-7 文件中心增强（搜索 / 批量 / 分片上传 / git 只读）─────────────────────────

export interface FilesSearchHit { name: string; path: string; type: 'dir' | 'file'; size: number; mtime: string | null }
export interface FilesSearchResponse { ok: boolean; path: string; query: string; recursive: boolean; results: FilesSearchHit[]; truncated: boolean; maxResults: number }

/** 文件名搜索（大小写不敏感子串；recursive=1 递归；结果上限触顶时 truncated=true 而非静默丢结果）。 */
export function filesSearch(scope: string, path: string, q: string, recursive = false, limit = 500): Promise<FilesSearchResponse> {
  const qs = new URLSearchParams({ scope, path, q, ...(recursive ? { recursive: '1' } : {}), limit: String(limit) })
  return filesGet<FilesSearchResponse>(`/api/files/search?${qs.toString()}`)
}

export interface FilesBatchItem { path: string; ok: boolean; error?: string; to?: string }
export interface FilesBatchResponse { ok: boolean; action: 'delete' | 'move'; okCount: number; failed: number; items: FilesBatchItem[] }

/** 批量操作（删除 / 移动到目录）：逐项报告成败，单项失败不整体回滚。 */
export function filesBatch(scope: string, action: 'delete' | 'move', paths: string[], toDir?: string): Promise<FilesBatchResponse> {
  return filesWrite<FilesBatchResponse>('/api/files/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, action, paths, ...(toDir === undefined ? {} : { toDir }), ...(action === 'delete' ? { confirm: 'yes' } : {}) }),
  })
}

export interface ChunkUploadInit {
  ok: boolean
  uploadId?: string
  received: number
  size: number
  chunkSize: number
  resumed?: boolean
  skipped?: boolean
  requestedName?: string
  finalName?: string
}

/** 发起（或复用）分片上传会话：同 path+size 已有未完成会话 → 返回原 uploadId 与 received（断点续传）。 */
export function filesUploadInit(scope: string, path: string, size: number, strategy: UploadStrategy = 'ask'): Promise<ChunkUploadInit> {
  return filesWrite<ChunkUploadInit>('/api/files/upload/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, path, size, strategy }),
  })
}

/** 追加一片（顺序语义：offset 必须等于服务端已收字节；不匹配 → 抛错，err.received 为真实进度）。 */
export function filesUploadChunk(scope: string, uploadId: string, offset: number, data: Blob): Promise<{ ok: boolean; received: number; size: number }> {
  const qs = new URLSearchParams({ scope, uploadId, offset: String(offset) })
  return filesWrite<{ ok: boolean; received: number; size: number }>(`/api/files/upload/chunk?${qs.toString()}`, { method: 'PUT', body: data })
}

/** 完成分片上传：长度须等于声明 size（未收齐 → 抛错，err.received 为已收字节，会话保留可续传）。 */
export function filesUploadComplete(scope: string, uploadId: string): Promise<FilesWriteOk & { name?: string; size?: number; requestedName?: string }> {
  return filesWrite<FilesWriteOk & { name?: string; size?: number; requestedName?: string }>('/api/files/upload/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, uploadId }),
  })
}

/** 中止分片上传（丢弃会话与分片；幂等）。 */
export function filesUploadAbort(scope: string, uploadId: string): Promise<{ ok: boolean; aborted: boolean }> {
  const qs = new URLSearchParams({ scope, uploadId })
  return filesWrite<{ ok: boolean; aborted: boolean }>(`/api/files/upload/abort?${qs.toString()}`, { method: 'DELETE' })
}

export interface GitFileStatus {
  path: string
  from?: string
  index: string
  worktree: string
  code: string
  staged: boolean
  untracked: boolean
  conflicted: boolean
}
export interface GitStatusResponse {
  ok: boolean
  isRepo: boolean
  repoRoot?: string
  branch?: string | null
  ahead?: number | null
  behind?: number | null
  files?: GitFileStatus[]
  summary?: { staged: number; unstaged: number; untracked: number; conflicted: number; both: number }
  total?: number
}

/** git **只读**：状态（分支 / 领先落后 / 逐文件标记，区分暂存与工作区）。 */
export function fetchGitStatus(scope: string, path = ''): Promise<GitStatusResponse> {
  const qs = new URLSearchParams({ scope, path })
  return filesGet<GitStatusResponse>(`/api/files/git/status?${qs.toString()}`)
}

export interface GitDiffResponse {
  ok: boolean
  isRepo: boolean
  path?: string
  relInRepo?: string
  staged?: boolean
  diff?: string
  binary?: boolean
  truncated?: boolean
  note?: string | null
}

/** git **只读**：单文件 unified diff（staged=true 取索引 vs HEAD）。 */
export function fetchGitDiff(scope: string, path: string, staged = false): Promise<GitDiffResponse> {
  const qs = new URLSearchParams({ scope, path, ...(staged ? { staged: '1' } : {}) })
  return filesGet<GitDiffResponse>(`/api/files/git/diff?${qs.toString()}`)
}

export interface GitCommit { hash: string; short: string; author: string; date: string; subject: string }
export interface GitLogResponse { ok: boolean; isRepo: boolean; repoRoot?: string; commits?: GitCommit[] }

/** git **只读**：最近提交。 */
export function fetchGitLog(scope: string, path = '', limit = 20): Promise<GitLogResponse> {
  const qs = new URLSearchParams({ scope, path, limit: String(limit) })
  return filesGet<GitLogResponse>(`/api/files/git/log?${qs.toString()}`)
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
    method: 'POST', headers: withAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ scope, path }),
  })
  const body = await res.json().catch(() => null) as { candidates?: SkillCandidate[]; error?: string } | null
  if (!res.ok || !body) throw new Error(body?.error ?? `扫描失败：${res.status} ${res.statusText}`)
  return body.candidates ?? []
}

/** 从 GitHub 仓库拉取（归档到受控缓存再扫描）→ 候选列表（不写入中枢）。 */
export async function scanSkillsGithub(scope: string, url: string): Promise<{ candidates: SkillCandidate[]; archiveDir?: string }> {
  const res = await fetch('/api/skills/scan-github', {
    method: 'POST', headers: withAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ scope, url }),
  })
  const body = await res.json().catch(() => null) as { candidates?: SkillCandidate[]; archiveDir?: string; error?: string } | null
  if (!res.ok || !body) throw new Error(body?.error ?? `拉取失败：${res.status} ${res.statusText}`)
  return { candidates: body.candidates ?? [], archiveDir: body.archiveDir }
}

/** 把选中的技能候选注册到中枢（→ pending 待复审）。 */
export async function importSkillCandidates(scope: string, candidates: SkillCandidate[]): Promise<{ results: { id: string; ok: boolean; error?: string; version?: number }[] }> {
  const res = await fetch('/api/skills/import', {
    method: 'POST', headers: withAuthHeaders({ 'Content-Type': 'application/json' }),
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
  const res = await hubGet(`/api/skill-source?scope=${encodeURIComponent(scope)}`)
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
    method: 'POST', headers: withAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ scope, url, branch, strategy }),
  })
  const body = await res.json().catch(() => null) as (SkillSyncResult & { error?: string }) | null
  if (!res.ok || !body) throw new Error(body?.error ?? `同步失败：${res.status} ${res.statusText}`)
  return body
}

// ───────────────────────── 浏览器助手（S7 ← S6 serve.mjs /api/web/fetch，同源）─────────────────────────

export async function webFetchPage(input: { url: string; maxBytes?: number; timeoutMs?: number; scope?: string }): Promise<WebFetchResult> {
  const res = await fetch('/api/web/fetch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = await res.json().catch(() => null) as WebFetchResult | null
  if (body && typeof body.ok === 'boolean') {
    // P2-8④：限流/配额失败以 429 + { code, retryAfterSec } 返回，交由界面给可行动指引
    if (res.status === 429 && body.retryAfterSec === undefined) {
      const ra = Number(res.headers.get('retry-after'))
      if (Number.isFinite(ra)) body.retryAfterSec = ra
    }
    return body
  }
  throw new Error(`浏览器助手请求失败：${res.status} ${res.statusText}`)
}

/** P2-8④：配额快照 + 截图能力状态 + 缓存规模（未带 scope 时 quota 为 null）。 */
export async function webMeta(scope?: string): Promise<WebMetaResponse | null> {
  const qs = scope ? '?scope=' + encodeURIComponent(scope) : ''
  try {
    const res = await fetch('/api/web/meta' + qs)
    const body = await res.json().catch(() => null) as WebMetaResponse | null
    return body && typeof body.ok === 'boolean' ? body : null
  } catch {
    return null // fetch 自身失败（serve 未起）：界面显示「配额不可用」而不是抛错打断面板
  }
}

/** P2-8①：按空间读抓取历史（team-hub 权威；serve.mjs 代理）。 */
export async function webHistory(input: { scope: string; limit?: number; q?: string }): Promise<WebHistoryResponse> {
  const qs = new URLSearchParams({ scope: input.scope })
  if (input.limit) qs.set('limit', String(input.limit))
  if (input.q) qs.set('q', input.q)
  const res = await fetch('/api/web/history?' + qs.toString())
  const body = await res.json().catch(() => null) as WebHistoryResponse | null
  if (body) return body
  throw new Error(`读取抓取历史失败：${res.status} ${res.statusText}`)
}

/** P2-8①：清空本空间历史（或按 id 删单条）。 */
export async function webHistoryClear(input: { scope: string; id?: number }): Promise<{ ok: boolean; removed?: number; error?: string }> {
  const res = await fetch('/api/web/history/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = await res.json().catch(() => null) as { ok?: boolean; removed?: number; error?: string } | null
  if (body) return { ok: body.ok === true, removed: body.removed, error: body.error }
  return { ok: false, error: `清空历史失败：${res.status} ${res.statusText}` }
}

/** P2-8③：可选截图（需 serve.mjs 以 DSH_WEB_SHOT_ENABLE=1 启动）；未启用/无浏览器时返回错误码。 */
export async function webScreenshot(input: { url: string; scope?: string; width?: number; height?: number }): Promise<WebShotResult> {
  const res = await fetch('/api/web/shot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = await res.json().catch(() => null) as WebShotResult | null
  if (body && (typeof body.ok === 'boolean' || typeof body.error === 'string')) return body
  throw new Error(`截图请求失败：${res.status} ${res.statusText}`)
}

/** P2-8③：已存截图的可访问 URL（同一 serve.mjs 读回）。 */
export function webShotUrl(scope: string, name: string): string {
  return '/api/web/shot?scope=' + encodeURIComponent(scope) + '&name=' + encodeURIComponent(name)
}

// ───────────────────────── 通知中心（S7 ← R-B2：audit 派生，零新表零新端点）─────────────────────────
// P2-4：分类/优先级/来源、批量已读、跳转协议、去重与断线恢复的**定义与纯函数**已收敛到 ./notify.ts
// （可被 node:test 直接 import）；本节只保留 localStorage IO 薄层与历史导出（向后兼容）。
// 注：相对导入写显式 .ts 扩展名——使本文件同时可被 Node（--experimental-strip-types）直接导入，
// 让 localStorage IO 层也进 node:test 端到端覆盖（tsconfig 已开 allowImportingTsExtensions）。

export {
  NOTIFY_ACTIONS, NOTIFY_ACTION_LABEL, NOTIFY_CATEGORY_LABEL, NOTIFY_PRIORITY_LABEL,
  isNotifyAction, notifyLabel, notifyCategory, notifyPriority, jumpOf, validTaskId,
  toNotifyItem, toNotifyItems, mergeNotifyItems, applyReadState,
  isSeqRead, normalizeReadState, applyMarkRead, applyMarkAllRead,
  unreadCount, categoryCounts, filterItems, highestSeq, shouldRefill,
  notifyReadKey, notifyReadIdsKey,
} from './notify.ts'
export type { NotifyCategory, NotifyPriority, NotifySource, NotifyJump, NotifyItem, NotifyReadState } from './notify.ts'

import { EMPTY_READ_STATE, applyMarkAllRead, applyMarkRead, isNotifyAction, isSeqRead, normalizeReadState, notifyReadIdsKey, notifyReadKey, unreadCount } from './notify.ts'
import type { NotifyItem, NotifyReadState } from './notify.ts'

/** 通知列表行 = 审计条目（seq 有序；time/scope/action/taskId/member/detail 即列表所需字段）。 */
export type NotifyRow = HubActivity

/**
 * 读取已读状态（localStorage per scope）。「已读」是纯本地语义：绝不写 audit、绝不新增写接口
 * （TC-S7-04/05：点击已读 → 刷新保持、切空间回来仍在；反向断言服务端零新行）。
 * cursor = 连续已读游标（历史键 legion.notify.read.<scope>，旧数据继续生效）；
 * ids   = 显式已读 seq 集合（P2-4 新增键 legion.notify.readseq.<scope>，支持非连续批量已读）。
 */
export function notifyReadState(scope: string | null): NotifyReadState {
  const raw = Number(localStorage.getItem(notifyReadKey(scope)) ?? 0)
  const cursor = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
  let ids: number[] = []
  try {
    const parsed = JSON.parse(localStorage.getItem(notifyReadIdsKey(scope)) ?? '[]') as unknown
    if (Array.isArray(parsed)) ids = parsed.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
  } catch {
    ids = [] // 损坏值 → 视为无显式已读，不崩溃
  }
  return normalizeReadState({ cursor, ids })
}

/** 写回已读状态（只写本机 localStorage；游标单调、集合规范化）。 */
export function saveNotifyReadState(scope: string | null, state: NotifyReadState): void {
  const norm = normalizeReadState(state)
  localStorage.setItem(notifyReadKey(scope), String(norm.cursor))
  if (norm.ids.length > 0) localStorage.setItem(notifyReadIdsKey(scope), JSON.stringify(norm.ids))
  else localStorage.removeItem(notifyReadIdsKey(scope))
}

/**
 * 已读游标读取（历史导出，保留兼容）。
 * 「已读」是纯本地语义：绝不写 audit、绝不新增写接口（TC-S7-04/05）。
 */
export function notifyReadSeq(scope: string | null): number {
  return notifyReadState(scope).cursor
}

/** 已读游标推进（单调递增：只把游标推到「已点开的最后一条 seq」，只写 localStorage）。
 *  游标仅本机有效、跨标签页/跨浏览器不同步（R-15 v1 接受；需服务端已读持久时走 J8-B）。 */
export function setNotifyReadSeq(scope: string | null, seq: number): void {
  saveNotifyReadState(scope, applyMarkRead(notifyReadState(scope), [seq]))
}

/** 单条/批量标记已读（P2-4：批量 = 传入多个 seq；压实游标后写回）。 */
export function markNotifyRead(scope: string | null, seqs: number[]): NotifyReadState {
  const next = applyMarkRead(notifyReadState(scope), seqs)
  saveNotifyReadState(scope, next)
  return next
}

/** 全部已读（把游标推进到给定的最大 seq；不回退）。 */
export function markAllNotifyRead(scope: string | null, maxSeq: number): NotifyReadState {
  const next = applyMarkAllRead(notifyReadState(scope), maxSeq)
  saveNotifyReadState(scope, next)
  return next
}

/** 通知未读计数：白名单内且未读（侧栏 badge 与通知面板共用同一口径）。 */
export function countNotifyUnread(rows: NotifyRow[], scope: string | null): number {
  const state = notifyReadState(scope)
  let n = 0
  for (const row of rows) {
    if (isNotifyAction(row.action) && !isSeqRead(row.seq, state)) n += 1
  }
  return n
}

/** 通知项未读数（列表已是 NotifyItem 时用，避免重复判定）。 */
export function countUnreadItems(items: NotifyItem[]): number {
  return unreadCount(items)
}

/** 测试/调试用：清空某空间的已读状态（生产代码不调用）。 */
export function resetNotifyRead(scope: string | null): void {
  saveNotifyReadState(scope, EMPTY_READ_STATE)
}

// ============================================================================
// 模型与密钥配置的客户端（PRT-501 / 502 / 504 / 506 / 507 / 508）
//
// ## 这一层此前**完全不存在**
//
// 后端把这六件事都做完了：模型档案 CRUD、岗位绑定与 fallback、连通性探测、
// 非敏感配置迁移、配置导入导出。而前端**一个客户端函数都没有**——
// 也就是说这些功能从界面上**一次都调不到**。
//
// 这与 PRT-507 查到的"PRT-504 没有任何非测试调用方"是同一种形态：
// **功能在、测试在、文档在，而没有任何入口。**
//
// ## 路径一律写成字面量
//
// 不是风格问题：`scripts/prt/` 有一个套件会把这里的路径拿去与平台契约基线
// （`prt-007-baseline.json`，由源码抽取）比对。用模板拼接或常量会让**整条**
// 路由从比对里消失——那正是 PRT-507 在服务端踩过的坑
// （用 `MODEL_PREFIX` 常量写守卫，路由对契约基线不可见，基线照样报"一致"）。
// ============================================================================

/** 一个模型档案（对外的 descriptor 形态，**不含** secretRef 的值）。 */
export interface HubModelProfile {
  id: string
  displayName: string
  runtimeType: string
  provider: string
  model: string
  endpoint: string | null
  reasoningEffort?: string
  limits?: Record<string, unknown>
  /** 只暴露「有无凭证」，不暴露引用名本身。 */
  hasCredential?: boolean
  version?: number
  updatedAtMs?: number
}

/** 岗位模型绑定（PRT-502）：`(scope, 岗位) → 主档案 + fallback 链`。 */
export interface HubModelBinding {
  scope: string
  employeeRole: string
  primaryProfile: string
  fallbackProfiles: string[]
  perRunBudget?: unknown
}

/** 一份迁移计划（PRT-506）。注意 `ok` 说的是"这份计划能不能执行"。 */
export interface HubMigrationPlan {
  ok: boolean
  code: string
  message: string | null
  toCreate: HubModelProfile[]
  toBind: Array<{ scope: string; employeeRole: string; primaryProfile: string; fallbackProfiles: string[] }>
  needsAttention: Array<{ id: string; missing: string[]; why: string }>
  skipped: Array<Record<string, unknown>>
  refused: Array<Record<string, unknown>>
  conflicts: Array<Record<string, unknown>>
  empty: boolean
  hasAttention: boolean
  digest: string
}

/** 通用 JSON 请求。**写请求都带 20s 超时**（与 hubPost 一致：界面不能无感卡住）。 */
async function hubRequest(method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20_000)
  let res: Response
  try {
    res = await fetch(`${hubBase()}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      ...(body === undefined ? {} : { body: JSON.stringify({ ...body, by: body.by ?? 'general' }) }),
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
    let parsed: unknown = null
    try { parsed = text ? JSON.parse(text) : null } catch { parsed = null }
    throw hubErrorFromBody(res.status, text, parsed)
  }
  return res.json().catch(() => undefined)
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? v as T[] : []
}

// ── 模型档案（PRT-501）────────────────────────────────────────────────────

/** 模型档案列表。默认**不含**墓碑：`includeDeleted` 要显式给，否则界面上会出现选不了的模型。 */
export async function fetchModelProfiles(opts: { includeDeleted?: boolean } = {}): Promise<HubModelProfile[]> {
  const qs = opts.includeDeleted ? '?includeDeleted=1' : ''
  const data = await hubGet(`/api/model-profiles${qs}`).then((r) => readJson<{ profiles?: HubModelProfile[] }>(r))
  return asArray<HubModelProfile>(data?.profiles)
}

export function createModelProfile(profile: Record<string, unknown>, actor: string): Promise<unknown> {
  return hubPost('/api/model-profiles', { profile, actor })
}

/** 改档案。**必须给 version**——服务端用它做 CAS，不给会 400 而不是"改最后一版"。 */
export function updateModelProfile(id: string, profile: Record<string, unknown>, version: number, actor: string): Promise<unknown> {
  return hubRequest('PUT', `/api/model-profiles/${encodeURIComponent(id)}`, { profile, version, actor })
}

export function deleteModelProfile(id: string, version: number, actor: string): Promise<unknown> {
  return hubRequest('DELETE', `/api/model-profiles/${encodeURIComponent(id)}`, { version, actor })
}

/**
 * 测试连接（PRT-507）。
 *
 * `force` 默认 **true**：这是用户主动按下的按钮。回一个缓存里的旧结论会让用户
 * 以为"刚才那次点击验证了现在"。缓存的价值在于**自动**重复检查，不在于回应一次点击。
 *
 * 失败时抛 `HubError`；其中 `status === 503` 表示**这次没有探测过**
 * （密钥库打不开 / 布局不合法 / 没填 endpoint）——**那不是"连不上"**，
 * 调用方必须分开渲染（见 `modelSettings.ts` 的 `probeBadge`）。
 */
export function probeModelProfile(
  id: string,
  opts: { force?: boolean; requiredCapabilities?: string[] } = {},
): Promise<unknown> {
  return hubPost(`/api/model-profiles/${encodeURIComponent(id)}/probe`, {
    force: opts.force !== false,
    requiredCapabilities: opts.requiredCapabilities ?? [],
  })
}

// ── 岗位绑定与 fallback（PRT-502）─────────────────────────────────────────

export async function fetchModelBindings(scope?: string | null): Promise<HubModelBinding[]> {
  const qs = scope ? `?scope=${encodeURIComponent(scope)}` : ''
  const data = await hubGet(`/api/model-bindings${qs}`).then((r) => readJson<{ bindings?: HubModelBinding[] }>(r))
  return asArray<HubModelBinding>(data?.bindings)
}

export function saveModelBinding(input: {
  scope: string
  employeeRole: string
  primaryProfile: string
  fallbackProfiles?: string[]
  perRunBudget?: unknown
  actor: string
}): Promise<unknown> {
  return hubPost('/api/model-bindings', {
    scope: input.scope,
    employeeRole: input.employeeRole,
    primaryProfile: input.primaryProfile,
    fallbackProfiles: input.fallbackProfiles ?? [],
    perRunBudget: input.perRunBudget ?? null,
    actor: input.actor,
  })
}

/** 「这个岗位现在该依次用哪些模型，为什么」。没有绑定时服务端回 404（不是空链）。 */
export function resolveModelBinding(scope: string, role: string): Promise<unknown> {
  return hubGet(`/api/model-bindings/resolve?scope=${encodeURIComponent(scope)}&role=${encodeURIComponent(role)}`)
    .then((r) => readJson<unknown>(r))
}

export function deleteModelBinding(scope: string, role: string, actor: string): Promise<unknown> {
  return hubRequest('DELETE', `/api/model-bindings/${encodeURIComponent(scope)}/${encodeURIComponent(role)}`, { actor })
}

// ── 迁移老配置（PRT-506）──────────────────────────────────────────────────

/**
 * 迁移计划。
 *
 * `runtimeType` 不给时服务端返回 **200 + 一份 `ok:false` 的计划**（说"必须选一种协议"），
 * 不是 400——所以这里**不把缺参数当异常**：那正是界面要渲染的第一件事。
 */
export async function fetchMigrationPlan(runtimeType?: string): Promise<{
  plan: HubMigrationPlan
  summary: string
  legacyRowCount: number
}> {
  const qs = runtimeType ? `?runtimeType=${encodeURIComponent(runtimeType)}` : ''
  return hubGet(`/api/model-migration/plan${qs}`).then((r) =>
    readJson<{ plan: HubMigrationPlan; summary: string; legacyRowCount: number }>(r))
}

/**
 * 执行迁移。
 *
 * **必须回传用户确认过的 `expectedDigest`**：服务端会重新算一遍计划并要求两者一致，
 * 不一致报 409（`MIGRATION_PLAN_STALE`）。不回传就等于跳过这道对齐——
 * 服务端允许 `null`，但那意味着"执行一份用户可能没看过的计划"。
 */
export function applyMigration(input: {
  runtimeType: string
  expectedDigest: string
  actor: string
}): Promise<unknown> {
  return hubPost('/api/model-migration/apply', {
    runtimeType: input.runtimeType,
    expectedDigest: input.expectedDigest,
    actor: input.actor,
  })
}

// ── 配置导入导出（PRT-508）────────────────────────────────────────────────

export async function fetchConfigBundle(kind: 'full' | 'model-profiles' | 'model-bindings' = 'full'): Promise<unknown> {
  const qs = kind === 'full' ? '' : `?kind=${encodeURIComponent(kind)}`
  return hubGet(`/api/config-bundle${qs}`).then((r) => readJson<unknown>(r))
}

/** 计划导入。只读地算出"会发生什么"，**不写库**。 */
export function planConfigBundle(bundle: unknown, conflictPolicy: 'fail' | 'skip' | 'overwrite', actor: string): Promise<unknown> {
  return hubPost('/api/config-bundle/plan', { bundle, conflictPolicy, actor })
}

export function applyConfigBundle(bundle: unknown, conflictPolicy: 'fail' | 'skip' | 'overwrite', actor: string): Promise<unknown> {
  return hubPost('/api/config-bundle/apply', { bundle, conflictPolicy, actor })
}
