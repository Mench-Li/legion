// services-plugin/dsh-snapshot.mjs
// ============================================================================
// 从**宿主进程内**读出"DSH 现在活着的供应商目录"（P1 的只读那一半）。
//
// ## 为什么单独成一个文件
//
// 它被两处用：`index.js`（P1 的引导导入）与 `shadow-materialize.mjs`（P2 的对账）。
// 一开始它住在 `index.js` 里，于是 P2 让 `index.js ↔ shadow-materialize.mjs` 成了**循环导入** ——
// 那次能跑（ESM 的活绑定 + 调用发生在两模块都求值完之后），但它是那种
// "今天能跑、改动顺序之后就看运气"的结构。
//
//   > 一个"两个模块互相 import 但调用发生在求值之后"的循环，
//   > 与一个"没有循环"的依赖图，在今天的运行结果上是同一个东西 ——
//   > 只不过前者的失败方式取决于**谁先被加载**。
//
// ## 只读、且只取目录类事实
//
// 供应商 id、显示名、协议、地址、**引用名**（`apiKeyEnv`）、型号清单、
// 以及"这个引用配没配"。**永不读值** —— `credentials.describe()` 返回的是 `{configured}`，
// 不是密钥本身；这条由 `provider-import.test.mjs` ② 用"resolve 一被调用就抛"的探针钉住。
//
// ## 三个服务一律软取
//
// `ctx.get(...)` 缺席 ⇒ 返回空 + 原因，**绝不抛**：把"宿主没这个服务"变成
// "整个插件 pending ⇒ team-hub 与指挥台都不启动"，是这条链上后果最大的一种错
// （BUG-014 第二版踩过一次，护栏用例在 `index.test.mjs`）。
// ============================================================================

/**
 * @returns `{ providers, readOk, reason }`
 *
 *   ★ `readOk` 是**必须**的一个字段，不能靠 `providers.length === 0` 去猜"读失败"：
 *     "宿主说它没有供应商"与"我们读不出来"都是空数组，而后者被当成前者会让
 *     **读失败伪装成"完全一致"** —— P2 的影子对账会因此报 `clean`，
 *     而那正是"接管后什么都不用改"这个结论的来源。两者必须分得开。
 *     （`readOk: false` ⇒ 调用方不许下任何结论。）
 */
export async function readDshProviderSnapshot(ctx) {
  const llm = ctx?.get?.('llm') ?? null
  if (!llm || typeof llm.listProviders !== 'function') {
    return { providers: [], readOk: false, reason: '宿主没有 llm 服务' }
  }
  const settings = ctx?.get?.('settings') ?? null
  const credentials = ctx?.get?.('credentials') ?? null

  let namespaces = []
  if (settings && typeof settings.describe === 'function') {
    try { namespaces = settings.describe({ redactSecrets: true }) ?? [] } catch { namespaces = [] }
  }
  let declared = []
  if (typeof llm.listConfigurableProviders === 'function') {
    try { declared = llm.listConfigurableProviders() ?? [] } catch { declared = [] }
  }

  /** 按 `settingsPath` 逐级下钻，取到这条供应商在配置里的那一节。 */
  const declaredProfile = (providerId) => {
    const entry = declared.find((d) => d?.provider === providerId)
    if (!entry) return {}
    let node = namespaces.find((n) => n?.ns === entry.settingsNs)?.value
    for (const key of entry.settingsPath ?? []) {
      node = node !== null && typeof node === 'object' ? node[key] : undefined
    }
    return node !== null && typeof node === 'object' ? node : {}
  }

  const providers = []
  for (const p of llm.listProviders()) {
    if (!p || typeof p.id !== 'string') continue
    const profile = declaredProfile(p.id)
    let models = []
    try { models = (await llm.listModels(p.id)) ?? [] } catch { models = [] }
    const apiKeyEnv = typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv !== '' ? profile.apiKeyEnv : null
    let credentialConfigured = false
    if (apiKeyEnv !== null && credentials && typeof credentials.describe === 'function') {
      try { credentialConfigured = (await credentials.describe(apiKeyEnv))?.configured === true } catch { credentialConfigured = false }
    }
    providers.push({
      id: p.id,
      displayName: typeof profile.displayName === 'string' && profile.displayName !== '' ? profile.displayName : (p.name ?? p.id),
      api: typeof profile.api === 'string' && profile.api !== '' ? profile.api : null,
      baseURL: typeof profile.baseURL === 'string' && profile.baseURL !== '' ? profile.baseURL : null,
      secretRef: apiKeyEnv,
      credentialConfigured,
      models: models.map((m) => ({
        id: m?.id,
        ...(typeof m?.name === 'string' && m.name !== '' ? { name: m.name } : {}),
        ...(Array.isArray(m?.inputModalities) && m.inputModalities.length > 0 ? { input: [...m.inputModalities] } : {}),
      })).filter((m) => typeof m.id === 'string' && m.id !== ''),
    })
  }
  // ★ 读成功、就是零个供应商：`readOk: true` + 空数组。
  //   这与上面那条"宿主没有 llm 服务"是**两个不同的事实**，也是本函数唯一容易做错的地方。
  return { providers, readOk: true, reason: providers.length === 0 ? '宿主当前没有任何可用供应商' : '' }
}
