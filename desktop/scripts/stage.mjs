import { cp, mkdir, readFile, writeFile, copyFile, lstat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inventoryTree, DESKTOP_MANIFEST_FORMAT, DESKTOP_COMPONENTS, validateDesktopManifest } from '../../product/release/desktop-manifest.mjs'
import { pruneWindowsX64Payload } from './platform-filter.mjs'

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
const resources = join(stage, 'resources')
const shell = join(stage, 'shell')
await mkdir(resources, { recursive: true })
await mkdir(shell, { recursive: true })
// The Node/DSH backend remains physical; only the Electron shell uses ASAR.
for (const [from, to] of [[`node-v${node.version}-win-x64`, 'node'], ['dsh', 'dsh'], ['git', 'git']]) {
  const source = join(build, from)
  console.log(`Checking ${to} payload`)
  await inventoryTree(source) // Reject every junction/symlink before copying.
  console.log(`Staging ${to} payload`)
  await copyTree(source, join(resources, to))
}
await pruneWindowsX64Payload(join(resources, 'dsh'))
const { stdout } = await exec('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
const untracked = await exec('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
const productionRoots = new Set(['product', 'team-hub', 'runtime', 'orchestrator', 'security', 'mesh', 'scrum', 'whiteboard', 'skills', 'instructions', 'plugins', 'packages'])
const paths = [...new Set(`${stdout}${untracked.stdout}`.split('\0').filter(Boolean))]
for (const path of paths) {
  const production = productionRoots.has(path.split('/')[0]) || path.startsWith('workbench/scripts/') || /^roles[^/]*\.json$/.test(path)
  if (!production || /(^|\/)(tests?|__tests__|node_modules|archive|fixtures?|probes)(\/|$)/.test(path) || /\.(test|spec)\.[cm]?[jt]s$/.test(path)) continue
  // Legacy task/daemon snapshots belong to a user's data, never an installation.
  if (path.startsWith('scrum/') && !/\.(mjs|sql|html|css)$/.test(path)) continue
  if ((await lstat(join(root, path))).isSymbolicLink()) throw new Error(`Production link rejected: ${path}`)
  const target = join(resources, 'legion', ...path.split('/'))
  await mkdir(dirname(target), { recursive: true })
  await copyFile(join(root, path), target)
}
await copyTree(join(root, 'workbench', 'dist'), join(resources, 'legion', 'workbench', 'dist'))
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
const files = []
for (const component of ['node', 'dsh', 'git', 'legion']) files.push(...await inventoryTree(join(resources, component), component))
const descriptor = { format: DESKTOP_MANIFEST_FORMAT, platform: 'win32', arch: 'x64', bridgeProtocol: 1, versions, files }
validateDesktopManifest(descriptor, { release, nodeVersion: node.version, platform: 'win32', arch: 'x64' })
await writeFile(join(resources, 'desktop-release.json'), `${JSON.stringify(descriptor, null, 2)}\n`)
await writeFile(join(build, 'current-stage.json'), `${JSON.stringify({ stage, resources, shell }, null, 2)}\n`)
console.log(JSON.stringify({ stage, files: files.length, payloadBytes: files.reduce((total, file) => total + file.bytes, 0) }))
