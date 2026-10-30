// team-hub/handoff-adapters.test.mjs
// ---------------------------------------------------------------------------
// 接线的三条硬边界（2026-10-30）。
//
// 这几个判断错了的后果都不是"报错"，而是**做了一件不该做的事**：
// 给非实现阶段补结算 → 绕开它自己的证据契约；给没有基线的任务结算 → 拿 main 当交付；
// 抢一个 in_progress 的任务 → 两处同时写同一份工作区。
//
// 运行：node --test team-hub/handoff-adapters.test.mjs
// ---------------------------------------------------------------------------
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { assertSettleable, createHandoffAdapters, handoffWorktreeDir } from './handoff-adapters.mjs'

const SHA = '717607bfd4fbbadc5ea644717d6acbc82853d092'

const task = (over = {}) => ({
  id: 'T-240', role: 'coder', status: 'todo',
  agentSelectionSnapshot: {
    workflowStageId: 'implement',
    adopt: { taskId: 'T-224', commit: SHA, branch: 'w/T-224' },
    ...over.snapshot,
  },
  ...over.task,
})

test('① 正常：带基线、实现阶段、todo ⇒ 放行并返回基线', () => {
  const r = assertSettleable(task(), { implementationStageId: 'implement' })
  assert.equal(r.adopt.commit, SHA)
  assert.equal(r.stageId, 'implement')
})

test('② 非实现阶段：拒绝（别的环有自己的证据契约）', () => {
  const t = task({ snapshot: { workflowStageId: 'review' } })
  assert.throws(() => assertSettleable(t, { implementationStageId: 'implement' }), (e) => e.code === 'HANDOFF_NOT_IMPLEMENTATION')
})

test('③ 没有继承基线：拒绝（否则会拿 main 当成交付）', () => {
  const t = task({ snapshot: { adopt: null } })
  assert.throws(() => assertSettleable(t), (e) => e.code === 'HANDOFF_NO_ADOPT_BASELINE')
})

test('④ in_progress：拒绝（有人正在写同一份工作区）', () => {
  const t = task({ task: { status: 'in_progress' } })
  assert.throws(() => assertSettleable(t), (e) => e.code === 'HANDOFF_BAD_STATUS')
})

test('⑤ in_review 也允许（上一轮结算失败后重试的路径）', () => {
  assert.doesNotThrow(() => assertSettleable(task({ task: { status: 'in_review' } })))
})

test('⑥ 快照里基线非法（不是 40/64 位十六进制）也要拒', () => {
  const t = task({ snapshot: { adopt: { taskId: 'T-224', commit: 'not-a-sha' } } })
  assert.throws(() => assertSettleable(t), (e) => e.code === 'HANDOFF_NO_ADOPT_BASELINE')
})

test('⑦ worktree 目录可预测（排查时不用翻日志）', () => {
  assert.equal(handoffWorktreeDir('D:/project/DSH/legion/', 'T-240'), 'D:/project/DSH/legion/.legion-worktrees/handoff-T-240')
})

test('⑧ 适配器把证据写成 evidence 评论（审查环按 evidence 找实现证据）', async () => {
  const seen = []
  const a = createHandoffAdapters({
    loadTask: (id) => task({ task: { id } }),
    setStatus: (...x) => seen.push(['status', ...x]),
    appendComment: (...x) => seen.push(['comment', ...x]),
    saveAttempt: (...x) => seen.push(['attempt', ...x]),
    prepareWorktree: async () => 'wt',
    runRunner: async () => ({ state: 'passed', exitCode: 0, executable: 'node', args: ['x'], timeoutMs: 1 }),
    implementationStageId: 'implement',
  })
  a.appendEvidence('T-240', 'agent-workflow-implementation:{}', 'general')
  a.setStatus('T-240', 'done', 'ok')
  assert.deepEqual(seen[0], ['comment', 'T-240', 'agent-workflow-implementation:{}', 'general', { evidence: true }])
  assert.deepEqual(seen[1], ['status', 'T-240', 'done', 'ok'])
})
