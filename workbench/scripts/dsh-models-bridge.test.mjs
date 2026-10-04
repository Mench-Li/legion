import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_DSH_BASE_URL, forwardDshModels, normalizeDshBaseUrl, validateDshModelsRequest } from './dsh-models-bridge.mjs'
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

// ── Bug #1「供应商与模型无法读取」的回归锚 ────────────────────────────────
// 根因不在供应商，而在宿主地址被写死成 3080：Desktop 部署里宿主在别的端口
//（实测 19387），三个读取方法全部连不上，界面只拿到一句 `fetch failed`。
// 下面这几条把「地址随部署走」与「连不上时说得清楚」钉住。

test('宿主地址随部署走：注入 Desktop 宿主端口后不再打到 3080', async () => {
  const seen = []
  const value = await forwardDshModels({ method: 'llm/listConfigurableProviders', args: {} }, {
    baseUrl: 'http://127.0.0.1:19387',
    cookie: 'token=fixture',
    fetchImpl: async (url, request) => {
      seen.push(url)
      assert.equal(request.headers.cookie, 'token=fixture')
      return Response.json({ result: { ok: true, value: [{ provider: 'fjd-ds' }] } })
    },
  })
  assert.deepEqual(seen, ['http://127.0.0.1:19387/api/llm/listConfigurableProviders'])
  assert.equal(seen.some(url => url.includes(':3080')), false, '注入的地址不许被默认值盖掉')
  assert.deepEqual(value, [{ provider: 'fjd-ds' }])
})

test('宿主地址归一化：只接受 http(s)，只取 origin（带路径/尾斜杠不拼出畸形 URL）', () => {
  assert.equal(DEFAULT_DSH_BASE_URL, 'http://127.0.0.1:3080', '3080 只是 web profile 的兜底')
  assert.equal(normalizeDshBaseUrl('http://127.0.0.1:19387/'), 'http://127.0.0.1:19387')
  assert.equal(normalizeDshBaseUrl('  http://127.0.0.1:19387/api/  '), 'http://127.0.0.1:19387')
  assert.equal(normalizeDshBaseUrl('https://dsh.example'), 'https://dsh.example')
  for (const bad of ['', '   ', '127.0.0.1:19387', 'file:///tmp/x', 'ftp://host', null, 42, {}]) {
    assert.equal(normalizeDshBaseUrl(bad), '', `${JSON.stringify(bad)} 不该被当成宿主地址`)
  }
})

test('连不上宿主时给的是「哪个地址 + 为什么 + 下一步」，不是 fetch failed', async () => {
  await assert.rejects(
    forwardDshModels({ method: 'settings/describe', args: {} }, {
      baseUrl: 'http://127.0.0.1:19387',
      fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:19387'), { code: 'ECONNREFUSED' }) }) },
    }),
    (e) => e.status === 502
      && e.message.includes('http://127.0.0.1:19387/api/settings/describe')
      && e.message.includes('ECONNREFUSED')
      && e.message.includes('不是供应商的问题'),
  )
})

test('超时与连不上分开说：等待超时不等于地址写错', async () => {
  await assert.rejects(
    forwardDshModels({ method: 'settings/describe', args: {} }, {
      baseUrl: 'http://127.0.0.1:19387',
      fetchImpl: async () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e },
    }),
    (e) => e.status === 504 && e.message.includes('超时'),
  )
})

test('注入的地址不可解析时回落默认，而不是拼一个畸形地址发出去', async () => {
  const seen = []
  await forwardDshModels({ method: 'session/modelCatalog', args: {} }, {
    baseUrl: 'not a url',
    fetchImpl: async (url) => { seen.push(url); return Response.json({ result: { ok: true, value: null } }) },
  })
  assert.deepEqual(seen, ['http://127.0.0.1:3080/api/session/modelCatalog'])
})
