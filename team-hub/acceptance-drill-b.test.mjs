// team-hub/acceptance-drill-b.test.mjs
// ============================================================================
// B 类演练脚本自身的判据
//
// 判据：
//   ① summarize 汇总正确
//   ② 导入不启动实例（只有直接运行才跑）
//   ③ 整轮 B 演练（LEGION_DRILL=1 才跑）：回答闭环必须全绿
//      —— 这条是"闸装上之后有没有放行开关"的自动化证据
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { summarize, runDrillB } from './scripts/acceptance-drill-b.mjs'

test('① summarize：全过 / 有失败 / 空列表', () => {
  assert.deepEqual(summarize([{ passed: true }, { passed: true }]), { total: 2, passed: 2, failed: 0, ok: true })
  const mixed = summarize([{ passed: true }, { passed: false }])
  assert.equal(mixed.ok, false)
  assert.equal(mixed.failed, 1)
  assert.equal(summarize([]).ok, true)
})

test('② 导入不启动实例', () => {
  assert.equal(typeof runDrillB, 'function')
  assert.equal(typeof summarize, 'function')
})

test('③ 整轮 B 演练（LEGION_DRILL=1 才跑）', {
  skip: process.env.LEGION_DRILL !== '1' ? '会起实例并建会话，设 LEGION_DRILL=1 才跑' : false,
}, async () => {
  const { summary, evidence } = await runDrillB({ keep: false })
  const failed = evidence.steps.filter((s) => !s.passed).map((s) => `${s.id}: ${JSON.stringify(s.detail)}`)
  assert.equal(summary.ok, true, `失败步骤：\n${failed.join('\n')}\n运行错误：${evidence.error ?? '无'}`)
  assert.ok(summary.total >= 5, '回答闭环至少应有 5 项断言')
})
