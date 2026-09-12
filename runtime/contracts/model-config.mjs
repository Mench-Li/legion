// runtime/contracts/model-config.mjs
// ============================================================================
// PRT-252：Workbench 模型配置的**产品化校验**与**用户可见错误**
//
// ## 现在的缺口（读完代码之后的具体形态）
//
// 前端 `workbench/src/api.ts` 里有一份**硬编码**的候选表，它的注释写着：
//
//   DSH 部署可用模型候选（来源：~/.dsh/settings.yaml 各 provider.models）
//
// 也就是说：那份表是**某台机器上某个 DSH 部署**的快照。而服务端
// `POST /api/models` **什么都不校验**——`provider` / `model` 非空就往
// `agent_models` 里写，然后回一个 200。
//
// 后果是三件不同的事被同一个"成功"盖住：
//
//   ① 用户照着前端那份旧表配了一个**这台机器上并不存在**的模型 → 存下来了；
//   ② 用户在另一台机器上配了模型，换机器后配置还在、模型没了 → 存下来了；
//   ③ 配的是对的，但那个档案**没有凭证** → 存下来了，跑的时候才发现。
//
// 三种情况都在**很久之后、别的地方**才暴露，而且暴露出来的错误与
// "当初配置时点错了"之间**没有任何连接**。用户看到的是一次莫名其妙的运行失败。
//
// ## 本模块的判断
//
// **「能存下来」不等于「能跑」。** 配置错误必须在**配置的那一刻**、
// 用**用户能看懂的话**说出来，并带上"下一步做什么"。
//
// 但这里有两个很容易搞错的地方，本模块刻意分开：
//
// ### ① 「校验不了」绝不等同于「配置错了」
//
// 如果模型档案仓储不可用（读不到），我们**不知道**用户配得对不对。
// 这时报"未知供应商"是**撒谎**——它会让人去查拼写，而真正的问题是
// 我们根本没查成。所以那是独立的 `CANNOT_VALIDATE`，并且**fail closed**
// （不通过），因为一个"查不了就放行"的校验比没有校验更坏。
//
// ### ② 一个档案都没有时，报「未知供应商」是误导
//
// 没有任何档案 → 用户**还没登记任何模型**。此时说"你选的供应商未知"
// 会把人引向"我是不是拼错了"，而真正该做的是"先去登记一个"。
// 所以那是 `NO_PROFILES`，文案直接给出下一步。
//
// 这与本项目已经记过的那条同源：**错误的具体程度必须与实际的确定程度相称。**
//
// ### ③ 缺凭证是**警告**，不是拒绝
//
// "先登记模型、后补凭证"是一个**合法**的操作顺序（而且很常见）。
// 拒绝它会把一条正常路径堵死。但静默通过也不行——用户会以为配好了。
// 所以它是 `ok: true` 加上一条**必须显示出来**的 warning。
// **不允许存在"看起来成功了但跑不了"的沉默状态。**
// ============================================================================

/** 校验结果码。`OK` 之外的每一个都带"下一步该做什么"。 */
export const MODEL_CONFIG_CODES = Object.freeze({
  OK: 'MODEL_CONFIG_OK',
  EMPTY_SELECTION: 'MODEL_CONFIG_EMPTY_SELECTION',
  /** 读不到档案仓储——**校验不了**，与"配置错了"是两件事。 */
  CANNOT_VALIDATE: 'MODEL_CONFIG_CANNOT_VALIDATE',
  /** 一个档案都没登记——不是"未知供应商"。 */
  NO_PROFILES: 'MODEL_CONFIG_NO_PROFILES',
  UNKNOWN_PROVIDER: 'MODEL_CONFIG_UNKNOWN_PROVIDER',
  UNKNOWN_MODEL: 'MODEL_CONFIG_UNKNOWN_MODEL',
})

/** 警告码（`ok: true` 但必须显示）。 */
export const MODEL_CONFIG_WARNINGS = Object.freeze({
  NO_CREDENTIAL: 'MODEL_CONFIG_NO_CREDENTIAL',
  PROFILE_DISABLED: 'MODEL_CONFIG_PROFILE_DISABLED',
})

/** 候选列表在错误文案里最多列几个——列全了会把一屏塞满，反而没人看。 */
const MAX_CANDIDATES = 6

const nonEmptyString = (v) => typeof v === 'string' && v.trim() !== ''

/**
 * 从档案里取出"供应商 → 型号"的可用集合。
 *
 * **不猜、不模糊匹配**：型号名不做大小写归一以外的任何处理，
 * 更不做"看起来像"的近似——那会让一个拼错的型号被悄悄接受。
 */
function catalogOf(profiles) {
  const byProvider = new Map()
  for (const p of profiles) {
    if (p === null || typeof p !== 'object') continue
    const provider = nonEmptyString(p.provider) ? p.provider.trim() : null
    const model = nonEmptyString(p.model) ? p.model.trim() : null
    if (provider === null || model === null) continue
    if (!byProvider.has(provider)) byProvider.set(provider, [])
    byProvider.get(provider).push({ model, raw: p })
  }
  return byProvider
}

/**
 * 校验一次「智能体默认模型」选择。
 *
 * @param {object} args
 * @param {string} args.provider  用户提交的供应商
 * @param {string} args.model     用户提交的型号
 * @param {Array|null} args.profiles 产品登记过的模型档案；`null` 表示**读不到**
 * @returns {{
 *   ok: boolean, code: string, message: string,
 *   field: string|null, hint: string|null, candidates: string[],
 *   warnings: Array<{code: string, message: string}>,
 *   profile: object|null,
 * }}
 */
export function validateAgentModelSelection({ provider = '', model = '', profiles = null } = {}) {
  const base = { candidates: [], warnings: [], profile: null }
  const fail = (code, message, { field = null, hint = null, candidates = [] } = {}) =>
    Object.freeze({ ...base, ok: false, code, message, field, hint, candidates: Object.freeze(candidates) })

  // ① 先看选择本身。空值是最常见的一种，且它与"未知"完全不同。
  if (!nonEmptyString(provider) || !nonEmptyString(model)) {
    const missing = !nonEmptyString(provider) && !nonEmptyString(model) ? 'provider/model'
      : (!nonEmptyString(provider) ? 'provider' : 'model')
    return fail(MODEL_CONFIG_CODES.EMPTY_SELECTION, `没有选择模型：缺少 ${missing}`, {
      field: missing,
      hint: '请从可用模型列表里选一个具体的供应商与型号。',
    })
  }

  // ② **校验不了**与**配置错了**必须分开。读不到仓储时我们什么都不知道，
  //    此时说"未知供应商"是撒谎——它会让人去查拼写。
  if (profiles === null || profiles === undefined || !Array.isArray(profiles)) {
    return fail(MODEL_CONFIG_CODES.CANNOT_VALIDATE,
      '无法校验模型配置：读不到模型档案列表。这一条**未被验证**，不等于配置有错。', {
        hint: '请确认 team-hub 已就绪并已登记模型档案，然后重试。',
      })
  }

  // ③ 一个档案都没有 → 用户还没登记。说"未知供应商"会把人引向查拼写，
  //    而真正该做的是"先去登记一个"。
  if (profiles.length === 0) {
    return fail(MODEL_CONFIG_CODES.NO_PROFILES,
      '还没有登记任何模型档案，因此无法把它指定给智能体。', {
        hint: '请先在「模型设置」里登记一个供应商与型号（并配置凭证），再回来指定。',
      })
  }

  const wantProvider = provider.trim()
  const wantModel = model.trim()
  const catalog = catalogOf(profiles)

  // ④ 供应商不在已登记的集合里。文案里给出**实际登记过**的供应商。
  if (!catalog.has(wantProvider)) {
    const known = [...catalog.keys()].sort()
    return fail(MODEL_CONFIG_CODES.UNKNOWN_PROVIDER,
      `没有已登记的供应商「${wantProvider}」。`, {
        field: 'provider',
        hint: known.length > 0
          ? `已登记的供应商：${known.slice(0, MAX_CANDIDATES).join('、')}${known.length > MAX_CANDIDATES ? ' 等' : ''}。`
          : '请先在「模型设置」里登记一个供应商。',
        candidates: known,
      })
  }

  // ⑤ 供应商对，但型号不在该供应商下。
  const entries = catalog.get(wantProvider)
  const hit = entries.find((e) => e.model === wantModel)
  if (hit === undefined) {
    const models = entries.map((e) => e.model)
    return fail(MODEL_CONFIG_CODES.UNKNOWN_MODEL,
      `供应商「${wantProvider}」下没有型号「${wantModel}」。`, {
        field: 'model',
        hint: `该供应商已登记的型号：${models.slice(0, MAX_CANDIDATES).join('、')}${models.length > MAX_CANDIDATES ? ' 等' : ''}。`,
        candidates: models,
      })
  }

  // ⑥ 通过了。但"合法"不等于"能跑"——把两件会**静默地**导致跑不起来的事
  //    作为 warning 带出去（不拒绝，因为"先登记后补凭证"是合法顺序）。
  const warnings = []
  const raw = hit.raw
  const disabled = raw.enabled === false || raw.status === 'disabled' || raw.disabled === true
  if (disabled) {
    warnings.push({
      code: MODEL_CONFIG_WARNINGS.PROFILE_DISABLED,
      message: `模型档案「${raw.displayName ?? raw.id ?? hit.model}」已被停用，指定给它之后运行会失败。`,
    })
  }
  // `secretRef` 为 null/空 表示这个档案没有凭证。
  // 注意这里**只判断"有没有"，不读取值**——密钥永远不进这个模块。
  //
  // 档案有两种形态：仓储的 descriptor 带 `hasCredential`（布尔），
  // 完整档案带 `secretRef`。两者都认。
  //
  // **两者都没有时不报这条警告**：那时我们**不知道**它有没有凭证，
  // 而猜"没有"会制造一条**永远不对**的警告（按本项目已记过的那条，
  // 那与没有警告是同一件事）。**不知道就不说**，只在真正知道时才说。
  const credentialKnown = typeof raw.hasCredential === 'boolean' || 'secretRef' in raw
  const hasCredential = typeof raw.hasCredential === 'boolean' ? raw.hasCredential : nonEmptyString(raw.secretRef)
  if (credentialKnown && !hasCredential) {
    warnings.push({
      code: MODEL_CONFIG_WARNINGS.NO_CREDENTIAL,
      message: `模型档案「${raw.displayName ?? raw.id ?? hit.model}」还没有配置凭证，现在保存可以，但**运行会失败**。`,
    })
  }

  return Object.freeze({
    ...base,
    ok: true,
    code: MODEL_CONFIG_CODES.OK,
    message: '模型配置有效。',
    field: null,
    hint: null,
    candidates: Object.freeze([]),
    warnings: Object.freeze(warnings),
    profile: raw,
  })
}

/**
 * 把校验结果压成**一行**给 toast 用。
 *
 * 用户可见是这条需求的全部意义：失败时必须能看懂"哪里错了、下一步做什么"，
 * 而不是看到一个 400 或一句 `UNKNOWN_PROVIDER`。
 * 警告也一并带出——**不允许"看起来成功了但跑不了"的沉默状态**。
 */
export function describeModelConfigResult(result) {
  if (result === null || typeof result !== 'object') return '模型配置未验证'
  if (result.ok !== true) {
    const parts = [result.message]
    if (result.hint) parts.push(result.hint)
    return parts.join(' ')
  }
  if (Array.isArray(result.warnings) && result.warnings.length > 0) {
    return result.warnings.map((w) => w.message).join(' ')
  }
  return result.message ?? '模型配置有效。'
}

/**
 * 供路由直接抛出用：带 `statusCode` 与结构化字段，
 * 由 `handleWrite` 原样带进响应体（前端据此渲染到具体字段上）。
 */
export function modelConfigErrorFor(result) {
  const err = new Error(describeModelConfigResult(result))
  err.statusCode = 400
  err.code = result?.code ?? MODEL_CONFIG_CODES.CANNOT_VALIDATE
  if (result?.field) err.field = result.field
  if (result?.hint) err.hint = result.hint
  if (Array.isArray(result?.candidates)) err.candidates = result.candidates
  return err
}
