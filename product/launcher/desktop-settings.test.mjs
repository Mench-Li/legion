import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, symlink, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveLayout } from '../paths.mjs'
import { configValueAt, loadProductConfig } from '../config.mjs'
import { createDesktopLauncher } from './desktop-launcher.mjs'
import { createDesktopBridge, desktopOptionsFrom } from './desktop-bridge.mjs'
import { readDesktopSettings, selectedWorkspace, writeDesktopModelVerified, writeDesktopSettings } from './desktop-settings.mjs'
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

test('identity setup persists a user-confirmed workspace fence above project configuration', async t => {
  const { root, workspace, layout } = await fixture(t)
  await mkdir(layout.dataDir, { recursive: true })
  await writeDesktopSettings(layout)
  const workspaceConfig = join(workspace, '.legion')
  await mkdir(workspaceConfig)
  await writeFile(join(workspaceConfig, 'product.config.json'), JSON.stringify({ runtime: {
    pathScope: { version: 'legion/path-scope@1', platform: process.platform, read: [root], write: [root] },
    env: { LEGION_ACTOR: 'project-override', LEGION_SCOPE: 'project-override', LEGION_ENFORCEMENT_ACTION: 'project-override' },
  } }))
  const input = { actor: 'operator-阿简', scope: '项目仓库维护', action: 'repository:write', allowWorkspaceWrites: true }
  const owner = createDesktopLauncher({ layout })
  t.after(() => owner.stop().catch(() => {}))
  assert.deepEqual(await owner.configureIdentity(input), { state: 'setup-required', phase: 'model', workspace })
  const loaded = loadProductConfig(layout)
  assert.equal(loaded.ok, true, JSON.stringify(loaded.diagnostics))
  assert.equal(configValueAt(loaded.merged, 'runtime.env.LEGION_ACTOR'), input.actor)
  assert.equal(configValueAt(loaded.merged, 'runtime.env.LEGION_SCOPE'), input.scope)
  assert.equal(configValueAt(loaded.merged, 'runtime.env.LEGION_ENFORCEMENT_ACTION'), input.action)
  assert.equal(configValueAt(loaded.merged, 'runtime.env.LEGION_ATTENDED'), 'true')
  assert.equal(configValueAt(loaded.merged, 'runtime.pathScope.platform'), process.platform)
  assert.deepEqual(configValueAt(loaded.merged, 'runtime.pathScope.read'), [workspace])
  assert.deepEqual(configValueAt(loaded.merged, 'runtime.pathScope.write'), [workspace])
  const homeSettings = JSON.parse(await readFile(join(layout.productHome, 'settings.json'), 'utf8'))
  assert.equal(Object.hasOwn(homeSettings, 'apiKey'), false)
  assert.equal(Object.hasOwn(homeSettings.runtime.env, 'apiKey'), false)
  await owner.stop()
})

test('identity persistence rejects incomplete input and plaintext credential fields without changing prior settings', async t => {
  const { workspace, layout } = await fixture(t)
  await mkdir(layout.dataDir, { recursive: true })
  await writeDesktopSettings(layout)
  const owner = createDesktopLauncher({ layout })
  t.after(() => owner.stop())
  await owner.configureIdentity({ actor: 'operator', scope: 'repo', action: 'repo:read', allowWorkspaceWrites: false })
  const path = join(layout.productHome, 'settings.json')
  const prior = await readFile(path, 'utf8')
  await assert.rejects(owner.configureIdentity({ actor: '', scope: 'repo', action: 'repo:read', allowWorkspaceWrites: true }), { code: 'DESKTOP_IDENTITY_INVALID' })
  await assert.rejects(owner.configureIdentity({ actor: 'operator', scope: 'repo', action: 'apiKey', allowWorkspaceWrites: true, apiKey: 'secret-fixture' }), { code: 'DESKTOP_IDENTITY_INVALID' })
  assert.equal(await readFile(path, 'utf8'), prior)
  const settings = JSON.parse(prior)
  assert.deepEqual(settings.runtime.pathScope.write, [])
  assert.equal(settings.runtime.env.LEGION_PERMISSION_PRESET, 'legion-attended')
  assert.equal(settings.runtime.env.LEGION_APPROVAL_POLICY, 'ask')
  assert.equal(workspace, settings.runtime.pathScope.read[0])
  await owner.stop()
})

test('verified model metadata is stored without a key and remains tied to the selected workspace', async t => {
  const { workspace, layout } = await fixture(t)
  await mkdir(layout.dataDir, { recursive: true })
  writeDesktopSettings(layout)
  const verified = writeDesktopModelVerified(layout, { verifiedAt: '2026-10-01T00:00:00.000Z', credentialUpdatedAt: '2026-10-01T00:00:00.000Z' })
  assert.deepEqual(verified, { state: 'configured', phase: 'model-verified', workspace })
  assert.deepEqual(readDesktopSettings(layout.dataDir), { version: 1, workspace,
    model: { provider: 'deepseek-official', model: 'deepseek-flash', endpoint: 'https://api.deepseek.com', verifiedAt: '2026-10-01T00:00:00.000Z', credentialUpdatedAt: '2026-10-01T00:00:00.000Z' } })
  const persisted = await readFile(join(layout.dataDir, 'desktop.settings.json'), 'utf8')
  assert.doesNotMatch(persisted, /apiKey|secret-fixture/)
  await assert.rejects(Promise.resolve().then(() => writeDesktopModelVerified({ ...layout, workspaceDir: join(workspace, 'missing') })),
    { code: 'WORKSPACE_SELECTION_CHANGED' })
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

test('desktop startup gates the model step until a successful model verification is recorded', async t => {
  const { workspace, layout } = await fixture(t)
  await mkdir(layout.dataDir, { recursive: true })
  writeDesktopSettings(layout)
  const env = { LEGION_HOME: layout.productHome, LEGION_INSTALL_DIR: layout.installDir,
    LEGION_WORKSPACE_DIR: join(workspace, 'unrelated-missing') }
  const owner = createDesktopLauncher({ layout })
  t.after(() => owner.stop())
  await owner.configureIdentity({ actor: 'operator', scope: 'repo', action: 'repo:read', allowWorkspaceWrites: false })
  assert.equal(desktopOptionsFrom({ env }).desktopSetupPhase, 'model')
  writeDesktopModelVerified(layout, { credentialUpdatedAt: new Date().toISOString() })
  assert.equal(desktopOptionsFrom({ env }).desktopSetupPhase, undefined)
  await owner.stop()
})
