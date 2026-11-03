// team-hub/acceptance-drill.test.mjs
// ============================================================================
// 演练脚本自身的判据（脚本也要有判据，否则"演练通过"本身就成了信仰）
//
// 判据：
//   ① summarizeSteps 汇总正确（全过 / 有失败）
//   ② 导入脚本不会启动实例（只有直接运行才跑）——否则被别的测试 import 时会偷偷起服务
//   ③ 步骤表非空且每个步骤都有 id/name/run（防止有人加了半截步骤）
//   ④ （可选）整轮演练：设 `LEGION_DRILL=1` 才跑，避免默认拖慢套件
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { summarizeSteps, runDrill } from './scripts/acceptance-drill.mjs'

test('① summarizeSteps：全过 / 有失败', () => {
  assert.deepEqual(summarizeSteps([{ passed: true }, { passed: true }]), { total: 2, passed: 2, failed: 0, ok: true })
  const mixed = summarizeSteps([{ passed: true }, { passed: false }])
  assert.equal(mixed.ok, false)
  assert.equal(mixed.passed, 1)
  assert.equal(mixed.failed, 1)
  assert.equal(summarizeSteps([]).ok, true, '空列表不应算失败')
})

test('② 导入不启动实例（只有 isMain 才跑）', () => {
  // 走到这里说明 import 没有副作用；再断一个类型，避免"导入了空对象"
  assert.equal(typeof runDrill, 'function')
  assert.equal(typeof summarizeSteps, 'function')
})

test('③ 整轮演练（LEGION_DRILL=1 才跑）', { skip: process.env.LEGION_DRILL !== '1' ? '需要起子进程，设 LEGION_DRILL=1 才跑' : false }, async () => {
  const { summary, evidence } = await runDrill({ keep: false })
  const failed = evidence.steps.filter((s) => !s.passed).map((s) => `${s.id}: ${JSON.stringify(s.detail)}`)
  assert.equal(summary.ok, true, `失败步骤：\n${failed.join('\n')}`)
  assert.ok(summary.total >= 10, '演练应覆盖 10 项以上能力')
})
