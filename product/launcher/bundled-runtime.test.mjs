import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { importBundledRuntime } from './bundled-runtime.mjs'
import { readActiveRuntime, runtimePathsOf } from './runtime-install.mjs'
import { inventoryTree, DESKTOP_MANIFEST_FORMAT } from '../release/desktop-manifest.mjs'
import { prepareInWorker } from './desktop-launcher.mjs'

const release = { productVersion: '0.1.0', legionVersion: '0.1.0', dshVersion: '0.1.5-rc.2',
  dshCompositionPatchVersion: 1, runtimeContractVersion: 1, packProtocolVersion: 1, schemaVersion: 1 }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'legion-import-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bundleRoot = join(root, 'bundle'), dataDir = join(root, 'data')
  const entryDir = join(bundleRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  await mkdir(entryDir, { recursive: true })
  await writeFile(join(entryDir, 'bin.js'), '// bundled fixture')
  await writeFile(join(bundleRoot, 'dsh', 'package-lock.json'), '{}')
  const files = await inventoryTree(join(bundleRoot, 'dsh'), 'dsh')
  const manifest = { format: DESKTOP_MANIFEST_FORMAT, platform: process.platform, arch: process.arch,
    bridgeProtocol: 1, versions: { ...release, node: process.versions.node }, files }
  await writeFile(join(bundleRoot, 'desktop-release.json'), JSON.stringify(manifest))
  return { root, bundleRoot, dataDir, installDir: bundleRoot, release, manifest }
}

test('offline import publishes the shared pointer only after verified completion; repeat launch reuses it', async t => {
  const input = await fixture(t)
  const result = await importBundledRuntime(input)
  assert.equal(result.ok, true)
  const active = readActiveRuntime({ dataDir: input.dataDir })
  assert.equal(active.version, release.dshVersion)
  assert.equal(active.complete, true)
  assert.equal((await importBundledRuntime(input)).reused, true)
})

test('tampered bundled bytes preserve the old pointer and do not create a completed installation', async t => {
  const input = await fixture(t)
  const paths = runtimePathsOf({ dataDir: input.dataDir, targetVersion: release.dshVersion })
  await mkdir(paths.runtimeRoot, { recursive: true })
  await writeFile(paths.pointerPath, '{"version":"previous"}')
  await writeFile(join(input.bundleRoot, 'dsh', 'package-lock.json'), 'tampered')
  await assert.rejects(importBundledRuntime(input), { code: 'BUNDLE_HASH_MISMATCH' })
  assert.equal(await readFile(paths.pointerPath, 'utf8'), '{"version":"previous"}')
})

test('cancel during local copy removes staging and never advances the pointer; retry succeeds', async t => {
  const input = await fixture(t)
  const abort = new AbortController()
  await assert.rejects(importBundledRuntime({ ...input, signal: abort.signal, onProgress(p) {
    if (p.phase === 'importing-runtime') abort.abort()
  } }), { name: 'AbortError' })
  const paths = runtimePathsOf({ dataDir: input.dataDir, targetVersion: release.dshVersion })
  assert.deepEqual(await readdir(paths.versionsDir), [])
  await assert.rejects(readFile(paths.pointerPath), { code: 'ENOENT' })
  assert.equal((await importBundledRuntime(input)).ok, true)
})

test('completed orphan is recovered after cancellation before pointer commit', async t => {
  const input = await fixture(t)
  await importBundledRuntime(input)
  const paths = runtimePathsOf({ dataDir: input.dataDir, targetVersion: release.dshVersion })
  await rm(paths.pointerPath)
  assert.equal((await importBundledRuntime(input)).reused, true)
  assert.equal(readActiveRuntime({ dataDir: input.dataDir }).complete, true)
})

test('mutable root cannot redirect installation through an escaping junction', async t => {
  const input = await fixture(t)
  await mkdir(input.dataDir)
  const outside = join(input.root, 'outside'); await mkdir(outside)
  await symlink(outside, join(input.dataDir, 'runtime'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(importBundledRuntime(input), { code: 'BUNDLE_DESTINATION_LINK' })
  assert.deepEqual(await readdir(outside), [])
})

test('real preparation worker reports progress and exits after a verified local import', async t => {
  const input = await fixture(t)
  const progress = []
  assert.equal((await prepareInWorker(input, { onProgress: p => progress.push(p.phase) })).ok, true)
  assert.ok(progress.includes('importing-runtime'))
  assert.ok(progress.includes('runtime-prepared'))
})

test('real worker cancellation during import leaves no active pointer', async t => {
  const input = await fixture(t)
  for (let i = 0; i < 20; i++) await writeFile(join(input.bundleRoot, 'dsh', `asset-${i}.bin`), Buffer.alloc(64 * 1024, i))
  input.manifest.files = await inventoryTree(join(input.bundleRoot, 'dsh'), 'dsh')
  await writeFile(join(input.bundleRoot, 'desktop-release.json'), JSON.stringify(input.manifest))
  const abort = new AbortController()
  await assert.rejects(prepareInWorker(input, { signal: abort.signal, onProgress(p) {
    if (p.phase === 'importing-runtime') abort.abort()
  } }), { code: 'PREPARATION_CANCELLED' })
  const paths = runtimePathsOf({ dataDir: input.dataDir, targetVersion: release.dshVersion })
  await assert.rejects(readFile(paths.pointerPath), { code: 'ENOENT' })
  assert.deepEqual(await readdir(paths.versionsDir), [])
})
