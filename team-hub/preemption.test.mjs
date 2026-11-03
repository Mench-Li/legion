// team-hub/preemption.test.mjs
// ============================================================================
// F7 · 抢占与人优先槽（设计稿 §8.2 / M9，D2）
//
// 目标：满负荷时人还能立刻插话，紧急活能让槽。但"能让槽"必须有四道闸，
// 少一道就会变成"谁的请求都能把别人的活踢掉"——那比排队还糟。
//
// 判据（对应 I-7.1 ~ I-7.3 + 防抖）：
//   ① 配置归一化（保留槽 ≥0、防抖下限、活锁窗口）
//   ② 人 + explicit + 已跑够时间 ⇒ 允许抢占
//   ③ bot 发起 ⇒ 拒（I-7.3 保留槽只给人）
//   ④ inferred 强度 ⇒ 拒（I-7.1 只有明确请求能抢占）
//   ⑤ 执行不足 60s ⇒ 拒（防抖：刚开工就被踢，等于永远开不了工）
//   ⑥ 10 分钟内已被抢 ≥2 次 ⇒ 拒并告警（I-7.4 防活锁）
//   ⑦ 保留槽：只剩保留槽时后台活不得占用，人可以用
//   ⑧ 抢占说明必须写清「被谁 · 因何」（I-7.2）
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_PREEMPTION,
  PREEMPTION_ERRORS,
  normalizePreemption,
  canPreempt,
  reserveSlotDecision,
  preemptionNote,
} from './preemption.mjs'

const config = DEFAULT_PREEMPTION
const human = { kind: 'general', strength: 'explicit' }

test('① 配置归一化：保留槽 / 防抖下限 / 活锁窗口', () => {
  assert.equal(config.reservedSlots, 1)
  assert.equal(config.minRunSec, 60)
  assert.equal(config.lockWindowSec, 600)
  assert.equal(config.maxPreemptionsInWindow, 2)

  const n = normalizePreemption({ reservedSlots: -5, minRunSec: 1, lockWindowSec: 'x', maxPreemptionsInWindow: 0 })
  assert.equal(n.reservedSlots, 0, '★ 保留槽不取负')
  assert.equal(n.minRunSec, 60, '★ 防抖有下限（否则谁都能秒踢）')
  assert.equal(n.lockWindowSec, 600, '非法窗口回默认')
  assert.equal(n.maxPreemptionsInWindow, 1, '至少允许 1 次（0 等于禁用）')
})

test('② 人 + explicit + 已跑够时间 ⇒ 允许', () => {
  const out = canPreempt({
    requester: human, task: { status: 'in_progress', claimedAt: '2026-11-03T00:00:00.000Z' },
    recentPreemptions: [], now: '2026-11-03T00:10:00.000Z', config,
  })
  assert.equal(out.allowed, true)
  assert.equal(out.code, null)
})

test('③ bot 发起 ⇒ 拒（保留槽与抢占都只给人）', () => {
  const out = canPreempt({
    requester: { kind: 'bot', strength: 'explicit' }, task: { status: 'in_progress', claimedAt: '2026-11-03T00:00:00.000Z' },
    recentPreemptions: [], now: '2026-11-03T00:10:00.000Z', config,
  })
  assert.equal(out.allowed, false)
  assert.equal(out.code, PREEMPTION_ERRORS.NOT_HUMAN)
})

test('④ inferred 强度 ⇒ 拒（I-7.1）', () => {
  const out = canPreempt({
    requester: { kind: 'general', strength: 'inferred' }, task: { status: 'in_progress', claimedAt: '2026-11-03T00:00:00.000Z' },
    recentPreemptions: [], now: '2026-11-03T00:10:00.000Z', config,
  })
  assert.equal(out.allowed, false)
  assert.equal(out.code, PREEMPTION_ERRORS.NEEDS_EXPLICIT)
})

test('⑤ 执行不足 60s ⇒ 拒（防抖）', () => {
  const out = canPreempt({
    requester: human, task: { status: 'in_progress', claimedAt: '2026-11-03T00:09:30.000Z' },
    recentPreemptions: [], now: '2026-11-03T00:10:00.000Z', config,
  })
  assert.equal(out.allowed, false)
  assert.equal(out.code, PREEMPTION_ERRORS.TOO_EARLY)
  assert.match(String(out.userText), /60|秒/)
})

test('⑥ 10 分钟内已被抢 ≥2 次 ⇒ 拒并告警（I-7.4 防活锁）', () => {
  const out = canPreempt({
    requester: human, task: { status: 'in_progress', claimedAt: '2026-11-03T00:00:00.000Z' },
    recentPreemptions: ['2026-11-03T00:03:00.000Z', '2026-11-03T00:07:00.000Z'],
    now: '2026-11-03T00:10:00.000Z', config,
  })
  assert.equal(out.allowed, false)
  assert.equal(out.code, PREEMPTION_ERRORS.LOOP_GUARD)
  assert.equal(out.alert, true, '★ 拒绝要能被看见')

  // 窗口外的旧记录不计数
  const stale = canPreempt({
    requester: human, task: { status: 'in_progress', claimedAt: '2026-11-03T00:00:00.000Z' },
    recentPreemptions: ['2026-11-02T23:00:00.000Z', '2026-11-02T23:30:00.000Z'],
    now: '2026-11-03T00:10:00.000Z', config,
  })
  assert.equal(stale.allowed, true, '★ 窗口外的不算账')
})

test('⑦ 保留槽：后台活不能占，人能占（I-7.3）', () => {
  const backend = reserveSlotDecision({ totalSlots: 2, activeSlots: 1, humanRequest: false, reservedSlots: 1 })
  assert.equal(backend.allowed, false, '★ 只剩保留槽时后台活必须让开')
  assert.equal(backend.code, PREEMPTION_ERRORS.RESERVED_FOR_HUMAN)

  const person = reserveSlotDecision({ totalSlots: 2, activeSlots: 1, humanRequest: true, reservedSlots: 1 })
  assert.equal(person.allowed, true, '人可以用保留槽')

  const idle = reserveSlotDecision({ totalSlots: 2, activeSlots: 0, humanRequest: false, reservedSlots: 1 })
  assert.equal(idle.allowed, true, '空载时后台活照常跑（保留槽不冻结整台机器）')
})

test('⑧ 抢占说明写清「被谁 · 因何」（I-7.2）', () => {
  const note = preemptionNote({ by: 'general', reason: '线上故障', at: '2026-11-03T00:10:00.000Z' })
  assert.match(note, /general/)
  assert.match(note, /线上故障/)
  assert.match(note, /2026-11-03/)
  assert.match(note, /续跑|恢复|resume/, '★ 要告诉士兵"之后会带你回来"')
})
