// Build-time dependency resolution only. Installed applications never invoke npm.
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const root = fileURLToPath(new URL('../../', import.meta.url))
const inputs = join(root, 'desktop', 'payload')
export const isDshPackage = name => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')

export async function pinnedFamily(version, metadata) {
  const overrides = {}
  const queue = ['@deepseek-ai/dsh']
  while (queue.length) {
    const name = queue.shift()
    if (overrides[name]) continue
    const pkg = await metadata(name, version)
    if (pkg.name !== name || pkg.version !== version) throw new Error(`Unqualified DSH package: ${name}`)
    overrides[name] = version
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })) {
      if (isDshPackage(dep) && !overrides[dep]) queue.push(dep)
    }
  }
  return Object.fromEntries(Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b)))
}

function runNpm(args, cwd) {
  // Invoke npm's JS entry with Node; no cmd shell or platform-specific shim.
  const npm = resolve(process.execPath, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [npm, ...args, '--cache', join(root, '.desktop-build', 'npm-cache')], { cwd, stdio: 'inherit', windowsHide: true })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`npm failed (${code})`)))
  })
}

async function main() {
  const manifest = JSON.parse(await readFile(join(root, 'product', 'release', 'runtime-manifest.json'), 'utf8'))
  const output = join(root, '.desktop-build', 'dsh')
  await mkdir(inputs, { recursive: true })
  await mkdir(output, { recursive: true })
  const regenerate = process.argv.includes('--resolve-lock')
  if (regenerate) {
    const overrides = await pinnedFamily(manifest.dshVersion, async (name, version) => {
      const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`, { signal: AbortSignal.timeout(60_000) })
      if (!response.ok) throw new Error(`Registry ${response.status}: ${name}@${version}`)
      return response.json()
    })
    const pkg = { name: 'legion-dsh-payload', version: manifest.productVersion, private: true,
      dependencies: { '@deepseek-ai/dsh': manifest.dshVersion },
      overrides: { ...overrides, '@deepseek-ai/cordis': '4.0.2', '@deepseek-ai/schemastery': '3.18.2' },
      // Reviewed build-time scripts: native prebuilds, ConPTY resource copies,
      // spawn-helper mode restoration and protobuf's version diagnostic.
      allowScripts: { [`@deepseek-ai/dsh-subprocess-local@${manifest.dshVersion}`]: true,
        'koffi@3.3.2': true, 'node-pty@1.2.0-beta.15': true, 'protobufjs@7.6.6': true,
        '@google/genai': false } }
    await writeFile(join(inputs, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
    await runNpm(['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], inputs)
  }
  const pkg = JSON.parse(await readFile(join(inputs, 'package.json'), 'utf8'))
  if (pkg.dependencies['@deepseek-ai/dsh'] !== manifest.dshVersion) throw new Error('Payload inputs do not match release')
  await copyFile(join(inputs, 'package.json'), join(output, 'package.json'))
  await copyFile(join(inputs, 'package-lock.json'), join(output, 'package-lock.json'))
  await runNpm(['ci', '--omit=dev', '--strict-allow-scripts', '--no-audit', '--no-fund'], output)
  console.log(`DSH ${manifest.dshVersion} prepared at ${output}`)
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
