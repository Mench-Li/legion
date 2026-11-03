// team-hub/mandate-policy.test.mjs
// ============================================================================
// F4 · 授权台账：`mandate` 与确定性准入（设计稿 §3 F4 / M5，DEC-1）
//
// 目标：任何任务都答得出「凭什么开工」。所以 mandate 是**不可变的授权记录**，
// 准入是一组**确定性闸门**（与 claim-policy 同一形态：SQL 片段 + holds() 镜像 + 一致性断言）。
//
// 判据：
//   ① 没有依据（既无 basisRuleIds 又非 manual）⇒ 拒（MISSING_BASIS）
//   ② inferred 且空间不是 auto ⇒ 只写 would_accept，不入队（I-4.5）
//   ③ 期望路径超出 fileDomain ⇒ 拒（OUT_OF_MANDATE）；空 fileDomain 一律拒（fail-closed）
//   ④ 已撤回 ⇒ 拒（REVOKED）；且 `revoked` 与调度 `hold` **不共用字段**（I-4.3）
//   ⑤ 变宽/变更 ⇒ 新版本（version+1、supersedes 指旧版本），旧版本仍可读（I-4.2）
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MANDATE_SCHEMA_ID,
  MANDATE_POLICY_VERSION,
  STRENGTHS,
  ACCEPT_MODES,
  MANDATE_GATES,
  MANDATE_ERRORS,
  buildMandate,
  mandateAllows,
  widenMandate,
} from './mandate-policy.mjs'

const explicit = (over = {}) => buildMandate({
  requestedBy: { kind: 'user', id: 'u-1' },
  grantedBy: { kind: 'general', id: 'general' },
  basisRuleIds: ['R-2'],
  scope: { fileDomain: ['team-hub/routes/'], stages: ['coder'] },
  grantedAt: '2026-11-03T00:00:00.000Z',
  ...over,
})

test('① 形状固定：schema / 版本 / 枚举', () => {
  const m = explicit()
  assert.equal(m.schema, MANDATE_SCHEMA_ID)
  assert.equal(m.version, 1)
  assert.equal(m.policyVersion, MANDATE_POLICY_VERSION)
  assert.deepEqual([...STRENGTHS], ['explicit', 'inferred'])
  assert.deepEqual([...ACCEPT_MODES], ['auto', 'manual', 'off'])
  assert.ok(Object.isFrozen(m), '★ mandate 不可变')
  assert.equal('hold' in m, false, '★ hold 是调度拦截，不是授权字段（I-4.3）')
})

test('② 正常授权：显式 + 有依据 + 路径在域内 ⇒ 通过', () => {
  const verdict = mandateAllows(explicit(), { paths: ['team-hub/routes/task-report.mjs'], acceptMode: 'manual' })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.code, null)
})

test('③ 没有依据 ⇒ MISSING_BASIS（不能"什么都没说就开工"）', () => {
  const noBasis = explicit({ basisRuleIds: [], manual: false })
  const verdict = mandateAllows(noBasis, { acceptMode: 'manual' })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, MANDATE_ERRORS.MISSING_BASIS)
  assert.equal(verdict.failedGate, 'has-basis')
})

test('④ manual 可替代依据（人手点过就是依据）', () => {
  const manual = explicit({ basisRuleIds: [], manual: true })
  assert.equal(mandateAllows(manual, { acceptMode: 'manual' }).ok, true)
})

test('⑤ inferred + 空间非 auto ⇒ 只写 would_accept，不入队（I-4.5）', () => {
  const inferred = explicit({ strength: 'inferred' })
  const manualSpace = mandateAllows(inferred, { acceptMode: 'manual' })
  assert.equal(manualSpace.ok, false)
  assert.equal(manualSpace.code, MANDATE_ERRORS.INFERRED_NEEDS_AUTO)
  assert.equal(manualSpace.wouldAcceptOnly, true, '★ 台账要记 would_accept=1，而不是简单拒绝')

  const autoSpace = mandateAllows(inferred, { acceptMode: 'auto' })
  assert.equal(autoSpace.ok, true, '空间允许自动受理时 inferred 可以进')
})

test('⑥ 路径超出 fileDomain ⇒ OUT_OF_MANDATE；空域一律拒（fail-closed）', () => {
  const out = mandateAllows(explicit(), { paths: ['scrum/taskctl.mjs'], acceptMode: 'manual' })
  assert.equal(out.ok, false)
  assert.equal(out.code, MANDATE_ERRORS.OUT_OF_MANDATE)
  assert.equal(out.failedGate, 'in-scope')

  const empty = mandateAllows(explicit({ scope: { fileDomain: [], stages: [] } }), { paths: ['team-hub/routes/x.mjs'], acceptMode: 'manual' })
  assert.equal(empty.ok, false, '★ 没有明确授权的目录 = 什么都不许改')
})

test('⑦ 已撤回 ⇒ REVOKED（撤回不是 hold）', () => {
  const revoked = explicit({ revoked: true, revokedAt: '2026-11-03T02:00:00.000Z' })
  const out = mandateAllows(revoked, { acceptMode: 'manual' })
  assert.equal(out.ok, false)
  assert.equal(out.code, MANDATE_ERRORS.REVOKED)
  assert.equal(out.failedGate, 'not-revoked')
})

test('⑧ 变宽 ⇒ 新版本：version+1、supersedes 指旧版本，旧对象不被改（I-4.2）', () => {
  const v1 = explicit()
  const v2 = widenMandate(v1, { scope: { fileDomain: ['team-hub/routes/', 'team-hub/scripts/'], stages: ['coder'] } }, { at: '2026-11-03T03:00:00.000Z' })

  assert.equal(v1.version, 1, '★ 旧版本不动')
  assert.equal(v2.version, 2)
  assert.equal(v2.supersedes, 1)
  assert.deepEqual([...v2.scope.fileDomain], ['team-hub/routes/', 'team-hub/scripts/'])
  assert.equal(mandateAllows(v2, { paths: ['team-hub/scripts/merge-open-questions.mjs'], acceptMode: 'manual' }).ok, true)
  assert.ok(Object.isFrozen(v2))
})

test('⑨ 每个闸都有 SQL 片段与 holds 镜像（与 claim-policy 同形态）', () => {
  for (const gate of MANDATE_GATES) {
    assert.equal(typeof gate.id, 'string')
    assert.equal(typeof gate.holds, 'function')
    assert.equal(typeof gate.userText, 'string')
  }
  const ids = MANDATE_GATES.map((g) => g.id)
  for (const id of ['has-basis', 'strength-visible', 'in-scope', 'not-revoked']) {
    assert.ok(ids.includes(id), `缺闸 ${id}`)
  }
})
