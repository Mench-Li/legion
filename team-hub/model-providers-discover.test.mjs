// ============================================================================
// 「获取可用模型」的**钥匙从哪来**（2026-10-12，将军实测报的 401）
//
// 现象（用户原话）：在「模型与凭证」里编辑具体的供应商、点「获取可用模型」，
// 弹框里报 **401**。而**钥匙本身是好的**（我拿 DSH 凭证文件里的真钥匙打过
// `GET /models` → 200，两种对话协议也 200）。
//
// 根因：那条路由从前**只认请求体里的 `apiKey`** —— 也就是"用户刚在表单里填的那一把"。
// 而编辑**已有**供应商时表单那格是空的（界面故意不回显值，见 BUG-028）
// ⇒ **不带钥匙**去问 `GET {baseURL}/models` ⇒ 网关回 401
// ⇒ 界面把那句 401 原样显示 ⇒ 读起来像"你的钥匙不对"。
//
//   > 一处"我没送钥匙"的缺口，与一处"钥匙被拒"的故障，
//   > 在供应商那一侧看到的都是 401 —— 而修法完全不同：
//   > 前者去填一次钥匙就好，后者要去控制台换钥匙。
//
// 这一组钉住三件事：
//   ① 三个来源的**优先级**（表单刚填 > 库里取的 > 没带）与返回值 `credentialFrom`；
//   ② 取不到时**具名**说清，且**不许**把值放进任何返回体；
//   ③ 库里那把钥匙**只在服务端**用于拼 Authorization，一次都不出现在响应里。
//
// 夹具：直接拿路由表调 `run`（`createModelProvidersRoutes` 返回 `{ routes }`），
// 用假 `json`/`handleRun`/`providerStore`/`discoverModels`/`probeService` ——
// 因为"钥匙从哪来"这件事**不该**依赖这台机器上真实的密钥库内容。
// ============================================================================
import test from 'node:test'
import assert from 'node:assert/strict'

import { createModelProvidersRoutes, discoverProviderModels } from './routes/model-providers.mjs'

/** 造一条路由实例，并把"谁被调用、带了什么钥匙"记下来。 */
function harness({ providers = [], vault = {} } = {}) {
  const seen = { discoverCalls: [], vaultReads: [], responses: [] }
  const providerStore = {
    get: (id) => providers.find((p) => p.id === id) ?? null,
    list: () => providers.slice(),
    isEmpty: () => providers.length === 0,
  }
  const routes = createModelProvidersRoutes({
    // 真实契约：`json(res, status, body)`；`handleRun(req, res, run)` 解析 body 并把它交给 run。
    json: (_res, status, body) => { seen.responses.push({ status, body }) },
    handleRun: async (_req, _res, run) => {
      try {
        const result = await run(seen.requestBody ?? {})
        seen.responses.push({ status: 200, body: { ok: true, ...result } })
      } catch (e) {
        seen.responses.push({ status: Number(e?.statusCode) || 400, body: { error: e instanceof Error ? e.message : String(e) } })
      }
    },
    providerStore,
    // ★ 注入的发现器：**记录它收到了哪把钥匙**（这是本组用例的观测点）。
    discoverModels: async ({ baseURL, apiKey }) => {
      seen.discoverCalls.push({ baseURL, apiKey })
      return ['m1', 'm2']
    },
    probeService: () => ({
      readCredentialValue: async (ref) => {
        seen.vaultReads.push(ref)
        return ref in vault
          ? { ok: true, value: vault[ref] }
          : { ok: false, code: 'CREDENTIAL_MISSING', message: '本机密钥库里没有这个引用' }
      },
    }),
  })
  const route = routes.routes.find((r) => r.path === '/api/model-providers/discover')
  assert.ok(route !== undefined, '/discover 那条路由必须在')
  return { seen, route }
}

const callDiscover = async (h, body) => {
  h.seen.requestBody = body
  await h.route.run({}, {})
  return h.seen.responses[h.seen.responses.length - 1]
}

const PROVIDERS = [
  { id: 'fjd-ds', secretRef: 'FJD_DS_API_KEY' },
  { id: 'no-ref', secretRef: null },
]
const VAULT = { FJD_DS_API_KEY: 'sk-from-vault-0123456789' }

test('① ★★★ 表单留空 ⇒ **自己去库里取**（这就是那个 401 的正解）', async () => {
  const h = harness({ providers: PROVIDERS, vault: VAULT })
  const r = await callDiscover(h, { actor: 'general', provider: 'fjd-ds', baseURL: 'https://v.example/v1' })
  assert.equal(r.status, 200)
  assert.deepEqual(h.seen.vaultReads, ['FJD_DS_API_KEY'], '按供应商的引用名去取，取一次')
  assert.equal(h.seen.discoverCalls[0].apiKey, VAULT.FJD_DS_API_KEY, '★ 真正发出去的是**库里那把**')
  assert.equal(r.body.credentialFrom, 'vault', '要如实回报钥匙从哪来')
  // ★ 值**不许**进响应体
  assert.equal(JSON.stringify(r.body).includes(VAULT.FJD_DS_API_KEY), false, '钥匙值不许出现在响应里')
  assert.deepEqual(r.body.models, [{ id: 'm1' }, { id: 'm2' }])
})

test('② ★★ 表单刚填的那把**优先于**库里的（"我要换一把"的意图）', async () => {
  const h = harness({ providers: PROVIDERS, vault: VAULT })
  const r = await callDiscover(h, { actor: 'general', provider: 'fjd-ds', baseURL: 'https://v.example/v1', apiKey: 'sk-user-just-typed' })
  assert.equal(h.seen.discoverCalls[0].apiKey, 'sk-user-just-typed')
  assert.deepEqual(h.seen.vaultReads, [], '表单填了就不该再去开库')
  assert.equal(r.body.credentialFrom, 'request')
  assert.equal(JSON.stringify(r.body).includes('sk-user-just-typed'), false, '值不进响应')
})

test('③ ★★★ 取不到时**具名说清**，并明确回报"没带钥匙"（绝不谎报成"带了一把"）', async () => {
  const h = harness({ providers: PROVIDERS, vault: {} })   // 库里没有这条
  const r = await callDiscover(h, { actor: 'general', provider: 'fjd-ds', baseURL: 'https://v.example/v1' })
  assert.equal(r.status, 200)
  assert.equal(r.body.credentialFrom, 'unavailable')
  assert.match(String(r.body.credentialNote), /没有这个引用/)
  assert.equal(h.seen.discoverCalls[0].apiKey, null, '取不到就**不带钥匙**发出去（而不是拿别的凑）')
})

test('④ ★★ 没点名供应商（老调用方）⇒ `credentialFrom: none`，且**不按 baseURL 反查**', async () => {
  // ★ 为什么刻不允许反查：fjd-ds 与 svea-ds **共用同一个 baseURL**（同一个网关），
  //   反查会取到另一条的钥匙 —— 那种错误不报错，只是"用错了钥匙"。
  const h = harness({ providers: PROVIDERS, vault: VAULT })
  const r = await callDiscover(h, { actor: 'general', baseURL: 'https://v.example/v1' })
  assert.equal(r.body.credentialFrom, 'none')
  assert.deepEqual(h.seen.vaultReads, [], '没有 id 就不许猜是哪一条')
  assert.equal(h.seen.discoverCalls[0].apiKey, null)
})

test('⑤ ★ 供应商还没有引用名 ⇒ 说清该做什么，而不是回一句 401', async () => {
  const h = harness({ providers: PROVIDERS, vault: VAULT })
  const r = await callDiscover(h, { actor: 'general', provider: 'no-ref', baseURL: 'https://v.example/v1' })
  assert.equal(r.body.credentialFrom, 'none')
  assert.match(String(r.body.credentialNote), /还没有引用名/)
})

test('⑥ ★ 供应商不存在 ⇒ 也不崩，如实回报没带钥匙', async () => {
  const h = harness({ providers: PROVIDERS, vault: VAULT })
  const r = await callDiscover(h, { actor: 'general', provider: 'ghost', baseURL: 'https://v.example/v1' })
  assert.equal(r.status, 200)
  assert.equal(r.body.credentialFrom, 'none')
  assert.match(String(r.body.credentialNote), /还没有引用名/)
})

// ── 纯函数那一侧：401 的**话**要分得开 ─────────────────────────────────────
//
// 与 ① 是同一件事的两端：路由负责"把钥匙送到"，这一条负责"送不到时说的话是对的"。

test('⑦ ★★★ 没带钥匙时的 401 必须说"没送钥匙"，而不是"钥匙不对"', async () => {
  const unauthorized = async () => ({ status: 401, ok: false, text: async () => 'unauthorized' })
  // 没带钥匙
  await assert.rejects(
    () => discoverProviderModels({ baseURL: 'https://v.example/v1', fetchImpl: unauthorized }),
    (e) => {
      assert.match(e.message, /HTTP 401/)
      assert.match(e.message, /没有带钥匙/, '★ 必须点明"这次没带钥匙"')
      assert.match(e.message, /不是"钥匙不对"/, '★ 必须与"钥匙被拒"分开')
      return true
    },
  )
  // 带了钥匙（被拒）⇒ 不许说"没带钥匙"
  await assert.rejects(
    () => discoverProviderModels({ baseURL: 'https://v.example/v1', apiKey: 'sk-wrong', fetchImpl: unauthorized }),
    (e) => {
      assert.match(e.message, /HTTP 401/)
      assert.doesNotMatch(e.message, /没有带钥匙/, '带了钥匙就不许说没带')
      return true
    },
  )
})

test('⑧ ★ 非 401 的失败不掺这句话（如 500 是供应商的问题）', async () => {
  const boom = async () => ({ status: 500, ok: false, text: async () => 'boom' })
  await assert.rejects(
    () => discoverProviderModels({ baseURL: 'https://v.example/v1', fetchImpl: boom }),
    (e) => { assert.doesNotMatch(e.message, /没有带钥匙/); return true },
  )
})
