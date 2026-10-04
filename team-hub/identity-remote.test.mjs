// team-hub/identity-remote.test.mjs
// 远程 Agent 通道：**接线**的端到端（真实 server.mjs + 真实 HTTP）。
//
// 前面几组用例测的是各模块自己；这一组测的是"它们真的被接上了"——
// 路由注册、门禁生效、Node 网关挂到 upgrade 上。这类问题的表现方式是
// "模块全绿、功能不可用"，所以必须有这一层。
//
// HTTP 范式仿 rules.test.mjs：临时 TEAM_HUB_DB + import server.mjs + listen(0) + fetch。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectWebSocket } from '../packages/shared/src/ws-client.mjs'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-identity-'))
const HUB_TOKEN = 'hub-machine-token-for-tests'
const IDENTITY_KEY = 'identity-signing-key-for-tests-0123456789'
let mod
let base = ''

before(async () => {
  process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_HOST = '127.0.0.1'
  process.env.TEAM_HUB_TOKEN = HUB_TOKEN
  process.env.LEGION_IDENTITY_KEY = IDENTITY_KEY
  // 远程门禁显式打开：Hub 绑回环 + 反代时，`readAuthRequired()` 那条既有门禁
  // **不会**生效（它的条件是"非回环监听"），所以这一层必须自己开。
  process.env.LEGION_REMOTE_AUTH = '1'
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${mod.server.address().port}`
})

after(() => {
  try { mod?.nodeGateway?.close?.() } catch { /* 已关 */ }
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close() } catch { /* 已关闭 */ }
  try { mod?.db?.close() } catch { /* 已关闭 */ }
  rmSync(tmpRoot, { recursive: true, force: true })
})

async function call(method, path, { body, token, hubToken } = {}) {
  const headers = {}
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  if (hubToken !== undefined) headers.authorization = `Bearer ${hubToken}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let json = null
  try { json = text.length > 0 ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  return { status: res.status, json }
}
const get = (path, opts) => call('GET', path, opts)
const post = (path, body, opts) => call('POST', path, { body, ...opts })

describe('远程 Agent 通道接线', () => {
  const state = {}

  it('能力发现是公开的，且如实报告已初始化 / 需要远程鉴权', async () => {
    const r = await get('/api/identity/status')
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true)
    assert.equal(r.json.bootstrapped, false)
    assert.equal(r.json.remoteAuthRequired, true)
    // 它只回布尔，**不**回任何用户数据。
    assert.equal(JSON.stringify(r.json).includes('user'), false)
  })

  it('未初始化的库：用 Hub 机器令牌初始化第一个系统管理员', async () => {
    // 没有机器令牌 → 拒绝（这不是公开注册口）。
    const denied = await post('/api/identity/bootstrap', { name: 'owner', password: 'owner-password-1' })
    assert.equal(denied.status, 401)
    assert.equal(denied.json.code, 'HUB_TOKEN_REQUIRED')

    const ok = await post('/api/identity/bootstrap', { name: 'owner', password: 'owner-password-1' }, { hubToken: HUB_TOKEN })
    assert.equal(ok.status, 200)
    assert.equal(ok.json.systemRole, 'admin')
    state.ownerId = ok.json.userId

    // 第二个初始化请求必须被拒。
    const again = await post('/api/identity/bootstrap', { name: 'other', password: 'other-password-1' }, { hubToken: HUB_TOKEN })
    assert.equal(again.status, 409)
    assert.equal(again.json.code, 'IDENTITY_ALREADY_BOOTSTRAPPED')
  })

  it('远程门禁：没有令牌的业务读端点被 401 挡住（而它在本机是开放的）', async () => {
    // ★ 这一条是这套接线存在的**全部理由**：Hub 绑回环 + 反代时，
    //   既有的 `readAuthRequired()` 不会生效，于是 `/api/board` 这类
    //   为本地开发开放的读端点会原样暴露到公网。
    const blocked = await get('/api/board?scope=software')
    assert.equal(blocked.status, 401)
    assert.equal(blocked.json.code, 'REMOTE_AUTH_MISSING')
    // 只给 Hub 机器令牌也放行（过渡期的机器面）。
    const viaHub = await get('/api/board?scope=software', { hubToken: HUB_TOKEN })
    assert.equal(viaHub.status, 200)
  })

  it('登录拿到访问令牌后，远程门禁放行；令牌可被 /api/identity/me 认出来', async () => {
    const login = await post('/api/identity/login', { name: 'owner', password: 'owner-password-1', label: '手机' })
    assert.equal(login.status, 200)
    assert.ok(login.json.accessToken)
    state.access = login.json.accessToken
    state.refresh = login.json.refreshToken

    const me = await get('/api/identity/me', { token: state.access })
    assert.equal(me.status, 200)
    assert.equal(me.json.user.name, 'owner')
    assert.equal(me.json.systemRole, 'admin')

    // 业务端点现在也放行了。
    const board = await get('/api/board?scope=software', { token: state.access })
    assert.equal(board.status, 200)
  })

  it('伪造/过期令牌被具名拒绝（前端据此决定刷新还是重新登录）', async () => {
    const bogus = await get('/api/identity/me', { token: 'v1.not.a.token' })
    assert.equal(bogus.status, 401)
    assert.ok(['IDENTITY_TOKEN_BAD_SIGNATURE', 'IDENTITY_TOKEN_MALFORMED'].includes(bogus.json.code))

    const missing = await get('/api/board?scope=software', { token: '' })
    assert.equal(missing.status, 401)
  })

  it('邀请 → 新用户登录 → 只能在被授权的空间看到东西', async () => {
    const invite = await post('/api/identity/invites', { space: 'software', role: 'member' }, { token: state.access })
    assert.equal(invite.status, 200)
    assert.ok(invite.json.code)

    const accepted = await post('/api/identity/invites/accept', { code: invite.json.code, name: 'member1', password: 'member-password-1' })
    assert.equal(accepted.status, 200)
    assert.equal(accepted.json.space, 'software')

    // 同一个邀请码再用一次必须被拒。
    const reuse = await post('/api/identity/invites/accept', { code: invite.json.code, name: 'member2', password: 'member-password-2' })
    assert.equal(reuse.status, 409)
    assert.equal(reuse.json.code, 'IDENTITY_INVITE_CONSUMED')

    const memberLogin = await post('/api/identity/login', { name: 'member1', password: 'member-password-1' })
    assert.equal(memberLogin.status, 200)
    const roles = await get('/api/identity/me', { token: memberLogin.json.accessToken })
    assert.deepEqual(roles.json.roles, [{ space: 'software', role: 'member' }])
    // 普通成员不能列用户（系统管理员才行）。
    const users = await get('/api/identity/users', { token: memberLogin.json.accessToken })
    assert.equal(users.status, 403)
    assert.equal(users.json.code, 'IDENTITY_FORBIDDEN')
  })

  it('配对码换设备令牌，随后设备可被枚举与撤销', async () => {
    const pairing = await post('/api/devices/pairing', { nodeName: '书桌电脑' }, { token: state.access })
    assert.equal(pairing.status, 200)
    assert.ok(pairing.json.code)

    // 兑换**不需要**登录：配对码本身就是凭据（那台电脑此刻还没有任何身份）。
    const paired = await post('/api/devices/pair', { code: pairing.json.code, platform: 'win32', protocolVersion: 1 })
    assert.equal(paired.status, 200)
    assert.ok(paired.json.deviceToken)
    assert.deepEqual(paired.json.capabilities, ['task.run'])
    state.nodeId = paired.json.nodeId
    state.deviceToken = paired.json.deviceToken

    // 再一次兑换同一个码必须被拒。
    const reuse = await post('/api/devices/pair', { code: pairing.json.code })
    assert.equal(reuse.status, 409)
    assert.equal(reuse.json.code, 'DEVICE_PAIRING_CONSUMED')

    const list = await get('/api/devices', { token: state.access })
    assert.equal(list.status, 200)
    assert.equal(list.json.devices.length, 1)
    assert.equal(list.json.devices[0].nodeId, state.nodeId)
    // 列设备不得回出令牌或哈希。
    assert.equal(JSON.stringify(list.json).includes(state.deviceToken), false)

    const revoked = await post('/api/devices/revoke', { nodeId: state.nodeId }, { token: state.access })
    assert.equal(revoked.status, 200)
    assert.equal(revoked.json.revoked, true)
  })

  it('登出后访问令牌立即失效（撤销不等自然过期）', async () => {
    const sessions = await get('/api/identity/sessions', { token: state.access })
    assert.equal(sessions.status, 200)
    const current = sessions.json.currentSessionId
    assert.ok(current)

    // 用刷新凭据换一对新的，然后登出这条新会话。
    const refreshed = await post('/api/identity/refresh', { refreshToken: state.refresh })
    assert.equal(refreshed.status, 200)
    const fresh = refreshed.json.accessToken
    assert.equal((await get('/api/identity/me', { token: fresh })).status, 200)

    const out = await post('/api/identity/logout', {}, { token: fresh })
    assert.equal(out.status, 200)
    const after = await get('/api/identity/me', { token: fresh })
    assert.equal(after.status, 401)
    assert.equal(after.json.code, 'IDENTITY_SESSION_REVOKED')
    // 业务端点同样立即拒。
    const board = await get('/api/board?scope=software', { token: fresh })
    assert.equal(board.status, 401)
  })

  it('Node 网关挂在 /node 上，且真实设备令牌能完成一次 WSS 握手', async () => {
    // 上一个用例登出的是 `state.access` 所属的**同一条会话**（`refresh` 更新的是
    // 那一行，不是新开一行），所以这里必须重新登录——顺带也证明了撤销是立即生效的。
    const relogin = await post('/api/identity/login', { name: 'owner', password: 'owner-password-1', label: '笔记本配对' })
    assert.equal(relogin.status, 200)
    const access = relogin.json.accessToken

    const pairing = await post('/api/devices/pairing', { nodeName: '笔记本' }, { token: access })
    assert.equal(pairing.status, 200, JSON.stringify(pairing.json))
    const paired = await post('/api/devices/pair', { code: pairing.json.code, platform: 'win32', protocolVersion: 1 })
    assert.equal(paired.status, 200, JSON.stringify(paired.json))

    const url = base.replace('http://', 'ws://') + '/node'
    const sock = connectWebSocket({ url, headers: { Authorization: `Bearer ${paired.json.deviceToken}` }, timeoutMs: 8000 })
    sock.on('error', () => {})
    const frames = []
    sock.on('message', (t) => frames.push(JSON.parse(t)))
    await new Promise((resolve, reject) => {
      sock.on('open', resolve)
      sock.on('close', (i) => reject(new Error(`连接被关闭：${i.reason}`)))
    })
    sock.send(JSON.stringify({ v: 1, type: 'hello', protocolVersion: 1, nodeId: paired.json.nodeId }))
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && frames.every((f) => f.type !== 'hello.ack')) await new Promise((r) => setTimeout(r, 20))
    const ack = frames.find((f) => f.type === 'hello.ack')
    assert.ok(ack, `未收到 hello.ack；已收到：${frames.map((f) => f.type).join(',')}`)
    assert.equal(ack.canDispatch, true)
    assert.equal(ack.nodeId, paired.json.nodeId)
    // 上线后 presence 可查。
    const presence = await get('/api/devices/presence', { token: access })
    assert.equal(presence.json.presence.some((p) => p.nodeId === paired.json.nodeId && p.online === true), true)
    sock.close()
  })

  it('未鉴权的普通 HTTP 请求打 /node 被门禁拒掉（而 WSS 升级走的是另一条路）', async () => {
    // ★ 关键性质：Node 网关挂在 `http.Server` 的 **upgrade** 事件上，不经过
    //   `handle()`，所以远程门禁不会挡真正的 Node 连接——它自己做设备令牌鉴权。
    //   而一个普通 GET 打这个路径会被门禁 401，不会落到 404 兜底上"什么都不发生"。
    const res = await fetch(`${base}/node`)
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.code, 'REMOTE_AUTH_MISSING')
  })
})

describe('远程通道默认关闭', () => {
  it('未配 LEGION_IDENTITY_KEY 时不注册身份路由、不挂网关（另起一个进程验证）', async () => {
    const { spawnSync } = await import('node:child_process')
    const script = `
      process.env.TEAM_HUB_DB = ${JSON.stringify(join(tmpRoot, 'closed.db'))}
      process.env.TEAM_HUB_HOST = '127.0.0.1'
      process.env.TEAM_HUB_TOKEN = 'x'.repeat(24)
      delete process.env.LEGION_IDENTITY_KEY
      delete process.env.LEGION_REMOTE_AUTH
      const mod = await import(${JSON.stringify(new URL('./server.mjs', import.meta.url).href)})
      await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
      const base = 'http://127.0.0.1:' + mod.server.address().port
      const status = await fetch(base + '/api/identity/status')
      const board = await fetch(base + '/api/board?scope=software')
      console.log(JSON.stringify({
        identityStatus: status.status,
        boardStatus: board.status,
        enabled: mod.REMOTE_AGENT_ENABLED,
        gateway: mod.nodeGateway,
        userStore: mod.userStore,
      }))
      mod.server.closeAllConnections?.(); mod.server.close(); mod.db.close()
    `
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 60000 })
    assert.equal(out.status, 0, `子进程失败：${out.stderr}`)
    const result = JSON.parse(out.stdout.trim().split('\n').pop())
    // ★ 默认关闭：没有签名密钥就不存在"打开了但没配好"这个中间态。
    assert.equal(result.enabled, false)
    assert.equal(result.gateway, null)
    assert.equal(result.userStore, null)
    assert.equal(result.identityStatus, 404, '身份路由不应注册')
    assert.equal(result.boardStatus, 200, '既有本机行为逐条不变')
  })
})
