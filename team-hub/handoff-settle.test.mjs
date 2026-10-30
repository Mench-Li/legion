// team-hub/handoff-settle.test.mjs
// ---------------------------------------------------------------------------
// 接手结算的**判定**（2026-10-30：实现环认领不了已交付的代码，只能整链重来）。
//
// 这一组守的是"什么样的回执才算这一环可以交出去"——因为结算路上踩过的坑都在判定上：
//   · `unknown`（跑了但超时）被当成通过；
//   · 状态说 passed 但退出码不是 0；
//   · runner 的 args/timeout 与回执不一致（hub 的交接校验会因此 409，而报错文案完全跑偏）。
//
// 运行：node --test team-hub/handoff-settle.test.mjs
// ---------------------------------------------------------------------------
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildImplementationEvidence, buildSettleAttempt, buildSettleCheckpoint, decideSettlement, runnerMatchesReceipt,
} from './handoff-settle.mjs'

const SHA = '717607bfd4fbbadc5ea644717d6acbc82853d092'
const RUNNER = { executable: 'node', args: ['scripts/ci/verify-changed.mjs'], timeoutMs: 3600000 }
const passed = { state: 'passed', exitCode: 0, executable: 'node', args: ['scripts/ci/verify-changed.mjs'], timeoutMs: 3600000 }

test('① 只有 passed + exitCode 0 才允许交出去', () => {
  assert.deepEqual(decideSettlement(passed), { ok: true, state: 'passed', reason: '独立验证通过' })
})

test('② unknown（超时/被中断）不能当通过，也不能当失败', () => {
  const r = decideSettlement({ state: 'unknown', exitCode: null, timeoutMs: 3600000 })
  assert.equal(r.ok, false)
  assert.equal(r.state, 'unknown')
  assert.match(r.reason, /没有跑出结论/)
  assert.match(r.reason, /3600 秒/)
})

test('③ 状态说 passed 但退出码不是 0：按失败处理（只信状态字段最容易被空回执骗过）', () => {
  const r = decideSettlement({ ...passed, exitCode: 1 })
  assert.equal(r.ok, false)
  assert.equal(r.state, 'failed')
  assert.match(r.reason, /退出码是 1/)
})

test('④ 空回执 / 不可识别状态都不放行', () => {
  assert.equal(decideSettlement(null).ok, false)
  assert.match(decideSettlement(null).reason, /没有拿到/)
  assert.equal(decideSettlement({ state: 'weird', exitCode: 0 }).ok, false)
})

test('⑤ runner 与回执必须逐字一致（args 顺序也要）', () => {
  assert.equal(runnerMatchesReceipt(RUNNER, passed), true)
  assert.equal(runnerMatchesReceipt(RUNNER, { ...passed, args: ['-test'] }), false)
  assert.equal(runnerMatchesReceipt(RUNNER, { ...passed, timeoutMs: 900000 }), false, '超时改了也算不一致')
  assert.equal(runnerMatchesReceipt({ ...RUNNER, args: ['--test'] }, passed), false)
  assert.equal(runnerMatchesReceipt(null, passed), false)
})

test('⑥ 结算记录：provider 取冻结值，run id 标注 verify-only，回执原样带上', () => {
  const attempt = buildSettleAttempt({
    attemptId: 'wfa-1', stageId: 'implement', providerName: 'spawn', receipt: passed,
    sourceCommit: SHA, summary: '接手 717607bf', evidence: 'verify-changed 通过', startedAtMs: 1, finishedAtMs: 2,
  })
  assert.equal(attempt.providerName, 'spawn')
  assert.match(attempt.providerRunId, /^verify-only:717607bfd4fb:/, '带唯一后缀：同一提交重试不会撞 idempotency 唯一约束')
  assert.equal(attempt.state, 'completed')
  assert.equal(attempt.result.testReport.passed, true)
  assert.deepEqual(attempt.result.testReport.failures, [])
  assert.equal(attempt.result.testVerification.state, 'passed')
  assert.equal(attempt.result.testReport.command, 'node scripts/ci/verify-changed.mjs')
})

test('⑦ 未通过时 failures 要有内容（不能空着让人猜）', () => {
  const attempt = buildSettleAttempt({
    attemptId: 'wfa-2', stageId: 'implement', providerName: 'spawn',
    receipt: { ...passed, state: 'failed', exitCode: 1, error: '2 suites failed' },
    sourceCommit: SHA, summary: 's', evidence: 'e', startedAtMs: 1, finishedAtMs: 2,
  })
  assert.equal(attempt.result.testReport.passed, false)
  assert.deepEqual(attempt.result.testReport.failures, ['2 suites failed'])
})

test('⑧ 实现证据带 hub 识别的固定前缀，并写明"未派 agent"', () => {
  const text = buildImplementationEvidence({
    passed: true, sourceCommit: SHA, stageAttemptId: 'wfa-1', providerRunId: 'verify-only:717607bfd4fb',
    receipt: passed, testCommand: 'node scripts/ci/verify-changed.mjs', testSummary: '9 suites', testEvidence: 'all green',
  })
  assert.ok(text.startsWith('agent-workflow-implementation:'))
  const body = JSON.parse(text.slice('agent-workflow-implementation:'.length))
  assert.equal(body.passed, true)
  assert.equal(body.sourceCommit, SHA)
  assert.match(body.settledBy, /未派 agent/)
})

test('⑨ 检查点带 `agent-workflow-stage-checkpoint:` 前缀与 sourceCommit（审查环靠它定基线）', () => {
  const text = buildSettleCheckpoint({ stageId: 'implement', sourceCommit: SHA })
  assert.ok(text.startsWith('agent-workflow-stage-checkpoint:'))
  const body = JSON.parse(text.slice('agent-workflow-stage-checkpoint:'.length))
  assert.equal(body.sourceCommit, SHA)
  assert.equal(body.stageId, 'implement')
  assert.deepEqual(body.artifactPaths, [])
})
