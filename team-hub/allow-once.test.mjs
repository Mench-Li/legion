// team-hub/allow-once.test.mjs
// ============================================================================
// PRT-616 的判据：`allow-once` 的原子占位
//
// spec §6.5：「消费必须由 team-hub 执行原子 CAS（`approved → consumed`），
// 同一哈希只能成功一次，CAS 失败即 deny。同一 Attempt 内模型对同一目标发出
// **参数完全相同**的并发重复调用不得放行两次。」
//
// 这一组盯的是 PRT-608 的行级 CAS **看不见**的那件事：危险场景里，
// 两条待批准行各自都只被消费了一次——CAS 全程尽职，而同一个操作执行了两次。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ALLOW_ONCE_CHECKED,
  ALLOW_ONCE_CODES,
  ALLOW_ONCE_TABLE,
  ALLOW_ONCE_VERSION,
  CLAIM_OUTCOMES,
  KEY_SEPARATOR,
  NO_ATTEMPT_NAMESPACE,
  assertKeyUnambiguous,
  claimOnce,
  consumptionKey,
  ensureAllowOnceSchema,
  isAttemptScopedKey,
  listClaimsOfAttempt,
  readClaim,
  releaseClaim,
} from './allow-once.mjs'
import { BINDING_HASH_COLUMN, APPROVAL_ATTEMPT_COLUMN, ensureApprovalSchema } from './approval-binding.mjs'
import { writeFixtureApproval } from './approval-fixture.mjs'

// ---------------------------------------------------------------- ① 键

test('① ★★ 键必须无歧义（字段长度会变时，拼接本身就有歧义）', () => {
  // 去掉分隔符时 ('att-1','ab') 与 ('att-1a','b') 都拼成 `att-1ab`。
  // 两条**不同**的授权共用一个键，第二条会被当成"已经用掉了"而拒绝。
  assert.equal(consumptionKey({ attemptId: 'att-1', bindingHash: 'ab' }), `att-1${KEY_SEPARATOR}ab`)
  assert.equal(consumptionKey({ attemptId: 'att-1a', bindingHash: 'b' }), `att-1a${KEY_SEPARATOR}b`)
  assert.notEqual(
    consumptionKey({ attemptId: 'att-1', bindingHash: 'ab' }),
    consumptionKey({ attemptId: 'att-1a', bindingHash: 'b' }),
    '两个不同的 (attemptId, bindingHash) 拼出了同一个键',
  )
})

test('① ★ 分隔符是一个不可能出现在任一字段里的字符', () => {
  assert.equal(KEY_SEPARATOR, '\u0000')
  assert.equal(ALLOW_ONCE_CHECKED.separatorCodePoint, 0)
  assert.equal(KEY_SEPARATOR.includes('a'), false)
})

test('① ★★ 缺 Attempt 时落到**另一个**命名空间，不是全局哈希锁', () => {
  // 若退化成"只按哈希"，同一操作在**不同** Attempt 里再次被批准（完全合法）
  // 会被永久拒绝。
  //
  //   > 一个「没有 Attempt 就按哈希全局锁死」的降级，
  //   > 与一个「这张票以后再也不能用」的降级，是同一个东西。
  const k = consumptionKey({ attemptId: null, bindingHash: 'h', requestId: 'req-1' })
  assert.ok(k.startsWith(NO_ATTEMPT_NAMESPACE), `无 Attempt 的键应当在自己的命名空间里，实际 ${JSON.stringify(k)}`)
  assert.notEqual(k, consumptionKey({ attemptId: 'req-1', bindingHash: 'h' }), '无 Attempt 的键与有 Attempt 的键撞上了')
  assert.equal(isAttemptScopedKey(k), false, '无 Attempt 的键被当成了"具备 Attempt 级去重"')
  // 两个不同的 requestId 是两个不同的键（所以不会互相锁死）
  assert.notEqual(k, consumptionKey({ attemptId: null, bindingHash: 'h', requestId: 'req-2' }))
  // 没有 requestId 时**拒绝**，而不是猜一个
  assert.throws(() => consumptionKey({ attemptId: null, bindingHash: 'h' }), /必须给出 requestId/)
})

test('① 空哈希被拒绝（不拼出一个"什么都匹配"的键）', () => {
  for (const bad of ['', '   ', null, undefined, 42]) {
    assert.throws(() => consumptionKey({ attemptId: 'a', bindingHash: bad }), TypeError, JSON.stringify(bad))
  }
})

test('① 键两边的字段各自 trim（前后空白不改变一次授权的身份）', () => {
  assert.equal(
    consumptionKey({ attemptId: ' att-1 ', bindingHash: ' hash ' }),
    consumptionKey({ attemptId: 'att-1', bindingHash: 'hash' }),
  )
})

test('① ★★ 自检留下的是**算出来的键与判定**，不是布尔标记', () => {
  // `ok: true` 是随手就能写出来的字面量；要伪造"分隔符没被去掉"，
  // 就得让 `consumptionKey` 真的拼出一个会撞车的键。
  assert.equal(ALLOW_ONCE_CHECKED.distinct, true, '两个不同的字段对拼出了同一个键')
  assert.notEqual(ALLOW_ONCE_CHECKED.leftKey, ALLOW_ONCE_CHECKED.rightKey)
  assert.equal(ALLOW_ONCE_CHECKED.attemptKeyIsAttemptScoped, true)
  assert.equal(ALLOW_ONCE_CHECKED.noAttemptIsAttemptScoped, false)
  assert.equal(ALLOW_ONCE_CHECKED.version, ALLOW_ONCE_VERSION)
  assert.equal(ALLOW_ONCE_CHECKED.table, ALLOW_ONCE_TABLE)
})

test('① ★★ 自检**真的会拦**一次撞车的键（注入 keyOf，不是注入字段对）', () => {
  // 正确的实现里"两个不同的字段对拼出同一个键"恒为假，那段断言**永远不触发**。
  //
  //   > 一段永远不会触发的断言，与一段不存在的断言，
  //   > 在「它到底拦不拦得住」上是同一个东西。
  //
  // ⚠️ 第一版这里注入的是一对**字段**（`('att-1','ab')` 与 `('att-1ab','ab')`），
  // 实测**没红**——因为分隔符在，任何一对字段都撞不上。那种写法看起来像
  // "构造了一次撞车"，实际永远测不到东西。改成注入 `keyOf`。
  assert.equal(assertKeyUnambiguous().distinct, true)
  assert.throws(
    () => assertKeyUnambiguous({ keyOf: () => 'collide' }),
    /拼出了同一个占位键/,
    '注入一个恒返回同一个键的 keyOf，自检却没有拦',
  )
})

test('① ★★ 自检**真的会拦**"无 Attempt 的键变成全局哈希锁"', () => {
  // 让无 Attempt 的键与有 Attempt 的键重合 —— 也就是那次降级。
  // 同样只能靠注入 `keyOf` 构造：真实实现里两者在不同命名空间。
  assert.throws(
    () => assertKeyUnambiguous({
      keyOf: ({ attemptId }) => (attemptId === null ? 'same' : 'same'),
    }),
    /拼出了同一个占位键/,
  )
  // 单独验命名空间那一道：让 keyOf 对"有 Attempt"与"无 Attempt"返回同一个串，
  // 但两个**样例字段对**仍不同 —— 这样第一道闸门不会先拦下来。
  assert.throws(
    () => assertKeyUnambiguous({
      left: { attemptId: 'att-1', bindingHash: 'ab' },
      right: { attemptId: 'att-1a', bindingHash: 'b' },
      keyOf: ({ attemptId }) => (attemptId === 'att-1' ? 'K1' : attemptId === 'att-1a' ? 'K2' : 'K1'),
    }),
    /无 Attempt 的占位键与有 Attempt 的键撞上了/,
  )
})

test('① ★★ 自检**真的会拦**"无 Attempt 的键被当成具备 Attempt 级去重"', () => {
  // 第三道闸门。它与前两道是**不同**的检查：前两道比的是"键是否相同"，
  // 这一道比的是"这个键**自称**具备的语义"。
  //
  // 第一版用例没有覆盖到它：那条用例让 keyOf 返回重合的串，于是第二道
  // 先拦了下来，第三道**一次都没跑过**——而一段没跑过的断言，
  // 与一段不存在的断言，同形。
  assert.throws(
    () => assertKeyUnambiguous({
      left: { attemptId: 'att-1', bindingHash: 'ab' },
      right: { attemptId: 'att-1a', bindingHash: 'b' },
      // 键各不相同（前两道不会拦），但"无 Attempt"被谎报成具备 Attempt 级去重
      keyOf: ({ attemptId }) => (attemptId === null ? 'NOATT' : `K:${attemptId}`),
      keyIsAttemptScoped: () => true,
    }),
    /无 Attempt 的键被判定为"具备 Attempt 级去重"/,
  )
})

// ---------------------------------------------------------------- ② 占位

const root = mkdtempSync(join(tmpdir(), 'legion-allow-once-'))
process.env.TEAM_HUB_DB = join(root, 'team.db')
const mod = await import('./server.mjs')
const db = mod.db
ensureAllowOnceSchema(db)

test('② ★★ 先到者占位成功，后来者丢失竞争（INSERT OR IGNORE + changes）', () => {
  const args = { db, attemptId: 'att-race', bindingHash: 'hash-race', requestId: 'req-race', consumedAtText: '2026-09-12T00:00:00.000Z' }
  const first = claimOnce(args)
  assert.equal(first.outcome, CLAIM_OUTCOMES.CLAIMED)
  assert.equal(first.changes, 1)
  assert.equal(first.attemptScoped, true)
  const second = claimOnce({ ...args, requestId: 'req-race-2' })
  assert.equal(second.outcome, CLAIM_OUTCOMES.LOST_RACE, '同一个 (attemptId, hash) 被占位了两次')
  assert.equal(second.changes, 0)
})

test('② ★★ 占位是**跨 requestId** 的（两条不同的审批行也只有一个能占位）', () => {
  // 这正是危险场景：同一 Attempt 内两次相同调用各自写下一条待批准行。
  // 若占位键包含 requestId，两条行各占各的键 → 都能放行 → 操作执行两次。
  const a = claimOnce({ db, attemptId: 'att-two', bindingHash: 'h-two', requestId: 'req-A', consumedAtText: 'x' })
  const b = claimOnce({ db, attemptId: 'att-two', bindingHash: 'h-two', requestId: 'req-B', consumedAtText: 'x' })
  assert.equal(a.outcome, CLAIM_OUTCOMES.CLAIMED)
  assert.equal(b.outcome, CLAIM_OUTCOMES.LOST_RACE, '占位键里混进了 requestId——两条审批行会各自放行一次')
})

test('② 不同 Attempt 各自的占位互不影响（重试之后该放行就放行）', () => {
  const a = claimOnce({ db, attemptId: 'att-x', bindingHash: 'h-shared', requestId: 'r1', consumedAtText: 'x' })
  const b = claimOnce({ db, attemptId: 'att-y', bindingHash: 'h-shared', requestId: 'r2', consumedAtText: 'x' })
  assert.equal(a.outcome, CLAIM_OUTCOMES.CLAIMED)
  assert.equal(b.outcome, CLAIM_OUTCOMES.CLAIMED, '同一个哈希在不同 Attempt 里被互相锁死了')
})

test('② ★ 没有 Attempt 时按 requestId 命名（不产生假拒绝，也不全局锁）', () => {
  const a = claimOnce({ db, attemptId: null, bindingHash: 'h-noatt', requestId: 'r-na-1', consumedAtText: 'x' })
  const b = claimOnce({ db, attemptId: null, bindingHash: 'h-noatt', requestId: 'r-na-2', consumedAtText: 'x' })
  assert.equal(a.outcome, CLAIM_OUTCOMES.CLAIMED)
  assert.equal(a.attemptScoped, false, '没有 Attempt 却声称具备 Attempt 级去重')
  assert.equal(b.outcome, CLAIM_OUTCOMES.CLAIMED, '没有 Attempt 时按哈希全局锁死了')
})

test('② ★★ 退回占位之后那个键可以再次被占（否则一次竞争会永久废掉一张票）', () => {
  const args = { db, attemptId: 'att-rel', bindingHash: 'h-rel', requestId: 'req-rel', consumedAtText: 'x' }
  const first = claimOnce(args)
  assert.equal(first.outcome, CLAIM_OUTCOMES.CLAIMED)
  const rel = releaseClaim({ db, key: first.key })
  assert.equal(rel.released, true)
  assert.equal(rel.changes, 1)
  const again = claimOnce(args)
  assert.equal(again.outcome, CLAIM_OUTCOMES.CLAIMED, '退回之后仍然占不上——那张票被永久废掉了')
  // 退回一个不存在的键是幂等的（停止路径上多发一次是正常竞态）
  assert.equal(releaseClaim({ db, key: 'no-such-key' }).released, false)
})

test('② 读得出占位的细节，且尝试级清单只列自己的', () => {
  const c = claimOnce({ db, attemptId: 'att-read', bindingHash: 'h-read', requestId: 'req-read', consumedAtText: '2026-09-12T01:00:00.000Z', callId: 'call-7' })
  const row = readClaim({ db, key: c.key })
  assert.equal(row.attemptId, 'att-read')
  assert.equal(row.bindingHash, 'h-read')
  assert.equal(row.requestId, 'req-read')
  assert.equal(row.callId, 'call-7')
  assert.equal(readClaim({ db, key: 'nope' }), null)
  const list = listClaimsOfAttempt({ db, attemptId: 'att-read' })
  assert.equal(list.length, 1)
  assert.equal(list[0].key, c.key)
  assert.equal(listClaimsOfAttempt({ db, attemptId: 'other' }).length, 0)
})

// ---------------------------------------------------------------- ③ 端到端

const TTL_SEEN = new Set()

function makeRuleAndOp(suffix) {
  const action = `p616:act:${suffix}`
  mod.upsertPermissionRule({ id: `p616-rule-${action}`, scope: 'legion', action, target: 'tgt', mode: 'ask', by: 'general' })
  return { scope: 'legion', actor: 'general', action, target: 'tgt' }
}

/** 走一遍真实路径：申请 → 批准。返回 requestId。 */
function requestAndApprove(op, attemptId) {
  const pending = mod.checkPermission({ ...op, attemptId })
  assert.equal(pending.status, 'pending', '夹具应当产生一条待批准请求')
  TTL_SEEN.add(pending.requestId)
  const decided = mod.decidePermission({ requestId: pending.requestId, decision: 'approve', by: 'general' })
  assert.equal(decided.status, 'approved')
  return pending.requestId
}

test('③ ★★ 同一 Attempt + 同一哈希：两次**已批准**的消费只有一次成功', () => {
  // 这是 PRT-616 的核心。两条行都是 approved、哈希都吻合、attemptId 相同——
  // PRT-608 的行级 CAS 对**每一条行**都会成功。只有按 (attemptId, hash) 的
  // 占位能挡住第二次。
  const op = makeRuleAndOp('dup')
  const attemptId = 'att-e2e-dup'
  const first = requestAndApprove(op, attemptId)
  const allowed = mod.checkPermission({ ...op, attemptId, permissionRequestId: first })
  assert.equal(allowed.allowed, true)
  assert.equal(allowed.attemptScoped, true)

  // 手工再造一条**同一个 (attemptId, hash)** 的已批准行，模拟并发下产生的第二条。
  // 正常情况下去重会拦住它（见 ④），所以这里直接写库——并发窗口里就是这样。
  const twin = writeFixtureApproval({
    db, attemptId, status: 'approved', requestId: `perm-twin-${Date.now()}`,
    operation: { ...op, taskId: null, unattended: false, metadata: {} },
  })
  assert.throws(
    () => mod.checkPermission({ ...op, attemptId, permissionRequestId: twin.requestId }),
    (e) => /allow-once-attempt-duplicate/.test(String(e.message)),
    '两条 (attemptId, hash) 相同的已批准行被放行了两次——同一个操作执行两次',
  )
})

test('③ ★★ 重复放行会留审计（值班的人要能查出"它为什么被拒"）', () => {
  const op = makeRuleAndOp('audit')
  const attemptId = 'att-e2e-audit'
  const first = requestAndApprove(op, attemptId)
  mod.checkPermission({ ...op, attemptId, permissionRequestId: first })
  const twin = writeFixtureApproval({
    db, attemptId, status: 'approved', requestId: `perm-twin-a-${Date.now()}`,
    operation: { ...op, taskId: null, unattended: false, metadata: {} },
  })
  try { mod.checkPermission({ ...op, attemptId, permissionRequestId: twin.requestId }) } catch { /* 预期 */ }
  const row = db.prepare("SELECT * FROM audit WHERE action='permission:allow-once-duplicate' AND taskId=?").get(twin.requestId)
  assert.ok(row, '重复放行没有留痕')
  const detail = JSON.parse(row.detail)
  assert.equal(detail.code, ALLOW_ONCE_CODES.ATTEMPT_DUPLICATE)
  assert.equal(detail.attemptId, attemptId)
})

test('③ ★★ 不同 Attempt 的同一个操作**可以**各自放行（占位是按 Attempt 的）', () => {
  const op = makeRuleAndOp('cross')
  const r1 = requestAndApprove(op, 'att-cross-1')
  const a = mod.checkPermission({ ...op, attemptId: 'att-cross-1', permissionRequestId: r1 })
  assert.equal(a.allowed, true)
  const r2 = requestAndApprove(op, 'att-cross-2')
  const b = mod.checkPermission({ ...op, attemptId: 'att-cross-2', permissionRequestId: r2 })
  assert.equal(b.allowed, true, '同一个哈希在另一条 Attempt 里被占位锁死了——重试之后再也放行不了')
})

test('③ ★★ 去重也必须按 Attempt（否则 Attempt #2 会认领 Attempt #1 的待批准行）', () => {
  // 去重的粒度必须等于消费的粒度——这条原则 PRT-608 已经写在代码里，
  // 但当时消费粒度是"整条操作"，去重是"哈希"，`attemptId` 两边都没有。
  const op = makeRuleAndOp('dedup')
  const p1 = mod.checkPermission({ ...op, attemptId: 'att-dedup-1' })
  assert.equal(p1.status, 'pending')
  const p2 = mod.checkPermission({ ...op, attemptId: 'att-dedup-2' })
  assert.notEqual(p2.requestId, p1.requestId, 'Attempt #2 复用了 Attempt #1 的待批准行')
  // 同一条 Attempt 重复申请仍然复用（否则用户会被问两遍同一件事）
  const p1again = mod.checkPermission({ ...op, attemptId: 'att-dedup-1' })
  assert.equal(p1again.requestId, p1.requestId, '同一个 Attempt 内的重复申请没有复用，用户会被重复询问')
})

test('③ ★★ 行级 CAS 输了要**退回占位**（否则这张票被永久废掉）', () => {
  // 占位成功、随后 `approved → consumed` 的 CAS 输了 → 这一次没有放行 →
  // 占位必须退回。不退的话：用户批准了、没人执行，而且之后无论怎么重试
  // 都是"这个操作已经用过了"。
  const op = makeRuleAndOp('rollback')
  const attemptId = 'att-e2e-rollback'
  const requestId = requestAndApprove(op, attemptId)
  const hash = mod.db.prepare(`SELECT ${BINDING_HASH_COLUMN} AS h FROM permission_requests WHERE requestId=?`).get(requestId).h
  const key = consumptionKey({ attemptId, bindingHash: hash })
  // 注入一个"必然丢失"的 consume：占位会成功，行级 CAS 会失败
  assert.throws(
    () => mod.checkPermission(
      { ...op, attemptId, permissionRequestId: requestId },
      { consume: () => ({ outcome: 'lost-race', changes: 0 }) },
    ),
    (e) => /already-consumed|已被并发消费/i.test(String(e.message)),
  )
  assert.equal(readClaim({ db, key }), null, '行级 CAS 输了，占位却留着——这张票被永久废掉了')
  // 而且那张票**仍然可用**（占位已退，行也还没被消费）
  const ok = mod.checkPermission({ ...op, attemptId, permissionRequestId: requestId })
  assert.equal(ok.allowed, true, '退回占位之后这张票仍然放行不了')
})

test('③ ★★ 占位与消费在**同一个事务**里（失败了不留半个状态）', () => {
  // 若两者不在同一事务：占位提交、消费失败 → 上面那条用例的场景就变成
  // "占位永久留下"。这里验的是"退回"确实发生在同一个事务内——
  // 通过 `withTx` 的报错路径不回滚已提交的占位这一行为无法直接观测，
  // 所以改为直接验不变量：任何一次**成功**的消费，账本里必须有且只有一条对应占位。
  const op = makeRuleAndOp('tx')
  const attemptId = 'att-e2e-tx'
  const requestId = requestAndApprove(op, attemptId)
  const before = listClaimsOfAttempt({ db, attemptId }).length
  const r = mod.checkPermission({ ...op, attemptId, permissionRequestId: requestId })
  assert.equal(r.allowed, true)
  const after = listClaimsOfAttempt({ db, attemptId })
  assert.equal(after.length, before + 1, '放行成功了，账本里却没有对应的占位')
  const hash = db.prepare(`SELECT ${BINDING_HASH_COLUMN} AS h FROM permission_requests WHERE requestId=?`).get(requestId).h
  assert.ok(after.some((c) => c.bindingHash === hash), '账本里的哈希与放行的不是同一个')
})

test('③ ★ 消费成功后审批行是 `consumed`（不是还停在 approved）', () => {
  const op = makeRuleAndOp('status')
  const attemptId = 'att-e2e-status'
  const requestId = requestAndApprove(op, attemptId)
  mod.checkPermission({ ...op, attemptId, permissionRequestId: requestId })
  const row = db.prepare('SELECT status, consumedAt FROM permission_requests WHERE requestId=?').get(requestId)
  assert.equal(row.status, 'consumed')
  assert.ok(row.consumedAt, 'consumedAt 没有被写下')
})

test('③ ★★ 占位表**独立于**审批行存在（审批行被删掉也不影响"已经放行过"）', () => {
  // 把不可回收的安全事实放进一张会被清理的表里，表现是
  // "清理跑完之后，同一操作又能被放行一次"。
  const op = makeRuleAndOp('indep')
  const attemptId = 'att-e2e-indep'
  const requestId = requestAndApprove(op, attemptId)
  mod.checkPermission({ ...op, attemptId, permissionRequestId: requestId })
  const claimsBefore = listClaimsOfAttempt({ db, attemptId }).length
  db.prepare('DELETE FROM permission_requests WHERE requestId=?').run(requestId)
  assert.equal(listClaimsOfAttempt({ db, attemptId }).length, claimsBefore, '审批行被删之后占位也没了')
})

test('③ ★ attemptId 被写进了审批行（占位与审批行说的是同一条 Attempt）', () => {
  const op = makeRuleAndOp('link')
  const attemptId = 'att-e2e-link'
  const requestId = requestAndApprove(op, attemptId)
  const row = db.prepare(`SELECT ${APPROVAL_ATTEMPT_COLUMN} AS a FROM permission_requests WHERE requestId=?`).get(requestId)
  assert.equal(row.a, attemptId)
})

test.after(() => { try { db.close() } catch {} ; rmSync(root, { recursive: true, force: true }) })
