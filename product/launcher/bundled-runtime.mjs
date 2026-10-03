// Called only by the Launcher while holding its DataDir ownership lock.
// No executable dependency resolution, network access or npm fallback occurs here.
import * as fs from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createRuntimeWriteGuard, runtimePathsOf, COMPLETION_MARKER_FILENAME } from './runtime-install.mjs'
import { hashFile, inventoryTree, readDesktopManifest, releaseError, verifyInventory } from '../release/desktop-manifest.mjs'

const execFileAsync = promisify(execFile)

// Windows Defender and NTFS pay a high per-file cost. Copy the already verified
// tree with Robocopy's bounded worker pool, then verify every output byte against
// the release inventory before publishing it. The destination is a new private
// staging directory; junction traversal is explicitly disabled.
async function copyPayloadTree(source, destination, { signal, platform = process.platform } = {}) {
  signal?.throwIfAborted()
  if (platform === 'win32') {
    try {
      await execFileAsync('robocopy.exe', [source, destination, '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:0', '/W:0',
        '/MT:8', '/XJ', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'],
      { windowsHide: true, timeout: 600_000, maxBuffer: 1024 * 1024, signal })
      return
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted()
      // Robocopy's 0–7 exit statuses indicate success or successful copying.
      if (Number.isInteger(error.code) && error.code >= 0 && error.code < 8) return
      throw releaseError('BUNDLE_COPY_FAILED')
    }
  }
  // Portable fallback for development and non-Windows tests.
  async function walk(from, to) {
    signal?.throwIfAborted()
    await mkdir(to, { recursive: true })
    for (const item of await fs.promises.readdir(from, { withFileTypes: true })) {
      signal?.throwIfAborted()
      if (item.isSymbolicLink()) throw releaseError('BUNDLE_LINK_REJECTED')
      const childFrom = join(from, item.name), childTo = join(to, item.name)
      if (item.isDirectory()) await walk(childFrom, childTo)
      else if (item.isFile()) await copyFile(childFrom, childTo)
      else throw releaseError('BUNDLE_FILE_INVALID')
    }
  }
  await walk(source, destination)
}

async function extractPayloadArchive({ archivePath, destination, vendorRoot, signal, extractArchive }) {
  signal?.throwIfAborted()
  if (extractArchive) return extractArchive(archivePath, destination)
  if (process.platform !== 'win32') {
    const asar = createRequire(join(vendorRoot, 'package.json'))('@electron/asar')
    return asar.extractAll(archivePath, destination)
  }
  const extractor = fileURLToPath(new URL('./bundle-extract-worker.mjs', import.meta.url))
  const child = spawn(process.execPath, [extractor, archivePath, destination, vendorRoot], {
    windowsHide: true, stdio: 'ignore',
    env: Object.fromEntries(['SystemRoot', 'windir', 'ComSpec', 'TEMP', 'TMP', 'PATH']
      .filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]])),
  })
  const abortChild = () => { if (child.exitCode === null) child.kill() }
  signal?.addEventListener('abort', abortChild, { once: true })
  if (signal?.aborted) abortChild()
  try {
    const outcome = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, childSignal) => resolve({ code, childSignal }))
    })
    signal?.throwIfAborted()
    if (outcome.code !== 0) throw releaseError('BUNDLE_EXTRACT_FAILED')
  } finally { signal?.removeEventListener('abort', abortChild) }
}

async function json(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw releaseError('BUNDLE_STATE_UNREADABLE')
  }
}

export async function importBundledRuntime({ bundleRoot, dataDir, installDir, release,
  nodeVersion = process.versions.node, platform = process.platform, arch = process.arch,
  signal, onProgress = () => {}, extractArchive = null, loadArchiveApi = null,
}) {
  const startedAt = performance.now()
  const timingsMs = {}
  let phaseStartedAt = startedAt
  const markPhase = phase => {
    timingsMs[phase] = Math.round(performance.now() - phaseStartedAt)
    phaseStartedAt = performance.now()
  }
  const manifest = await readDesktopManifest(join(bundleRoot, 'desktop-release.json'), { release, nodeVersion, platform, arch })
  const files = manifest.files.filter(item => item.path.startsWith('dsh/'))
  const archive = manifest.archives?.find(item => item.component === 'dsh') ?? null
  const entry = 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'
  if (!files.some(file => file.path === entry) || !files.some(file => file.path === 'dsh/package-lock.json')) {
    throw releaseError('BUNDLE_ENTRY_MISSING')
  }
  const paths = runtimePathsOf({ dataDir, targetVersion: release.dshVersion })
  const guard = createRuntimeWriteGuard({ fs, writableRoot: dataDir, readOnlyRoots: [bundleRoot, installDir].filter(Boolean), platform })
  const dataRoot = resolve(dataDir)
  async function checked(path) {
    guard.guardPath('prepare-bundle', path)
    const rel = relative(dataRoot, resolve(path))
    // Reject junctions below the mutable root, including the mutable root itself.
    let cursor = dataRoot
    for (const segment of ['', ...rel.split(/[\\/]/).filter(Boolean)]) {
      if (segment) cursor = join(cursor, segment)
      try { if ((await lstat(cursor)).isSymbolicLink()) throw releaseError('BUNDLE_DESTINATION_LINK') }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    return path
  }
  async function atomicJson(path, value) {
    const temporary = `${path}.${randomUUID()}.tmp`
    await checked(temporary); await checked(path)
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
    try { await rename(temporary, path) } finally { await rm(temporary, { force: true }) }
  }
  const digest = createHash('sha256').update(JSON.stringify(files)).digest('hex')
  const migratePrunedPayload = async marker => {
    if (marker.version !== release.dshVersion
      || marker.dshCompositionPatchVersion !== release.dshCompositionPatchVersion
      || typeof marker.payloadDigest !== 'string') return false
    // Earlier desktop builds installed the same DSH runtime files plus only
    // metadata and ARM64 node-pty payloads that Windows x64 staging now prunes.
    // Permit that exact transition after hashing every retained file, then
    // remove only the known-pruned paths and advance the completion marker.
    const expected = new Map(files.map(file => [file.path, file]))
    const actual = await inventoryTree(paths.versionDir, 'dsh', { signal, exclude: [COMPLETION_MARKER_FILENAME] })
    const extras = []
    for (const item of actual) {
      const wanted = expected.get(item.path)
      if (wanted) {
        if (item.bytes !== wanted.bytes || item.sha256 !== wanted.sha256) return false
        expected.delete(item.path)
        continue
      }
      const relative = item.path.slice('dsh/'.length)
      const knownPruned = relative.endsWith('.map') || relative.endsWith('.d.ts')
        || relative.startsWith('node_modules/node-pty/prebuilds/win32-arm64/')
        || relative.startsWith('node_modules/node-pty/third_party/conpty/1.25.260303002/win10-arm64/')
      if (!knownPruned) return false
      extras.push(relative)
    }
    if (expected.size !== 0) return false
    for (const relative of extras) {
      const path = join(paths.versionDir, ...relative.split('/'))
      await checked(path)
      await rm(path, { force: true })
    }
    const nextMarker = { ...marker, payloadDigest: digest, migratedAtMs: Date.now() }
    await atomicJson(paths.markerPath, nextMarker)
    return true
  }
  const checkTarget = async () => {
    const marker = await json(paths.markerPath)
    if (marker === null) return false
    if (marker.version !== release.dshVersion || marker.dshCompositionPatchVersion !== release.dshCompositionPatchVersion
      || (marker.payloadDigest !== digest && !await migratePrunedPayload(marker))) {
      throw releaseError('BUNDLE_EXISTING_VERSION_MISMATCH')
    }
    await verifyInventory(paths.versionDir, files, { prefix: 'dsh', signal, exclude: [COMPLETION_MARKER_FILENAME] })
    return true
  }
  signal?.throwIfAborted()
  onProgress({ phase: 'verifying-bundle', completed: 0, total: files.length })
  let sourceDshRoot = join(bundleRoot, 'dsh')
  let asar = null
  if (archive !== null) {
    const archivePath = join(bundleRoot, archive.path)
    if ((await fs.promises.stat(archivePath)).size !== archive.bytes || await hashFile(archivePath) !== archive.sha256) {
      throw releaseError('BUNDLE_HASH_MISMATCH')
    }
    const vendorRoot = join(bundleRoot, 'legion', 'vendor', 'archive')
    asar = loadArchiveApi?.() ?? createRequire(join(vendorRoot, 'package.json'))('@electron/asar')
    const actualAsar = JSON.parse(await readFile(join(vendorRoot, 'node_modules', '@electron', 'asar', 'package.json'), 'utf8'))
    if (manifest.versions.asar !== actualAsar.version) throw releaseError('BUNDLE_ARCHIVE_VERSION_MISMATCH')
    sourceDshRoot = null
  } else {
    await verifyInventory(sourceDshRoot, files, { prefix: 'dsh', signal,
      onProgress(completed) { if (completed % 100 === 0 || completed === files.length) onProgress({ phase: 'verifying-bundle', completed, total: files.length }) } })
  }
  markPhase('verifyBundle')
  const verifyDshVersion = async root => {
    const actualPackage = await json(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    const lock = await json(join(root, 'package-lock.json'))
    if (actualPackage?.name !== '@deepseek-ai/dsh' || actualPackage.version !== release.dshVersion
      || lock?.lockfileVersion !== 3 || lock.packages?.['node_modules/@deepseek-ai/dsh']?.version !== release.dshVersion
      || Object.entries(lock.packages ?? {}).some(([path, pkg]) => /(^|\/)node_modules\/@deepseek-ai\/dsh(?:-[^/]+)?$/.test(path)
        && pkg.version !== release.dshVersion)) throw releaseError('BUNDLE_VERSION_MISMATCH')
  }
  if (archive === null) await verifyDshVersion(join(bundleRoot, 'dsh'))
  await checked(paths.versionsDir)
  await mkdir(paths.versionsDir, { recursive: true })
  await checked(paths.versionDir)
  let reused = await checkTarget()
  let staging = null
  if (!reused) {
    // Preserve an incomplete pre-existing target for explicit recovery instead of deleting it.
    if (fs.existsSync(paths.versionDir)) throw releaseError('BUNDLE_TARGET_INCOMPLETE')
    staging = join(paths.versionsDir, `.staging-${release.dshVersion}-${randomUUID()}`)
    await checked(staging); await mkdir(staging)
    try {
      onProgress({ phase: 'importing-runtime', completed: 0, total: files.length })
      if (archive !== null) {
        await extractPayloadArchive({ archivePath: join(bundleRoot, archive.path), destination: staging,
          vendorRoot: join(bundleRoot, 'legion', 'vendor', 'archive'), signal, extractArchive })
      } else await copyPayloadTree(sourceDshRoot, staging, { signal, platform })
      signal?.throwIfAborted()
      markPhase('copyRuntime')
      await verifyInventory(staging, files, { prefix: 'dsh', signal,
        onProgress(completed) { if (completed % 100 === 0 || completed === files.length) onProgress({ phase: 'verifying-runtime', completed, total: files.length }) } })
      if (archive !== null) await verifyDshVersion(staging)
      markPhase('verifyImportedRuntime')
      signal?.throwIfAborted()
      const marker = { version: release.dshVersion, packageName: '@deepseek-ai/dsh',
        dshCompositionPatchVersion: release.dshCompositionPatchVersion, legionRoute: 'bundled',
        legionPackages: [], payloadDigest: digest, installedAtMs: Date.now(), installerVersion: 1 }
      await writeFile(join(staging, COMPLETION_MARKER_FILENAME), `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx' })
      signal?.throwIfAborted()
      await checked(paths.versionDir)
      await rename(staging, paths.versionDir)
      staging = null
    } finally {
      if (staging !== null) { await checked(staging); await rm(staging, { recursive: true, force: true }) }
    }
  }
  signal?.throwIfAborted()
  // Product-owned profile: fixed web bundles, reconfigured on controlled restart.
  // The pinned DSH's live patch watcher requires a dynamically mounted HMR
  // service; it can announce a URL before that mount fails. No live watcher is
  // needed for the managed desktop profile.
  const profileDir = join(dataDir, 'runtime', 'dsh', 'home', 'profiles', 'legion-desktop')
  await checked(profileDir); await mkdir(profileDir, { recursive: true })
  const profilePath = join(profileDir, 'package.json')
  await checked(profilePath)
  const profile = await json(profilePath)
  const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
  if (profile === null) {
    await atomicJson(profilePath, { name: 'dsh-profile-legion-desktop', private: true, dependencies: {},
      dsh: { profile: { bundles, patchReload: 'startup' } } })
  } else if (profile.dsh?.profile?.patchReload !== 'startup'
    || JSON.stringify(profile.dsh.profile.bundles) !== JSON.stringify(bundles)) throw releaseError('BUNDLE_PROFILE_MISMATCH')
  const rootConfig = join(profileDir, 'cordis.yml')
  await checked(rootConfig)
  try { await writeFile(rootConfig, '[]\n', { flag: 'wx' }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  signal?.throwIfAborted()
  await checked(paths.pointerPath)
  const previous = await json(paths.pointerPath)
  if (previous?.version === release.dshVersion && previous.dir === paths.versionDir && previous.entry === paths.entryPath) {
    return { ok: true, reused, version: release.dshVersion }
  }
  if (previous !== null) await atomicJson(paths.previousPointerPath, previous)
  signal?.throwIfAborted()
  const pointer = { version: release.dshVersion, dir: paths.versionDir, entry: paths.entryPath,
    packageName: '@deepseek-ai/dsh', dshCompositionPatchVersion: release.dshCompositionPatchVersion, switchedAtMs: Date.now() }
  await atomicJson(paths.pointerPath, pointer)
  onProgress({ phase: 'runtime-prepared', completed: files.length, total: files.length })
  timingsMs.prepareTotal = Math.round(performance.now() - startedAt)
  return { ok: true, reused, version: release.dshVersion, timingsMs }
}
