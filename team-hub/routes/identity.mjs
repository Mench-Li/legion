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
}) {
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
      async run(req, res) { await withoutUser(req, res, (body) => userStore.login(body)) },
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
