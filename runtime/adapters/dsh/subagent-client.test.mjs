import assert from 'node:assert/strict'
import test from 'node:test'
import {
  observedSubagentProviders,
  subagentProviderCapabilities,
  subagentProviderCatalogMode,
  subagentProviderPermissionMode,
} from './subagent-client.mjs'

function contextFor(provider) {
  return {
    subagents: {
      getProvider(name) { return name === 'codex' ? provider : undefined },
    },
  }
}

test('reads the effective permission mode from DSH provider config', () => {
  const ctx = contextFor({
    capabilities: {},
    config: { permissionMode: 'approve-for-me' },
  })

  assert.equal(subagentProviderPermissionMode(ctx, 'codex'), 'approve-for-me')
  assert.deepEqual(subagentProviderCapabilities(ctx, 'codex'), {
    outputSchema: false,
    toolFilter: false,
    cancellation: true,
    permissionMode: 'approve-for-me',
  })
})

test('keeps compatibility with providers exposing permissionMode at top level', () => {
  const ctx = contextFor({
    capabilities: {},
    permissionMode: 'approve-for-me',
    config: { permissionMode: 'never' },
  })

  assert.equal(subagentProviderPermissionMode(ctx, 'codex'), 'approve-for-me')
})

// ══════════════════════════════════════════════════════════════════════════
// BUG-050-d：这一代 `ctx.subagents` **没有 `list()`**（目录按 Agent 树走）。
//
// 现场（2026-11-20）：`listSubagentProviders` 直接调 `.list()` ⇒ TypeError ⇒ 被
// 心跳的 try/catch 吞掉 ⇒ 节点上报 `providers: []` ⇒ 中枢"声明 ⊆ 观测"必然失败
// ⇒ 节点永久 incompatible。而**注册表其实是好的**（`getProvider('spawn')` 拿得到，
// 就绪度里 `spawn/fork` 都是 ready）。
// ══════════════════════════════════════════════════════════════════════════

test('★ 能枚举的一代：照枚举（顺序保持 DSH 的注册顺序）', () => {
  const ctx = { subagents: { list: () => ['fork', 'spawn'], getProvider: () => undefined } }
  assert.equal(subagentProviderCatalogMode(ctx), 'list')
  assert.deepEqual(observedSubagentProviders(ctx, ['spawn']), ['fork', 'spawn'])
})

test('★★★ 枚举不到的一代：对候选逐个 `getProvider`，只认问到的（不是"一个都没有"）', () => {
  const registered = new Map([['spawn', { name: 'spawn' }], ['codex', { name: 'codex' }]])
  const ctx = {
    subagents: {
      getProvider: (name) => registered.get(name),
      // 这一代**没有** list：
    },
  }
  assert.equal(subagentProviderCatalogMode(ctx), 'unavailable')
  assert.deepEqual(
    observedSubagentProviders(ctx, ['spawn', 'fork', 'codex', '  ', 'spawn']),
    ['spawn', 'codex'],
    '★★ 问得到的才报：fork 不在册就不报；空白与重复要被丢掉',
  )
  // ★ 一个都问不到 ⇒ 空数组（这才是"真的没有"，与"列不出来"已经分开了）
  assert.deepEqual(observedSubagentProviders(ctx, ['claude-code']), [])
})

test('★ getProvider 抛错时按"问不到"处理（一次目录读取不该把心跳带崩）', () => {
  const ctx = { subagents: { getProvider: () => { throw new Error('boom') } } }
  assert.deepEqual(observedSubagentProviders(ctx, ['spawn']), [])
})

test('★ 服务上既没有 list 也没有 getProvider：返回空，不抛', () => {
  assert.deepEqual(observedSubagentProviders({ subagents: {} }, ['spawn']), [])
})
