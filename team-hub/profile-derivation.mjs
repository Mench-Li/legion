// team-hub/profile-derivation.mjs
// ============================================================================
// **从供应商派生模型档案** —— 让"新建档案"不再是手填 8 个字段。
//
// ## 由来（将军原话）
//
//   > 那我还有必要新建档案嘛，直接来源于模型与供应商才对啊
//
// 说得对。澄清一下两者的分工（`docs/DECISION-legion-owns-model-config.md` §6 自己写的是
// "`model_profiles` 是 **(provider, model)** 粒度"）：
//
//   · **供应商**回答"我能连上谁" —— 一个端点 + 一把钥匙 + **N 个模型**（`models_json`）；
//   · **档案**回答"我选了哪一个" —— 从那张清单里挑定一个，好被岗位绑定
//     （`employee_model_bindings` 键是 `(scope, 岗位) → 主档案 + 备选链 + 单次预算`）、
//     好写进每一次 Run 的历史（`modelProfileRef`，所以档案删除是**墓碑**）。
//
// 所以档案**必须存在**（岗位绑定与历史都需要一个稳定的引用），
// 但**手工新建是不该需要的**：档案的 `provider` / `model` / `displayName` / `id`
// 全都能从"供应商 + 它清单里的第几个模型"算出来 —— 而那个算法**本仓早就有了**：
// `model-migration.mjs` 的 `profileIdFor(provider, model)`，只是它此前**只有一次性迁移在用**。
//
//   > 一个"把 (供应商, 模型) 折叠成 id"的函数，
//   > 在**只有迁移那一条路调用它**的时候，
//   > 与一个"界面上仍然要用户手打 id"的产品，是可以同时存在的。
//
// ## 三条纪律
//
// ① **身份是 `(provider, model)`，不是 `id`。**
//    实测：库里三条 fjd 档案的 id 是 `fjd-ds-deepseek-v4-flash-openai`（连字符），
//    而 `profileIdFor` 算出来的是 `fjd-ds.deepseek-v4-flash-openai`（点号）。
//    若按 id 认身份，一次派生就会**多建三条重复档案** —— 而它们看起来完全正常。
// ② **只建缺的，绝不改已有的。** 已存在的档案带着用户的真实选择
//    （推理档位、限额、以及可能的偏离地址/另一把钥匙）。派生**一个字都不动**它。
// ③ **绝不自动删除。** 供应商清单里去掉的模型，对应档案只**报出来**
//    （`orphaned`）。自动打墓碑是不可逆方向的动作，该由人决定；
//    而且那个档案可能正被某个岗位绑定引用着。
// ============================================================================

/** 派生计划的失败码。 */
export const DERIVE_CODES = Object.freeze({
  /**
   * ★ 没给 `runtimeType`。
   *
   * 与 `MIGRATION_RUNTIME_TYPE_REQUIRED`（`model-migration.mjs`）**同一个理由**：
   * `runtimeType` 是"这次要用哪个运行时去跑"的声明，老数据里没有、供应商里也没有，
   * 所以**不猜**——猜出来的档案会看起来可用，直到第一次运行才失败。
   */
  RUNTIME_TYPE_REQUIRED: 'DERIVE_RUNTIME_TYPE_REQUIRED',
})

/** 冲突原因。 */
export const DERIVE_CONFLICT_REASONS = Object.freeze({
  /** 算出来的 id 已被**另一对** `(provider, model)` 的活档案占用。 */
  ID_TAKEN_BY_OTHER: 'ID_TAKEN_BY_OTHER',
  /** 算出来的 id 是一个**墓碑**：`modelStore.create` 会拒（同名重建会让历史指向另一个模型）。 */
  TOMBSTONED_ID: 'TOMBSTONED_ID',
})

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== ''
const pairKey = (provider, model) => `${provider}\u0000${model}`

/** 一行档案是不是墓碑（容忍 `deleted` 布尔与 `deletedAtMs` 两种形状）。 */
function isDeleted(p) {
  if (p === null || typeof p !== 'object') return false
  if (p.deleted === true) return true
  return p.deletedAtMs !== null && p.deletedAtMs !== undefined
}

/** 供应商的模型清单：去重、丢掉空 id（一个空模型名派不出档案，也不该变成一条坏行）。 */
function modelIdsOf(provider) {
  const models = []
  const seen = new Set()
  for (const raw of Array.isArray(provider?.models) ? provider.models : []) {
    const id = isNonEmptyString(raw) ? raw.trim() : (isNonEmptyString(raw?.id) ? raw.id.trim() : '')
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    models.push(id)
  }
  return models
}

/**
 * ★ **"哪些模型已经有档案"这条规则的唯一来源。**
 *
 * 两处要问同一件事：列表要显示"还有 N 个模型没有档案"（不需要 `runtimeType`），
 * 派生要真的建（需要）。把规则抄两遍的后果很具体：**两处的"N"会不一样**，
 * 而用户看到"还有 2 个"点下去却建了 3 个时，他不会怀疑规则被抄了两遍。
 *
 * 身份是 `(provider, model)`，**不是 `id`**（纪律 ①）。
 *
 * @returns {{models: string[], existing: Array, missing: string[], orphaned: Array}}
 */
export function matchProviderModels({ provider, profiles = [] } = {}) {
  if (provider === null || typeof provider !== 'object') {
    throw new TypeError('matchProviderModels 需要供应商行')
  }
  if (!Array.isArray(profiles)) {
    throw new TypeError('profiles 必须是数组（可以是空数组）')
  }
  const providerId = isNonEmptyString(provider.id) ? provider.id.trim() : ''
  const models = modelIdsOf(provider)

  const livePairOwner = new Map()
  for (const p of profiles) {
    if (p === null || typeof p !== 'object' || isDeleted(p)) continue
    if (!isNonEmptyString(p.id)) continue
    livePairOwner.set(pairKey(p.provider, p.model), p.id)
  }

  const existing = []
  const missing = []
  for (const model of models) {
    const owner = livePairOwner.get(pairKey(providerId, model))
    if (owner === undefined) missing.push(model)
    else existing.push(Object.freeze({ model, profileId: owner }))
  }

  const modelSet = new Set(models)
  const orphaned = []
  for (const p of profiles) {
    if (p === null || typeof p !== 'object' || isDeleted(p)) continue
    if (p.provider !== providerId) continue
    if (!isNonEmptyString(p.model) || modelSet.has(p.model)) continue
    orphaned.push(Object.freeze({ profileId: p.id, model: p.model }))
  }

  return Object.freeze({ providerId, models, existing: Object.freeze(existing), missing: Object.freeze(missing), orphaned: Object.freeze(orphaned) })
}

/**
 * 算出"这个供应商的模型清单里，哪些还没有档案"。
 *
 * **只算，不写。** 写入由调用方（路由）逐条做，于是"算出什么"与"写了什么"
 * 不会因为一次部分失败而对不上账。
 *
 * @param {object} args
 * @param {object} args.provider     供应商行（`providerStore.get`；需 `id` / `displayName` / `models`）
 * @param {Array}  [args.profiles]   已有档案（**含墓碑**：要用来判 id 占用）
 * @param {string} args.runtimeType  **必填**，不猜（见 `DERIVE_CODES.RUNTIME_TYPE_REQUIRED`）
 * @param {Function} args.profileIdOf `(providerId, model) => id`（注入 `profileIdFor`）
 * @returns {Readonly<object>} 计划；`ok:false` 时带 `code` / `message`
 */
export function planProfileDerivation({ provider, profiles = [], runtimeType = null, profileIdOf } = {}) {
  if (typeof profileIdOf !== 'function') {
    throw new TypeError('planProfileDerivation 需要 profileIdOf：没有它就算不出档案 id')
  }
  if (provider === null || typeof provider !== 'object') {
    throw new TypeError('planProfileDerivation 需要供应商行')
  }
  if (!Array.isArray(profiles)) {
    throw new TypeError('profiles 必须是数组（可以是空数组）')
  }
  if (!isNonEmptyString(runtimeType)) {
    return Object.freeze({
      ok: false,
      code: DERIVE_CODES.RUNTIME_TYPE_REQUIRED,
      message: '派生模型档案需要显式给出 runtimeType（用哪个运行时跑）：' +
        '供应商里没有这个信息，库里也不该猜——猜出来的档案看起来可用，直到第一次运行才失败。',
    })
  }
  const rt = runtimeType.trim()
  // ★ 身份规则走 `matchProviderModels`（唯一来源），这里只负责"给缺的那些配上 id"。
  const matched = matchProviderModels({ provider, profiles })
  const providerId = matched.providerId
  if (providerId === '') {
    return Object.freeze({ ok: false, code: DERIVE_CODES.RUNTIME_TYPE_REQUIRED, message: '供应商没有 id，无法派生档案。' })
  }

  // id 占用表（**含墓碑**：`modelStore.create` 拒绝墓碑 id）
  const byId = new Map()
  for (const p of profiles) {
    if (p === null || typeof p !== 'object') continue
    const id = isNonEmptyString(p.id) ? p.id : ''
    if (id === '') continue
    byId.set(id, { id, provider: p.provider ?? null, model: p.model ?? null, deleted: isDeleted(p) })
  }

  const providerLabel = isNonEmptyString(provider.displayName) ? provider.displayName.trim() : providerId
  const create = []
  const conflicts = []

  for (const model of matched.missing) {
    const id = String(profileIdOf(providerId, model))
    const taken = byId.get(id)
    if (taken !== undefined) {
      conflicts.push(Object.freeze({
        model,
        id,
        reason: taken.deleted ? DERIVE_CONFLICT_REASONS.TOMBSTONED_ID : DERIVE_CONFLICT_REASONS.ID_TAKEN_BY_OTHER,
        takenBy: Object.freeze({ provider: taken.provider, model: taken.model }),
      }))
      continue
    }
    const input = Object.freeze({
      id,
      displayName: `${providerLabel} · ${model}`,
      runtimeType: rt,
      provider: providerId,
      model,
      // ★ `endpoint` / `secretRef` **留空**：留空即继承供应商
      //   （`model-resolution.mjs`）。这正是"连接信息只存一份"的兑现——
      //   派生的档案天然就是上移后的形态，不会再造一份拷贝。
      endpoint: null,
      secretRef: null,
    })
    create.push(input)
    // 占位：同一次计划里两个模型折叠到同一个 id 也要能被判成冲突（而不是撞库）
    byId.set(id, { id, provider: providerId, model, deleted: false })
  }

  return Object.freeze({
    ok: true,
    providerId,
    runtimeType: rt,
    create: Object.freeze(create),
    existing: matched.existing,
    conflicts: Object.freeze(conflicts),
    orphaned: matched.orphaned,
  })
}

/**
 * 把计划压成**一句话读数**（面板与日志共用同一份口径，免得两处各写一遍）。
 *
 * 故意把 `orphaned` 说成"要你自己看"，而不是"已清理"：
 * 本模块**不删任何东西**（纪律 ③）。
 */
export function describeDerivation(plan) {
  if (plan === null || typeof plan !== 'object' || plan.ok !== true) {
    return `派生未执行：${plan?.message ?? '计划不可用'}`
  }
  const bits = [
    `新增 ${plan.create.length}`,
    `已存在 ${plan.existing.length}`,
    `冲突跳过 ${plan.conflicts.length}`,
  ]
  if (plan.orphaned.length > 0) {
    bits.push(`供应商里已没有的模型 ${plan.orphaned.length}（**未动**，需你自己决定）`)
  }
  return bits.join(' / ')
}
