// Called only by the Launcher while holding its DataDir ownership lock.
// No executable dependency resolution, network access or npm fallback occurs here.
import * as fs from 'node:fs'
import { copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, relative, resolve } from 'node:path'
import { createRuntimeWriteGuard, runtimePathsOf, COMPLETION_MARKER_FILENAME } from './runtime-install.mjs'
import { readDesktopManifest, releaseError, verifyInventory } from '../release/desktop-manifest.mjs'

async function json(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw releaseError('BUNDLE_STATE_UNREADABLE')
  }
}

export async function importBundledRuntime({ bundleRoot, dataDir, installDir, release,
  nodeVersion = process.versions.node, platform = process.platform, arch = process.arch,
  signal, onProgress = () => {},
}) {
  const manifest = await readDesktopManifest(join(bundleRoot, 'desktop-release.json'), { release, nodeVersion, platform, arch })
  const files = manifest.files.filter(item => item.path.startsWith('dsh/'))
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
  const checkTarget = async () => {
    const marker = await json(paths.markerPath)
    if (marker === null) return false
    if (marker.version !== release.dshVersion || marker.dshCompositionPatchVersion !== release.dshCompositionPatchVersion
      || marker.payloadDigest !== digest) throw releaseError('BUNDLE_EXISTING_VERSION_MISMATCH')
    await verifyInventory(paths.versionDir, files, { prefix: 'dsh', signal, exclude: [COMPLETION_MARKER_FILENAME] })
    return true
  }
  signal?.throwIfAborted()
  onProgress({ phase: 'verifying-bundle', completed: 0, total: files.length })
  await verifyInventory(join(bundleRoot, 'dsh'), files, { prefix: 'dsh', signal })
  await checked(paths.versionsDir)
  await mkdir(paths.versionsDir, { recursive: true })
  let reused = await checkTarget()
  let staging = null
  if (!reused) {
    // Preserve an incomplete pre-existing target for explicit recovery instead of deleting it.
    if (fs.existsSync(paths.versionDir)) throw releaseError('BUNDLE_TARGET_INCOMPLETE')
    staging = join(paths.versionsDir, `.staging-${release.dshVersion}-${randomUUID()}`)
    await checked(staging); await mkdir(staging)
    try {
      for (let index = 0; index < files.length; index++) {
        signal?.throwIfAborted()
        const file = files[index]
        const dest = join(staging, ...file.path.slice(4).split('/'))
        await checked(dest)
        await mkdir(dirname(dest), { recursive: true })
        await copyFile(join(bundleRoot, ...file.path.split('/')), dest)
        if (index % 100 === 0 || index === files.length - 1) {
          onProgress({ phase: 'importing-runtime', completed: index + 1, total: files.length })
        }
      }
      await verifyInventory(staging, files, { prefix: 'dsh', signal })
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
  return { ok: true, reused, version: release.dshVersion }
}
