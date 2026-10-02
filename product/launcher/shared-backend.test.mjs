import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireSingleInstance } from './single-instance.mjs'
import { publishBackend, discoverBackend, BACKEND_FILENAME } from './shared-backend.mjs'
import { createDesktopBridge } from './desktop-bridge.mjs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createBridgeClient } from '../../desktop/runtime.mjs'
import { createLauncher } from './launcher.mjs'
import { reserveEphemeralPort } from './ports.mjs'
import { resolveLayout } from '../paths.mjs'
import { request as httpRequest } from 'node:http'

const repo = fileURLToPath(new URL('../../', import.meta.url))

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'legion-shared-'))
  const layout = { dataDir: join(root, 'data'), workspaceDir: join(root, 'workspace'), installDir: join(root, 'install') }
  for (const path of [layout.dataDir, layout.workspaceDir, join(layout.installDir, 'product/release')]) mkdirSync(path, { recursive: true })
  writeFileSync(join(layout.installDir, 'product/release/runtime-manifest.json'), JSON.stringify({ productVersion: '1', dshVersion: '2' }))
  const lease = await acquireSingleInstance({ dataDir: layout.dataDir })
  let state = { state: 'ready', stateText: 'Legion 已就绪', processes: [{ key: 'workbench', state: 'ready', url: 'http://127.0.0.1:5173' }] }
  let stops = 0
  let publication
  const publish = async () => publication = await publishBackend({ layout, status: () => state, stop: async () => {
    stops++; state = { state: 'unavailable', processes: [] }; publication.close(); lease.handle.release(); return { results: [] }
  } })
  t.after(() => { publication?.close(); lease.handle.release(); rmSync(root, { recursive: true, force: true }) })
  return { layout, publish, get stops() { return stops }, set state(value) { state = value },
    record: () => JSON.parse(readFileSync(join(layout.dataDir, BACKEND_FILENAME), 'utf8')) }
}

test('verified backend is reused and stop removes discovery only after services stop', async t => {
  const f = await fixture(t)
  await f.publish()
  const client = await discoverBackend(f.layout)
  assert.equal(client.shared, true)
  assert.equal((await client.start()).ok, true)
  assert.equal(client.status().processes[0].url, 'http://127.0.0.1:5173')
  f.state = { state: 'degraded', processes: [] }
  assert.equal((await client.refresh()).state, 'degraded')
  assert.equal(f.stops, 0)
  assert.equal((await client.stop()).ok, true)
  assert.equal(f.stops, 1)
  assert.equal(await discoverBackend(f.layout), null)
})

test('another workspace and an incompatible version cannot attach', async t => {
  const f = await fixture(t)
  await f.publish()
  const different = join(f.layout.workspaceDir, 'other')
  mkdirSync(different)
  await assert.rejects(discoverBackend({ ...f.layout, workspaceDir: different }), { code: 'BACKEND_WORKSPACE_MISMATCH' })
  writeFileSync(join(f.layout.installDir, 'product/release/runtime-manifest.json'), JSON.stringify({ productVersion: '3', dshVersion: '2' }))
  await assert.rejects(discoverBackend(f.layout), { code: 'BACKEND_VERSION_MISMATCH' })
  assert.equal(f.stops, 0)
})

test('local browser control requires a secret and rejects foreign origins', async t => {
  const f = await fixture(t)
  await f.publish()
  const record = f.record()
  assert.equal((await fetch(`${record.url}/status`)).status, 401)
  assert.equal((await fetch(`${record.url}/stop`, { method: 'POST', headers: {
    authorization: `Bearer ${record.token}`, origin: 'https://evil.test',
  } })).status, 403)
  assert.equal(f.stops, 0)
  const response = await fetch(`${record.url}/status`, { headers: { authorization: `Bearer ${record.token}` } })
  assert.doesNotMatch(await response.text(), new RegExp(record.token))
})

test('concurrent entry waits for the lock owner to publish instead of spawning twice', async t => {
  const f = await fixture(t)
  const first = discoverBackend(f.layout, { timeoutMs: 1000, intervalMs: 5 })
  const second = discoverBackend(f.layout, { timeoutMs: 1000, intervalMs: 5 })
  await f.publish()
  const clients = await Promise.all([first, second])
  assert.ok(clients.every(client => client.shared))
  assert.equal((await acquireSingleInstance({ dataDir: f.layout.dataDir })).ok, false)
  assert.equal(f.stops, 0)
})

test('dead owner and missing lock never authorize attaching to an occupied port', async t => {
  const f = await fixture(t)
  await f.publish()
  assert.equal(await discoverBackend(f.layout, { alive: () => false }), null)
  unlinkSync(join(f.layout.dataDir, 'legion-instance.lock'))
  assert.equal(await discoverBackend(f.layout), null)
})

test('desktop attaches before its first-run setup and exit leaves Web services running', async t => {
  const f = await fixture(t)
  await f.publish()
  const bridge = createDesktopBridge({
    optionsFactory: () => ({ options: { layout: f.layout }, desktopSetupPhase: 'model' }),
    launcherFactory: () => { throw new Error('must not start a second backend') },
  })
  const response = await bridge.handle({ id: 'start', type: 'start', payload: { token: 'a'.repeat(64) } })
  assert.equal(response.ok, true)
  assert.equal(response.payload.workbenchUrl, 'http://127.0.0.1:5173')
  assert.equal((await bridge.handle({ id: 'detach', type: 'detach', payload: {} })).payload.state, 'detached')
  await bridge.close()
  assert.equal(f.stops, 0)
  assert.equal((await discoverBackend(f.layout)).status().state, 'ready')
})

test('explicit desktop stop controls the shared backend', async t => {
  const f = await fixture(t)
  await f.publish()
  const bridge = createDesktopBridge({ optionsFactory: () => ({ options: { layout: f.layout } }) })
  await bridge.handle({ id: 'start', type: 'start', payload: { token: 'b'.repeat(64) } })
  const response = await bridge.handle({ id: 'stop', type: 'stop', payload: {} })
  assert.equal(response.payload.state, 'stopped')
  assert.equal(f.stops, 1)
  await bridge.close()
})

test('real desktop-owned Hub and Workbench survive desktop exit and accept a second CLI entry', { timeout: 90_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'legion-shared-real-'))
  const { layout } = resolveLayout({ installDir: repo, workspaceDir: join(root, 'workspace'), env: { LEGION_HOME: root } })
  for (const key of ['dataDir', 'workspaceDir', 'cacheDir', 'logDir']) mkdirSync(layout[key], { recursive: true })
  const options = { layout, include: ['team-hub', 'workbench'],
    ports: { 'team-hub': await reserveEphemeralPort(), workbench: await reserveEphemeralPort() },
    readiness: { timeoutMs: 60_000, intervalMs: 100 } }
  const source = `import { runDesktopBridge, createDesktopBridge } from ${JSON.stringify(new URL('./desktop-bridge.mjs', import.meta.url).href)};
    import { createLauncher } from ${JSON.stringify(new URL('./launcher.mjs', import.meta.url).href)};
    runDesktopBridge({ bridgeFactory: ({ emit }) => createDesktopBridge({ emit,
      launcherFactory: input => {
        const owner = createLauncher(input);
        const start = owner.start.bind(owner);
        return { ...owner, start: async () => { const result = await start();
          if (!result.ok) console.error(JSON.stringify({ phase: result.phase, failures: result.failures,
            diagnostics: result.diagnostics?.map(d => ({ code: d.code, message: d.message })) }));
          return result; } };
      },
      optionsFactory: () => ({ options: ${JSON.stringify(options)} }) }) });`
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const client = createBridgeClient(child)
  t.after(async () => {
    try { const backend = await discoverBackend(layout); await backend?.stop() } catch {}
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
    if (child.exitCode === null) child.kill()
    rmSync(root, { recursive: true, force: true })
  })
  const first = await client.request('start', { token: 'e'.repeat(64) }).catch(error => { throw new Error(`${error.code}: ${stderr}`) })
  assert.equal(first.state, 'degraded')
  assert.ok(first.workbenchUrl)
  assert.equal((await client.request('detach')).state, 'detached')
  await client.close({ detach: true })
  const reused = await discoverBackend(layout)
  assert.equal(reused.status().processes.find(p => p.key === 'workbench').url, first.workbenchUrl)
  const secondDesktop = createDesktopBridge({ optionsFactory: () => ({ options: { layout } }),
    launcherFactory: () => { throw new Error('second desktop must reuse') } })
  const second = await secondDesktop.handle({ id: 'second', type: 'start', payload: { token: 'f'.repeat(64) } })
  assert.equal(second.payload.workbenchUrl, first.workbenchUrl)
  await secondDesktop.close()
  const cli = spawn(process.execPath, [join(repo, 'product/launcher/cli.mjs'), '--connect-existing', '--json', '--no-config',
    `--data-dir=${layout.dataDir}`], { windowsHide: true, env: { ...process.env, LEGION_WORKSPACE_DIR: undefined } })
  let output = ''
  cli.stdout.on('data', chunk => output += chunk)
  cli.stderr.resume()
  const exit = await new Promise((accept, reject) => { cli.once('exit', accept); cli.once('error', reject) })
  assert.equal(exit, 0, output)
  assert.equal(JSON.parse(output).processes.find(p => p.key === 'workbench').url, first.workbenchUrl)
  // Browser navigation and same-origin API access work without a desktop token.
  const cookie = await new Promise((accept, reject) => {
    const req = httpRequest(first.workbenchUrl, { headers: {
      'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none',
    } }, res => { res.resume(); res.once('end', () => accept(res.headers['set-cookie']?.[0]?.split(';')[0])) })
    req.once('error', reject); req.end()
  })
  assert.ok(cookie)
  assert.equal((await fetch(`${first.workbenchUrl}/hub/api/config`, { headers: { cookie } })).status, 200)
  await reused.stop()
  assert.equal(await discoverBackend(layout), null)
})

test('real Web-owned services are reused by desktop and desktop close does not stop them', { timeout: 90_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'legion-web-shared-'))
  const { layout } = resolveLayout({ installDir: repo, workspaceDir: join(root, 'workspace'), env: { LEGION_HOME: root } })
  for (const key of ['dataDir', 'workspaceDir', 'cacheDir', 'logDir']) mkdirSync(layout[key], { recursive: true })
  const owner = createLauncher({ layout, sharedBackend: true, include: ['team-hub', 'workbench'],
    ports: { 'team-hub': await reserveEphemeralPort(), workbench: await reserveEphemeralPort() },
    readiness: { timeoutMs: 60_000, intervalMs: 100 } })
  t.after(async () => { await owner.stop(); rmSync(root, { recursive: true, force: true }) })
  const started = await owner.start()
  assert.equal(started.ok, true, JSON.stringify(started))
  const bridge = createDesktopBridge({ optionsFactory: () => ({ options: { layout }, desktopSetupPhase: 'model' }),
    launcherFactory: () => { throw new Error('must reuse Web owner') } })
  const result = await bridge.handle({ id: 'start', type: 'start', payload: { token: 'a'.repeat(64) } })
  assert.equal(result.ok, true)
  assert.equal(result.payload.workbenchUrl, owner.status().processes.find(p => p.key === 'workbench').url)
  const restarted = await bridge.handle({ id: 'restart', type: 'restart', payload: {} })
  assert.equal(restarted.ok, true, JSON.stringify(restarted))
  assert.equal(restarted.payload.workbenchUrl, result.payload.workbenchUrl)
  await bridge.close()
  assert.equal((await fetch(`${result.payload.workbenchUrl}/hub/api/config`)).status, 200)
})

test('stopping a CLI-owned shared backend lets the original Web launcher exit successfully', { timeout: 90_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'legion-cli-shared-'))
  const { layout } = resolveLayout({ installDir: repo, workspaceDir: join(root, 'workspace'), env: { LEGION_HOME: root } })
  for (const key of ['dataDir', 'workspaceDir', 'cacheDir', 'logDir']) mkdirSync(layout[key], { recursive: true })
  const child = spawn(process.execPath, [join(repo, 'product/launcher/cli.mjs'), '--no-config', '--no-tray', '--no-auto-diagnostics',
    '--include=team-hub,workbench', `--workspace=${layout.workspaceDir}`,
    `--port.team-hub=${await reserveEphemeralPort()}`, `--port.workbench=${await reserveEphemeralPort()}`],
  { windowsHide: true, env: { ...process.env, LEGION_HOME: root, LEGION_DATA_DIR: undefined,
    LEGION_WORKSPACE_DIR: undefined, LEGION_CACHE_DIR: undefined, LEGION_LOG_DIR: undefined, LEGION_SECRETS_FILE: undefined } })
  let output = ''
  child.stdout.on('data', chunk => output += chunk)
  child.stderr.on('data', chunk => output += chunk)
  const exit = new Promise((accept, reject) => { child.once('exit', accept); child.once('error', reject) })
  let backend = null
  t.after(async () => {
    if (child.exitCode === null) { try { await backend?.stop() } catch {} ; child.kill() }
    child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy()
    rmSync(root, { recursive: true, force: true })
  })
  for (let attempt = 0; attempt < 100 && backend === null; attempt++) {
    if (child.exitCode !== null) throw new Error(output)
    backend = await discoverBackend(layout, { timeoutMs: 60_000 })
    if (backend === null) await new Promise(r => setTimeout(r, 50))
  }
  assert.ok(backend, output)
  await backend.stop()
  assert.equal(await exit, 0, output)
})
