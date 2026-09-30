import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const DESKTOP_MANIFEST_FORMAT = 'legion/desktop-release@1'
export const DESKTOP_COMPONENTS = Object.freeze(['productVersion', 'legionVersion', 'dshVersion',
  'dshCompositionPatchVersion', 'runtimeContractVersion', 'packProtocolVersion', 'schemaVersion'])
export function releaseError(code) { return Object.assign(new Error(code), { code }) }

export function validateDesktopManifest(manifest, {
  release, nodeVersion, platform = process.platform, arch = process.arch,
} = {}) {
  if (manifest?.format !== DESKTOP_MANIFEST_FORMAT || manifest.bridgeProtocol !== 1) throw releaseError('BUNDLE_FORMAT_INVALID')
  if (manifest.platform !== platform || manifest.arch !== arch) throw releaseError('BUNDLE_PLATFORM_MISMATCH')
  for (const key of DESKTOP_COMPONENTS) {
    if (release?.[key] === undefined || manifest.versions?.[key] !== release[key]) throw releaseError('BUNDLE_VERSION_MISMATCH')
  }
  if (!/^\d+\.\d+\.\d+$/.test(manifest.versions.node ?? '') || (nodeVersion && manifest.versions.node !== nodeVersion)) {
    throw releaseError('BUNDLE_NODE_MISMATCH')
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw releaseError('BUNDLE_INVENTORY_INVALID')
  const names = new Set()
  for (const item of manifest.files) {
    // No drive, ADS, traversal, empty segments, reserved completion marker or case aliases.
    const parts = typeof item.path === 'string' ? item.path.split('/') : []
    if (parts.length < 2 || !['node', 'legion', 'dsh', 'git'].includes(parts[0])
      || parts.some(p => !p || p === '.' || p === '..' || /[\\:\x00-\x1f]/.test(p) || /[. ]$/.test(p)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p))
      || parts.includes('install-complete.json') || names.has(item.path.toLowerCase())
      || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.bytes) || item.bytes < 0) {
      throw releaseError('BUNDLE_INVENTORY_INVALID')
    }
    names.add(item.path.toLowerCase())
  }
  return manifest
}

export async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export async function inventoryTree(root, prefix = '', { signal, onProgress = () => {}, exclude = [] } = {}) {
  const files = []
  async function walk(relative) {
    signal?.throwIfAborted()
    const path = join(root, relative)
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) throw releaseError('BUNDLE_LINK_REJECTED')
    if (exclude.includes(relative)) return
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await walk(relative ? `${relative}/${name}` : name)
    } else if (stat.isFile()) {
      const entry = { path: prefix ? `${prefix}/${relative}` : relative, bytes: stat.size, sha256: await hashFile(path) }
      files.push(entry)
      onProgress(files.length)
    } else throw releaseError('BUNDLE_FILE_INVALID')
  }
  await walk('')
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

export async function verifyInventory(root, files, { prefix = '', signal, onProgress, exclude } = {}) {
  const actual = await inventoryTree(root, prefix, { signal, onProgress, exclude })
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path))
  if (actual.length !== sorted.length || actual.some((item, index) => {
    const expected = sorted[index]
    return item.path !== expected.path || item.bytes !== expected.bytes || item.sha256 !== expected.sha256
  })) throw releaseError('BUNDLE_HASH_MISMATCH')
}

export async function readDesktopManifest(path, options) {
  let manifest
  try { manifest = JSON.parse(await readFile(path, 'utf8')) } catch { throw releaseError('BUNDLE_MANIFEST_UNREADABLE') }
  return validateDesktopManifest(manifest, options)
}
