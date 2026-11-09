// plugins/tests/state-machine-escalate.test.mjs
// ============================================================================
// F3 守护侧 · 控制组判据（设计稿 §3 F3「有 @ → 追加续跑 / @general → 停手」）
//
// 只测 `classifyFeedback` 的分类是不够的：**分类对**不等于**守护据此改变了动作**。
// 所以这里直接驱动 `runRound`，用「同一条任务、只改评论内容」做控制组：
//
//   ① 普通评论（打回）      ⇒ workReturned 被调用（今天的行为）
//   ② @<其他角色>（追加）    ⇒ workReturned 被调用，且 intent='order'
//   ③ @general（升级提问）  ⇒ **不被调用**（守护停手，等人拍板）
//
// ②③ 只差一个词，却应当导致完全不同的动作——这正是不变量 I-7.1/I-3.x 的落点。
// ============================================================================
import test from 'node:test'
import assert from 'node:assert/strict'

import { createStateMachine } from '../lib/stateMachine.js'

/** 造一个"认得 coder 与 general"的状态机；记录它有没有派人。 */
function makeMachine({ comments, maxWorkers = 2 }) {
  const calls = { workReturned: [], workTodo: [], detached: [] }
  const task = {
    id: 'T-1', status: 'in_progress', role: 'coder', soldier: 'coder',
    claimedAt: '2026-11-03T00:00:00.000Z', scope: 'default',
    blockedBy: [], hold: 0, comments,
  }
  const machine = createStateMachine({
    config: { role: 'coder', intervalMs: 30000, maxWorkers },
    log: () => {},
    scope: 'default',
    isPipeline: () => false,
    stageByRole: () => new Map([['coder', { role: 'coder', label: '编码' }], ['general', { role: 'general', label: '将军' }]]),
    stageOf: () => undefined,
    room: () => true,
    sliceRoomOk: () => true,
    runDetached: (id, job) => { calls.detached.push(id); void job },
    inflight: new Set(),
    abortRetryAt: new Map(),
    maxWorkerRetry: 3,
    maxMediateAttempts: 2,
    claimTask: async () => task,
    workTodo: async () => { calls.workTodo.push(task.id) },
    workReturned: async (t, feedback, stage, intent) => { calls.workReturned.push({ id: t.id, intent, feedbackCount: feedback.length }) },
    runDiscussion: async () => {},
    safeComment: async () => {},
    transitionTo: async () => {},
    mediatorRecoverWorker: async () => ({ fixed: false }),
  })
  machine.runRound([task], new Map([[task.id, task]]))
  return calls
}

const humanComment = (text) => ({ by: 'general', at: '2026-11-03T00:10:00.000Z', text })

test('① 普通评论（打回）⇒ 派人重做，intent=rework', () => {
  const calls = makeMachine({ comments: [humanComment('这段和需求不符，重做')] })
  assert.equal(calls.workReturned.length, 1, '打回必须触发重派')
  assert.equal(calls.workReturned[0].intent, 'rework')
})

test('② @<其他角色>（追加）⇒ 也派人，但 intent=order（不算失败）', () => {
  const calls = makeMachine({ comments: [humanComment('@coder 顺手把日志加上')] })
  assert.equal(calls.workReturned.length, 1, '追加要求也要派下去')
  assert.equal(calls.workReturned[0].intent, 'order', '★ 追加不该被记成"重做"')
})

test('③ @general（升级提问）⇒ **不派人**（守护停手，等人拍板）', () => {
  const calls = makeMachine({ comments: [humanComment('@general 这个取舍要您定')] })
  assert.equal(calls.workReturned.length, 0, '★ 人还没答，活不该被再派下去')
  assert.equal(calls.detached.length, 0, '也不该起任何后台作业')
})

test('④ 控制组对照：同样一条任务，只把 @general 换成普通评论，行为就应当翻转', () => {
  const stop = makeMachine({ comments: [humanComment('@general 这个取舍要您定')] })
  const go = makeMachine({ comments: [humanComment('这个取舍要您定')] })
  assert.equal(stop.workReturned.length, 0)
  assert.equal(go.workReturned.length, 1)
})
