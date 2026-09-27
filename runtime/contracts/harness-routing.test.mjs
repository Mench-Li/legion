// F-23 判据：路由优先级、来源可审计、指名不在册**具名拒绝不回落**。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHarnessRouter, ROUTE_SOURCES, ROUTE_REJECT } from './harness-routing.mjs'

const PROVIDERS = ['deepseek-harness', 'codex', 'claude-code']
const mk = (rules = []) => createHarnessRouter({ providers: PROVIDERS, rules, defaultProvider: 'deepseek-harness' })

test('F-23 不指定 ⇒ 默认 DeepSeek Harness（来源如实记为 default）', () => {
  const r = mk().resolve({})
  assert.equal(r.ok, true)
  assert.equal(r.provider, 'deepseek-harness')
  assert.equal(r.source, ROUTE_SOURCES.DEFAULT)
})

test('★ F-23 配置表为权威：命中任务类型 ⇒ 用表里的，**压过**模型建议', () => {
  const router = mk([{ taskType: 'code-review', provider: 'claude-code' }])
  const r = router.resolve({ taskType: 'code-review', suggested: 'codex' })
  assert.equal(r.provider, 'claude-code')
  assert.equal(r.source, ROUTE_SOURCES.TABLE, '表命中时不许让建议插手')
})

test('★ F-23 单次任务显式指定 ⇒ 压过配置表', () => {
  const router = mk([{ taskType: 'code-review', provider: 'claude-code' }])
  const r = router.resolve({ taskType: 'code-review', requested: 'codex', suggested: 'claude-code' })
  assert.equal(r.provider, 'codex')
  assert.equal(r.source, ROUTE_SOURCES.EXPLICIT)
})

test('★ F-23 模型建议作**兜底**：表没命中且在册 ⇒ 采纳，并记为 suggested（不是 table）', () => {
  const router = mk([{ taskType: 'code-review', provider: 'claude-code' }])
  const r = router.resolve({ taskType: '未登记的类型', suggested: 'codex' })
  assert.equal(r.provider, 'codex')
  assert.equal(r.source, ROUTE_SOURCES.SUGGESTED)
})

test('★★ F-23 指名不在册 ⇒ **具名拒绝，绝不回落到默认**', () => {
  const router = mk([{ taskType: 'code-review', provider: 'claude-code' }])
  const a = router.resolve({ requested: 'gemini' })
  assert.equal(a.ok, false)
  assert.equal(a.reason, ROUTE_REJECT.UNKNOWN_PROVIDER)
  assert.equal(a.detail.stage, ROUTE_SOURCES.EXPLICIT)
  const b = router.resolve({ suggested: 'gemini' })
  assert.equal(b.ok, false)
  assert.equal(b.detail.stage, ROUTE_SOURCES.SUGGESTED)
  // ★ 关键：被拒时**没有** provider 字段 —— 调用方不可能"顺手用默认顶上"
  assert.equal('provider' in a, false)
  assert.equal('provider' in b, false)
})

test('★ F-23 错误挪到启动期：默认不在册 / 规则指向不在册 ⇒ 构造即抛', () => {
  assert.throws(() => createHarnessRouter({ providers: PROVIDERS, defaultProvider: 'gemini' }), /默认 provider 不在册/)
  assert.throws(() => mk([{ taskType: 'x', provider: 'gemini' }]), /规则指向不在册的 provider/)
  assert.throws(() => mk([{ taskType: '', provider: 'codex' }]), /规则形状不对/)
  assert.throws(() => createHarnessRouter({ providers: [], defaultProvider: 'x' }), /providers 必填/)
})

test('F-23 只读面是快照：外部改它影响不到内部', () => {
  const router = mk([{ taskType: 'code-review', provider: 'claude-code' }])
  const d = router.describe()
  assert.deepEqual(d.providers.sort(), ['claude-code', 'codex', 'deepseek-harness'])
  assert.equal(d.defaultProvider, 'deepseek-harness')
  d.providers.push('gemini')
  d.rules.push({ taskType: 'evil', provider: 'gemini' })
  assert.equal(router.resolve({ requested: 'gemini' }).ok, false, '外部改快照不得让 gemini 变成在册')
  assert.equal(router.resolve({ taskType: 'evil' }).source, ROUTE_SOURCES.DEFAULT)
})

test('F-23 空白与重复：在册清单去重、两端空白被裁掉', () => {
  const router = createHarnessRouter({ providers: [' codex ', 'codex', 'deepseek-harness'], defaultProvider: 'codex' })
  assert.deepEqual(router.describe().providers, ['codex', 'deepseek-harness'])
  assert.equal(router.resolve({ requested: ' codex ' }).provider, 'codex')
})
