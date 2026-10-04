// team-hub/user-store.test.mjs
// 远程 Agent 通道 S-B：用户身份、会话与空间授权。
//
// 重点覆盖**安全性质**，而不是"函数能跑"：撤销立即生效、刷新凭据轮换、
// 用户不存在与口令错误不可区分、邀请码只能消费一次、空格授权默认拒绝。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import {
  ACCESS_TOKEN_TTL_MS,
  IDENTITY_CODES,
  IdentityError,
  LOGIN_MAX_FAILURES,
  REFRESH_TOKEN_TTL_MS,
  SPACE_ROLES,
  createUserStore,
  hashPassword,
  verifyPassword,
} from './user-store.mjs'

const KEY = 'test-signing-key-0123456789'

/** 内存库 + 与 server.mjs 同形的 withTx（同样用 BEGIN IMMEDIATE + SAVEPOINT 嵌套）。 */
function makeStore({ clock = { now: Date.now() }, auditLog = null } = {}) {
  const db = new DatabaseSync(':memory:')
  let depth = 0
  const withTx = (mutate) => {
    const nested = depth > 0
    const name = `tx_sp_${depth + 1}`
    if (nested) db.exec(`SAVEPOINT ${name}`)
    else db.exec('BEGIN IMMEDIATE')
    depth += 1
    try {
      const r = mutate()
      if (nested) db.exec(`RELEASE ${name}`)
      else db.exec('COMMIT')
      depth -= 1
      return r
    } catch (e) {
      depth -= 1
      try {
        if (nested) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`) }
        else db.exec('ROLLBACK')
      } catch { /* 保留原异常 */ }
      throw e
    }
  }
  const audit = auditLog === null ? null : (actor, scope, action, taskId, detail) => {
    auditLog.push({ actor, scope, action, detail })
  }
  const store = createUserStore({ db, withTx, clock: () => clock.now, key: KEY, audit })
  return { db, store, clock, withTx, auditLog }
}

async function bootstrapped(opts = {}) {
  const ctx = makeStore(opts)
  const owner = await ctx.store.bootstrapOwner({ name: 'owner', password: 'owner-password', authorized: true })
  return { ...ctx, owner }
}

const codeOf = async (fn) => {
  try { await fn(); return null } catch (e) { return e instanceof IdentityError ? e.code : `UNEXPECTED:${e.message}` }
}

// ── 口令哈希 ────────────────────────────────────────────────────────────────

test('口令哈希自带参数与随机盐，同口令两次得到不同哈希', async () => {
  const a = await hashPassword('same-password')
  const b = await hashPassword('same-password')
  assert.notEqual(a, b)
  assert.match(a, /^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]{32}\$[0-9a-f]{128}$/)
  // 参数随哈希存储：以后调高成本时老口令仍能验证。
  assert.equal((await verifyPassword('same-password', a)).ok, true)
  assert.equal((await verifyPassword('wrong-password', a)).ok, false)
})

test('verifyPassword 对畸形存储返回 false 而不是抛错', async () => {
  for (const bad of ['', 'plaintext', 'scrypt$1$2$3$zz$zz', 'scrypt$x$8$1$00$00', null, undefined]) {
    assert.equal((await verifyPassword('x', bad)).ok, false, `畸形哈希 ${JSON.stringify(bad)} 应返回 false`)
  }
})

test('needsRehash 在存储参数落后于当前参数时为 true', async () => {
  const weak = await hashPassword('pw', { N: 1024, r: 8, p: 1, keylen: 64 })
  const v = await verifyPassword('pw', weak)
  assert.equal(v.ok, true)
  assert.equal(v.needsRehash, true, '低成本参数的旧哈希应被标记为待升级')
})

// ── 引导 ────────────────────────────────────────────────────────────────────

test('引导只在空库成功，且必须有管理令牌', async () => {
  const ctx = makeStore()
  assert.equal(ctx.store.isBootstrapped(), false)
  assert.equal(await codeOf(() => ctx.store.bootstrapOwner({ name: 'a', password: 'password-1' })), IDENTITY_CODES.BOOTSTRAP_DENIED)

  await ctx.store.bootstrapOwner({ name: 'owner', password: 'password-1', authorized: true })
  assert.equal(ctx.store.isBootstrapped(), true)

  // 第二次引导（哪怕换个名字）必须被拒：否则任何人都能再造一个 owner。
  assert.equal(await codeOf(() => ctx.store.bootstrapOwner({ name: 'second', password: 'password-2', authorized: true })), IDENTITY_CODES.ALREADY_BOOTSTRAPPED)
})

test('引导时口令与用户名的下限被强制', async () => {
  const ctx = makeStore()
  assert.equal(await codeOf(() => ctx.store.bootstrapOwner({ name: 'a', password: 'short', authorized: true })), IDENTITY_CODES.INVALID_INPUT)
  assert.equal(await codeOf(() => ctx.store.bootstrapOwner({ name: '   ', password: 'long-enough-password', authorized: true })), IDENTITY_CODES.INVALID_INPUT)
})

// ── 登录 ────────────────────────────────────────────────────────────────────

test('登录成功签发访问令牌与刷新凭据，令牌可被校验', async () => {
  const { store, owner } = await bootstrapped()
  const session = await store.login({ name: 'owner', password: 'owner-password', label: '手机' })
  assert.equal(session.userId, owner.userId)
  assert.match(session.accessToken, /^v1\./)
  assert.equal(session.needsPasswordUpgrade, false)

  const verified = store.verifyAccessToken(session.accessToken)
  assert.equal(verified.ok, true)
  assert.equal(verified.userId, owner.userId)
  assert.equal(verified.sessionId, session.sessionId)

  // 库里不能出现明文刷新凭据。
  const row = store._internals
  const stored = store.listSessions(owner.userId)
  assert.equal(stored.length, 1)
  assert.equal(stored[0].label, '手机')
  assert.ok(row.hashSecret(session.refreshToken) !== session.refreshToken)
})

test('用户不存在与口令错误返回同一个码（不做用户名枚举）', async () => {
  const { store } = await bootstrapped()
  const missing = await codeOf(() => store.login({ name: 'nobody', password: 'whatever-password' }))
  const wrong = await codeOf(() => store.login({ name: 'owner', password: 'wrong-password' }))
  assert.equal(missing, IDENTITY_CODES.INVALID_CREDENTIALS)
  assert.equal(wrong, IDENTITY_CODES.INVALID_CREDENTIALS)
  // ★ 两者必须**同码**：不同码（或不同耗时）等于告诉攻击者"这个用户名存在"。
})

test('连续失败触发锁定，成功登录后清零', async () => {
  const { store } = await bootstrapped()
  for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) {
    await codeOf(() => store.login({ name: 'owner', password: 'wrong-password' }))
  }
  // 第 N 次失败后进入锁定。
  assert.equal(await codeOf(() => store.login({ name: 'owner', password: 'owner-password' })), IDENTITY_CODES.ACCOUNT_LOCKED)

  // 锁定到期后可以用正确口令登录，且失败计数被清掉。
  const ctx = await bootstrapped()
  for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i += 1) {
    await codeOf(() => ctx.store.login({ name: 'owner', password: 'wrong-password' }))
  }
  const session = await ctx.store.login({ name: 'owner', password: 'owner-password' })
  assert.ok(session.accessToken)
  const after = await ctx.store.login({ name: 'owner', password: 'owner-password' })
  assert.ok(after.accessToken, '成功登录后失败计数应已清零')
})

test('停用的账号不能登录，登录后停用会让既有会话失效', async () => {
  const { store, owner } = await bootstrapped()
  const session2 = await store.login({ name: 'owner', password: 'owner-password' })
  const { createInvite, acceptInvite } = store
  const invite = createInvite({ by: owner.userId, space: 'software', role: 'member' })
  const invited = await acceptInvite({ code: invite.code, name: 'member1', password: 'member-password' })

  assert.equal(store.verifyAccessToken(session2.accessToken).ok, true)
  store.setUserDisabled({ by: owner.userId, userId: invited.userId, disabled: true })
  assert.equal(await codeOf(() => store.login({ name: 'member1', password: 'member-password' })), IDENTITY_CODES.INVALID_CREDENTIALS)
})

// ── 撤销与刷新 ──────────────────────────────────────────────────────────────

test('撤销会话后访问令牌**立即**失效（不等到自然过期）', async () => {
  const { store } = await bootstrapped()
  const session = await store.login({ name: 'owner', password: 'owner-password' })
  assert.equal(store.verifyAccessToken(session.accessToken).ok, true)
  store.revokeSession({ sessionId: session.sessionId })
  const after = store.verifyAccessToken(session.accessToken)
  assert.equal(after.ok, false)
  assert.equal(after.code, IDENTITY_CODES.SESSION_REVOKED)
})

test('伪造与篡改的访问令牌被拒', async () => {
  const { store, owner } = await bootstrapped()
  const session = await store.login({ name: 'owner', password: 'owner-password' })
  const [v1, body, sig] = session.accessToken.split('.')
  // 换掉载荷但留旧签名（冒充另一个用户/session）。
  const forged = Buffer.from(JSON.stringify({ sub: owner.userId, sid: 'sess-forged', exp: Date.now() + 60000, iat: Date.now() })).toString('base64url')
  assert.equal(store.verifyAccessToken(`v1.${forged}.${sig}`).code, IDENTITY_CODES.TOKEN_BAD_SIGNATURE)
  assert.equal(store.verifyAccessToken('v1.' + body).code, IDENTITY_CODES.TOKEN_MALFORMED)
  assert.equal(store.verifyAccessToken('').code, IDENTITY_CODES.TOKEN_MALFORMED)
  assert.equal(store.verifyAccessToken('garbage').code, IDENTITY_CODES.TOKEN_MALFORMED)
})

test('访问令牌过期后报 expired，而刷新凭据仍可用', async () => {
  const clock = { now: Date.now() }
  const { store } = await bootstrapped({ clock })
  const session = await store.login({ name: 'owner', password: 'owner-password' })
  clock.now += ACCESS_TOKEN_TTL_MS + 1000
  const expired = store.verifyAccessToken(session.accessToken)
  assert.equal(expired.ok, false)
  assert.equal(expired.code, IDENTITY_CODES.TOKEN_EXPIRED)
  // 会话本身没过期，刷新仍然成功。
  const refreshed = store.refresh({ refreshToken: session.refreshToken })
  assert.equal(store.verifyAccessToken(refreshed.accessToken).ok, true)
})

test('刷新轮换凭据：旧刷新凭据再用一次即失效', async () => {
  const { store } = await bootstrapped()
  const session = await store.login({ name: 'owner', password: 'owner-password' })
  const second = store.refresh({ refreshToken: session.refreshToken })
  assert.notEqual(second.refreshToken, session.refreshToken)
  // 旧凭据已不再匹配任何会话行。
  assert.equal(await codeOf(() => store.refresh({ refreshToken: session.refreshToken })), IDENTITY_CODES.SESSION_NOT_FOUND)
  // 新凭据可用。
  const third = store.refresh({ refreshToken: second.refreshToken })
  assert.ok(third.accessToken)
})

test('刷新凭据过期后拒绝，且过期的会话不能再用旧访问令牌', async () => {
  const clock = { now: Date.now() }
  const { store } = await bootstrapped({ clock })
  const session = await store.login({ name: 'owner', password: 'owner-password' })
  clock.now += REFRESH_TOKEN_TTL_MS + 1000
  assert.equal(await codeOf(() => store.refresh({ refreshToken: session.refreshToken })), IDENTITY_CODES.SESSION_EXPIRED)
  assert.equal(store.verifyAccessToken(session.accessToken).code, IDENTITY_CODES.SESSION_EXPIRED)
})

test('撤销全部会话时会话计数正确，且可保留当前会话', async () => {
  const { store, owner } = await bootstrapped()
  const a = await store.login({ name: 'owner', password: 'owner-password' })
  const b = await store.login({ name: 'owner', password: 'owner-password' })
  const c = await store.login({ name: 'owner', password: 'owner-password' })
  const res = store.revokeAllSessions({ userId: owner.userId, exceptSessionId: b.sessionId })
  assert.equal(res.revoked, 2)
  assert.equal(store.verifyAccessToken(a.accessToken).ok, false)
  assert.equal(store.verifyAccessToken(c.accessToken).ok, false)
  assert.equal(store.verifyAccessToken(b.accessToken).ok, true)
})

test('撤销不存在的会话返回 404，重复撤销是幂等的', async () => {
  const { store } = await bootstrapped()
  const session = await store.login({ name: 'owner', password: 'owner-password' })
  assert.equal(store.revokeSession({ sessionId: session.sessionId }).revoked, true)
  const again = store.revokeSession({ sessionId: session.sessionId })
  assert.equal(again.revoked, false)
  assert.equal(again.alreadyRevoked, true)
  assert.equal(await codeOf(() => store.revokeSession({ sessionId: 'sess-nope' })), IDENTITY_CODES.SESSION_NOT_FOUND)
})

// ── 邀请 ────────────────────────────────────────────────────────────────────

test('邀请码一次性消费：重复使用被拒', async () => {
  const { store, owner } = await bootstrapped()
  const invite = store.createInvite({ by: owner.userId, space: 'software', role: 'member' })
  const first = await store.acceptInvite({ code: invite.code, name: 'u1', password: 'password-1' })
  assert.equal(first.space, 'software')
  assert.equal(first.role, 'member')
  assert.equal(await codeOf(() => store.acceptInvite({ code: invite.code, name: 'u2', password: 'password-2' })), IDENTITY_CODES.INVITE_CONSUMED)
})

test('邀请码过期后被拒，且库里不存明文', async () => {
  const clock = { now: Date.now() }
  const { store, owner } = await bootstrapped({ clock })
  const invite = store.createInvite({ by: owner.userId, space: 'software', role: 'viewer', ttlMs: 1000 })
  clock.now += 2000
  assert.equal(await codeOf(() => store.acceptInvite({ code: invite.code, name: 'u1', password: 'password-1' })), IDENTITY_CODES.INVITE_EXPIRED)
})

test('编造的邀请码返回 not found，不给出"接近正确"的提示', async () => {
  const { store } = await bootstrapped()
  assert.equal(await codeOf(() => store.acceptInvite({ code: 'made-up-code', name: 'u1', password: 'password-1' })), IDENTITY_CODES.INVITE_NOT_FOUND)
})

test('邀请不能授予 owner（把空间交出去只能由 owner 直接授权）', async () => {
  const { store, owner } = await bootstrapped()
  assert.equal(await codeOf(() => store.createInvite({ by: owner.userId, space: 'software', role: 'owner' })), IDENTITY_CODES.FORBIDDEN)
})

test('接受邀请时用户名重复被拒，且不消费邀请码', async () => {
  const { store, owner } = await bootstrapped()
  const invite = store.createInvite({ by: owner.userId, space: 'software', role: 'member' })
  assert.equal(await codeOf(() => store.acceptInvite({ code: invite.code, name: 'owner', password: 'password-9' })), IDENTITY_CODES.NAME_TAKEN)
  // 邀请码必须还能用：否则一次重名输入就把这个邀请作废了。
  const ok = await store.acceptInvite({ code: invite.code, name: 'owner2', password: 'password-9' })
  assert.ok(ok.userId)
})

// ── 空间授权 ────────────────────────────────────────────────────────────────

test('空格授权默认拒绝（没有角色行就是没有权限）', async () => {
  const { store, owner } = await bootstrapped()
  assert.equal(store.hasRoleAtLeast(owner.userId, 'software', 'viewer'), false)
  assert.equal(store.roleIn(owner.userId, 'software'), null)
})

test('角色等级单调：高角色满足低要求，反之不成立', async () => {
  const { store, owner } = await bootstrapped()
  store.grantSpaceRole({ by: owner.userId, userId: owner.userId, space: 'software', role: 'owner' })
  for (const role of SPACE_ROLES) {
    assert.equal(store.hasRoleAtLeast(owner.userId, 'software', role), true, `owner 应满足 ${role}`)
  }
  store.grantSpaceRole({ by: owner.userId, userId: owner.userId, space: 'other', role: 'viewer' })
  assert.equal(store.hasRoleAtLeast(owner.userId, 'other', 'viewer'), true)
  assert.equal(store.hasRoleAtLeast(owner.userId, 'other', 'member'), false)
  assert.equal(store.hasRoleAtLeast(owner.userId, 'other', 'admin'), false)
})

test('非 admin 不能授予角色；只有 owner 能授予 owner', async () => {
  const { store, owner } = await bootstrapped()
  store.grantSpaceRole({ by: owner.userId, userId: owner.userId, space: 'software', role: 'owner' })
  const invite = store.createInvite({ by: owner.userId, space: 'software', role: 'member' })
  const member = await store.acceptInvite({ code: invite.code, name: 'member1', password: 'password-1' })

  assert.equal(await codeOf(() => store.grantSpaceRole({ by: member.userId, userId: owner.userId, space: 'software', role: 'viewer' })), IDENTITY_CODES.FORBIDDEN)
  // member 不能造邀请（邀请需要 admin）。
  assert.equal(await codeOf(() => store.createInvite({ by: member.userId, space: 'software', role: 'member' })), IDENTITY_CODES.FORBIDDEN)

  // 升到 admin 后可以造邀请，但仍不能授予 owner。
  store.grantSpaceRole({ by: owner.userId, userId: member.userId, space: 'software', role: 'admin' })
  assert.ok(store.createInvite({ by: member.userId, space: 'software', role: 'member' }).code)
  assert.equal(await codeOf(() => store.grantSpaceRole({ by: member.userId, userId: owner.userId, space: 'software', role: 'owner' })), IDENTITY_CODES.FORBIDDEN)
})

test('撤销空间角色后立即失去权限', async () => {
  const { store, owner } = await bootstrapped()
  const invite = store.createInvite({ by: owner.userId, space: 'software', role: 'member' })
  const u = await store.acceptInvite({ code: invite.code, name: 'u1', password: 'password-1' })
  assert.equal(store.hasRoleAtLeast(u.userId, 'software', 'viewer'), true)
  store.revokeSpaceRole({ by: owner.userId, userId: u.userId, space: 'software' })
  assert.equal(store.hasRoleAtLeast(u.userId, 'software', 'viewer'), false)
  assert.deepEqual(store.rolesOf(u.userId), [])
})

test('非法 space 与非法角色被拒', async () => {
  const { store, owner } = await bootstrapped()
  for (const bad of ['Software', 'a b', '', '-x', 'x'.repeat(65), null]) {
    assert.equal(await codeOf(() => store.grantSpaceRole({ by: owner.userId, userId: owner.userId, space: bad, role: 'member' })), IDENTITY_CODES.INVALID_INPUT, `space=${JSON.stringify(bad)} 应被拒`)
  }
  assert.equal(await codeOf(() => store.grantSpaceRole({ by: owner.userId, userId: owner.userId, space: 'ok', role: 'root' })), IDENTITY_CODES.INVALID_INPUT)
})

// ── 审计与配置 ──────────────────────────────────────────────────────────────

test('关键动作写入审计，且审计里不含明文凭据', async () => {
  const auditLog = []
  const { store, owner } = await bootstrapped({ auditLog })
  const invite = store.createInvite({ by: owner.userId, space: 'software', role: 'member' })
  await store.acceptInvite({ code: invite.code, name: 'u1', password: 'password-1' })
  const session = await store.login({ name: 'u1', password: 'password-1' })
  store.revokeSession({ sessionId: session.sessionId })

  const actions = auditLog.map((a) => a.action)
  for (const expected of ['identity:bootstrap-owner', 'identity:invite-create', 'identity:invite-accept', 'identity:login', 'identity:session-revoke']) {
    assert.ok(actions.includes(expected), `审计缺少 ${expected}`)
  }
  const serialized = JSON.stringify(auditLog)
  assert.ok(!serialized.includes(invite.code), '审计不得记录邀请码明文')
  assert.ok(!serialized.includes(session.refreshToken), '审计不得记录刷新凭据明文')
  assert.ok(!serialized.includes('password-1'), '审计不得记录口令')
})

test('缺少签名密钥时构造直接失败（不留一个"能跑但没签名"的状态）', () => {
  const db = new DatabaseSync(':memory:')
  assert.throws(() => createUserStore({ db, withTx: (fn) => fn(), key: '' }), /HMAC key/)
  assert.throws(() => createUserStore({ db, withTx: (fn) => fn(), key: 'too-short' }), /HMAC key/)
})
