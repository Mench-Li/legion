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
  const responses = await Promise.all([
    bridge.handle({ version: 1, id: '2', type: 'restart', payload: {} }),
    bridge.handle({ version: 1, id: '3', type: 'stop', payload: {} }),
  ])
  assert.equal(responses[0].payload.code, 'PREPARATION_CANCELLED')
  assert.deepEqual(events, ['start', 'stop'])
  await bridge.close()
  assert.deepEqual(events, ['start', 'stop'])
})

test('launcher failure remains failed even when status claims ready', async () => {
  const bridge = createDesktopBridge({
    launcherFactory: () => ({ async start() { return { ok: false, phase: 'ports', code: 'PORT_IN_USE', diagnostics: [
      { severity: 'error', code: 'PORT_IN_USE', process: 'team-hub', port: 8787, portListening: true,
        message: 'text must not be forwarded' },
    ] } }, status() { return { state: 'ready', processes: [] } }, async stop() {} }),
    optionsFactory: () => ({ options: {} }), emit: () => {},
  })
  const response = await bridge.handle({ version: 1, id: 'a', type: 'start', payload: { token: 'a'.repeat(64) } })
  assert.equal(response.ok, false)
  assert.equal(response.payload.code, 'PORT_IN_USE')
  assert.equal(response.payload.state, 'failed')
  assert.deepEqual(response.payload.portConflict, { process: 'team-hub', port: 8787, listening: true })
  assert.doesNotMatch(JSON.stringify(response), /text must not be forwarded/)
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

test('model configuration crosses only the authenticated bridge request and never returns the key', async () => {
  const key = 'sk-model-setup-secret'
  let received = null
  const events = []
  const bridge = createDesktopBridge({
    optionsFactory: () => ({ options: {} }), emit: event => events.push(event),
    launcherFactory: () => ({
      async configureModel(input) { received = input; return { state: 'configured', phase: 'model-verified' } },
      async start() { return { ok: true } }, async stop() {}, status() { return { state: 'unavailable', processes: [] } },
    }),
  })
  const response = await bridge.handle({ version: 1, id: 'model-setup', type: 'configure-model',
    payload: { token: 'a'.repeat(64), model: { apiKey: key } } })
  assert.equal(response.ok, true)
  assert.equal(received.apiKey, key)
  assert.doesNotMatch(JSON.stringify([response, events]), /sk-model-setup-secret/)
  await bridge.close()
})

test('changed or missing protected model credentials reopen setup instead of trusting an old verification', async () => {
  let constructed = false
  const bridge = createDesktopBridge({
    optionsFactory: () => ({ options: {}, desktopModelSetup: { credentialUpdatedAt: 'old-version' } }),
    modelCredentialVerifier: async input => input.desktopModelSetup.credentialUpdatedAt === 'current-version',
    launcherFactory: () => { constructed = true; throw new Error('must not start') },
  })
  const result = await bridge.handle({ version: 1, id: 'start', type: 'start', payload: { token: 'a'.repeat(64) } })
  assert.equal(result.payload.code, 'MODEL_NOT_CONFIGURED')
  assert.equal(constructed, false)
  await bridge.close()
})

test('current protected credential metadata permits automatic backend startup', async () => {
  let starts = 0
  const bridge = createDesktopBridge({
    optionsFactory: () => ({ options: {}, desktopModelSetup: { credentialUpdatedAt: 'current-version' } }),
    modelCredentialVerifier: async () => true,
    launcherFactory: () => ({
      async start() { starts++; return { ok: true } }, async stop() {},
      status() { return { state: 'ready', processes: [{ key: 'workbench', state: 'ready', url: 'http://127.0.0.1:5173' }] } },
    }),
  })
  const result = await bridge.handle({ version: 1, id: 'start-current', type: 'start', payload: { token: 'a'.repeat(64) } })
  assert.equal(result.ok, true)
  assert.equal(result.payload.state, 'ready')
  assert.equal(starts, 1)
  await bridge.close()
})

test('stdio status and stop remain serviceable while runtime preparation is pending', { timeout: 1000 }, async () => {
  const input = new PassThrough(), output = new PassThrough()
  let entered, cancel, finished
  const began = new Promise(resolve => { entered = resolve })
  const done = new Promise(resolve => { finished = resolve })
  const lines = []
  output.on('data', chunk => {
    for (const line of String(chunk).trim().split('\n')) {
      const message = JSON.parse(line); lines.push(message)
      if (message.id === 'stop') finished()
    }
  })
  const bridge = runDesktopBridge({ input, output, bridgeFactory: ({ emit }) => createDesktopBridge({ emit,
    optionsFactory: () => ({ options: {} }), launcherFactory: () => ({
      async start() { entered(); await new Promise(resolve => { cancel = resolve }); return { ok: false, code: 'PREPARATION_CANCELLED' } },
      cancelPreparation() { cancel?.() }, async stop() {}, status() { return { state: 'preparing', processes: [] } },
    }),
  }) })
  input.write(`${JSON.stringify({ version: 1, id: 'start', type: 'start', payload: { token: 'a'.repeat(64) } })}\n`)
  await began
  input.write(`${JSON.stringify({ version: 1, id: 'status', type: 'status', payload: {} })}\n`)
  input.write(`${JSON.stringify({ version: 1, id: 'stop', type: 'stop', payload: {} })}\n`)
  await done
  assert.equal(lines.find(line => line.id === 'status').payload.state, 'preparing')
  assert.equal(lines.find(line => line.id === 'start').payload.code, 'PREPARATION_CANCELLED')
  assert.equal(lines.find(line => line.id === 'stop').payload.state, 'stopped')
  input.end()
  await bridge.close()
})
