// team-hub/model-resolution.mjs
// ============================================================================
// **有效档案**：把"档案 + 它的供应商"合成一份**真正拿来用**的配置。
//
// ## 这件事的由来（用户原话："我既然配置了模型供应商，还有啥必要登记这个模型档案？"）
//
// 两条轴本来不是一回事（供应商 = 一个端点 + 一把钥匙 + N 个模型；档案 = 从里面挑定
// **一个**模型，好被岗位绑定、好写进每次 Run 的历史），但**连接信息**确实被存了两份：
//
//     model_providers.fjd-ds   base_url = https://fjbigmodel.fjdac.cn/v1   secret_ref = FJD_DS_API_KEY
//     model_profiles.<三条>    endpoint = https://fjbigmodel.fjdac.cn/v1   secret_ref = FJD_DS_API_KEY  ← 又一份
//
// 而 `docs/DECISION-legion-owns-model-config.md` §6（用户自己写的）早就定了方向：
//
//     > 建议（P1 一并做）：新增 `model_providers` 表…`model_profiles.provider` 引用它；
//     > `api` 协议与 `base_url` 从"每行都有"上移到"每个供应商一份"。
//
// **表建了（P1 做了），"上移"只做了一半**：供应商有了 `base_url`，档案那份没删。
// 于是同一份事实有两个消费者、两份拷贝 —— 只改一处时，"面板说配好了"与
// "档案指向一把不存在的钥匙"就会同时成立（这正是 BUG-023/025 的土壤）。
//
//   > 一份"被上移到供应商、但旧的那份没删"的配置，
//   > 与一份"故意留了两份"的配置，在**只改其中一处**的那天之前，是一样的。
//
// ## 本模块做的事：**只对齐读法，不动数据**
//
// 档案里的值是**可选覆盖**（真要偏离时才写，例如同一个供应商的某个模型走另一个网关）；
// 留空就从供应商取。这样"上移"不必再来一次数据迁移：**留空的档案自动就是上移后的形态**，
// 而已经写满的那三条档案行为**逐字不变**（它们本来就等于供应商的值）。
//
// 为什么不直接删掉那两列：端点确实可能**逐档案不同**（同一供应商的不同模型走不同网关），
// 而档案行是要被读出来、被导出到别处（备份 / 运维脚本）用的。删列会关掉那条真实的可能性。
// （★ 2026-10-12：这里原来举的例子是「配置包导出」`runtime/contracts/config-bundle.mjs` ——
//  配置包已整体拆除；支持保留这两列的理由本身不变，只是换成了备份/运维这两条真实的读法。）
// ============================================================================

/** 可从供应商继承的字段。 */
export const INHERITABLE_FIELDS = Object.freeze(['endpoint', 'secretRef'])

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== ''

/**
 * 合成**有效档案**：档案自己的值优先，留空时从供应商取。
 *
 * @param {object|null} profile  内部档案（含 `secretRef`；见 `modelStore.internalGet`）
 * @param {object|null} provider 供应商行（`providerStore.get`，含 `baseURL` / `secretRef`）
 * @returns {object|null} 冻结的新对象；附 `inherited` 与 `providerMissing` 供界面/诊断说明来源
 *
 * 不修改入参，也不写库：**这是一次读法上的合成**，不是一次数据变更。
 */
export function effectiveProfile(profile, provider = null) {
  if (profile === null || typeof profile !== 'object') return null
  const hasProvider = provider !== null && typeof provider === 'object'

  const ownEndpoint = isNonEmptyString(profile.endpoint) ? profile.endpoint.trim() : null
  const ownSecretRef = isNonEmptyString(profile.secretRef) ? profile.secretRef.trim() : null
  const providerEndpoint = hasProvider && isNonEmptyString(provider.baseURL) ? provider.baseURL.trim() : null
  const providerSecretRef = hasProvider && isNonEmptyString(provider.secretRef) ? provider.secretRef.trim() : null

  const endpoint = ownEndpoint ?? providerEndpoint
  const secretRef = ownSecretRef ?? providerSecretRef

  return Object.freeze({
    ...profile,
    endpoint,
    secretRef,
    inherited: Object.freeze({
      endpoint: ownEndpoint === null && providerEndpoint !== null,
      credential: ownSecretRef === null && providerSecretRef !== null,
    }),
    // 档案点名了一个供应商，而库里没有这一行 —— 界面要能说清"是找不到供应商"，
    // 而不是笼统地报"没填 endpoint"（后者的修法是去填地址，而真的修法是先建供应商）。
    providerMissing: isNonEmptyString(profile.provider) && !hasProvider,
  })
}

/**
 * 描述**连接信息的来源**（给面板与诊断）：每个字段的取值与它来自哪里。
 *
 * 与 `effectiveProfile` 分开：前者要一份能直接用的配置，这里要一份**能向人解释**的说明。
 * 合成在一起会让"用它"和"解释它"共用一份形状，而两者要的字段并不一样。
 */
export function connectionSources(profile, provider = null) {
  const eff = effectiveProfile(profile, provider)
  if (eff === null) return null
  return Object.freeze({
    endpoint: Object.freeze({
      value: eff.endpoint,
      from: eff.endpoint === null ? null : (eff.inherited.endpoint ? 'provider' : 'profile'),
    }),
    credential: Object.freeze({
      ref: eff.secretRef,
      from: eff.secretRef === null ? null : (eff.inherited.credential ? 'provider' : 'profile'),
    }),
    providerMissing: eff.providerMissing,
  })
}

/**
 * 这个档案的连接信息是不是**纯复制**（逐字等于供应商的值，一个字都没不同）。
 *
 * 用途：界面提示"这两项与供应商完全相同，可以留空"。
 * **只提示，不拒绝** —— 一个"拒绝保存"的实现会在用户真想逐字钉住时挡住他，
 * 而"留空"与"写成一模一样"在行为上确实等价，所以这里没有任何正确性理由去拒绝。
 */
export function connectionIsRedundant(profile, provider = null) {
  if (profile === null || typeof profile !== 'object') return Object.freeze({ endpoint: false, credential: false })
  const ownEndpoint = isNonEmptyString(profile.endpoint) ? profile.endpoint.trim() : null
  const ownSecretRef = isNonEmptyString(profile.secretRef) ? profile.secretRef.trim() : null
  const providerEndpoint = provider !== null && isNonEmptyString(provider?.baseURL) ? provider.baseURL.trim() : null
  const providerSecretRef = provider !== null && isNonEmptyString(provider?.secretRef) ? provider.secretRef.trim() : null
  return Object.freeze({
    endpoint: ownEndpoint !== null && providerEndpoint !== null && ownEndpoint === providerEndpoint,
    credential: ownSecretRef !== null && providerSecretRef !== null && ownSecretRef === providerSecretRef,
  })
}
