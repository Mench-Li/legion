import { readFile, mkdir, access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { hashFile, readDesktopManifest, verifyInventory } from '../../product/release/desktop-manifest.mjs'
const root = fileURLToPath(new URL('../../', import.meta.url))
const exec = promisify(execFile)
const { resources } = JSON.parse(await readFile(join(root, '.desktop-build', 'current-stage.json'), 'utf8'))
const release = JSON.parse(await readFile(join(resources, 'legion', 'product', 'release', 'runtime-manifest.json'), 'utf8'))
const nodeSpec = JSON.parse(await readFile(join(root, 'desktop', 'payload', 'node.json'), 'utf8'))
const descriptor = await readDesktopManifest(join(resources, 'desktop-release.json'), { release, nodeVersion: nodeSpec.version, platform: 'win32', arch: 'x64' })
const scratch = join(root, '.desktop-build', `closure-smoke-${Date.now()}`)
await mkdir(scratch, { recursive: true })
let dshRoot = join(resources, 'dsh')
const dshFiles = descriptor.files.filter(file => file.path.startsWith('dsh/'))
const dshArchive = descriptor.archives?.find(item => item.component === 'dsh')
if (dshArchive) {
  const archivePath = join(resources, dshArchive.path)
  const archiveStat = await import('node:fs/promises').then(fs => fs.stat(archivePath))
  if (archiveStat.size !== dshArchive.bytes || await hashFile(archivePath) !== dshArchive.sha256) throw new Error('DSH archive hash mismatch')
  dshRoot = join(scratch, 'dsh-from-archive')
  await exec(join(resources, 'node', 'node.exe'), [join(resources, 'legion', 'product', 'launcher', 'bundle-extract-worker.mjs'),
    archivePath, dshRoot, join(resources, 'legion', 'vendor', 'archive')], { cwd: scratch, windowsHide: true })
  await verifyInventory(dshRoot, dshFiles, { prefix: 'dsh' })
} else await verifyInventory(dshRoot, dshFiles, { prefix: 'dsh' })
for (const component of ['node', 'git', 'legion']) {
  await verifyInventory(join(resources, component), descriptor.files.filter(file => file.path.startsWith(`${component}/`)), { prefix: component })
}
for (const path of ['node/node.exe', 'node/node_modules/npm/bin/npm-cli.js', 'git/cmd/git.exe',
  'legion/workbench/dist/index.html', 'legion/product/launcher/desktop-bridge.mjs',
  'legion/runtime/dsh-composition/legion-host.patch.yml']) await access(join(resources, path))
for (const path of ['node_modules/@deepseek-ai/dsh/lib/bin.js', 'node_modules/node-pty/prebuilds/win32-x64/conpty.node',
  'node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll']) await access(join(dshRoot, path))

// Build-time AST parsing checks static relative imports without interpreting comments.
const requireBuild = createRequire(join(root, 'workbench', 'package.json'))
const ts = requireBuild('typescript')
const entrypoints = ['product/launcher/desktop-bridge.mjs', 'team-hub/server.mjs', 'workbench/scripts/serve.mjs',
  'orchestrator/worker/run.mjs', 'team-hub/approval-registrar-row.mjs']
const visited = new Set()
async function checkModule(path) {
  if (visited.has(path)) return
  visited.add(path)
  const source = await readFile(path, 'utf8')
  const syntax = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const imports = []
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text)
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(syntax) === 'require')
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text)
    ts.forEachChild(node, visit)
  }
  visit(syntax)
  for (const specifier of imports) {
    if (specifier.startsWith('node:')) continue
    if (specifier.startsWith('.')) {
      const target = resolve(dirname(path), specifier)
      const rel = relative(join(resources, 'legion'), target)
      if (rel.startsWith('..') || rel.includes(':')) throw new Error('Import escapes production tree')
      await access(target)
      if (/\.[cm]?js$/.test(target)) await checkModule(target)
    } else {
      createRequire(path).resolve(specifier) // No dependency search in the developer checkout.
    }
  }
}
for (const entry of entrypoints) await checkModule(join(resources, 'legion', entry))

const nodePath = join(resources, 'node', 'node.exe')
const env = { SystemRoot: process.env.SystemRoot, windir: process.env.windir, ComSpec: process.env.ComSpec,
  TEMP: scratch, TMP: scratch, USERPROFILE: scratch, HOME: scratch, DSH_HOME: join(scratch, 'dsh-home'),
  PATH: `${join(resources, 'node')};${join(resources, 'git', 'cmd')};${join(process.env.SystemRoot, 'System32')};${join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0')}` }
const version = await exec(nodePath, ['--version'], { cwd: scratch, env, windowsHide: true })
if (version.stdout.trim() !== `v${descriptor.versions.node}`) throw new Error('Bundled Node version mismatch')
const nativeScript = join(scratch, 'native.cjs')
await import('node:fs/promises').then(fs => fs.writeFile(nativeScript, `
const { createRequire } = require('node:module')
const r = createRequire(process.argv[2])
r('koffi'); r('sharp')
const dpapi = r(process.argv[3])
const protection = dpapi.probeDpapi()
if (!protection.available || dpapi.unprotectValue(dpapi.protectValue('Legion 测试 fixture', protection), protection) !== 'Legion 测试 fixture') process.exit(3)
const pty = r('node-pty')
const child = pty.spawn(process.env.ComSpec, ['/d','/c','echo LEGION_NATIVE_OK'], { cwd: process.cwd(), env: process.env })
let output = ''
child.onData(data => { output += data })
const timer = setTimeout(() => { child.kill(); process.exit(2) }, 10000)
child.onExit(({ exitCode }) => { clearTimeout(timer); process.exit(exitCode === 0 && output.includes('LEGION_NATIVE_OK') ? 0 : 1) })
`))
await exec(nodePath, [nativeScript, join(dshRoot, 'package.json'), join(resources, 'legion', 'security', 'secrets', 'dpapi.mjs')], { cwd: scratch, env, timeout: 30_000, windowsHide: true })
await exec(nodePath, [join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '--profile', 'web', '--dump-config'],
  { cwd: scratch, env, timeout: 20_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 })
const git = await exec(join(resources, 'git', 'cmd', 'git.exe'), ['--version'], { cwd: scratch, env, windowsHide: true })
console.log(JSON.stringify({ ok: true, checkedModules: visited.size, node: version.stdout.trim(), git: git.stdout.trim(), native: ['koffi', 'sharp', 'node-pty/ConPTY', 'Windows DPAPI'], profile: 'isolated web' }))
