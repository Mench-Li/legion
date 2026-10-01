import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pruneWindowsX64Payload } from './platform-filter.mjs'

test('Windows x64 staging removes unused architecture binaries and debug metadata, retaining runtime code and licenses', async t => {
  const root = await mkdtemp(join(tmpdir(), 'legion-x64-payload-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const x64 = join(root, 'node_modules/node-pty/prebuilds/win32-x64/conpty.node')
  const arm = join(root, 'node_modules/node-pty/prebuilds/win32-arm64/conpty/conpty.dll')
  const other = join(root, 'node_modules/node-pty/third_party/conpty/1.25.260303002/win10-arm64/OpenConsole.exe')
  const map = join(root, 'node_modules/example/dist/index.js.map')
  const declaration = join(root, 'node_modules/example/dist/index.d.ts')
  const code = join(root, 'node_modules/example/dist/index.js')
  const license = join(root, 'node_modules/example/LICENSE')
  await mkdir(join(root, 'node_modules/node-pty/prebuilds/win32-x64'), { recursive: true })
  await mkdir(join(root, 'node_modules/node-pty/prebuilds/win32-arm64/conpty'), { recursive: true })
  await mkdir(join(root, 'node_modules/node-pty/third_party/conpty/1.25.260303002/win10-arm64'), { recursive: true })
  await mkdir(join(root, 'node_modules/example/dist'), { recursive: true })
  await writeFile(x64, 'x64')
  await writeFile(arm, 'arm64')
  await writeFile(other, 'arm64')
  await writeFile(map, '{}')
  await writeFile(declaration, 'export declare const ok: boolean')
  await writeFile(code, 'exports.ok = true')
  await writeFile(license, 'MIT')

  await pruneWindowsX64Payload(root)

  assert.equal(await readFile(x64, 'utf8'), 'x64')
  await assert.rejects(readFile(arm), { code: 'ENOENT' })
  await assert.rejects(readFile(other), { code: 'ENOENT' })
  await assert.rejects(readFile(map), { code: 'ENOENT' })
  await assert.rejects(readFile(declaration), { code: 'ENOENT' })
  assert.equal(await readFile(code, 'utf8'), 'exports.ok = true')
  assert.equal(await readFile(license, 'utf8'), 'MIT')
})
