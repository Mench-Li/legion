// team-hub/decisions.test.mjs
// ============================================================================
// F4 · 受理台账 `decisions`（设计稿 §3 F4 / M5）
//
// 这张表要回答的问题是：**这个候选为什么没做？**
// 所以每条评估都必须落一行——包括"本来可以、但容量满了"（would_accept=1 的 ignore）。
//
// 判据：
//   ① 建表幂等
//   ② accept 必须有依据（I-4.1）：既无 matchedRuleIds 又非 manual ⇒ 拒收
//   ③ 分流四种：accept / stop / ignore / unavailable，且**每种都带 reason**
//   ④ 推断受理但空间不允许 ⇒ ignore + would_accept=1（不是简单的 stop）
//   ⑤ 闸过但没容量 ⇒ ignore + would_accept=1（"本来能做"必须留痕）
//   ⑥ 列表可按 kind / wouldAccept 过滤
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import {
  DECISION_KINDS,
  DECISION_ERRORS,
  ensureDecisionSchema,
  recordDecision,
  decideForCandidate,
  listDecisions,
} from './decisions.mjs'
import { buildMandate } from './mandate-policy.mjs'

const makeDb = () => { const db = new DatabaseSync(':memory:'); ensureDecisionSchema(db); return db }
const mandate = (over = {}) => buildMandate({
  basisRuleIds: ['R-2'],
  scope: { fileDomain: ['team-hub/'], stages: ['coder'] },
  ...over,
})

test('① 建表幂等：跑两次不报错', () => {
  const db = makeDb()
  assert.doesNotThrow(() => ensureDecisionSchema(db))
  assert.deepEqual([...DECISION_KINDS], ['accept', 'stop', 'ignore', 'unavailable'])
})

test('② accept 必须有依据（I-4.1）', () => {
  const db = makeDb()
  assert.throws(
    () => recordDecision(db, { subject: 'task:T-1', kind: 'accept', by: 'general', at: '2026-11-03T00:00:00.000Z', matchedRuleIds: [], manual: false }),
    (e) => e.code === DECISION_ERRORS.MISSING_BASIS,
  )
  // manual 可替代依据
  assert.doesNotThrow(() => recordDecision(db, {
    subject: 'task:T-1', kind: 'accept', by: 'general', at: '2026-11-03T00:00:00.000Z', matchedRuleIds: [], manual: true,
  }))
})

test('③ 分流：闸通过 + 有容量 ⇒ accept；未知 kind ⇒ 拒收', () => {
  const out = decideForCandidate({ mandate: mandate(), ctx: { paths: ['team-hub/x.mjs'], acceptMode: 'manual' }, hasRoom: true })
  assert.equal(out.kind, 'accept')
  assert.equal(out.wouldAccept, false)
  assert.ok(out.reason.length > 0)

  assert.throws(() => recordDecision(makeDb(), { subject: 'task:T-1', kind: 'maybe', by: 'g', at: 'x', matchedRuleIds: ['R-2'] }),
    (e) => e.code === DECISION_ERRORS.UNKNOWN_KIND)
})

test('④ 闸不过 ⇒ stop，且 reason 说清是哪条闸', () => {
  const out = decideForCandidate({
    mandate: mandate({ basisRuleIds: [] }),
    ctx: { paths: [], acceptMode: 'manual' }, hasRoom: true,
  })
  assert.equal(out.kind, 'stop')
  assert.equal(out.code, 'MISSING_BASIS')
  assert.match(out.reason, /依据/)
})

test('⑤ 推断受理但空间不允许 ⇒ ignore + would_accept=1（I-4.5）', () => {
  const out = decideForCandidate({
    mandate: mandate({ strength: 'inferred' }),
    ctx: { paths: [], acceptMode: 'manual' }, hasRoom: true,
  })
  assert.equal(out.kind, 'ignore')
  assert.equal(out.wouldAccept, true, '★ "本来可以"要留痕')
})

test('⑥ 闸过但没容量 ⇒ ignore + would_accept=1（不是 stop）', () => {
  const out = decideForCandidate({ mandate: mandate(), ctx: { paths: [], acceptMode: 'manual' }, hasRoom: false })
  assert.equal(out.kind, 'ignore')
  assert.equal(out.wouldAccept, true)
  assert.match(out.reason, /容量|并发|满/)
})

test('⑦ 落库 + 过滤：kind / wouldAccept', () => {
  const db = makeDb()
  recordDecision(db, { subject: 'task:T-1', kind: 'accept', by: 'general', at: '2026-11-03T01:00:00.000Z', matchedRuleIds: ['R-2'] })
  recordDecision(db, { subject: 'task:T-2', kind: 'ignore', by: 'general', at: '2026-11-03T01:01:00.000Z', matchedRuleIds: [], wouldAccept: true, reason: '容量满' })
  recordDecision(db, { subject: 'task:T-3', kind: 'stop', by: 'general', at: '2026-11-03T01:02:00.000Z', matchedRuleIds: [], reason: '越域' })

  assert.equal(listDecisions(db).length, 3)
  assert.deepEqual(listDecisions(db, { kind: 'ignore' }).map((d) => d.subject), ['task:T-2'])
  assert.deepEqual(listDecisions(db, { wouldAccept: true }).map((d) => d.subject), ['task:T-2'])
  const [row] = listDecisions(db, { kind: 'accept' })
  assert.deepEqual(JSON.parse(row.matched_rule_ids), ['R-2'])
  assert.equal(row.policy_version.length > 0, true)
})

test('⑧ 每次评估都答得出"为什么"（reason 非空是硬要求）', () => {
  const cases = [
    { mandate: mandate(), ctx: {}, hasRoom: true },
    { mandate: mandate(), ctx: {}, hasRoom: false },
    { mandate: null, ctx: {}, hasRoom: true },
    { mandate: mandate({ revoked: true }), ctx: {}, hasRoom: true },
  ]
  for (const c of cases) {
    const out = decideForCandidate(c)
    assert.equal(typeof out.reason, 'string')
    assert.ok(out.reason.trim().length > 0, '★ 沉默的拒绝等于没拒绝')
  }
})
