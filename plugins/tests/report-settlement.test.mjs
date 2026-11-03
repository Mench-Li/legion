// plugins/tests/report-settlement.test.mjs
// ============================================================================
// F1 · Report 四态（设计稿 §3 F1 / M2）
//
// 病灶：`WorkerReport.status` 只有 `done | blocked` 两个值，于是士兵遇到
//   「这活不值得做 / 已不必要」 只能报 done（假完成，污染验收）
//   「在等外部条件 / 等人」     只能报 blocked（假受阻，制造噪音）
//
// 本族把两件事分开：
//   · **意图**：done / waiting / blocked / dropped（四态，结构化）
//   · **结算**：每个意图映射到「任务状态 + 是否发消息 + 审计动作」
//
// 钉住的判据：
//   ① 常量固定（四态 + waitFor 枚举）
//   ② waiting 缺 wait_for ⇒ 拒收（不能退化成第二种 blocked）
//   ③ 未支持的状态（如 ready）⇒ 明确拒收，不静默当 done
//   ④ dropped ⇒ 不发消息、终态 done、标 no-action、仍留审计
//   ⑤ done / blocked 与今天行为一致（回归）
// ============================================================================
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  REPORT_STATES,
  WAIT_FOR_REASONS,
  REPORT_SETTLEMENT_ERRORS,
  normalizeReport,
  settlementFor,
} from '../lib/reportSettlement.js'

const throwsCode = (fn, code) => {
  let error = null
  try { fn() } catch (e) { error = e }
  assert.ok(error, `期望抛出 ${code}`)
  assert.equal(error.code, code, `期望 ${code}，实际 ${error?.code}`)
}

test('① 常量固定：四态与 waitFor 枚举不外扩', () => {
  assert.deepEqual([...REPORT_STATES], ['done', 'waiting', 'blocked', 'dropped'])
  assert.deepEqual([...WAIT_FOR_REASONS].sort(),
    ['ci-result', 'dependency', 'external-review', 'human-decision', 'upstream-merge'])
  assert.equal(typeof REPORT_SETTLEMENT_ERRORS.WAIT_FOR_REQUIRED, 'string')
})

test('② waiting 必须带 wait_for（否则退化成第二种 blocked）', () => {
  throwsCode(() => normalizeReport({ status: 'waiting' }), REPORT_SETTLEMENT_ERRORS.WAIT_FOR_REQUIRED)
  throwsCode(() => normalizeReport({ status: 'waiting', wait_for: '  ' }), REPORT_SETTLEMENT_ERRORS.WAIT_FOR_REQUIRED)
  throwsCode(() => normalizeReport({ status: 'waiting', wait_for: 'whatever' }), REPORT_SETTLEMENT_ERRORS.WAIT_FOR_UNKNOWN)

  const ok = normalizeReport({ status: 'waiting', wait_for: 'ci-result' })
  assert.equal(ok.status, 'waiting')
  assert.equal(ok.waitFor, 'ci-result')
})

test('③ 未支持的状态明确拒收，不静默当 done', () => {
  for (const status of ['ready', 'progress', 'failed', '']) {
    throwsCode(() => normalizeReport({ status }), REPORT_SETTLEMENT_ERRORS.UNKNOWN_STATUS)
  }
})

test('④ dropped：不发消息、终态 canceled、标 no-action、仍留审计', () => {
  const plan = settlementFor(normalizeReport({ status: 'dropped', summary: '需求已被 8f2a 覆盖' }))
  assert.equal(plan.taskStatus, 'canceled', '★ Legion 的 done 只有将军能写；「无需处理」= 取消')
  assert.equal(plan.reportState, 'dropped')
  assert.equal(plan.noAction, true, '★ 看板要显示「无需处理」，而不是普通完成')
  assert.equal(plan.emitsMessage, false, '★ dropped 的全部意义是不打扰人')
  assert.equal(plan.auditAction, 'drop', '★ 不打扰不等于不留痕')
})

test('⑤ done / blocked 与今天一致（回归）', () => {
  const done = settlementFor(normalizeReport({ status: 'done' }))
  assert.equal(done.taskStatus, 'in_review')
  assert.equal(done.emitsMessage, true)
  assert.equal(done.noAction, false)

  const blocked = settlementFor(normalizeReport({ status: 'blocked' }))
  assert.equal(blocked.taskStatus, 'blocked')
  assert.equal(blocked.emitsMessage, true)
})

test('⑥ waiting：留在 in_progress，但**不发**进度噪音', () => {
  const plan = settlementFor(normalizeReport({ status: 'waiting', wait_for: 'external-review' }))
  assert.equal(plan.taskStatus, 'in_progress')
  assert.equal(plan.reportState, 'waiting')
  assert.equal(plan.emitsMessage, false)
  assert.equal(plan.waitFor, 'external-review')
})

test('⑦ dropped 与 blocker 同时出现时，dropped 优先（不因残留 blocker 变成受阻）', () => {
  const plan = settlementFor(normalizeReport({ status: 'dropped', blocker: '顺带记一句' }))
  assert.equal(plan.taskStatus, 'canceled')
  assert.equal(plan.emitsMessage, false)
})
