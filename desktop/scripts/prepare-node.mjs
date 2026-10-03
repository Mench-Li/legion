import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../../', import.meta.url))
const version = '24.19.0'
const filename = `node-v${version}-win-x64.zip`
const origin = `https://nodejs.org/dist/v${version}/`
const input = join(root, 'desktop', 'payload', 'node.json')
const build = join(root, '.desktop-build')

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) })
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 builder required')
  await mkdir(build, { recursive: true })
  if (process.argv.includes('--resolve-checksum')) {
    const sums = (await download(`${origin}SHASUMS256.txt`)).toString('utf8')
    const sha256 = sums.split(/\r?\n/).find(line => line.endsWith(`  ${filename}`))?.split(' ')[0]
    if (!/^[a-f0-9]{64}$/.test(sha256 ?? '')) throw new Error('Node archive checksum missing')
    await writeFile(input, `${JSON.stringify({ version, platform: 'win32', arch: 'x64', filename, sha256, url: origin + filename }, null, 2)}\n`)
  }
  const spec = JSON.parse(await readFile(input, 'utf8'))
  if (spec.version !== version || spec.filename !== filename || spec.url !== origin + filename) throw new Error('Node input mismatch')
  const zip = join(build, filename)
  let bytes
  try { bytes = await readFile(zip) } catch { bytes = await download(spec.url) }
  if (createHash('sha256').update(bytes).digest('hex') !== spec.sha256) throw new Error('Node archive checksum mismatch')
  await writeFile(zip, bytes)
  // Script and paths travel as arguments; the command contains no interpolated source.
  const script = join(build, 'expand-node.ps1')
  await writeFile(script, 'param([string]$Archive, [string]$Destination)\nExpand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force\n')
  await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, zip, build], { stdio: 'inherit', windowsHide: true })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Archive extraction failed (${code})`)))
  })
  await copyFile(input, join(build, `node-v${version}-win-x64`, 'legion-node.json'))
  console.log(`Verified bundled Node ${version} prepared`)
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
