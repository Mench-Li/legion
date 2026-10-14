// ============================================================================
// P1 的**只读那一半**：从宿主进程内读出 "DSH 现在活着的供应商目录"，并在
// **Legion 目录为空时**把它收进来一次。
//
// 这一组用**纯假件**（假的 ctx / llm / settings / credentials / fetch）来钉：
//
//   ① 快照的形状与值：id / displayName / api / baseURL / **引用名** / 型号清单
//   ② **永不读密钥值**：只调 `credentials.describe()`（返回 `{configured}`），
//      快照里**不许**出现任何像密钥的字符串（这是本条的密钥纪律，必须能被验）
//   ③ "活着"以 `llm.listProviders()` 为准：**活着但没声明**的供应商也要收进来
//      （否则一个引擎认得的供应商会因为"配置文件里没写"而消失）
//   ④ 服务缺席 ⇒ 返回空 + 原因，**不抛**（软取：它只是增强，不该有能力拖坏启动）
//   ⑤ 引导导入只在**空**目录时发生；非空 ⇒ 一次写都不发
//      —— 这是 DECISION §3 的方向纪律：DSH 侧被手改**不会**改写 Legion
//   ⑥ 中枢不可达/拒绝 ⇒ 只记日志、不抛
//
// 为什么用假件而不是真宿主：真宿主里这三个服务由 DSH 组装，
// 跑不起来的那些分支（服务缺席、describe 抛错）恰恰是软取要守的分支 ——
// 而它们在生产里**很难**被制造出来。
// ============================================================================
import test from 'node:test'
import assert from 'node:assert/strict'

import { maybeBootstrapProviderImport, readDshProviderSnapshot } from './index.js'

/** 一个"DSH 活着"的最小假件集：两个供应商，其中一个**没有**声明配置。 */
function fakeCtx({ withServices = true, describeThrows = false } = {}) {
  const services = {
    llm: {
      listProviders: () => [{ id: 'fjd-ds', name: 'FJD' }, { id: 'undeclared-ds', name: 'Undeclared' }],
      listConfigurableProviders: () => [
        { provider: 'fjd-ds', displayName: 'FJD', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'fjd-ds'], declared: true },
      ],
      listModels: async (id) => (id === 'fjd-ds'
        ? [
          { provider: 'fjd-ds', id: 'deepseek-v4-pro-openai', name: 'pro', inputModalities: ['text', 'image'] },
          { provider: 'fjd-ds', id: 'deepseek-v4-flash-openai', name: 'flash', inputModalities: ['text'] },
        ]
        : [{ provider: id, id: 'm-1', name: 'm-1', inputModalities: ['text'] }]),
    },
    settings: {
      describe: () => {
        if (describeThrows) throw new Error('settings 还没就绪')
        return [{
          ns: 'llm-pi-ai',
          revision: 7,
          value: {
            providers: {
              'fjd-ds': {
                displayName: 'FJD', api: 'openai-responses', baseURL: 'https://fjbigmodel.fjdac.cn/v1',
                apiKeyEnv: 'FJD_DS_API_KEY', models: [{ id: 'deepseek-v4-pro-openai' }],
              },
            },
          },
        }]
      },
    },
    credentials: {
      // ★ 只回报"配没配"，**值不经过这里**：这就是"永不读值"的可验证形态。
      describe: async (ref) => ({ configured: ref === 'FJD_DS_API_KEY' }),
    },
  }
  return { get: (k) => (withServices ? services[k] ?? null : null) }
}

test('① 快照：id/显示名/协议/地址/引用名/型号清单都要对', async () => {
  const { providers, reason } = await readDshProviderSnapshot(fakeCtx())
  assert.equal(reason, '')
  const fjd = providers.find((p) => p.id === 'fjd-ds')
  assert.equal(fjd.displayName, 'FJD')
  assert.equal(fjd.api, 'openai-responses')
  assert.equal(fjd.baseURL, 'https://fjbigmodel.fjdac.cn/v1')
  assert.equal(fjd.secretRef, 'FJD_DS_API_KEY', 'secretRef 必须是**引用名**')
  assert.equal(fjd.credentialConfigured, true)
  assert.deepEqual(fjd.models.map((m) => m.id), ['deepseek-v4-pro-openai', 'deepseek-v4-flash-openai'])
  assert.deepEqual(fjd.models[0].input, ['text', 'image'], '输入模态要保住：它是目录的一部分')
})

test('② 永不读密钥值：快照里不许出现任何像密钥的东西，且只调 describe', async () => {
  const seen = []
  const ctx = fakeCtx()
  const baseGet = ctx.get
  const patched = {
    get: (k) => {
      const svc = baseGet(k)
      if (k === 'credentials') {
        return {
          describe: async (ref) => { seen.push(ref); return { configured: true } },
          resolve: async () => { throw new Error('**resolve 绝不该被调用**：它返回的是密钥本身') },
        }
      }
      return svc
    },
  }
  const { providers } = await readDshProviderSnapshot(patched)
  assert.deepEqual(seen, ['FJD_DS_API_KEY'], '只按引用名问"配没配"')
  const dump = JSON.stringify(providers)
  assert.equal(/resolve|sk-|secret\s*[:=]/i.test(dump), false, '快照里不许出现密钥形态或 resolve 的产物')
  assert.equal(dump.includes('FJD_DS_API_KEY'), true, '引用名本身要留下来（它是 P3 物化时的接线）')
})

test('③ 活着但没声明的供应商也要收进来（"引擎认得它"才是要紧的事实）', async () => {
  const { providers } = await readDshProviderSnapshot(fakeCtx())
  const undeclared = providers.find((p) => p.id === 'undeclared-ds')
  assert.ok(undeclared, 'undeclared-ds 活着却没声明 —— 它必须仍在快照里')
  assert.equal(undeclared.api, null, '没声明就是 null，不编一个协议')
  assert.equal(undeclared.baseURL, null)
  assert.equal(undeclared.secretRef, null)
  assert.equal(undeclared.credentialConfigured, false)
  assert.deepEqual(undeclared.models.map((m) => m.id), ['m-1'], '它的型号也要收（模型来自 llm，不来自配置）')
})

// ══════════════════════════════════════════════════════════════════════════
// ③b ★★★ `declaredInSettings` 的判据是**那一节有没有内容**，不是"引擎有没有登记它"
//
// 首版写的是 `declared.some(d => d.provider === p.id)`，而实测：
// **`deepseek-official` 也被 `llm.listConfigurableProviders()` 列了出来**
// （每条内置路线都会登记自己，带 settingsNs）⇒ 被判成"有声明" ⇒ 进正常比较。
// 可它的 `api`/`baseURL` 是 `llm-deepseek` 的**内置默认值**（快照读到 null），
// 于是 **Legion 一旦把真实端点记下来**（为了让「测试连接」能用），两边就永远不等
// ⇒ 每轮报一处 `update`、门永远 clean 不了。
//
//   > 一处"我在配置里没写、端点由引擎内置"的条目，
//   > 与一处"我写了、只是字段恰好为空"的条目，
//   > 在快照里的区别只有**那一节到底有没有内容** ——
//   > 而它们的处置必须相反：后者要用户去补，前者**任何东西都不许写**。
// ══════════════════════════════════════════════════════════════════════════

/** 造一个"引擎登记了它、但那一节是空的"上下文（= 内置路线的真实形状）。 */
function engineRegisteredCtx() {
  const services = {
    llm: {
      listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
      // ★ 关键：**登记了**，settingsNs/settingsPath 都在，看起来像"有声明"
      listConfigurableProviders: () => [
        { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
      ],
      listModels: async () => [{ id: 'deepseek-flash', name: 'DeepSeek-V41-Flash', inputModalities: ['text', 'image'] }],
    },
    settings: {
      // 那一节是**空的**：api/baseURL/apiKeyEnv 一个都没有（值在插件默认里）
      describe: () => [{ ns: 'llm-deepseek', revision: 1, value: {} }],
    },
    credentials: { describe: async () => ({ configured: false }) },
  }
  return { get: (k) => services[k] ?? null }
}

test('③b ★★★ 引擎登记了但那一节是空的 ⇒ `declaredInSettings: false`（不是"有声明"）', async () => {
  const { providers } = await readDshProviderSnapshot(engineRegisteredCtx())
  const p = providers.find((x) => x.id === 'deepseek-official')
  assert.ok(p, '它必须在快照里（"引擎认得它"）')
  assert.equal(p.api, null)
  assert.equal(p.baseURL, null)
  assert.equal(p.declaredInSettings, false,
    '★ 那一节没有任何受管字段 ⇒ 它的端点来自引擎内置 ⇒ 必须标成"没声明"，'
    + '否则 Legion 记下真实端点后会与它的 null 永久不等')
})

test('③b ★★ 有**任何一个**受管字段是真值 ⇒ `declaredInSettings: true`（用户真的写了）', async () => {
  // 先钉住"空节 = false"的反面：只要有一个字段有值，就算声明过。
  const withOne = (field, value) => {
    const services = {
      llm: {
        listProviders: () => [{ id: 'p', name: 'P' }],
        listConfigurableProviders: () => [{ provider: 'p', displayName: 'P', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'p'] }],
        listModels: async () => [],
      },
      settings: { describe: () => [{ ns: 'llm-pi-ai', revision: 1, value: { providers: { p: { [field]: value } } } }] },
      credentials: { describe: async () => ({ configured: false }) },
    }
    return { get: (k) => services[k] ?? null }
  }
  for (const [field, value] of [['api', 'openai-responses'], ['baseURL', 'https://a.example/v1'], ['apiKeyEnv', 'A_KEY']]) {
    const { providers } = await readDshProviderSnapshot(withOne(field, value))
    assert.equal(providers[0].declaredInSettings, true, `只有 ${field} 有值也必须算"声明过"`)
  }
  // 空串**不算**有值（"我写了空串"与"我没写"在配置里是同一件事）
  const { providers } = await readDshProviderSnapshot(withOne('api', ''))
  assert.equal(providers[0].declaredInSettings, false, '空串不算声明')
})

test('③b ★★★ 端到端：Legion 记了真端点、引擎那边是内置默认 ⇒ 对账仍是 clean（不接管那一类）', async () => {
  const { readDshProviderSnapshot, default: _ } = await import('./index.js')
  const { planMaterialization, describeMaterializationPlan } = await import('./materialize-plan.mjs')
  const snap = await readDshProviderSnapshot(engineRegisteredCtx())
  // Legion 侧：为了「测试连接」能用，我们把真实端点记下来了
  const desired = [{
    id: 'deepseek-official', displayName: 'DeepSeek',
    api: 'openai-completions', baseURL: 'https://api.deepseek.com',
    secretRef: 'DEEPSEEK_API_KEY', models: [{ id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' }],
  }]
  const plan = planMaterialization({ desired, actual: snap.providers })
  assert.deepEqual(plan.engineInternal, ['deepseek-official'], '归入"不接管"')
  assert.equal(plan.clean, true, '★ 必须是 clean —— 否则门永远开不了（这正是首版判据的后果）')
  assert.deepEqual(plan.update, [])
  assert.deepEqual(plan.delete, [])
  assert.match(describeMaterializationPlan(plan), /不接管/)
})

test('④ 服务缺席或抛错 ⇒ 返回空 + 原因，**绝不抛**（软取）', async () => {
  const none = await readDshProviderSnapshot({ get: () => null })
  assert.deepEqual(none.providers, [])
  assert.equal(none.readOk, false, '读不出来必须显式标成 readOk=false')
  assert.match(none.reason, /llm/)
  // 只有 llm、没有 settings/credentials：仍然要能读出"活着的"那部分
  const llmOnly = { get: (k) => (k === 'llm' ? fakeCtx().get('llm') : null) }
  const partial = await readDshProviderSnapshot(llmOnly)
  assert.equal(partial.providers.length, 2, '缺 settings 不影响"哪些活着"')
  assert.equal(partial.providers[0].api, null, '缺 settings ⇒ 细节为 null，而不是编一个')
  assert.equal(partial.providers[0].credentialConfigured, false)
  // settings.describe 抛错也要兜住（"还没就绪"是启动期的常态）
  const throwing = await readDshProviderSnapshot(fakeCtx({ describeThrows: true }))
  assert.equal(throwing.providers.length, 2)
  assert.equal(throwing.providers[0].displayName, 'FJD', '拿不到声明就回落到 provider 自己的 name')
  // ★ 完全没有可用供应商 ≠ 读失败：`readOk` 必须仍是 true
  //   （混起来会让 P2 的影子对账把"DSH 是空的"读成"读不出来"，或反过来 —
  //    两个方向的混淆都会得到一个**看起来正常**的错结论）
  const empty = { get: (k) => (k === 'llm' ? { listProviders: () => [], listModels: async () => [] } : null) }
  const noneAlive = await readDshProviderSnapshot(empty)
  assert.deepEqual(noneAlive.providers, [])
  assert.equal(noneAlive.readOk, true, '"宿主说它没有供应商"是**读到了**，不是读失败')
})

/** 一个只记请求的假 fetch；按剧本作答。 */
function fakeFetch(script) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    const r = script(String(url), init) ?? { status: 404, body: {} }
    return {
      status: r.status,
      text: async () => JSON.stringify(r.body),
    }
  }
  return { impl, calls }
}

test('⑤ 引导导入只在**空**目录时发生；非空 ⇒ 一次写都不发（方向纪律）', async () => {
  // 非空：只允许一次 GET，不许有 POST
  const nonEmpty = fakeFetch(() => ({ status: 200, body: { ok: true, providers: [{ id: 'x' }], empty: false } }))
  const skipped = await maybeBootstrapProviderImport({
    ctx: fakeCtx(), hubUpstream: 'http://hub.test', fetchImpl: nonEmpty.impl, log: () => {},
  })
  assert.equal(skipped.skipped, 'not-empty')
  assert.deepEqual(nonEmpty.calls.map((c) => c.init.method), ['GET'],
    '目录非空 ⇒ 不许发写请求：那会把"有人手改了 DSH"变成"Legion 也跟着改了"')

  // 空：先 GET（empty=true）再 POST 导入
  let posted = null
  const emptyHub = fakeFetch((url, init) => {
    if (url.includes('/import')) { posted = JSON.parse(init.body); return { status: 200, body: { ok: true, created: 2, updated: 0, unchanged: 0 } } }
    return { status: 200, body: { ok: true, providers: [], empty: true } }
  })
  const done = await maybeBootstrapProviderImport({
    ctx: fakeCtx(), hubUpstream: 'http://hub.test', fetchImpl: emptyHub.impl, log: () => {},
  })
  assert.equal(done.created, 2)
  assert.deepEqual(emptyHub.calls.map((c) => c.init.method), ['GET', 'POST'])
  assert.equal(posted.actor, 'legion-services')
  assert.equal(posted.source, 'dsh-import')
  assert.deepEqual(posted.providers.map((p) => p.id), ['fjd-ds', 'undeclared-ds'], '两个都要导，含没声明的那个')
  assert.equal(JSON.stringify(posted).includes('sk-'), false, '送出去的快照里不许有密钥形态')
})

test('⑤b 令牌存在时两个请求都要带（否则中枢按未授权拒）', async () => {
  const hub = fakeFetch(() => ({ status: 200, body: { ok: true, providers: [], empty: true } }))
  await maybeBootstrapProviderImport({
    ctx: fakeCtx(), hubUpstream: 'http://hub.test', teamHubToken: 'T0K', fetchImpl: hub.impl, log: () => {},
  })
  for (const c of hub.calls) {
    assert.equal(c.init.headers.authorization, 'Bearer T0K')
    assert.match(c.url, /token=T0K/)
  }
})

test('⑥ 中枢不可达 / 拒绝 / 没有快照 ⇒ 只记日志、不抛', async () => {
  const logs = []
  // 不可达：每次都抛（退避次数调小，别把用例拖慢）
  const boom = async () => { throw new Error('ECONNREFUSED') }
  const unreachable = await maybeBootstrapProviderImport({
    ctx: fakeCtx(), hubUpstream: 'http://hub.test', fetchImpl: boom, log: (m) => logs.push(m), retries: 2, delayMs: 1,
  })
  assert.equal(unreachable.skipped, 'hub-unreachable')
  assert.match(logs.join('\n'), /不影响服务启动/)

  // 拒绝：POST 回 400
  const rejected = await maybeBootstrapProviderImport({
    ctx: fakeCtx(), hubUpstream: 'http://hub.test', log: (m) => logs.push(m),
    fetchImpl: fakeFetch((url) => (url.includes('/import')
      ? { status: 400, body: { error: '未知字段：apiKey' } }
      : { status: 200, body: { ok: true, providers: [], empty: true } })).impl,
  })
  assert.equal(rejected.skipped, 'rejected')
  assert.match(logs.join('\n'), /未知字段/)

  // 读不出快照：llm 缺席
  const noSnapshot = await maybeBootstrapProviderImport({
    ctx: { get: () => null }, hubUpstream: 'http://hub.test', log: (m) => logs.push(m),
    fetchImpl: fakeFetch(() => ({ status: 200, body: { ok: true, providers: [], empty: true } })).impl,
  })
  assert.equal(noSnapshot.skipped, 'no-snapshot')
})
