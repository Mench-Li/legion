// plugins/tests/workflow-timeout-attribution.test.mjs
// ============================================================================
// BUG-043 回归：工作流阶段"没有可确认终态"时必须**可归因**。
//
// 缺陷形态（现场记录 docs/bugs/BUG-043-...md）：
//   timeout / 启动失败 / provider 拒绝 / 取消竞态 全部被记成同一个
//   `stop_reason='outcome-unknown'`，而且超时那条路径**不打日志**。
//   于是 T-224 跑了 56.9 分钟、超过配置上限也没被砍，事后无法从 Attempt 判断
//   到底是"看门狗没响"还是"provider 自己挂了"。
//
// 本套件钉两件事：
//   ① `workflowUnknownStopReason` 的优先级（取消 > 超时 > provider 拒绝 > 未知）；
//   ② `waitForWorkflowAgentRun` 到点确实返回 `timedOut: true` 并发出了 abort ——
//      这是"看门狗有没有响"唯一能被断言的那一刻。
// ============================================================================
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  waitForWorkflowAgentRun,
  workflowUnknownStopReason,
} from '../../runtime/adapters/dsh/workflow-run.mjs'

test('取消与超时同时发生：取消优先（保留现有"用户已取消"的语义）', () => {
  assert.equal(workflowUnknownStopReason({ timedOut: true, taskCanceled: true }), 'canceled-race')
})

test('只是超时：记 timeout，不再混进 outcome-unknown', () => {
  assert.equal(workflowUnknownStopReason({ timedOut: true }), 'timeout')
})

test('provider result promise 被拒：记 provider-rejected', () => {
  assert.equal(workflowUnknownStopReason({ failureType: 'ProductSubagentError' }), 'provider-rejected')
})

test('没有任何可归因信号：才退回 outcome-unknown', () => {
  assert.equal(workflowUnknownStopReason({}), 'outcome-unknown')
  assert.equal(workflowUnknownStopReason({ failureType: '' }), 'outcome-unknown')
})

test('到点未结算：waitForWorkflowAgentRun 返回 timedOut=true 并 abort', async () => {
  let aborted = false
  const controller = {
    signal: new AbortController().signal,
    abort() { aborted = true },
  }
  const never = new Promise(() => {})
  const startedAt = Date.now()
  const outcome = await waitForWorkflowAgentRun({
    run: { result: never },
    taskId: 'T-TEST',
    getTask: async () => ({ status: 'in_progress' }),
    controller,
    timeoutMs: 30,
    pollIntervalMs: 5,
  })
  assert.equal(outcome.timedOut, true, '超时必须以 timedOut=true 浮出来，否则上层只能记 unknown')
  assert.equal(outcome.result, null)
  assert.equal(outcome.taskCanceled, false)
  assert.equal(aborted, true, '超时必须发出 abort，否则子代理可能继续写同一个 worktree')
  assert.ok(Date.now() - startedAt >= 25, '不应在 timeoutMs 之前结算')
})

test('正常返回：timedOut=false 且原样带回结果', async () => {
  const controller = { signal: new AbortController().signal, abort() { assert.fail('不应 abort') } }
  const outcome = await waitForWorkflowAgentRun({
    run: { result: Promise.resolve({ stopReason: 'completed', structured: { status: 'done' } }) },
    taskId: 'T-TEST',
    getTask: async () => ({ status: 'in_progress' }),
    controller,
    timeoutMs: 1_000,
    pollIntervalMs: 5,
  })
  assert.equal(outcome.timedOut, false)
  assert.deepEqual(outcome.result, { stopReason: 'completed', structured: { status: 'done' } })
})

test('任务被取消：taskCanceled=true、发出 abort，并带回 provider 的取消终态', async () => {
  let aborted = false
  const controller = { signal: new AbortController().signal, abort() { aborted = true } }
  const outcome = await waitForWorkflowAgentRun({
    run: {
      result: new Promise((resolve) => {
        // 真实 provider 在 abort 之后才返回终态；这里用短延迟模拟同一条时序。
        setTimeout(() => resolve({ stopReason: 'aborted' }), 30)
      }),
    },
    taskId: 'T-TEST',
    getTask: async () => ({ status: 'canceled' }),
    controller,
    timeoutMs: 1_000,
    pollIntervalMs: 5,
  })
  assert.equal(outcome.taskCanceled, true)
  assert.equal(outcome.timedOut, false)
  assert.equal(aborted, true)
  assert.deepEqual(outcome.result, { stopReason: 'aborted' })
})
