// workbench/src/identity.ts
// ============================================================================
// 指挥台的账号会话（远程 Agent 通道 S-B 的**浏览器侧**）
//
// ## 两种令牌，两个 localStorage 键，**不混用**
//
// `legion.workbench.token` 是「你是这台机器上的 Legion 组件」（机器令牌，
// 由 `serve.mjs --token` 或桌面启动器写进去）；本模块管的是
// **「你是谁」**（用户访问令牌，从 `/api/identity/login` 换来）。
//
// `routes/identity.mjs` 的开头把这条边界写得很清楚：
//
//   > 用一个机器令牌去看"我的会话"是没有意义的问题，
//   > 放行只会让审计里出现一个说不清主体是谁的主语。
//
// 把两者塞进**同一个键**的版本平时也能跑，它的代价在排障时才显形：
// 一个 401 摆在你面前，而"现在那个键里装的到底是哪一种令牌"无人能答。
// 所以分开放，并在 `api.ts` 的 `authHeaders()` 里**用户令牌优先**。
//
// ## 访问令牌进 sessionStorage，刷新凭据进 localStorage
//
// 与手机端同一条纪律：关掉标签页就等于"我走了"，而刷新凭据留着，
// 用户自己重开时无感续期。借来的电脑上，"我关掉了页面"应该真的等于
// "别人打不开"——放在 localStorage 里做不到这一点。
//
// ## 只在 Hub **要求**时才拦
//
// 判据是能力发现里的 `remoteAuthRequired`，不是"能不能登录"。本机单机部署
// （`LEGION_REMOTE_AUTH` 没开）时它是 false，指挥台就不该多出一道登录墙——
// 那会把人挡在一个他本来就有权进的地方之外。
// ============================================================================

/** 用户访问令牌（短时）。放 sessionStorage。 */
const SS_ACCESS = 'legion.identity.access'
/** 刷新凭据（长时可撤销）。放 localStorage。 */
const LS_REFRESH = 'legion.identity.refresh'
/** 上一次用过的用户名：只用来预填，**不是**凭据。 */
const LS_LAST_NAME = 'legion.identity.name'

export interface IdentityStatus {
  ok: boolean
  /** Hub 是否配好了身份体系（没配 = 没有账号可登）。 */
  enabled: boolean
  /** 库里有没有第一个用户。false 时该显示"首次初始化"。 */
  bootstrapped: boolean
  /** Hub 是否要求远程鉴权。**只有它才是"要不要弹登录页"的判据。** */
  remoteAuthRequired: boolean
  /** 注册策略。老 Hub 不带这个字段 → 按 closed 处理。 */
  registration: 'closed' | 'invite' | 'open'
}

export interface Session {
  accessToken: string
  refreshToken: string
}

export interface MeInfo {
  userId: string
  name: string
  roles: Array<{ space: string; role: string }>
  systemRole: 'admin' | 'none'
}

/** 请求失败时带上服务端的具名码，前端据此分支（过期→刷新；撤销→重新登录）。 */
export class IdentityRequestError extends Error {
  code: string | null
  status: number
  constructor(message: string, code: string | null, status: number) {
    super(message)
    this.name = 'IdentityRequestError'
    this.code = code
    this.status = status
  }
}

/**
 * Hub 地址。与 `api.ts` 的 `hubBase()` 同一条规则（`?hub=` > localStorage > `/hub`），
 * 但**不复用那个函数**：本模块要能在 `api.ts` 之外被调用（登录页在 App 挂载前
 * 就要能发起请求），而 `api.ts` 的依赖面比这里大得多。
 */
function hubBase(): string {
  const fromQuery = new URLSearchParams(window.location.search).get('hub')
  if (fromQuery) return fromQuery.replace(/\/+$/, '')
  return localStorage.getItem('legion.workbench.hub') ?? '/hub'
}

export function getAccessToken(): string {
  try { return sessionStorage.getItem(SS_ACCESS) ?? '' } catch { return '' }
}

export function getRefreshToken(): string {
  try { return localStorage.getItem(LS_REFRESH) ?? '' } catch { return '' }
}

export function saveSession(session: Session): void {
  try {
    sessionStorage.setItem(SS_ACCESS, session.accessToken)
    localStorage.setItem(LS_REFRESH, session.refreshToken)
  } catch { /* 隐私模式禁写存储：退化成"这一次有效"，不阻断登录 */ }
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(SS_ACCESS)
    localStorage.removeItem(LS_REFRESH)
  } catch { /* 同上 */ }
}

export function hasSession(): boolean {
  return getAccessToken().length > 0 || getRefreshToken().length > 0
}

export function lastName(): string {
  try { return localStorage.getItem(LS_LAST_NAME) ?? '' } catch { return '' }
}

export function rememberName(name: string): void {
  try { localStorage.setItem(LS_LAST_NAME, name) } catch { /* 同上 */ }
}

/** 统一的 POST：把服务端的 `{ok:false, code, error}` 翻成带码的异常。 */
async function postJson<T>(path: string, body: unknown, { token = '' } = {}): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token.length > 0) headers.authorization = `Bearer ${token}`
  let res: Response
  try {
    res = await fetch(`${hubBase()}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  } catch (e) {
    throw new IdentityRequestError(`无法连接 Hub：${e instanceof Error ? e.message : String(e)}`, 'HUB_UNREACHABLE', 0)
  }
  const text = await res.text()
  let json: Record<string, unknown> | null = null
  try { json = text.length > 0 ? JSON.parse(text) as Record<string, unknown> : null } catch { /* 非 JSON */ }
  if (!res.ok || json?.ok !== true) {
    const message = typeof json?.error === 'string' ? json.error : `请求失败（HTTP ${res.status}）`
    const code = typeof json?.code === 'string' ? json.code : null
    throw new IdentityRequestError(message, code, res.status)
  }
  return json as T
}

async function getJson<T>(path: string, { token = '' } = {}): Promise<T> {
  const headers: Record<string, string> = {}
  if (token.length > 0) headers.authorization = `Bearer ${token}`
  let res: Response
  try {
    res = await fetch(`${hubBase()}${path}`, { headers })
  } catch (e) {
    throw new IdentityRequestError(`无法连接 Hub：${e instanceof Error ? e.message : String(e)}`, 'HUB_UNREACHABLE', 0)
  }
  const text = await res.text()
  let json: Record<string, unknown> | null = null
  try { json = text.length > 0 ? JSON.parse(text) as Record<string, unknown> : null } catch { /* 非 JSON */ }
  if (!res.ok || json?.ok !== true) {
    const message = typeof json?.error === 'string' ? json.error : `请求失败（HTTP ${res.status}）`
    const code = typeof json?.code === 'string' ? json.code : null
    throw new IdentityRequestError(message, code, res.status)
  }
  return json as T
}

/**
 * 能力发现。**不带令牌**——它要回答的正是"这里要不要登录"。
 *
 * 拿不到时返回一个保守的默认值（`enabled:false`）：一个探测失败就弹登录墙的
 * 指挥台，会在 Hub 暂时不可达时把用户挡在一个他本来能进的地方外面。
 * 真正的 401 会由 `api.ts` 那边的调用如实报出来。
 */
export async function probeIdentity(): Promise<IdentityStatus> {
  const fallback: IdentityStatus = {
    ok: false, enabled: false, bootstrapped: false, remoteAuthRequired: false, registration: 'closed',
  }
  try {
    const r = await getJson<Partial<IdentityStatus>>('/api/identity/status')
    return {
      ok: true,
      enabled: r.enabled === true,
      bootstrapped: r.bootstrapped === true,
      remoteAuthRequired: r.remoteAuthRequired === true,
      registration: r.registration === 'open' || r.registration === 'invite' ? r.registration : 'closed',
    }
  } catch { return fallback }
}

export async function login(name: string, password: string): Promise<Session & MeInfo> {
  const r = await postJson<{ accessToken: string; refreshToken: string; userId: string; name: string; roles?: MeInfo['roles']; systemRole?: MeInfo['systemRole'] }>(
    '/api/identity/login',
    { name, password, label: browserLabel() },
  )
  rememberName(name)
  return {
    accessToken: r.accessToken, refreshToken: r.refreshToken,
    userId: r.userId, name: r.name,
    roles: r.roles ?? [], systemRole: r.systemRole ?? 'none',
  }
}

/**
 * 注册并直接登录。
 *
 * 与手机端同一条纪律：注册与发会话在服务端是**一个**事务性动作，
 * 分成两步会留下"账号存在但我进不去"的中间态——而用户会以为注册失败，
 * 换个名字再来一遍，然后两个账号都在。
 */
export async function register(input: { name: string; password: string; /** 留空 = 让服务端解析（只有一个空间时它自己选，多个时具名拒绝）。 */ space?: string; code?: string }): Promise<Session & MeInfo> {
  const r = await postJson<{ accessToken: string; refreshToken: string; userId: string; name: string; roles?: MeInfo['roles']; systemRole?: MeInfo['systemRole'] }>(
    '/api/identity/register',
    { ...input, label: browserLabel() },
  )
  rememberName(input.name)
  return {
    accessToken: r.accessToken, refreshToken: r.refreshToken,
    userId: r.userId, name: r.name,
    roles: r.roles ?? [], systemRole: r.systemRole ?? 'none',
  }
}

/** 换新令牌。**轮换**刷新凭据（服务端会作废旧的那个）。 */
export async function refreshSession(): Promise<Session | null> {
  const refreshToken = getRefreshToken()
  if (refreshToken.length === 0) return null
  try {
    const r = await postJson<{ accessToken: string; refreshToken: string }>('/api/identity/refresh', { refreshToken })
    const session = { accessToken: r.accessToken, refreshToken: r.refreshToken }
    saveSession(session)
    return session
  } catch {
    // 刷新失败 = 会话确实没了（撤销或过期）。**不**在这里 clear：
    // 调用方可能还要拿错误码去决定措辞。
    return null
  }
}

// ── 会话失效的处理 ──────────────────────────────────────────────────────────

type ExpiredHandler = () => void
let expiredHandler: ExpiredHandler | null = null

/**
 * 注册"会话彻底没了"的处理器。由 `App` 挂在登录页上。
 *
 * 为什么需要它：访问令牌只有 15 分钟。一个开着指挥台的人，过一会儿再点任何东西
 * 都会拿到 401——而**界面上没有任何地方能让他重新登录**，除非他手动清掉
 * localStorage。那是个死胡同，而它只在"用了一会儿"之后才出现。
 */
export function setSessionExpiredHandler(fn: ExpiredHandler | null): void {
  expiredHandler = fn
}

/**
 * 单飞（single-flight）的会话恢复。
 *
 * 「单飞」在这里不是优化，是**正确性**：指挥台首屏会同时发出十几个请求
 * （board / missions / roster / activity / spaces…）。它们会**同时**拿到 401，
 * 于是十几路各自去打一次刷新——而刷新凭据是**轮换**的（服务端作废旧的那个），
 * 后到的那些必然失败，把一次本来能救回来的会话砸成"会话已被撤销"。
 *
 * 所以：同一时刻只允许一次刷新，其余的在同一个 Promise 上排队。
 */
let recovery: Promise<boolean> | null = null

export async function recoverSession(): Promise<boolean> {
  if (getRefreshToken().length === 0) return false
  if (recovery !== null) return recovery
  recovery = (async () => {
    try {
      const session = await refreshSession()
      if (session !== null) return true
      // 刷新失败：会话真的没了。清干净并通知上层回登录页——
      // 留着半个会话只会让每一个后续请求继续 401。
      clearSession()
      expiredHandler?.()
      return false
    } finally {
      recovery = null
    }
  })()
  return recovery
}

export async function fetchMe(): Promise<MeInfo> {
  const r = await getJson<{ user: { userId: string; name: string }; roles?: MeInfo['roles']; systemRole?: MeInfo['systemRole'] }>(
    '/api/identity/me', { token: getAccessToken() },
  )
  return {
    userId: r.user.userId, name: r.user.name,
    roles: r.roles ?? [], systemRole: r.systemRole ?? 'none',
  }
}

export async function logout(): Promise<void> {
  try { await postJson('/api/identity/logout', {}, { token: getAccessToken() }) } catch { /* 登出失败也要清本地 */ }
  clearSession()
}

export interface SessionRow {
  sessionId: string
  label: string
  createdAt: string
  lastSeenAt: string | null
  revoked: boolean
}

export async function listSessions(): Promise<{ sessions: SessionRow[]; currentSessionId: string | null }> {
  const r = await getJson<{ sessions?: SessionRow[]; currentSessionId?: string }>('/api/identity/sessions', { token: getAccessToken() })
  return { sessions: r.sessions ?? [], currentSessionId: r.currentSessionId ?? null }
}

export async function revokeSession(sessionId: string): Promise<void> {
  await postJson('/api/identity/sessions/revoke', { sessionId }, { token: getAccessToken() })
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<{ revokedOtherSessions: number }> {
  const r = await postJson<{ revokedOtherSessions?: number }>(
    '/api/identity/password', { currentPassword, newPassword }, { token: getAccessToken() },
  )
  return { revokedOtherSessions: r.revokedOtherSessions ?? 0 }
}

export async function createInvite(space: string, role: string): Promise<string> {
  const r = await postJson<{ code?: string }>('/api/identity/invites', { space, role }, { token: getAccessToken() })
  return r.code ?? ''
}

// ── 设备（执行节点）────────────────────────────────────────────────────────
//
// ## 为什么这一节必须存在，而不只是"顺手加个列表"
//
// 在这之前，**把一台电脑接到 Hub 上只有一条路**：在服务器上跑
// `product/server/make-pairing-code.sh`。也就是说，一个刚在手机上注册完的用户
// **没有任何办法**让自己电脑上的 Legion 连上来——他能看见空间、能看见 Agent，
// 而任务永远停在"等电脑领取"，界面上的措辞还是对的。
//
//   > 一个"能注册、能登录、但永远连不上自己电脑"的产品，
//   > 与一个还没做完的产品，在用户那边是同一个东西——
//   > 只不过前者每一步看起来都成功了。

export interface DeviceRow {
  nodeId: string
  name: string
  platform: string
  capabilities: string[]
  createdAt: string
  revoked: boolean
  lastSeenAt: string | null
  presence: { online: boolean; stale?: boolean; lastHeartbeatAt: string | null } | null
}

export async function listDevices(): Promise<DeviceRow[]> {
  const r = await getJson<{ devices?: DeviceRow[] }>('/api/devices', { token: getAccessToken() })
  return r.devices ?? []
}

/**
 * 造一个配对码。**明文只在这里出现一次**（库里只存哈希）。
 *
 * `nodeName` 是给人看的标签（"我的台式机"），它出现在设备列表与会话列表里，
 * 所以要求用户起一个能认得出的名字——而不是默认成某个随机 id，
 * 让"我在撤销哪一台"变成一个要猜的问题。
 */
export async function createPairingCode(nodeName: string): Promise<{ code: string; nodeName: string; expiresAtMs: number }> {
  const r = await postJson<{ code?: string; nodeName?: string; expiresAtMs?: number }>(
    '/api/devices/pairing', { nodeName }, { token: getAccessToken() },
  )
  return { code: r.code ?? '', nodeName: r.nodeName ?? nodeName, expiresAtMs: r.expiresAtMs ?? 0 }
}

export async function revokeDevice(nodeId: string): Promise<void> {
  await postJson('/api/devices/revoke', { nodeId }, { token: getAccessToken() })
}

/** 换设备令牌。**旧令牌当场失效**，那台电脑要用新令牌重连。 */
export async function rotateDeviceToken(nodeId: string): Promise<string> {
  // ★ 字段名是 `deviceToken`（`device-store.mjs` 的 `rotateToken` 返回
  // `{ nodeId, deviceToken }`），不是 `token`。读错名字的后果不是报错，
  // 而是一个**空字符串**——界面上会得到一个空的输入框，
  // 而"令牌是空的"与"令牌没显示出来"看起来一模一样。
  const r = await postJson<{ deviceToken?: string }>('/api/devices/rotate', { nodeId }, { token: getAccessToken() })
  return r.deviceToken ?? ''
}

/** 会话标签：在"登录中的设备"那一列里区分开不同浏览器。 */
function browserLabel(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Chrome\//.test(ua) ? 'Chrome'
      : /Firefox\//.test(ua) ? 'Firefox'
        : /Safari\//.test(ua) ? 'Safari' : '浏览器'
  const platform = typeof navigator === 'undefined' ? '' : (navigator.platform ?? '')
  return `指挥台 · ${browser}${platform ? ` · ${platform}` : ''}`
}
