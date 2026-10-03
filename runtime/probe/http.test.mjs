// runtime/probe/http.test.mjs
// ============================================================================
// 真实 HTTP transport（PRT-504）
//
// 这一组起一个**真的本机 HTTP 服务**。理由是：假 transport 全绿只证明
// "分类对"，不证明"真 transport 能把真实响应归一化成正确的 {kind, status}"。
// 上一次这个区别很关键——`{kind:'http', status:401}` 与 `fetch` 实际拿到的
// 401 之间隔着响应解析、重定向、正文读取这些步骤，每一步都能把码搞错。
// ============================================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import {
  CAPABILITY_EVIDENCE,
  LONG_CONTEXT_MIN_TOKENS,
  capabilitiesFromModelRecord,
  createHttpTransport,
  findModelRecord,
  hasModelList,
} from './http.mjs'

let server
let base = ''
/** 每次请求记录到这里的路径与认证头，供断言。 */
let seen = []

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(text)
}

before(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization ?? null })
    // /v1/models 的正常清单
    if (req.url === '/v1/models') {
      if (req.headers.authorization !== 'Bearer good-key') return json(res, 401, { error: 'bad key' })
      return json(res, 200, {
        data: [
          { id: 'plain-model' },
          {
            id: 'rich-model',
            supported_parameters: ['tools', 'response_format', 'reasoning', 'unknown-param'],
            architecture: { input_modalities: ['text', 'image'] },
            context_length: 200_000,
          },
          { id: 'small-model', context_length: 8_000 },
        ],
      })
    }
    if (req.url === '/nolist/v1/models') return json(res, 200, { object: 'model', id: 'solo' })
    if (req.url === '/html/v1/models') {
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end('<html>login</html>')
    }
    if (req.url === '/ratelimit/v1/models') {
      res.writeHead(429, { 'retry-after': '3' })
      return res.end('slow down')
    }
    if (req.url === '/boom/v1/models') return json(res, 503, { error: 'upstream' })
    if (req.url === '/forbidden/v1/models') return json(res, 403, { error: 'nope' })
    res.writeHead(400)
    return res.end('bad')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => {
  try { server.closeAllConnections?.() } catch { /* 无连接 */ }
  try { server.close() } catch { /* 已关闭 */ }
})

const profile = (endpoint, model = 'plain-model') => ({
  id: 'm1', displayName: 'x', runtimeType: 'dsh', provider: 'byok',
  model, endpoint: `${base}${endpoint}`, secretRef: 'legion/k', reasoningEffort: 'medium', limits: {},
})

// ------------------------------------------------------------------ ① 连通与鉴权

test('① 真实 200 + 正确钥匙 → 通过，且能力来自响应里的**证据**', async () => {
  seen = []
  const t = createHttpTransport()
  const obs = await t({ profile: profile('/'), credential: 'good-key' })
  assert.equal(obs.kind, 'http')
  assert.equal(obs.status, 200)
  assert.ok(obs.latencyMs >= 0)
  // 钥匙必须以 Bearer 发出（否则"鉴权验证"根本没验）
  assert.equal(seen[0].auth, 'Bearer good-key')
  assert.equal(seen[0].url, '/v1/models')
})

test('① 列表里的模型 id 对不上 → MODEL_NOT_FOUND（真响应，不是构造的）', async () => {
  const t = createHttpTransport()
  const obs = await t({ profile: profile('/', 'typo-model'), credential: 'good-key' })
  assert.equal(obs.kind, 'http')
  assert.equal(obs.status, 404, '清单里没有这个 id 就是"不认这个模型"')
})

test('① 真实 401 / 403 → AUTH_FAILED（经由执行器分类）', async () => {
  const t = createHttpTransport()
  const bad = await t({ profile: profile('/'), credential: 'wrong-key' })
  assert.equal(bad.status, 401)
  const forbidden = await t({ profile: profile('/forbidden'), credential: 'good-key' })
  assert.equal(forbidden.status, 403)
})

test('① 真实 429 / 503 → 限流与供应商错（分类不同）', async () => {
  const t = createHttpTransport()
  const rl = await t({ profile: profile('/ratelimit'), credential: 'good-key' })
  assert.equal(rl.status, 429)
  const boom = await t({ profile: profile('/boom'), credential: 'good-key' })
  assert.equal(boom.status, 503)
})

test('① 200 但正文是 HTML → kind:parse（这不是一个模型 API）', async () => {
  const t = createHttpTransport()
  const obs = await t({ profile: profile('/html'), credential: 'good-key' })
  assert.equal(obs.kind, 'parse', '答了 200 但不是 JSON，必须与"成功"分开')
})

test('① 真的连不上会**抛出**（由执行器的归一化负责分类，只有一份实现）', async () => {
  const t = createHttpTransport()
  await assert.rejects(
    () => t({ profile: profile('http://127.0.0.1:1/'), credential: 'k' }),
    '连不上必须抛，而不是返回一个假的观测',
  )
})

test('① 超时/中止也抛出，由执行器判成 cancelled 或 timeout', async () => {
  const t = createHttpTransport({ fetchImpl: async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }) } })
  await assert.rejects(() => t({ profile: profile('/'), credential: 'k' }), (e) => e.name === 'AbortError')
})

test('① 没有 fetch 就构造不出来（"没探测过"不能被当成"可用"）', () => {
  // 传了非函数 → 立刻失败。这是配置错误，不能等到第一次探测时才炸。
  assert.throws(() => createHttpTransport({ fetchImpl: 42 }), TypeError)
  assert.throws(() => createHttpTransport({ fetchImpl: {} }), TypeError)
  // 显式省略 / null 会回落到全局 fetch（Node 18+ 有）——这是**有意**的：
  // null 的含义是"没提供"，而不是"提供一个空的"。真正的失败模式是
  // 运行环境根本没有 fetch，那时构造必须抛。
  const saved = globalThis.fetch
  try {
    // @ts-expect-error 故意制造"宿主没有 fetch"的场景
    delete globalThis.fetch
    assert.throws(() => createHttpTransport(), TypeError,
      '宿主没有 fetch 时构造必须失败，而不是留一个永远探测不了的探针')
  } finally {
    globalThis.fetch = saved
  }
})

test('① endpoint 末尾斜杠不会拼出双斜杠路径', async () => {
  seen = []
  const t = createHttpTransport()
  await t({ profile: { ...profile('/'), endpoint: `${base}/` }, credential: 'good-key' })
  assert.equal(seen[0].url, '/v1/models')
})

test('① 无凭证时不发 Authorization 头（本地模型不该被塞一个空 Bearer）', async () => {
  seen = []
  const t = createHttpTransport()
  await t({ profile: profile('/'), credential: null })
  assert.equal(seen[0].auth, null)
})

// ------------------------------------------------------------------ ② 能力证据

test('② 能力必须**有据可依**：只提取响应明确写了的东西', () => {
  const rich = {
    id: 'rich-model',
    supported_parameters: ['tools', 'response_format', 'reasoning', 'unknown-param'],
    architecture: { input_modalities: ['text', 'image'] },
    context_length: 200_000,
  }
  const { capabilities, evidence } = capabilitiesFromModelRecord(rich)
  assert.deepEqual(Object.keys(capabilities).sort(),
    ['chat', 'json', 'long-context', 'reasoning', 'tools', 'vision'])
  // 未知的 supported_parameter 被忽略（不猜）
  assert.ok(evidence.includes(CAPABILITY_EVIDENCE.SUPPORTED_PARAMETERS))

  // 只有 id → 只能说明它是聊天模型
  const bare = capabilitiesFromModelRecord({ id: 'plain-model' })
  assert.deepEqual(Object.keys(bare.capabilities), ['chat'])
})

test('② 没有证据就是空表，**不是**一张猜测的能力表', () => {
  // 猜错成"支持 tools"会让依赖工具调用的运行在半途崩；
  // 猜错成"不支持"会让能用的模型被排除。两种都比"不知道"更糟。
  for (const rec of [null, undefined, {}, 'x', 42, [], { object: 'model' }]) {
    const { capabilities, evidence } = capabilitiesFromModelRecord(rec)
    assert.deepEqual(Object.keys(capabilities), [], `${JSON.stringify(rec)} 不得凭空产生能力`)
    assert.deepEqual(evidence, [])
  }
  assert.equal(CAPABILITY_EVIDENCE.NONE, 'no-evidence')
})

test('② 长上下文有门槛，卡在门槛下不算', () => {
  const ctxOf = (rec) => capabilitiesFromModelRecord(rec).capabilities['long-context']
  assert.equal(ctxOf({ id: 'a', context_length: LONG_CONTEXT_MIN_TOKENS }), true)
  assert.equal(ctxOf({ id: 'a', context_length: LONG_CONTEXT_MIN_TOKENS - 1 }), undefined)
  // 也认 top_provider.context_length
  assert.equal(ctxOf({ id: 'a', top_provider: { context_length: 500_000 } }), true)
  // 非数字不算
  assert.equal(ctxOf({ id: 'a', context_length: '99999999' }), undefined)
})

test('② 未知能力名不得进入结果（能力集是封闭的）', () => {
  const { capabilities } = capabilitiesFromModelRecord({
    id: 'a',
    supported_parameters: ['tools', 'telepathy', 'time_travel'],
  })
  assert.deepEqual(Object.keys(capabilities).sort(), ['chat', 'tools'])
})

test('② 清单载荷形状的识别：data / models / 都不是', () => {
  assert.equal(hasModelList({ data: [] }), true)
  assert.equal(hasModelList({ models: [] }), true)
  assert.equal(hasModelList({ object: 'model', id: 'solo' }), false)
  assert.equal(hasModelList(null), false)
  assert.equal(hasModelList({ data: 'nope' }), false)

  assert.equal(findModelRecord({ data: [{ id: 'a' }, { id: 'b' }] }, 'b')?.id, 'b')
  assert.equal(findModelRecord({ data: [{ id: 'a' }] }, 'z'), null)
  assert.equal(findModelRecord({ object: 'model' }, 'a'), null)
  assert.equal(findModelRecord(null, 'a'), null)
})

test('② 载荷**没有**清单时不去判模型不存在（代理常只返回单个对象）', async () => {
  const t = createHttpTransport()
  const obs = await t({ profile: profile('/nolist', 'solo'), credential: 'good-key' })
  assert.equal(obs.kind, 'http')
  assert.equal(obs.status, 200, '没有清单可对时不能凭空判"模型不存在"')
  assert.deepEqual(Object.keys(obs.capabilities), [], '也不得凭空产生能力')
})

test('② verifyModelId:false 时跳过模型 id 校验（只验连通与鉴权）', async () => {
  const t = createHttpTransport({ verifyModelId: false })
  const obs = await t({ profile: profile('/', 'typo-model'), credential: 'good-key' })
  assert.equal(obs.status, 200)
})

test('② 真实响应里挖出的能力经执行器判定：够用则通过、不够则 CAPABILITY_MISSING', async () => {
  const { createModelProbe } = await import('./index.mjs')
  const probe = createModelProbe({
    transport: createHttpTransport(),
    resolveSecret: async () => 'good-key',
  })
  // rich-model 有 tools
  const richOk = await probe.probe({ profile: profile('/', 'rich-model'), requiredCapabilities: ['tools', 'vision'] })
  assert.equal(richOk.ok, true, JSON.stringify(richOk))
  assert.deepEqual(Object.keys(richOk.capabilities).sort(),
    ['chat', 'json', 'long-context', 'reasoning', 'tools', 'vision'])

  // plain-model 只有 chat —— 要求 tools 必须失败
  const plainFail = await probe.probe({ profile: profile('/', 'plain-model'), requiredCapabilities: ['tools'] })
  assert.equal(plainFail.ok, false)
  assert.equal(plainFail.code, 'CAPABILITY_MISSING')
  assert.deepEqual([...plainFail.missingCapabilities], ['tools'])
})

test('② 错误的钥匙经真实 HTTP 后落到 AUTH_FAILED，而不是 SECRET_UNAVAILABLE', async () => {
  const { createModelProbe } = await import('./index.mjs')
  const probe = createModelProbe({
    transport: createHttpTransport(),
    // 解析成功（本地没问题），供应商拒绝
    resolveSecret: async () => 'wrong-key',
  })
  const v = await probe.probe({ profile: profile('/') })
  assert.equal(v.code, 'AUTH_FAILED')
  assert.equal(v.class, 'config')
  assert.match(v.message, /本机密钥库是好的/, '要指向供应商侧的动作')
})
