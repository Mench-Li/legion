// F-23 判据：配置表可改、判定立刻生效、来源如实、指名不在册不回落、默认不可摘/不可悬空。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createHarnessRoutes } from './harness.mjs'
import { createHarnessStore, DEFAULT_HARNESS_NAME } from '../harness-store.mjs'
import { ROUTE_SOURCES, ROUTE_REJECT } from '../../runtime/contracts/harness-routing.mjs'

function mk() {
  const store = createHarnessStore({ db: new DatabaseSync(':memory:') })
  const calls = []
  let body
  const handleWrite = async (_q, _s, cb) => {
    try { calls.push({ ok: true, value: await cb(body, 'tester', 'default') }) }
    catch (e) { calls.push({ ok: false, message: String(e.message) }) }
  }
  const routes = createHarnessRoutes({ json: () => {}, handleWrite, harnessStore: store })
  const hit = async (path, b, method = 'POST') => { body = b; return routes.dispatch({ method }, {}, { path }) }
  return { store, routes, calls, hit }
}
const CODEX = { name: 'codex', kind: 'codex', command: 'codex', args: ['exec'], permission: 'reject' }

test('F-23 缺注入项 ⇒ 当场抛', () => {
  assert.throws(() => createHarnessRoutes({ json: () => {}, handleWrite: async () => {} }), /createHarnessRoutes 缺注入项：harnessStore/)
})

test('★ F-23 默认表：只有 DeepSeek Harness 一行，且标记 protected；不指定就走它', async () => {
  const s = mk()
  assert.deepEqual(s.store.routerConfig().providers, [DEFAULT_HARNESS_NAME])
  assert.equal(s.store.listProviders().length, 1)
  assert.equal(s.store.listProviders()[0].protected, true)
  await s.hit('/api/harness/resolve', {})
  assert.equal(s.calls[0].value.provider, DEFAULT_HARNESS_NAME)
  assert.equal(s.calls[0].value.source, ROUTE_SOURCES.DEFAULT)
})

test('★ F-23 配置表为权威：落一行 codex，改任务类型规则 ⇒ 判定立刻按表（不必重启）', async () => {
  const s = mk()
  await s.hit('/api/harness/providers', CODEX)
  await s.hit('/api/harness/rules', { taskType: 'code-review', provider: 'codex' })
  await s.hit('/api/harness/resolve', { taskType: 'code-review', suggested: 'claude-code' })
  assert.equal(s.calls[2].value.provider, 'codex', '表命中压过建议')
  assert.equal(s.calls[2].value.source, ROUTE_SOURCES.TABLE)
  // ★ 表是**现读**的：改掉它，下一次判定立刻变
  await s.hit('/api/harness/rules', { taskType: 'code-review', provider: DEFAULT_HARNESS_NAME })
  await s.hit('/api/harness/resolve', { taskType: 'code-review' })
  assert.equal(s.calls[4].value.provider, DEFAULT_HARNESS_NAME)
})

test('★ F-23 单次指定压过表；指名不在册 ⇒ 具名拒绝（且不回落默认）', async () => {
  const s = mk()
  await s.hit('/api/harness/providers', CODEX)
  await s.hit('/api/harness/rules', { taskType: 'code-review', provider: 'codex' })
  await s.hit('/api/harness/resolve', { taskType: 'code-review', requested: DEFAULT_HARNESS_NAME })
  assert.equal(s.calls[2].value.source, ROUTE_SOURCES.EXPLICIT)
  assert.equal(s.calls[2].value.provider, DEFAULT_HARNESS_NAME)
  await s.hit('/api/harness/resolve', { taskType: 'code-review', requested: 'gemini' })
  assert.equal(s.calls[3].ok, false)
  assert.match(s.calls[3].message, new RegExp(ROUTE_REJECT.UNKNOWN_PROVIDER))
})

test('★ F-23 默认 provider 不可摘除：摘它报 protected-default 且仍在册', async () => {
  const s = mk()
  await s.hit('/api/harness/providers/remove', { name: DEFAULT_HARNESS_NAME })
  assert.equal(s.calls[0].value.removed, 0)
  assert.equal(s.calls[0].value.reason, 'protected-default')
  assert.equal(s.store.routerConfig().providers.includes(DEFAULT_HARNESS_NAME), true)
  await s.hit('/api/harness/resolve', {})
  assert.equal(s.calls[1].value.provider, DEFAULT_HARNESS_NAME)
})

test('★ F-23 被规则指着的 provider 不许摘（别让配置表悬空）', async () => {
  const s = mk()
  await s.hit('/api/harness/providers', CODEX)
  await s.hit('/api/harness/rules', { taskType: 'code-review', provider: 'codex' })
  await s.hit('/api/harness/providers/remove', { name: 'codex' })
  assert.equal(s.calls[2].value.reason, 'in-use')
  assert.deepEqual(s.calls[2].value.taskTypes, ['code-review'])
  await s.hit('/api/harness/rules/remove', { taskType: 'code-review' })
  assert.equal(s.calls[3].value.removed, 1)
  await s.hit('/api/harness/providers/remove', { name: 'codex' })
  assert.equal(s.calls[4].value.removed, 1, '规则摘掉后才允许摘 provider')
})

test('★ F-23 规则指向不在册 ⇒ 写入当场拒（别等派工时才发现）', async () => {
  const s = mk()
  await s.hit('/api/harness/rules', { taskType: 'x', provider: 'gemini' })
  assert.equal(s.calls[0].ok, false)
  assert.match(s.calls[0].message, /规则指向不在册的 provider/)
  assert.equal(s.store.listRules().length, 0)
})

test('F-23 停用一行 = 从在册清单里消失（但规则会因此指向不存在 ⇒ 拒绝写入，先配套）', async () => {
  const s = mk()
  await s.hit('/api/harness/providers', { ...CODEX, enabled: false })
  assert.equal(s.store.routerConfig().providers.includes('codex'), false, '停用的不在册')
  await s.hit('/api/harness/rules', { taskType: 'x', provider: 'codex' })
  assert.equal(s.calls[1].ok, false, '停用的 provider 不能被规则指')
})

test('F-23 provider 字段校验：permission 只有 reject/allow；args 必须是数组；env 必须是对象', async () => {
  const s = mk()
  for (const [b, re] of [[{ ...CODEX, permission: 'maybe' }, /permission/], [{ ...CODEX, args: 'x' }, /args/], [{ ...CODEX, env: [] }, /env/], [{ command: 'x' }, /缺少参数 name/]]) {
    s.calls.length = 0
    await s.hit('/api/harness/providers', b)
    assert.equal(s.calls[0].ok, false, JSON.stringify(b))
    assert.match(s.calls[0].message, re)
  }
})

test('F-23 本族只认自己那几条路', async () => {
  const s = mk()
  assert.equal(await s.hit('/api/tasks', {}), false)
  assert.equal(await s.hit('/api/harness/resolve', {}, 'GET'), false)
  assert.equal(s.routes.id, 'harness')
  assert.equal(s.routes.routes.length, 7)
})
