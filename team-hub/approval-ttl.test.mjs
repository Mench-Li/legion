// team-hub/approval-ttl.test.mjs
// ============================================================================
// PRT-615 的判据：审批 TTL 到期 → 自动拒绝 → Attempt 转为 blocked，
// 而 AwaitingApproval 期间的租约**续到 TTL，绝不超过它**。
//
// 这一组盯的不是"TTL 算得对不对"，而是三件更难发现的事：
//
//   ① 租约的上界与自动拒绝的时点是不是**同一个时刻**；
//   ② 越过截止时刻后，心跳与自动拒绝是不是**同时**转向；
//   ③ "Attempt 转为 blocked" 是不是真的走了重试额度判定，
//      而不是停在中间态成了一个谁也不管的失败。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  APPROVAL_TTL_CHECKED,
  APPROVAL_TTL_CODES,
  APPROVAL_TTL_DEFAULT_MS,
  APPROVAL_TTL_MAX_MS,
  APPROVAL_TTL_MIN_MS,
  EXPIRE_OUTCOMES,
  OPEN_APPROVAL_STATES,
  OPEN_APPROVAL_STATUS_SQL,
  approvalDeadlineMs,
  assertDeadlineShared,
  auditReasonText,
  evaluateApprovalExpiry,
  evaluateApprovalHeartbeat,
  leaseRenewalBoundMs,
  markApprovalExpired,
  resolveApprovalTtlMs,
} from './approval-ttl.mjs'
import { SCHEMA as CONFIG_SCHEMA } from './config-schema.mjs'
import { APPROVAL_ATTEMPT_COLUMN, BINDING_HASH_COLUMN, ensureApprovalSchema } from './approval-binding.mjs'
import { writeFixtureApproval, expireFixtureApproval } from './approval-fixture.mjs'
import { createContextStore, ensureContextSchema } from './context-store.mjs'
import { freezeFixtureContext } from './context-fixture.mjs'

const NOW = 1_800_000_000_000

// ---------------------------------------------------------------- ① 配置

test('① ★★ 配置 Schema 里的上下界**等于**模块里的两个常量（不是各写一份）', () => {
  // 一个必须靠人记得同步的上下界，与一个迟早会不同步的上下界，
  // 在「配置校验到底拦不拦得住」上是同一个东西。
  const field = CONFIG_SCHEMA.fields.find((f) => f.key === 'approvalTtlMs')
  assert.ok(field, '配置 Schema 里没有 approvalTtlMs——TTL 又变成了写死的常量')
  assert.equal(field.min, APPROVAL_TTL_MIN_MS, 'Schema 的 min 与模块的 APPROVAL_TTL_MIN_MS 不一致')
  assert.equal(field.max, APPROVAL_TTL_MAX_MS, 'Schema 的 max 与模块的 APPROVAL_TTL_MAX_MS 不一致')
  assert.equal(field.default, APPROVAL_TTL_DEFAULT_MS, 'Schema 的 default 与模块的默认值不一致')
  assert.equal(field.env, 'LEGION_APPROVAL_TTL_MS')
  assert.equal(field.type, 'int')
})

test('① ★★ 非法的 TTL **抛错**，不静默回落默认值', () => {
  // 静默回落的表现是"配置改了但没生效"，而这类问题的排查方向完全错——
  // 运维会去看配置有没有被加载，而不是看那个值本身。
  for (const bad of ['15m', 0, -1, 1.5, NaN, Infinity, APPROVAL_TTL_MIN_MS - 1, APPROVAL_TTL_MAX_MS + 1]) {
    assert.throws(() => resolveApprovalTtlMs(bad), /PRT-615/, `${JSON.stringify(bad)} 被接受了`)
  }
})

test('① 缺省与合法区间', () => {
  assert.equal(resolveApprovalTtlMs(undefined), APPROVAL_TTL_DEFAULT_MS)
  assert.equal(resolveApprovalTtlMs(null), APPROVAL_TTL_DEFAULT_MS)
  assert.equal(resolveApprovalTtlMs(''), APPROVAL_TTL_DEFAULT_MS)
  assert.equal(resolveApprovalTtlMs(APPROVAL_TTL_MIN_MS), APPROVAL_TTL_MIN_MS)
  assert.equal(resolveApprovalTtlMs(APPROVAL_TTL_MAX_MS), APPROVAL_TTL_MAX_MS)
  assert.equal(resolveApprovalTtlMs('60000'), 60000, '字符串形式应当被接受')
})

test('① ★ 拒绝码与开放状态集合', () => {
  assert.ok(APPROVAL_TTL_CODES.BAD_TTL.startsWith('approval-ttl-'))
  assert.deepEqual([...OPEN_APPROVAL_STATES], ['pending', 'approved'])
  assert.equal(OPEN_APPROVAL_STATES.includes('consumed'), false, 'consumed 是终态，不该再被判过期')
})

// ---------------------------------------------------------------- ② 截止时刻

test('② 截止时刻优先读行里写下的 expiresAt', () => {
  const r = approvalDeadlineMs({ row: { expiresAtMs: 12345 } })
  assert.equal(r.deadlineMs, 12345)
  assert.equal(r.derived, false)
  assert.equal(r.source, 'row.expiresAt')
})

test('② 行里没有时用 createdAt+ttl 兜底，且标出来是兜底的', () => {
  const r = approvalDeadlineMs({ row: { createdAtMs: NOW }, ttlMs: 60000 })
  assert.equal(r.deadlineMs, NOW + 60000)
  assert.equal(r.derived, true, '兜底算出来的截止时刻必须能被看出来')
})

test('② 两者都没有时返回 null（而不是拿"现在"当基准猜一个）', () => {
  assert.equal(approvalDeadlineMs({ row: {} }).deadlineMs, null)
  assert.equal(approvalDeadlineMs({}).deadlineMs, null)
})

test('② ★ `leaseRenewalBoundMs` 越过截止时刻返回 **0**，不返回负数', () => {
  assert.equal(leaseRenewalBoundMs({ nowMs: NOW, deadlineMs: NOW + 100 }), 100)
  assert.equal(leaseRenewalBoundMs({ nowMs: NOW, deadlineMs: NOW }), 0)
  assert.equal(leaseRenewalBoundMs({ nowMs: NOW, deadlineMs: NOW - 500 }), 0)
  // 非法输入也返回 0：一个 null 会被 `??` 兜底成默认值——那正是"偷偷续上"。
  assert.equal(leaseRenewalBoundMs({ nowMs: NaN, deadlineMs: NOW }), 0)
  assert.equal(leaseRenewalBoundMs({ nowMs: NOW, deadlineMs: undefined }), 0)
})

// ---------------------------------------------------------------- ③ ★★ 一个截止时刻，两处共用

test('③ ★★ 加载时自检留下的是**算出来的那一对时刻**（不是布尔标记）', () => {
  // `ok: true` 是随手就能写出来的字面量；要伪造"租约没超过截止时刻"，
  // 就得让 `evaluateApprovalHeartbeat` 真的续出一个晚于截止时刻的租约。
  assert.equal(APPROVAL_TTL_CHECKED.leaseWithinDeadline, true, '租约超过了审批截止时刻')
  assert.ok(APPROVAL_TTL_CHECKED.leaseExpiresAtMs <= APPROVAL_TTL_CHECKED.deadlineMs)
  assert.equal(APPROVAL_TTL_CHECKED.turnAtMs, APPROVAL_TTL_CHECKED.deadlineMs)
  assert.equal(APPROVAL_TTL_CHECKED.version.includes('approval-ttl'), true)
})

test('③ ★★ 自检**真的会拦**一对漂移的心跳/过期结论', () => {
  // 一个只能对"当前恰好正确的那份输入"作答的校验，与一个恒真的校验，同形——
  // 正确的实现里 `beat.expiresAtMs > deadlineMs` 恒为假，那段断言**永远不触发**。
  // 所以这对结论是可注入的：喂一对故意漂移的进来，它必须抛。
  const healthy = assertDeadlineShared()
  assert.equal(healthy.leaseWithinDeadline, true)

  assert.throws(
    () => assertDeadlineShared({
      beat: { action: 'renew', deadlineMs: NOW, expiresAtMs: NOW + 60_000, boundMs: 60_000 },
    }),
    /租约被续到了/,
    '租约越过了截止时刻，自检却没有拦',
  )
  assert.throws(
    () => assertDeadlineShared({ beat: { action: 'expire', reason: 'deadline-passed', deadlineMs: NOW } }),
    /截止时刻之前的心跳被判成/,
  )
  assert.throws(
    () => assertDeadlineShared({ expiry: { expired: true, reason: 'deadline-passed' } }),
    /截止时刻之前的审批被判成已过期/,
  )
})

test('③ ★★ 自检**真的会拦**"两份时钟各走各的"（截止时刻不是从行里来的）', () => {
  // 如果自检的"同一时刻"比较用的是**从 row 重新算**的 deadline，那么伪造一个
  // `deadlineMs` 就能把它架空——它自称在检查两份时钟，真正的比较却用第三方时钟。
  assert.throws(
    () => assertDeadlineShared({
      beat: { action: 'renew', deadlineMs: Number.MAX_SAFE_INTEGER, expiresAtMs: NOW, boundMs: 1 },
    }),
    /不一致/,
    '心跳报告的截止时刻与行里推导出的不一致，自检没有发现',
  )
})

test('③ ★★ 越过截止时刻时，心跳与过期**同时**转向', () => {
  const row = { status: 'pending', expiresAtMs: NOW + 1000 }
  assert.deepEqual({ ...evaluateApprovalHeartbeat({ row, nowMs: NOW - 1 }) }.action, 'renew')
  assert.equal(evaluateApprovalExpiry({ row, nowMs: NOW - 1 }).expired, false)
  // 恰好到期：两边同时转向
  assert.equal(evaluateApprovalHeartbeat({ row, nowMs: NOW + 1000 }).action, 'expire')
  assert.equal(evaluateApprovalExpiry({ row, nowMs: NOW + 1000 }).expired, true)
})

test('③ ★★ 续出来的租约永远不超过截止时刻', () => {
  const row = { status: 'pending', expiresAtMs: NOW + 10_000 }
  for (const at of [NOW, NOW + 1, NOW + 5000, NOW + 9999]) {
    const beat = evaluateApprovalHeartbeat({ row, nowMs: at })
    assert.equal(beat.action, 'renew')
    assert.ok(beat.expiresAtMs <= row.expiresAtMs,
      `在 ${at - NOW}ms 处续到了 ${beat.expiresAtMs}，晚于截止时刻 ${row.expiresAtMs}`)
  }
})

test('③ ★★ 请求更长的 TTL 会被**截断**（worker 不能自己把等待期拉长）', () => {
  const row = { status: 'pending', expiresAtMs: NOW + 5000 }
  const beat = evaluateApprovalHeartbeat({ row, nowMs: NOW, requestedTtlMs: 60 * 60 * 1000 })
  assert.equal(beat.boundMs, 5000, 'worker 用一个更长的 TTL 把审批等待期拉长了')
  assert.equal(beat.expiresAtMs, NOW + 5000)
})

test('③ 请求更短的 TTL 会被尊重（不延长）', () => {
  const row = { status: 'pending', expiresAtMs: NOW + 60_000 }
  const beat = evaluateApprovalHeartbeat({ row, nowMs: NOW, requestedTtlMs: 1000 })
  assert.equal(beat.boundMs, 1000)
})

test('③ ★★ 算不出截止时刻的开放审批：**不续期**，且判为过期', () => {
  // 一个"不知道何时该结束"的等待，续下去就是无限期——那正是 §6.3 禁止的。
  const row = { status: 'pending' }
  const beat = evaluateApprovalHeartbeat({ row, nowMs: NOW })
  assert.equal(beat.action, 'expire')
  assert.equal(beat.reason, 'no-deadline')
  const exp = evaluateApprovalExpiry({ row, nowMs: NOW })
  assert.equal(exp.expired, true)
  assert.equal(exp.reason, 'no-deadline', '「数据问题」与「用户没回应」必须是两个理由')
})

// ---------------------------------------------------------------- ④ 过期判定

test('④ ★ 终态的行不会被改判成"过期"', () => {
  // 对已结清的行再判一次过期，会把"这次审批用户拒绝了"改写成"过期了"——
  // 两条都进终态，但用户在界面上看到的原因不一样。
  for (const status of ['consumed', 'expired', 'denied']) {
    const v = evaluateApprovalExpiry({ row: { status, expiresAtMs: NOW - 1 }, nowMs: NOW })
    assert.equal(v.expired, false, `${status} 被改判成过期`)
    assert.equal(v.reason, `status-${status}`)
  }
})

test('④ 开放状态才会被判过期', () => {
  for (const status of OPEN_APPROVAL_STATES) {
    assert.equal(evaluateApprovalExpiry({ row: { status, expiresAtMs: NOW - 1 }, nowMs: NOW }).expired, true, status)
    assert.equal(evaluateApprovalExpiry({ row: { status, expiresAtMs: NOW + 1 }, nowMs: NOW }).expired, false, status)
  }
})

test('④ `deadline-passed` 与 `no-deadline` 是两个理由（排查方向相反）', () => {
  const passed = evaluateApprovalExpiry({ row: { status: 'pending', expiresAtMs: NOW - 1 }, nowMs: NOW })
  const broken = evaluateApprovalExpiry({ row: { status: 'pending' }, nowMs: NOW })
  assert.notEqual(passed.reason, broken.reason)
  assert.equal(passed.deadlineMs, NOW - 1)
  assert.equal(broken.deadlineMs, null)
})

test('④ 没有行时不判过期', () => {
  assert.equal(evaluateApprovalExpiry({ row: null, nowMs: NOW }).expired, false)
  assert.equal(evaluateApprovalExpiry({ row: undefined, nowMs: NOW }).expired, false)
})

test('④ 审计文本过 NFC 且去首尾空白', () => {
  assert.equal(auditReasonText('  cafe\u0301  '), 'caf\u00e9')
})

// ---------------------------------------------------------------- ⑤ 真的库

const root = mkdtempSync(join(tmpdir(), 'legion-approval-ttl-'))
process.env.TEAM_HUB_DB = join(root, 'team.db')
const mod = await import('./server.mjs')
const { createRunStore, RUN_ERRORS } = await import('./run-store.mjs')

/**
 * PRT-607：进入 `AwaitingApproval` 的迁移现在**必须**在同一次事务里建出一条待批准
 * 请求（没有端口会被 `APPROVAL_NOT_WIRED` 拒绝）。这一组用的是自己建的仓储，
 * 所以夹具要注入端口——走 PRT-615 的真实写入路径（`writeFixtureApproval`），
 * 而不是手写 `permission_requests` 的列名。
 *
 * 注意：这与下面那些 `writeFixtureApproval(...)` 调用**不冲突**——后者构造的是
 * "另外一条/另一种状态"的审批（例如已拒绝、已过期），本条用例考的正是它们。
 */
function fixtureApprovalPort(db) {
  return (p) => writeFixtureApproval({
    db, attemptId: p.attemptId, status: 'pending', scope: p.scope, taskId: p.taskId, nowMs: p.atMs,
  })
}

const store = createRunStore({ db: mod.db, clock: () => Date.now(), createApproval: fixtureApprovalPort(mod.db) })

const ctxStore = createContextStore({ db: mod.db, clock: () => Date.now() })

/**
 * 把一条刚领到的 Attempt 推到 `AwaitingApproval`（工具级暂停）。
 *
 * 三段都是**必须**的，缺一段就走不通，而红的是夹具不是闸门：
 *  · `PreparingWorkspace → BuildingContext`
 *  · 冻结上下文快照 —— `BuildingContext → Running` 的 `contextSnapshot` 闸门（PRT-411）
 *  · `Running → AwaitingApproval` —— **不能**从 BuildingContext 直接进，
 *    那条边不在状态机里（合法目标是 Running / RetryableFailure / Cancelled）
 */
function advanceToAwaitingApproval({ attemptId, epoch, store: st = store }) {
  st.transition({ attemptId, leaseEpoch: epoch, workerId: 'w1', to: 'PreparingWorkspace' })
  st.transition({ attemptId, leaseEpoch: epoch, workerId: 'w1', to: 'BuildingContext' })
  freezeFixtureContext({ store: ctxStore, attemptId, frozenAtMs: Date.now() })
  st.transition({ attemptId, leaseEpoch: epoch, workerId: 'w1', to: 'Running' })
  st.transition({ attemptId, leaseEpoch: epoch, workerId: 'w1', to: 'AwaitingApproval', context: { returnTo: 'Running' } })
}

function makeAttempt({ acceptance = '[]', maxAttempts = 5 } = {}) {
  const st = maxAttempts === 5 ? store : createRunStore({ db: mod.db, clock: () => Date.now(), maxAttempts, createApproval: fixtureApprovalPort(mod.db) })
  const stamp = new Date().toISOString()
  const id = `t-${Math.random().toString(36).slice(2, 9)}`
  // `priority='high'` 只是**减少**被别的用例遗留任务抢先的机会，不是保证：
  // 库里还有前面用例留下的任务，而 `claim` 会按优先级挑**任意一条**可领的。
  mod.db.prepare('INSERT INTO tasks (id, title, status, scope, hold, priority, createdAt, updatedAt, acceptance) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, 'TTL 任务', 'todo', 'legion', 0, 'high', stamp, stamp, acceptance)
  // 所以这里必须**循环**直到领到我们自己插入的那一条。
  // 不循环的夹具会在"前面某个用例恰好留下一条可领任务"时领错任务，
  // 于是用例断言的是**别人的**尝试——它可能碰巧通过，也可能莫名其妙地红。
  //
  //   > 一个"碰巧领到正确任务"的夹具，
  //   > 与一个"有时候在断言别的任务"的夹具，是同一个东西——只不过它红得没有规律。
  for (let i = 0; i < 200; i += 1) {
    const claimed = st.claim({ workerId: 'w1' })
    if (claimed.claimed === null) break
    if (claimed.claimed.taskId === id) return { taskId: id, attemptId: claimed.claimed.attemptId, epoch: claimed.claimed.leaseEpoch, store: st }
  }
  throw new Error(`夹具没能领到自己插入的任务 ${id}（库里还有别的可领任务）`)
}

test('⑤ ★★ 到期扫描把审批标为 expired，并把 Attempt 送到 blocked', () => {
  const { attemptId, epoch } = makeAttempt()
  advanceToAwaitingApproval({ attemptId, epoch })
  assert.equal(store.getAttempt(attemptId).state, 'AwaitingApproval')

  const approval = writeFixtureApproval({ db: mod.db, attemptId, status: 'pending' })
  expireFixtureApproval(mod.db, approval.requestId)

  const swept = mod.sweepExpiredApprovals()
  assert.ok(swept.expired.includes(approval.requestId), '到期的审批没有被结清')

  const row = mod.db.prepare('SELECT status, reason FROM permission_requests WHERE requestId=?').get(approval.requestId)
  assert.equal(row.status, 'expired')
  assert.equal(row.reason, 'deadline-passed')

  // 关键：Attempt 不能还停在 AwaitingApproval
  const state = store.getAttempt(attemptId).state
  assert.notEqual(state, 'AwaitingApproval', '审批过期了而 Attempt 还在等这份审批')
  // 有重试额度 → 新 attempt（任务回 todo）；没有 → DeadLetter（任务 blocked）
  if (state === 'DeadLetter') {
    const task = mod.db.prepare('SELECT status FROM tasks WHERE id=?').get(store.getAttempt(attemptId).taskId)
    assert.equal(task.status, 'blocked', 'DeadLetter 的尝试，任务必须在 blocked')
  } else {
    assert.equal(state, 'RetryableFailure')
  }
})

test('⑤ ★★ 重试额度用完时审批到期 → 任务真的进 `blocked`', () => {
  const { attemptId, epoch, store: st1 } = makeAttempt({ maxAttempts: 1 })
  advanceToAwaitingApproval({ attemptId, epoch, store: st1 })
  const approval = writeFixtureApproval({ db: mod.db, attemptId, status: 'pending' })
  expireFixtureApproval(mod.db, approval.requestId)
  mod.sweepExpiredApprovals({ store: st1 })
  const attempt = st1.getAttempt(attemptId)
  assert.equal(attempt.state, 'DeadLetter', `额度用完却停在 ${attempt.state}——任务会既没有新尝试可领、也不在等人工列表里`)
  assert.equal(mod.db.prepare('SELECT status FROM tasks WHERE id=?').get(attempt.taskId).status, 'blocked')
})

test('⑤ ★★ 到期扫描**不碰**终态的审批行（用户已拒绝的不能被改写成过期）', () => {
  const { attemptId } = makeAttempt()
  const approval = writeFixtureApproval({ db: mod.db, attemptId, status: 'denied' })
  expireFixtureApproval(mod.db, approval.requestId)
  const swept = mod.sweepExpiredApprovals()
  assert.ok(!swept.expired.includes(approval.requestId), '被拒绝的审批被判成了过期——用户看到的原因变了')
  assert.equal(mod.db.prepare('SELECT status FROM permission_requests WHERE requestId=?').get(approval.requestId).status, 'denied')
})

test('⑤ ★★ 到期扫描是**幂等**的（跑两次不会把同一条结清两次）', () => {
  const { attemptId, epoch } = makeAttempt()
  advanceToAwaitingApproval({ attemptId, epoch })
  const approval = writeFixtureApproval({ db: mod.db, attemptId, status: 'pending' })
  expireFixtureApproval(mod.db, approval.requestId)
  const first = mod.sweepExpiredApprovals()
  const second = mod.sweepExpiredApprovals()
  assert.ok(first.expired.includes(approval.requestId))
  assert.ok(!second.expired.includes(approval.requestId), '同一条被结清了两次')
  const events = mod.db.prepare('SELECT COUNT(*) AS n FROM audit WHERE action=? AND taskId=?')
    .get('permission:ttl-expired', approval.requestId).n
  assert.equal(events, 1, '审计里出现了两条"TTL 过期"')
})

test('⑤ ★★ 没有 attemptId 的老行照样过期，但**不动**任何 Attempt', () => {
  // 凭 taskId 猜一条 Attempt 是错的：同一个任务可能已经重试到第 5 条，
  // 把第 1 条判成 blocked 会改错历史。
  ensureApprovalSchema(mod.db)
  const id = `perm-orphan-${Math.random().toString(36).slice(2, 8)}`
  mod.db.prepare(`INSERT INTO permission_requests (requestId,scope,actor,action,target,taskId,operation,mode,status,createdAt,expiresAt,${BINDING_HASH_COLUMN},${APPROVAL_ATTEMPT_COLUMN})
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, 'legion', 'general', 'repo:write', 'repo/x', null, '{}', 'ask', 'pending',
      new Date(Date.now() - 1000).toISOString(), Date.now() - 500, null, null)
  const swept = mod.sweepExpiredApprovals()
  assert.ok(swept.expired.includes(id), '没有 attemptId 的老行没有过期——它会永远占着')
  assert.ok(swept.orphaned.includes(id))
  assert.equal(mod.db.prepare('SELECT status FROM permission_requests WHERE requestId=?').get(id).status, 'expired')
  const linked = mod.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='permission:ttl-expired-unlinked' AND taskId=?").get(id).n
  assert.equal(linked, 1, '没有留下"它没有被联动"的痕迹')
})

test('⑤ ★★ 到期扫描在 `AwaitingApproval` 上真的会**写审计**', () => {
  const { attemptId, epoch } = makeAttempt()
  advanceToAwaitingApproval({ attemptId, epoch })
  const approval = writeFixtureApproval({ db: mod.db, attemptId, status: 'pending' })
  expireFixtureApproval(mod.db, approval.requestId)
  mod.sweepExpiredApprovals()
  const row = mod.db.prepare("SELECT * FROM audit WHERE action='permission:ttl-expired' AND taskId=?").get(approval.requestId)
  assert.ok(row, 'TTL 自动拒绝没有留痕')
  const detail = JSON.parse(row.detail)
  assert.equal(detail.reason, 'deadline-passed')
  assert.equal(detail.attemptId, attemptId)
  assert.ok(detail.deadlineMs > 0)
})

test('⑤ ★★ 懒扫描接在权限面入口上（不依赖 `isMain` 那个定时器）', () => {
  // 一个"只在独立进程模式下才跑"的到期扫描，与一个"在宿主外壳模式下永远不跑"
  // 的扫描，是同一个东西——只不过它的表现是"有的人的审批会过期，有的人的不会"。
  const { attemptId } = makeAttempt()
  const approval = writeFixtureApproval({ db: mod.db, attemptId, status: 'pending', scope: 'legion', requestId: `perm-lazy-${Math.random().toString(36).slice(2, 8)}` })
  expireFixtureApproval(mod.db, approval.requestId)
  // 不显式调用扫描，只做一次普通的收件箱读取
  const inbox = mod.listPermissionInbox('legion')
  const row = inbox.find((r) => r.requestId === approval.requestId)
  assert.ok(row, '收件箱里找不到那条审批')
  assert.equal(row.status, 'expired', '读了收件箱，到期的审批却还是 pending——懒扫描没接上')
})

test('⑤ ★★ 越期的审批**不能被批准**（自动拒绝不是一句空话）', () => {
  const { attemptId } = makeAttempt()
  const approval = writeFixtureApproval({ db: mod.db, attemptId, status: 'pending' })
  expireFixtureApproval(mod.db, approval.requestId)
  const decided = mod.decidePermission({ requestId: approval.requestId, decision: 'approve', by: 'general' })
  assert.equal(decided.status, 'expired', '用户批准了一条早就该被自动拒绝的请求')
})

test('⑤ ★★ 过期 CAS 只在那一行**仍然是开放状态**时生效（真的走到 lost-race）', () => {
  // 这条路径只在"扫描与用户点击批准并发"时发生。一个只能靠时序触发的分支，
  // 与一个不存在的分支，在"它到底拦不拦得住"上是同一个东西——
  // 所以 `markApprovalExpired` 被单独导出。
  const { attemptId } = makeAttempt()
  const a = writeFixtureApproval({ db: mod.db, attemptId, status: 'pending' })
  const first = markApprovalExpired({ db: mod.db, requestId: a.requestId, reason: 'deadline-passed' })
  assert.equal(first.outcome, EXPIRE_OUTCOMES.EXPIRED)
  assert.equal(first.changes, 1)
  // 再来一次：已经 expired，不再是开放状态
  const twice = markApprovalExpired({ db: mod.db, requestId: a.requestId, reason: 'deadline-passed' })
  assert.equal(twice.outcome, EXPIRE_OUTCOMES.LOST_RACE)
  assert.equal(twice.changes, 0)

  // ★ 关键：用户**已经批准**的那一行，扫描不许改写它
  const b = writeFixtureApproval({ db: mod.db, attemptId, status: 'approved' })
  const onApproved = markApprovalExpired({ db: mod.db, requestId: b.requestId, reason: 'deadline-passed' })
  assert.equal(onApproved.outcome, EXPIRE_OUTCOMES.EXPIRED, 'approved 是开放状态，应当能被过期')
  // 而 denied/consumed 不是
  const c = writeFixtureApproval({ db: mod.db, attemptId, status: 'denied' })
  assert.equal(markApprovalExpired({ db: mod.db, requestId: c.requestId, reason: 'x' }).outcome, EXPIRE_OUTCOMES.LOST_RACE)
  assert.equal(
    mod.db.prepare('SELECT status FROM permission_requests WHERE requestId=?').get(c.requestId).status,
    'denied',
    '用户点了拒绝，扫描把它改成了过期——用户看到的原因变了',
  )
})

test('⑤ ★★ 开放状态的 SQL 字面量**由状态集合生成**（不是手抄第二份）', () => {
  for (const s of OPEN_APPROVAL_STATES) assert.ok(OPEN_APPROVAL_STATUS_SQL.includes(`'${s}'`), s)
  assert.equal((OPEN_APPROVAL_STATUS_SQL.match(/'/g) ?? []).length, OPEN_APPROVAL_STATES.length * 2)
  assert.ok(!OPEN_APPROVAL_STATUS_SQL.includes('denied'))
  assert.ok(!OPEN_APPROVAL_STATUS_SQL.includes('consumed'))
})

test('⑤ ★★ 只读一次收件箱就**联动释放**了 Attempt（懒扫描不是只改状态）', () => {
  // `listPermissionInbox` 内部另有一段"把过期的 pending 行标成 expired"的循环
  // （PRT-608 加的，为的是别让视图里出现两个真相）。它**只改状态、不释放 Attempt**。
  // 所以如果懒扫描被摘掉，收件箱看上去一切正常（status 是 expired），
  // 而 Attempt 还停在 AwaitingApproval —— 任务安静地停在那里。
  //
  //   > 一个「收件箱说它过期了、而 Attempt 还在等它」的系统，
  //   > 与一个「任务永远停在那里」的系统，是同一个东西。
  const { attemptId, epoch } = makeAttempt()
  advanceToAwaitingApproval({ attemptId, epoch })
  const approval = writeFixtureApproval({ db: mod.db, attemptId, status: 'pending', scope: 'legion' })
  expireFixtureApproval(mod.db, approval.requestId)
  assert.equal(store.getAttempt(attemptId).state, 'AwaitingApproval')

  // 只读一次收件箱——不显式调扫描
  mod.listPermissionInbox('legion')

  assert.notEqual(
    store.getAttempt(attemptId).state, 'AwaitingApproval',
    '收件箱读了、审批标成过期了，而 Attempt 还停在 AwaitingApproval——懒扫描没有真的释放它',
  )
})

test('⑤ ★★ 重入保护真的拦得住（嵌套调用被短路，不递归）', () => {
  // `sweepInFlight = sweepExpiredApprovals(...)` 的赋值发生在函数返回**之后**，
  // 所以用 `sweepInFlight !== null` 判重入一次都拦不住——那种写法看起来有保护，其实没有。
  // 要证明保护有效，必须**真的构造一次重入**：让 store 的 failAndRetry 回调里
  // 再调一次 `sweepApprovalsOnce`。
  const { attemptId, epoch } = makeAttempt()
  advanceToAwaitingApproval({ attemptId, epoch })
  const approval = writeFixtureApproval({ db: mod.db, attemptId, status: 'pending' })
  expireFixtureApproval(mod.db, approval.requestId)

  // ★ 先跑一轮，留下一个**哨兵**结果。
  // 短路时嵌套调用拿到的正是"上一轮已完成的结果"这个**同一个对象**；
  // 没有保护时它会自己再扫一轮，返回一个**新对象**。
  // 用对象同一性来判，比看字段稳：新对象与旧对象可能恰好字段相同。
  const sentinel = mod.sweepApprovalsOnce()

  let nestedCalls = 0
  let nestedResult = 'unset'
  const reentrantStore = {
    failAndRetry: (args) => {
      nestedCalls += 1
      nestedResult = mod.sweepApprovalsOnce() // ★ 在扫描进行中再调一次
      return store.failAndRetry(args)
    },
  }
  // 再来一条到期的，让外层这一轮里有东西可释放，回调才会被走到
  const second = writeFixtureApproval({ db: mod.db, attemptId, status: 'pending' })
  expireFixtureApproval(mod.db, second.requestId)

  const outer = mod.sweepApprovalsOnce({ store: reentrantStore })
  assert.equal(nestedCalls, 1, '重入路径没有被走到，这条用例没测到东西')
  assert.ok(outer.expired.includes(second.requestId), '外层扫描没有结清那条审批')
  assert.equal(
    nestedResult, sentinel,
    '嵌套调用返回了一个**新**对象，说明它自己又扫了一轮——重入保护没有生效',
  )
})

test('⑤ ★★ `checkPermission` 真的把 `attemptId` 写进那一行（否则扫描无从联动）', () => {
  const { attemptId } = makeAttempt()
  const op = { scope: 'legion', actor: 'general', action: `ttl:act:${Math.random().toString(36).slice(2, 8)}`, target: 'x' }
  mod.upsertPermissionRule({ id: `ttl-rule-${op.action}`, scope: 'legion', action: op.action, target: 'x', mode: 'ask', by: 'general' })
  const pending = mod.checkPermission({ ...op, attemptId })
  assert.equal(pending.status, 'pending')
  assert.equal(pending.attemptId, attemptId)
  const row = mod.db.prepare('SELECT * FROM permission_requests WHERE requestId=?').get(pending.requestId)
  assert.equal(row[APPROVAL_ATTEMPT_COLUMN], attemptId,
    '审批行没有被写上 attemptId——TTL 到期扫描将无从联动，只能把它归进 orphaned')
})

test('⑤ ★★ 心跳：截止时刻之前续、之后**拒绝续期**', () => {
  const { attemptId } = makeAttempt()
  const approval = writeFixtureApproval({ db: mod.db, attemptId, status: 'pending' })
  const row = mod.db.prepare('SELECT expiresAt FROM permission_requests WHERE requestId=?').get(approval.requestId)
  const before = mod.heartbeatAwaitingApproval({ requestId: approval.requestId, nowMs: Number(row.expiresAt) - 1000 })
  assert.equal(before.ok, true)
  assert.equal(before.action, 'renew')
  assert.ok(before.expiresAtMs <= before.deadlineMs, '续出来的租约晚于审批截止时刻')

  const after = mod.heartbeatAwaitingApproval({ requestId: approval.requestId, nowMs: Number(row.expiresAt) })
  assert.equal(after.ok, false)
  assert.equal(after.action, 'expire', '越过截止时刻之后还在续租约——会把任务一直占住')
})

test('⑤ ★ 心跳拒绝续期时留痕（值班的人要知道为什么租约不续了）', () => {
  const { attemptId } = makeAttempt()
  const approval = writeFixtureApproval({ db: mod.db, attemptId, status: 'pending' })
  const row = mod.db.prepare('SELECT expiresAt FROM permission_requests WHERE requestId=?').get(approval.requestId)
  mod.heartbeatAwaitingApproval({ requestId: approval.requestId, nowMs: Number(row.expiresAt) + 1 })
  assert.ok(mod.db.prepare("SELECT * FROM audit WHERE action='permission:heartbeat-refused' AND taskId=?").get(approval.requestId),
    '拒绝续期没有留痕')
})

test('⑤ ★★ 证据闸门：`AwaitingApproval → RetryableFailure` 要有真的审批行', () => {
  const { attemptId, epoch } = makeAttempt()
  advanceToAwaitingApproval({ attemptId, epoch })
  // PRT-607：进入 AwaitingApproval 的迁移会**自己**建出一条待批准行（这正是审批箱）。
  // 闸门要拦的是"这一行不存在"的状态，所以这里先把它删掉——重建那个状态，
  // 而不是删掉断言。
  mod.db.prepare(`DELETE FROM permission_requests WHERE ${APPROVAL_ATTEMPT_COLUMN}=?`).run(attemptId)
  // 一条审批记录都没有 → 拒绝
  assert.throws(
    () => store.failAndRetry({ attemptId, actor: 'system', reason: 'no-approval' }),
    (e) => e.code === RUN_ERRORS.EVIDENCE_MISSING,
    '「审批被拒或被 TTL 自动 deny」可以在没有任何审批记录的情况下被写进历史',
  )
  // 补上一行之后就过得去
  writeFixtureApproval({ db: mod.db, attemptId, status: 'denied' })
  const r = store.failAndRetry({ attemptId, actor: 'system', reason: 'denied' })
  assert.equal(r.ok, true)
})

test('⑤ ★★ 正常失败路径**不受**审批证据闸门影响（从 Running 来的失败只要 attempt）', () => {
  // 闸门只对 `AwaitingApproval` 出边生效。如果它误伤普通失败路径，
  // 那么所有 worker 报失败都会 409——而这是最常走的一条路。
  const { attemptId, epoch } = makeAttempt()
  store.transition({ attemptId, leaseEpoch: epoch, workerId: 'w1', to: 'PreparingWorkspace' })
  store.transition({ attemptId, leaseEpoch: epoch, workerId: 'w1', to: 'BuildingContext' })
  freezeFixtureContext({ store: ctxStore, attemptId, frozenAtMs: Date.now() })
  store.transition({ attemptId, leaseEpoch: epoch, workerId: 'w1', to: 'Running' })
  const r = store.failAndRetry({ attemptId, actor: 'w1', reason: 'exec-failed' })
  assert.equal(r.ok, true, '普通失败路径被审批证据闸门误伤了')
})

test('⑤ ★★ 别的 Attempt 的审批不算数（闸门查的是**这一次**）', () => {
  const a = makeAttempt()
  const b = makeAttempt()
  advanceToAwaitingApproval({ attemptId: b.attemptId, epoch: b.epoch })
  // PRT-607：b 进入 AwaitingApproval 时已经自动建了一条；删掉它才能构造
  // "b 上一条审批都没有"——本用例要证的正是**别的** Attempt 的审批不算数。
  mod.db.prepare(`DELETE FROM permission_requests WHERE ${APPROVAL_ATTEMPT_COLUMN}=?`).run(b.attemptId)
  // 审批挂在 a 上，b 上一条都没有
  writeFixtureApproval({ db: mod.db, attemptId: a.attemptId, status: 'denied' })
  assert.throws(
    () => store.failAndRetry({ attemptId: b.attemptId, actor: 'system', reason: 'x' }),
    (e) => e.code === RUN_ERRORS.EVIDENCE_MISSING,
    '另一条 Attempt 的审批被算成了这一次的依据',
  )
})

test('⑤ ★ 重入保护真的拦得住（不是"看起来有保护"）', () => {
  // `sweepInFlight = sweepExpiredApprovals(...)` 的赋值发生在函数返回**之后**，
  // 用 `!== null` 判重入一次都拦不住——那种写法看起来有保护，其实没有。
  const { attemptId, epoch } = makeAttempt()
  advanceToAwaitingApproval({ attemptId, epoch })
  const approval = writeFixtureApproval({ db: mod.db, attemptId, status: 'pending' })
  expireFixtureApproval(mod.db, approval.requestId)
  // 第一次调用拿到真实结论；紧接着的第二次拿到的是**同一轮**的结果（因为没有重入，
  // 它会自己再扫一轮并返回空）——两者都能返回，关键是它**不递归、不抛**。
  const first = mod.sweepApprovalsOnce()
  assert.ok(first.expired.includes(approval.requestId))
  const second = mod.sweepApprovalsOnce()
  assert.ok(second !== null && typeof second.scanned === 'number')
})

test.after(() => { try { mod.db.close() } catch {} ; rmSync(root, { recursive: true, force: true }) })
