// plugins/tests/chat-error-classifier.test.mjs —— S1（R-1 决策 A1）错误分类器契约
// 运行：node plugins/tests/chat-error-classifier.test.mjs（需先构建 plugins/lib：tsc -p plugins/tsconfig.json）
import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyChatError, CATEGORIES } from '../lib/chatErrorClassifier.js'

test('TC-S1-01 五类别映射：每类 ≥1 输入 → 类别 + 可行动文案（含恢复指引）', () => {
  const cases = [
    { in: { stopReason: 'error', error: 'model not found: x-unknown-9' }, cls: 'model-unavailable' },
    { in: { stopReason: 'error', error: 'unauthorized: invalid api key 401' }, cls: 'provider-error' },
    { in: { stopReason: 'error', error: 'ECONNREFUSED connection refused' }, cls: 'provider-error' },
    { in: { stopReason: null, error: 'timeout' }, cls: 'timeout-aborted' },
    { in: { stopReason: 'aborted', error: '' }, cls: 'timeout-aborted' },
    { in: { stopReason: 'error', error: '守护 foreman 不可用' }, cls: 'foreman-down' },
    { in: { stopReason: 'error', error: 'weird upstream noise text' }, cls: 'empty-other' },
  ]
  assert.deepEqual([...CATEGORIES].sort(), ['empty-other', 'foreman-down', 'model-unavailable', 'provider-error', 'timeout-aborted'])
  for (const c of cases) {
    const out = classifyChatError(c.in)
    assert.equal(out.category, c.cls, 'input ' + JSON.stringify(c.in))
    assert.ok(out.message && out.message.length > 0)
    assert.ok(out.message.length <= 500, 'aiError ≤500 契约')
    assert.ok(/(重试|配置|模型|恢复)/.test(out.message), '含恢复指引: ' + out.message)
  }
})

test('TC-S1-03 负例：error/undefined 原文不得产出裸「回复子代理未完成（error）」', () => {
  for (const bad of ['error: undefined', 'undefined', 'Error: error']) {
    const out = classifyChatError({ stopReason: 'error', error: bad })
    assert.ok(!out.message.includes('回复子代理未完成（error）'), '无裸兜底文案: ' + out.message)
    assert.ok(!/回复子代理未完成/.test(out.message))
  }
})

test('TC-S1-04 边界：空/未知/超长输入兜底不抛，原文片段截断 ≤500', () => {
  const inputs = [{ stopReason: '' }, { stopReason: undefined }, {}, { stopReason: null, error: 'x'.repeat(5000) }]
  for (const i of inputs) {
    const out = classifyChatError(i)
    assert.ok(CATEGORIES.includes(out.category))
    assert.ok(out.message.length <= 500)
    assert.ok(out.message.length > 0)
  }
})

test('TC-S1-02 timeout/foreman 沿用既有语义文案', () => {
  const t = classifyChatError({ stopReason: 'error', error: 'timeout 120s 预算中止' })
  assert.ok(t.category === 'timeout-aborted' && /超时|中止/.test(t.message))
  const f = classifyChatError({ stopReason: 'error', error: 'foreman down' })
  assert.ok(f.category === 'foreman-down' && f.message.includes('守护 foreman 不可用'))
})
