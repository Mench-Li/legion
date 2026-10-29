// team-hub/identity-profile-store.test.mjs
// ============================================================================
// 账号管理（P0）—— 仓储层：display_name 追加列、旧数据回退、校验边界、
// 事务/严格审计、停用与不存在、迁移幂等。
//
// 对应用例：docs/G-mvt9or0l-1/TEST_CASES.md §4.1（TC-S1-*）
// 夹具形态与 team-hub/user-store.test.mjs 一致：内存库 + 与 server.mjs 同形 withTx。
// 用例名以 TC 编号开头，便于单条复跑：
//   node --test --test-isolation=none team-hub/identity-profile-store.test.mjs --test-name-pattern='TC-S1-22'
// ============================================================================
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { IDENTITY_CODES, IdentityError, createUserStore, hashPassword } from './user-store.mjs'

const KEY = 'test-signing-key-0123456789'
const INVALID = IDENTITY_CODES.INVALID_INPUT
const HASH = await hashPassword('test-password')

/** 与 server.mjs 同形的 withTx（BEGIN IMMEDIATE + SAVEPOINT 嵌套）。 */
function makeWithTx(db) {
  let depth = 0
  return (mutate) => {
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
}

function baseDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY, name TEXT, local_dir TEXT, private INTEGER DEFAULT 0);
    INSERT INTO spaces (id, name) VALUES ('default', '默认空间');
  `)
  return db
}

/** 旧库：只有**旧七列**。用来真实验证 ensureColumn 补列 + 读取回退。 */
function legacyDb() {
  const db = baseDb()
  db.exec(`
    CREATE TABLE hub_users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, name_key TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, created_at_ms INTEGER NOT NULL, disabled_at_ms INTEGER,
      system_role TEXT NOT NULL DEFAULT 'none');
  `)
  return db
}

function makeStore({ db = baseDb(), auditLog = null, audit = null } = {}) {
  const withTx = makeWithTx(db)
  const log = auditLog ?? []
  const sink = audit ?? ((actor, scope, action, taskId, detail) => {
    log.push({ actor, scope, action, taskId, detail })
  })
  const store = createUserStore({ db, withTx, clock: () => Date.now(), key: KEY, audit: sink })
  return { db, store, withTx, auditLog: log }
}

function seedUser(db, { id, name, displayName = null, disabled = false, systemRole = 'none' }) {
  db.prepare('INSERT INTO hub_users (id,name,name_key,password_hash,created_at_ms,disabled_at_ms,system_role,display_name) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, name, name.toLowerCase(), HASH, Date.now(), disabled ? Date.now() : null, systemRole, displayName)
}

function readName(db, id) {
  return db.prepare('SELECT display_name FROM hub_users WHERE id=?').get(id).display_name
}

const codeOf = (fn) => {
  try { fn(); return null } catch (e) { return e instanceof IdentityError ? e.code : `UNEXPECTED:${e.message}` }
}

describe('账号资料仓储（S1）', () => {
  it('TC-S1-01 旧库补列后读取回退用户名', () => {
    const db = legacyDb()
    // 旧行按**旧七列**插入（此刻 display_name 还不存在）。
    db.prepare('INSERT INTO hub_users VALUES(?,?,?,?,?,NULL,?)')
      .run('user-legacy', '旧数据兵', '旧数据兵', HASH, Date.now(), 'none')
    const { store } = makeStore({ db })
    const cols = db.prepare('PRAGMA table_info(hub_users)').all().map((c) => c.name)
    assert.ok(cols.includes('display_name'), 'display_name 列必须被补上')
    const row = store.listUsers().find((u) => u.userId === 'user-legacy')
    assert.equal(row.displayName, '旧数据兵')
    assert.equal(row.name, '旧数据兵')
  })

  it('TC-S1-02 连续两次创建 store：补列幂等，恰好一列', () => {
    const db = legacyDb()
    makeStore({ db })
    makeStore({ db }) // 第二次不得抛 duplicate column
    const cols = db.prepare('PRAGMA table_info(hub_users)').all().filter((c) => c.name === 'display_name')
    assert.equal(cols.length, 1)
  })

  it('TC-S1-03 新库 NULL 显示名回退用户名', () => {
    const { db, store } = makeStore()
    seedUser(db, { id: 'user-a', name: '小兵', displayName: null })
    assert.equal(store.listUsers().find((u) => u.userId === 'user-a').displayName, '小兵')
  })

  it('TC-S1-04 空串/纯空白/制表符都回退用户名，不返回空白', () => {
    const { db, store } = makeStore()
    seedUser(db, { id: 'u1', name: '甲', displayName: '' })
    seedUser(db, { id: 'u2', name: '乙', displayName: '   ' })
    seedUser(db, { id: 'u3', name: '丙', displayName: '\t\t' })
    const byId = new Map(store.listUsers().map((u) => [u.userId, u]))
    assert.equal(byId.get('u1').displayName, '甲')
    assert.equal(byId.get('u2').displayName, '乙')
    assert.equal(byId.get('u3').displayName, '丙')
  })

  it('TC-S1-05 引导 / 接受邀请 / 自助注册三条建号路都带 displayName=name', async () => {
    const { store } = makeStore()
    const owner = await store.bootstrapOwner({ name: 'owner', password: 'owner-password', authorized: true })
    const invite = store.createInvite({ by: owner.userId, space: 'default', role: 'member' })
    const member = await store.acceptInvite({ code: invite.code, name: '小兵', password: 'soldier-password' })
    const registered = await store.register({ name: '自助兵', password: 'selfserve-password', registration: 'open', space: 'default' })
    const rows = new Map(store.listUsers().map((u) => [u.userId, u]))
    assert.equal(rows.get(owner.userId).displayName, 'owner')
    assert.equal(rows.get(member.userId).displayName, '小兵')
    assert.equal(rows.get(registered.userId).displayName, '自助兵')
  })

  it('TC-S1-06 P0 契约：avatar 恒为空字符串', () => {
    const { db, store } = makeStore()
    seedUser(db, { id: 'u1', name: '甲' })
    assert.equal(store.listUsers()[0].avatar, '')
  })

  it('TC-S1-07 迁移不改 name / name_key（逐字节）', () => {
    const db = legacyDb()
    db.prepare('INSERT INTO hub_users VALUES(?,?,?,?,?,NULL,?)')
      .run('user-legacy', '旧数据兵', '旧数据兵', HASH, Date.now(), 'none')
    const before = db.prepare('SELECT name, name_key FROM hub_users WHERE id=?').get('user-legacy')
    makeStore({ db })
    const after = db.prepare('SELECT name, name_key FROM hub_users WHERE id=?').get('user-legacy')
    assert.deepEqual(after, before)
  })

  it('TC-S1-08 三处位置式 INSERT 已改显式列名', () => {
    const src = readFileSync(new URL('./user-store.mjs', import.meta.url), 'utf8')
    const hits = src.match(/INSERT INTO hub_users VALUES/g) ?? []
    assert.equal(hits.length, 0)
    assert.equal((src.match(/INSERT INTO hub_users \(id,name,name_key,password_hash,created_at_ms,disabled_at_ms,system_role\)/g) ?? []).length, 3)
  })

  it('TC-S1-10 保存后持久化：同一 db 新建 store 仍读到新值', () => {
    const { db, store } = makeStore()
    seedUser(db, { id: 'u1', name: '小兵' })
    const updated = store.updateProfile({ userId: 'u1', displayName: 'Alice' })
    assert.equal(updated.displayName, 'Alice')
    const { store: store2 } = makeStore({ db })
    assert.equal(store2.listUsers().find((u) => u.userId === 'u1').displayName, 'Alice')
  })

  it('TC-S1-11 去首尾空白后保存', () => {
    const { db, store } = makeStore()
    seedUser(db, { id: 'u1', name: '小兵' })
    assert.equal(store.updateProfile({ userId: 'u1', displayName: '  Alice  ' }).displayName, 'Alice')
    assert.equal(readName(db, 'u1'), 'Alice')
  })

  it('TC-S1-12 后写覆盖并返回最终值', () => {
    const { db, store } = makeStore()
    seedUser(db, { id: 'u1', name: '小兵' })
    assert.equal(store.updateProfile({ userId: 'u1', displayName: 'Alice' }).displayName, 'Alice')
    assert.equal(store.updateProfile({ userId: 'u1', displayName: 'Bob' }).displayName, 'Bob')
    assert.equal(readName(db, 'u1'), 'Bob')
  })

  it('TC-S1-13 显示名非唯一：两个用户可以同名', () => {
    const { db, store } = makeStore()
    seedUser(db, { id: 'u1', name: '甲' })
    seedUser(db, { id: 'u2', name: '乙' })
    store.updateProfile({ userId: 'u1', displayName: '同名' })
    store.updateProfile({ userId: 'u2', displayName: '同名' })
    const rows = store.listUsers()
    assert.equal(rows.filter((u) => u.displayName === '同名').length, 2)
  })

  it('TC-S1-14 改显示名不动 name / name_key', () => {
    const { db, store } = makeStore()
    seedUser(db, { id: 'u1', name: '小兵' })
    const before = db.prepare('SELECT name, name_key FROM hub_users WHERE id=?').get('u1')
    store.updateProfile({ userId: 'u1', displayName: 'Alice' })
    assert.deepEqual(db.prepare('SELECT name, name_key FROM hub_users WHERE id=?').get('u1'), before)
  })

  it('TC-S1-15 只改 display_name：口令哈希/停用/系统角色/空间角色/会话都不变', () => {
    const { db, store } = makeStore()
    seedUser(db, { id: 'u1', name: '小兵', systemRole: 'none' })
    db.prepare('INSERT INTO hub_space_roles VALUES(?,?,?,?,?)').run('u1', 'default', 'member', 'u1', Date.now())
    db.prepare('INSERT INTO hub_user_sessions VALUES(?,?,?,?,?,?,?,NULL,?)')
      .run('sess-1', 'u1', '浏览器A', 'refresh-hash-1', Date.now(), Date.now() + 900000, Date.now() + 86400000, Date.now())
    const userBefore = db.prepare('SELECT password_hash, disabled_at_ms, system_role FROM hub_users WHERE id=?').get('u1')
    const rolesBefore = db.prepare('SELECT * FROM hub_space_roles WHERE user_id=?').all('u1')
    const sessionsBefore = db.prepare('SELECT * FROM hub_user_sessions WHERE user_id=?').all('u1')
    store.updateProfile({ userId: 'u1', displayName: 'Alice' })
    assert.deepEqual(db.prepare('SELECT password_hash, disabled_at_ms, system_role FROM hub_users WHERE id=?').get('u1'), userBefore)
    assert.deepEqual(db.prepare('SELECT * FROM hub_space_roles WHERE user_id=?').all('u1'), rolesBefore)
    assert.deepEqual(db.prepare('SELECT * FROM hub_user_sessions WHERE user_id=?').all('u1'), sessionsBefore)
  })

  it('TC-S1-20 长度 1 通过', () => {
    const { db, store } = makeStore()
    seedUser(db, { id: 'u1', name: '小兵' })
    assert.equal(store.updateProfile({ userId: 'u1', displayName: 'A' }).displayName, 'A')
  })

  it('TC-S1-21 长度 64 通过', () => {
    const { db, store } = makeStore()
    seedUser(db, { id: 'u1', name: '小兵' })
    const v = 'A'.repeat(64)
    assert.equal(store.updateProfile({ userId: 'u1', displayName: v }).displayName, v)
  })

  it('TC-S1-22 长度 65 被拒且不写库（保留原值）', () => {
    const { db, store } = makeStore()
    seedUser(db, { id: 'u1', name: '小兵', displayName: '旧显示名' })
    assert.equal(codeOf(() => store.updateProfile({ userId: 'u1', displayName: 'A'.repeat(65) })), INVALID)
    assert.equal(readName(db, 'u1'), '旧显示名')
  })

  it('TC-S1-23 空串被拒且不写库', () => {
    const { db, store } = makeStore()
    seedUser(db, { id: 'u1', name: '小兵', displayName: '旧显示名' })
    assert.equal(codeOf(() => store.updateProfile({ userId: 'u1', displayName: '' })), INVALID)
    assert.equal(readName(db, 'u1'), '旧显示名')
  })

  it('TC-S1-24 纯空白 / 制表符被拒且不写库', () => {
    const { db, store } = makeStore()
    seedUser(db, { id: 'u1', name: '小兵', displayName: '旧显示名' })
    for (const v of ['   ', '\t\t']) {
      assert.equal(codeOf(() => store.updateProfile({ userId: 'u1', displayName: v })), INVALID)
      assert.equal(readName(db, 'u1'), '旧显示名')
    }
  })

  it('TC-S1-25/26/27 C0 控制字符 U+0000 / U+001F / U+007F 被拒', () => {
    const { db, store } = makeStore()
    seedUser(db, { id: 'u1', name: '小兵', displayName: '旧显示名' })
    for (const ch of ['\u0000', '\u001F', '\u007F']) {
      assert.equal(codeOf(() => store.updateProfile({ userId: 'u1', displayName: `Ali${ch}ce` })), INVALID)
      assert.equal(readName(db, 'u1'), '旧显示名')
    }
  })

  it('TC-S1-28 内部换行 U+000A 被拒（不得被 trim 放行）', () => {
    const { db, store } = makeStore()
    seedUser(db, { id: 'u1', name: '小兵', displayName: '旧显示名' })
    assert.equal(codeOf(() => store.updateProfile({ userId: 'u1', displayName: 'Ali\nce' })), INVALID)
    assert.equal(readName(db, 'u1'), '旧显示名')
  })

  it('TC-S1-29 U+000D+U+000A 与单独 U+000D 均被拒', () => {
    const { db, store } = makeStore()
    seedUser(db, { id: 'u1', name: '小兵', displayName: '旧显示名' })
    for (const v of ['Ali\r\nce', 'Ali\rce']) {
      assert.equal(codeOf(() => store.updateProfile({ userId: 'u1', displayName: v })), INVALID)
      assert.equal(readName(db, 'u1'), '旧显示名')
    }
  })

  it('TC-S1-30 非字符串（null/undefined/42/true/{}/[]）全部被拒', () => {
    const { db, store } = makeStore()
    seedUser(db, { id: 'u1', name: '小兵', displayName: '旧显示名' })
    for (const v of [null, undefined, 42, true, {}, ['a']]) {
      assert.equal(codeOf(() => store.updateProfile({ userId: 'u1', displayName: v })), INVALID)
      assert.equal(readName(db, 'u1'), '旧显示名')
    }
  })

  it('TC-S1-31 长度口径是 UTF-16 code unit（emoji 32 通过 / 33 拒绝 / 64 汉字通过）', () => {
    const { db, store } = makeStore()
    seedUser(db, { id: 'u1', name: '小兵' })
    assert.equal(codeOf(() => store.updateProfile({ userId: 'u1', displayName: '😀'.repeat(32) })), null)
    assert.equal(codeOf(() => store.updateProfile({ userId: 'u1', displayName: '😀'.repeat(33) })), INVALID)
    assert.equal(codeOf(() => store.updateProfile({ userId: 'u1', displayName: '汉'.repeat(64) })), null)
  })

  it('TC-S1-32 每条拒绝之后立即读库：值都与调用前相同', () => {
    const { db, store } = makeStore()
    seedUser(db, { id: 'u1', name: '小兵', displayName: '固定值' })
    const bads = ['', '   ', 'A'.repeat(65), 'Ali\nce', 'Ali\rce', 'Ali\u0000ce', 'Ali\u007Fce', null, 42, {}, []]
    for (const v of bads) {
      assert.equal(codeOf(() => store.updateProfile({ userId: 'u1', displayName: v })), INVALID, JSON.stringify(v))
      assert.equal(readName(db, 'u1'), '固定值', JSON.stringify(v))
    }
  })

  it('TC-S1-33 抛出的是 IdentityError 且 code 为 IDENTITY_INVALID_INPUT', () => {
    const { db, store } = makeStore()
    seedUser(db, { id: 'u1', name: '小兵' })
    try {
      store.updateProfile({ userId: 'u1', displayName: 'A'.repeat(65) })
      assert.fail('应当抛错')
    } catch (e) {
      assert.ok(e instanceof IdentityError)
      assert.equal(e.code, INVALID)
    }
  })

  it('TC-S1-40 审计：identity:profile-update / global / fields / from / to', () => {
    const { db, store, auditLog } = makeStore()
    seedUser(db, { id: 'u1', name: '小兵', displayName: '旧名' })
    store.updateProfile({ userId: 'u1', displayName: 'Alice' })
    const row = auditLog.find((a) => a.action === 'identity:profile-update')
    assert.ok(row, '必须写一条资料更新审计')
    assert.equal(row.actor, 'u1')
    assert.equal(row.scope, 'global')
    assert.deepEqual(row.detail.fields, ['displayName'])
    assert.equal(row.detail.from, '旧名')
    assert.equal(row.detail.to, 'Alice')
  })

  it('TC-S1-41 审计里不出现口令/令牌/哈希', () => {
    const { db, store, auditLog } = makeStore()
    seedUser(db, { id: 'u1', name: '小兵' })
    store.updateProfile({ userId: 'u1', displayName: 'Alice' })
    const blob = JSON.stringify(auditLog)
    for (const secret of ['test-password', 'scrypt$', 'accessToken', 'refreshToken']) {
      assert.equal(blob.includes(secret), false, secret)
    }
  })

  it('TC-S1-42 审计抛错时整事务回滚', () => {
    const auditLog = []
    const audit = (actor, scope, action, taskId, detail) => {
      if (action === 'identity:profile-update') throw new Error('audit down')
      auditLog.push({ actor, scope, action, detail })
    }
    const db = baseDb()
    const { store } = makeStore({ db, audit })
    seedUser(db, { id: 'u1', name: '小兵', displayName: '旧名' })
    db.prepare('INSERT INTO hub_user_sessions VALUES(?,?,?,?,?,?,?,NULL,?)')
      .run('sess-1', 'u1', '浏览器A', 'refresh-hash-1', Date.now(), Date.now() + 900000, Date.now() + 86400000, Date.now())
    const hashBefore = db.prepare('SELECT password_hash FROM hub_users WHERE id=?').get('u1').password_hash
    assert.throws(() => store.updateProfile({ userId: 'u1', displayName: 'Alice' }), /audit down/)
    assert.equal(readName(db, 'u1'), '旧名')
    assert.equal(db.prepare('SELECT password_hash FROM hub_users WHERE id=?').get('u1').password_hash, hashBefore)
    assert.equal(db.prepare('SELECT revoked_at_ms FROM hub_user_sessions WHERE id=?').get('sess-1').revoked_at_ms, null)
  })

  it('TC-S1-43 停用账号写入被拒（FORBIDDEN 403）且行不变', () => {
    const { db, store } = makeStore()
    seedUser(db, { id: 'u1', name: '停用兵', displayName: '旧名', disabled: true })
    assert.equal(codeOf(() => store.updateProfile({ userId: 'u1', displayName: 'Alice' })), IDENTITY_CODES.FORBIDDEN)
    assert.equal(readName(db, 'u1'), '旧名')
  })

  it('TC-S1-44 不存在的用户返回 USER_NOT_FOUND', () => {
    const { store } = makeStore()
    assert.equal(codeOf(() => store.updateProfile({ userId: 'user-不存在', displayName: 'x' })), IDENTITY_CODES.USER_NOT_FOUND)
  })

  it('TC-S1-45 N/A：仓储只收 {userId, displayName}，未知字段/非对象由 HTTP 层覆盖', { skip: 'store 不接收原始请求体；由 TC-S2-27…32 等价覆盖' }, () => {})

  it('TC-S1-50 两次串行保存不出现半写，最终值为后写者', () => {
    const { db, store } = makeStore()
    seedUser(db, { id: 'u1', name: '小兵' })
    assert.equal(store.updateProfile({ userId: 'u1', displayName: 'Alice' }).displayName, 'Alice')
    assert.equal(store.updateProfile({ userId: 'u1', displayName: 'Bob' }).displayName, 'Bob')
    assert.equal(readName(db, 'u1'), 'Bob')
  })

  it('TC-S1-51 100 条随机非法输入全部拒绝，值始终不变', () => {
    const { db, store } = makeStore()
    seedUser(db, { id: 'u1', name: '小兵', displayName: '固定值' })
    const strings = ['', ' ', '\t', '\n', '\r', '\u0000', '\u001F', '\u007F']
    const controls = ['\t', '\n', '\r', '\u0000', '\u001F', '\u007F']
    const nonStrings = [null, undefined, 42, true, {}, []]
    for (let i = 0; i < 100; i += 1) {
      const kind = i % 4
      const v = kind === 0
        ? 'A'.repeat(65 + i)
        : kind === 1
          ? `Ali${controls[i % controls.length]}ce`
          : kind === 2
            ? strings[i % strings.length]
            : nonStrings[i % nonStrings.length]
      assert.equal(codeOf(() => store.updateProfile({ userId: 'u1', displayName: v })), INVALID, JSON.stringify(v))
      assert.equal(readName(db, 'u1'), '固定值')
    }
  })

  it('TC-S1-52 迁移只加列：既有会话/邀请/空间角色行不变', () => {
    const db = legacyDb()
    db.prepare('INSERT INTO hub_users VALUES(?,?,?,?,?,NULL,?)')
      .run('user-legacy', '旧数据兵', '旧数据兵', HASH, Date.now(), 'none')
    // createUserStore 会建会话/邀请/空间角色表；先建 store 再写行，再迁移一次。
    const { store } = makeStore({ db })
    db.prepare('INSERT INTO hub_user_sessions VALUES(?,?,?,?,?,?,?,NULL,?)')
      .run('sess-1', 'user-legacy', 'A', 'rh-1', Date.now(), Date.now() + 900000, Date.now() + 86400000, Date.now())
    db.prepare('INSERT INTO hub_invites VALUES(?,?,?,?,?,?,?,NULL,NULL)')
      .run('inv-1', 'ch-1', 'default', 'member', 'user-legacy', Date.now(), Date.now() + 86400000)
    db.prepare('INSERT INTO hub_space_roles VALUES(?,?,?,?,?)').run('user-legacy', 'default', 'member', 'user-legacy', Date.now())
    const before = {
      sessions: db.prepare('SELECT * FROM hub_user_sessions').all(),
      invites: db.prepare('SELECT * FROM hub_invites').all(),
      roles: db.prepare('SELECT * FROM hub_space_roles').all(),
    }
    makeStore({ db }) // 第二次补列（已是目标状态）
    assert.deepEqual(db.prepare('SELECT * FROM hub_user_sessions').all(), before.sessions)
    assert.deepEqual(db.prepare('SELECT * FROM hub_invites').all(), before.invites)
    assert.deepEqual(db.prepare('SELECT * FROM hub_space_roles').all(), before.roles)
    assert.ok(store)
  })
})
