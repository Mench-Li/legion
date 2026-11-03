// team-hub/goal-share.test.mjs
// ============================================================================
// F6 · 目标级配额与公平（设计稿 §8.1 / M8，D1）
//
// 病灶：一个 12 片的大目标可以把空间里的槽位全部吃干，让旁边那个"只差一步"的小目标
// 一直等。配额要解决的问题是**公平**，不是限流——所以它在两条边界上必须克制：
//   · 只影响**认领顺序与准入**，不改 `TASK_GATES` 的资格判定（I-6.3）
//   · 空载时大目标可以吃满全部槽（借槽 I-6.1 的例外），否则配额会变成闲置
//
// 判据：
//   ① 配置归一化：默认 0.5 / 权重取整 / TTL 有下限 / 非法值回默认
//   ② 单目标配额 = ceil(maxWorkers × share × weight)，至少 1
//   ③ 配额内 ⇒ 准入；配额满且**没有别的目标在等** ⇒ 借槽（带 TTL）
//   ④ 配额满且别的目标在等 ⇒ 拒绝（I-6.1）
//   ⑤ 排序：缺口大的目标优先，其次 priority、再 createdAt（稳定）
//   ⑥ 配额不碰 gate：候选 SQL 里不出现 goal 配额条件（I-6.3）
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_GOAL_SHARE,
  normalizeGoalShare,
  quotaFor,
  admitCandidate,
  orderCandidates,
} from './goal-share.mjs'
import { buildClaimableTaskSql, TASK_GATES } from './claim-policy.mjs'

test('① 配置归一化：默认值 / 取整 / 下限 / 非法回默认', () => {
  assert.equal(DEFAULT_GOAL_SHARE.default, 0.5)
  assert.equal(DEFAULT_GOAL_SHARE.borrowTtlSec, 600)

  const normalized = normalizeGoalShare({
    default: 1.7, weights: { 'G-1': 2.6, 'G-2': 'x' }, borrowTtlSec: 5,
  })
  assert.equal(normalized.default, 1, '★ 份额夹到 0..1')
  assert.equal(normalized.weights['G-1'], 3, '★ 权重取整')
  assert.equal(normalized.weights['G-2'], undefined, '非法权重丢弃')
  assert.equal(normalized.borrowTtlSec, 60, '★ TTL 有下限（借槽不能永久占）')

  const broken = normalizeGoalShare(null)
  assert.deepEqual(broken, { default: 0.5, weights: {}, borrowTtlSec: 600 })
})

test('② 配额 = ceil(maxWorkers × share × weight)，至少 1', () => {
  assert.equal(quotaFor({ maxWorkers: 4, share: 0.5, weight: 1 }), 2)
  assert.equal(quotaFor({ maxWorkers: 3, share: 0.5, weight: 1 }), 2, '★ 向上取整：3×0.5=1.5 ⇒ 2')
  assert.equal(quotaFor({ maxWorkers: 4, share: 0.5, weight: 2 }), 4, '权重 2 的目标拿到双份')
  assert.equal(quotaFor({ maxWorkers: 4, share: 0.1, weight: 1 }), 1, '★ 至少 1：否则小目标永远排不上')
})

test('③ 配额内即可准入', () => {
  const out = admitCandidate({
    goalId: 'G-1', activeForGoal: 1, maxWorkers: 4,
    config: { default: 0.5, weights: {}, borrowTtlSec: 600 },
    otherGoalsWaiting: 3, now: '2026-11-03T00:00:00.000Z',
  })
  assert.equal(out.admit, true)
  assert.equal(out.reason, 'within-quota')
  assert.equal(out.borrowUntil, null)
})

test('④ 超配额但无其它目标在等 ⇒ 借槽，带过期时间（I-6.1）', () => {
  const out = admitCandidate({
    goalId: 'G-1', activeForGoal: 2, maxWorkers: 4,
    config: { default: 0.5, weights: {}, borrowTtlSec: 600 },
    otherGoalsWaiting: 0, now: '2026-11-03T00:00:00.000Z',
  })
  assert.equal(out.admit, true)
  assert.equal(out.reason, 'borrowed')
  assert.equal(out.borrowUntil, '2026-11-03T00:10:00.000Z', '★ 借槽必须自己会过期')
})

test('⑤ 超配额且别的目标在等 ⇒ 拒绝', () => {
  const out = admitCandidate({
    goalId: 'G-1', activeForGoal: 2, maxWorkers: 4,
    config: { default: 0.5, weights: {}, borrowTtlSec: 600 },
    otherGoalsWaiting: 1, now: '2026-11-03T00:00:00.000Z',
  })
  assert.equal(out.admit, false)
  assert.equal(out.reason, 'over-quota')
  assert.match(String(out.userText), /配额|让位|其它目标/)
})

test('⑥ 排序：缺口大的目标优先，其次 priority、再 createdAt', () => {
  const candidates = [
    { taskId: 'T-1', goalId: 'G-big', priority: 'high', createdAt: '2026-11-03T00:00:03.000Z' },
    { taskId: 'T-2', goalId: 'G-small', priority: 'low', createdAt: '2026-11-03T00:00:02.000Z' },
    { taskId: 'T-3', goalId: 'G-big', priority: 'low', createdAt: '2026-11-03T00:00:01.000Z' },
  ]
  const ordered = orderCandidates(candidates, {
    activeByGoal: { 'G-big': 2, 'G-small': 0 }, config: { default: 0.5, weights: {}, borrowTtlSec: 600 }, maxWorkers: 4,
  })
  assert.equal(ordered[0].taskId, 'T-2', '★ 小目标（缺口 2）排在大目标（缺口 0）之前')
  assert.equal(ordered[1].taskId, 'T-1', '同目标内 priority 高的在前')
  assert.equal(ordered[2].taskId, 'T-3')
})

test('⑦ 配额不碰 gate（I-6.3）：候选 SQL 里没有 goal 配额条件', () => {
  const sql = buildClaimableTaskSql()
  const gateCount = TASK_GATES.length
  assert.equal(gateCount, 3, '闸门数量不应因配额而变')
  for (const gate of TASK_GATES) assert.ok(sql.includes(gate.sql), `候选 SQL 必须仍带闸「${gate.id}」`)
  assert.equal(/goal_share|quota|borrow/i.test(sql), false, '★ 配额只影响排序，不能混进资格判定')
})
