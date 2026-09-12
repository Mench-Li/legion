import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluatePermission, normalizeOperation, consumeDecision } from './permission-engine.mjs'

test('normalizes required operation fields and rejects missing fields', () => {
  assert.deepEqual(normalizeOperation({ scope: 'alpha', actor: 'general', action: 'skill:grant', target: 'bob' }), {
    scope: 'alpha', actor: 'general', action: 'skill:grant', target: 'bob', taskId: null, unattended: false, metadata: {},
    // PRT-611 补记：spec line 470 的 `toolName` / `callId` / 不可变工具参数
    // 现在也是主体的字段；`skill:grant` 没有工具，于是三者都落在默认值 `null`。
    toolName: null, callId: null, argsHash: null,
  })
  assert.throws(() => normalizeOperation({ scope: 'alpha', actor: 'general', action: 'skill:grant' }), /target required/)
})

test('selects the most specific matching policy and supports allow-by-policy', () => {
  const result = evaluatePermission(
    { scope: 'alpha', actor: 'general', action: 'skill:grant', target: 'bob' },
    [
      { id: 'scope', scope: 'alpha', action: 'skill:grant', mode: 'deny' },
      { id: 'exact', scope: 'alpha', actor: 'general', action: 'skill:grant', target: 'bob', mode: 'allow-by-policy' },
    ],
    { now: Date.now() },
  )
  assert.equal(result.allowed, true)
  assert.equal(result.matchedRule.id, 'exact')
})

test('hard floor denies irreversible actions even with an allow policy', () => {
  const result = evaluatePermission(
    { scope: 'alpha', actor: 'general', action: 'file:delete', target: 'repo/x', metadata: { irreversible: true } },
    [{ id: 'all', mode: 'allow-by-policy' }],
    { now: Date.now() },
  )
  assert.equal(result.allowed, false)
  assert.equal(result.reason, 'hard-floor')
})

test('ask creates pending decision and consumeDecision is one-shot', () => {
  const result = evaluatePermission(
    { scope: 'alpha', actor: 'general', action: 'skill:grant', target: 'bob' },
    [{ id: 'ask', scope: 'alpha', action: 'skill:grant', mode: 'ask' }],
    { now: Date.now() },
  )
  assert.equal(result.allowed, false)
  assert.equal(result.decision, 'ask')
  assert.equal(result.status, 'pending')
  const approved = { ...result, decision: 'allow-once', status: 'approved' }
  assert.equal(consumeDecision(approved, result.operation).status, 'consumed')
  assert.throws(() => consumeDecision({ ...approved, status: 'consumed' }, result.operation), /not consumable/)
})
