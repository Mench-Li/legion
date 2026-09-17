// team-hub/event-delivery.test.mjs
// ============================================================================
// F-05 投递状态机的判据。
//
// 这一组用例要回答的**不是**"六个状态字符串存在吗"，而是三件在改动前无人回答的事：
//
//   ① **跳过要被记下来**。`scope` 不匹配的帧原来是一个静默 `continue`——
//      "这条不属于你所以没投"与"这条从没产生过"在事后是同一个东西。
//   ② **写失败要能被看见**。`res.write` 的返回值被丢掉时，"发过了"是假的。
//   ③ **崩溃不许猜**。取走之后进程死掉：记 `delivered` 是谎报，退回 `pending` 是重投，
//      唯一诚实的答案是 `unknown`。
//
// 另有一组**结构级**变红对照（对源码做字符串检查），因为这三条纪律里有一条
// （`delivered` 只能从 `delivering` 来）的失效形态是"在应用层加了个 `if`"——
// 那种实现能过全部行为用例，却在并发下失效。所以这里直接钉住 SQL 里的 `WHERE`。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import {
  DELIVERY_STATES,
  DEFAULT_DELIVERY_LEASE_MS,
  RETRYABLE_DELIVERY_STATES,
  SUPPRESS_REASONS,
  TERMINAL_DELIVERY_STATES,
  assertDeliveryStateTotal,
  createEventDeliveryStore,
  cursorAdvances,
  ensureEventDeliverySchema,
  isDeliveryState,
  isRetryableDeliveryState,
  isTerminalDeliveryState,
  normalizeDeliveryState,
} from './event-delivery.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 临时库 + 可注入的钟。**所有时间都由钟决定**，因此"租约到期"是确定性跨过去的，不用 sleep。 */
function fixture({ deliveryLeaseMs = DEFAULT_DELIVERY_LEASE_MS } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'legion-deliv-'))
  const db = new DatabaseSync(join(dir, 'team.db'))
  let t = 1_000_000
  const store = createEventDeliveryStore({ db, clock: () => t, deliveryLeaseMs })
  return {
    db,
    store,
    dir,
    scope: 'software',
    advance: (ms) => { t += ms },
    now: () => t,
    dispose: () => { try { db.close() } catch { /* 已关 */ } rmSync(dir, { recursive: true, force: true }) },
  }
}

const ev = (seq, scope = 'software') => ({ seq, scope, event: 'task:update', action: 'task:update', id: seq })

// ---------------------------------------------------------------- 状态清单

test('六个状态与文档逐个对齐，且终态/可重试两档不重叠', () => {
  assert.deepEqual([...DELIVERY_STATES],
    ['pending', 'delivering', 'delivered', 'suppressed', 'failed', 'unknown'])
  assert.deepEqual([...TERMINAL_DELIVERY_STATES], ['delivered', 'suppressed', 'unknown'])
  assert.deepEqual([...RETRYABLE_DELIVERY_STATES], ['pending', 'failed'])
  // 重叠会让"一个状态既不用再投、又要重投"同时成立。
  for (const s of RETRYABLE_DELIVERY_STATES) assert.equal(isTerminalDeliveryState(s), false, `${s} 不该是终态`)
})

test('自检对**做坏的**表会报问题（否则它只是一句恒真的话）', () => {
  assert.equal(assertDeliveryStateTotal().ok, true)
  // ① 少一个状态
  const missing = DELIVERY_STATES.filter((s) => s !== 'unknown')
  assert.equal(assertDeliveryStateTotal(missing).ok, false)
  assert.ok(assertDeliveryStateTotal(missing).problems.some((p) => p.includes('unknown')))
  // ② 重复状态
  assert.equal(assertDeliveryStateTotal([...DELIVERY_STATES, 'pending']).ok, false)
  // ③ 抑制原因清单为空
  assert.equal(assertDeliveryStateTotal(DELIVERY_STATES, []).ok, false)
  // ④ 抑制原因重复
  assert.equal(assertDeliveryStateTotal(DELIVERY_STATES, ['policy', 'policy']).ok, false)
  // ⑤ 空字符串状态
  assert.equal(assertDeliveryStateTotal(['', ...DELIVERY_STATES]).ok, false)
})

test('认不出的状态**抛错**，绝不回落到任何一档', () => {
  assert.equal(normalizeDeliveryState('delivered'), 'delivered')
  for (const bad of ['Delivered', 'DELIVERED', 'done', '', null, undefined, 0, {}, ['pending']]) {
    assert.throws(() => normalizeDeliveryState(bad), /未知的投递状态/,
      `${JSON.stringify(bad)} 被接受了——"认不出"被归到了某一档`)
  }
  assert.equal(isDeliveryState('unknown'), true)
  assert.equal(isDeliveryState('Unknown'), false)
})

test('游标只在终态推进：`failed` 不推进（这正是它可重试的原因）', () => {
  assert.equal(cursorAdvances('delivered'), true)
  assert.equal(cursorAdvances('suppressed'), true)
  assert.equal(cursorAdvances('unknown'), true)
  assert.equal(cursorAdvances('failed'), false)
  assert.equal(cursorAdvances('pending'), false)
  assert.equal(cursorAdvances('delivering'), false)
})

// ---------------------------------------------------------------- plan

test('plan 把 scope 不匹配的帧落成 `suppressed` + 具名原因，而不是静默跳过', () => {
  const f = fixture()
  try {
    f.store.registerSubscriber({ subscriberId: 'sub-a', kind: 'workbench', scope: 'software' })
    const r = f.store.plan({
      subscriberId: 'sub-a',
      events: [ev(1, 'software'), ev(2, 'ozon'), ev(3, 'software')],
    })
    assert.equal(r.created, 3)
    assert.equal(r.existing, 0)
    // ② 号是别人的：它**有**一条记录，而且带原因。
    assert.deepEqual(r.suppressed, [{ seq: 2, reason: 'scope-mismatch' }])
    const two = f.store.readRow('sub-a', 2)
    assert.equal(two.state, 'suppressed')
    assert.equal(two.reason, 'scope-mismatch')
    // 反向对照：另外两条不是 suppressed —— 否则"全都抑制"也能过上面那条。
    assert.equal(f.store.readRow('sub-a', 1).state, 'pending')
    assert.equal(f.store.readRow('sub-a', 3).state, 'pending')
  } finally { f.dispose() }
})

test('订阅者 scope 为 null 表示全部；空串不是"全部"', () => {
  const f = fixture()
  try {
    f.store.registerSubscriber({ subscriberId: 'all', kind: 'workbench', scope: null })
    const r = f.store.plan({ subscriberId: 'all', events: [ev(1, 'software'), ev(2, 'ozon')] })
    assert.equal(r.suppressed.length, 0, 'scope=null 的订阅者不该被抑制任何帧')
    // 空串必须被拒：它与"scope 就叫空"分不开，而那种字符串在 JSON 里完全合法。
    assert.throws(() => f.store.registerSubscriber({ subscriberId: 'x', kind: 'workbench', scope: '' }),
      /scope 必须是 null/)
  } finally { f.dispose() }
})

test('plan 幂等：已投过的行不会被重新 plan 成 pending（重启不重投）', () => {
  const f = fixture()
  try {
    f.store.registerSubscriber({ subscriberId: 's', kind: 'workbench', scope: null })
    f.store.plan({ subscriberId: 's', events: [ev(1)] })
    f.store.takeUp({ subscriberId: 's', seqs: [1] })
    f.store.markDelivered({ subscriberId: 's', seqs: [1] })
    // 模拟"服务重启后重新回放同一段事件"。
    const again = f.store.plan({ subscriberId: 's', events: [ev(1)] })
    assert.equal(again.created, 0)
    assert.equal(again.existing, 1)
    assert.equal(f.store.readRow('s', 1).state, 'delivered',
      '重启把一条已投递的行打回了 pending —— 那会让重复通知永远修不掉')
  } finally { f.dispose() }
})

test('plan 拒绝未登记的订阅者，也拒绝坏 seq', () => {
  const f = fixture()
  try {
    assert.throws(() => f.store.plan({ subscriberId: 'ghost', events: [ev(1)] }), /订阅者未登记/)
    f.store.registerSubscriber({ subscriberId: 's', kind: 'workbench' })
    assert.throws(() => f.store.plan({ subscriberId: 's', events: [{ scope: 'x' }] }), /seq 必须是非负安全整数/)
    assert.throws(() => f.store.plan({ subscriberId: 's', events: [ev(-1)] }), /seq 必须是非负安全整数/)
    assert.throws(() => f.store.plan({ subscriberId: 's', events: [ev(1.5)] }), /seq 必须是非负安全整数/)
    assert.throws(() => f.store.plan({ subscriberId: 's', events: [null] }), /每一项必须是对象/)
  } finally { f.dispose() }
})

// ---------------------------------------------------------------- takeUp / CAS

test('takeUp 只能取 pending/failed；已 delivering 的第二次取走被拒', () => {
  const f = fixture()
  try {
    f.store.registerSubscriber({ subscriberId: 's', kind: 'workbench' })
    f.store.plan({ subscriberId: 's', events: [ev(1), ev(2)] })
    const first = f.store.takeUp({ subscriberId: 's', seqs: [1, 2] })
    assert.deepEqual([...first.claimed], [1, 2])
    assert.equal(first.refused.length, 0)
    // 并发场景：另一个投递者也想投 1 号。
    const second = f.store.takeUp({ subscriberId: 's', seqs: [1] })
    assert.deepEqual([...second.claimed], [])
    assert.deepEqual(second.refused, [{ seq: 1, state: 'delivering' }])
    assert.equal(f.store.readRow('s', 1).attempts, 1, '被拒的取走不该把 attempts 加上去')
  } finally { f.dispose() }
})

test('takeUp 对**没有这一行**的 seq 报 `missing`（不是编一个状态）', () => {
  const f = fixture()
  try {
    f.store.registerSubscriber({ subscriberId: 's', kind: 'workbench' })
    const r = f.store.takeUp({ subscriberId: 's', seqs: [42] })
    assert.deepEqual(r.refused, [{ seq: 42, state: 'missing' }])
  } finally { f.dispose() }
})

test('takeUp 会记租约到期时间，且用的是**注入的权威时间**', () => {
  const f = fixture({ deliveryLeaseMs: 5000 })
  try {
    f.store.registerSubscriber({ subscriberId: 's', kind: 'workbench' })
    f.store.plan({ subscriberId: 's', events: [ev(1)] })
    f.store.takeUp({ subscriberId: 's', seqs: [1] })
    assert.equal(f.store.readRow('s', 1).leaseExpiresAtMs, f.now() + 5000)
    assert.throws(() => f.store.takeUp({ subscriberId: 's', seqs: [], leaseMs: 0 }), /leaseMs 必须是正的有限数/)
  } finally { f.dispose() }
})

// ---------------------------------------------------------------- delivered / failed

test('markDelivered 只能从 `delivering` 来：没发就记成发了会被拒', () => {
  const f = fixture()
  try {
    f.store.registerSubscriber({ subscriberId: 's', kind: 'workbench' })
    f.store.plan({ subscriberId: 's', events: [ev(1)] })
    // ★ 关键：**没有 takeUp**，直接从 pending 记 delivered。
    const r = f.store.markDelivered({ subscriberId: 's', seqs: [1] })
    assert.deepEqual([...r.delivered], [], 'pending → delivered 被放行了 —— 那等于允许"没发就记成发了"')
    assert.deepEqual(r.refused, [{ seq: 1, state: 'pending' }])
    assert.equal(f.store.readRow('s', 1).state, 'pending')
    // 正常路径仍然通。
    f.store.takeUp({ subscriberId: 's', seqs: [1] })
    const ok = f.store.markDelivered({ subscriberId: 's', seqs: [1] })
    assert.deepEqual([...ok.delivered], [1])
    assert.equal(f.store.readRow('s', 1).state, 'delivered')
    assert.equal(f.store.readRow('s', 1).leaseExpiresAtMs, null, '投完必须把租约清掉')
  } finally { f.dispose() }
})

test('markFailed 必填错误原因，且**不推进游标**', () => {
  const f = fixture()
  try {
    f.store.registerSubscriber({ subscriberId: 's', kind: 'workbench' })
    f.store.plan({ subscriberId: 's', events: [ev(1)] })
    assert.throws(() => f.store.takeUp({ subscriberId: 's', seqs: [1] }) && f.store.markFailed({ subscriberId: 's', seqs: [1], error: '  ' }),
      /error 必须是非空字符串/)
    f.store.takeUp({ subscriberId: 's', seqs: [1] })
    const r = f.store.markFailed({ subscriberId: 's', seqs: [1], error: 'EPIPE' })
    assert.deepEqual([...r.failed], [1])
    assert.equal(f.store.readRow('s', 1).state, 'failed')
    assert.equal(f.store.readRow('s', 1).lastError, 'EPIPE')
    assert.equal(f.store.cursorOf('s'), 0, '失败的投递**不许**推进游标——推进了那个洞就再也不会被投')
  } finally { f.dispose() }
})

test('failed 可以重投，且重投会带上 attempts 计数', () => {
  const f = fixture()
  try {
    f.store.registerSubscriber({ subscriberId: 's', kind: 'workbench' })
    f.store.plan({ subscriberId: 's', events: [ev(1)] })
    f.store.takeUp({ subscriberId: 's', seqs: [1] })
    f.store.markFailed({ subscriberId: 's', seqs: [1], error: 'EPIPE' })
    const again = f.store.takeUp({ subscriberId: 's', seqs: [1] })
    assert.deepEqual([...again.claimed], [1])
    assert.equal(f.store.readRow('s', 1).attempts, 2)
    f.store.markDelivered({ subscriberId: 's', seqs: [1] })
    assert.equal(f.store.cursorOf('s'), 1)
  } finally { f.dispose() }
})

// ---------------------------------------------------------------- suppress

test('suppress 必须给封闭清单里的原因；自由文本被拒', () => {
  const f = fixture()
  try {
    f.store.registerSubscriber({ subscriberId: 's', kind: 'workbench' })
    f.store.plan({ subscriberId: 's', events: [ev(1)] })
    assert.throws(() => f.store.suppress({ subscriberId: 's', seq: 1, reason: '因为我觉得不该发' }),
      /抑制原因必须是清单里的一种/)
    assert.throws(() => f.store.suppress({ subscriberId: 's', seq: 1, reason: null }),
      /抑制原因必须是清单里的一种/)
    for (const reason of SUPPRESS_REASONS) {
      const f2 = fixture()
      try {
        f2.store.registerSubscriber({ subscriberId: 's', kind: 'workbench' })
        f2.store.plan({ subscriberId: 's', events: [ev(1)] })
        const r = f2.store.suppress({ subscriberId: 's', seq: 1, reason })
        assert.equal(r.ok, true, `清单里的 ${reason} 应被接受`)
        assert.equal(f2.store.readRow('s', 1).reason, reason)
      } finally { f2.dispose() }
    }
  } finally { f.dispose() }
})

test('suppress 推进游标（抑制是终态），但已投递的不能再被抑制', () => {
  const f = fixture()
  try {
    f.store.registerSubscriber({ subscriberId: 's', kind: 'workbench' })
    f.store.plan({ subscriberId: 's', events: [ev(1), ev(2)] })
    f.store.takeUp({ subscriberId: 's', seqs: [1] })
    f.store.markDelivered({ subscriberId: 's', seqs: [1] })
    const r = f.store.suppress({ subscriberId: 's', seq: 1, reason: 'policy' })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'DELIVERY_NOT_SUPPRESSIBLE')
    assert.equal(r.state, 'delivered')
    // 2 号从 pending 被抑制 → 游标必须越过 2（它不会再有下文）。
    f.store.suppress({ subscriberId: 's', seq: 2, reason: 'retention' })
    assert.equal(f.store.cursorOf('s'), 2)
    // 不存在的行是另一个码：别把"没有这一行"说成"状态不对"。
    assert.equal(f.store.suppress({ subscriberId: 's', seq: 99, reason: 'policy' }).code, 'DELIVERY_ROW_MISSING')
  } finally { f.dispose() }
})

// ---------------------------------------------------------------- 崩溃收敛

test('租约过期 → `unknown`，既不谎报 delivered 也不重投', () => {
  const f = fixture({ deliveryLeaseMs: 1000 })
  try {
    f.store.registerSubscriber({ subscriberId: 's', kind: 'workbench' })
    f.store.plan({ subscriberId: 's', events: [ev(1), ev(2)] })
    f.store.takeUp({ subscriberId: 's', seqs: [1, 2] })
    // 还没到期：什么都不该被回收。
    assert.equal(f.store.recoverExpired().recovered.length, 0)
    f.advance(1001)
    const r = f.store.recoverExpired()
    assert.deepEqual(r.recovered.map((x) => x.seq), [1, 2])
    assert.equal(f.store.readRow('s', 1).state, 'unknown')
    assert.equal(f.store.readRow('s', 1).leaseExpiresAtMs, null)
    assert.match(f.store.readRow('s', 1).lastError, /租约到期/)
    // ★ 反向对照：它**不是** delivered（谎报可见性），也**不是** pending（重投一条可能已到的）。
    assert.notEqual(f.store.readRow('s', 1).state, 'delivered')
    assert.notEqual(f.store.readRow('s', 1).state, 'pending')
    // unknown 不可自动重投。
    const retry = f.store.takeUp({ subscriberId: 's', seqs: [1] })
    assert.deepEqual([...retry.claimed], [])
    assert.deepEqual(retry.refused, [{ seq: 1, state: 'unknown' }])
  } finally { f.dispose() }
})

test('回收只碰**过期**的租约：另一个进程正在投的行不许被收走', () => {
  const f = fixture({ deliveryLeaseMs: 10_000 })
  try {
    f.store.registerSubscriber({ subscriberId: 's', kind: 'workbench' })
    f.store.registerSubscriber({ subscriberId: 'other', kind: 'workbench' })
    f.store.plan({ subscriberId: 's', events: [ev(1)] })
    f.store.plan({ subscriberId: 'other', events: [ev(1)] })
    f.store.takeUp({ subscriberId: 's', seqs: [1] })           // 长租约
    f.store.takeUp({ subscriberId: 'other', seqs: [1], leaseMs: 1 }) // 短租约
    f.advance(5)
    const r = f.store.recoverExpired()
    assert.deepEqual(r.recovered, [{ subscriberId: 'other', seq: 1 }])
    assert.equal(f.store.readRow('s', 1).state, 'delivering', '别人正在投的行被当成崩溃收走了')
    assert.equal(f.store.readRow('other', 1).state, 'unknown')
  } finally { f.dispose() }
})

test('回收是幂等的：第二次没有东西可收', () => {
  const f = fixture({ deliveryLeaseMs: 1 })
  try {
    f.store.registerSubscriber({ subscriberId: 's', kind: 'workbench' })
    f.store.plan({ subscriberId: 's', events: [ev(1)] })
    f.store.takeUp({ subscriberId: 's', seqs: [1] })
    f.advance(10)
    assert.equal(f.store.recoverExpired().recovered.length, 1)
    assert.equal(f.store.recoverExpired().recovered.length, 0)
  } finally { f.dispose() }
})

// ---------------------------------------------------------------- 游标

test('游标跨过连续终态段，遇到洞就停（洞不许被跳过）', () => {
  const f = fixture()
  try {
    f.store.registerSubscriber({ subscriberId: 's', kind: 'workbench' })
    f.store.plan({ subscriberId: 's', events: [ev(1), ev(2), ev(3), ev(4)] })
    // 1 已投、2 失败、3 已投、4 已投。
    f.store.takeUp({ subscriberId: 's', seqs: [1, 2, 3, 4] })
    f.store.markDelivered({ subscriberId: 's', seqs: [1, 3, 4] })
    f.store.markFailed({ subscriberId: 's', seqs: [2], error: 'EPIPE' })
    f.store.advanceCursor({ subscriberId: 's' })
    assert.equal(f.store.cursorOf('s'), 1, '游标越过了失败的那一条 —— 那个洞永远不会再被投')
    // 补上 2 之后，游标一次跨到 4。
    f.store.takeUp({ subscriberId: 's', seqs: [2] })
    f.store.markDelivered({ subscriberId: 's', seqs: [2] })
    assert.equal(f.store.cursorOf('s'), 4)
  } finally { f.dispose() }
})

test('游标单调：重算不会让它回退', () => {
  const f = fixture()
  try {
    f.store.registerSubscriber({ subscriberId: 's', kind: 'workbench' })
    f.store.plan({ subscriberId: 's', events: [ev(5), ev(6)] })
    f.store.takeUp({ subscriberId: 's', seqs: [5, 6] })
    f.store.markDelivered({ subscriberId: 's', seqs: [5, 6] })
    assert.equal(f.store.cursorOf('s'), 6)
    // 直接改库制造一个"不该发生"的状态（模拟有人手工改数据/数据损坏）。
    f.db.prepare("UPDATE event_deliveries SET state = 'pending' WHERE subscriber_id = ? AND seq = ?").run('s', 5)
    f.store.advanceCursor({ subscriberId: 's' })
    const cur = f.store.cursorOf('s')
    assert.equal(cur, 6, '游标回退了 —— 会让已经投过的事件重投一遍')
    // 但 suspended pending 行本身仍然留在那里（游标不回退 ≠ 假装它不存在）。
    assert.equal(f.store.readRow('s', 5).state, 'pending')
  } finally { f.dispose() }
})

test('未知 state 在被读到时**如实记成 unrecognized**，不丢进已知档', () => {
  const f = fixture()
  try {
    f.store.registerSubscriber({ subscriberId: 's', kind: 'workbench' })
    f.store.plan({ subscriberId: 's', events: [ev(1)] })
    f.db.prepare('UPDATE event_deliveries SET state = ? WHERE subscriber_id = ? AND seq = ?').run('wut', 's', 1)
    const st = f.store.stateOf('s')
    assert.equal(st.counts['unrecognized:wut'], 1)
    // ★ 这条是本用例存在的理由：只数四个已知非终态的实现在这里会说 `settled: true`，
    //   于是"数据损坏"被读成"投递完毕"。
    assert.equal(st.settled, false, '一个不认识的 state 被算成了"投递完毕"')
    assert.deepEqual([...st.unrecognizedStates], ['wut'])
    assert.ok(f.store.summary().counts['unrecognized:wut'] === 1)
  } finally { f.dispose() }
})

// ---------------------------------------------------------------- stateOf / summary

test('stateOf 的 `settled` 判据是"没有任何非终态行"，而不是"最近一次成功"', () => {
  const f = fixture()
  try {
    f.store.registerSubscriber({ subscriberId: 's', kind: 'workbench' })
    f.store.plan({ subscriberId: 's', events: [ev(1), ev(2)] })
    assert.equal(f.store.stateOf('s').settled, false)
    assert.equal(f.store.stateOf('s').oldestOutstandingSeq, 1)
    f.store.takeUp({ subscriberId: 's', seqs: [1] })
    f.store.markDelivered({ subscriberId: 's', seqs: [1] })
    // 1 成功了，但 2 还没投 ⇒ **没结清**。用"最近成功"当判据的实现在这里会说 true。
    assert.equal(f.store.stateOf('s').settled, false)
    assert.equal(f.store.stateOf('s').oldestOutstandingSeq, 2)
    f.store.takeUp({ subscriberId: 's', seqs: [2] })
    f.store.markDelivered({ subscriberId: 's', seqs: [2] })
    assert.equal(f.store.stateOf('s').settled, true)
    assert.equal(f.store.stateOf('s').oldestOutstandingSeq, null)
  } finally { f.dispose() }
})

test('未登记的订阅者：`exists:false` 而不是抛错（查询不该因为"没有"就炸）', () => {
  const f = fixture()
  try {
    const st = f.store.stateOf('ghost')
    assert.equal(st.exists, false)
    assert.equal(st.cursorSeq, null)
    assert.equal(f.store.cursorOf('ghost'), null)
    assert.equal(f.store.subscriberOf('ghost'), null)
  } finally { f.dispose() }
})

test('summary 汇总所有订阅者 + 六态总计 + 过期租约数', () => {
  const f = fixture({ deliveryLeaseMs: 100 })
  try {
    f.store.registerSubscriber({ subscriberId: 'a', kind: 'workbench' })
    f.store.registerSubscriber({ subscriberId: 'b', kind: 'workbench' })
    f.store.plan({ subscriberId: 'a', events: [ev(1), ev(2)] })
    f.store.plan({ subscriberId: 'b', events: [ev(1)] })
    f.store.takeUp({ subscriberId: 'a', seqs: [1] })
    f.store.markDelivered({ subscriberId: 'a', seqs: [1] })
    f.store.takeUp({ subscriberId: 'a', seqs: [2] })
    f.store.takeUp({ subscriberId: 'b', seqs: [1] })
    const s = f.store.summary()
    assert.equal(s.subscribers.length, 2)
    assert.equal(s.counts.delivered, 1)
    assert.equal(s.counts.delivering, 2)
    assert.equal(s.expiredLeases, 0)
    f.advance(101)
    assert.equal(f.store.summary().expiredLeases, 2)
  } finally { f.dispose() }
})

test('rowsOf 按状态筛，且拒绝坏 limit / 坏状态', () => {
  const f = fixture()
  try {
    f.store.registerSubscriber({ subscriberId: 's', kind: 'workbench' })
    f.store.plan({ subscriberId: 's', events: [ev(1), ev(2), ev(3)] })
    f.store.takeUp({ subscriberId: 's', seqs: [1] })
    f.store.markDelivered({ subscriberId: 's', seqs: [1] })
    assert.deepEqual(f.store.rowsOf('s', { state: 'delivered' }).map((r) => r.seq), [1])
    assert.deepEqual(f.store.rowsOf('s', { state: 'pending' }).map((r) => r.seq), [2, 3])
    assert.equal(f.store.rowsOf('s').length, 3)
    assert.throws(() => f.store.rowsOf('s', { state: 'wut' }), /未知的投递状态/)
    assert.throws(() => f.store.rowsOf('s', { limit: 0 }), /limit 必须是正安全整数/)
  } finally { f.dispose() }
})

test('重复登记不重置游标（重置等于把已投的再投一遍）', () => {
  const f = fixture()
  try {
    f.store.registerSubscriber({ subscriberId: 's', kind: 'workbench', scope: 'software' })
    f.store.plan({ subscriberId: 's', events: [ev(1)] })
    f.store.takeUp({ subscriberId: 's', seqs: [1] })
    f.store.markDelivered({ subscriberId: 's', seqs: [1] })
    assert.equal(f.store.cursorOf('s'), 1)
    // 同一个 id 换 kind/scope 再登记（浏览器重连、kind 改版）。
    f.store.registerSubscriber({ subscriberId: 's', kind: 'browser', scope: 'ozon' })
    assert.equal(f.store.cursorOf('s'), 1, '重新登记把游标清零了')
    assert.equal(f.store.subscriberOf('s').kind, 'browser')
    assert.equal(f.store.readRow('s', 1).state, 'delivered', '重新登记把已投的行打回了')
  } finally { f.dispose() }
})

test('建表幂等 + 老库补列（重复 ensureEventDeliverySchema 不抛）', () => {
  const f = fixture()
  try {
    assert.doesNotThrow(() => ensureEventDeliverySchema(f.db))
    assert.doesNotThrow(() => ensureEventDeliverySchema(f.db))
    const cols = f.db.prepare('PRAGMA table_info(event_deliveries)').all().map((c) => c.name)
    for (const c of ['subscriber_id', 'seq', 'scope', 'state', 'reason', 'attempts', 'last_error',
      'created_at_ms', 'updated_at_ms', 'delivered_at_ms', 'lease_expires_at_ms']) {
      assert.ok(cols.includes(c), `event_deliveries 缺列 ${c}`)
    }
    const subCols = f.db.prepare('PRAGMA table_info(event_subscribers)').all().map((c) => c.name)
    for (const c of ['subscriber_id', 'kind', 'scope', 'cursor_seq', 'registered_at_ms', 'last_seen_at_ms', 'received_count', 'note']) {
      assert.ok(subCols.includes(c), `event_subscribers 缺列 ${c}`)
    }
  } finally { f.dispose() }
})

test('两个独立连接（模拟两个进程）看得到同一批投递', () => {
  const f = fixture()
  const db2 = new DatabaseSync(join(f.dir, 'team.db'))
  try {
    const store2 = createEventDeliveryStore({ db: db2, clock: f.now })
    f.store.registerSubscriber({ subscriberId: 's', kind: 'workbench' })
    f.store.plan({ subscriberId: 's', events: [ev(1)] })
    // 另一个"进程"取走并投递。
    const up = store2.takeUp({ subscriberId: 's', seqs: [1] })
    assert.deepEqual([...up.claimed], [1], 'WAL 下第二个连接看不到第一行 —— 跨进程投递不成立')
    store2.markDelivered({ subscriberId: 's', seqs: [1] })
    assert.equal(f.store.readRow('s', 1).state, 'delivered')
    assert.equal(f.store.cursorOf('s'), 1)
  } finally {
    try { db2.close() } catch { /* 已关 */ }
    f.dispose()
  }
})

// ---------------------------------------------------------------- 结构级对照

test('结构性：`delivered` 的 SQL 里**必须**带 `state = \'delivering\'` 的条件（CAS，不是应用层 if）', () => {
  const src = readFileSync(join(HERE, 'event-delivery.mjs'), 'utf8')
  // 定位 markDelivered 里那条 UPDATE 的 SQL 片段。
  const m = /state = 'delivered', delivered_at_ms[\s\S]*?WHERE subscriber_id = \? AND seq = \? AND state = 'delivering'/
    .exec(src)
  assert.ok(m !== null,
    'markDelivered 的 UPDATE 没有把 `state = \'delivering\'` 放进 WHERE —— '
    + '只在应用层 if 判断的话，并发下两个调用方都会放行，于是"没发就记成发了"重新变得可能')
  // 反向对照：takeUp 与 markFailed 也各自要带自己的条件。
  assert.match(src, /state IN \('pending','failed'\)/, "takeUp 的取走条件丢了")
  assert.match(src, /WHERE subscriber_id = \? AND seq = \? AND state = 'delivering'/, 'markFailed 的 CAS 条件丢了')
})

test('结构性：广播路径不许再自己写 `res.write`（必须走投递仓储）', () => {
  const src = readFileSync(join(HERE, 'server.mjs'), 'utf8')
  const broadcast = /function broadcastAudit\(entry\) \{[\s\S]*?\n\}/.exec(src)
  assert.ok(broadcast !== null, '找不到 broadcastAudit —— 这条结构检查已失效，需要重新钉住')
  const body = broadcast[0]
  assert.match(body, /delivery/,
    'broadcastAudit 里没有出现投递仓储 —— 静默 `continue` / 丢掉 res.write 返回值的写法又回来了')
})
