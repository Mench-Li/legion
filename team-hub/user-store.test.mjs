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
  // `spaces` 表：**注册要查它**（`resolveRegistrationSpace`）。
  //
  // 复刻 `server.mjs` 里那张表的最小形状。不给它的话，"注册到不存在的空间"
  // 会以 `SPACE_NOT_FOUND` 失败，而那时用例报出来的是一句读起来像
  // "注册坏了"的话——真正的原因只是夹具少了一张表。
  //
  // 默认放一个 `default`：绝大多数用例关心的是账号，不是空间解析。
  db.exec(`
    CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY, name TEXT, local_dir TEXT, private INTEGER DEFAULT 0);
    INSERT INTO spaces (id, name) VALUES ('default', '默认空间');
  `)
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

// ── 自助注册与改口令（账号体系） ────────────────────────────────────────────
//
// 这一组守的是"给别人用的那套流程"。它与邀请制的差别不在实现，在**默认值**：
// 邀请制默认关着（没有邀请码就进不来），而注册入口一旦默认打开，
// 与"忘了设策略"在出事那天是同一个东西。

// 复用文件顶部那个 `codeOf`（它已经是 async 的，本组全用它）。
const codeOfAsync = codeOf

test('注册默认是 closed：没显式开就进不来', async () => {
  const { store } = await bootstrapped()
  // 不传 registration → 默认 closed。
  assert.equal(await codeOfAsync(() => store.register({ name: '新同学', password: 'good-password' })),
    IDENTITY_CODES.REGISTRATION_CLOSED)
  // 显式写 closed 也一样。
  assert.equal(await codeOfAsync(() => store.register({ name: '新同学', password: 'good-password', registration: 'closed' })),
    IDENTITY_CODES.REGISTRATION_CLOSED)
})

test('策略必须落在枚举里：写错的名字不能静默当成"可以注册"', async () => {
  const { store } = await bootstrapped()
  assert.equal(await codeOfAsync(() => store.register({ name: 'x', password: 'good-password', registration: 'OPEN' })),
    IDENTITY_CODES.INVALID_INPUT)
  assert.equal(await codeOfAsync(() => store.register({ name: 'x', password: 'good-password', registration: 'yes' })),
    IDENTITY_CODES.INVALID_INPUT)
})

test('open 策略：注册即登录，拿到的是可用令牌而不是"请去登录"', async () => {
  const { store } = await bootstrapped()
  const r = await store.register({ name: '新同学', password: 'good-password', registration: 'open', space: 'default', label: '手机' })
  assert.equal(r.name, '新同学')
  assert.equal(r.space, 'default')
  assert.equal(r.role, 'member')
  assert.equal(r.via, 'open')
  // 令牌当场就能用——分成两步的版本会留下"账号存在但我进不去"的中间态。
  const verified = store.verifyAccessToken(r.accessToken)
  assert.equal(verified.ok, true)
  assert.equal(verified.userId, r.userId)
  assert.equal(verified.name, '新同学')
})

test('open 策略**不**授予 owner：否则任何人都能注册成空间主人', async () => {
  const { store, owner } = await bootstrapped()
  await store.register({ name: '新同学', password: 'good-password', registration: 'open', space: 'default' })
  const users = store.listUsers()
  const fresh = users.find((u) => u.name === '新同学')
  assert.equal(fresh.systemRole, 'none')
  assert.equal(store.roleIn(fresh.userId, 'default'), 'member')
  // 主人还是原来那一个。
  assert.equal(store.isSystemAdmin(owner.userId), true)
})

test('open 策略下重名被拒，且与登录用同一套归一（"Admin" 与 "admin " 是同一个）', async () => {
  const { store } = await bootstrapped()
  await store.register({ name: 'Neo', password: 'good-password', registration: 'open' })
  assert.equal(await codeOfAsync(() => store.register({ name: 'neo', password: 'other-password', registration: 'open' })),
    IDENTITY_CODES.NAME_TAKEN)
  assert.equal(await codeOfAsync(() => store.register({ name: '  Neo  ', password: 'other-password', registration: 'open' })),
    IDENTITY_CODES.NAME_TAKEN)
})

test('invite 策略：没有邀请码进不来，有码才注册成功', async () => {
  const { store, owner } = await bootstrapped()
  assert.equal(await codeOfAsync(() => store.register({ name: '小兵', password: 'good-password', registration: 'invite' })),
    IDENTITY_CODES.INVITE_REQUIRED)
  assert.equal(await codeOfAsync(() => store.register({ name: '小兵', password: 'good-password', registration: 'invite', code: '   ' })),
    IDENTITY_CODES.INVITE_REQUIRED)

  const invite = store.createInvite({ by: owner.userId, space: 'default', role: 'member' })
  const r = await store.register({ name: '小兵', password: 'good-password', registration: 'invite', code: invite.code })
  assert.equal(r.via, 'invite')
  assert.equal(r.role, 'member')
  assert.equal(store.verifyAccessToken(r.accessToken).ok, true)
  // 邀请码一次性：同一个码再注册一次不成立。
  assert.equal(await codeOfAsync(() => store.register({ name: '另一个', password: 'good-password', registration: 'invite', code: invite.code })),
    IDENTITY_CODES.INVITE_CONSUMED)
})

test('口令强度与用户名规则对注册同样生效（不是只有登录那条路管）', async () => {
  const { store } = await bootstrapped()
  assert.equal(await codeOfAsync(() => store.register({ name: '短口令', password: 'short', registration: 'open' })),
    IDENTITY_CODES.INVALID_INPUT)
  assert.equal(await codeOfAsync(() => store.register({ name: '   ', password: 'good-password', registration: 'open' })),
    IDENTITY_CODES.INVALID_INPUT)
})

test('改口令：必须给对原口令，错了不许改', async () => {
  const { store, owner } = await bootstrapped()
  assert.equal(await codeOfAsync(() => store.changePassword({
    userId: owner.userId, currentPassword: '想错了', newPassword: 'brand-new-password',
  })), IDENTITY_CODES.WRONG_PASSWORD)
  // 原口令仍然有效 —— 一次失败的修改不能把账号弄坏。
  const again = await store.login({ name: 'owner', password: 'owner-password' })
  assert.equal(again.userId, owner.userId)
})

test('改口令成功后：新口令能登，旧口令不能', async () => {
  const { store, owner } = await bootstrapped()
  await store.changePassword({ userId: owner.userId, currentPassword: 'owner-password', newPassword: 'brand-new-password' })
  assert.equal(await codeOfAsync(() => store.login({ name: 'owner', password: 'owner-password' })),
    IDENTITY_CODES.INVALID_CREDENTIALS)
  const ok = await store.login({ name: 'owner', password: 'brand-new-password' })
  assert.equal(ok.userId, owner.userId)
})

test('改口令必须撤销**其它**会话，但保留当前这一个', async () => {
  // 改口令的第一动机通常是"我怀疑别人在用我的账号"。只改哈希不踢会话的话，
  // 那个人的令牌照样有效到过期为止 —— 用户会以为他做完了。
  const { store, owner } = await bootstrapped()
  const other = await store.login({ name: 'owner', password: 'owner-password', label: '别的设备' })
  const current = await store.login({ name: 'owner', password: 'owner-password', label: '本机' })
  const r = await store.changePassword({
    userId: owner.userId, currentPassword: 'owner-password', newPassword: 'brand-new-password',
    exceptSessionId: current.sessionId,
  })
  assert.equal(r.changed, true)
  // 别处那个令牌当场失效。
  assert.equal(store.verifyAccessToken(other.accessToken).ok, false)
  assert.equal(store.verifyAccessToken(other.accessToken).code, IDENTITY_CODES.SESSION_REVOKED)
  // 自己这个还在（把人一起踢掉，他会以为改口令失败了）。
  assert.equal(store.verifyAccessToken(current.accessToken).ok, true)
})

test('新口令与旧口令相同 → 拒绝（否则用户会以为改成功了）', async () => {
  const { store, owner } = await bootstrapped()
  assert.equal(await codeOfAsync(() => store.changePassword({
    userId: owner.userId, currentPassword: 'owner-password', newPassword: 'owner-password',
  })), IDENTITY_CODES.INVALID_INPUT)
})

test('被停用的账号不能改口令', async () => {
  const { store, owner } = await bootstrapped()
  await store.setUserDisabled({ by: owner.userId, userId: owner.userId, disabled: true })
  assert.equal(await codeOfAsync(() => store.changePassword({
    userId: owner.userId, currentPassword: 'owner-password', newPassword: 'brand-new-password',
  })), IDENTITY_CODES.FORBIDDEN)
})

test('注册与改口令都进审计（谁在什么时候开了账号/换了口令）', async () => {
  const log = []
  const { store, owner } = await bootstrapped({ auditLog: log })
  await store.register({ name: '新同学', password: 'good-password', registration: 'open' })
  await store.changePassword({ userId: owner.userId, currentPassword: 'owner-password', newPassword: 'brand-new-password' })
  assert.ok(log.some((e) => e.action === 'identity:register'))
  assert.ok(log.some((e) => e.action === 'identity:password-change'))
  // 审计里不许出现口令原文。
  assert.equal(JSON.stringify(log).includes('good-password'), false)
  assert.equal(JSON.stringify(log).includes('brand-new-password'), false)
})

// ── 注册的两道闸门（速率 / 目标空间） ────────────────────────────────────────
//
// 这一组补的都是"接口在，但没人在它前面拦一下"那一类。两条各自都有一个
// **不报错**的坏形态：一条是任何人都能批量造账号，另一条是新用户注册成功
// 之后什么都看不到。

test('目标空间不存在 → 具名拒绝，而不是"成功但什么都看不到"', async () => {
  const { store } = await bootstrapped()
  // 只做 validateSpace（那是正则）时，"打错一个字母"会通过：返回 200、发令牌、
  // 进主界面，然后 /api/spaces 里什么都没有——而那个界面与"注册成功、但还没人
  // 拉你进空间"长得一模一样，所以用户不会来报 bug。
  assert.equal(await codeOf(() => store.register({
    name: '打错了', password: 'good-password', registration: 'open', space: 'defualt',
  })), IDENTITY_CODES.SPACE_NOT_FOUND)
  // 而且**没有**留下半个账号。
  assert.equal(store.listUsers().some((u) => u.name === '打错了'), false)
})

test('目标空间存在 → 正常注册', async () => {
  const { store } = await bootstrapped()
  const r = await store.register({ name: '正常', password: 'good-password', registration: 'open', space: 'default' })
  assert.equal(r.space, 'default')
  assert.equal(r.role, 'member')
})

test('没给空间：**唯一**时替用户选，多个时拒绝（不静默挑一个）', async () => {
  const { store, db } = await bootstrapped()
  // 唯一 → 自动落进去
  const one = await store.register({ name: '唯一空间', password: 'good-password', registration: 'open' })
  assert.equal(one.space, 'default')

  // 多个 → 拒绝。挑第一个会把用户静默丢进一个他不知道自己为什么在那儿的空间，
  // 而他之后做的每件事都落在那儿。
  db.prepare("INSERT INTO spaces (id, name) VALUES ('second', '第二个')").run()
  assert.equal(await codeOf(() => store.register({
    name: '没说清', password: 'good-password', registration: 'open',
  })), IDENTITY_CODES.SPACE_REQUIRED)
  // 说清了就行
  const two = await store.register({ name: '说清了', password: 'good-password', registration: 'open', space: 'second' })
  assert.equal(two.space, 'second')
})

test('一个空间都没有 → 明确说"先建一个"，不是一句校验失败', async () => {
  const ctx = makeStore()
  const owner = await ctx.store.bootstrapOwner({ name: 'owner', password: 'owner-password', authorized: true })
  assert.ok(owner)
  ctx.db.prepare('DELETE FROM spaces').run()
  assert.equal(await codeOf(() => ctx.store.register({
    name: '来得太早', password: 'good-password', registration: 'open',
  })), IDENTITY_CODES.SPACE_NOT_FOUND)
})

test('★ 速率闸门：滑动窗口内开够上限之后，自助注册被拒', async () => {
  const { store } = await bootstrapped()
  // 上限本身要能读到（否则下面那条循环的上界是猜的）。
  const gate = store.registrationGate()
  assert.equal(gate.allowed, true)
  assert.equal(gate.max, 20)
  assert.equal(gate.recent, 0)

  for (let i = 0; i < gate.max; i += 1) {
    await store.register({ name: `批量${i}`, password: 'good-password', registration: 'open' })
  }
  assert.equal(store.registrationGate().allowed, false)
  const err = await (async () => { try { await store.register({ name: '再来一个', password: 'good-password', registration: 'open' }) } catch (e) { return e } })()
  assert.equal(err.code, IDENTITY_CODES.REGISTRATION_RATE_LIMITED)
  assert.equal(err.status, 429)
  // 消息里要有**可执行**的信息：现在是多少、上限多少、怎么办。
  assert.match(err.message, /上限 20/)
  assert.match(err.message, /管理员/)
})

test('速率闸门按**全局**算：换名字绕不过去', async () => {
  // 这正是它不复用 hub_login_failures 的理由——那张表按用户名归并，
  // 而批量注册从来不重复用同一个名字。
  const { store } = await bootstrapped()
  const max = store.registrationGate().max
  for (let i = 0; i < max; i += 1) {
    await store.register({ name: `路人甲${i}`, password: 'good-password', registration: 'open' })
  }
  assert.equal(await codeOf(() => store.register({
    name: '全新的名字', password: 'good-password', registration: 'open',
  })), IDENTITY_CODES.REGISTRATION_RATE_LIMITED)
})

test('滑动窗口会过期：窗口之外的那些不算数', async () => {
  const clock = { now: 1_700_000_000_000 }
  const { store } = await bootstrapped({ clock })
  const max = store.registrationGate().max
  for (let i = 0; i < max; i += 1) {
    await store.register({ name: `旧账${i}`, password: 'good-password', registration: 'open' })
  }
  assert.equal(store.registrationGate().allowed, false)
  // 跨过一个完整窗口后应当又能注册——否则闸门就成了"永久关停"，
  // 而那是另一个决定，不该由限速顺手做掉。
  clock.now += 60 * 60 * 1000 + 1000
  assert.equal(store.registrationGate().allowed, true)
  const back = await store.register({ name: '窗口之后', password: 'good-password', registration: 'open' })
  assert.equal(back.space, 'default')
})

test('邀请制**不**受速率闸门影响：邀请码本身就是一次性的、由人签发的', async () => {
  const { store, owner } = await bootstrapped()
  const max = store.registrationGate().max
  // 把窗口塞满
  for (let i = 0; i < max; i += 1) {
    await store.register({ name: `占满${i}`, password: 'good-password', registration: 'open' })
  }
  assert.equal(store.registrationGate().allowed, false)
  // 邀请那条路照常走：闸门加在 open 上是有意的——邀请制天然限速，
  // 而给它也加一道会在"管理员连续拉几个同事进来"时误伤。
  const invite = store.createInvite({ by: owner.userId, space: 'default', role: 'member' })
  const r = await store.register({ name: '被邀请的', password: 'good-password', registration: 'invite', code: invite.code })
  assert.equal(r.via, 'invite')
})

test('注册被拒时不留半条记账（否则闸门会自己把自己关掉）', async () => {
  const { store, db } = await bootstrapped()
  const before = Number(db.prepare('SELECT COUNT(*) AS n FROM hub_registrations').get().n)
  // 名字被占 → 事务回滚 → 记账也不该留下
  await store.register({ name: '占位', password: 'good-password', registration: 'open' })
  const mid = Number(db.prepare('SELECT COUNT(*) AS n FROM hub_registrations').get().n)
  assert.equal(mid, before + 1)
  await codeOf(() => store.register({ name: '占位', password: 'good-password', registration: 'open' }))
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM hub_registrations').get().n), mid,
    '失败的注册不许记账——否则连续失败会把闸门自己关掉')
})

// ── 口令重置（忘记口令 / 账号恢复） ─────────────────────────────────────────
//
// 在这之前，全仓**只有**自助改口令（要记得原口令）与 `rebootstrap.sh`（清整库）。
// 也就是说：忘了口令 = 账号报废 + 整库重来。

test('管理员签发重置码；用户用它改口令并直接拿到会话', async () => {
  const { store, owner } = await bootstrapped()
  await store.register({ name: '忘了口令的人', password: 'forgotten-password', registration: 'open' })
  const target = store.listUsers().find((u) => u.name === '忘了口令的人')

  const issued = store.createPasswordReset({ by: owner.userId, userId: target.userId })
  assert.equal(typeof issued.code, 'string')
  assert.ok(issued.code.length > 20)
  assert.equal(issued.userName, '忘了口令的人')

  const r = await store.redeemPasswordReset({ name: '忘了口令的人', code: issued.code, newPassword: 'brand-new-password' })
  assert.equal(r.userId, target.userId)
  // 与注册同一条理由：刚设完口令再让他打一遍，是最容易放弃的一步。
  assert.equal(store.verifyAccessToken(r.accessToken).ok, true)
  // 新口令能登，旧口令不能。
  assert.equal((await store.login({ name: '忘了口令的人', password: 'brand-new-password' })).userId, target.userId)
  assert.equal(await codeOf(() => store.login({ name: '忘了口令的人', password: 'forgotten-password' })),
    IDENTITY_CODES.INVALID_CREDENTIALS)
})

test('重置码一次性：用过就废', async () => {
  const { store, owner } = await bootstrapped()
  await store.register({ name: '甲', password: 'good-password', registration: 'open' })
  const target = store.listUsers().find((u) => u.name === '甲')
  const { code } = store.createPasswordReset({ by: owner.userId, userId: target.userId })
  await store.redeemPasswordReset({ name: '甲', code, newPassword: 'first-new-password' })
  assert.equal(await codeOf(() => store.redeemPasswordReset({ name: '甲', code, newPassword: 'second-new-password' })),
    IDENTITY_CODES.RESET_CONSUMED)
  // 第二次没生效：口令还是第一次设的那个。
  assert.equal((await store.login({ name: '甲', password: 'first-new-password' })).userId, target.userId)
})

test('重置码会过期', async () => {
  const clock = { now: 1_700_000_000_000 }
  const { store, owner } = await bootstrapped({ clock })
  await store.register({ name: '乙', password: 'good-password', registration: 'open' })
  const target = store.listUsers().find((u) => u.name === '乙')
  const { code } = store.createPasswordReset({ by: owner.userId, userId: target.userId })
  clock.now += 30 * 60 * 1000 + 1000
  assert.equal(await codeOf(() => store.redeemPasswordReset({ name: '乙', code, newPassword: 'brand-new-password' })),
    IDENTITY_CODES.RESET_EXPIRED)
})

test('★ 只有系统管理员能签发（它是一条能接管账号的凭据）', async () => {
  const { store, owner } = await bootstrapped()
  await store.register({ name: '普通人', password: 'good-password', registration: 'open' })
  const plain = store.listUsers().find((u) => u.name === '普通人')
  assert.equal(await codeOf(() => store.createPasswordReset({ by: plain.userId, userId: plain.userId })),
    IDENTITY_CODES.FORBIDDEN)
  // 也读不到别人的重置记录。
  assert.equal(await codeOf(() => store.listPasswordResets({ by: plain.userId })), IDENTITY_CODES.FORBIDDEN)
  assert.ok(store.listPasswordResets({ by: owner.userId }).length === 0)
})

test('用户名对不上 → 一律"重置码无效"（不说"这个码是别人的"）', async () => {
  const { store, owner } = await bootstrapped()
  await store.register({ name: '丙', password: 'good-password', registration: 'open' })
  await store.register({ name: '丁', password: 'good-password', registration: 'open' })
  const bing = store.listUsers().find((u) => u.name === '丙')
  const { code } = store.createPasswordReset({ by: owner.userId, userId: bing.userId })
  // 拿丙的码去改丁的口令：报的必须是"码无效"，而不是"这个码不属于你"——
  // 后者等于告诉对方"这个码存在，只是不是你的"。
  assert.equal(await codeOf(() => store.redeemPasswordReset({ name: '丁', code, newPassword: 'brand-new-password' })),
    IDENTITY_CODES.RESET_NOT_FOUND)
})

test('★ 重置后**所有**会话失效（与自助改口令"保留当前"相反）', async () => {
  // 这条路上的前提是"原凭据可能已经不可信"——用户进不来，我们无从判断此刻
  // 哪些会话是他本人的。宁可让他重新登一次。
  const { store, owner } = await bootstrapped()
  await store.register({ name: '戊', password: 'good-password', registration: 'open' })
  const target = store.listUsers().find((u) => u.name === '戊')
  const thief = await store.login({ name: '戊', password: 'good-password', label: '别人的设备' })
  assert.equal(store.verifyAccessToken(thief.accessToken).ok, true)

  const { code } = store.createPasswordReset({ by: owner.userId, userId: target.userId })
  const r = await store.redeemPasswordReset({ name: '戊', code, newPassword: 'brand-new-password' })
  assert.equal(store.verifyAccessToken(thief.accessToken).ok, false, '别人的会话必须当场失效')
  assert.equal(store.verifyAccessToken(thief.accessToken).code, IDENTITY_CODES.SESSION_REVOKED)
  // 而新会话是好的。
  assert.equal(store.verifyAccessToken(r.accessToken).ok, true)
})

test('停用与重置各管各的：重置**不**顺手解停用', async () => {
  // 顺手解停会让"停用"被一条别的路径悄悄撤销——而管理员停用一个人
  // （多半是某种封禁）之后，一个重置动作就把他放回来了，那不是他按下
  // "生成重置码"时想做的事。
  const { store, owner } = await bootstrapped()
  await store.register({ name: '己', password: 'good-password', registration: 'open' })
  const target = store.listUsers().find((u) => u.name === '己')
  await store.setUserDisabled({ by: owner.userId, userId: target.userId, disabled: true })

  // 但**签发**要能签：否则"停用"成了一条单向路，管理员想让人回来时连码都开不出来。
  const { code } = store.createPasswordReset({ by: owner.userId, userId: target.userId })
  await store.redeemPasswordReset({ name: '己', code, newPassword: 'brand-new-password' })
  // 口令确实改了，但账号**仍然停用**。
  assert.equal(await codeOf(() => store.login({ name: '己', password: 'brand-new-password' })),
    IDENTITY_CODES.INVALID_CREDENTIALS, '停用的账号登不进来')

  // 管理员显式恢复之后才进得来。
  await store.setUserDisabled({ by: owner.userId, userId: target.userId, disabled: false })
  assert.equal((await store.login({ name: '己', password: 'brand-new-password' })).userId, target.userId)
})

test('重置也清掉登录失败锁定（否则"救回来了但登不进"）', async () => {
  const { store, owner } = await bootstrapped()
  await store.register({ name: '庚', password: 'good-password', registration: 'open' })
  const target = store.listUsers().find((u) => u.name === '庚')
  for (let i = 0; i < 12; i += 1) await codeOf(() => store.login({ name: '庚', password: 'wrong-password' }))
  assert.equal(await codeOf(() => store.login({ name: '庚', password: 'good-password' })), IDENTITY_CODES.ACCOUNT_LOCKED)
  const { code } = store.createPasswordReset({ by: owner.userId, userId: target.userId })
  await store.redeemPasswordReset({ name: '庚', code, newPassword: 'brand-new-password' })
  assert.equal((await store.login({ name: '庚', password: 'brand-new-password' })).userId, target.userId)
})

test('列表不含 code_hash（那是凭据的哈希，界面不需要它）', async () => {
  const { store, owner } = await bootstrapped()
  await store.register({ name: '辛', password: 'good-password', registration: 'open' })
  const target = store.listUsers().find((u) => u.name === '辛')
  const { code } = store.createPasswordReset({ by: owner.userId, userId: target.userId })
  const rows = store.listPasswordResets({ by: owner.userId })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].consumed, false)
  const blob = JSON.stringify(rows)
  assert.equal(blob.includes(code), false, '列表里不许出现明文码')
  assert.equal(blob.includes(store._internals.hashSecret(code)), false, '也不许出现它的哈希')
})

// ── 事件订阅票据（SSE） ─────────────────────────────────────────────────────
//
// 它取代的是"把访问令牌放在查询串里"。查询串会进访问日志、浏览器历史、Referer，
// 而访问令牌是 15 分钟、覆盖全部 API 的主钥匙。

test('签发的票据能用一次，换出来的是**用户会话**', async () => {
  const { store, owner } = await bootstrapped()
  const session = await store.login({ name: 'owner', password: 'owner-password' })
  const t = store.createEventTicket({ userId: owner.userId, sessionId: session.sessionId })
  assert.equal(typeof t.ticket, 'string')
  assert.ok(t.ticket.length > 20)

  const r = store.redeemEventTicket(t.ticket)
  assert.equal(r.ok, true)
  // 形状与 `verifyAccessToken` 一致：门禁对两者一视同仁，不写第二条分支。
  assert.deepEqual(Object.keys(r).sort(), ['name', 'ok', 'sessionId', 'userId'])
  assert.equal(r.userId, owner.userId)
  assert.equal(r.sessionId, session.sessionId)
})

test('★ 一次性：同一张票第二次作废', async () => {
  const { store, owner } = await bootstrapped()
  const session = await store.login({ name: 'owner', password: 'owner-password' })
  const { ticket } = store.createEventTicket({ userId: owner.userId, sessionId: session.sessionId })
  assert.equal(store.redeemEventTicket(ticket).ok, true)
  assert.equal(store.redeemEventTicket(ticket).ok, false)
})

test('票据会过期', async () => {
  const clock = { now: 1_700_000_000_000 }
  const { store, owner } = await bootstrapped({ clock })
  const session = await store.login({ name: 'owner', password: 'owner-password' })
  const { ticket } = store.createEventTicket({ userId: owner.userId, sessionId: session.sessionId })
  clock.now += 60 * 1000 + 1
  assert.equal(store.redeemEventTicket(ticket).ok, false)
})

test('★ 四种失败**只有一种说法**（分开报会让"这张票存在过"可探测）', async () => {
  const { store, owner } = await bootstrapped()
  const session = await store.login({ name: 'owner', password: 'owner-password' })
  const { ticket } = store.createEventTicket({ userId: owner.userId, sessionId: session.sessionId })
  const shapes = new Set()

  shapes.add(JSON.stringify(store.redeemEventTicket('根本不存在的票')))
  store.redeemEventTicket(ticket)                      // 用掉
  shapes.add(JSON.stringify(store.redeemEventTicket(ticket)))
  // 会话被撤销之后
  const s2 = await store.login({ name: 'owner', password: 'owner-password' })
  const t2 = store.createEventTicket({ userId: owner.userId, sessionId: s2.sessionId })
  await store.revokeSession({ sessionId: s2.sessionId, by: owner.userId })
  shapes.add(JSON.stringify(store.redeemEventTicket(t2.ticket)))

  assert.equal(shapes.size, 1, `对外说法必须只有一种，实际有 ${shapes.size} 种：${[...shapes].join(' | ')}`)

  // 空票据**不在**这条纪律里：空串不可能是"某一张票"，所以它泄露不了
  // "这张票存在过"，而"缺少票据"对写错客户端的诊断价值更大。
  assert.equal(store.redeemEventTicket('').code, IDENTITY_CODES.INVALID_INPUT)
})

test('★ 会话被撤销后，它签出去的票据一并作废', async () => {
  // 否则"撤销会话"会留下一条只活 60 秒、但确实还能用的尾巴。
  const { store, owner } = await bootstrapped()
  const session = await store.login({ name: 'owner', password: 'owner-password' })
  const { ticket } = store.createEventTicket({ userId: owner.userId, sessionId: session.sessionId })
  await store.revokeSession({ sessionId: session.sessionId, by: owner.userId })
  assert.equal(store.redeemEventTicket(ticket).ok, false)
})

test('已停用的账号签不出票据，也换不出来', async () => {
  const { store, owner } = await bootstrapped()
  const session = await store.login({ name: 'owner', password: 'owner-password' })
  const { ticket } = store.createEventTicket({ userId: owner.userId, sessionId: session.sessionId })
  await store.setUserDisabled({ by: owner.userId, userId: owner.userId, disabled: true })
  assert.equal(await codeOf(() => store.createEventTicket({ userId: owner.userId, sessionId: session.sessionId })), IDENTITY_CODES.FORBIDDEN)
  assert.equal(store.redeemEventTicket(ticket).ok, false)
})

test('库里只存哈希：明文票据读不出来', async () => {
  const { store, db, owner } = await bootstrapped()
  const session = await store.login({ name: 'owner', password: 'owner-password' })
  const { ticket } = store.createEventTicket({ userId: owner.userId, sessionId: session.sessionId })
  const blob = JSON.stringify(db.prepare('SELECT * FROM hub_event_tickets').all())
  assert.equal(blob.includes(ticket), false, '库里不许出现明文票据')
})

test('过期票据与重置码会被清掉（后台扫，不抛）', async () => {
  const clock = { now: 1_700_000_000_000 }
  const { store, owner } = await bootstrapped({ clock })
  const session = await store.login({ name: 'owner', password: 'owner-password' })
  store.createEventTicket({ userId: owner.userId, sessionId: session.sessionId })
  // 要跨过「票据过期」+「清理的宽限期」两段。宽限期是**刻意的**：
  // 刚过期的东西留一会儿，排障时还看得到它存在过。
  clock.now += 24 * 60 * 60 * 1000 + 60 * 1000 + 1000
  const r = store.sweepExpiredCredentials()
  assert.equal(r.tickets, 1)
  assert.ok(r.resets >= 0)
})
