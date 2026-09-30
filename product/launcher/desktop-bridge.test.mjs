import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { createDesktopBridge, runDesktopBridge } from './desktop-bridge.mjs'

test('start correlates response and hides secrets from all emitted data', async () => {
  const emitted = []
  const secret = 'secret-should-never-appear'.padEnd(64, 'x')
  let starts = 0
  const launcher = {
    async start() { starts++; return { ok: true, diagnostics: [{ code: 'OK', message: secret }] } },
    async stop() { return {} },
    status() { return { state: 'ready', processes: [{ key: 'workbench', state: 'ready', url: 'http://127.0.0.1:5173', token: secret }] } },
  }
  const bridge = createDesktopBridge({ launcherFactory: () => launcher, optionsFactory: () => ({ options: {} }), emit: (item) => emitted.push(item) })
  const response = await bridge.handle({ version: 1, id: 'start-1', type: 'start', payload: { token: secret } })
  assert.equal(response.id, 'start-1')
  assert.equal(response.ok, true)
  assert.equal(response.payload.state, 'ready')
  assert.equal(response.payload.workbenchUrl, 'http://127.0.0.1:5173')
  assert.equal(starts, 1)
  assert.doesNotMatch(JSON.stringify([response, emitted]), /secret-should-never-appear/)
  assert.equal((await bridge.handle({ version: 1, id: 'start-2', type: 'start', payload: {} })).ok, true)
  assert.equal(starts, 1)
})

test('stop and restart serialize lifecycle and close stops the owned launcher', async () => {
  const events = []
  const launcher = {
    async start() { events.push('start'); return { ok: true } },
    async stop() { events.push('stop'); return {} },
    status() { return { state: 'ready', processes: [] } },
  }
  const bridge = createDesktopBridge({ launcherFactory: () => launcher, optionsFactory: () => ({ options: {} }), emit: () => {} })
  await bridge.handle({ version: 1, id: '1', type: 'start', payload: { token: 'a'.repeat(64) } })
  await Promise.all([
    bridge.handle({ version: 1, id: '2', type: 'restart', payload: {} }),
    bridge.handle({ version: 1, id: '3', type: 'stop', payload: {} }),
  ])
  assert.deepEqual(events, ['start', 'stop', 'start', 'stop'])
  await bridge.close()
  assert.deepEqual(events, ['start', 'stop', 'start', 'stop'])
})

test('launcher failure remains failed even when status claims ready', async () => {
  const bridge = createDesktopBridge({
    launcherFactory: () => ({ async start() { return { ok: false, phase: 'ports', code: 'PORT_IN_USE' } }, status() { return { state: 'ready', processes: [] } }, async stop() {} }),
    optionsFactory: () => ({ options: {} }), emit: () => {},
  })
  const response = await bridge.handle({ version: 1, id: 'a', type: 'start', payload: { token: 'a'.repeat(64) } })
  assert.equal(response.ok, false)
  assert.equal(response.payload.code, 'PORT_IN_USE')
  assert.equal(response.payload.state, 'failed')
})

test('unexpected failure details cannot escape through a diagnostic code', async () => {
  const secret = 'sk-live-secret-value'
  const bridge = createDesktopBridge({
    launcherFactory: () => ({ async start() { return { ok: false, code: secret } }, async stop() {}, status() { return { state: 'unavailable', processes: [] } } }),
    optionsFactory: () => ({ options: {} }), emit: () => {},
  })
  const response = await bridge.handle({ version: 1, id: 'a', type: 'start', payload: { token: 'a'.repeat(64) } })
  assert.equal(response.payload.code, 'START_FAILED')
  assert.doesNotMatch(JSON.stringify(response), /sk-live-secret-value/)
})

test('stdio wiring rejects bad input, handles a later request, and closes the owner on EOF', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const lines = []
  let closed = false
  output.on('data', (chunk) => lines.push(...String(chunk).trim().split('\n').filter(Boolean).map(JSON.parse)))
  runDesktopBridge({ input, output, bridgeFactory: () => ({
    async handle(request) { return { version: 1, id: request.id, type: 'result', ok: true, payload: { state: 'ready' } } },
    async close() { closed = true },
  }) })
  input.write('{"version":1,"id":"x","type":"unknown","payload":{}}\n')
  input.write('{"version":1,"id":"y","type":"status","payload":{}}\n')
  input.end()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(lines[0].payload.code, 'UNKNOWN_TYPE')
  assert.equal(lines[1].id, 'y')
  assert.equal(lines[1].payload.state, 'ready')
  assert.equal(closed, true)
})

test('bridge requires a credential handshake and privately scopes distinct service credentials', async () => {
  let options
  const token = 'a'.repeat(64)
  const events = []
  const bridge = createDesktopBridge({
    optionsFactory: () => ({ options: {} }), emit: event => events.push(event),
    launcherFactory: input => { options = input; return {
      async start() { return { ok: true } }, async stop() {}, status() { return { state: 'ready', processes: [] } },
    } },
  })
  assert.equal((await bridge.handle({ version: 1, id: 'missing', type: 'start', payload: {} })).payload.code, 'DESKTOP_CREDENTIAL_REQUIRED')
  assert.equal(options, undefined)
  assert.equal((await bridge.handle({ version: 1, id: 'valid', type: 'start', payload: { token } })).ok, true)
  assert.equal(options.desktopCredentials.workbench, token)
  assert.match(options.desktopCredentials.hub, /^[a-f0-9]{64}$/)
  assert.notEqual(options.desktopCredentials.hub, token)
  assert.doesNotMatch(JSON.stringify(events), new RegExp(`${token}|${options.desktopCredentials.hub}`))
  assert.equal((await bridge.handle({ version: 1, id: 'changed', type: 'restart', payload: { token: 'b'.repeat(64) } })).payload.code, 'DESKTOP_CREDENTIAL_CHANGED')
  await bridge.close()
})
