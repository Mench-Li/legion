import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { importBundledRuntime } from '../../product/launcher/bundled-runtime.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const stage = JSON.parse(await readFile(join(root, '.desktop-build', 'current-stage.json'), 'utf8'))
const bundleRoot = resolve(process.argv[2] ?? stage.resources)
const release = JSON.parse(await readFile(join(root, 'product', 'release', 'runtime-manifest.json'), 'utf8'))
const manifest = JSON.parse(await readFile(join(bundleRoot, 'desktop-release.json'), 'utf8'))
const temporaryRoot = await mkdtemp(join(tmpdir(), 'legion-import-benchmark-'))
try {
  const started = performance.now()
  const result = await importBundledRuntime({ bundleRoot, dataDir: join(temporaryRoot, 'data'),
    installDir: bundleRoot, release })
  console.log(JSON.stringify({
    bundleRoot,
    dshFileCount: manifest.files.filter(file => file.path.startsWith('dsh/')).length,
    dshBytes: manifest.files.filter(file => file.path.startsWith('dsh/')).reduce((sum, file) => sum + file.bytes, 0),
    totalMs: Math.round(performance.now() - started),
    phaseMs: result.timingsMs,
    ok: result.ok,
    reused: result.reused,
  }, null, 2))
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
