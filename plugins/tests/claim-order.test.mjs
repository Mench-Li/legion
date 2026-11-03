// plugins/tests/claim-order.test.mjs
// ============================================================================
// F6 · 认领顺序（设计稿 §8.1 / M8 排序层，守护侧）
//
// 配额只在"准入"上生效还不够：**谁先跑**同样决定公平。
// 一个 12 片的大目标即使受配额限制，只要它永远排在小目标前面，
// 小目标就会一直等到大目标的分片间隙——那仍然不是公平。
//
// 判据：
//   ① 缺口大的目标优先（配额 - 在跑数）
//   ② 同缺口按 priority，再按 createdAt（稳定，不因遍历顺序抖动）
//   ③ 不改集合：只是重排，绝不丢任务
//   ④ 权重生效：权重 2 的目标配额翻倍，缺口也算得更大
//   ⑤ 纯函数：同一输入两次结果一致（守护可以安全重算）
// ============================================================================
import test from 'node:test'
import assert from 'node:assert/strict'

import { orderTodoCandidates, goalDeficitOf } from '../lib/claimOrder.js'

const config = { default: 0.5, weights: {}, borrowTtlSec: 600 }

test('① 缺口大的目标优先', () => {
  const tasks = [
    { id: 'T-1', goalId: 'G-big', priority: 'high', createdAt: '2026-11-03T00:00:01.000Z' },
    { id: 'T-2', goalId: 'G-small', priority: 'low', createdAt: '2026-11-03T00:00:02.000Z' },
  ]
  const ordered = orderTodoCandidates(tasks, {
    maxWorkers: 4, config, activeByGoal: { 'G-big': 2, 'G-small': 0 },
  })
  assert.equal(ordered[0].id, 'T-2', '★ 小目标缺口 2 > 大目标缺口 0')
  assert.equal(ordered.length, 2, '★ 不丢任务')
})

test('② 同缺口：priority 再 createdAt', () => {
  const tasks = [
    { id: 'T-late', goalId: 'G-1', priority: 'high', createdAt: '2026-11-03T00:00:09.000Z' },
    { id: 'T-early', goalId: 'G-1', priority: 'high', createdAt: '2026-11-03T00:00:01.000Z' },
    { id: 'T-low', goalId: 'G-1', priority: 'low', createdAt: '2026-11-03T00:00:00.000Z' },
  ]
  const ordered = orderTodoCandidates(tasks, { maxWorkers: 4, config, activeByGoal: {} })
  assert.deepEqual(ordered.map((t) => t.id), ['T-early', 'T-late', 'T-low'])
})

test('③ 不改原数组（纯函数）', () => {
  const tasks = [
    { id: 'T-1', goalId: 'G-big', priority: 'high', createdAt: '2026-11-03T00:00:01.000Z' },
    { id: 'T-2', goalId: 'G-small', priority: 'low', createdAt: '2026-11-03T00:00:02.000Z' },
  ]
  const snapshot = tasks.map((t) => t.id)
  orderTodoCandidates(tasks, { maxWorkers: 4, config, activeByGoal: { 'G-big': 2 } })
  assert.deepEqual(tasks.map((t) => t.id), snapshot, '★ 入参不得被就地排序')
})

test('④ 权重生效：权重 2 的目标缺口更大', () => {
  const weighted = { default: 0.5, weights: { 'G-big': 2 }, borrowTtlSec: 600 }
  // maxWorkers=4 ⇒ G-big 配额 4（0.5×4×2），G-small 配额 2
  assert.equal(goalDeficitOf({ goalId: 'G-big', maxWorkers: 4, config: weighted, activeByGoal: { 'G-big': 1 } }), 3)
  assert.equal(goalDeficitOf({ goalId: 'G-small', maxWorkers: 4, config: weighted, activeByGoal: { 'G-small': 1 } }), 1)
})

test('⑤ 纯函数：同一输入两次一致', () => {
  const tasks = [
    { id: 'T-1', goalId: 'G-a', priority: 'medium', createdAt: '2026-11-03T00:00:01.000Z' },
    { id: 'T-2', goalId: 'G-b', priority: 'medium', createdAt: '2026-11-03T00:00:01.000Z' },
  ]
  const opts = { maxWorkers: 2, config, activeByGoal: {} }
  assert.deepEqual(orderTodoCandidates(tasks, opts).map((t) => t.id), orderTodoCandidates(tasks, opts).map((t) => t.id))
})

test('⑥ 没有 goalId 的任务照常排（不能因为无目标就被丢掉）', () => {
  const tasks = [
    { id: 'T-nogo', goalId: null, priority: 'high', createdAt: '2026-11-03T00:00:01.000Z' },
    { id: 'T-goal', goalId: 'G-1', priority: 'low', createdAt: '2026-11-03T00:00:00.000Z' },
  ]
  const ordered = orderTodoCandidates(tasks, { maxWorkers: 4, config, activeByGoal: {} })
  assert.equal(ordered.length, 2)
  assert.ok(ordered.some((t) => t.id === 'T-nogo'))
})
