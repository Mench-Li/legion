import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../', import.meta.url))
const spec = JSON.parse(await readFile(join(root, 'desktop', 'payload', 'git.json'), 'utf8'))
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 builder required')
const build = join(root, '.desktop-build')
const dest = join(build, 'git')
await mkdir(dest, { recursive: true })
const archive = join(build, spec.filename)
let bytes
try { bytes = await readFile(archive) } catch { /* cold cache */ }
if (!bytes || createHash('sha256').update(bytes).digest('hex') !== spec.sha256) {
  // Build-time Windows downloader supports resume on a slow release-asset link.
  // No download code is copied into the installed Electron shell or Launcher.
  await new Promise((resolve, reject) => {
    const child = spawn('curl.exe', ['--silent', '--show-error', '-L', '--fail', '--retry', '2', '--continue-at', '-',
      '--connect-timeout', '20', '--max-time', '1800', '--output', archive, spec.url], { stdio: 'inherit', windowsHide: true })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Git archive download failed (${code})`)))
  })
  bytes = await readFile(archive)
}
if (createHash('sha256').update(bytes).digest('hex') !== spec.sha256) throw new Error('Git checksum mismatch')
await writeFile(archive, bytes)
const script = join(build, 'expand-git.ps1')
await writeFile(script, 'param([string]$Archive, [string]$Destination)\nExpand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force\n')
await new Promise((resolve, reject) => {
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, archive, dest], { stdio: 'inherit', windowsHide: true })
  child.once('error', reject)
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Git extraction failed (${code})`)))
})
console.log(`Verified bundled Git ${spec.version} prepared`)
