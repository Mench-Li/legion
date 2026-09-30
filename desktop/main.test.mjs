import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { canNavigate, closeAction, createBridgeClient, desktopRequestHeaders, externalUrl, workbenchTarget } from './runtime.mjs'
import { failureMessage } from './messages.mjs'

test('window allows only bundled startup page and the verified Workbench origin', () => {
  const startup = 'file:///C:/Program%20Files/Legion/startup.html'
  const origin = 'http://127.0.0.1:5173'
  assert.equal(canNavigate(startup, { startup, origin }), true)
  assert.equal(canNavigate(`${origin}/tasks`, { startup, origin }), true)
  for (const url of ['http://evil.test/', 'http://localhost:5173/', 'http://user@127.0.0.1:5173/', 'file:///C:/Windows/system.ini', 'javascript:alert(1)']) {
    assert.equal(canNavigate(url, { startup, origin }), false, url)
  }
  assert.equal(externalUrl('https://example.org/docs'), 'https://example.org/docs')
  assert.equal(externalUrl('file:///C:/Windows/system.ini'), null)
})

test('workbench target exists only after verified service status', () => {
  assert.equal(workbenchTarget({ state: 'ready', workbenchUrl: 'http://127.0.0.1:5173' }), 'http://127.0.0.1:5173')
  assert.equal(workbenchTarget({ state: 'unavailable', workbenchUrl: 'http://127.0.0.1:5173' }), null)
  assert.equal(workbenchTarget({ state: 'ready', workbenchUrl: 'http://evil.test' }), null)
  assert.equal(closeAction({ quitting: false, closeToTray: true }), 'hide')
  assert.equal(closeAction({ quitting: true, closeToTray: true }), 'close')
})

test('bridge client correlates request and rejects pending work when child dies', async () => {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  const sent = []
  child.stdin.on('data', (chunk) => sent.push(JSON.parse(String(chunk))))
  const client = createBridgeClient(child)
  const first = client.request('status')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, 'status')
  child.stdout.write(`${JSON.stringify({ version: 1, id: sent[0].id, type: 'result', ok: true, payload: { state: 'ready' } })}\n`)
  assert.equal((await first).state, 'ready')
  const pending = client.request('start', { token: 'private-test-token' })
  assert.equal(sent[1].payload.token, 'private-test-token')
  child.emit('exit', 1)
  await assert.rejects(pending, { code: 'BRIDGE_EXITED' })
  await assert.rejects(client.request('status'), { code: 'BRIDGE_EXITED' })
})

test('sandbox-compatible preload exposes only the startup command allowlist', async () => {
  let exposed
  const calls = []
  const filename = fileURLToPath(new URL('./preload.cjs', import.meta.url))
  const source = readFileSync(filename, 'utf8')
  runInNewContext(source, {
    require: () => ({
      contextBridge: { exposeInMainWorld(_name, api) { exposed = api } },
      ipcRenderer: { invoke(_channel, command) { calls.push(command); return Promise.resolve(command) }, on() {}, removeListener() {} },
    }),
  })
  assert.deepEqual(Object.keys(exposed).sort(), ['onState', 'retry', 'status', 'stop'])
  assert.equal(await exposed.retry(), 'retry')
  assert.deepEqual(calls, ['retry'])
})

test('startup failure identifies missing execution identity instead of blaming the network', () => {
  assert.equal(failureMessage('ENFORCEMENT_IDENTITY_MISSING'), '缺少执行身份配置，请完成首次设置。')
})

test('desktop credential belongs only to the owned main frame and verified origin', () => {
  const origin = 'http://127.0.0.1:5173'
  const owner = { origin, token: 'private-test-token', webContentsId: 7 }
  const request = { url: `${origin}/api/fs/home`, webContentsId: 7, resourceType: 'xhr',
    frame: { parent: null, url: `${origin}/tasks` }, requestHeaders: { Accept: 'application/json' } }
  assert.equal(desktopRequestHeaders(request, owner).Authorization, 'Bearer private-test-token')
  for (const details of [
    { ...request, webContentsId: 8 },
    { ...request, url: 'https://evil.test/api' },
    { ...request, frame: { parent: {}, url: `${origin}/tasks` } },
    { ...request, frame: null },
    { ...request, frame: { parent: null, url: 'https://evil.test/' } },
    { ...request, requestHeaders: { Origin: 'https://evil.test' } },
    { ...request, resourceType: 'subFrame' },
  ]) assert.equal(desktopRequestHeaders(details, owner).Authorization, undefined)
  assert.equal(desktopRequestHeaders(request, { ...owner, origin: null }).Authorization, undefined)
  assert.equal(desktopRequestHeaders({ ...request, resourceType: 'mainFrame', frame: { parent: null, url: 'file:///startup.html' } }, owner).Authorization, 'Bearer private-test-token')
})
