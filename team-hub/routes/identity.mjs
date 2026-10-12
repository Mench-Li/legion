// team-hub/routes/identity.mjs
// ============================================================================
// 路由族：身份、会话、设备（远程 Agent 通道 S-B 的管理面）
//
// 与其它族同一形状（`{ id, routes, dispatch }`），依赖由 `server.mjs` 注入。
//
// ## 两套凭据在这一个族里并存，且**不互相冒充**
//
// `user-store` 的访问令牌是"你是谁"，`TEAM_HUB_TOKEN` 是"你是这台机器上的 Legion
// 组件"。本族的读面（`/api/identity/me`、`/api/identity/sessions`）**只认用户令牌**：
// 用一个机器令牌去看"我的会话"是没有意义的问题，放行只会让审计里出现一个
// 说不清主体是谁的主语。
//
// 例外是 `/api/identity/bootstrap`：它出现在**还没有任何用户**的时刻，此刻唯一
// 可能存在的凭据就是机器令牌，所以它要求机器令牌。
//
// ## 为什么每个响应都带 `code`
//
// 手机端要按错误**类型**分支（令牌过期→刷新；会话撤销→重新登录；权限不足→不重试）。
// 只给中文消息的话，前端只能做字符串匹配——那是一种会在文案改动时静默失效的耦合。
// ============================================================================

import { readFileSync } from 'node:fs'

import { clientIpFrom, isLoopbackOrPrivate } from '../client-ip.mjs'
import { limitMessage, RATE_LIMIT_CODE, RATE_LIMIT_STATUS, QUOTA_RESOURCES } from '../rate-limit.mjs'
import { readStateLevel, stateSummary } from '../storage-state.mjs'

/** 把仓储抛出的具名错误映射成 HTTP。 */
function errorResponse(store, e) {
  const status = Number(e?.status) || 400
  const code = typeof e?.code === 'string' ? e.code : 'IDENTITY_REQUEST_FAILED'
  return { status, body: { ok: false, code, error: e instanceof Error ? e.message : String(e) } }
}

export function createIdentityRoutes({
  json, readBody, authorized, requireString,
  userStore, deviceStore, remoteAuthEnabled = false, gateway = undefined,
  registration = 'closed',
  // ── 按来源（IP）限速 ──────────────────────────────────────────────────────
  // `trustedProxies` 是 `parseTrustedProxies` 的结果。**默认不信任何人** ——
  // 一个"没配就信 X-Forwarded-For"的默认值会让每个请求自带一个 IP，
  // 于是限速在攻击者面前等于不存在（见 `client-ip.mjs` 文件头）。
  trustedProxies = { rules: [], invalid: [] },
  // 上限。`<= 0` = 显式关掉。窗口统一 15 分钟（与按用户名的登录锁定同量级）。
  limits = {},
  // 按**账号**的用量配额上限（键同 `QUOTA_RESOURCES`）。只用于**如实报出**读数 ——
  // 判定在 `server.mjs` 的 `requireAccountQuota`，诊断在这里，两处读同一份注入值。
  quotas = {},
  // 定时体检的状态文件路径（`storageStatePath`）。诊断端点读它来回答
  // "那个定时器**真的在跑**吗" —— 而这个问题只能由**读数的新鲜度**回答。
  storageStatePath = '',
} = {}) {
  for (const [name, fn] of Object.entries({ json, readBody, authorized, requireString })) {
    if (typeof fn !== 'function') throw new TypeError(`createIdentityRoutes 缺注入项：${name}`)
  }
  for (const [name, dep] of Object.entries({ userStore, deviceStore })) {
    if (dep === null || dep === undefined) throw new TypeError(`createIdentityRoutes 缺注入项：${name}`)
  }
  // `gateway` 允许为 null（远程通道未启用时），但**必须**在注入项里出现：
  // 一个"忘了注入"与一个"确实没有网关"在运行时长得一样，而前者会让诊断端点
  // 永远报 `enabled:false`，把一次接线遗漏伪装成一次正常读数。
  if (gateway === undefined) throw new TypeError('createIdentityRoutes 缺注入项：gateway（允许 null，但不能不传）')

  const RATE_WINDOW_MS = 15 * 60 * 1000
  const rateMax = (name) => {
    const v = Number(limits?.[name])
    return Number.isFinite(v) ? v : 0
  }
  /**
   * 生效中的配额上限。**从注入的 `quotas` 读**，不在本文件里写死 ——
   * 报出来的数与实际判定的数必须是同一个来源，否则"诊断说 300、实际不限"这种
   * 最难查的偏差就会出现（而且只在被攻击时暴露）。
   */
  const quotaMax = {}
  for (const [resource, spec] of Object.entries(QUOTA_RESOURCES)) {
    const v = Number(quotas?.[resource])
    quotaMax[resource] = Number.isFinite(v) ? v : (Number.isFinite(spec?.defaultMax) ? spec.defaultMax : 0)
  }
  const quotaWindowSec = () => {
    const ms = Math.max(...Object.values(QUOTA_RESOURCES).map((s) => Number(s?.defaultWindowMs) || 0), 0)
    return Math.round(ms / 1000)
  }

  /** 这次请求的"来源"长什么样，以及它能不能用来按来源限速。 */
  function sourceOf(req) {
    return clientIpFrom({
      peerAddress: req?.socket?.remoteAddress ?? null,
      // 重复头在 Node 里会变成数组；`clientIpFrom` 两种形状都吃。
      forwardedFor: req?.headers?.['x-forwarded-for'] ?? null,
      trustedProxies,
    })
  }

  /**
   * 在一次**免鉴权**的尝试上应用来源限速。
   *
   * 返回 `null` = 放行；否则已经把 429 写出去。
   *
   * ★ 这条判断发生在**读用户名之前**，所以它的结果与"那个用户名存不存在"无关 ——
   *   一个与账号相关的限速消息会成为用户名探测接口，那比限速本身更值钱。
   */
  function rateGuard(req, res, bucket) {
    const max = rateMax(bucket)
    if (max <= 0) return null
    const src = sourceOf(req)
    // ★ `effective` 为假时**跳过**这层，而不是把所有人算成同一个键。
    //   拿一个所有人共用的键去限速，会把"限制一个攻击者"变成"限制你的全部用户"：
    //   攻击者只要失败几次，就能把所有人挡在门外（对自己用户的 DoS）。
    //   这个取舍与注册闸门**相反**（那里全局计数是对的，因为注册限的是"新建资源"，
    //   而登录限的是"某个来源的行为"—— 前者被耗尽的代价远小于后者被误锁）。
    const decision = userStore.rateLimit({
      bucket,
      key: src.ip ?? '(unknown)',
      max,
      windowMs: RATE_WINDOW_MS,
      effective: src.effective === true,
    })
    if (decision.allowed !== false) return null
    // ★ `Retry-After` 是 HTTP 语义的一部分：客户端（含我们自己的手机端）
    //   应当照它退避，而不是自己猜一个间隔重试。
    try { res.setHeader('retry-after', String(decision.retryAfterSec)) } catch { /* 有的适配层没有 setHeader */ }
    json(res, RATE_LIMIT_STATUS, {
      ok: false,
      code: RATE_LIMIT_CODE,
      error: limitMessage({ retryAfterSec: decision.retryAfterSec }),
      // 只回**计数与上限**，不回键本身 —— 那会把来源 IP 回显给调用方。
      retryAfterSec: decision.retryAfterSec,
      windowSec: Math.round(RATE_WINDOW_MS / 1000),
    })
    return { status: RATE_LIMIT_STATUS, limited: true }
  }

  /** 给诊断端点用：限速到底有没有真正生效（以及为什么没有）。 */
  function rateReport(req) {
    const src = sourceOf(req)
    return {
      reason: src.reason,
      // `effective:false` 是**如实报出来**，不是错误：它意味着这台 Hub 的部署形态
      // 让"按来源"这一层无从下手，运维该去配 `LEGION_TRUSTED_PROXIES`。
      effective: src.effective === true,
      loopbackOrPrivate: src.ip === null ? true : isLoopbackOrPrivate(src.ip),
      max: {
        login: rateMax('login'),
        register: rateMax('register'),
        'password-reset': rateMax('password-reset'),
      },
      windowSec: Math.round(RATE_WINDOW_MS / 1000),
      trustedProxyRules: Array.isArray(trustedProxies?.rules) ? trustedProxies.rules.length : 0,
      trustedProxiesInvalid: Array.isArray(trustedProxies?.invalid) ? trustedProxies.invalid : [],
      // ── 按**账号**的用量配额（与上面的来源限速是**两套**读数）────────────────
      //
      // ★ 为什么两组必须分开报：它们问的问题不同，运维的动作也不同。
      //   来源限速 → 去配 `LEGION_TRUSTED_PROXIES`；配额 → 去调 `LEGION_QUOTA_*`。
      //   揉成一组的话，运维看到"限速已生效"就以为配额也配好了。
      quotas: quotaMax,
      quotaWindowSec: quotaWindowSec(),
    }
  }

  /**
   * 运维端点共用的门：**机器令牌或系统管理员**。
   *
   * ★ 抽出来是因为这一类端点会越来越多（限速读数、存储读数……），
   *   而"每处各写一遍鉴权"必然漂 —— 漂的那一次会是**更松**的那一次，
   *   因为写第二遍的人会照抄一段自己觉得对的东西。
   *
   *   > 两处各写一遍的鉴权，与一处写对、另一处写漏，在代码评审里长得一样。
   *
   * ★ 它们**刻意都不在公开名单里**：一个匿名可读的"我有没有在限速/盘满没满"
   *   等于把运维面暴露给任何人。要看它就先有凭据。
   *
   * @returns {boolean} true = 已经回过响应，调用方应当直接 return
   */
  function requireOperator(req, res, url, what) {
    if (authorized(req)) return false
    const me = currentUser(req, url)
    if (me.ok !== true) {
      json(res, 401, { ok: false, code: 'HUB_TOKEN_REQUIRED', error: `${what}需要 Hub 管理令牌或系统管理员账号` })
      return true
    }
    try {
      userStore.requireSystemAdmin(me.userId)
    } catch (e) {
      const { status, body } = errorResponse(userStore, e)
      json(res, status, body)
      return true
    }
    return false
  }

  /**
   * 读定时体检的状态文件，并**按新鲜度**给出现在的判定。
   *
   * ★ 读失败**不抛**也**不回 500**：一个读不出来的状态文件本身就是一个
   *   **要报出来的读数**（"没人测"或"写入方坏了"），不是这个端点坏了。
   *   回 500 会让运维以为端点有问题，而去查错的东西。
   */
  function readStorageState(nowMs = Date.now()) {
    const path = typeof storageStatePath === 'string' && storageStatePath.length > 0 ? storageStatePath : null
    if (path === null) {
      return { ...readStateLevel({ raw: null, nowMs }), summary: stateSummary({ raw: null, nowMs }), path: null }
    }
    let raw = null
    try {
      raw = readFileSync(path, 'utf8')
    } catch (e) {
      // `ENOENT` = 文件不在（定时器没跑过）；其它错误 = 文件在但读不出来。
      // ★ 两者**不能合并**：前者是"去装定时器"，后者是"去查权限/写入方"。
      raw = e?.code === 'ENOENT' ? null : '{ 读不出来 }'
    }
    const level = readStateLevel({ raw, nowMs })
    return { ...level, summary: stateSummary({ raw, nowMs }), path }
  }

  /** 取用户令牌并校验。返回 `{ ok, ... }`，不抛。 */
  function currentUser(req, url) {
    const header = String(req.headers.authorization ?? '')
    const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() ?? ''
    if (!bearer) return { ok: false, status: 401, code: 'IDENTITY_TOKEN_MISSING', message: '缺少访问令牌' }
    const verified = userStore.verifyAccessToken(bearer)
    if (verified.ok !== true) {
      return { ok: false, status: 401, code: verified.code, message: verified.message }
    }
    userStore.touchSession(verified.sessionId)
    return { ok: true, userId: verified.userId, sessionId: verified.sessionId, name: verified.name }
  }

  /** 执行一次"需要登录"的操作；未登录/失败时直接应答并返回 null。 */
  async function withUser(req, res, url, run) {
    const me = currentUser(req, url)
    if (me.ok !== true) {
      json(res, me.status, { ok: false, code: me.code, error: me.message })
      return
    }
    try {
      json(res, 200, { ok: true, ...(await run(me)) })
    } catch (e) {
      const { status, body } = errorResponse(userStore, e)
      json(res, status, body)
    }
  }

  /** 执行一次"不需要登录"的操作（登录、刷新、兑换配对码等）。 */
  async function withoutUser(req, res, run) {
    try {
      json(res, 200, { ok: true, ...(await run(await readBody(req))) })
    } catch (e) {
      const { status, body } = errorResponse(userStore, e)
      json(res, status, body)
    }
  }

  const routes = [
    // ── 能力发现与初始化 ────────────────────────────────────────────────────
    {
      method: 'GET',
      path: '/api/identity/status',
      async run(req, res) {
        // 只回布尔与配置状态，不回任何用户数据。手机用它在登录页决定
        // "显示登录"还是"显示首次初始化"。
        json(res, 200, {
          ok: true,
          enabled: userStore !== null,
          bootstrapped: userStore.isBootstrapped(),
          remoteAuthRequired: remoteAuthEnabled === true,
          protocolVersion: 1,
          // 注册策略**公开**：登录页要靠它决定显不显示"注册"。
          // 一个不公开的开关会让前端只能猜，而猜错的两种方向都坏：
          // 猜"能注册"给用户一个必然 403 的按钮；猜"不能"则永远没有注册入口。
          registration,
        })
      },
    },
    {
      method: 'GET',
      path: '/api/identity/rate-limits',
      async run(req, res, { url }) {
        // ★ 这个端点存在的理由：一台"以为自己在限速、其实没有"的 Hub，
        //   与一台真的在限速的 Hub，在被攻击之前**没有任何区别**。
        //
        //   按来源限速在不配 `LEGION_TRUSTED_PROXIES` 时**必然**失效
        //   （Hub 绑回环 → 推出来的来源永远是 127.0.0.1 → `effective:false`
        //   → 整层被跳过）。那是一个**配置事实**，不是 bug，而它必须能被读出来。
        if (requireOperator(req, res, url, '查看限速状态')) return
        // 只回形状与计数，**不回**任何地址：把来源 IP 回显给调用方会让这个
        // 端点本身变成信息泄露（"你们从哪个 IP 访问我"）。
        json(res, 200, { ok: true, rateLimit: rateReport(req) })
      },
    },
    {
      method: 'GET',
      path: '/api/identity/storage-state',
      async run(req, res, { url }) {
        // ★ 这个端点存在的理由：上一轮有了体检脚本与四档退出码，但**没有定时器** ——
        //   于是"盘快满了"仍然不会主动告警。有了定时器之后，还需要有人能回答
        //   "那个定时器**真的在跑**吗"。
        //
        //   这个问题只能由**读数的新鲜度**回答：一个每小时跑一次的定时器与一个
        //   上个月就停了的定时器，在没有状态文件的情况下**完全一样**。
        //
        //   > 一个"配了定时器"的部署，与一个"定时器从来没跑成功过"的部署，
        //   > 在 `systemctl list-timers` 里长得一模一样 ——
        //   > 只要没人去看 `LAST` 那一列。
        if (requireOperator(req, res, url, '查看存储体检状态')) return
        json(res, 200, { ok: true, storage: readStorageState() })
      },
    },
    {
      method: 'POST',
      path: '/api/identity/bootstrap',
      async run(req, res) {
        // ★ 这一条要求**机器令牌**，不是"谁都能初始化"。库非空时 user-store
        //   自己会拒（ALREADY_BOOTSTRAPPED），所以它不构成公开注册入口。
        if (!authorized(req)) { json(res, 401, { ok: false, code: 'HUB_TOKEN_REQUIRED', error: '初始化需要 Hub 管理令牌' }); return }
        await withoutUser(req, res, (body) => userStore.bootstrapOwner({ ...body, authorized: true }))
      },
    },

    // ── 登录 / 刷新 / 登出 ──────────────────────────────────────────────────
    {
      method: 'POST',
      path: '/api/identity/login',
      async run(req, res) {
        // ★ 来源限速在**最前面**：在解析 body、查库、跑 scrypt 之前。
        //   放在后面的话，被限的请求仍然会付出一次 scrypt（~100ms CPU）——
        //   于是限速挡不住"用计算量打死服务器"这一路。
        if (rateGuard(req, res, 'login') !== null) return
        await withoutUser(req, res, (body) => userStore.login(body))
      },
    },
    {
      method: 'POST',
      path: '/api/identity/refresh',
      async run(req, res) { await withoutUser(req, res, (body) => userStore.refresh(body)) },
    },
    {
      method: 'POST',
      path: '/api/identity/logout',
      async run(req, res) {
        await withUser(req, res, null, (me) => userStore.revokeSession({ sessionId: me.sessionId, by: me.userId }))
      },
    },
    {
      method: 'POST',
      path: '/api/identity/invites/accept',
      async run(req, res) { await withoutUser(req, res, (body) => userStore.acceptInvite(body)) },
    },
    {
      method: 'POST',
      path: '/api/identity/register',
      async run(req, res) {
        // 注册也按来源限速。它**不替代** `registrationAllowed` 的全局窗口 ——
        // 两者问的不是同一件事：全局窗口问"这台 Hub 这一小时开了几个号"，
        // 来源限速问"这个来源发了多少次注册尝试"。前者防资源被灌满，
        // 后者防止一个来源高速试探（比如试邀请码）。
        if (rateGuard(req, res, 'register') !== null) return
        // ★ 策略从**注入的配置**来，不从请求体来。
        //   一个"由调用方声明这次注册适用哪条策略"的接口，等于没有策略——
        //   攻击者只要在请求里写 `registration: 'open'`。
        //   所以这里覆盖掉 body 里可能带的同名字段。
        await withoutUser(req, res, (body) => userStore.register({
          name: body?.name,
          password: body?.password,
          space: body?.space,
          code: body?.code,
          label: body?.label ?? '',
          registration,
        }))
      },
    },

    // ── 自己的身份与会话 ────────────────────────────────────────────────────
    {
      method: 'GET',
      path: '/api/identity/me',
      async run(req, res, { url }) {
        await withUser(req, res, url, (me) => ({
          user: { userId: me.userId, name: me.name },
          roles: userStore.rolesOf(me.userId),
          systemRole: userStore.isSystemAdmin(me.userId) ? 'admin' : 'none',
        }))
      },
    },
    {
      method: 'GET',
      path: '/api/identity/sessions',
      async run(req, res, { url }) {
        await withUser(req, res, url, (me) => ({ sessions: userStore.listSessions(me.userId), currentSessionId: me.sessionId }))
      },
    },
    {
      method: 'POST',
      path: '/api/identity/password',
      async run(req, res, { url }) {
        // 只改**自己**的口令：要改别人的得走管理员那条（本节暂不提供，
        // 因为"管理员重置用户口令"需要一个只在带外可见的一次性口令通道，
        // 那是另一件事，不该顺手加一个接口）。
        await withUser(req, res, url, async (me) => {
          const body = await readBody(req)
          return userStore.changePassword({
            userId: me.userId,
            currentPassword: requireString(body, 'currentPassword'),
            newPassword: requireString(body, 'newPassword'),
            // 保留当前会话，理由见 `changePassword` 的注释。
            exceptSessionId: me.sessionId,
          })
        })
      },
    },
    {
      method: 'POST',
      path: '/api/identity/sessions/revoke',
      async run(req, res, { url }) {
        await withUser(req, res, url, async (me) => {
          const body = await readBody(req)
          const sessionId = requireString(body, 'sessionId')
          // 只能撤销**自己的**会话；撤销别人的要系统管理员。
          const own = userStore.listSessions(me.userId).some((s) => s.sessionId === sessionId)
          if (!own) {
            if (!userStore.isSystemAdmin(me.userId)) {
              throw Object.assign(new Error('只能撤销自己的会话'), { code: 'IDENTITY_FORBIDDEN', status: 403 })
            }
          }
          return userStore.revokeSession({ sessionId, by: me.userId })
        })
      },
    },

    // ── 用户与邀请（管理） ──────────────────────────────────────────────────
    // ── 事件订阅票据（SSE）──────────────────────────────────────────────────
    {
      method: 'POST',
      path: '/api/events/ticket',
      async run(req, res, { url }) {
        // 要**用户会话**：票据只是一个短命的替代品，签发它的前提仍然是"你是登录用户"。
        await withUser(req, res, url, (me) => userStore.createEventTicket({ userId: me.userId, sessionId: me.sessionId }))
      },
    },

    // ── 口令重置（忘记口令 / 账号恢复）──────────────────────────────────────
    {
      method: 'POST',
      path: '/api/identity/password/reset-code',
      async run(req, res, { url }) {
        // 签发只给系统管理员：这是一条**能接管账号**的凭据，不是自助动作。
        await withUser(req, res, url, async (me) => {
          const body = await readBody(req)
          return userStore.createPasswordReset({ by: me.userId, userId: requireString(body, 'userId') })
        })
      },
    },
    {
      method: 'GET',
      path: '/api/identity/password/resets',
      async run(req, res, { url }) {
        await withUser(req, res, url, (me) => ({
          resets: userStore.listPasswordResets({ by: me.userId, userId: url?.searchParams?.get('userId') ?? null }),
        }))
      },
    },
    {
      method: 'POST',
      path: '/api/identity/password/reset',
      async run(req, res) {
        // 免登录：进不来的人正是要用它的人（与接受邀请同一个道理）。
        // ★ 正因为免登录，它是最该限速的一类：**重置码是短字符串**，
        //   不限速的话它可以被暴力枚举，而枚举成功等于账号被接管。
        if (rateGuard(req, res, 'password-reset') !== null) return
        await withoutUser(req, res, (body) => userStore.redeemPasswordReset({
          name: body?.name, code: body?.code, newPassword: body?.newPassword, label: body?.label ?? '',
        }))
      },
    },
    {
      method: 'GET',
      path: '/api/identity/users',
      async run(req, res, { url }) {
        await withUser(req, res, url, (me) => {
          userStore.requireSystemAdmin(me.userId)
          return { users: userStore.listUsers() }
        })
      },
    },
    {
      method: 'POST',
      path: '/api/identity/users/disable',
      async run(req, res, { url }) {
        await withUser(req, res, url, async (me) => {
          const body = await readBody(req)
          return userStore.setUserDisabled({ by: me.userId, userId: requireString(body, 'userId'), disabled: body.disabled !== false })
        })
      },
    },
    {
      method: 'POST',
      path: '/api/identity/invites',
      async run(req, res, { url }) {
        await withUser(req, res, url, async (me) => {
          const body = await readBody(req)
          return userStore.createInvite({
            by: me.userId,
            space: requireString(body, 'space'),
            role: body.role ?? 'member',
            ttlMs: Number.isSafeInteger(body.ttlMs) && body.ttlMs > 0 ? body.ttlMs : undefined,
          })
        })
      },
    },
    {
      method: 'POST',
      path: '/api/identity/roles/grant',
      async run(req, res, { url }) {
        await withUser(req, res, url, async (me) => {
          const body = await readBody(req)
          return userStore.grantSpaceRole({
            by: me.userId, userId: requireString(body, 'userId'),
            space: requireString(body, 'space'), role: requireString(body, 'role'),
          })
        })
      },
    },
    {
      method: 'POST',
      path: '/api/identity/roles/revoke',
      async run(req, res, { url }) {
        await withUser(req, res, url, async (me) => {
          const body = await readBody(req)
          return userStore.revokeSpaceRole({ by: me.userId, userId: requireString(body, 'userId'), space: requireString(body, 'space') })
        })
      },
    },

    // ── 设备 ────────────────────────────────────────────────────────────────
    {
      method: 'POST',
      path: '/api/devices/pairing',
      async run(req, res, { url }) {
        // 造配对码要**已登录**：配对是把一台机器挂到某个人名下，不是匿名动作。
        await withUser(req, res, url, async (me) => {
          const body = await readBody(req)
          return deviceStore.createPairingCode({ userId: me.userId, nodeName: requireString(body, 'nodeName') })
        })
      },
    },
    {
      method: 'POST',
      path: '/api/devices/pair',
      async run(req, res) {
        // 免登录：**配对码本身就是凭据**（一次性、短时、限速）。要求登录才能兑换，
        // 等于要求那台还没接入的电脑先会登录——而它连账号都不知道。
        await withoutUser(req, res, (body) => deviceStore.redeemPairingCode({
          code: requireString(body, 'code'),
          platform: body.platform ?? '',
          capabilities: body.capabilities,
          protocolVersion: Number.isSafeInteger(body.protocolVersion) ? body.protocolVersion : null,
        }))
      },
    },
    {
      method: 'GET',
      path: '/api/devices',
      async run(req, res, { url }) {
        await withUser(req, res, url, (me) => {
          // 系统管理员看全部；普通用户只看自己的设备。
          const devices = userStore.isSystemAdmin(me.userId) ? deviceStore.listDevices() : deviceStore.listDevices({ userId: me.userId })
          return { devices: devices.map((d) => ({ ...d, presence: deviceStore.presenceOf(d.nodeId) })) }
        })
      },
    },
    {
      method: 'GET',
      path: '/api/devices/presence',
      async run(req, res, { url }) {
        await withUser(req, res, url, () => ({ presence: deviceStore.listPresence() }))
      },
    },
    {
      method: 'GET',
      path: '/api/devices/gateway',
      async run(req, res, { url }) {
        // Node 网关的**运行时读数**。
        //
        // 为什么要有这个端点：网关内部状态（有没有就绪连接、在途几条、各个计数器）
        // 在别处**完全不可见**。没有它时，"节点连上了但任务不派发"只能靠加日志
        // 再重启来查——而重启会把要查的那个状态（内存里的连接表）清掉。
        // 这是运维面，所以要登录；不需要管理员（每个用户看的是自己 Hub 的读数）。
        await withUser(req, res, url, () => {
          if (gateway === null) return { enabled: false }
          return {
            enabled: true,
            ...gateway.stats,
            // 每条连接的关键相位：`phase` 不是 `ready` 时不会被派发，
            // 而"为什么不是 ready"是排查的第一个问题。
            connections: gateway.connectionViews(),
            // 「连上了但不派发」的第一个要看的读数：定时器到底有没有起。
            dispatching: gateway.dispatching === true,
            claimScope: gateway.claimScope ?? null,
            dispatchPollMs: gateway.dispatchPollMs ?? null,
          }
        })
      },
    },
    {
      method: 'POST',
      path: '/api/devices/revoke',
      async run(req, res, { url }) {
        await withUser(req, res, url, async (me) => {
          const body = await readBody(req)
          const nodeId = requireString(body, 'nodeId')
          const row = deviceStore.deviceRow(nodeId)
          if (row.user_id !== me.userId && !userStore.isSystemAdmin(me.userId)) {
            throw Object.assign(new Error('只能撤销自己的设备'), { code: 'IDENTITY_FORBIDDEN', status: 403 })
          }
          return deviceStore.revokeDevice({ nodeId, by: me.userId })
        })
      },
    },
    {
      method: 'POST',
      path: '/api/devices/rotate',
      async run(req, res, { url }) {
        await withUser(req, res, url, async (me) => {
          const body = await readBody(req)
          const nodeId = requireString(body, 'nodeId')
          const row = deviceStore.deviceRow(nodeId)
          if (row.user_id !== me.userId && !userStore.isSystemAdmin(me.userId)) {
            throw Object.assign(new Error('只能轮换自己的设备令牌'), { code: 'IDENTITY_FORBIDDEN', status: 403 })
          }
          return deviceStore.rotateToken({ nodeId, by: me.userId })
        })
      },
    },
  ]

  return {
    id: 'identity',
    routes,
    async dispatch(req, res, ctx) {
      for (const r of routes) {
        if (req.method !== r.method || ctx.path !== r.path) continue
        await r.run(req, res, ctx)
        return true
      }
      return false
    },
  }
}
