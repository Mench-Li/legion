// team-hub/handoff-settle-run.test.mjs
// ---------------------------------------------------------------------------
// 接手结算的**落点**（2026-10-30）。
//
// 判定是纯函数、另有单测；这一组守的是"判定出来之后，状态落到哪儿"：
//   · passed → done，且实现证据/检查点都写了（审查环靠它们认领）
//   · failed / unknown → **in_review**（不是 done、更不是静默 200），评论里带原因
//   · 回执与冻结 runner 不一致 → 直接拒绝，一个字都不落库
//
// 运行：node --test team-hub/handoff-settle-run.test.mjs
// ---------------------------------------------------------------------------
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { settleHandoff } from './handoff-settle-run.mjs'

const SHA = '717607bfd4fbbadc5ea644717d6acbc82853d092'
const RUNNER = { executable: 'node', args: ['scripts/ci/verify-changed.mjs'], timeoutMs: 3600000 }

function makeTask() {
  return {
    id: 'T-240', role: 'coder', status: 'todo',
    agentSelectionSnapshot: {
      workflowStageId: 'implement',
      agentToolConfig: { providerName: 'spawn' },
      adopt: { taskId: 'T-224', commit: SHA, branch: 'w/T-224' },
      reviewWorkflow: { stageDefinitionsById: { implement: { testRunner: RUNNER } } },
    },
  }
}

function deps(over = {}) {
  const calls = { attempts: [], evidence: [], statuses: [] }
  return {
    calls,
    loadTask: () => makeTask(),
    assertSettleable: () => {},
    prepareWorktree: async () => 'D:/tmp/wt',
    runRunner: async () => ({ state: 'passed', exitCode: 0, ...RUNNER, outputExcerpt: 'all green' }),
    saveAttempt: (a) => calls.attempts.push(a),
    appendEvidence: (id, text, by) => calls.evidence.push({ id, text, by }),
    setStatus: (id, status, comment) => calls.statuses.push({ id, status, comment }),
    ...over,
  }
}

test('① 通过：置 done，写下检查点 + 实现证据（审查环认领所需）', async () => {
  const d = deps()
  const result = await settleHandoff({ taskId: 'T-240', by: 'general' }, d)
  assert.equal(result.ok, true)
  assert.deepEqual(d.calls.statuses.map((s) => s.status), ['done'])
  assert.equal(d.calls.attempts.length, 1)
  assert.equal(d.calls.attempts[0].result.testReport.passed, true)
  const kinds = d.calls.evidence.map((e) => e.text.slice(0, 34))
  assert.ok(kinds.some((k) => k.startsWith('agent-workflow-stage-checkpoint:')), '缺检查点：审查环定不了基线')
  assert.ok(kinds.some((k) => k.startsWith('agent-workflow-implementation:')), '缺实现证据：审查环认领不了')
  assert.match(d.calls.statuses[0].comment, /未派 agent/)
})

test('② 未通过：停在 in_review，评论带退出码（不能置 done）', async () => {
  const d = deps({ runRunner: async () => ({ state: 'failed', exitCode: 1, ...RUNNER, error: 'boom' }) })
  const result = await settleHandoff({ taskId: 'T-240', by: 'general' }, d)
  assert.equal(result.ok, false)
  assert.deepEqual(d.calls.statuses.map((s) => s.status), ['in_review'])
  assert.match(d.calls.statuses[0].comment, /退出码 1/)
  assert.equal(d.calls.evidence.length, 0, '没通过就不该写实现证据')
})

test('③ 未知（超时/中断）：同样停 in_review，但原因写"没有跑出结论"', async () => {
  const d = deps({ runRunner: async () => ({ state: 'unknown', exitCode: null, ...RUNNER }) })
  const result = await settleHandoff({ taskId: 'T-240', by: 'general' }, d)
  assert.equal(result.ok, false)
  assert.deepEqual(d.calls.statuses.map((s) => s.status), ['in_review'])
  assert.match(d.calls.statuses[0].comment, /没有跑出结论/)
})

test('④ 回执与冻结 runner 不一致：直接拒绝，不落库', async () => {
  const d = deps({ runRunner: async () => ({ state: 'passed', exitCode: 0, ...RUNNER, args: ['--test'] }) })
  await assert.rejects(() => settleHandoff({ taskId: 'T-240', by: 'general' }, d), (e) => e.code === 'HANDOFF_RECEIPT_MISMATCH')
  assert.equal(d.calls.attempts.length, 0)
  assert.equal(d.calls.statuses.length, 0)
})

test('⑤ 冻结阶段没有 runner：具名拒绝，不去猜一个命令来跑', async () => {
  const task = makeTask()
  task.agentSelectionSnapshot.reviewWorkflow.stageDefinitionsById.implement.testRunner = null
  const d = deps({ loadTask: () => task })
  await assert.rejects(() => settleHandoff({ taskId: 'T-240', by: 'general' }, d), (e) => e.code === 'HANDOFF_NO_RUNNER')
})

test('⑥ 不可结算的任务：在动 git 之前就被拦下', async () => {
  let prepared = 0
  const d = deps({
    assertSettleable: () => { throw Object.assign(new Error('只有实现阶段能接手结算'), { code: 'HANDOFF_NOT_SETTLEABLE' }) },
    prepareWorktree: async () => { prepared += 1; return 'x' },
  })
  await assert.rejects(() => settleHandoff({ taskId: 'T-999', by: 'general' }, d), (e) => e.code === 'HANDOFF_NOT_SETTLEABLE')
  assert.equal(prepared, 0)
})
