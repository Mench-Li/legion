// team-hub/credential-status.mjs
// ============================================================================
// **凭证的真实状态** —— 一条"引用名到底在不在本机密钥库里"的核验。
//
// ## 为什么需要它（实测的假话）
//
// 2026-10-10：面板显示 `fjd-ds · 已配置凭证 · 版本 1`，而三条 fjd 档案引用的
// `FJD_DS_API_KEY` **根本不在密钥库里**（库里只有两把 SVEA 键）。
// 那句"已配置"来自两个**都不是核验**的来源：
//
//   · 供应商行：`model_providers.credential_configured` —— 它是 **P1 从 DSH 导入的标记**，
//     记的是"DSH 那边说它配过"，不是"本机密钥库里有这把钥匙"；
//   · 档案行：`hasCredential` —— 它只表示 `secret_ref` **非空**（引用了一个名字）。
//
//   > 一个"引用了某个名字"的条目，
//   > 与一个"那把钥匙真的在库里"的条目，在界面上说的是同一句话——
//   > 而它们的修法完全不同（一个要补钥匙，一个什么也不用做）。
//
// ## 三条纪律
//
// ① **读不出来 ≠ 没有。** 密钥库打不开时状态是 `unavailable`，**绝不**降级成 `missing`：
//    把"我不知道"说成"没有"会让用户去补一把其实已经在的钥匙
//    （与 `services-plugin/materialize-plan.mjs` 那条"读失败不许伪装成 clean"同一条纪律）。
// ② **一次列表只问一遍密钥库。** 20 个供应商不该产生 20 次 DPAPI 打开。
// ③ **不把引用名写进日志。** 它只出现在**响应**里（界面要告诉用户缺的是哪一个），
//    与 `GET /api/secrets` 同一口径。
// ============================================================================

/** 凭证状态。`none` = 这个条目本来就不要凭证（本地模型合法）。 */
export const CREDENTIAL_STATES = Object.freeze(['none', 'ready', 'missing', 'unavailable'])

/**
 * 纯分类：**给定一份密钥库读数**，判断某个引用名的状态。
 *
 * 抽成纯函数是为了让"读不出来时不许说没有"这条能被**直接**验，
 * 而不需要在一台真的打不开 DPAPI 的机器上制造失败。
 *
 * @param {string|null|undefined} ref 引用名（`null`/空 = 这个条目不要凭证）
 * @param {{ok: boolean, refs: Iterable<string>, message?: string}|null} snapshot 密钥库读数
 */
export function classifyCredential(ref, snapshot) {
  const cleanRef = typeof ref === 'string' && ref !== '' ? ref : null
  if (cleanRef === null) {
    return Object.freeze({ state: 'none', ref: null, detail: '这个条目没有配置凭证引用（不需要鉴权的模型是合法的）' })
  }
  if (snapshot === null || snapshot === undefined || snapshot.ok !== true) {
    // ★ 「这不等于'没有'」这句是**无条件**附上的，不因为来源给了 message 就省掉。
    //   第一版写的是 `detail: snapshot?.message ?? '…（这不等于"没有"）'` ——
    //   于是**只要来源带了 message**，那句限定就消失了，而"读不出来"读起来
    //   正好就是"没有"。判据当场变红（`credential-status.test.mjs` ③）。
    const why = typeof snapshot?.message === 'string' && snapshot.message !== '' ? `：${snapshot.message}` : ''
    return Object.freeze({
      state: 'unavailable',
      ref: cleanRef,
      detail: `读不到本机密钥库，因此**无法判断**这把钥匙在不在（这不等于"没有"）${why}`,
    })
  }
  const refs = snapshot.refs
  const has = refs instanceof Set ? refs.has(cleanRef) : Array.from(refs ?? []).includes(cleanRef)
  return has
    ? Object.freeze({ state: 'ready', ref: cleanRef, detail: null })
    : Object.freeze({
      state: 'missing',
      ref: cleanRef,
      detail: '本机密钥库里没有这个引用：钥匙从未存进来，或者它被删掉了',
    })
}

/** 状态 → 一句话（面板与诊断共用同一份口径，避免两处各写一遍）。 */
export const CREDENTIAL_STATE_TEXT = Object.freeze({
  none: '无需凭证',
  ready: '钥匙已就位',
  missing: '钥匙不在库里',
  unavailable: '无法核验（读不到密钥库）',
})

/**
 * 造一个"凭证状态"读取器。
 *
 * @param {object} deps
 * @param {() => Promise<Iterable<string>>} deps.listRefs
 *        列出本机密钥库里的引用名。**抛错 = 读不出来**（不是"空库"）。
 */
export function createCredentialStatus({ listRefs } = {}) {
  if (typeof listRefs !== 'function') {
    throw new TypeError('createCredentialStatus 需要 listRefs：没有它就无从核验，"没核验过"绝不能被当成"没有"')
  }

  return Object.freeze({
    /**
     * 取一份读数。**一次列表共用一份**（见纪律 ②）。
     *
     * 返回的对象带 `of(ref)`，于是调用方读一次库、对任意多条目判任意多次。
     */
    async snapshot() {
      let snap
      try {
        const refs = await listRefs()
        snap = { ok: true, refs: new Set(Array.from(refs ?? [])), message: null }
      } catch (e) {
        // 抛错 ⇒ unavailable。**不**把错误正文当 message 原样带出去：
        // 它可能含密钥库的实现细节；一句话足够用户知道"这次没核验成"。
        snap = { ok: false, refs: new Set(), message: '读不到本机密钥库（产品目录布局未确定或密钥库打不开）' }
        void e
      }
      return Object.freeze({
        ok: snap.ok,
        message: snap.message,
        of: (ref) => classifyCredential(ref, snap),
      })
    },
  })
}
