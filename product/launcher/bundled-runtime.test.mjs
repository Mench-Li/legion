import { test as nodeTest } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, writeFile, readFile, rm, readdir, stat, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { importBundledRuntime } from './bundled-runtime.mjs'
import { readActiveRuntime, runtimePathsOf } from './runtime-install.mjs'
import { inventoryTree, DESKTOP_MANIFEST_FORMAT } from '../release/desktop-manifest.mjs'
import { prepareInWorker } from './desktop-launcher.mjs'
import { hashFile } from '../release/desktop-manifest.mjs'

// ★ 本文件整份都建在 `desktop/node_modules/@electron/asar` 之上（打包 ASAR、算版本、
//   连同 glob/minimatch 一起当 vendor 摆进夹具）。而那套依赖**不在 CI 的 deps 阶段里**
//   （`run-ci.mjs` 的 `stageDeps` 只处理 `workbench/node_modules`）。
//
//   所以缺它时必须**具名跳过**，不能让它以静态 import 的形式在加载期炸掉 ——
//   后者在读数里长成一条"用例失败"，而真相是"这条用例今天没跑"。
//
//   > 把"没跑"显示成"失败"，与把"跳过"显示成"通过"，
//   > 是同一种坏法的两个方向：都让人去查一个不存在的问题。
const ASAR_ENTRY = fileURLToPath(new URL('../../desktop/node_modules/@electron/asar/lib/asar.js', import.meta.url))
const ASAR_SKIP = existsSync(ASAR_ENTRY)
  ? false
  : 'SKIP：desktop/node_modules 未安装（CI 的 deps 阶段只装 workbench 的依赖；本机需先 `cd desktop && npm install`）'
const asar = ASAR_SKIP ? null : (await import(pathToFileURL(ASAR_ENTRY).href)).default

// 整份文件共用同一个跳过理由：这 13 条全部要打 ASAR、要摆 vendor 依赖，缺一即不可跑。
// 用一个本地 `test` 把它接住，而不是在 13 个调用点上各写一遍 ——
// 13 处写 13 遍，漏掉的那一处就会在 CI 里变成一条"失败"。
const test = ASAR_SKIP ? (name, fn) => nodeTest(name, { skip: ASAR_SKIP }, fn) : nodeTest

const release = { productVersion: '0.1.0', legionVersion: '0.1.0', dshVersion: '0.1.5-rc.2',
  dshCompositionPatchVersion: 1, runtimeContractVersion: 1, packProtocolVersion: 1, schemaVersion: 1 }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'legion-import-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bundleRoot = join(root, 'bundle'), dataDir = join(root, 'data')
  const entryDir = join(bundleRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  await mkdir(entryDir, { recursive: true })
  await writeFile(join(entryDir, 'bin.js'), '// bundled fixture')
  await writeFile(join(entryDir, '..', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: release.dshVersion }))
  await writeFile(join(bundleRoot, 'dsh', 'package-lock.json'), JSON.stringify({ lockfileVersion: 3,
    packages: { 'node_modules/@deepseek-ai/dsh': { version: release.dshVersion } } }))
  const files = await inventoryTree(join(bundleRoot, 'dsh'), 'dsh')
  const manifest = { format: DESKTOP_MANIFEST_FORMAT, platform: process.platform, arch: process.arch,
    bridgeProtocol: 1, versions: { ...release, node: process.versions.node }, files }
  await writeFile(join(bundleRoot, 'desktop-release.json'), JSON.stringify(manifest))
  return { root, bundleRoot, dataDir, installDir: bundleRoot, release, manifest }
}

async function stageArchiveRuntime(bundleRoot) {
  const desktopModules = fileURLToPath(new URL('../../desktop/node_modules', import.meta.url))
  const vendorRoot = join(bundleRoot, 'legion', 'vendor', 'archive')
  const targetModules = join(vendorRoot, 'node_modules')
  await mkdir(targetModules, { recursive: true })
  const packages = [
    ['@electron/asar', join(desktopModules, '@electron', 'asar')],
    ['glob', join(desktopModules, 'glob')],
    ['minimatch', join(desktopModules, '@electron', 'asar', 'node_modules', 'minimatch')],
    ...['fs.realpath', 'inflight', 'inherits', 'once', 'path-is-absolute', 'wrappy', 'concat-map']
      .map(name => [name, join(desktopModules, name)]),
  ]
  for (const [name, source] of packages) {
    const target = join(targetModules, ...name.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await cp(source, target, { recursive: true })
  }
  await writeFile(join(vendorRoot, 'package.json'), JSON.stringify({ name: 'legion-archive-runtime', private: true }))
  return JSON.parse(await readFile(join(desktopModules, '@electron', 'asar', 'package.json'), 'utf8')).version
}

async function createArchiveBundle(input, { additionalFiles = [] } = {}) {
  const asarVersion = await stageArchiveRuntime(input.bundleRoot)
  const source = join(input.bundleRoot, 'dsh')
  for (const [name, contents] of additionalFiles) {
    const path = join(source, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, contents)
  }
  input.manifest.files = await inventoryTree(source, 'dsh')
  const archivePath = join(input.bundleRoot, 'dsh.asar')
  await asar.createPackage(source, archivePath)
  const archiveStats = await stat(archivePath)
  input.manifest.versions.asar = asarVersion
  input.manifest.archives = [{ component: 'dsh', path: 'dsh.asar', bytes: archiveStats.size, sha256: await hashFile(archivePath) }]
  await writeFile(join(input.bundleRoot, 'desktop-release.json'), JSON.stringify(input.manifest))
  await rm(source, { recursive: true, force: true })
  return archivePath
}

test('offline import publishes the shared pointer only after verified completion; repeat launch reuses it', async t => {
  const input = await fixture(t)
  const result = await importBundledRuntime(input)
  assert.equal(result.ok, true)
  assert.equal(Number.isFinite(result.timingsMs.verifyBundle), true)
  assert.equal(Number.isFinite(result.timingsMs.copyRuntime), true)
  assert.equal(Number.isFinite(result.timingsMs.verifyImportedRuntime), true)
  assert.equal(result.timingsMs.prepareTotal >= result.timingsMs.copyRuntime, true)
  const active = readActiveRuntime({ dataDir: input.dataDir })
  assert.equal(active.version, release.dshVersion)
  assert.equal(active.complete, true)
  assert.equal((await importBundledRuntime(input)).reused, true)
  const profile = JSON.parse(await readFile(join(input.dataDir, 'runtime', 'dsh', 'home', 'profiles', 'legion-desktop', 'package.json'), 'utf8'))
  assert.equal(profile.dsh.profile.patchReload, 'startup')
  assert.deepEqual(profile.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
})

test('hashed ASAR payload is locally extracted, individually verified, and published through the same pointer', async t => {
  const input = await fixture(t)
  await createArchiveBundle(input)
  const result = await importBundledRuntime(input)
  assert.equal(result.ok, true)
  assert.equal(readActiveRuntime({ dataDir: input.dataDir }).complete, true)
  const installed = runtimePathsOf({ dataDir: input.dataDir, targetVersion: release.dshVersion })
  assert.equal(await readFile(installed.entryPath, 'utf8'), '// bundled fixture')
})

test('existing same-version runtime migrates only when differences are pruned metadata or x64-excluded files', async t => {
  const input = await fixture(t)
  const oldFiles = [
    ['node_modules/@deepseek-ai/dsh/lib/bin.js.map', 'source map'],
    ['node_modules/@deepseek-ai/dsh/lib/index.d.ts', 'declaration'],
    ['node_modules/node-pty/prebuilds/win32-arm64/pty.node', 'arm64 binary'],
    ['node_modules/node-pty/third_party/conpty/1.25.260303002/win10-arm64/conpty.dll', 'arm64 dll'],
  ]
  for (const [name, contents] of oldFiles) {
    const path = join(input.bundleRoot, 'dsh', name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, contents)
  }
  input.manifest.files = await inventoryTree(join(input.bundleRoot, 'dsh'), 'dsh')
  await writeFile(join(input.bundleRoot, 'desktop-release.json'), JSON.stringify(input.manifest))
  await importBundledRuntime(input)

  const paths = runtimePathsOf({ dataDir: input.dataDir, targetVersion: release.dshVersion })
  const oldPointer = await readFile(paths.pointerPath, 'utf8')
  for (const [name] of oldFiles) await rm(join(input.bundleRoot, 'dsh', ...name.split('/')), { force: true })
  await createArchiveBundle(input)
  const migrated = await importBundledRuntime(input)

  assert.equal(migrated.ok, true)
  assert.equal(migrated.reused, true)
  assert.equal(await readFile(paths.pointerPath, 'utf8'), oldPointer)
  const marker = JSON.parse(await readFile(paths.markerPath, 'utf8'))
  assert.equal(marker.payloadDigest, createHash('sha256').update(JSON.stringify(input.manifest.files)).digest('hex'))
  assert.equal(Number.isFinite(marker.migratedAtMs), true)
  for (const [name] of oldFiles) await assert.rejects(readFile(join(paths.versionDir, ...name.split('/'))), { code: 'ENOENT' })

  const pointerAfterMigration = await readFile(paths.pointerPath, 'utf8')
  await writeFile(join(paths.versionDir, 'untracked-runtime.js'), 'must be rejected')
  await writeFile(paths.markerPath, JSON.stringify({ ...marker, payloadDigest: 'previous-payload' }))
  await assert.rejects(importBundledRuntime(input), { code: 'BUNDLE_EXISTING_VERSION_MISMATCH' })
  assert.equal(await readFile(paths.pointerPath, 'utf8'), pointerAfterMigration)
})

test('changed ASAR bytes are rejected before staging or current-pointer mutation', async t => {
  const input = await fixture(t)
  const archivePath = await createArchiveBundle(input)
  await writeFile(archivePath, 'tampered')
  await assert.rejects(importBundledRuntime(input), { code: 'BUNDLE_HASH_MISMATCH' })
  const paths = runtimePathsOf({ dataDir: input.dataDir, targetVersion: release.dshVersion })
  await assert.rejects(readFile(paths.pointerPath), { code: 'ENOENT' })
  await assert.rejects(readdir(paths.versionsDir), { code: 'ENOENT' })
})

test('cancelling a real ASAR extraction worker leaves no staging files or runtime pointer', async t => {
  const input = await fixture(t)
  const content = Buffer.alloc(1024, 7)
  const files = Array.from({ length: 1200 }, (_, index) => [`assets/${index}.bin`, content])
  await createArchiveBundle(input, { additionalFiles: files })
  const abort = new AbortController()
  await assert.rejects(prepareInWorker(input, { signal: abort.signal, onProgress(progress) {
    if (progress.phase === 'importing-runtime') abort.abort()
  } }), { code: 'PREPARATION_CANCELLED' })
  const paths = runtimePathsOf({ dataDir: input.dataDir, targetVersion: release.dshVersion })
  await assert.rejects(readFile(paths.pointerPath), { code: 'ENOENT' })
  assert.deepEqual(await readdir(paths.versionsDir), [])
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

test('desktop profile configuration drift is rejected without overwriting user files or the active pointer', async t => {
  const input = await fixture(t)
  await importBundledRuntime(input)
  const paths = runtimePathsOf({ dataDir: input.dataDir, targetVersion: release.dshVersion })
  const before = await readFile(paths.pointerPath, 'utf8')
  const path = join(input.dataDir, 'runtime', 'dsh', 'home', 'profiles', 'legion-desktop', 'package.json')
  const changed = JSON.parse(await readFile(path, 'utf8'))
  changed.dsh.profile.patchReload = 'live'
  await writeFile(path, JSON.stringify(changed))
  await assert.rejects(importBundledRuntime(input), { code: 'BUNDLE_PROFILE_MISMATCH' })
  assert.equal(JSON.parse(await readFile(path, 'utf8')).dsh.profile.patchReload, 'live')
  assert.equal(await readFile(paths.pointerPath, 'utf8'), before)
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

test('a self-consistent inventory cannot disguise an unqualified actual DSH version', async t => {
  const input = await fixture(t)
  await writeFile(join(input.bundleRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0' }))
  input.manifest.files = await inventoryTree(join(input.bundleRoot, 'dsh'), 'dsh')
  await writeFile(join(input.bundleRoot, 'desktop-release.json'), JSON.stringify(input.manifest))
  await assert.rejects(importBundledRuntime(input), { code: 'BUNDLE_VERSION_MISMATCH' })
})
