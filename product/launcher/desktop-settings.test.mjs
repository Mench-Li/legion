import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, symlink, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveLayout } from '../paths.mjs'
import { createDesktopLauncher } from './desktop-launcher.mjs'
import { createDesktopBridge, desktopOptionsFrom } from './desktop-bridge.mjs'
import { readDesktopSettings, selectedWorkspace, writeDesktopSettings } from './desktop-settings.mjs'
import { acquireSingleInstance } from './single-instance.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'Legion setup with spaces-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, '项目 workspace')
  await mkdir(workspace)
  const { layout } = resolveLayout({ installDir: join(root, 'install'), workspaceDir: workspace,
    env: { LEGION_HOME: join(root, 'product') } })
  return { root, workspace, layout }
}

test('workspace setup saves only selection, preserves configuration and retains the real owner lease', async t => {
  const { workspace, layout } = await fixture(t)
  await mkdir(layout.dataDir, { recursive: true })
  const existing = '{"runtime":{"command":"retained-config"}}'
  await writeFile(layout.productConfigPath, existing)
  let spawned = false
  const owner = createDesktopLauncher({ layout }, { launcherFactory: () => { spawned = true; throw new Error('unexpected start') } })
  t.after(() => owner.stop())
  const configured = await owner.configureWorkspace()
  assert.equal(configured.state, 'setup-required')
  assert.equal(configured.phase, 'identity')
  assert.equal(selectedWorkspace(workspace), configured.workspace)
  assert.equal((await readFile(layout.productConfigPath, 'utf8')), existing)
  assert.deepEqual(readDesktopSettings(layout.dataDir), { version: 1, workspace: configured.workspace })
  assert.equal(spawned, false)
  assert.equal((await acquireSingleInstance({ dataDir: layout.dataDir })).ok, false)
  await owner.stop()
  const next = await acquireSingleInstance({ dataDir: layout.dataDir })
  assert.equal(next.ok, true)
  next.handle.release()
})

test('malformed, secret-bearing, missing and relative workspace settings cannot silently become a valid selection', async t => {
  const { workspace, layout } = await fixture(t)
  assert.equal(readDesktopSettings(layout.dataDir), null)
  await mkdir(layout.dataDir, { recursive: true })
  const settings = join(layout.dataDir, 'desktop.settings.json')
  for (const value of ['{', JSON.stringify({ version: 1, workspace, apiKey: 'secret-fixture' }),
    JSON.stringify({ version: 2, workspace }), JSON.stringify({ version: 1, workspace: 'relative' }),
    JSON.stringify({ version: 1, workspace: join(workspace, 'missing') })]) {
    await writeFile(settings, value)
    assert.throws(() => readDesktopSettings(layout.dataDir))
    assert.equal(await readFile(settings, 'utf8'), value)
  }
  assert.throws(() => selectedWorkspace('relative'), { code: 'WORKSPACE_SELECTION_INVALID' })
})

test('settings file and ancestor junctions cannot redirect reads or writes', async t => {
  const { root, workspace, layout } = await fixture(t)
  const other = join(root, 'other')
  await mkdir(other)
  const outside = join(other, 'desktop.settings.json')
  const original = JSON.stringify({ version: 1, workspace })
  await writeFile(outside, original)
  await mkdir(join(root, 'product'))
  await symlink(other, layout.dataDir, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => readDesktopSettings(layout.dataDir), { code: 'DESKTOP_SETTINGS_LINK' })
  assert.throws(() => writeDesktopSettings(layout), { code: 'DESKTOP_SETTINGS_LINK' })
  assert.equal(await readFile(outside, 'utf8'), original)
  const owner = createDesktopLauncher({ layout })
  await assert.rejects(owner.configureWorkspace(), { code: 'DESKTOP_SETTINGS_LINK' })
  assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(other)), ['desktop.settings.json'])
  await owner.stop()
})

test('bridge workspace setup uses the owner and closes its lease without starting any services', async t => {
  const { workspace, layout } = await fixture(t)
  let selection
  const bridge = createDesktopBridge({ optionsFactory: input => { selection = input.workspace; return { options: { layout } } } })
  t.after(() => bridge.close())
  const response = await bridge.handle({ version: 1, id: 'setup', type: 'configure-workspace',
    payload: { token: 'a'.repeat(64), workspace } })
  assert.equal(response.ok, true)
  assert.equal(response.payload.state, 'setup-required')
  assert.equal(selection, selectedWorkspace(workspace))
  assert.equal((await acquireSingleInstance({ dataDir: layout.dataDir })).ok, false)
  await bridge.close()
  const next = await acquireSingleInstance({ dataDir: layout.dataDir })
  assert.equal(next.ok, true)
  next.handle.release()
})

test('a saved workspace replaced by a junction cannot silently change the selected project', async t => {
  const { root, workspace, layout } = await fixture(t)
  await mkdir(layout.dataDir, { recursive: true })
  writeDesktopSettings(layout)
  await rename(workspace, join(root, 'original workspace'))
  const other = join(root, 'other workspace')
  await mkdir(other)
  await symlink(other, workspace, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => readDesktopSettings(layout.dataDir), { code: 'WORKSPACE_SELECTION_CHANGED' })
})

test('invalid selection cannot instantiate a launcher or stop a running owner', async () => {
  let stopped = false
  const bridge = createDesktopBridge({ optionsFactory: () => ({ options: {} }), launcherFactory: () => ({
    start: async () => ({ ok: true }), stop: async () => { stopped = true }, status: () => ({ state: 'ready', processes: [] }),
  }) })
  await bridge.handle({ version: 1, id: 'start', type: 'start', payload: { token: 'a'.repeat(64) } })
  const response = await bridge.handle({ version: 1, id: 'setup', type: 'configure-workspace', payload: { workspace: 'relative' } })
  assert.equal(response.payload.code, 'WORKSPACE_SELECTION_INVALID')
  assert.equal(stopped, false)
  await bridge.close()
})

test('saved workspace resumes identity setup and overrides an inherited workspace without preparing a runtime', async t => {
  const { workspace, layout } = await fixture(t)
  await mkdir(layout.dataDir, { recursive: true })
  writeDesktopSettings(layout)
  const env = { LEGION_HOME: layout.productHome, LEGION_INSTALL_DIR: layout.installDir,
    LEGION_WORKSPACE_DIR: join(workspace, 'unrelated-missing') }
  const input = desktopOptionsFrom({ env })
  assert.equal(selectedWorkspace(input.options.layout.workspaceDir), selectedWorkspace(workspace))
  assert.equal(input.desktopSetupPhase, 'identity')
  let constructed = false
  const bridge = createDesktopBridge({ optionsFactory: () => desktopOptionsFrom({ env }),
    launcherFactory: () => { constructed = true; throw new Error('unexpected preparation') } })
  const result = await bridge.handle({ version: 1, id: 'resume', type: 'start', payload: { token: 'a'.repeat(64) } })
  assert.equal(result.payload.code, 'ENFORCEMENT_IDENTITY_MISSING')
  assert.equal(constructed, false)
  await bridge.close()
})
