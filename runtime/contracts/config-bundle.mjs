// runtime/contracts/config-bundle.mjs
// ============================================================================
// 产品配置导入导出（PRT-508，spec §6.6 第 403 行 / §3.1）
//
// spec 两句话：
//   §6.6 第 403 行：「配置导入导出；**导出不包含密钥**。」
//   §3.1：模型密钥不进入提示词、业务数据库正文、日志、**导出证据**或能力包。
//
// 纯模块：构造、校验、**导入计划**（dry run），不做任何 I/O。
// 真正的读写在 team-hub 的路由层。
//
// ---------------------------------------------------------------------------
// 为什么 `secretRef` **总是**被剥掉，而不是"默认剥掉、可以打开"
//
// 两条理由，第二条更根本：
//
// ① 引用名本身泄漏密钥库结构。仓库里已经有一次同样的判断——
//    `toModelDescriptor` 只暴露 `hasCredential`，不暴露引用名，
//    理由写的是"引用名也是可枚举的攻击面"。同一份判断不该在导出路径上放宽。
//
// ② **`secretRef` 是**本机**的配置，不是模型档案的属性。**
//    它命名的是*这台机器*密钥库里的一个槽位。把它带到另一台机器上，
//    那个名字什么也不指——最坏的结果是"新机器上恰好有一个同名槽位，
//    于是这条档案用上了一把完全无关的钥匙"，而且**看起来一切正常**。
//
// 所以导出时每个档案保留 `credentialRequired`（它**需要**凭证，这是档案的
// 属性），丢掉 `secretRef`（它在哪台机器上解析，是那台机器的事）。
//
// 于是同一台机器上的备份也确实需要重新绑定一次引用。这是**有意**的代价：
// 少一次点击，换"跨机器导入时不会悄悄接上一把无关的钥匙"。
// ============================================================================

import { MODEL_PROFILE_FIELDS, findPlaintextSecrets, validateProfile } from './model.mjs'

/** 导出格式版本。**不兼容时拒绝导入**，而不是尽力解析。 */
export const CONFIG_BUNDLE_VERSION = 1

/** 导出内容的种类。 */
export const BUNDLE_KINDS = Object.freeze(['model-profiles', 'model-bindings', 'full'])

/** 冲突策略：已存在的 id 内容不同时怎么办。 */
export const CONFLICT_POLICIES = Object.freeze(['fail', 'keep', 'overwrite'])

/** 导入计划里的动作种类。 */
export const IMPORT_ACTIONS = Object.freeze(['create', 'update', 'skip', 'conflict'])

export const BUNDLE_ERRORS = Object.freeze({
  NOT_OBJECT: 'BUNDLE_NOT_OBJECT',
  UNSUPPORTED_VERSION: 'BUNDLE_VERSION_UNSUPPORTED',
  KIND_INVALID: 'BUNDLE_KIND_INVALID',
  PROFILES_NOT_ARRAY: 'BUNDLE_PROFILES_NOT_ARRAY',
  BINDINGS_NOT_ARRAY: 'BUNDLE_BINDINGS_NOT_ARRAY',
  UNKNOWN_FIELD: 'BUNDLE_UNKNOWN_FIELD',
  PROFILE_INVALID: 'BUNDLE_PROFILE_INVALID',
  BINDING_INVALID: 'BUNDLE_BINDING_INVALID',
  CONTAINS_SECRET: 'BUNDLE_CONTAINS_SECRET',
  SECRET_REF_PRESENT: 'BUNDLE_SECRET_REF_PRESENT',
  CONFLICT_POLICY_INVALID: 'CONFLICT_POLICY_INVALID',
  ACTOR_REQUIRED: 'ACTOR_REQUIRED',
})

export class BundleError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'BundleError'
    this.code = code
    Object.assign(this, extra)
  }
}

/** 顶层允许的字段。未知字段**拒绝**（而不是忽略）——见下方说明。 */
export const BUNDLE_FIELDS = Object.freeze([
  'version',
  'kind',
  'exportedAtMs',
  'exportedBy',
  'note',
  /**
   * 是否含实际密钥值。**恒为 false**；存在是为了让读者能验，而不是让它可选。
   *
   * 这两个字段之所以是**布尔**而不是一个策略字符串（比如
   * `secretPolicy: 'references-omitted'`）：`findPlaintextSecrets` 会把
   * "键名含 secret/token/key/credential/password 且值是**字符串**"判成
   * 明文密钥载体。于是一个描述"密钥是怎么处理的"的字符串字段，
   * 会让**自己导出的包无法导入**——报的还是
   * "导入包含疑似明文密钥：$.credentialPolicy"，而那里一个密钥都没有。
   *
   * 这与 PRT-102 的 `limits.maxTokens` 是同一类误判（键名像密钥载体、
   * 值完全无害）。那次的修法是给判据加"值必须是字符串"这个条件；
   * 这一次值**就是**字符串，所以修法在**表达方式**上：用布尔而不是
   * 字符串枚举——布尔不在判据的射程内，而且两个布尔比一个枚举更精确
   * （"有没有密钥值"与"有没有引用名"是两件事）。
   *
   * 让探测器保持严格，而不是为了一个字段名去放宽它。
   */
  'containsSecrets',
  /** 是否含 `secretRef` 引用名。**恒为 false**（理由见文件头"为什么总是剥掉"）。 */
  'credentialRefsIncluded',
  'profiles',
  'bindings',
])

/** 绑定允许的字段。 */
export const BUNDLE_BINDING_FIELDS = Object.freeze([
  'scope',
  'employeeRole',
  'primaryProfile',
  'fallbackProfiles',
  'perRunBudget',
])

/**
 * 档案里**可导出**的字段：`MODEL_PROFILE_FIELDS` 去掉 `secretRef`。
 *
 * 由 `MODEL_PROFILE_FIELDS` 派生而不是手抄一份：手抄的那份会在 PRT-501
 * 增删字段时漂移，而漂移的表现是"新字段静默地不被导出"。
 */
export const EXPORTABLE_PROFILE_FIELDS = Object.freeze(
  MODEL_PROFILE_FIELDS.filter((f) => f !== 'secretRef'),
)

/**
 * 判断一条档案是否"需要凭证"。
 *
 * 注意判据是 `secretRef != null`，**不是**"有没有 endpoint"：
 * 本地模型可以合法地没有 endpoint 也没有凭证。
 */
export function credentialRequiredOf(profile) {
  if (profile === null || typeof profile !== 'object') return false
  const ref = profile.secretRef
  return ref !== null && ref !== undefined && ref !== ''
}

/** 把一条内部档案压成可导出的形态。**永远不含 `secretRef`。** */
export function toExportableProfile(profile) {
  const out = {}
  for (const f of EXPORTABLE_PROFILE_FIELDS) {
    if (profile[f] !== undefined) out[f] = profile[f]
  }
  // `limits` 可能是冻结对象；导出必须是普通可序列化值
  if (out.limits !== undefined && out.limits !== null) out.limits = { ...out.limits }
  // `credentialRequired`：**已经带了就原样保留**，只有没有时才从 `secretRef` 推。
  //
  // 导出态里没有 `secretRef`，所以对一份**导出物**再导出时，
  // `credentialRequired` 是"这条档案要不要凭证"的**唯一**事实来源。
  // 一律重算会把它变成 `false`：于是"主模型需要凭证"这件事在一次
  // 导出→导入→导出之后**静默消失**，而一台新机器导入这份包时不会再
  // 提示去绑定引用——它会在第一次真实运行、解密钥的时候才发现。
  out.credentialRequired = typeof profile.credentialRequired === 'boolean'
    ? profile.credentialRequired
    : credentialRequiredOf(profile)
  return out
}

/** 把一条内部绑定压成可导出的形态（绑定本来就不含密钥）。 */
export function toExportableBinding(binding) {
  const out = {}
  for (const f of BUNDLE_BINDING_FIELDS) {
    if (binding[f] !== undefined) out[f] = binding[f]
  }
  if (Array.isArray(out.fallbackProfiles)) out.fallbackProfiles = [...out.fallbackProfiles]
  if (out.perRunBudget !== undefined && out.perRunBudget !== null) out.perRunBudget = { ...out.perRunBudget }
  return out
}

/**
 * 构造导出包。
 *
 * **两条出口保证**：
 *   ① 任何档案里出现疑似明文密钥 → **拒绝构造**（不是"剥掉再继续"）。
 *      剥掉需要脱敏逻辑正确，而脱敏漏一处就等于把密钥永久留在导出文件里；
 *      拒绝是 fail closed，且失败立刻可见。这与 `assertAuditClean` 同一条理由。
 *   ② `secretRef` 一律剥掉（理由见文件头）。
 *
 * @throws {BundleError} 含明文密钥 / 参数不合法
 */
export function buildBundle({
  profiles = [],
  bindings = [],
  kind = 'full',
  exportedAtMs = null,
  exportedBy = null,
  note = null,
} = {}) {
  if (!BUNDLE_KINDS.includes(kind)) {
    throw new BundleError(BUNDLE_ERRORS.KIND_INVALID,
      `未知的导出种类 ${JSON.stringify(kind)}：只接受 ${BUNDLE_KINDS.join(' / ')}`)
  }
  if (!Array.isArray(profiles)) {
    throw new BundleError(BUNDLE_ERRORS.PROFILES_NOT_ARRAY, 'profiles 必须是数组')
  }
  if (!Array.isArray(bindings)) {
    throw new BundleError(BUNDLE_ERRORS.BINDINGS_NOT_ARRAY, 'bindings 必须是数组')
  }

  const exportable = profiles.map(toExportableProfile)
  const exportableBindings = bindings.map(toExportableBinding)

  // 出口保证 ①：先把要写出去的东西整体查一遍再返回。
  // 顺序刻意：**先查后返回**，不存在"已经返回了才发现要拒绝"的窗口。
  const hits = findPlaintextSecrets({ kind, note, profiles: exportable, bindings: exportableBindings })
  if (hits.length > 0) {
    throw new BundleError(BUNDLE_ERRORS.CONTAINS_SECRET,
      `导出被拒绝：待导出的配置里含疑似明文密钥（${hits.join(', ')}）。` +
      '导出永远不得包含密钥，而"先剥掉再继续"需要脱敏逻辑完全正确——拒绝更安全',
      { hits })
  }

  // 出口保证 ②：显式再查一遍 `secretRef` 是否真的没了。
  // 上面那条查的是"密钥**值**"，这条查的是"引用**名**"——两者不同，
  // 而 `EXPORTABLE_PROFILE_FIELDS` 的手工改动会让第二条失效。
  // 一条防线如果只在"写对代码"时才有效，就需要一条能验它在不在的检查。
  for (const p of exportable) {
    if (Object.prototype.hasOwnProperty.call(p, 'secretRef') && p.secretRef !== null && p.secretRef !== undefined) {
      throw new BundleError(BUNDLE_ERRORS.SECRET_REF_PRESENT,
        `导出被拒绝：档案 ${p.id} 的可导出形态里仍有 secretRef。` +
        'secretRef 命名的是**本机**密钥库槽位，跨机器导入时那个名字什么也不指',
        { profileId: p.id })
    }
  }

  return Object.freeze({
    version: CONFIG_BUNDLE_VERSION,
    kind,
    exportedAtMs: typeof exportedAtMs === 'number' && Number.isFinite(exportedAtMs) ? exportedAtMs : null,
    exportedBy: typeof exportedBy === 'string' && exportedBy !== '' ? exportedBy : null,
    note: typeof note === 'string' && note !== '' ? note : null,
    // 让读者**知道手里这份是什么**。导入方分不清"没有引用"与"引用被剥掉了"，
    // 就会静默地留下没有凭证的档案。两个布尔把这件事说全。
    containsSecrets: false,
    credentialRefsIncluded: false,
    profiles: Object.freeze(exportable),
    bindings: Object.freeze(exportableBindings),
  })
}

/**
 * 校验一份导入包。
 *
 * 三条纪律：
 *   - **版本不兼容直接拒绝**，不尽力解析（尽力解析会把"格式变了"变成"少导了几条"）；
 *   - **未知顶层字段拒绝**，不忽略（与 ModelProfile 同一条：忽略会让密钥字段搭便车）；
 *   - **含密钥直接拒绝**（导入方向也要挡：一份被别人塞了密钥的文件不该进库）。
 */
export function validateBundle(raw) {
  const errors = []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['导入包必须是一个对象'], value: null }
  }

  if (raw.version !== CONFIG_BUNDLE_VERSION) {
    errors.push(`导入包版本 ${JSON.stringify(raw.version)} 不受支持（本版本只接受 ${CONFIG_BUNDLE_VERSION}）`)
  }
  if (raw.kind !== undefined && !BUNDLE_KINDS.includes(raw.kind)) {
    errors.push(`未知的导出种类 ${JSON.stringify(raw.kind)}`)
  }
  for (const key of Object.keys(raw)) {
    if (!BUNDLE_FIELDS.includes(key)) {
      errors.push(`未知字段 ${key}：导入包只接受受控字段，避免密钥搭便车`)
    }
  }
  // `containsSecrets: true` 的文件本身就是一种声明"我有密钥"——拒绝
  if (raw.containsSecrets === true) {
    errors.push('导入包声明 containsSecrets=true：拒绝导入。导出永远不得包含密钥')
  }
  if (raw.containsSecrets !== undefined && raw.containsSecrets !== false && raw.containsSecrets !== true) {
    errors.push('containsSecrets 必须是布尔值')
  }
  // 引用名同理：一份声明"我带引用名"的包不该进库
  if (raw.credentialRefsIncluded === true) {
    errors.push('导入包声明 credentialRefsIncluded=true：拒绝导入。引用名是本机配置，跨机器没有意义')
  }
  if (raw.credentialRefsIncluded !== undefined &&
      raw.credentialRefsIncluded !== false && raw.credentialRefsIncluded !== true) {
    errors.push('credentialRefsIncluded 必须是布尔值')
  }

  // 密钥门禁：整包查一遍（含嵌套），再逐条查 profiles
  const hits = findPlaintextSecrets(raw)
  if (hits.length > 0) {
    errors.push(`导入包含疑似明文密钥（${hits.join(', ')}）：拒绝导入`)
  }

  const profiles = raw.profiles === undefined ? [] : raw.profiles
  if (!Array.isArray(profiles)) {
    errors.push('profiles 必须是数组')
  }
  const bindings = raw.bindings === undefined ? [] : raw.bindings
  if (!Array.isArray(bindings)) {
    errors.push('bindings 必须是数组')
  }
  if (errors.length > 0) return { ok: false, errors, value: null }

  const cleanProfiles = []
  const seenProfileIds = new Set()
  profiles.forEach((p, i) => {
    // **导出形态**里不该有 secretRef。带着它进来一律拒绝：
    // 一份"从别的机器带过来的引用名"在这里什么也不指，接受它等于
    // 让一条档案指向一把不存在的钥匙（或者更坏：一把同名但无关的钥匙）。
    if (p !== null && typeof p === 'object' &&
        Object.prototype.hasOwnProperty.call(p, 'secretRef') &&
        p.secretRef !== null && p.secretRef !== undefined && p.secretRef !== '') {
      errors.push(`profiles[${i}] 含 secretRef：导出包不得携带本机密钥库引用名`)
      return
    }
    // `credentialRequired` 是导出附加字段，`validateProfile` 不认识它，
    // 所以校验前先摘掉——但**要检查它是不是布尔**（它是导入方唯一的线索）。
    const { credentialRequired, ...profileForContract } = p ?? {}
    if (credentialRequired !== undefined && typeof credentialRequired !== 'boolean') {
      errors.push(`profiles[${i}].credentialRequired 必须是布尔值`)
      return
    }
    const v = validateProfile(profileForContract)
    if (!v.ok) {
      errors.push(`profiles[${i}]：${v.errors.join('；')}`)
      return
    }
    if (seenProfileIds.has(v.value.id)) {
      // 同一个 id 出现两次会让"导出→导入→导出"不稳定（后一条覆盖前一条），
      // 而且掩盖了"导出方有重复数据"这个事实
      errors.push(`profiles[${i}]：id ${v.value.id} 在同一个包里出现了两次`)
      return
    }
    seenProfileIds.add(v.value.id)
    cleanProfiles.push(Object.freeze({
      ...v.value,
      // 缺省视为 false（导出方没写就是"不需要凭证"）
      credentialRequired: credentialRequired === true,
    }))
  })

  const cleanBindings = []
  const seenBindingKeys = new Set()
  bindings.forEach((b, i) => {
    if (b === null || typeof b !== 'object' || Array.isArray(b)) {
      errors.push(`bindings[${i}] 必须是对象`)
      return
    }
    for (const key of Object.keys(b)) {
      if (!BUNDLE_BINDING_FIELDS.includes(key)) {
        errors.push(`bindings[${i}].${key} 不是绑定字段`)
      }
    }
    const scope = typeof b.scope === 'string' ? b.scope.trim() : ''
    const role = typeof b.employeeRole === 'string' ? b.employeeRole.trim() : ''
    if (scope === '') errors.push(`bindings[${i}].scope 必填`)
    if (role === '') errors.push(`bindings[${i}].employeeRole 必填`)
    if (typeof b.primaryProfile !== 'string' || b.primaryProfile.trim() === '') {
      errors.push(`bindings[${i}].primaryProfile 必填`)
    }
    if (b.fallbackProfiles !== undefined && !Array.isArray(b.fallbackProfiles)) {
      errors.push(`bindings[${i}].fallbackProfiles 必须是数组`)
    }
    if (scope !== '' && role !== '') {
      const k = `${scope}\u0000${role}`
      if (seenBindingKeys.has(k)) {
        errors.push(`bindings[${i}]：(${scope}, ${role}) 在同一个包里出现了两次`)
        return
      }
      seenBindingKeys.add(k)
      cleanBindings.push(Object.freeze({
        scope,
        employeeRole: role,
        primaryProfile: typeof b.primaryProfile === 'string' ? b.primaryProfile.trim() : '',
        fallbackProfiles: Object.freeze(Array.isArray(b.fallbackProfiles) ? [...b.fallbackProfiles] : []),
        perRunBudget: b.perRunBudget === undefined ? null : Object.freeze({ ...b.perRunBudget }),
      }))
    }
  })

  if (errors.length > 0) return { ok: false, errors, value: null }

  return {
    ok: true,
    errors: [],
    value: Object.freeze({
      version: raw.version,
      kind: raw.kind ?? 'full',
      exportedAtMs: raw.exportedAtMs ?? null,
      exportedBy: raw.exportedBy ?? null,
      containsSecrets: false,
      credentialRefsIncluded: false,
      profiles: Object.freeze(cleanProfiles),
      bindings: Object.freeze(cleanBindings),
    }),
  }
}

/** 档案里参与"内容是否相同"比较的字段（即导出面）。 */
function profileComparable(p) {
  const out = {}
  for (const f of EXPORTABLE_PROFILE_FIELDS) out[f] = p?.[f] ?? null
  if (out.limits !== null && typeof out.limits === 'object') out.limits = { ...out.limits }
  return out
}

function bindingComparable(b) {
  const out = {}
  for (const f of BUNDLE_BINDING_FIELDS) out[f] = b?.[f] ?? null
  if (Array.isArray(out.fallbackProfiles)) out.fallbackProfiles = [...out.fallbackProfiles]
  if (out.perRunBudget !== null && typeof out.perRunBudget === 'object') out.perRunBudget = { ...out.perRunBudget }
  return out
}

/** 两个 JSON 值是否相等（键序无关）。 */
function sameJson(a, b) {
  const norm = (v) => {
    if (v === null || v === undefined) return null
    if (Array.isArray(v)) return v.map(norm)
    if (typeof v === 'object') {
      const out = {}
      for (const k of Object.keys(v).sort()) out[k] = norm(v[k])
      return out
    }
    return v
  }
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b))
}

/**
 * 生成**导入计划**（dry run，不写任何东西）。
 *
 * 为什么必须先有计划：导入会改变"哪条任务用哪个模型"。一份导入包把
 * `primaryProfile` 从 A 改成 B，是**换模型**——它同时改变成本、质量、
 * 以及数据去了哪。静默应用意味着这三件事都在无人看到的情况下变了。
 *
 * 冲突策略（已存在且内容不同时）：
 *   `fail`（默认）→ 标 `conflict`，**不动**。要求调用方明确选择。
 *   `keep`        → 标 `skip`，保留库里那份。
 *   `overwrite`   → 标 `update`。
 *
 * 默认是 `fail` 而不是 `keep`：`keep` 看起来更"安全"，但它会让一次本该
 * 报错的导入**静默地什么都没做**——用户以为配置已经导入了。
 * 报错至少是可见的。
 *
 * 不删除：导出包里没有的档案/绑定**保持不动**。导入是"补齐与更新"，
 * 不是"同步成这份包"——后者会让一份不完整的包删掉整台机器的配置。
 */
export function planImport({
  bundle,
  existingProfiles = [],
  existingBindings = [],
  conflictPolicy = 'fail',
  actor = null,
} = {}) {
  if (!CONFLICT_POLICIES.includes(conflictPolicy)) {
    throw new BundleError(BUNDLE_ERRORS.CONFLICT_POLICY_INVALID,
      `未知冲突策略 ${JSON.stringify(conflictPolicy)}：只接受 ${CONFLICT_POLICIES.join(' / ')}`)
  }
  const validated = validateBundle(bundle)
  if (!validated.ok) {
    return { ok: false, errors: validated.errors, actions: [], summary: null }
  }
  const b = validated.value

  const profilesById = new Map()
  for (const p of existingProfiles) {
    if (p !== null && typeof p === 'object' && typeof p.id === 'string') profilesById.set(p.id, p)
  }
  const bindingsByKey = new Map()
  for (const x of existingBindings) {
    if (x !== null && typeof x === 'object') bindingsByKey.set(`${x.scope}\u0000${x.employeeRole}`, x)
  }

  const actions = []
  for (const incoming of b.profiles) {
    const existing = profilesById.get(incoming.id)
    if (existing === undefined) {
      actions.push(Object.freeze({
        kind: 'profile', id: incoming.id, action: 'create',
        reason: '本机没有这条档案',
        credentialRequired: incoming.credentialRequired === true,
      }))
      continue
    }
    if (sameJson(profileComparable(incoming), profileComparable(existing))) {
      actions.push(Object.freeze({
        kind: 'profile', id: incoming.id, action: 'skip', reason: '内容相同（重复导入是幂等的）',
      }))
      continue
    }
    if (conflictPolicy === 'keep') {
      // `keptLocal: true` 让它**可数**。只用 reason 文字表达的话，
      // 路由层要么去正则匹配自己的提示语，要么就只能报 `conflicts: 0`
      // ——而后者会让用户以为"没有冲突、导入成功了"，实际是包里的改动
      // 一处都没进去。一条"安静的成功"比一条错误更坏。
      actions.push(Object.freeze({
        kind: 'profile', id: incoming.id, action: 'skip', keptLocal: true,
        reason: '内容不同，策略 keep：保留本机那份（**包里的没有被导入**）',
      }))
    } else if (conflictPolicy === 'overwrite') {
      actions.push(Object.freeze({
        kind: 'profile', id: incoming.id, action: 'update',
        reason: '内容不同，策略 overwrite：用包里那份覆盖',
        // CAS 需要当前版本：不带它就没法表达"我改的是我看过的那一版"
        currentVersion: typeof existing.version === 'number' ? existing.version : null,
      }))
    } else {
      actions.push(Object.freeze({
        kind: 'profile', id: incoming.id, action: 'conflict',
        reason: '内容不同：换模型会同时改变成本、质量与数据去向，需要明确选择 keep 或 overwrite',
      }))
    }
  }

  for (const incoming of b.bindings) {
    const key = `${incoming.scope}\u0000${incoming.employeeRole}`
    const existing = bindingsByKey.get(key)
    const label = `${incoming.scope}/${incoming.employeeRole}`
    if (existing === undefined) {
      actions.push(Object.freeze({
        kind: 'binding', id: label, action: 'create',
        reason: '本机没有这条绑定',
        referencesProfile: incoming.primaryProfile,
      }))
      continue
    }
    if (sameJson(bindingComparable(incoming), bindingComparable(existing))) {
      actions.push(Object.freeze({
        kind: 'binding', id: label, action: 'skip', reason: '内容相同（重复导入是幂等的）',
      }))
      continue
    }
    if (conflictPolicy === 'keep') {
      actions.push(Object.freeze({
        kind: 'binding', id: label, action: 'skip', keptLocal: true,
        reason: '内容不同，策略 keep：保留本机那份（**包里的没有被导入**）',
      }))
    } else if (conflictPolicy === 'overwrite') {
      actions.push(Object.freeze({
        kind: 'binding', id: label, action: 'update',
        reason: '内容不同，策略 overwrite：用包里那份覆盖',
      }))
    } else {
      actions.push(Object.freeze({
        kind: 'binding', id: label, action: 'conflict',
        reason: '内容不同：岗位换模型会同时改变成本、质量与数据去向，需要明确选择 keep 或 overwrite',
      }))
    }
  }

  // 包里的绑定引用了一条**包里没有、本机也没有**的档案。
  // 照单全收会存下一条跑不起来的绑定——运行时才发现，那时已经认领任务、
  // 烧掉一次尝试。（与 PRT-502"主档案不可用直接 409"同一条纪律。）
  const willExist = new Set(existingProfiles.map((p) => p?.id).filter((x) => typeof x === 'string'))
  for (const incoming of b.profiles) willExist.add(incoming.id)
  const danglingRefs = []
  for (const incoming of b.bindings) {
    const refs = [incoming.primaryProfile, ...incoming.fallbackProfiles]
    for (const r of refs) {
      if (typeof r === 'string' && r !== '' && !willExist.has(r)) danglingRefs.push({ binding: `${incoming.scope}/${incoming.employeeRole}`, profile: r })
    }
  }

  const summary = Object.freeze({
    profiles: countBy(actions.filter((a) => a.kind === 'profile')),
    bindings: countBy(actions.filter((a) => a.kind === 'binding')),
    total: actions.length,
    willWrite: actions.filter((a) => a.action === 'create' || a.action === 'update').length,
    conflicts: actions.filter((a) => a.action === 'conflict').length,
    /**
     * 策略 `keep` 下**因为内容不同而被跳过**的条数。
     *
     * 与 `conflicts` 相加才是"包里有但没进去"的总数：
     * `keep` 会把冲突转成 `skip`，于是 `conflicts` 变成 0，
     * 而"一处都没导入"这件事必须仍然可数——否则回执上看起来是成功的。
     */
    keptLocal: actions.filter((a) => a.keptLocal === true).length,
    // 导入包里需要凭证的档案条数：导入方要去密钥库补多少条引用
    needsCredential: b.profiles.filter((p) => p.credentialRequired === true).length,
    danglingRefs: Object.freeze(danglingRefs),
  })

  return {
    ok: true,
    errors: [],
    conflictPolicy,
    actor,
    actions: Object.freeze(actions),
    summary,
    /** 可写入的档案（create/update 的那些），按计划裁好。 */
    value: b,
  }
}

function countBy(list) {
  const out = {}
  for (const a of list) out[a.action] = (out[a.action] ?? 0) + 1
  return Object.freeze(out)
}

/**
 * 计划是否可以安全应用。
 *
 * 两个都不安全的条件：还有未决冲突（`fail` 策略下），
 * 或存在悬空引用。**两者都是"应用了会坏"而不是"应用了会不完整"**，
 * 所以拒绝而不是尽力而为。
 */
export function assertApplicable(plan) {
  if (plan === null || typeof plan !== 'object' || plan.ok !== true) {
    return { ok: false, reason: '导入计划本身不合法', code: 'PLAN_INVALID' }
  }
  if (plan.summary.conflicts > 0) {
    return {
      ok: false,
      code: 'IMPORT_HAS_CONFLICTS',
      reason: `有 ${plan.summary.conflicts} 处冲突未决：换模型会同时改变成本、质量与数据去向，` +
        '请明确选择 keep（保留本机）或 overwrite（用包里那份覆盖）',
    }
  }
  if (plan.summary.danglingRefs.length > 0) {
    const first = plan.summary.danglingRefs[0]
    return {
      ok: false,
      code: 'IMPORT_DANGLING_PROFILE_REF',
      reason: `绑定 ${first.binding} 引用了不存在的模型档案 ${first.profile}：` +
        '照单全收会存下一条跑不起来的绑定，而它要到运行时才被发现有错',
    }
  }
  return { ok: true, code: null, reason: null }
}
