import test from 'node:test'
import assert from 'node:assert/strict'
import { forwardDshModels, validateDshModelsRequest } from './dsh-models-bridge.mjs'
test('DSH bridge preserves its authenticated Remote envelope and catalog', async () => {
  const catalog = { groups: [{ id: 'actual-provider', models: [{ id: 'actual-model' }] }] }
  const value = await forwardDshModels({ method: 'session/modelCatalog', args: {} }, { cookie: 'session=fixture', fetchImpl: async (url, request) => {
    assert.equal(url, 'http://127.0.0.1:3080/api/session/modelCatalog')
    assert.equal(request.headers.cookie, 'session=fixture')
    const body = JSON.parse(request.body)
    assert.equal(body.type, 'client-request'); assert.deepEqual(body.payload.args, {})
    return Response.json({ result: { ok: true, value: catalog } })
  } })
  assert.deepEqual(value, catalog)
})
test('requires profile revisions and restricts writes to model configuration', () => {
  for (const body of [
    { method: 'session/create', args: {} },
    { method: 'settings/mutate', args: { ns: 'other', ops: [], expectedRevision: 1 } },
    { method: 'settings/mutate', args: { ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', '__proto__'], value: {} }], expectedRevision: 1 } },
    { method: 'settings/mutate', args: { ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['other'], value: {} }], expectedRevision: 1 } },
    { method: 'settings/mutate', args: { ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', 'test'], value: {} }] } },
  ]) assert.throws(() => validateDshModelsRequest(body))
  assert.doesNotThrow(() => validateDshModelsRequest({ method: 'settings/mutate', args: { ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', 'test', 'models'], value: [{ id: 'model' }] }], expectedRevision: 0 } }))
})
test('missing DSH login is explicit and never becomes an empty catalog', async () => {
  await assert.rejects(forwardDshModels({ method: 'session/modelCatalog', args: {} }, { fetchImpl: async () => new Response('unauthorized', { status: 401 }) }), error => error.status === 401 && error.message.includes('未授权'))
})
test('DSH conflict diagnostics survive and credentials remain write-only', async () => {
  assert.throws(() => validateDshModelsRequest({ method: 'credentials/get', args: { ref: 'TEST_API_KEY' } }))
  await assert.rejects(forwardDshModels({ method: 'settings/mutate', args: { ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', 'test'], value: {} }], expectedRevision: 1 } }, { fetchImpl: async () => Response.json({ result: { ok: false, error: { code: 'settings/conflict', message: 'configuration revision changed' } } }) }), /revision changed/)
})

test('only provider-level removal is accepted', () => {
  const request = path => ({method:'settings/mutate',args:{ns:'llm-pi-ai',expectedRevision:1,ops:[{op:'unset',path}]}})
  assert.doesNotThrow(()=>validateDshModelsRequest(request(['providers','custom'])))
  assert.throws(()=>validateDshModelsRequest(request(['providers'])))
  assert.throws(()=>validateDshModelsRequest(request(['providers','custom','models'])))
})
