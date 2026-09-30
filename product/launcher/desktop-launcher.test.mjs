import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDesktopLauncher } from './desktop-launcher.mjs'
import { acquireSingleInstance } from './single-instance.mjs'
import { resolveLayout } from '../paths.mjs'
import { writeDesktopSettings } from './desktop-settings.mjs'

test('preparation and service start retain one real DataDir lease until stop', async t => {
  const root = await mkdtemp(join(tmpdir(), 'legion-owner-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const options = { layout: { dataDir: root, installDir: join(root, 'install') }, bundledRuntime: {}, runtimeCommand: 'uncontrolled-host-dsh' }
  let releaseInner
  const owner = createDesktopLauncher(options, { prepare: async () => ({ ok: true }),
    launcherFactory: input => {
      assert.equal(input.runtimeCommand, null)
      assert.equal(input.dshProfile, 'legion-desktop')
      return {
        async start() { const lease = await input.acquireInstanceLockImpl(); releaseInner = lease.handle.release; return { ok: true } },
        async stop() { releaseInner(); return {} }, status() { return { state: 'ready', processes: [] } },
      }
    } })
  await owner.prepareRuntime()
  assert.equal((await acquireSingleInstance({ dataDir: root })).ok, false)
  assert.equal((await owner.start()).ok, true)
  assert.equal((await acquireSingleInstance({ dataDir: root })).ok, false)
  await owner.stop()
  const next = await acquireSingleInstance({ dataDir: root })
  assert.equal(next.ok, true)
  next.handle.release()
})

test('stop during preparation cancels work and releases ownership without spawning services', async t => {
  const root = await mkdtemp(join(tmpdir(), 'legion-cancel-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let entered
  const began = new Promise(resolve => { entered = resolve })
  let spawned = false
  const owner = createDesktopLauncher({ layout: { dataDir: root, installDir: join(root, 'install') }, bundledRuntime: {} }, {
    prepare: async (_input, { signal }) => { entered(); await new Promise((_, reject) => signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('cancelled'), { code: 'PREPARATION_CANCELLED' }))
    }, { once: true })) },
    launcherFactory: () => { spawned = true; throw new Error('unexpected spawn') },
  })
  const start = owner.start()
  const rejected = assert.rejects(start, { code: 'PREPARATION_CANCELLED' })
  await began
  assert.equal(owner.status().state, 'preparing')
  await owner.stop()
  await rejected
  assert.equal(spawned, false)
  const next = await acquireSingleInstance({ dataDir: root })
  assert.equal(next.ok, true)
  next.handle.release()
})

test('model setup probes before protected storage, then writes only non-secret completion metadata', async t => {
  const root = await mkdtemp(join(tmpdir(), 'legion-model-setup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const { layout } = resolveLayout({ installDir: join(root, 'install'), workspaceDir: workspace,
    env: { LEGION_HOME: join(root, 'product') } })
  await mkdir(layout.dataDir, { recursive: true })
  writeDesktopSettings(layout)
  const secret = 'sk-test-secret-value'
  const events = []
  let stored = null
  const owner = createDesktopLauncher({ layout }, {
    probeModel: async (apiKey, profile) => {
      events.push(['probe', apiKey, profile.endpoint, profile.model])
      return { ok: true, code: 'OK' }
    },
    openSecrets: async input => {
      events.push(['open', input.requireProtected])
      return { ok: true, store: { protection: () => ({ protected: true }), async put(ref, value, options) {
        stored = { ref, value, options }
        return { updatedAt: '2026-10-01T00:00:00.000Z' }
      } } }
    },
  })
  t.after(() => owner.stop())
  const result = await owner.configureModel({ apiKey: secret })
  assert.equal(result.phase, 'model-verified')
  assert.deepEqual(events.map(event => event[0]), ['probe', 'open'])
  assert.deepEqual(stored, { ref: 'model/api-key', value: secret, options: { purpose: 'model' } })
  const persisted = await (await import('node:fs/promises')).readFile(join(layout.dataDir, 'desktop.settings.json'), 'utf8')
  assert.doesNotMatch(persisted, /sk-test-secret-value|apiKey/)
  assert.doesNotMatch(JSON.stringify(result), /sk-test-secret-value/)
  await owner.stop()
})

test('failed model probe neither stores a key nor marks setup complete', async t => {
  const root = await mkdtemp(join(tmpdir(), 'legion-model-reject-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const { layout } = resolveLayout({ installDir: join(root, 'install'), workspaceDir: workspace,
    env: { LEGION_HOME: join(root, 'product') } })
  await mkdir(layout.dataDir, { recursive: true })
  writeDesktopSettings(layout)
  let opened = false
  const owner = createDesktopLauncher({ layout }, {
    probeModel: async () => ({ ok: false, code: 'AUTH_FAILED' }),
    openSecrets: async () => { opened = true; throw new Error('must not open store after failed probe') },
  })
  t.after(() => owner.stop())
  await assert.rejects(owner.configureModel({ apiKey: 'sk-test-secret-value' }), { code: 'MODEL_PROBE_AUTH_FAILED' })
  assert.equal(opened, false)
  assert.deepEqual((await import('./desktop-settings.mjs')).readDesktopSettings(layout.dataDir), { version: 1, workspace })
  await owner.stop()
})
