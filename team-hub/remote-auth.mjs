// team-hub/remote-auth.mjs
// ============================================================================
// 远程访问门禁策略（远程 Agent 通道 S-B 之三）
//
// ## 它守的是什么
//
// 部署形态是：Hub 绑 `127.0.0.1`，nginx 提供 TLS 并反代，公网只开 443。
// 在这个形态下 `server.mjs` 里那条既有门禁
//
//     if (readAuthRequired() && path !== '/api/config' && !authorized(req))
//
// **不会生效**——`readAuthRequired()` 的条件是「非回环监听 + 配了 token」，
// 而 Hub 绑的是回环。也就是说：一旦把 nginx 接上，那些为本地开发留的开放读端点
// 会**原样暴露到公网**，而代码里没有任何一处会因此报错。
//
// 这不是假想风险，它是"把本机服务反代出去"的标准翻车方式：在本地测得一切正常
// （因为本来就该正常），上线后所有人可读。
//
// 所以这一层是**独立的、显式的**门禁：`LEGION_REMOTE_AUTH=1` 时，
// 除白名单外的全部 `/api/*` 都要求用户访问令牌。
//
// ## 与 `TEAM_HUB_TOKEN` 的关系
//
// 不替换、不删除。既有令牌继续有效（它保护的是**本机与服务间**那一面：桌面、
// 守护、看板）。两者是并存的两把门：
//
//   · Hub token   = "你是这台机器上的 Legion 组件"（过渡期，机器级）
//   · 用户令牌    = "你是某个用户"（远程面，人级）
//
// 允许 Hub token 通过远程门禁是刻意的：否则过渡期（还没建任何用户）会把
// 自己锁在门外，而"锁在门外"与"配置正确"在监控上看不出区别。
// ============================================================================
import { timingSafeEqual } from 'node:crypto'

/** 远程面允许**匿名**访问的路径。每一条都要能说清"为什么它可以没有身份"。 */
export const PUBLIC_PATHS = Object.freeze(new Set([
  // 能力发现：手机在登录前要知道"这个 Hub 支不支持账号体系、有没有初始化"。
  // 它**不**泄露任何数据，只回布尔与版本。
  '/api/identity/status',
  // 登录与刷新：它们是**取得**身份的地方，不可能要求已有身份。
  '/api/identity/login',
  '/api/identity/refresh',
  // 接受邀请：被邀请的人此刻还没有账号，邀请码本身就是凭据。
  '/api/identity/invites/accept',
  // 注册：与它同一个道理——注册的人此刻还没有账号。
  //
  // ★ 把它放在公开名单里**不等于**开放注册：真正的开关是配置里的
  //   `LEGION_REGISTRATION`（默认 `closed`），由 `routes/identity.mjs` 在
  //   路由里判。门禁与策略是**两件事**，混起来会得到一个很坏的中间态：
  //   为了让"关掉的注册"返回 403 而不是 401，而把它从公开名单里拿掉——
  //   那时用户看到的是"缺少访问令牌"，他会去查登录、而问题在注册策略上。
  '/api/identity/register',
  // 首次初始化：库为空时的唯一入口；非空库时它自己会拒（见 user-store 的
  // `ALREADY_BOOTSTRAPPED`）。它额外要求 Hub 管理令牌，所以不构成公开注册口。
  '/api/identity/bootstrap',
  // 设备配对：配对码本身就是凭据（一次性、短时、限速）。
  '/api/devices/pair',
  // 既有能力探测，本来就免鉴权（见 `server.mjs` 的 P2-2 注释）。
  // 指挥台的 `probeHub()` 不带令牌打它，所以它必须留在这张表里。
  '/api/config',
  // Hub 的**门口**。它必须公开：一个"发个链接给人"的服务，第一次打开时必须
  // 说得出自己是什么。在此之前这里回的是 `{"error":"缺少访问令牌"}`——
  // 那是对机器说的话，而它是每个新用户看到的第一句话。
  '/',
]))

/** 允许把令牌放在查询串里的路径。EventSource 无法自定义请求头。 */
export const QUERY_TOKEN_PATHS = Object.freeze(new Set([
  '/api/events',           // SSE
  '/api/event-delivery',
]))

export const REMOTE_AUTH_CODES = Object.freeze({
  MISSING: 'REMOTE_AUTH_MISSING',
  INVALID: 'REMOTE_AUTH_INVALID',
  EXPIRED: 'REMOTE_AUTH_EXPIRED',
})

const ALLOWED_HEADERS = Object.freeze({ 'www-authenticate': 'Bearer realm="legion-hub"' })

const deny = (status, code, message) => Object.freeze({
  allow: false, status, code, message, headers: ALLOWED_HEADERS,
})
const allow = (actor) => Object.freeze({ allow: true, actor })

const constantTimeEqual = (a, b) => {
  const x = Buffer.from(String(a ?? ''))
  const y = Buffer.from(String(b ?? ''))
  if (x.length === 0 || x.length !== y.length) return false
  return timingSafeEqual(x, y)
}

/**
 * 从请求里取令牌。只在允许的路径上接受查询串形式的令牌。
 *
 * 为什么不是到处都接受 `?token=`：查询串会进访问日志、浏览器历史、Referer。
 * 把它限死在"确实没有别的办法"的 SSE 上，是一个可以解释的边界。
 */
export function extractBearer({ path, headers = {}, searchParams = null, legacyToken = '' } = {}) {
  const headerToken = /^Bearer\s+(.+)$/i.exec(String(headers.authorization ?? ''))?.[1]?.trim() ?? ''
  if (headerToken) return { token: headerToken, source: 'header' }
  if (QUERY_TOKEN_PATHS.has(path)) {
    const q = searchParams?.get?.('token') ?? ''
    if (q) return { token: q.trim(), source: 'query' }
  }
  // 既有的 `x-dsh-token` 头（与 v1 对齐）继续被当作 **Hub token**，不是用户令牌。
  const legacyHeader = String(headers['x-dsh-token'] ?? '').trim()
  if (legacyHeader && legacyToken && constantTimeEqual(legacyHeader, legacyToken)) {
    return { token: legacyHeader, source: 'legacy-header', isLegacy: true }
  }
  return { token: '', source: 'none' }
}

/**
 * 判定一次远程请求是否放行。
 *
 * 纯函数：不读环境、不建连接、不碰数据库。`verifyAccessToken` 由调用方注入，
 * 于是"令牌过期""会话被撤销""签名不对"这三条都能在单测里直接构造，
 * 而不必造一个真的会过期的会话。
 *
 * @param {object} input
 * @param {string} input.path
 * @param {string} [input.method]
 * @param {boolean} [input.remoteAuth]  远程门禁是否启用（`LEGION_REMOTE_AUTH=1`）
 * @param {string} [input.token]        请求携带的令牌
 * @param {boolean} [input.legacyAuthorized] 既有 Hub token 是否匹配
 * @param {(token: string) => {ok: boolean, code?: string, message?: string}} [input.verifyAccessToken]
 * @returns {{allow: true, actor: object} | {allow: false, status: number, code: string, message: string, headers: object}}
 */
export function decideRemoteAuth({
  path,
  method = 'GET',
  remoteAuth = false,
  token = '',
  legacyAuthorized = false,
  verifyAccessToken = () => ({ ok: false, code: REMOTE_AUTH_CODES.MISSING }),
} = {}) {
  if (remoteAuth !== true) {
    // 门禁未启用：保持既有行为**逐条不变**。这条分支让"上线远程面"这件事
    // 成为一个显式动作，而不是把本机服务的默认开放面顺带带出去。
    return allow({ kind: 'unconfigured' })
  }
  if (method === 'OPTIONS') return allow({ kind: 'preflight' })
  if (PUBLIC_PATHS.has(path)) return allow({ kind: 'public' })
  if (legacyAuthorized === true) return allow({ kind: 'legacy-token' })
  if (typeof token === 'string' && token.length > 0) {
    const verified = verifyAccessToken(token) ?? { ok: false, code: REMOTE_AUTH_CODES.INVALID }
    if (verified.ok === true) {
      return allow({ kind: 'user', userId: verified.userId, sessionId: verified.sessionId, name: verified.name })
    }
    // 令牌存在但无效：把**具体**原因回给调用方（过期 vs 撤销 vs 签名错），
    // 因为客户端对这三者的正确反应不同——过期要刷新，撤销要重新登录。
    // 这不泄露信息：能区分它们的前提是**已经持有**一个签名合法的令牌。
    return deny(401, verified.code ?? REMOTE_AUTH_CODES.INVALID, verified.message ?? '访问令牌无效')
  }
  return deny(401, REMOTE_AUTH_CODES.MISSING, '缺少访问令牌')
}

/**
 * 把门禁结论写成 HTTP 响应。
 *
 * `code` 与 `message` 都回：只有中文消息时前端无法按类型分支（比如"过期就刷新"），
 * 只有码时排障的人要多跳一次。
 */
export function applyRemoteAuth(res, decision, json) {
  if (decision.allow === true) return false
  if (decision.headers) for (const [k, v] of Object.entries(decision.headers)) res.setHeader(k, v)
  json(res, decision.status, { error: decision.message, code: decision.code })
  return true
}
