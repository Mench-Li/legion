// team-hub/regression-gate.test.mjs
// ============================================================================
// F11 · 不退化门（设计稿 §8.6 / M12，E3）
//
// 目标：任何规则/提示词/岗位包改动，都要证明"没变差"。
//
// 三条不变量决定这个模块的形状：
//   I-11.1 **基线只能由人写**——agent 无权改自己的及格线（白皮书硬约束①）
//   I-11.2 退化必须说清"哪个指标、从多少到多少、阈值几何"，不能只说"变差了"
//   I-11.3 门是**硬的**：没有 --force；紧急放行要单独走审批并留痕
//
// 判据：
//   ① 建表幂等，主键是 (metric, scope)
//   ② 人能设基线；agent / system 被拒（I-11.1）
//   ③ 未知指标被拒
//   ④ 指标在容忍范围内 ⇒ 通过
//   ⑤ 不该变差的指标变差 ⇒ 拦住，且带 metric/baseline/current/threshold（I-11.2）
//   ⑥ 该变好的指标下滑 ⇒ 拦住
//   ⑦ 传 force 无效：门没有后门（I-11.3）
//   ⑧ 没有基线 ⇒ 不通过（不能"没基线就算过"）
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import {
  ensureBaselineSchema,
  setBaseline,
  getBaseline,
  listBaselines,
  checkGate,
  METRIC_POLICY,
  BASELINE_ERRORS,
} from './regression-gate.mjs'

const makeDb = () => { const db = new DatabaseSync(':memory:'); ensureBaselineSchema(db); return db }

test('① 建表幂等，主键 (metric, scope)', () => {
  const db = makeDb()
  assert.doesNotThrow(() => ensureBaselineSchema(db))
  setBaseline(db, { metric: 'mandateMissingRatio', scope: 'default', value: 0, by: 'general', at: '2026-11-03T00:00:00.000Z' })
  setBaseline(db, { metric: 'mandateMissingRatio', scope: 'default', value: 0.01, by: 'general', at: '2026-11-03T01:00:00.000Z' })
  assert.equal(listBaselines(db).length, 1, '★ 同 (metric, scope) 是更新不是新增')
  assert.equal(getBaseline(db, 'mandateMissingRatio', 'default').value, 0.01)
})

test('② 人能设基线；agent / system 被拒（I-11.1）', () => {
  const db = makeDb()
  for (const by of ['agent:coder', 'system', 'daemon', 'bot']) {
    assert.throws(
      () => setBaseline(db, { metric: 'accepted', scope: 'default', value: 5, by }),
      (e) => e.code === BASELINE_ERRORS.HUMAN_REQUIRED,
      `${by} 不该能改及格线`,
    )
  }
  assert.doesNotThrow(() => setBaseline(db, { metric: 'accepted', scope: 'default', value: 5, by: 'general' }))
})

test('③ 未知指标被拒（不给自己发明指标）', () => {
  const db = makeDb()
  assert.throws(
    () => setBaseline(db, { metric: 'vibes', scope: 'default', value: 1, by: 'general' }),
    (e) => e.code === BASELINE_ERRORS.UNKNOWN_METRIC,
  )
})

test('④ 容忍范围内 ⇒ 通过', () => {
  const db = makeDb()
  setBaseline(db, { metric: 'mandateMissingRatio', scope: 'default', value: 0.1, by: 'general' })
  setBaseline(db, { metric: 'accepted', scope: 'default', value: 10, by: 'general' })

  const out = checkGate(db, { metrics: { mandateMissingRatio: 0.11, accepted: 10 }, scope: 'default' })
  assert.equal(out.ok, true)
  assert.deepEqual(out.violations, [])
})

test('⑤「越低越好」变差 ⇒ 拦住，并带四要素（I-11.2）', () => {
  const db = makeDb()
  setBaseline(db, { metric: 'mandateMissingRatio', scope: 'default', value: 0.05, by: 'general' })

  const out = checkGate(db, { metrics: { mandateMissingRatio: 0.4 }, scope: 'default' })
  assert.equal(out.ok, false)
  const v = out.violations.find((x) => x.metric === 'mandateMissingRatio')
  assert.ok(v)
  assert.equal(v.baseline, 0.05)
  assert.equal(v.current, 0.4)
  assert.equal(v.direction, 'lower-better')
  assert.ok(typeof v.threshold === 'number')
  assert.match(String(v.text), /0\.05/)
  assert.match(String(v.text), /0\.4/)
})

test('⑥「越高越好」下滑 ⇒ 拦住', () => {
  const db = makeDb()
  setBaseline(db, { metric: 'accepted', scope: 'default', value: 10, by: 'general' })
  const out = checkGate(db, { metrics: { accepted: 2 }, scope: 'default' })
  assert.equal(out.ok, false)
  assert.equal(out.violations[0].direction, 'higher-better')
})

test('⑦ 传 force 无效：门没有后门（I-11.3）', () => {
  const db = makeDb()
  setBaseline(db, { metric: 'accepted', scope: 'default', value: 10, by: 'general' })
  const out = checkGate(db, { metrics: { accepted: 1 }, scope: 'default', force: true })
  assert.equal(out.ok, false, '★ 门是硬的')
  assert.equal(out.forcedIgnored, true, '传了 force 要如实说"被忽略"')
})

test('⑧ 没有基线 ⇒ 不通过（不能"没基线就算过"）', () => {
  const db = makeDb()
  const out = checkGate(db, { metrics: { accepted: 10 }, scope: 'default' })
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'NO_BASELINE')
  assert.ok(METRIC_POLICY.accepted)
})