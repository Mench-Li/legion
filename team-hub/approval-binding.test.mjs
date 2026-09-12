// team-hub/approval-binding.test.mjs
// ============================================================================
// PRT-608 的判据：审批绑定到**写下来的**规范化操作哈希。
//
// 这一组盯的**不是**"哈希算得对不对"（那是 PRT-611 的事），而是两件事：
//
//   ① 哈希必须被**写进那一行**。每次验证时重算一遍，等于让审批的含义
//      由"你读它的那一刻的代码"决定。
//   ② 没有哈希的审批行一律**拒绝**，不"跳过校验"。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  APPROVAL_BINDING_VERSION,
  APPROVAL_STATES,
  BINDING_CODES,
  BINDING_HASH_CHECKED,
  BINDING_HASH_COLUMN,
  CONSUMABLE_APPROVAL_STATES,
  CONSUME_OUTCOMES,
  TERMINAL_APPROVAL_STATES,
  assertBindingHashShared,
  computeBindingHash,
  consumeBinding,
  createBindingRecord,
  isBoundHash,
  isTerminalApprovalState,
  operationOfRow,
  verifyBinding,
} from './approval-binding.mjs'
import { operationFingerprint } from './permission-engine.mjs'

const OP = Object.freeze({
  scope: 'legion', actor: 'general', action: 'file:write', target: 'repo/notes.md',
  taskId: 'task-1', unattended: false, metadata: { path: 'repo/notes.md', mode: 'rw' },
})

const TTL = 15 * 60 * 1000

function approvedRow(overrides = {}) {
  const hash = computeBindingHash(OP)
  return {
    requestId: 'perm-1',
    scope: OP.scope, actor: OP.actor, action: OP.action, target: OP.target, taskId: OP.taskId,
    operation: JSON.stringify(OP),
    mode: 'allow-once',
    status: 'approved',
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: 1_800_000_000_000,
    [BINDING_HASH_COLUMN]: hash,
    ...overrides,
  }
}

const NOW = 1_700_000_000_000

// ---------------------------------------------------------------- ① 哈希就是 F-02 的指纹

test('① ★★ 绑定哈希**就是** F-02 的 canonical operation 指纹（不是另算一份）', () => {
  // 一个与 F-02 各算一份的绑定哈希，与一个"审批绑的东西和执行时看的东西
  // 不是同一个东西"的绑定，是同一个东西。
  assert.equal(computeBindingHash(OP), operationFingerprint(OP))
  for (const op of [
    OP,
    { scope: 'a', actor: 'b', action: 'c', target: 'd' },
    { scope: 'a', actor: 'b', action: 'c', target: 'd', metadata: { z: [1, 2, { q: null }] } },
  ]) {
    assert.equal(computeBindingHash(op), operationFingerprint(op))
  }
})

test('① ★★ 加载时自检留下的是**算出来的**那个哈希（不是布尔标记）', () => {
  // `ok: true` 是随手就能写出来的字面量；要伪造一个"算出来的哈希"，
  // 就得把 F-02 的指纹算法再实现一遍。
  assert.match(BINDING_HASH_CHECKED.bindingHash, /^sha256:[0-9a-f]{64}$/)
  assert.equal(BINDING_HASH_CHECKED.bindingHash, BINDING_HASH_CHECKED.fingerprintHash)
  assert.equal(BINDING_HASH_CHECKED.ok, true)
  assert.equal(BINDING_HASH_CHECKED.version, APPROVAL_BINDING_VERSION)
  assert.equal(BINDING_HASH_CHECKED.domain.includes('permission'), true)
})

test('① ★★ 自检**真的会拦**一对不一致的哈希（不是只读模块级两个值比一下）', () => {
  // 一个只能对"当前恰好正确的那份输入"作答的校验，与一个恒真的校验，同形。
  // 只读模块级的两个值然后 `if (a !== b) throw`，那条 `if` 永远只在
  // "已经出事了"的时候才跑——用例根本碰不到它。
  const good = computeBindingHash(OP)
  assert.equal(assertBindingHashShared(good, good).ok, true)
  assert.throws(
    () => assertBindingHashShared(good, `sha256:${'f'.repeat(64)}`),
    /PRT-608/,
    '绑定哈希与 F-02 指纹分家了，自检却没有拦',
  )
})

test('① 哈希对同一个操作稳定、对不同操作不同', () => {
  assert.equal(computeBindingHash(OP), computeBindingHash({ ...OP }))
  assert.notEqual(computeBindingHash(OP), computeBindingHash({ ...OP, taskId: 'task-2' }))
  assert.notEqual(computeBindingHash(OP), computeBindingHash({ ...OP, metadata: { path: 'repo/notes.md', mode: 'r' } }))
})

test('① `isBoundHash` 只认完整形态', () => {
  assert.equal(isBoundHash(computeBindingHash(OP)), true)
  for (const bad of [null, undefined, '', '   ', 'sha256:', 'sha256:zz', 42, {}, 'SHA256:AB', `sha256:${'a'.repeat(63)}`]) {
    assert.equal(isBoundHash(bad), false, `${JSON.stringify(bad)} 被当成了合法哈希`)
  }
})

// ---------------------------------------------------------------- ② 绑定记录

test('② `createBindingRecord` 在**创建时**就把哈希算好放进返回值', () => {
  const rec = createBindingRecord({ requestId: 'perm-9', operation: OP, mode: 'allow-once', ttlMs: TTL, nowMs: NOW })
  assert.equal(rec.bindingHash, computeBindingHash(OP))
  assert.equal(rec.status, 'pending')
  assert.equal(rec.createdAtMs, NOW)
  assert.equal(rec.expiresAtMs, NOW + TTL)
  assert.equal(rec.version, APPROVAL_BINDING_VERSION)
  assert.equal(Object.isFrozen(rec), true)
})

test('② 非正的 TTL 被拒绝（"永不过期"不该是一条安静的默认值）', () => {
  for (const bad of [0, -1, NaN, Infinity, undefined, null]) {
    assert.throws(() => createBindingRecord({ requestId: 'x', operation: OP, mode: 'ask', ttlMs: bad, nowMs: NOW }), /TTL/)
  }
})

test('② 无法规范化的操作在创建时就抛（不是等到消费时）', () => {
  assert.throws(() => createBindingRecord({
    requestId: 'x', operation: { scope: '', actor: 'a', action: 'b', target: 'c' }, mode: 'ask', ttlMs: TTL, nowMs: NOW,
  }))
})

// ---------------------------------------------------------------- ③ ★★ 校验

test('③ ★★ 哈希对得上、状态是 approved、没过期 → 放行', () => {
  const v = verifyBinding({ row: approvedRow(), operation: OP, nowMs: NOW })
  assert.equal(v.ok, true)
  assert.equal(v.code, null)
  assert.equal(v.bindingHash, computeBindingHash(OP))
})

test('③ ★★ 操作字段变了 → `approval-operation-changed`（不是"没批准"）', () => {
  for (const changed of [
    { ...OP, taskId: 'task-2' },
    { ...OP, metadata: { path: 'repo/notes.md', mode: 'r' } },
    { ...OP, unattended: true },
    { ...OP, target: 'repo/other.md' },
  ]) {
    const v = verifyBinding({ row: approvedRow(), operation: changed, nowMs: NOW })
    assert.equal(v.ok, false)
    assert.equal(v.code, BINDING_CODES.OPERATION_CHANGED, JSON.stringify(changed))
    assert.ok(v.actualHash && v.actualHash !== v.bindingHash)
  }
})

test('③ ★★ `metadata` 键序不同**不算**改了字段（PRT-611 的成果不能被这里吃掉）', () => {
  const v = verifyBinding({
    row: approvedRow(),
    operation: { ...OP, metadata: { mode: 'rw', path: 'repo/notes.md' } },
    nowMs: NOW,
  })
  assert.equal(v.ok, true, '键序又被当成了操作身份')
})

test('③ ★★ 没有哈希的行 → `approval-unbound` 且**拒绝**', () => {
  for (const missing of [null, undefined, '', '   ']) {
    const v = verifyBinding({ row: approvedRow({ [BINDING_HASH_COLUMN]: missing }), operation: OP, nowMs: NOW })
    assert.equal(v.ok, false, `哈希为 ${JSON.stringify(missing)} 时被放行了`)
    assert.equal(v.code, BINDING_CODES.UNBOUND)
  }
})

test('③ ★★ `unbound` 与 `operation-changed` 是**两个不同的码**', () => {
  // 混成一个码会让一次迁移遗留看起来像一次用户改参数，值班的人去查错方向。
  const unbound = verifyBinding({ row: approvedRow({ [BINDING_HASH_COLUMN]: null }), operation: OP, nowMs: NOW })
  const changed = verifyBinding({ row: approvedRow(), operation: { ...OP, taskId: 'other' }, nowMs: NOW })
  assert.notEqual(unbound.code, changed.code)
  assert.ok(unbound.userText.includes('重新发起'), unbound.userText)
})

test('③ ★★ 未批准/已消费/已过期各有自己的码，都不放行', () => {
  const cases = [
    ['pending', BINDING_CODES.NOT_APPROVED],
    ['denied', BINDING_CODES.NOT_APPROVED],
    ['consumed', BINDING_CODES.ALREADY_CONSUMED],
    ['expired', BINDING_CODES.EXPIRED],
  ]
  const seen = new Set()
  for (const [status, code] of cases) {
    const v = verifyBinding({ row: approvedRow({ status }), operation: OP, nowMs: NOW })
    assert.equal(v.ok, false, `${status} 被放行了`)
    assert.equal(v.code, code, status)
    seen.add(code)
  }
  assert.equal(seen.size, 3, '四种状态塌成了三个码——分不清三件不同的事')
})

test('③ 找不到行 → `approval-not-found`', () => {
  assert.equal(verifyBinding({ row: null, operation: OP, nowMs: NOW }).code, BINDING_CODES.NOT_FOUND)
  assert.equal(verifyBinding({ row: undefined, operation: OP, nowMs: NOW }).code, BINDING_CODES.NOT_FOUND)
  assert.equal(verifyBinding({}).code, BINDING_CODES.NOT_FOUND)
})

test('③ ★★ 过期检查**排在**绑定检查之后（否则日志会写错理由）', () => {
  // 一条**绑错了**的审批，如果先被过期检查拦下，日志里写的理由是"过期"，
  // 值班的人会去查 TTL 配置，而真正的问题是这次调用根本不是那条审批覆盖的。
  const row = approvedRow({ expiresAt: NOW - 1 })
  const v = verifyBinding({ row, operation: { ...OP, taskId: 'other' }, nowMs: NOW })
  assert.equal(v.code, BINDING_CODES.OPERATION_CHANGED, '绑定错误被过期掩盖了')
  // 哈希对得上时才报过期
  assert.equal(verifyBinding({ row, operation: OP, nowMs: NOW }).code, BINDING_CODES.EXPIRED)
})

test('③ ★ 恰好到期的那一刻算过期（`>=` 而不是 `>`）', () => {
  const row = approvedRow({ expiresAt: NOW })
  assert.equal(verifyBinding({ row, operation: OP, nowMs: NOW }).code, BINDING_CODES.EXPIRED)
  assert.equal(verifyBinding({ row, operation: OP, nowMs: NOW - 1 }).ok, true)
})

test('③ 读 `expiresAtMs` 或 `expiresAt` 都能工作（迁移期的两种行）', () => {
  const row = approvedRow({ expiresAt: 1_800_000_000_000 })
  assert.equal(verifyBinding({ row, operation: OP, nowMs: NOW }).ok, true)
  assert.equal(verifyBinding({ row, operation: OP, nowMs: 1_800_000_000_001 }).code, BINDING_CODES.EXPIRED)
})

test('③ 返回对象形状固定（调用方不需要为某种拒绝写第二条分支）', () => {
  const keys = Object.keys(verifyBinding({ row: approvedRow(), operation: OP, nowMs: NOW })).sort()
  const denyKeys = Object.keys(verifyBinding({ row: null, operation: OP })).sort()
  // 拒绝路径的字段是成功路径的子集，且都含 ok/code/userText
  for (const k of denyKeys) assert.ok(keys.includes(k), `拒绝返回里有成功返回没有的字段 ${k}`)
  assert.equal(Object.isFrozen(verifyBinding({ row: null, operation: OP })), true)
})

// ---------------------------------------------------------------- ④ 状态与行

test('④ 状态集合与终态划分', () => {
  assert.deepEqual([...APPROVAL_STATES], ['pending', 'approved', 'denied', 'consumed', 'expired'])
  assert.deepEqual([...CONSUMABLE_APPROVAL_STATES], ['approved'])
  for (const s of APPROVAL_STATES) {
    const terminal = ['denied', 'consumed', 'expired'].includes(s)
    assert.equal(isTerminalApprovalState(s), terminal, s)
  }
  assert.equal(isTerminalApprovalState('approved'), false, 'approved 还会变成 consumed')
  assert.equal(isTerminalApprovalState('nope'), false)
  assert.equal(TERMINAL_APPROVAL_STATES.length, 3)
})

test('④ ★ `operationOfRow` 解析不出来时返回 `null`（不返回空对象）', () => {
  // 一个"解析不出来就当空对象"的回退，会让一次损坏的审批变成一次对空操作的批准。
  assert.equal(operationOfRow({ operation: 'not json' }), null)
  assert.equal(operationOfRow({ operation: '' }), null)
  assert.equal(operationOfRow({ operation: 'null' }), null)
  assert.equal(operationOfRow({ operation: '[]' }), null)
  assert.equal(operationOfRow({ operation: '"str"' }), null)
  assert.equal(operationOfRow(null), null)
  assert.deepEqual(operationOfRow({ operation: JSON.stringify({ a: 1 }) }), { a: 1 })
})

test('④ 绑定码两两不同（合并两个码＝分不清两件事）', () => {
  const values = Object.values(BINDING_CODES)
  assert.equal(new Set(values).size, values.length)
  for (const v of values) assert.ok(v.startsWith('approval-'), v)
})

// ---------------------------------------------------------------- ⑤ 真的库

const root = mkdtempSync(join(tmpdir(), 'legion-approval-binding-'))
process.env.TEAM_HUB_DB = join(root, 'team.db')
const mod = await import('./server.mjs')

test('⑤ ★★ 新建的待批准请求**带着**绑定哈希（不是等到批准时才补）', () => {
  mod.upsertPermissionRule({ id: 'ab-once', scope: 'legion', action: 'file:write', target: 'repo/notes.md', mode: 'allow-once', by: 'general' })
  const pending = mod.checkPermission({ ...OP, actor: 'general', scope: 'legion' })
  assert.equal(pending.status, 'pending')
  assert.match(pending.bindingHash, /^sha256:[0-9a-f]{64}$/, '待批准请求没有带回绑定哈希')
  const row = mod.db.prepare('SELECT * FROM permission_requests WHERE requestId=?').get(pending.requestId)
  assert.equal(row[BINDING_HASH_COLUMN], pending.bindingHash, '哈希没有真的写进那一行')
})

test('⑤ ★★ 批准用的是**那一行写下的**哈希，不是当场重算的', () => {
  const pending = mod.checkPermission({ ...OP, actor: 'general', scope: 'legion' })
  // 手工把行里的哈希改掉（模拟"规则变了/行被改过"）
  mod.db.prepare(`UPDATE permission_requests SET ${BINDING_HASH_COLUMN}=? WHERE requestId=?`)
    .run(`sha256:${'0'.repeat(64)}`, pending.requestId)
  mod.decidePermission({ requestId: pending.requestId, decision: 'approve', by: 'general' })
  // 于是这次调用被拒——**因为那一行说的话才算数**
  assert.throws(
    () => mod.checkPermission({ ...OP, actor: 'general', scope: 'legion', permissionRequestId: pending.requestId }),
    /approval-operation-changed/,
  )
})

test('⑤ ★★ 没有哈希的旧行：批准被拒绝，而且话说清了怎么办', () => {
  const pending = mod.checkPermission({ ...OP, actor: 'general', scope: 'legion' })
  mod.db.prepare(`UPDATE permission_requests SET ${BINDING_HASH_COLUMN}=NULL WHERE requestId=?`).run(pending.requestId)
  assert.throws(
    () => mod.decidePermission({ requestId: pending.requestId, decision: 'approve', by: 'general' }),
    /重新发起/,
    '一条绑不了东西的审批被允许变成"已批准"',
  )
  // 而且它**没有**被改成 approved
  const row = mod.db.prepare('SELECT * FROM permission_requests WHERE requestId=?').get(pending.requestId)
  assert.equal(row.status, 'pending')
})

test('⑤ ★★ 没有哈希的旧行：消费也被拒绝（不是"跳过校验"）', () => {
  const pending = mod.checkPermission({ ...OP, actor: 'general', scope: 'legion' })
  mod.db.prepare(`UPDATE permission_requests SET status='approved', ${BINDING_HASH_COLUMN}=NULL WHERE requestId=?`).run(pending.requestId)
  assert.throws(
    () => mod.checkPermission({ ...OP, actor: 'general', scope: 'legion', permissionRequestId: pending.requestId }),
    /approval-unbound/,
  )
})

test('⑤ ★★ 消费时 CAS 带哈希条件（并发的同哈希调用只成功一次）', () => {
  mod.upsertPermissionRule({ id: 'ab-race', scope: 'legion', action: 'repo:read', target: 'repo/x', mode: 'allow-once', by: 'general' })
  const op = { scope: 'legion', actor: 'general', action: 'repo:read', target: 'repo/x' }
  const pending = mod.checkPermission(op)
  mod.decidePermission({ requestId: pending.requestId, decision: 'approve', by: 'general' })
  const first = mod.checkPermission({ ...op, permissionRequestId: pending.requestId })
  assert.equal(first.allowed, true)
  assert.equal(first.status, 'consumed')
  assert.ok(first.bindingHash)
  // 第二次：行已是 consumed → 落回策略判定 → 一条新的待批准请求，而不是放行
  const second = mod.checkPermission({ ...op, permissionRequestId: pending.requestId })
  assert.equal(second.allowed, false)
  assert.equal(second.status, 'pending')
  assert.notEqual(second.requestId, pending.requestId, '用掉之后应当产生一条新的待批准请求')
})

test('⑤ ★ 每次消费/拒绝都写审计，且审计里带着哈希', () => {
  const pending = mod.checkPermission({ ...OP, actor: 'general', scope: 'legion' })
  const before = mod.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='permission:request'").get().n
  assert.ok(before >= 1)
  mod.decidePermission({ requestId: pending.requestId, decision: 'deny', by: 'general', reason: '不要' })
  // 注意 `audit(member, scope, action, taskId, detail)` 的第 4 个参数落在 `taskId` 列。
  const row = mod.db.prepare("SELECT * FROM audit WHERE action='permission:denied' AND taskId=?").get(pending.requestId)
  assert.ok(row, '拒绝没有写审计')
  assert.ok(JSON.parse(row.detail).bindingHash, `审计里没有绑定哈希：${row.detail ?? ''}`)
})

test('⑤ ★ 拒绝绑定时写 `permission:binding-rejected` 审计（值班的人能查到为什么）', () => {
  const pending = mod.checkPermission({ ...OP, actor: 'general', scope: 'legion' })
  mod.db.prepare(`UPDATE permission_requests SET ${BINDING_HASH_COLUMN}=? WHERE requestId=?`)
    .run(`sha256:${'1'.repeat(64)}`, pending.requestId)
  mod.decidePermission({ requestId: pending.requestId, decision: 'approve', by: 'general' })
  assert.throws(() => mod.checkPermission({ ...OP, actor: 'general', scope: 'legion', permissionRequestId: pending.requestId }))
  const row = mod.db.prepare("SELECT * FROM audit WHERE action='permission:binding-rejected' AND taskId=?").get(pending.requestId)
  assert.ok(row, '绑定被拒时没有留痕')
  const detail = JSON.parse(row.detail)
  assert.equal(detail.code, BINDING_CODES.OPERATION_CHANGED)
  assert.ok(detail.bindingHash && detail.actualHash, '审计里没有把两个哈希都写下来')
})

test('⑤ ★★ `expired` 是**写进库**的状态，不是视图里算出来的第二个真相', () => {
  const pending = mod.checkPermission({ ...OP, actor: 'general', scope: 'legion' })
  mod.db.prepare('UPDATE permission_requests SET expiresAt=? WHERE requestId=?').run(Date.now() - 1, pending.requestId)
  const inbox = mod.listPermissionInbox('legion')
  const row = inbox.find((r) => r.requestId === pending.requestId)
  assert.equal(row.status, 'expired')
  assert.equal('expired' in row, false, '视图里仍然有一个与 status 并列的 expired 字段——同一件事两个说法')
  const stored = mod.db.prepare('SELECT status FROM permission_requests WHERE requestId=?').get(pending.requestId)
  assert.equal(stored.status, 'expired', '视图说"过期了"，库里还是 pending')
})

test('⑤ ★ 过期的审批不能被消费', () => {
  const pending = mod.checkPermission({ ...OP, actor: 'general', scope: 'legion' })
  mod.decidePermission({ requestId: pending.requestId, decision: 'approve', by: 'general' })
  mod.db.prepare('UPDATE permission_requests SET expiresAt=? WHERE requestId=?').run(Date.now() - 1, pending.requestId)
  assert.throws(
    () => mod.checkPermission({ ...OP, actor: 'general', scope: 'legion', permissionRequestId: pending.requestId }),
    /approval-expired/,
  )
})

test('⑤ ★ 库里的行**确实有** bindingHash 列（迁移真的跑了）', () => {
  const cols = mod.db.prepare('PRAGMA table_info(permission_requests)').all().map((c) => c.name)
  assert.ok(cols.includes(BINDING_HASH_COLUMN), `列 ${BINDING_HASH_COLUMN} 不存在：${cols.join(',')}`)
})

test('⑤ ★★ CAS 只在那一行仍然是**我校验过的那条绑定**时才生效（真的走到 lost-race）', () => {
  // 一个只能靠并发时序才能触发的分支，与一个不存在的分支，
  // 在"它到底拦不拦得住"上是同一个东西。`consumeBinding` 被单独导出就是为了
  // 让这条路径可以被**真的走到**。
  mod.upsertPermissionRule({ id: 'ab-cas', scope: 'legion', action: 'repo:write', target: 'repo/z', mode: 'allow-once', by: 'general' })
  const op = { scope: 'legion', actor: 'general', action: 'repo:write', target: 'repo/z' }
  const pending = mod.checkPermission(op)
  mod.decidePermission({ requestId: pending.requestId, decision: 'approve', by: 'general' })

  // ① 哈希对不上（这一行在我校验之后被换成了另一条绑定）→ 不许消费
  const wrong = consumeBinding({
    db: mod.db, requestId: pending.requestId, bindingHash: `sha256:${'c'.repeat(64)}`, consumedAtText: 'now',
  })
  assert.equal(wrong.outcome, CONSUME_OUTCOMES.LOST_RACE)
  assert.equal(mod.db.prepare('SELECT status FROM permission_requests WHERE requestId=?').get(pending.requestId).status, 'approved',
    '哈希对不上却把它消费掉了')

  // ② 哈希对得上 → 消费成功
  const right = consumeBinding({
    db: mod.db, requestId: pending.requestId, bindingHash: pending.bindingHash, consumedAtText: 'now',
  })
  assert.equal(right.outcome, CONSUME_OUTCOMES.CONSUMED)
  assert.equal(right.changes, 1)

  // ③ 再消费一次 → 又是 lost-race（**不能**放行两次）
  const twice = consumeBinding({
    db: mod.db, requestId: pending.requestId, bindingHash: pending.bindingHash, consumedAtText: 'now',
  })
  assert.equal(twice.outcome, CONSUME_OUTCOMES.LOST_RACE)
  assert.equal(twice.changes, 0)
})

test('⑤ ★★ CAS 没抢到时**抛错**，而不是静默落回策略给出一条新的待批准请求', () => {
  // 这条路径只有在并发时序恰好落在"校验"与"消费"之间时才会发生。一个只能靠时序
  // 触发的分支，与一个不存在的分支，在"它到底拦不拦得住"上是同一个东西——
  // 所以 `checkPermission` 收一个可注入的 `consume`。
  mod.upsertPermissionRule({ id: 'ab-lost', scope: 'legion', action: 'skill:grant', target: 'dave', mode: 'allow-once', by: 'general' })
  const op = { scope: 'legion', actor: 'general', action: 'skill:grant', target: 'dave' }
  const pending = mod.checkPermission(op)
  mod.decidePermission({ requestId: pending.requestId, decision: 'approve', by: 'general' })

  assert.throws(
    () => mod.checkPermission(
      { ...op, permissionRequestId: pending.requestId },
      { consume: () => ({ outcome: CONSUME_OUTCOMES.LOST_RACE, changes: 0 }) },
    ),
    /已被并发消费/,
    'CAS 没抢到时静默落回策略——调用方会以为"这次只是需要新的批准"，而真相是它已经在别处被放行过',
  )
  // 而且它**没有**因为这次尝试而产生一条新的待批准请求
  const leftover = mod.db
    .prepare("SELECT COUNT(*) AS n FROM permission_requests WHERE scope='legion' AND action='skill:grant' AND target='dave' AND status='pending'")
    .get().n
  assert.equal(leftover, 0, '落回策略留下了一条新的待批准请求')
})

test('⑤ ★★ 待办视图里带着绑定哈希（UI 与审计看到的是**同一个字符串**）', () => {
  // 注意**不能**用 `repo:push`：它是硬底线动作，`evaluatePermission` 会直接 deny，
  // 根本不会产生待批准请求——那样这条用例会因为拿不到 requestId 而报错，
  // 看起来像"视图缺字段"，其实是用错了动作。
  mod.upsertPermissionRule({ id: 'ab-view', scope: 'legion', action: 'repo:write', target: 'repo/v', mode: 'ask', by: 'general' })
  const pending = mod.checkPermission({ scope: 'legion', actor: 'general', action: 'repo:write', target: 'repo/v' })
  assert.equal(pending.status, 'pending')
  const row = mod.listPermissionInbox('legion').find((r) => r.requestId === pending.requestId)
  assert.ok(row, `待办里找不到刚建的请求 ${pending.requestId}`)
  assert.equal(row.bindingHash, pending.bindingHash,
    '视图把绑定哈希藏起来了——UI 与审计看到的不再是同一个字符串')
  assert.equal(row.bindingHash, mod.db.prepare('SELECT * FROM permission_requests WHERE requestId=?').get(pending.requestId)[BINDING_HASH_COLUMN])
})

test.after(() => { try { mod.db.close() } catch {} ; rmSync(root, { recursive: true, force: true }) })
