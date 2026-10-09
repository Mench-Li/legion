// ============================================================================
// P2（docs/DECISION-legion-owns-model-config.md）：**影子物化 —— 只报告，不写**
//
// 这一组要钉住的是三件在别处会被读成"没事"的事：
//
//   ① **它真的一个字节都没写。** 夹具把 `settings.mutate` / `credentials.set` / `credentials.unset`
//      换成"一被调用就记名 + 抛"的探针 ⇒ 任何一次误写立刻红。
//      这条纪律的文字版容易写（"P2 只报告"），而**只有探针能让它可验**。
//   ② **要删的那几条必须被点名。** 这是 P2 存在的唯一理由：
//      接管会 unset 掉"Legion 里没有、DSH 里活着"的供应商，而那可能删掉别人正在用的东西。
//      "新增/修改"报得再全，也不替代这一行。
//   ③ **读不到 DSH 现状时不许说 clean。** 两侧都空会让 diff 干净 ——
//      于是"读失败"会伪装成"完全一致"。这正是本仓反复出现的那一族错
//      （BUG-009-a 的探测器、BUG-010 的假停摆、P1 的幂等读数），所以它单列一个用例。
//
// 另有一组纯函数判据（`planMaterialization`）：字段映射（`secretRef` ↔ `apiKeyEnv`）、
// 型号比较对**顺序不敏感**、以及"少一个字段就要报出是哪个字段"。
// ============================================================================
import test from 'node:test'
import assert from 'node:assert/strict'

import { planMaterialization, describeMaterializationPlan, normalizeForCompare, changedFields } from './materialize-plan.mjs'
import { runShadowMaterialization } from './shadow-materialize.mjs'

// ── 纯函数那一组 ───────────────────────────────────────────────────────────

const LEGION = [
  { id: 'fjd-ds', displayName: 'FJD', api: 'openai-responses', baseURL: 'https://a.example/v1', secretRef: 'FJD_DS_API_KEY', models: [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }] },
]
const DSH = [
  { id: 'fjd-ds', displayName: 'FJD', api: 'openai-responses', baseURL: 'https://a.example/v1', apiKeyEnv: 'FJD_DS_API_KEY', credentialConfigured: true, models: [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }] },
]

test('① 字段名不同不算差异：`secretRef` ↔ `apiKeyEnv` 要映射成同一个东西', () => {
  const plan = planMaterialization({ desired: LEGION, actual: DSH })
  assert.deepEqual(plan.counts, { create: 0, update: 0, delete: 0, unchanged: 1 })
  assert.equal(plan.clean, true, '两侧是同一件事时必须是 clean —— 否则影子对账每轮都报差异，人会把它关掉')
  // 反向锚：如果映射丢了，这里会变成"永远有差异"
  const noMap = normalizeForCompare({ id: 'x', secretRef: 'A' })
  const noMap2 = normalizeForCompare({ id: 'x', apiKeyEnv: 'A' })
  assert.deepEqual(noMap, noMap2, '两个名字必须归一化到同一个键')
})

test('② 型号比较对**顺序不敏感**（顺序不是变化）', () => {
  const shuffled = [{ ...DSH[0], models: [{ id: 'm2', name: 'M2' }, { id: 'm1', name: 'M1' }] }]
  const plan = planMaterialization({ desired: LEGION, actual: shuffled })
  assert.equal(plan.clean, true, '型号顺序变了不是配置变化')
  // 输入模态同理
  const a = normalizeForCompare({ id: 'x', models: [{ id: 'm', input: ['text', 'image'] }] })
  const b = normalizeForCompare({ id: 'x', models: [{ id: 'm', input: ['image', 'text'] }] })
  assert.deepEqual(a, b)
})

test('③ 真差异要**指明是哪个字段**，不是只说"这条变了"', () => {
  const changed = [{ ...DSH[0], baseURL: 'https://b.example/v1', displayName: 'FJD 2' }]
  const plan = planMaterialization({ desired: LEGION, actual: changed })
  assert.equal(plan.counts.update, 1)
  assert.deepEqual(plan.update[0], { id: 'fjd-ds', fields: ['displayName', 'baseURL'] })
  assert.equal(changedFields(normalizeForCompare(changed[0]), normalizeForCompare(LEGION[0])).join(','), 'displayName,baseURL')
})

test('④ ★ 要删的那几条必须被点名（P2 存在的唯一理由）', () => {
  const extra = [...DSH, { id: 'svea-ds', displayName: 'SVEA', api: 'openai-completions', apiKeyEnv: 'SVEA_DS_API_KEY', credentialConfigured: true, models: [{ id: 'm9' }] }]
  // Legion 里**没有** svea-ds ⇒ 接管会把它 unset 掉
  const plan = planMaterialization({ desired: LEGION, actual: extra })
  assert.equal(plan.clean, false)
  assert.deepEqual(plan.delete, ['svea-ds'], 'DSH 有而 Legion 没有的，必须出现在"会被删掉"里')
  const line = describeMaterializationPlan(plan)
  assert.match(line, /接管会删掉/)
  assert.match(line, /svea-ds/, 'id 必须写在同一行里 —— 藏在下一行就等于没有')
})

test('⑤ Legion 空 ⇒ 整份 DSH 目录都会被删（最危险的那一态必须可见）', () => {
  const plan = planMaterialization({ desired: [], actual: DSH })
  assert.equal(plan.clean, false)
  assert.deepEqual(plan.delete, ['fjd-ds'])
  assert.match(describeMaterializationPlan(plan), /接管会删掉/)
})

test('⑥ 缺凭证只按**引用名**报，且不认识值', () => {
  const notConfigured = [{ ...DSH[0], credentialConfigured: false }]
  const plan = planMaterialization({ desired: LEGION, actual: notConfigured })
  assert.deepEqual(plan.credentialsNeeded, ['FJD_DS_API_KEY'])
  assert.equal(JSON.stringify(plan).includes('sk-'), false)
  // DSH 侧已配 ⇒ 不报
  assert.deepEqual(planMaterialization({ desired: LEGION, actual: DSH }).credentialsNeeded, [])
  // 调用方给的权威读数优先于快照
  assert.deepEqual(planMaterialization({ desired: LEGION, actual: DSH, actualCredentials: { FJD_DS_API_KEY: false } }).credentialsNeeded, ['FJD_DS_API_KEY'])
})

// ── 执行那一组：只报告，不写 ────────────────────────────────────────────────

/** 一个会**记名并抛**的写探针：任何一次误写都会让用例红，而不是静默成功。 */
function mutationsProbe() {
  const touched = []
  const boom = (name) => async () => { touched.push(name); throw new Error(`影子模式不许调用 ${name}（它是一次写）`) }
  return {
    touched,
    settings: { describe: () => [], mutate: boom('settings.mutate') },
    credentials: { describe: async () => ({ configured: true }), set: boom('credentials.set'), unset: boom('credentials.unset') },
  }
}

function fakeCtx({ providers = [], reason = '', probe = mutationsProbe() } = {}) {
  return {
    probe,
    get: (k) => {
      if (k === 'llm') {
        return {
          listProviders: () => providers.map((p) => ({ id: p.id, name: p.displayName })),
          listConfigurableProviders: () => providers.map((p) => ({ provider: p.id, displayName: p.displayName, settingsNs: 'llm-pi-ai', settingsPath: ['providers', p.id] })),
          listModels: async (id) => (providers.find((p) => p.id === id)?.models ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id })),
        }
      }
      if (k === 'settings') {
        return {
          describe: () => [{
            ns: 'llm-pi-ai',
            value: { providers: Object.fromEntries(providers.map((p) => [p.id, { displayName: p.displayName, api: p.api, baseURL: p.baseURL, apiKeyEnv: p.apiKeyEnv ?? p.secretRef }])) },
          }],
          mutate: probe.settings.mutate,
        }
      }
      if (k === 'credentials') return probe.credentials
      return null
    },
  }
}

function fakeHub(providers) {
  return async () => ({ status: 200, text: async () => JSON.stringify({ ok: true, providers, empty: providers.length === 0 }) })
}

test('⑦ ★ 影子对账对"完全一致"的两侧：报 clean，且**一次写都没发生**', async () => {
  const ctx = fakeCtx({ providers: DSH })
  const lines = []
  const r = await runShadowMaterialization({ ctx, hubUpstream: 'http://hub.test', fetchImpl: fakeHub(LEGION), log: (m) => lines.push(m) })
  assert.equal(r.ok, true)
  assert.equal(r.plan.clean, true)
  assert.deepEqual(ctx.probe.touched, [], '影子模式一次都不许碰 mutate/set/unset')
  assert.match(lines.join('\n'), /clean=true/)
})

test('⑧ ★ 有差异时：照样**一次写都没有**，而"会被删掉"出现在读数里', async () => {
  const withExtra = [...DSH, { id: 'svea-ds', displayName: 'SVEA', api: 'openai-completions', secretRef: 'SVEA_DS_API_KEY', credentialConfigured: true, models: [{ id: 'm9' }] }]
  const ctx = fakeCtx({ providers: withExtra })
  const lines = []
  const r = await runShadowMaterialization({ ctx, hubUpstream: 'http://hub.test', fetchImpl: fakeHub(LEGION), log: (m) => lines.push(m) })
  assert.equal(r.plan.clean, false)
  assert.deepEqual(r.plan.delete, ['svea-ds'])
  assert.deepEqual(ctx.probe.touched, [], '有差异时更不许写 —— 那正是"先看见再决定"的意思')
  assert.match(lines.join('\n'), /接管会删掉.*svea-ds/s)
})

test('⑨ ★ 读不到 DSH 现状 ⇒ **不许说 clean**（读失败不许伪装成"完全一致"）', async () => {
  // 宿主没有 llm 服务：快照为空 + 有 reason
  const noLlm = { get: () => null }
  const lines = []
  const r = await runShadowMaterialization({ ctx: noLlm, hubUpstream: 'http://hub.test', fetchImpl: fakeHub(LEGION), log: (m) => lines.push(m) })
  assert.equal(r.ok, false, '读不到 DSH 现状 ⇒ ok=false')
  assert.equal(r.actualReadOk, false)
  assert.match(lines.join('\n'), /读不到 DSH 现状/)
  assert.match(lines.join('\n'), /不是 clean/)
  // 对照：**真的没有供应商**（reason 为空）是"读到了、就是空"，那时才是可对账的
  const reallyEmpty = fakeCtx({ providers: [], reason: '' })
  const r2 = await runShadowMaterialization({ ctx: reallyEmpty, hubUpstream: 'http://hub.test', fetchImpl: fakeHub([]), log: () => {} })
  assert.equal(r2.actualReadOk, true, '"宿主说没有供应商"与"读不出来"必须分得开')
})

test('⑩ 读不到 Legion 目录 ⇒ 也不说 clean，且不写', async () => {
  const ctx = fakeCtx({ providers: DSH })
  const lines = []
  const brokenHub = async () => ({ status: 500, text: async () => 'boom' })
  const r = await runShadowMaterialization({ ctx, hubUpstream: 'http://hub.test', fetchImpl: brokenHub, log: (m) => lines.push(m) })
  assert.equal(r.ok, false)
  assert.equal(r.legionReadOk, false)
  assert.deepEqual(ctx.probe.touched, [])
  assert.match(lines.join('\n'), /读不到 Legion 的目录/)
})

test('⑪ 请求带令牌，且**不**把密钥值放进任何请求体（影子模式没有值可写）', async () => {
  const seen = []
  const hub = async (url, init) => {
    seen.push({ url: String(url), init })
    return { status: 200, text: async () => JSON.stringify({ ok: true, providers: LEGION, empty: false }) }
  }
  await runShadowMaterialization({ ctx: fakeCtx({ providers: DSH }), hubUpstream: 'http://hub.test', teamHubToken: 'T0K', fetchImpl: hub, log: () => {} })
  assert.equal(seen.length, 1, '影子模式只读一次 Legion 目录就够，不该有第二个请求')
  assert.equal(seen[0].init.method, 'GET')
  assert.equal(seen[0].init.headers.authorization, 'Bearer T0K')
  assert.match(seen[0].url, /token=T0K/)
  assert.equal(seen[0].init.body, undefined, 'GET 不许带体：影子模式没有任何东西要写')
})
