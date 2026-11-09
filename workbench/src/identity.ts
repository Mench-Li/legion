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

/**
 * 账号本人的**展示信息**（`/api/identity/me` 与资料写接口的 user 字段）。
 *
 * ★ name 与 displayName 是**两个字段**，不得混用：
 *   · name = 登录用户名，唯一、不可改、用于登录与审计 actor；
 *   · displayName = 展示名，非唯一、可改、缺失时回退 name（服务端已回退，
 *     前端仍再兜一次，避免旧 Hub 不带该字段时出现空白）。
 */
export interface AccountUser {
  userId: string
  name: string
  displayName: string
  avatar: string
  createdAt: string
  disabled: boolean
}

export interface MeInfo extends AccountUser {
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

/**
 * 用户访问令牌的形状判据：Hub 签发的是 `v1.<payload>.<sig>`（三段点分，首段字面量 `v1`）。
 *
 * 为什么要在**读**的时候判一次：这个键里曾经装过别的东西——旧版本把机器令牌
 * （48 位 hex）写进了同一个存储位。之后每一次身份请求都把那个值原样发出去，
 * 服务端只能回一句 `IDENTITY_TOKEN_MALFORMED`「访问令牌格式不正确」，
 * 而这句话既不告诉用户"你没登录"，也不告诉开发者"这个值是垃圾"。
 *
 *   现场（2026-11-07）：账号面板两块都是「账号读取失败：访问令牌格式不正确」，
 *   用户以为账号功能坏了；实际是 sessionStorage 里躺着一把不是用户令牌的字符串，
 *   而它不落在可重放的 401 里，页面永远不会自己恢复。
 *
 * 形状不符 ⇒ 当作"没有令牌"处理并顺手清掉：把垃圾送去服务端，
 * 换回来的只会是诊断噪声，而不是数据。
 */
function looksLikeAccessToken(raw: string): boolean {
  return /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(raw)
}

export function getAccessToken(): string {
  try {
    const raw = sessionStorage.getItem(SS_ACCESS) ?? ''
    if (raw.length === 0) return ''
    if (looksLikeAccessToken(raw)) return raw
    sessionStorage.removeItem(SS_ACCESS)
    return ''
  } catch { return '' }
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
    // 登录响应只带登录名（旧 Hub 也可能只回这些）；账号页另走 fetchMe 取完整资料。
    displayName: r.name, avatar: '', createdAt: '', disabled: false,
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
    // 登录响应只带登录名（旧 Hub 也可能只回这些）；账号页另走 fetchMe 取完整资料。
    displayName: r.name, avatar: '', createdAt: '', disabled: false,
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
  // ★ 没有刷新凭据时，**也必须清掉那把已经作废的访问令牌**。
  //
  //   从前这里直接 `return false`，把死掉的访问令牌留在 sessionStorage 里；
  //   之后每一次请求都带着同一个失效凭据再 401 —— 而调用方（App 的看板加载循环）
  //   把 401 当成"中枢不可达"每 5 秒重连一次，于是页面永远转圈、永远同一条红。
  //   现场（2026-10-30）：访问令牌 19:14 过期，refresh 已被轮换掉，页面挂了一夜。
  //
  //   清掉之后重放会用机器令牌（本机部署）⇒ 立刻有数据；远端 Hub 则拿到一次
  //   干净的 401，由上面按"凭据过期"处理，而不是无限重连。
  if (getRefreshToken().length === 0) {
    if (getAccessToken().length > 0) {
      clearSession()
      expiredHandler?.()
    }
    return false
  }
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

/**
 * 身份读/资料写的**窄条件** 401 重放。
 *
 * ## 为什么 `identity.ts` 自己需要它
 *
 * `api.ts` 的 `fetchWithSessionRetry` 只覆盖业务数据请求；账号页直接调用本模块，
 * 而访问令牌只有 15 分钟。没有这层时，一个开着页面的用户过一会儿点"刷新"会看到
 * "账号读取失败"，而真正要做的那件事（刷新令牌）在屏幕上根本没发生。
 *
 * ## 只重放一次，且**只**在真正过期的码上
 *
 *   · 无限重试会在"刷新成功但立刻又过期"（例如服务端时钟不对）时打成死循环；
 *   · `IDENTITY_WRONG_PASSWORD` 也是 401，但它必须原样提示"当前口令不正确"，
 *     不能触发刷新——否则用户要等一次注定失败的令牌轮换才知道口令错了；
 *   · `IDENTITY_SESSION_REVOKED` 同理：刷新救不回来，只会多打一次请求。
 *
 * `/api/identity/refresh` 与 `/api/identity/login` 显式排除（前者会递归，
 * 后者根本没有旧令牌可续）。
 */
const REPLAYABLE_401 = new Set(['IDENTITY_TOKEN_EXPIRED', 'IDENTITY_TOKEN_MISSING', 'IDENTITY_TOKEN_MALFORMED'])

async function withSessionRetry<T>(path: string, attempt: (token: string) => Promise<T>): Promise<T> {
  const isAuthPath = path === '/api/identity/refresh' || path === '/api/identity/login'
  // ★ 手上没有可用的访问令牌、但还有刷新凭据：**先换再发**。
  //
  //   不这么做的话，空令牌换来的是 `REMOTE_AUTH_MISSING`（网关层的"缺少访问令牌"），
  //   它不在下面的可重放集合里 ⇒ 直接抛给界面 ⇒ 用户看到一句他无法处理的错误，
  //   而真正该发生的那件事（拿 refresh 换新令牌）根本没发生。
  if (!isAuthPath && getAccessToken().length === 0 && getRefreshToken().length > 0) {
    await recoverSession()
  }
  // 换完仍然没有令牌：这是一次**没有会话**的调用，说人话。
  // 不抛原始服务端错误，是因为"格式不正确"对用户没有任何可执行含义。
  if (!isAuthPath && getAccessToken().length === 0) {
    throw new IdentityRequestError('登录已过期，请重新登录', 'IDENTITY_NO_SESSION', 401)
  }
  try {
    return await attempt(getAccessToken())
  } catch (e) {
    const replayable = e instanceof IdentityRequestError
      && e.status === 401
      && e.code !== null
      && REPLAYABLE_401.has(e.code)
    if (!replayable) throw e
    if (path === '/api/identity/refresh' || path === '/api/identity/login') throw e
    if (getRefreshToken().length === 0) throw e
    const recovered = await recoverSession()
    if (!recovered) throw e
    return attempt(getAccessToken())
  }
}

export async function fetchMe(): Promise<MeInfo> {
  const r = await withSessionRetry('/api/identity/me', (token) => getJson<{
    user?: { userId?: string; name?: string; displayName?: string; avatar?: string; createdAt?: string; disabled?: boolean }
    roles?: MeInfo['roles']
    systemRole?: MeInfo['systemRole']
  }>('/api/identity/me', { token }))
  const u = r.user ?? {}
  const name = typeof u.name === 'string' ? u.name : ''
  const display = typeof u.displayName === 'string' ? u.displayName.trim() : ''
  return {
    userId: typeof u.userId === 'string' ? u.userId : '',
    name,
    // 旧 Hub 不带 displayName（或返回空白）时回退登录用户名，永远不显示空白。
    displayName: display.length > 0 ? display : name,
    avatar: typeof u.avatar === 'string' ? u.avatar : '',
    createdAt: typeof u.createdAt === 'string' ? u.createdAt : '',
    disabled: u.disabled === true,
    roles: r.roles ?? [], systemRole: r.systemRole === 'admin' ? 'admin' : 'none',
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
  const r = await withSessionRetry('/api/identity/sessions', (token) => getJson<{ sessions?: SessionRow[]; currentSessionId?: string }>(
    '/api/identity/sessions', { token },
  ))
  return { sessions: r.sessions ?? [], currentSessionId: r.currentSessionId ?? null }
}

export async function revokeSession(sessionId: string): Promise<void> {
  await withSessionRetry('/api/identity/sessions/revoke', (token) => postJson('/api/identity/sessions/revoke', { sessionId }, { token }))
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<{ revokedOtherSessions: number }> {
  const r = await withSessionRetry('/api/identity/password', (token) => postJson<{ revokedOtherSessions?: number }>(
    '/api/identity/password', { currentPassword, newPassword }, { token },
  ))
  return { revokedOtherSessions: r.revokedOtherSessions ?? 0 }
}

/**
 * 更新**本人**资料（P0 只有 displayName）。
 *
 * 返回服务端最终投影：并发保存是"后写覆盖"，页面必须以它回填，
 * 不能假设本地草稿一定生效。错误按 IdentityRequestError.code 分支。
 */
export async function updateProfile(input: { displayName: string }): Promise<AccountUser> {
  const r = await withSessionRetry('/api/identity/profile', (token) => postJson<{ user?: Partial<AccountUser> }>(
    '/api/identity/profile', { displayName: input.displayName }, { token },
  ))
  const u = r.user ?? {}
  const name = typeof u.name === 'string' ? u.name : ''
  const display = typeof u.displayName === 'string' ? u.displayName.trim() : ''
  return {
    userId: typeof u.userId === 'string' ? u.userId : '',
    name,
    displayName: display.length > 0 ? display : name,
    avatar: typeof u.avatar === 'string' ? u.avatar : '',
    createdAt: typeof u.createdAt === 'string' ? u.createdAt : '',
    disabled: u.disabled === true,
  }
}

export async function createInvite(space: string, role: string): Promise<string> {
  const r = await postJson<{ code?: string }>('/api/identity/invites', { space, role }, { token: getAccessToken() })
  return r.code ?? ''
}

/**
 * 口令重置。**只有系统管理员能签发**——它是一条能接管账号的凭据。
 *
 * ## 为什么必须有它
 *
 * 在此之前，全仓只有自助改口令（要记得原口令）。忘了口令 = 账号报废。
 * 自托管的 Hub 没有邮件通道，所以恢复走**带外**：管理员生成一次性码，
 * 自己想办法给到用户。
 *
 *   > 一个"忘了口令就只能把库推倒重来"的账号体系，
 *   > 与一个"还没有账号体系"的系统，在用户丢掉口令那天是同一个东西。
 */
export async function createPasswordReset(userId: string): Promise<{ code: string; userName: string; expiresAtMs: number }> {
  const r = await postJson<{ code?: string; userName?: string; expiresAtMs?: number }>(
    '/api/identity/password/reset-code', { userId }, { token: getAccessToken() },
  )
  return { code: r.code ?? '', userName: r.userName ?? '', expiresAtMs: r.expiresAtMs ?? 0 }
}

/**
 * 用管理员给的**一次性重置码**设新口令。免登录。
 *
 * 返回一个会话：与注册同一条理由——他刚设完口令，再让他打一遍是最容易放弃的
 * 一步，而在手机上尤其如此。
 */
export async function redeemPasswordReset(input: { name: string; code: string; newPassword: string }): Promise<Session & MeInfo> {
  const r = await postJson<{ accessToken: string; refreshToken: string; userId: string; name: string; roles?: MeInfo['roles']; systemRole?: MeInfo['systemRole'] }>(
    '/api/identity/password/reset',
    { ...input, label: browserLabel() },
  )
  rememberName(r.name)
  return {
    accessToken: r.accessToken, refreshToken: r.refreshToken,
    userId: r.userId, name: r.name,
    // 登录响应只带登录名（旧 Hub 也可能只回这些）；账号页另走 fetchMe 取完整资料。
    displayName: r.name, avatar: '', createdAt: '', disabled: false,
    roles: r.roles ?? [], systemRole: r.systemRole ?? 'none',
  }
}

export interface UserRow {
  userId: string
  name: string
  /** 显示名（服务端 publicUser 投影；旧 Hub 可能没有）。列表用「显示名（用户名）」消歧。 */
  displayName?: string
  avatar?: string
  createdAt?: string
  systemRole: string
  disabled: boolean
}

export async function listUsers(): Promise<UserRow[]> {
  const r = await getJson<{ users?: UserRow[] }>('/api/identity/users', { token: getAccessToken() })
  return r.users ?? []
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
  /** 设备归属。管理员调用 /api/devices 会拿到**全部**设备，计数必须按它过滤。 */
  userId?: string
  name: string
  platform: string
  capabilities: string[]
  createdAt: string
  revoked: boolean
  lastSeenAt: string | null
  presence: { online: boolean; stale?: boolean; lastHeartbeatAt: string | null } | null
}

export async function listDevices(): Promise<DeviceRow[]> {
  const r = await withSessionRetry('/api/devices', (token) => getJson<{ devices?: DeviceRow[] }>('/api/devices', { token }))
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
