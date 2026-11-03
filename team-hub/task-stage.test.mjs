// team-hub/task-stage.test.mjs
// ============================================================================
// F2 · 派生阶段 `deriveStage()`（设计稿 §3 F2）
//
// 为什么不加一列：阶段是**从事实推出来的**（有没有未答问题、任务是什么状态），
// 加列就多一份要维护的真相——而且它一定会和真实情况漂移（superagent 的
// ticket stage 就是纯推导，第一次匹配即胜）。
//
// 判据：
//   ① 有未答问题 ⇒ awaiting_answer（优先于所有其它结论）
//   ② blocked 且没有未答问题 ⇒ stuck（"真卡住"，与"在等人"分开）
//   ③ dropped 报告过的任务 ⇒ dropped（无需处理）
//   ④ 其它情况原样返回 status（todo / in_progress / in_review …）
//   ⑤ 未知输入不抛异常，返回 'unknown'（看板不该因为一条脏数据白屏）
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { deriveStage, STAGE_VALUES } from './task-stage.mjs'

test('① 有未答问题 ⇒ awaiting_answer（优先级最高）', () => {
  const out = deriveStage({ status: 'blocked', report_state: 'blocked' }, { openQuestionCount: 1 })
  assert.equal(out.stage, 'awaiting_answer')
  assert.equal(out.reason, 'open-question')
  // 即使任务状态是 in_progress，也只是"在等人"的一种
  assert.equal(deriveStage({ status: 'in_progress' }, { openQuestionCount: 2 }).stage, 'awaiting_answer')
})

test('② blocked 且没有未答问题 ⇒ stuck（真卡住，不冒充"在等人"）', () => {
  const out = deriveStage({ status: 'blocked', report_state: 'blocked' }, { openQuestionCount: 0 })
  assert.equal(out.stage, 'stuck')
  assert.equal(out.reason, 'blocked-without-question')
})

test('③ dropped 报告过 ⇒ dropped（无需处理）', () => {
  const out = deriveStage({ status: 'canceled', report_state: 'dropped' })
  assert.equal(out.stage, 'dropped')
})

test('④ 其它情况原样返回 status', () => {
  assert.equal(deriveStage({ status: 'todo' }).stage, 'todo')
  assert.equal(deriveStage({ status: 'in_progress', report_state: 'waiting' }).stage, 'in_progress')
  assert.equal(deriveStage({ status: 'in_review' }).stage, 'in_review')
})

test('⑤ 脏输入不抛：返回 unknown', () => {
  assert.equal(deriveStage(null).stage, 'unknown')
  assert.equal(deriveStage({}).stage, 'unknown')
  assert.equal(deriveStage({ status: '   ' }).stage, 'unknown')
})

test('⑥ 常量覆盖全部可能的阶段值', () => {
  for (const value of ['awaiting_answer', 'stuck', 'dropped', 'unknown']) {
    assert.ok(STAGE_VALUES.includes(value), `STAGE_VALUES 缺 ${value}`)
  }
})
