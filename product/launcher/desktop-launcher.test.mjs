import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDesktopLauncher } from './desktop-launcher.mjs'
import { acquireSingleInstance } from './single-instance.mjs'

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
