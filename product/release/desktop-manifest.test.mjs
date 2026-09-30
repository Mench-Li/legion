import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DESKTOP_COMPONENTS, DESKTOP_MANIFEST_FORMAT, inventoryTree, validateDesktopManifest, verifyInventory } from './desktop-manifest.mjs'

const release = Object.fromEntries(DESKTOP_COMPONENTS.map(key => [key, key.endsWith('Version') && ['productVersion', 'legionVersion', 'dshVersion'].includes(key) ? '0.1.0' : 1]))
const spec = () => ({ format: DESKTOP_MANIFEST_FORMAT, platform: 'win32', arch: 'x64', bridgeProtocol: 1,
  versions: { ...release, node: '24.19.0' }, files: [{ path: 'dsh/package.json', bytes: 2, sha256: 'a'.repeat(64) }] })
const options = { release, platform: 'win32', arch: 'x64', nodeVersion: '24.19.0' }

test('release binds platform, all product/patch versions and exact Node', () => {
  assert.equal(validateDesktopManifest(spec(), options).bridgeProtocol, 1)
  for (const key of DESKTOP_COMPONENTS) {
    const bad = spec(); bad.versions[key] = 'unexpected'
    assert.throws(() => validateDesktopManifest(bad, options), { code: 'BUNDLE_VERSION_MISMATCH' })
  }
  assert.throws(() => validateDesktopManifest({ ...spec(), arch: 'arm64' }, options), { code: 'BUNDLE_PLATFORM_MISMATCH' })
  const wrongNode = spec(); wrongNode.versions.node = '22.0.0'
  assert.throws(() => validateDesktopManifest(wrongNode, options), { code: 'BUNDLE_NODE_MISMATCH' })
})

test('inventory rejects traversal, case aliases, injected completion markers and invalid hashes', () => {
  for (const path of ['dsh/../../evil', 'dsh/C:evil', 'dsh/a\\b', 'dsh//b', 'dsh/file.', 'dsh/install-complete.json']) {
    const bad = spec(); bad.files[0].path = path
    assert.throws(() => validateDesktopManifest(bad, options), { code: 'BUNDLE_INVENTORY_INVALID' })
  }
  const bad = spec(); bad.files.push({ ...bad.files[0], path: 'dsh/PACKAGE.json' })
  assert.throws(() => validateDesktopManifest(bad, options), { code: 'BUNDLE_INVENTORY_INVALID' })
})

test('real tree verification rejects changed bytes, extra files and escaping junctions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legion-bundle-'))
  try {
    const source = join(root, 'source'); await mkdir(source)
    await writeFile(join(source, 'package.json'), '{}')
    const files = await inventoryTree(source, 'dsh')
    await verifyInventory(source, files, { prefix: 'dsh' })
    await writeFile(join(source, 'package.json'), '[]')
    await assert.rejects(verifyInventory(source, files, { prefix: 'dsh' }), { code: 'BUNDLE_HASH_MISMATCH' })
    await writeFile(join(source, 'package.json'), '{}')
    await writeFile(join(source, 'extra'), 'x')
    await assert.rejects(verifyInventory(source, files, { prefix: 'dsh' }), { code: 'BUNDLE_HASH_MISMATCH' })
    await symlink(root, join(source, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(inventoryTree(source), { code: 'BUNDLE_LINK_REJECTED' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
