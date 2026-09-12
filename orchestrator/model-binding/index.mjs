// orchestrator/model-binding/index.mjs
// ============================================================================
// 岗位模型绑定与 fallback 的**纯**解析逻辑（PRT-502，spec §6.6）
//
// spec 的 EmployeeModelBinding：
//   employeeRole / primaryProfile / fallbackProfiles / perRunBudget
//
// 纯函数、不碰数据库：绑定与档案的读取是仓储的事，而"给一个岗位排出它该用
// 哪个模型的顺序"是判定。分开写才能把判定单独验。
//
// ── 这个模块要回答的唯一问题 ──
//
//   「这条任务用的是哪个模型，为什么是它？」
//
// 它必须**可回答**，因为换模型会同时改变三件事：成本、质量、以及数据去了哪。
// 三件都不可见时，一次"用错了模型"的运行在事后完全没有痕迹——
// 它能跑完、能出结果、看起来正常。
//
// ── 四条判定 ──
//
//   ① **主档案解析不出来 = 绑定不可用，不允许自动让 fallback 顶上。**
//      fallback 存在的意义是"主档案**运行时**连不上"，不是"配置写错了替我兜住"。
//      让 fallback 悄悄顶替的后果是：`primaryProfile` 一直是错的，而每一次运行
//      都在用一个没人选过的模型——而且没有任何报错。这与 §6.6
//      「不得在未获用户批准时自动切换到更昂贵模型」是同一条纪律。
//
//   ② **不可用的 fallback 是"跳过 + 理由"，不是错误。**
//      备用档案被下线是正常运维动作。但**必须报出来**：链短了一位，
//      意味着真实的容错余量比配置上看起来少一位。
//
//   ③ **链是有序且去重的。** 同一个档案在一次解析里出现两次（主档案也在
//      fallback 列表里）会让"重试"变成对着同一个模型重试——那不是容错，
//      是把一次瞬时故障变成了两次同样的失败。去重并如实报告。
//
//   ④ **解析结果里没有密钥，也没有 secretRef 的值。** 只给
//      `hasCredential`。与 PRT-501 的 `toModelDescriptor` 同一条纪律。
//
// ── 交付边界 ──
//
// 本模块只**排序与解释**，不执行任何探测。「这个档案连得上吗」是 PRT-504。
// 因此 `chain` 里的是"按配置应该依次尝试的候选"，不是"已验证可用"。
// 把它们混为一谈会让"配置齐全"看起来像"能跑"。
// ============================================================================

/** 绑定层具名错误码。Callers 靠它区分"配置错了"与"数据没了"。 */
export const BINDING_ERRORS = Object.freeze({
  BINDING_NOT_OBJECT: 'BINDING_NOT_OBJECT',
  ROLE_REQUIRED: 'ROLE_REQUIRED',
  PRIMARY_REQUIRED: 'PRIMARY_REQUIRED',
  FALLBACKS_NOT_ARRAY: 'FALLBACKS_NOT_ARRAY',
  PRIMARY_UNRESOLVED: 'PRIMARY_UNRESOLVED',
  NO_USABLE_PROFILE: 'NO_USABLE_PROFILE',
  BUDGET_INVALID: 'BUDGET_INVALID',
  PROFILES_NOT_ARRAY: 'PROFILES_NOT_ARRAY',
})

/** 候选在一次解析里的角色。 */
export const CANDIDATE_ROLES = Object.freeze(['primary', 'fallback'])

/** 一个候选被跳过（或主档案不可用）的原因。 */
export const SKIP_REASONS = Object.freeze([
  'PROFILE_NOT_FOUND', // 没有这个档案
  'PROFILE_DELETED', // 档案已立墓碑
  'PROFILE_DUPLICATE', // 本次解析里已经出现过同一个档案
  'PROFILE_ID_INVALID', // id 形态不合法（不是字符串 / 空串）
])

export class BindingError extends Error {
  constructor(code, message, { statusCode = 400, ...extra } = {}) {
    super(message)
    this.name = 'BindingError'
    this.code = code
    this.statusCode = statusCode
    Object.assign(this, extra)
  }
}

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== ''

/**
 * 校验 perRunBudget。
 *
 * 本批（PRT-502）只做**形态**校验：单次运行预算的**执行**（原子预留、结算、
 * 取消、Unknown Outcome 锁定）是 PRT-503/510。
 *
 * 形态校验仍然必须做，而且必须严格：一个坏掉的预算对象在 PRT-503 落地后会
 * 直接变成"预算没有上限"——而那是一条静默的、花钱的失败。
 */
export function validatePerRunBudget(budget) {
  if (budget === undefined || budget === null) return { ok: true, value: null, errors: [] }
  if (typeof budget !== 'object' || Array.isArray(budget)) {
    return { ok: false, value: null, errors: ['perRunBudget 必须是对象'] }
  }
  const errors = []
  const out = {}
  for (const [k, v] of Object.entries(budget)) {
    if (v === undefined || v === null) continue
    if (!['maxCost', 'maxTokens', 'currency'].includes(k)) {
      // 未知字段拒绝而不是忽略：一个拼错的 `maxCst` 被静默忽略后，
      // 预算看起来配了、实际没有上限。
      errors.push(`perRunBudget 未知字段 ${k}：只接受 maxCost / maxTokens / currency（拼错的字段被忽略等于没有上限）`)
      continue
    }
    if (k === 'currency') {
      if (!isNonEmptyString(v)) errors.push('perRunBudget.currency 必须是非空字符串')
      else out.currency = v.trim()
      continue
    }
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      errors.push(`perRunBudget.${k} 必须是正的有限数`)
      continue
    }
    out[k] = v
  }
  // 给了金额就必须给币种：`maxCost: 5` 而币种不明，等于没给上限。
  if (out.maxCost !== undefined && out.currency === undefined) {
    errors.push('perRunBudget.maxCost 必须与 currency 一起给出：金额脱离币种不构成上限')
  }
  return { ok: errors.length === 0, value: errors.length === 0 ? Object.freeze(out) : null, errors }
}

/**
 * 把档案列表变成一张按 id 索引的表。
 *
 * `profiles` 允许是数组或者已经索引好的对象。墓碑档案**也要传进来**
 * （带 `deleted: true`）——只有传了才能把"档案被下线了"与"档案根本不存在"
 * 分开报。两者的运维动作完全不同：前者去找谁下线的，后者去查是不是打错了 id。
 */
function indexProfiles(profiles) {
  const byId = new Map()
  if (Array.isArray(profiles)) {
    for (const p of profiles) {
      if (p !== null && typeof p === 'object' && isNonEmptyString(p.id)) byId.set(p.id, p)
    }
    return byId
  }
  if (profiles !== null && typeof profiles === 'object') {
    for (const [id, p] of Object.entries(profiles)) {
      byId.set(id, p !== null && typeof p === 'object' ? { id, ...p } : { id })
    }
    return byId
  }
  throw new BindingError(BINDING_ERRORS.PROFILES_NOT_ARRAY,
    'profiles 必须是档案数组或按 id 索引的对象')
}

/** 一个候选为什么不能用。返回 null 表示可用。 */
function skipReasonFor(id, profile) {
  if (!isNonEmptyString(id)) return { code: 'PROFILE_ID_INVALID', message: `档案 id 不是非空字符串：${JSON.stringify(id)}` }
  if (profile === undefined) {
    return {
      code: 'PROFILE_NOT_FOUND',
      message: `没有这个模型档案：${id}（引用打错了，或档案从未建立）`,
    }
  }
  if (profile.deleted === true || profile.deletedAtMs !== undefined && profile.deletedAtMs !== null) {
    return {
      code: 'PROFILE_DELETED',
      message: `模型档案 ${id} 已被下线（墓碑仍在：历史记录里那个引用还指着它）`,
    }
  }
  return null
}

/** 把可用的档案压成候选条目——**只有非敏感字段**。 */
function candidateOf(profile, { id, role, order }) {
  return Object.freeze({
    id,
    role,
    order,
    displayName: profile.displayName ?? null,
    provider: profile.provider ?? null,
    model: profile.model ?? null,
    runtimeType: profile.runtimeType ?? null,
    reasoningEffort: profile.reasoningEffort ?? null,
    limits: profile.limits ?? Object.freeze({}),
    // 只暴露"有没有凭证"，不给引用名（PRT-501 的 toModelDescriptor 同理）
    hasCredential: profile.hasCredential === true ||
      (profile.secretRef !== undefined && profile.secretRef !== null && profile.secretRef !== ''),
  })
}

/**
 * 解析一个岗位的模型候选链。
 *
 * @param {object} args
 * @param {object} args.binding   `{ employeeRole, primaryProfile, fallbackProfiles, perRunBudget }`
 * @param {Array|object} args.profiles  档案（含墓碑）
 * @returns {{
 *   ok: boolean, code: string|null, message: string,
 *   employeeRole: string|null, chain: object[], skipped: object[],
 *   perRunBudget: object|null, errors: string[]
 * }}
 *
 * **返回值永远是同一个形状**，不用异常表达"配置有问题"：
 * 调用方（恢复扫描、诊断面板、CLI）需要的是把链与理由一起打出来，
 * 而不是在 catch 里再拼一次。
 */
export function resolveModelChain({ binding, profiles } = {}) {
  if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) {
    throw new BindingError(BINDING_ERRORS.BINDING_NOT_OBJECT, 'binding 必须是对象')
  }
  const byId = indexProfiles(profiles)

  const errors = []
  const skipped = []
  const chain = []
  const employeeRole = isNonEmptyString(binding.employeeRole) ? binding.employeeRole.trim() : null
  if (employeeRole === null) errors.push('employeeRole 必填且必须是非空字符串')

  const primary = binding.primaryProfile
  if (!isNonEmptyString(primary)) {
    errors.push('primaryProfile 必填且必须是非空字符串：没有主档案时"这次该用哪个模型"没有起点')
  }

  let fallbacks = binding.fallbackProfiles
  if (fallbacks === undefined || fallbacks === null) fallbacks = []
  if (!Array.isArray(fallbacks)) {
    // 不当成"没有 fallback"：那会把一个写错的结构读成"配置齐全但没有备用"。
    throw new BindingError(BINDING_ERRORS.FALLBACKS_NOT_ARRAY,
      'fallbackProfiles 必须是数组（给 null/undefined 表示没有备用；给别的类型是配置错误）')
  }

  const budget = validatePerRunBudget(binding.perRunBudget)
  if (!budget.ok) errors.push(...budget.errors)

  // ── 主档案 ──
  const seen = new Set()
  if (isNonEmptyString(primary)) {
    const id = primary.trim()
    seen.add(id)
    const skip = skipReasonFor(id, byId.get(id))
    if (skip === null) {
      chain.push(candidateOf(byId.get(id), { id, role: 'primary', order: 0 }))
    } else {
      // 主档案不可用 → 绑定不可用。**不**让 fallback 顶上来（见模块头 ①）。
      skipped.push(Object.freeze({ id, role: 'primary', order: 0, code: skip.code, message: skip.message }))
      errors.push(
        `主档案 ${id} 不可用（${skip.code}）：${skip.message}。` +
        '**不自动降级到 fallback**——fallback 是为"运行时连不上"准备的，' +
        '不是为"配置写错了"准备的；悄悄顶替会让 primaryProfile 一直是错的，' +
        '而每次运行都在用一个没人选过的模型',
      )
    }
  }

  // ── 备用档案 ──
  fallbacks.forEach((rawId, i) => {
    const order = i + 1
    const id = typeof rawId === 'string' ? rawId.trim() : rawId
    if (isNonEmptyString(id) && seen.has(id)) {
      // 去重：同一个档案出现两次会把"容错重试"变成"对着同一个模型重试两次"。
      skipped.push(Object.freeze({
        id, role: 'fallback', order, code: 'PROFILE_DUPLICATE',
        message: `备用档案 ${id} 在本次解析里已经出现过（主档案或更靠前的备用）：` +
          '重试同一个模型不是容错，而是把一次瞬时故障变成两次同样的失败',
      }))
      return
    }
    if (isNonEmptyString(id)) seen.add(id)
    const skip = skipReasonFor(id, isNonEmptyString(id) ? byId.get(id) : undefined)
    if (skip === null) {
      chain.push(candidateOf(byId.get(id), { id, role: 'fallback', order }))
    } else {
      skipped.push(Object.freeze({ id, role: 'fallback', order, code: skip.code, message: skip.message }))
    }
  })

  const primaryUsable = chain.some((c) => c.role === 'primary')
  let code = null
  let ok = true
  let message = ''
  if (errors.length > 0) {
    ok = false
    code = primaryUsable ? BINDING_ERRORS.BUDGET_INVALID : BINDING_ERRORS.PRIMARY_UNRESOLVED
    message = errors.join('；')
  } else if (chain.length === 0) {
    // 走到这里意味着 primary 没有非空字符串（上面已进 errors），
    // 因此这条分支是兜底：链为空时**永远不能**说"可以跑"。
    ok = false
    code = BINDING_ERRORS.NO_USABLE_PROFILE
    message = `岗位 ${employeeRole ?? '(未命名)'} 没有任何可用的模型档案`
  }

  return Object.freeze({
    ok,
    code,
    message,
    employeeRole,
    chain: Object.freeze(chain),
    skipped: Object.freeze(skipped),
    perRunBudget: budget.value,
    errors: Object.freeze(errors),
  })
}

/**
 * 把一次解析的结果压成**可落库的**快照（PRT-502 的冻结时点）。
 *
 * spec §6.7 明确「密钥轮换只影响轮换后创建的 Run」——同样地，档案与绑定的
 * 改动只影响改动后创建的 Run。因此一次 Run 启动时要把当时排好的链**记下来**：
 * 事后翻这次运行的记录，必须能看到"它当时打算依次用哪几个模型"，
 * 而不是拿现在的配置去反推（现在的配置可能已经变了）。
 *
 * 只存 id 与角色顺序，不存 provider/model 的值：那些值会随档案改动而变，
 * 存下来会变成两份互相矛盾的真相；id + 顺序足以在事后按时间线还原。
 */
export function chainSnapshot(resolution) {
  if (resolution === null || typeof resolution !== 'object') {
    throw new BindingError(BINDING_ERRORS.BINDING_NOT_OBJECT, 'chainSnapshot 需要 resolveModelChain 的结果')
  }
  return Object.freeze({
    employeeRole: resolution.employeeRole,
    ok: resolution.ok === true,
    code: resolution.code ?? null,
    order: Object.freeze((resolution.chain ?? []).map((c) => Object.freeze({ id: c.id, role: c.role }))),
    skipped: Object.freeze((resolution.skipped ?? []).map((s) => Object.freeze({ id: s.id ?? null, code: s.code }))),
    perRunBudget: resolution.perRunBudget ?? null,
  })
}
