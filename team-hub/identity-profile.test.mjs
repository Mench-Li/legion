// team-hub/identity-profile.test.mjs
// ============================================================================
// 账号管理（P0）—— HTTP 契约：/api/identity/me 追加字段、POST /api/identity/profile、
// 401 具名码、越权与停用、失败无副作用。
//
// 对应用例：docs/G-mvt9or0l-1/TEST_CASES.md §4.2（TC-S2-*）
// 夹具仿 team-hub/identity-remote.test.mjs：临时 TEAM_HUB_DB + import server.mjs +
// listen(0) + fetch。全程只写临时库，不碰 live team.db。
// ============================================================================
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hashPassword } from './user-store.mjs'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-profile-'))
const HUB_TOKEN = 'hub-machine-token-for-tests'
const IDENTITY_KEY = 'identity-signing-key-for-tests-0123456789'
let mod
let base = ''

const state = {}

async function call(method, path, { body, rawBody, token, hubToken } = {}) {
  const headers = {}
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  if (hubToken !== undefined) headers.authorization = `Bearer ${hubToken}`
  let payload
  if (rawBody !== undefined) {
    headers['content-type'] = 'application/json'
    payload = rawBody
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const res = await fetch(base + path, { method, headers, body: payload })
  const text = await res.text()
  let json = null
  try { json = text.length > 0 ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  return { status: res.status, json, text, contentType: res.headers.get('content-type') ?? '' }
}
const get = (path, opts) => call('GET', path, opts)
const post = (path, body, opts) => call('POST', path, { body, ...opts })

async function login(name, password, label = '') {
  const r = await post('/api/identity/login', { name, password, label })
  assert.equal(r.status, 200, `login ${name} 失败：${r.text.slice(0, 160)}`)
  return r.json
}

async function createMember(name, password) {
  const invite = await post('/api/identity/invites', { space: 'default', role: 'member' }, { token: state.adminToken })
  assert.equal(invite.status, 200, invite.text.slice(0, 160))
  const accept = await post('/api/identity/invites/accept', { code: invite.json.code, name, password })
  assert.equal(accept.status, 200, accept.text.slice(0, 160))
  const session = await login(name, password)
  return { userId: accept.json.userId, ...session }
}

before(async () => {
  process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_HOST = '127.0.0.1'
  process.env.TEAM_HUB_TOKEN = HUB_TOKEN
  process.env.LEGION_IDENTITY_KEY = IDENTITY_KEY
  // ★ 刻意**不**开 LEGION_REMOTE_AUTH：本套件验证的是**路由层**契约
  //   （R-08 要求缺令牌时是 IDENTITY_TOKEN_MISSING）。远程门禁在缺令牌时会
  //   先回 REMOTE_AUTH_MISSING（见 team-hub/identity-remote.test.mjs 的既有
  //   断言），那是独立的门禁层，不该被本目标改动、也不该被误当成路由错误码。
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${mod.server.address().port}`
  mod.db.prepare("INSERT OR IGNORE INTO spaces (id, name) VALUES ('default', '默认空间')").run()

  const boot = await post('/api/identity/bootstrap', { name: 'owner', password: 'owner-password' }, { hubToken: HUB_TOKEN })
  assert.equal(boot.status, 200, boot.text.slice(0, 200))
  state.adminId = boot.json.userId
  const admin = await login('owner', 'owner-password')
  state.adminToken = admin.accessToken

  state.member = await createMember('小兵', 'soldier-password')
  state.memberId = state.member.userId
  state.member2 = await createMember('小卒', 'pawn-password')
  state.member2Id = state.member2.userId
  state.same1 = await createMember('同名甲', 'same1-password')
  state.same2 = await createMember('同名乙', 'same2-password')

  // 旧数据：display_name 为 NULL（真旧行，不是代码默认值）。
  const legacyHash = await hashPassword('legacy-password')
  mod.db.prepare('INSERT INTO hub_users (id,name,name_key,password_hash,created_at_ms,disabled_at_ms,system_role,display_name) VALUES (?,?,?,?,?,NULL,?,NULL)')
    .run('user-legacy', '旧数据兵', '旧数据兵', legacyHash, Date.now(), 'none')
  state.legacy = await login('旧数据兵', 'legacy-password')

  // 停用专用账号：不能拿主线成员做停用，否则后续用例的令牌会失效。
  state.disabled = await createMember('停用兵', 'disabled-password')
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close() } catch { /* 已关闭 */ }
  try { mod?.db?.close() } catch { /* 已关闭 */ }
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('账号资料 HTTP 契约（S2）', () => {
  it('TC-S2-01 /me 旧字段名与类型不变', async () => {
    const r = await get('/api/identity/me', { token: state.member.accessToken })
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true)
    assert.equal(typeof r.json.user.userId, 'string')
    assert.equal(r.json.user.name, '小兵')
    assert.ok(Array.isArray(r.json.roles))
    assert.ok(['admin', 'none'].includes(r.json.systemRole))
  })

  it('TC-S2-02 /me 追加 displayName / avatar / createdAt / disabled 且类型正确', async () => {
    const r = await get('/api/identity/me', { token: state.member.accessToken })
    assert.equal(typeof r.json.user.displayName, 'string')
    assert.equal(typeof r.json.user.avatar, 'string')
    assert.ok(Number.isFinite(Date.parse(r.json.user.createdAt)))
    assert.equal(typeof r.json.user.disabled, 'boolean')
    assert.equal(r.json.user.displayName, '小兵', '未设置显示名时回退登录用户名')
  })

  it('TC-S2-03 旧数据（display_name NULL）回退用户名', async () => {
    const r = await get('/api/identity/me', { token: state.legacy.accessToken })
    assert.equal(r.status, 200)
    assert.equal(r.json.user.displayName, '旧数据兵')
  })

  it('TC-S2-04 响应不泄露 password_hash / name_key / 令牌 / scrypt', async () => {
    const blob = JSON.stringify((await get('/api/identity/me', { token: state.member.accessToken })).json)
      + JSON.stringify((await post('/api/identity/profile', { displayName: '小兵' }, { token: state.member.accessToken })).json)
    for (const secret of ['password_hash', 'name_key', 'accessToken', 'refreshToken', 'scrypt$']) {
      assert.equal(blob.includes(secret), false, secret)
    }
  })

  it('TC-S2-05 无 Authorization → 401 IDENTITY_TOKEN_MISSING', async () => {
    const r = await get('/api/identity/me')
    assert.equal(r.status, 401)
    assert.equal(r.json.ok, false)
    assert.equal(r.json.code, 'IDENTITY_TOKEN_MISSING')
  })

  it('TC-S2-06 畸形令牌 → 401 IDENTITY_TOKEN_MALFORMED', async () => {
    const r = await get('/api/identity/me', { token: 'not-a-token' })
    assert.equal(r.status, 401)
    assert.equal(r.json.code, 'IDENTITY_TOKEN_MALFORMED')
  })

  it('TC-S2-07 错签名令牌 → 401 IDENTITY_TOKEN_BAD_SIGNATURE', async () => {
    const [v, body, sig] = state.member.accessToken.split('.')
    const bad = `${v}.${body}.${'A'.repeat(sig.length)}`
    const r = await get('/api/identity/me', { token: bad })
    assert.equal(r.status, 401)
    assert.equal(r.json.code, 'IDENTITY_TOKEN_BAD_SIGNATURE')
  })

  it('TC-S2-08 访问令牌过期 → 401 IDENTITY_TOKEN_EXPIRED', async () => {
    const s = await login('小兵', 'soldier-password', '过期实验')
    mod.db.prepare('UPDATE hub_user_sessions SET access_expires_at_ms=? WHERE id=?').run(Date.now() - 1000, s.sessionId)
    const r = await get('/api/identity/me', { token: s.accessToken })
    assert.equal(r.status, 401)
    assert.equal(r.json.code, 'IDENTITY_TOKEN_EXPIRED')
  })

  it('TC-S2-09 会话被撤销 → 401 IDENTITY_SESSION_REVOKED', async () => {
    const s = await login('小兵', 'soldier-password', '待撤销')
    const revoke = await post('/api/identity/sessions/revoke', { sessionId: s.sessionId }, { token: state.member.accessToken })
    assert.equal(revoke.status, 200)
    const r = await get('/api/identity/me', { token: s.accessToken })
    assert.equal(r.status, 401)
    assert.equal(r.json.code, 'IDENTITY_SESSION_REVOKED')
  })

  it('TC-S2-10 POST /profile 成功：200 + 完整 user + name 不变', async () => {
    const r = await post('/api/identity/profile', { displayName: 'Alice' }, { token: state.member.accessToken })
    assert.equal(r.status, 200, r.text.slice(0, 200))
    assert.equal(r.json.ok, true)
    const u = r.json.user
    for (const k of ['userId', 'name', 'displayName', 'avatar', 'createdAt', 'disabled']) assert.ok(k in u, `缺 ${k}`)
    assert.equal(u.displayName, 'Alice')
    assert.equal(u.name, '小兵')
    assert.equal(u.userId, state.memberId)
  })

  it('TC-S2-11 提交前后空白 → 存 trim 值，GET /me 一致', async () => {
    const r = await post('/api/identity/profile', { displayName: '  Alice  ' }, { token: state.member.accessToken })
    assert.equal(r.status, 200)
    assert.equal(r.json.user.displayName, 'Alice')
    assert.equal((await get('/api/identity/me', { token: state.member.accessToken })).json.user.displayName, 'Alice')
  })

  it('TC-S2-12 后写覆盖：Alice → Bob，GET /me 为 Bob', async () => {
    assert.equal((await post('/api/identity/profile', { displayName: 'Alice' }, { token: state.member.accessToken })).status, 200)
    const r = await post('/api/identity/profile', { displayName: 'Bob' }, { token: state.member.accessToken })
    assert.equal(r.status, 200)
    assert.equal(r.json.user.displayName, 'Bob')
    assert.equal((await get('/api/identity/me', { token: state.member.accessToken })).json.user.displayName, 'Bob')
  })

  it('TC-S2-13 写后读：userId/name/displayName/createdAt/disabled 一致', async () => {
    const w = await post('/api/identity/profile', { displayName: 'Alice' }, { token: state.member.accessToken })
    const m = await get('/api/identity/me', { token: state.member.accessToken })
    for (const k of ['userId', 'name', 'displayName', 'createdAt', 'disabled']) assert.equal(m.json.user[k], w.json.user[k], k)
  })

  it('TC-S2-14 两个用户可同名；管理员列表同时有 displayName 与 name', async () => {
    assert.equal((await post('/api/identity/profile', { displayName: '同名' }, { token: state.same1.accessToken })).status, 200)
    assert.equal((await post('/api/identity/profile', { displayName: '同名' }, { token: state.same2.accessToken })).status, 200)
    const r = await get('/api/identity/users', { token: state.adminToken })
    assert.equal(r.status, 200)
    const same = r.json.users.filter((u) => u.displayName === '同名')
    assert.equal(same.length, 2)
    assert.deepEqual(same.map((u) => u.name).sort(), ['同名乙', '同名甲'])
  })

  const failureCases = [
    ['TC-S2-20', '缺 displayName', {}],
    ['TC-S2-21', '空字符串', { displayName: '' }],
    ['TC-S2-22', '全空格', { displayName: '   ' }],
    ['TC-S2-23', '65 字符', { displayName: 'A'.repeat(65) }],
    ['TC-S2-24', '含 U+0000', { displayName: `Ali${String.fromCharCode(0)}ce` }],
    ['TC-S2-25', '含 U+000A', { displayName: `Ali${String.fromCharCode(10)}ce` }],
    ['TC-S2-26', 'displayName 非字符串', { displayName: 42 }],
  ]
  for (const [id, label, body] of failureCases) {
    it(`${id} 非法输入（${label}）→ 400 IDENTITY_INVALID_INPUT 且不写库`, async () => {
      const before = (await get('/api/identity/me', { token: state.member.accessToken })).json.user.displayName
      const r = await post('/api/identity/profile', body, { token: state.member.accessToken })
      assert.equal(r.status, 400, r.text.slice(0, 160))
      assert.equal(r.json.ok, false)
      assert.equal(r.json.code, 'IDENTITY_INVALID_INPUT')
      assert.equal((await get('/api/identity/me', { token: state.member.accessToken })).json.user.displayName, before)
    })
  }

  it('TC-S2-27 请求体为 null/[]/"x"/42/true → 400 IDENTITY_INVALID_INPUT', async () => {
    for (const body of [null, [], 'x', 42, true]) {
      const r = await post('/api/identity/profile', body, { token: state.member.accessToken })
      assert.equal(r.status, 400, JSON.stringify(body))
      assert.equal(r.json.code, 'IDENTITY_INVALID_INPUT')
    }
  })

  it('TC-S2-28 非法 JSON → 400 IDENTITY_INVALID_INPUT（不是 REQUEST_FAILED）', async () => {
    const r = await call('POST', '/api/identity/profile', { rawBody: '{displayName:', token: state.member.accessToken })
    assert.equal(r.status, 400)
    assert.equal(r.json.code, 'IDENTITY_INVALID_INPUT')
  })

  it('TC-S2-29 请求体带 userId → 400，本人与他人 displayName 都未变', async () => {
    const beforeSelf = (await get('/api/identity/me', { token: state.member.accessToken })).json.user.displayName
    const beforeOther = (await get('/api/identity/me', { token: state.member2.accessToken })).json.user.displayName
    const r = await post('/api/identity/profile', { displayName: 'Hacked', userId: state.member2Id }, { token: state.member.accessToken })
    assert.equal(r.status, 400)
    assert.equal(r.json.code, 'IDENTITY_INVALID_INPUT')
    assert.equal((await get('/api/identity/me', { token: state.member.accessToken })).json.user.displayName, beforeSelf)
    assert.equal((await get('/api/identity/me', { token: state.member2.accessToken })).json.user.displayName, beforeOther)
  })

  it('TC-S2-30 请求体带 name → 400，用户名不变且仍可登录', async () => {
    const r = await post('/api/identity/profile', { displayName: 'Alice', name: 'hacker' }, { token: state.member.accessToken })
    assert.equal(r.status, 400)
    assert.equal((await get('/api/identity/me', { token: state.member.accessToken })).json.user.name, '小兵')
    assert.equal((await post('/api/identity/login', { name: '小兵', password: 'soldier-password' })).status, 200)
  })

  it('TC-S2-31 请求体带 password → 400，旧口令仍能登录', async () => {
    const r = await post('/api/identity/profile', { displayName: 'Alice', password: 'x' }, { token: state.member.accessToken })
    assert.equal(r.status, 400)
    assert.equal((await post('/api/identity/login', { name: '小兵', password: 'soldier-password' })).status, 200)
  })

  it('TC-S2-32 仅含 displayName 的请求只改本人；他人逐字段未变', async () => {
    const before = (await get('/api/identity/me', { token: state.member2.accessToken })).json.user
    const r = await post('/api/identity/profile', { displayName: '小兵新名' }, { token: state.member.accessToken })
    assert.equal(r.status, 200)
    assert.equal(r.json.user.displayName, '小兵新名')
    const after = (await get('/api/identity/me', { token: state.member2.accessToken })).json.user
    assert.deepEqual(after, before)
  })

  it('TC-S2-33 每条失败后 GET /me 仍是失败前的值', async () => {
    const before = (await get('/api/identity/me', { token: state.member.accessToken })).json.user.displayName
    const bads = [null, [], 'x', 42, true, {}, { displayName: '' }, { displayName: '   ' }, { displayName: 'A'.repeat(65) }, { displayName: 'x', userId: 'u' }]
    for (const body of bads) {
      const r = await post('/api/identity/profile', body, { token: state.member.accessToken })
      assert.equal(r.status, 400, JSON.stringify(body))
      assert.equal((await get('/api/identity/me', { token: state.member.accessToken })).json.user.displayName, before)
    }
  })

  it('TC-S2-40…44 /profile 的 401 具名码齐全且未写入', async () => {
    const before = (await get('/api/identity/me', { token: state.member.accessToken })).json.user.displayName
    const missing = await post('/api/identity/profile', { displayName: 'x' })
    assert.equal(missing.status, 401)
    assert.equal(missing.json.code, 'IDENTITY_TOKEN_MISSING')

    const malformed = await post('/api/identity/profile', { displayName: 'x' }, { token: 'not-a-token' })
    assert.equal(malformed.status, 401)
    assert.equal(malformed.json.code, 'IDENTITY_TOKEN_MALFORMED')

    const [v, body, sig] = state.member.accessToken.split('.')
    const bad = `${v}.${body}.${'A'.repeat(sig.length)}`
    const badSig = await post('/api/identity/profile', { displayName: 'x' }, { token: bad })
    assert.equal(badSig.status, 401)
    assert.equal(badSig.json.code, 'IDENTITY_TOKEN_BAD_SIGNATURE')

    const expired = await login('小兵', 'soldier-password', '过期写')
    mod.db.prepare('UPDATE hub_user_sessions SET access_expires_at_ms=? WHERE id=?').run(Date.now() - 1000, expired.sessionId)
    const exp = await post('/api/identity/profile', { displayName: 'x' }, { token: expired.accessToken })
    assert.equal(exp.status, 401)
    assert.equal(exp.json.code, 'IDENTITY_TOKEN_EXPIRED')

    const revoked = await login('小兵', 'soldier-password', '撤销写')
    await post('/api/identity/sessions/revoke', { sessionId: revoked.sessionId }, { token: state.member.accessToken })
    const rev = await post('/api/identity/profile', { displayName: 'x' }, { token: revoked.accessToken })
    assert.equal(rev.status, 401)
    assert.equal(rev.json.code, 'IDENTITY_SESSION_REVOKED')

    assert.equal((await get('/api/identity/me', { token: state.member.accessToken })).json.user.displayName, before)
  })

  it('TC-S2-45 停用后：旧访问令牌 / 登录 / 刷新三路全拒', async () => {
    const disable = await post('/api/identity/users/disable', { userId: state.disabled.userId, disabled: true }, { token: state.adminToken })
    assert.equal(disable.status, 200, disable.text.slice(0, 160))

    const oldToken = await get('/api/identity/me', { token: state.disabled.accessToken })
    assert.equal(oldToken.status, 401)
    assert.equal(oldToken.json.code, 'IDENTITY_SESSION_REVOKED')

    const relogin = await post('/api/identity/login', { name: '停用兵', password: 'disabled-password' })
    assert.equal(relogin.status, 401)
    assert.equal(relogin.json.code, 'IDENTITY_INVALID_CREDENTIALS')

    const refreshed = await post('/api/identity/refresh', { refreshToken: state.disabled.refreshToken })
    assert.equal(refreshed.status, 401)
    assert.equal(refreshed.json.code, 'IDENTITY_SESSION_REVOKED')
  })

  it('TC-S2-46 非管理员读用户列表 → 403 IDENTITY_FORBIDDEN 且无用户数据', async () => {
    const r = await get('/api/identity/users', { token: state.member.accessToken })
    assert.equal(r.status, 403)
    assert.equal(r.json.code, 'IDENTITY_FORBIDDEN')
    assert.equal('users' in r.json, false)
  })

  it('TC-S2-47 管理员用户列表每行同时有 displayName 与 name', async () => {
    const r = await get('/api/identity/users', { token: state.adminToken })
    assert.equal(r.status, 200)
    assert.ok(r.json.users.length >= 2)
    for (const u of r.json.users) {
      assert.equal(typeof u.displayName, 'string')
      assert.equal(typeof u.name, 'string')
    }
  })

  it('TC-S2-48 管理员与普通成员的 systemRole 分别为 admin / none', async () => {
    assert.equal((await get('/api/identity/me', { token: state.adminToken })).json.systemRole, 'admin')
    assert.equal((await get('/api/identity/me', { token: state.member.accessToken })).json.systemRole, 'none')
  })

  it('TC-S2-50 旧客户端只读旧四字段仍正常', async () => {
    const r = await get('/api/identity/me', { token: state.member.accessToken })
    const legacyView = { userId: r.json.user.userId, name: r.json.user.name, roles: r.json.roles, systemRole: r.json.systemRole }
    assert.equal(typeof legacyView.userId, 'string')
    assert.equal(typeof legacyView.name, 'string')
    assert.ok(Array.isArray(legacyView.roles))
    assert.ok(['admin', 'none'].includes(legacyView.systemRole))
  })

  it('TC-S2-51 成功/失败形状：JSON + ok 布尔 + 可读中文错误，无堆栈', async () => {
    const ok = await post('/api/identity/profile', { displayName: '契约形状' }, { token: state.member.accessToken })
    assert.match(ok.contentType, /application\/json/)
    assert.equal(ok.json.ok, true)
    const bad = await post('/api/identity/profile', {}, { token: state.member.accessToken })
    assert.match(bad.contentType, /application\/json/)
    assert.equal(bad.json.ok, false)
    assert.equal(typeof bad.json.code, 'string')
    assert.equal(typeof bad.json.error, 'string')
    assert.equal(/<[a-z]/i.test(bad.json.error), false)
  })

  it('TC-S2-52 失败请求不新增 profile-update 审计行', async () => {
    const count = () => mod.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='identity:profile-update'").get().n
    const before = count()
    assert.equal((await post('/api/identity/profile', { displayName: 'A'.repeat(65) }, { token: state.member.accessToken })).status, 400)
    assert.equal(count(), before)
  })

  it('TC-S2-53 资料更新不撤销会话', async () => {
    const before = (await get('/api/identity/sessions', { token: state.member.accessToken })).json.sessions
    assert.equal((await post('/api/identity/profile', { displayName: '会话实验' }, { token: state.member.accessToken })).status, 200)
    const after = (await get('/api/identity/sessions', { token: state.member.accessToken })).json.sessions
    assert.deepEqual(after.map((s) => ({ id: s.sessionId, revoked: s.revoked })), before.map((s) => ({ id: s.sessionId, revoked: s.revoked })))
  })

  it('TC-S2-54 资料更新不改口令：旧口令仍能登录', async () => {
    assert.equal((await post('/api/identity/profile', { displayName: '口令实验' }, { token: state.member.accessToken })).status, 200)
    assert.equal((await post('/api/identity/login', { name: '小兵', password: 'soldier-password' })).status, 200)
  })

  it('TC-S2-55 资料更新不碰执行设备列表', async () => {
    const before = (await get('/api/devices', { token: state.member.accessToken })).json.devices
    assert.equal((await post('/api/identity/profile', { displayName: '设备实验' }, { token: state.member.accessToken })).status, 200)
    const after = (await get('/api/devices', { token: state.member.accessToken })).json.devices
    assert.deepEqual(after, before)
  })
})
