// orchestrator/state-machine/rework-escalation.test.mjs
// ---------------------------------------------------------------------------
// 「返工连续同因升级」纯层判据（决策 #1 方案 B）。
//
// 这一组问的不是"数得对不对"，而是四件会静默失效的事：
//   ① `evidence` 若进了指纹，判据**永远不会连续**——保护看起来在，实际每次都放过；
//   ② 修好一次再复发（回归）不该被当成"反复修不好"；
//   ③ 中间换过别的 finding 但目标 finding 一直在，仍算连续；
//   ④ 阈值环境变量写错时不许退化成"永不升级"。
//
// 运行：node orchestrator/state-machine/rework-escalation.test.mjs
// ---------------------------------------------------------------------------
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_ESCALATE_AFTER, describeFingerprint, escalateAfterFromEnv,
  escalateVerdict, findingFingerprint, fingerprintsOf,
} from './rework-escalation.mjs'

const impl = (summary, file = 'src/a.mjs', evidence = 'line 1') => ({ kind: 'implementation', file, summary, evidence })

test('① ★★★ 指纹不含 evidence：每轮证据不同也必须能连续', () => {
  const a = findingFingerprint(impl('缺少空值检查', 'src/a.mjs', '第 1 轮：第 12 行'))
  const b = findingFingerprint(impl('缺少空值检查', 'src/a.mjs', '第 2 轮：第 18 行，输出不同'))
  assert.equal(a, b, '★★ evidence 变化不许改变指纹——否则判据永远不会触发，保护名存实亡')
  // 反例：真改了 summary 就是另一件事。
  assert.notEqual(a, findingFingerprint(impl('缺少空值检查（已改为抛错）', 'src/a.mjs')))
})

test('② 归一化只做空白与大小写：换行/多空格/大小写不产生新指纹', () => {
  assert.equal(
    findingFingerprint(impl('缺少   空值\n检查')),
    findingFingerprint(impl('缺少 空值 检查')),
  )
  assert.equal(findingFingerprint(impl('Missing Null Check')), findingFingerprint(impl('missing null check')))
  // Windows 路径分隔符归一，避免同一文件两个指纹。
  assert.equal(findingFingerprint(impl('x', 'src\\a.mjs')), findingFingerprint(impl('x', 'src/a.mjs')))
})

test('③ ★★★ 连续 3 轮同一指纹 ⇒ 升级；中间被其他问题隔开仍算连续', () => {
  const target = impl('缺少空值检查')
  const other = impl('日志缺上下文', 'src/b.mjs')
  const verdict = escalateVerdict({
    currentFindings: [target],
    priorReviews: [
      { round: 1, findings: [target, other] },
      { round: 2, findings: [other, target] },
    ],
    limit: 3,
  })
  assert.equal(verdict.escalate, true)
  assert.equal(verdict.streak, 3)
  assert.equal(verdict.repeated.length, 1)
  assert.equal(verdict.repeated[0].rounds.length, 2, '★ 报出它出现在哪几轮，评论才写得清')
})

test('④ ★★★ 修好一次再复发（回归）不算"反复修不好"', () => {
  const target = impl('缺少空值检查')
  const other = impl('日志缺上下文', 'src/b.mjs')
  const verdict = escalateVerdict({
    currentFindings: [target],
    priorReviews: [
      { round: 1, findings: [target] },   // 第 1 轮有
      { round: 2, findings: [other] },    // 第 2 轮没了一一修好了
    ],
    limit: 3,
  })
  assert.equal(verdict.escalate, false, '★★ 回归是新问题，不是同一个问题修不好')
  assert.equal(verdict.streak, 1)
})

test('⑤ 未达阈值不升级；阈值边界正好命中时升级', () => {
  const target = impl('缺少空值检查')
  assert.equal(escalateVerdict({ currentFindings: [target], priorReviews: [], limit: 3 }).escalate, false)
  assert.equal(escalateVerdict({
    currentFindings: [target], priorReviews: [{ round: 1, findings: [target] }], limit: 3,
  }).escalate, false, '连续 2 轮 < 3')
  assert.equal(escalateVerdict({
    currentFindings: [target],
    priorReviews: [{ round: 2, findings: [target] }, { round: 1, findings: [target] }],
    limit: 3,
  }).escalate, true, '连续 3 轮 = 3 ⇒ 升级')
})

test('⑥ 默认阈值可被环境变量覆盖；非法值回落默认而不是"永不升级"', () => {
  assert.equal(DEFAULT_ESCALATE_AFTER, 3)
  assert.equal(escalateAfterFromEnv({}), 3)
  assert.equal(escalateAfterFromEnv({ LEGION_REWORK_ESCALATE_AFTER: '5' }), 5)
  for (const bad of ['0', '1', '-3', 'abc', '', '  ']) {
    assert.equal(escalateAfterFromEnv({ LEGION_REWORK_ESCALATE_AFTER: bad }), 3,
      `★★ ${JSON.stringify(bad)} 必须回落默认：退化成"永不升级"会让保护静默消失`)
  }
})

test('⑦ 一组 finding 里空值/坏形状不产生假指纹', () => {
  assert.deepEqual(fingerprintsOf([{ kind: 'implementation', summary: 'x' }]), ['implementation||x'])
  assert.deepEqual(fingerprintsOf([null, undefined, {}, { kind: '', summary: '' }]), [])
  assert.deepEqual(fingerprintsOf('not-an-array'), [])
})

test('⑧ 描述函数给出人话（评论里要能读）', () => {
  assert.equal(describeFingerprint(findingFingerprint(impl('缺少空值检查'))), '[实现] src/a.mjs — 缺少空值检查')
  assert.equal(describeFingerprint('design||边界没写'), '[设计] — 边界没写')
})
