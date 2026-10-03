// Build tool only. Never included in the installed application.
import { access, mkdir, readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPath7za } from 'app-builder-lib/out/toolsets/7zip.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const exec = promisify(execFile)
export async function prepareNsisResources() {
  const spec = JSON.parse(await readFile(join(root, 'desktop', 'payload', 'nsis-resources.json'), 'utf8'))
  const build = join(root, '.desktop-build')
  await mkdir(build, { recursive: true })
  const archive = join(build, spec.filename)
  let bytes
  try { bytes = await readFile(archive) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!bytes) {
    await exec('curl.exe', ['--silent', '--show-error', '--fail', '--location', '--retry', '2',
      '--connect-timeout', '20', '--max-time', '900', '--header', 'Accept: application/octet-stream',
      '--output', archive, spec.url], { windowsHide: true, timeout: 950_000 })
    bytes = await readFile(archive)
  }
  if (createHash('sha256').update(bytes).digest('hex') !== spec.sha256) throw new Error('NSIS resources checksum mismatch')
  // A fresh directory avoids trusting previously extracted or partial tool files.
  const destination = join(build, `nsis-resources-${spec.version}-${randomUUID()}`)
  await mkdir(destination)
  await exec(await getPath7za(), ['x', '-y', `-o${destination}`, archive], { windowsHide: true, timeout: 60_000 })
  await access(join(destination, 'plugins'))
  return destination
}
