import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import asar from '@electron/asar'
import { verifyInventory } from '../../product/release/desktop-manifest.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const stage = JSON.parse(await readFile(join(root, '.desktop-build', 'current-stage.json'), 'utf8'))
const bundleRoot = resolve(process.argv[2] ?? stage.resources)
const descriptor = JSON.parse(await readFile(join(bundleRoot, 'desktop-release.json'), 'utf8'))
const files = descriptor.files.filter(file => file.path.startsWith('dsh/'))
const scratch = await mkdtemp(join(tmpdir(), 'legion-asar-benchmark-'))
const archive = join(scratch, 'dsh.asar')
const extracted = join(scratch, 'extracted')
try {
  const started = performance.now()
  let phase = performance.now()
  await asar.createPackage(join(bundleRoot, 'dsh'), archive)
  const packMs = Math.round(performance.now() - phase)
  phase = performance.now()
  asar.extractAll(archive, extracted)
  const extractMs = Math.round(performance.now() - phase)
  phase = performance.now()
  await verifyInventory(extracted, files, { prefix: 'dsh' })
  const verifyMs = Math.round(performance.now() - phase)
  console.log(JSON.stringify({
    archiveBytes: (await stat(archive)).size,
    dshFileCount: files.length,
    dshBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    packMs,
    extractMs,
    verifyMs,
    totalMs: Math.round(performance.now() - started),
  }, null, 2))
} finally {
  await rm(scratch, { recursive: true, force: true })
}
