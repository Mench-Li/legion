import type { ActivityEvent, AgentCatalogItem, AgentModelCfg, ApiConfig, BoardData, CardStatus, ChatConversation, ChatMessage, DirListing, FileListResponse, FilePreview, GoalInfo, HubActivity, HubAuditEvent, HubTask, MissionsResponse, ModelOption, RepoInspect, RosterResponse, SkillInfo, SpaceInfo, WebFetchResult } from './types'

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

/** team-hub v2：读取指定空间目标（objective + 该空间任务进度）。 */
export async function fetchGoal(scope: string | null): Promise<GoalInfo> {
  const qs = scope ? `?scope=${encodeURIComponent(scope)}` : ''
  return readJson<GoalInfo>(await fetch(`${hubBase()}/api/goal${qs}`))
}

/** team-hub v2：发布空间目标（upsert 该空间 objective）。 */
export function publishGoal(scope: string, objective: string): Promise<unknown> {
  return hubPost('/api/goal', { scope, objective })
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

/** team-hub v2：某空间/某任务的审计时间线（进展历史）。taskId 优先，其次 scope。 */
export async function fetchHubActivity(opts: { scope?: string | null; taskId?: string } = {}): Promise<HubActivity[]> {
  const qs = new URLSearchParams()
  if (opts.taskId) qs.set('taskId', opts.taskId)
  else if (opts.scope) qs.set('scope', opts.scope)
  if (qs.size === 0) qs.set('limit', '100')
  return readJson<HubActivity[]>(await fetch(`${hubBase()}/api/activity?${qs.toString()}`))
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

async function hubPost(path: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${hubBase()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ ...body, by: body.by ?? 'general' }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${res.status}${text ? `：${text}` : ''}`)
  }
  return res.json().catch(() => undefined)
}

/** team-hub v2：技能列表。includePending=true 时含待审/被拒（复审者视角）。 */
export async function fetchSkills(opts: { scope?: string | null; includePending?: boolean } = {}): Promise<SkillInfo[]> {
  const qs = new URLSearchParams()
  if (opts.scope) qs.set('scope', opts.scope)
  if (opts.includePending) qs.set('include', 'pending')
  return readJson<SkillInfo[]>(await fetch(`${hubBase()}/api/skills${qs.size ? `?${qs.toString()}` : ''}`))
}

/** team-hub v2：提交技能（新技能/内容变更 → pending 待复审，不自动发布）。 */
export function registerSkill(input: {
  id: string
  name: string
  description?: string
  prompt?: string
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

/** team-hub v2：发消息（body 校验在后端：kind ∈ text|markdown|system、≤8000 字符、scope=会话 scope）。 */
export function postChatMessage(input: { conv: number; body: string; kind?: string; clientTs?: string }): Promise<ChatMessage> {
  return hubPost('/api/chat/messages', {
    conv: input.conv,
    body: input.body,
    kind: input.kind ?? 'text',
    clientTs: input.clientTs ?? '',
  }).then(res => (res as { task: ChatMessage }).task)
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
