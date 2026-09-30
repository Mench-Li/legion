import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveLayout } from '../paths.mjs'
import { createLauncher } from './launcher.mjs'
import { reserveEphemeralPort } from './ports.mjs'

test('desktop runtime cannot inherit or override the operator DSH home', () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-profile-'))
  try {
    const { layout } = resolveLayout({ installDir: fileURLToPath(new URL('../../', import.meta.url)), homeDir: root, workspaceDir: join(root, 'workspace') })
    const owner = createLauncher({ layout, baseEnv: { ...process.env, DSH_HOME: 'C:/operator/.dsh' },
      runtimeEnv: { DSH_HOME: 'C:/uncontrolled/.dsh' }, desktopCredentials: { hub: 'private-hub-token', workbench: 'private-desktop-token' } })
    const runtime = owner.envSurface().find(process => process.process === 'runtime')
    assert.equal(runtime.values.DSH_HOME, join(layout.dataDir, 'runtime', 'dsh', 'home'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('real desktop Launcher authenticates its probes and both local API services', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-desktop-auth-'))
  const workspaceDir = join(root, 'workspace'); mkdirSync(workspaceDir)
  const { layout } = resolveLayout({ installDir: fileURLToPath(new URL('../../', import.meta.url)), homeDir: root, workspaceDir })
  const ports = { 'team-hub': await reserveEphemeralPort(), workbench: await reserveEphemeralPort() }
  const owner = createLauncher({ layout, ports, include: ['team-hub', 'workbench'], baseEnv: process.env,
    desktopCredentials: { hub: 'private-hub-token', workbench: 'private-desktop-token' } })
  try {
    const result = await owner.start()
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics?.map(d => d.code)))
    assert.equal((await fetch(`http://127.0.0.1:${ports['team-hub']}/api/spaces`)).status, 401)
    assert.equal((await fetch(`http://127.0.0.1:${ports.workbench}/api/fs/home`)).status, 401)
    assert.equal((await fetch(`http://127.0.0.1:${ports.workbench}/hub/api/spaces`, { headers: { authorization: 'Bearer private-desktop-token' } })).status, 200)
  } finally { await owner.stop({ graceMs: 1000 }); rmSync(root, { recursive: true, force: true }) }
})
