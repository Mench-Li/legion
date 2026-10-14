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

  /**
   * ★★★ 2026-10-14（第三次修这条判据 —— 前两版都错在**同一件事**上）：
   * **这条供应商在 DSH 的配置里到底有没有一块属于它自己的声明？**
   *
   * ## 两版错判据，与它们各自踩到的坑
   *
   * ```js
   * // 首版：引擎登记了自己 ⇒ 当作"用户声明了"
   * declared.some((d) => d?.provider === p.id)
   *
   * // 第二版：那一节里有受管字段的真值 ⇒ 当作"用户声明了"
   * ['api','baseURL','apiKeyEnv'].some((k) => typeof profile[k] === 'string' && profile[k] !== '')
   * ```
   *
   * **首版的坑**：`llm.listConfigurableProviders()` 会列出**每一条内置路线**
   * （它们都登记自己、带 `settingsNs`）⇒ `deepseek-official` 被判成"有声明"。
   *
   * **第二版的坑（从 DSH 源码读出的真原因）**：`settings.describe()` 每个命名空间返回
   * **三层**（`packages/settings/settings/src/index.ts:302-331`）：
   *
   * ```ts
   * value = projectForm(form, plainConfig(entry.fiber.config))  // ← 生效值，**含引擎默认**
   * base  = 继承来的
   * user  = projectForm(form, override)                          // ← **用户真正写的那一份**
   * ```
   *
   * 而快照读的是 `value`。于是对 `deepseek-official`（`settingsNs = llm-deepseek`）来说，
   * `value` 里有引擎默认的 `baseURL`（非空字符串）⇒ 第二版判据命中的是**引擎默认值**，
   * 而不是任何"用户声明"。（另有一种同样能骗过它的形状：某个**别人的**命名空间里
   * 出现了这个名字 —— 这台机器上 `web` 节的 `searchProvider: deepseek-official` 就是。）
   *
   * 两种形状合起来说明：**"那一节里有真值"与"这一节里有它的声明"是两件事**。
   *
   *   > 引擎把默认值投影进 `value` 之后，
   *   > "用户写了这一块"与"引擎替它补了这一块"在**值**上再也分不出来 ——
   *   > 它们只在**结构**上还分得开。
   *
   * ## 现在的判据：问**结构**，不问"有没有值"
   *
   *   ① 它的 `settingsPath` 指向**它自己**（末段等于供应商 id）⇒ 有声明；
   *   ② 否则看下钻出来的那一节里，**有没有一个键就是这条供应商的 id**
   *      且那个值是对象（`{ providers: { 'fjd-ds': {...} } }` 那种形状）⇒ 有声明；
   *   ③ 再否则 ⇒ `false`：它的 api/baseURL 来自引擎默认值 ⇒ 下游按"不接管"处置
   *      （`materialize-plan.mjs` 的 `engineInternal`）：不比较、不写、也不进删除候选。
   *
   * ⚠ 这条规则**只**对 DSH 侧成立（它是"我读到了什么"），Legion 侧的同名字段没有这个含义。
   * ⚠ 将来若要更精确，可以用 `descriptor.user`（引擎自己的"用户写了什么"那一层）——
   *   但那是**另一条**路（它依赖 `projectForm` 的投影语义），不要与这条混着改。
   */
  const hasOwnDeclaration = (providerId, entry, profile) => {
    const path = Array.isArray(entry?.settingsPath) ? entry.settingsPath : []
    // ① 路径直接指向它自己（`['providers', 'fjd-ds']` 这种）
    if (path.length > 0 && path[path.length - 1] === providerId) return true
    // ② 下钻出来的那一节里，有一个以它命名的**对象**（`{ providers: { 'fjd-ds': {...} } }`）
    const own = profile?.[providerId]
    return own !== null && typeof own === 'object' && !Array.isArray(own)
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
      /**
       * 见上面 `hasOwnDeclaration` 的长注释：判据是"**这一节里有没有一块属于它的配置**"，
       * 不是"引擎有没有登记它"，也不是"这一节里有没有真值"——
       * 后两者都实测踩过（`deepseek-official` 的 `settingsNs` 是 `web`，
       * 那一节里只有一个 `searchProvider: deepseek-official`）。
       */
      declaredInSettings: hasOwnDeclaration(p.id, declared.find((d) => d?.provider === p.id), profile),
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
