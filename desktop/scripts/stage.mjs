import { cp, mkdir, readFile, writeFile, copyFile, lstat, rm, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import asar from '@electron/asar'
import { inventoryTree, hashFile, DESKTOP_MANIFEST_FORMAT, DESKTOP_COMPONENTS, validateDesktopManifest } from '../../product/release/desktop-manifest.mjs'
import { validateWorkflowPack } from '../../product/workflow-packs/pack.mjs'
import { createSoftwareCollaborationPack } from './software-collaboration-pack.mjs'
import { pruneWindowsX64Payload } from './platform-filter.mjs'
import { isShippablePayloadFile } from './payload-filter.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const build = join(root, '.desktop-build')
const exec = promisify(execFile)
async function copyTree(source, destination) {
  if (process.platform !== 'win32') return cp(source, destination, { recursive: true, dereference: false })
  // Windows metadata copies through fs.cp can stall on large npm trees.
  // robocopy handles the physical payload with bounded parallelism and no retry loop.
  await mkdir(destination, { recursive: true })
  try {
    await exec('robocopy.exe', [source, destination, '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:0', '/W:0', '/MT:8',
      '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { windowsHide: true, timeout: 180_000, maxBuffer: 1024 * 1024 })
  } catch (error) { if (!Number.isInteger(error.code) || error.code >= 8) throw error }
}
const release = JSON.parse(await readFile(join(root, 'product', 'release', 'runtime-manifest.json'), 'utf8'))
const node = JSON.parse(await readFile(join(root, 'desktop', 'payload', 'node.json'), 'utf8'))
const git = JSON.parse(await readFile(join(root, 'desktop', 'payload', 'git.json'), 'utf8'))
const desktop = JSON.parse(await readFile(join(root, 'desktop', 'package.json'), 'utf8'))
const stage = join(build, `stage-${Date.now()}`)
const stageStartedAt = performance.now()
const componentTimings = {}
const resources = join(stage, 'resources')
const shell = join(stage, 'shell')
await mkdir(resources, { recursive: true })
await mkdir(shell, { recursive: true })
// The Electron shell and immutable DSH dependency payload are archives. Native
// DSH resources are ordinary data inside dsh.asar and are materialized only in
// the verified, DataDir-owned runtime at first launch.
for (const [from, to] of [[`node-v${node.version}-win-x64`, 'node'], ['dsh', 'dsh'], ['git', 'git']]) {
  const source = join(build, from)
  const componentStartedAt = performance.now()
  console.log(`Checking ${to} payload`)
  await inventoryTree(source) // Reject every junction/symlink before copying.
  console.log(`Staging ${to} payload`)
  await copyTree(source, join(resources, to))
  componentTimings[to] = Math.round(performance.now() - componentStartedAt)
}
await pruneWindowsX64Payload(join(resources, 'dsh'))
const dshFiles = await inventoryTree(join(resources, 'dsh'), 'dsh')

const { stdout } = await exec('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
const untracked = await exec('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
const productionRoots = new Set(['product', 'team-hub', 'runtime', 'orchestrator', 'security', 'mesh', 'scrum', 'whiteboard', 'skills', 'instructions', 'plugins', 'packages'])
const paths = [...new Set(`${stdout}${untracked.stdout}`.split('\0').filter(Boolean))]
for (const path of paths) {
  const production = productionRoots.has(path.split('/')[0]) || path.startsWith('workbench/scripts/') || /^roles[^/]*\.json$/.test(path)
  if (!production || /(^|\/)(tests?|__tests__|node_modules|archive|fixtures?|probes)(\/|$)/.test(path) || /\.(test|spec)\.[cm]?[jt]s$/.test(path)) continue
  // Legacy task/daemon snapshots belong to a user's data, never an installation.
  if (path.startsWith('scrum/') && !/\.(mjs|sql|html|css)$/.test(path)) continue
  // ★ 数据库与备份**永远不进包**。这一段清单是 `git ls-files` **加上未跟踪文件**，
  //   而"未跟踪"只等于"`.gitignore` 没盖住"——那不是"它该发给用户"。
  //   实测（2026-10-07）：三个 33.9 MB 的 `team-hub/team.db.bak-*` 差点被打进
  //   给所有人下载的安装包。判据抽在 `payload-filter.mjs`，那里有完整的来龙去脉。
  if (!isShippablePayloadFile(path)) {
    console.log(`  Skipping non-shippable file: ${path}`)
    continue
  }
  if ((await lstat(join(root, path))).isSymbolicLink()) throw new Error(`Production link rejected: ${path}`)
  const target = join(resources, 'legion', ...path.split('/'))
  await mkdir(dirname(target), { recursive: true })
  await copyFile(join(root, path), target)
}
await copyTree(join(root, 'workbench', 'dist'), join(resources, 'legion', 'workbench', 'dist'))

// The generic software workflow is a first-party declarative package, not a
// workspace snapshot. Its source is explicit and versioned; local/user data
// such as roles-ozon.json and .legion are never included.
const softwarePack = createSoftwareCollaborationPack({
  rolesDefinition: JSON.parse(await readFile(join(root, 'roles.json'), 'utf8')),
  soldierPrompt: await readFile(join(root, 'workflows', 'soldier-prompt.md'), 'utf8'),
})
const validatedSoftwarePack = validateWorkflowPack(softwarePack)
const packDir = join(resources, 'legion', 'workflow-packs')
await mkdir(packDir, { recursive: true })
await writeFile(join(packDir, 'software-collaboration.legionpack'), `${JSON.stringify(validatedSoftwarePack.pack, null, 2)}\n`)

// Runtime extraction needs only @electron/asar's library closure. Stage exact
// installed packages beside Legion so the private Node can expand dsh.asar
// without downloading a helper or resolving anything from the developer tree.
const vendorRoot = join(resources, 'legion', 'vendor', 'archive', 'node_modules')
await mkdir(vendorRoot, { recursive: true })
const desktopModules = join(root, 'desktop', 'node_modules')
const archivePackages = [
  ['@electron/asar', join(desktopModules, '@electron', 'asar')],
  ['glob', join(desktopModules, 'glob')],
  ['minimatch', join(desktopModules, '@electron', 'asar', 'node_modules', 'minimatch')],
  ...['fs.realpath', 'inflight', 'inherits', 'once', 'path-is-absolute', 'wrappy', 'concat-map']
    .map(name => [name, join(desktopModules, name)]),
]
for (const [name, source] of archivePackages) {
  await inventoryTree(source)
  const target = join(vendorRoot, ...name.split('/'))
  await mkdir(dirname(target), { recursive: true })
  await copyTree(source, target)
}
await writeFile(join(resources, 'legion', 'vendor', 'archive', 'package.json'),
  `${JSON.stringify({ name: 'legion-archive-runtime', private: true, type: 'commonjs' }, null, 2)}\n`)

const archivePath = join(resources, 'dsh.asar')
const archiveStartedAt = performance.now()
await asar.createPackage(join(resources, 'dsh'), archivePath)
const dshArchive = { component: 'dsh', path: 'dsh.asar', bytes: (await stat(archivePath)).size, sha256: await hashFile(archivePath) }
const archiveBuildMs = Math.round(performance.now() - archiveStartedAt)
await rm(join(resources, 'dsh'), { recursive: true, force: true })

await mkdir(join(shell, 'desktop'), { recursive: true })
for (const file of ['main.mjs', 'runtime.mjs', 'preload.cjs', 'startup.html', 'startup.mjs', 'messages.mjs', 'assets']) {
  if (file === 'assets') await copyTree(join(root, 'desktop', file), join(shell, 'desktop', file))
  else await copyFile(join(root, 'desktop', file), join(shell, 'desktop', file))
}
await mkdir(join(shell, 'product', 'launcher'), { recursive: true })
await copyFile(join(root, 'product', 'launcher', 'desktop-protocol.mjs'), join(shell, 'product', 'launcher', 'desktop-protocol.mjs'))
await writeFile(join(shell, 'package.json'), `${JSON.stringify({ name: desktop.name, version: desktop.version,
  private: true, type: 'module', main: 'desktop/main.mjs' }, null, 2)}\n`)
const npm = JSON.parse(await readFile(join(resources, 'node', 'node_modules', 'npm', 'package.json'), 'utf8')).version
const versions = Object.fromEntries(DESKTOP_COMPONENTS.map(key => [key, release[key]]))
Object.assign(versions, { node: node.version, npm, electron: desktop.devDependencies.electron, git: git.version })
versions.asar = JSON.parse(await readFile(join(desktopModules, '@electron', 'asar', 'package.json'), 'utf8')).version
const files = [...dshFiles]
for (const component of ['node', 'git', 'legion']) files.push(...await inventoryTree(join(resources, component), component))
const descriptor = { format: DESKTOP_MANIFEST_FORMAT, platform: 'win32', arch: 'x64', bridgeProtocol: 1,
  versions, archives: [dshArchive], files }
validateDesktopManifest(descriptor, { release, nodeVersion: node.version, platform: 'win32', arch: 'x64' })
await writeFile(join(resources, 'desktop-release.json'), `${JSON.stringify(descriptor, null, 2)}\n`)
await writeFile(join(build, 'current-stage.json'), `${JSON.stringify({ stage, resources, shell }, null, 2)}\n`)
const manifestPayloadBytes = files.reduce((total, file) => total + file.bytes, 0)
const dshLogicalBytes = dshFiles.reduce((total, file) => total + file.bytes, 0)
console.log(JSON.stringify({ stage, manifestFileCount: files.length, manifestPayloadBytes,
  physicalPayloadFileCount: files.length - dshFiles.length + 1,
  physicalPayloadBytes: manifestPayloadBytes - dshLogicalBytes + dshArchive.bytes,
  dshArchiveBytes: dshArchive.bytes, componentTimingsMs: componentTimings,
  dshArchiveBuildMs: archiveBuildMs, stageTotalMs: Math.round(performance.now() - stageStartedAt) }))
