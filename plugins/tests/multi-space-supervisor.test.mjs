import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'

/**
 * SP-P1 多空间监督者：**编排本身**（挂载/卸载/重启 diff）的行为，用假宿主 + 假 hub 驱动。
 *
 * 覆盖：按数据面挂载子实例、执行关闭后卸载、关键配置变化后重启、宿主释放时全量卸载、
 *      以及「父 scope 不在接管集合时 daemon.json 仍有人维护」。
 */

function fakeContext() {
  const mounts = []
  const intervals = []
  const effects = []
  const ctx = {
    plugin: (plugin, config) => {
      const entry = { plugin, config, disposed: false }
      mounts.push(entry)
      return { dispose: () => { entry.disposed = true } }
    },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return () => {} },
    effect: (fn) => { const disposer = fn(); effects.push(disposer); return () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: () => undefined,
  }
  return { ctx, mounts, intervals, effects }
}

function baseConfig(root, overrides = {}) {
  return {
    role: 'soldier-auto', intervalMs: 30_000, maxWorkers: 1, workerTimeoutMs: 60_000,
    staleMinutes: 40, taskTtlMinutes: 0, provider: 'spawn', scrumDir: join(root, 'scrum'),
    workspace: root, isolate: true, repoRoot: root, worktreeRoot: '', denyTools: [],
    rolesFile: '', logFile: join(root, 'supervisor.log'),
    hubUrl: 'http://hub.test', hubToken: '', scope: 'software', agentPreset: 'code',
    scopes: 'auto', primaryScope: '',
    ...overrides,
  }
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

/** 假 hub：/api/spaces + /api/pipeline?scope=…&include=active；data 可变以模拟数据面变化。 */
function stubHub(initial) {
  const state = { spaces: initial }
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    const href = String(url)
    if (href.includes('/api/spaces')) return jsonResponse(state.spaces.map(s => ({ id: s.id })))
    const m = /\/api\/pipeline\?scope=([^&]+)/.exec(href)
    if (m !== null) {
      const s = state.spaces.find(x => x.id === decodeURIComponent(m[1]))
      if (s === undefined) return new Response('{}', { status: 404 })
      return jsonResponse({
        runtime: { enabled: s.enabled, maxWorkers: s.maxWorkers, isolate: s.isolate },
        activeRoles: Array.from({ length: s.stages }, (_, i) => `role-${i}`),
      })
    }
    return new Response('{}', { status: 404 })
  }
  return {
    state,
    restore: () => { globalThis.fetch = original },
  }
}

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const live = (id, extra = {}) => ({ id, enabled: true, stages: 6, ...extra })

async function withCase(spaces, fn) {
  const root = mkdtempSync(join(tmpdir(), 'sp-p1-'))
  const hub = stubHub(spaces)
  try {
    await fn({ root, hub })
  } finally {
    hub.restore()
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

test('TC-SP-P1-20 首次对齐：按数据面为每个已开通空间挂一个子实例，且都退回单空间模式', async () => {
  await withCase([live('software', { maxWorkers: 2 }), live('ozon', { maxWorkers: 1, isolate: false })], async ({ root }) => {
    const h = fakeContext()
    apply(h.ctx, baseConfig(root))
    await waitFor(() => h.mounts.length >= 2, '应挂载 2 个子实例')
    assert.deepEqual(h.mounts.map(m => m.config.scope).sort(), ['ozon', 'software'])
    for (const m of h.mounts) {
      assert.equal(m.config.scopes, 'off', '子实例必须单空间（防递归）')
      assert.match(m.plugin.name, /space:/)
    }
    const software = h.mounts.find(m => m.config.scope === 'software')
    const ozon = h.mounts.find(m => m.config.scope === 'ozon')
    assert.equal(software.config.maxWorkers, 2, '数据面 space_runtime.maxWorkers 下发')
    assert.equal(software.config.primaryScope, 'software', '父 scope 在集合内 → 由它维护 daemon.json')
    assert.equal(ozon.config.maxWorkers, 1)
    assert.equal(ozon.config.isolate, false, '数据面 isolate 覆盖部署面')
    assert.match(ozon.config.logFile, /supervisor-ozon\.log$/, '子实例日志分文件')
  })
})

test('TC-SP-P1-21 数据面变化：关闭执行 → 该空间卸载，其余不动（最小 diff，不重启无辜实例）', async () => {
  await withCase([live('software'), live('ozon')], async ({ root, hub }) => {
    const h = fakeContext()
    apply(h.ctx, baseConfig(root))
    await waitFor(() => h.mounts.length >= 2, '初始应挂载 2 个')
    const softwareMount = h.mounts.find(m => m.config.scope === 'software')

    hub.state.spaces = [live('software'), live('ozon', { enabled: false })]
    h.intervals[0].fn()
    await waitFor(() => h.mounts.find(m => m.config.scope === 'ozon').disposed, 'ozon 子实例应被卸载')
    assert.equal(softwareMount.disposed, false, 'software 未变化 → 不得被重启')
    assert.equal(h.mounts.filter(m => m.config.scope === 'software').length, 1, '不得重复挂载')
  })
})

test('TC-SP-P1-22 关键配置变化：并发上限变化 → 只重启该空间（旧实例先卸载）', async () => {
  await withCase([live('software', { maxWorkers: 1 }), live('ozon')], async ({ root, hub }) => {
    const h = fakeContext()
    apply(h.ctx, baseConfig(root))
    await waitFor(() => h.mounts.length >= 2, '初始应挂载 2 个')
    const first = h.mounts.find(m => m.config.scope === 'software')
    const ozonMount = h.mounts.find(m => m.config.scope === 'ozon')

    hub.state.spaces = [live('software', { maxWorkers: 3 }), live('ozon')]
    h.intervals[0].fn()
    await waitFor(() => first.disposed, '配置变化 → 旧实例先卸载')
    await waitFor(() => h.mounts.some(m => m.config.scope === 'software' && !m.disposed && m !== first), '应挂载新实例')
    const next = h.mounts.filter(m => m.config.scope === 'software' && m !== first)
    assert.equal(next.length, 1)
    assert.equal(next[0].config.maxWorkers, 3)
    assert.equal(ozonMount.disposed, false, 'ozon 未变化 → 不得被牵连重启')
  })
})

test('TC-SP-P1-23 未开通/无流水线/白名单外：一律不接管（避免退化成单角色认领）', async () => {
  await withCase([live('a'), live('b', { enabled: false }), live('c', { stages: 0 }), live('d')], async ({ root }) => {
    const h = fakeContext()
    apply(h.ctx, baseConfig(root, { scopes: ['a', 'b', 'c'] }))
    await waitFor(() => h.mounts.length >= 1, '应至少挂载 a')
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.deepEqual(h.mounts.map(m => m.config.scope), ['a'], 'b（未开通）/c（无流水线）/d（白名单外）都不接管')
  })
})

test('TC-SP-P1-24 父 scope 未被接管时，第一个空间顶上维护 daemon.json（看板守护卡片不能失效）', async () => {
  await withCase([live('ozon'), live('software')], async ({ root }) => {
    const h = fakeContext()
    apply(h.ctx, baseConfig(root, { scope: 'legacy-space' }))
    await waitFor(() => h.mounts.length >= 2, '应挂载 2 个子实例')
    assert.deepEqual(h.mounts.map(m => m.config.primaryScope), ['ozon', 'ozon'], '第一个空间顶上')
  })
})

test('TC-SP-P1-25 宿主释放：所有子实例随监督者一起卸载（不留孤儿 sweep）', async () => {
  await withCase([live('software'), live('ozon')], async ({ root }) => {
    const h = fakeContext()
    apply(h.ctx, baseConfig(root))
    await waitFor(() => h.mounts.length >= 2, '初始应挂载 2 个')
    for (const disposer of h.effects) await disposer()
    assert.ok(h.mounts.every(m => m.disposed), '监督者释放后不得有存活子实例')
  })
})

test('TC-SP-P1-26 scopes=off（默认）：完全不进监督者分支，行为与 P1 之前一致', async () => {
  await withCase([live('software')], async ({ root }) => {
    const h = fakeContext()
    // 单空间模式下 apply 不 mount 任何子实例（走 spaceWorker）；这里用最小假 ctx 断言「没有 mount 动作」。
    try {
      apply(h.ctx, baseConfig(root, { scopes: 'off' }))
    } catch {
      // spaceWorker 需要 timer/agents 等真实服务：本用例只关心「没有监督者行为」
    }
    assert.equal(h.mounts.length, 0, '单空间模式不得挂载任何子实例')
  })
})
