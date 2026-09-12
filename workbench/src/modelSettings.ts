// workbench/src/modelSettings.ts
// ============================================================================
// PRT-507：模型设置页的**纯逻辑**
//
// 这一层单独存在，是因为它守的是一条已经被这个仓库反复证明的纪律：
//
//   **后端加了码、前端还是笼统提示 —— 那条码就等于没加。**
//
// 所以这里每一个后端码都必须映射到一段**可区分、可行动**的界面文案，
// 并且这个映射被用例逐条钉住（沿用 `browserUi.ts` 的做法）。
//
// ---------------------------------------------------------------------------
// 本模块最重要的一条判断：「没探测过」不是「探测失败」
//
// 后端对"密钥库打不开 / 布局不合法 / 没填 endpoint"返回 **503 + unavailable**，
// 那与一个 `ok:false` 的**探测判定**是两回事：
//
//   * 「没探测过」→ 用户该去查**密钥库/配置**；
//   * 「探测失败」→ 用户该去看**失败分类**（鉴权？网络？模型名？）。
//
// 如果把 503 渲染成红色的"连接失败"，用户会去查网络与供应商状态
// ——**一条完全错误的方向**，而且他会怀疑一个其实没被验证过的东西。
//
// 所以 `unavailable` 走一个**完全不同**的徽标（灰，"未测试"），
// 并且**绝不**显示失败分类（那时没有分类可言）。
//
// ---------------------------------------------------------------------------
// 第二条：失败分类决定了"该做什么"，而码决定了"是什么"
//
// `class` 有四种（fail-closed / config / transient / unknown），它们对应的
// 用户动作完全不同：
//   * `config`        → 去改配置（endpoint/模型名/供应商）——重试没用；
//   * `transient`     → 等一会儿重试；
//   * `fail-closed`   → **本机的问题**（凭证库），不要去供应商那边；
//   * `unknown`       → **不能猜**：说清"没归类"并让人看原始信息。
//
// 把 `unknown` 猜成 `transient` 会让用户反复重试一个永远不会好的配置错误。
// ============================================================================

/** 探测徽标的语气。`muted` 专供"未测试"——它**不是**失败。 */
export type ProbeTone = 'ok' | 'warn' | 'bad' | 'muted'

export interface ProbeVerdictLike {
  ok?: boolean
  code?: string
  class?: string
  message?: string
  latencyMs?: number | null
  cached?: boolean
  unavailable?: boolean
  missingCapabilities?: string[]
  capabilities?: Record<string, boolean>
  ageMs?: number
}

export interface ProbeBadge {
  tone: ProbeTone
  label: string
  detail: string
  /** 用户下一步该做什么；`null` 表示无需动作。 */
  action: string | null
  /** 是否显示"重试"按钮。**未测试也要能重试**——那正是修好之后要做的事。 */
  canRetry: boolean
}

/** 每个判定码 → 一句"这是什么"。码是**总的**：未列出的码走 `unknown` 分支。 */
const CODE_TEXT: Record<string, string> = {
  OK: '连通，鉴权通过，且模型在供应商的清单里',
  SECRET_UNAVAILABLE: '本机凭证库读不到或解不开',
  SECRET_REF_MISSING: '这个档案没有配凭证引用',
  AUTH_FAILED: '供应商拒绝了这把凭证',
  ENDPOINT_UNREACHABLE: '连不上这个地址',
  TLS_FAILED: 'TLS/证书校验没通过',
  RATE_LIMITED: '被供应商限流了',
  MODEL_NOT_FOUND: '供应商的清单里没有这个模型名',
  PROVIDER_ERROR: '供应商返回了服务端错误',
  BAD_RESPONSE: '地址答了，但答的不是一个模型 API',
  TIMEOUT: '超时了',
  CAPABILITY_MISSING: '连得上，但缺少这次运行需要的能力',
  UNCLASSIFIED: '这次失败无法归类',
}

/** 分类 → 该做什么。**这张表就是"用户下一步"的全部来源。** */
const CLASS_ACTION: Record<string, string> = {
  // 本机的问题：**不要去供应商那边**
  'fail-closed': '这是本机凭证库的问题，不是供应商的问题——请检查密钥库与当前账户作用域，不要去供应商控制台换钥匙。',
  // 改配置能解决，重试没用
  config: '这是配置问题，重试不会变好：请检查地址、模型名与供应商设置。',
  // 等一等
  transient: '这多半是暂时的：稍后重试。',
  // **不能猜**
  unknown: '这类失败没有归类，**不能当作暂时问题重试**：请看下面的原始信息后判断。',
}

/**
 * 把一个探测结果渲染成徽标。
 *
 * 三种输入走三条**互不重叠**的路：
 *   ① `unavailable === true` → 灰"未测试"（没有分类可显示）
 *   ② `ok === true`          → 绿
 *   ③ 其余                   → 按码与分类给红/黄
 */
export function probeBadge(verdict: ProbeVerdictLike | null | undefined): ProbeBadge {
  if (verdict === null || verdict === undefined || typeof verdict !== 'object') {
    return {
      tone: 'muted', label: '未测试', detail: '还没有测试过这个模型。',
      action: '点「测试连接」验证它现在能不能用——**没测过不等于可用**。', canRetry: true,
    }
  }

  // ① 「没探测过」。与失败**结构上**分开：这里没有码、没有分类、没有延迟。
  if (verdict.unavailable === true) {
    return {
      tone: 'muted',
      label: '未测试',
      detail: verdict.message ?? '这次没有探测过（不是探测失败）。',
      action: '这不是"连不上"。请先解决上面说的问题，然后重新测试。',
      canRetry: true,
    }
  }

  const code = typeof verdict.code === 'string' ? verdict.code : 'UNCLASSIFIED'
  const codeText = CODE_TEXT[code] ?? '这个结果码没有对应的说明（**未归类**）'

  // ② 通过
  if (verdict.ok === true) {
    const latency = typeof verdict.latencyMs === 'number' ? `，耗时 ${verdict.latencyMs} ms` : ''
    const caps = Object.keys(verdict.capabilities ?? {}).filter((k) => verdict.capabilities?.[k] === true)
    const capText = caps.length > 0
      ? `供应商报告的能力：${caps.join('、')}`
      : '供应商**没有报告任何能力**：空能力表不等于“什么都不支持”，需要时请向供应商确认'
    return {
      tone: 'ok',
      label: '通过',
      detail: `${codeText}${latency}。${capText}${verdict.cached === true ? '（来自缓存）' : ''}`,
      action: null,
      canRetry: true,
    }
  }

  // ③ 失败。分类决定"该做什么"。
  const cls = typeof verdict.class === 'string' ? verdict.class : 'unknown'
  const action = CLASS_ACTION[cls] ?? CLASS_ACTION.unknown

  // 缺能力是**黄色**：它连通、鉴权都正常，只是一项能力不具备。
  if (code === 'CAPABILITY_MISSING') {
    const missing = Array.isArray(verdict.missingCapabilities) ? verdict.missingCapabilities : []
    return {
      tone: 'warn',
      label: '能力不足',
      detail: `${codeText}${missing.length > 0 ? `：缺少 ${missing.join('、')}` : ''}`,
      action: '连接是好的，但这个模型做不了这次运行需要的事：请换一个模型，或降低对该能力的要求。',
      canRetry: true,
    }
  }

  return {
    tone: 'bad',
    label: '失败',
    // 码 + 分类都要出现：码说"是什么"，分类说"该做什么"。
    detail: `${codeText}（分类：${cls}）${typeof verdict.message === 'string' && verdict.message !== '' ? ` —— ${verdict.message}` : ''}`,
    action,
    canRetry: true,
  }
}

// ------------------------------------------------------------------ 档案行

export interface ProfileLike {
  id?: string
  displayName?: string
  provider?: string
  model?: string
  endpoint?: string | null
  runtimeType?: string
  secretRef?: string | null
  hasCredential?: boolean
  enabled?: boolean
  status?: string
}

export interface ProfileRowView {
  id: string
  title: string
  subtitle: string
  credential: { tone: ProbeTone; text: string }
  endpointText: string
  disabled: boolean
}

/**
 * 一个档案在列表里长什么样。
 *
 * 凭证状态**必须显式**：`hasCredential === false` 与"字段缺失"是两件事，
 * 后者我们**不知道**——而猜"没有"会显示一条永远不对的提示。
 */
export function profileRowView(profile: ProfileLike | null | undefined): ProfileRowView {
  const p = profile ?? {}
  const id = typeof p.id === 'string' ? p.id : ''
  const title = (typeof p.displayName === 'string' && p.displayName !== '' ? p.displayName : id) || '（未命名档案）'
  const provider = typeof p.provider === 'string' ? p.provider : ''
  const model = typeof p.model === 'string' ? p.model : ''

  let credential: ProfileRowView['credential']
  const known = typeof p.hasCredential === 'boolean' || 'secretRef' in p
  if (typeof p.hasCredential === 'boolean') {
    credential = p.hasCredential
      ? { tone: 'ok', text: '已配置凭证' }
      : { tone: 'warn', text: '没有凭证 —— 保存可以，运行会失败' }
  } else if (typeof p.secretRef === 'string' && p.secretRef !== '') {
    // 有引用名**不等于**那把钥匙有效：这里只报"引用了哪个名字"这件事。
    credential = { tone: 'ok', text: '引用了凭证名（是否有效要看测试结果）' }
  } else if (known) {
    credential = { tone: 'warn', text: '没有凭证 —— 保存可以，运行会失败' }
  } else {
    credential = { tone: 'muted', text: '凭证状态未知' }
  }

  const endpointText = typeof p.endpoint === 'string' && p.endpoint !== '' ? p.endpoint : '（未填地址）'
  const disabled = p.enabled === false || p.status === 'disabled'

  return {
    id,
    title,
    subtitle: `${provider || '（未填供应商）'} / ${model || '（未填模型）'}`,
    credential,
    endpointText,
    disabled,
  }
}

// ------------------------------------------------------------------ 表单错误（接 PRT-252）

export interface FieldErrorView {
  /** 该落到哪个输入框；`null` = 整体错误，落在表单顶部。 */
  field: string | null
  text: string
  hint: string | null
  candidates: string[]
}

/**
 * 把一次写失败（后端 400）翻成**能落到具体字段**的错误。
 *
 * 这是 PRT-252 那条工作的另一半：后端已经返回 `code`/`field`/`hint`/`candidates`，
 * 前端如果不消费它们，**用户看到的仍然只有一整句 toast**——
 * 而"错在哪个框"才是他要的信息。
 */
export function fieldErrorFrom(body: unknown): FieldErrorView {
  const b = (body ?? {}) as Record<string, unknown>
  const field = typeof b.field === 'string' && b.field !== '' ? b.field : null
  const text = typeof b.error === 'string' && b.error !== '' ? b.error : '保存失败（服务端没有给出原因）'
  const hint = typeof b.hint === 'string' && b.hint !== '' ? b.hint : null
  const candidates = Array.isArray(b.candidates) ? b.candidates.filter((c): c is string => typeof c === 'string') : []
  return { field, text, hint, candidates }
}

/**
 * 取候选建议时**必须去重**，且**不得把用户已经填的值混进去**
 * ——那看起来像"系统认可了你输入的那个"，而它其实并不存在。
 */
export function suggestCandidates(candidates: readonly string[], current: string): string[] {
  const cur = typeof current === 'string' ? current : ''
  const seen = new Set<string>()
  const out: string[] = []
  for (const c of candidates) {
    if (typeof c !== 'string' || c === '' || c === cur || seen.has(c)) continue
    seen.add(c)
    out.push(c)
  }
  return out
}

// ------------------------------------------------------------------ fallback 链（接 PRT-502）

export interface ChainEntryLike {
  profileId?: string | null
  reason?: string | null
  skipped?: boolean
  displayName?: string | null
}

export interface ChainEntryView {
  index: number
  label: string
  role: 'primary' | 'fallback' | 'unusable'
  note: string | null
}

/**
 * 解析链的展示。
 *
 * 关键：**不可用的候选也要显示出来，并带上原因**。
 * 只显示"能用的那些"会让用户以为链条比实际短，而一次运行失败之后
 * 他没有任何线索知道"其实还有一个候选，只是被跳过了"。
 */
export function chainView(entries: readonly ChainEntryLike[] | null | undefined): ChainEntryView[] {
  if (!Array.isArray(entries)) return []
  return entries.map((e, i) => {
    const usable = e?.skipped !== true
    const role: ChainEntryView['role'] = !usable ? 'unusable' : i === 0 ? 'primary' : 'fallback'
    const label = (typeof e?.displayName === 'string' && e.displayName !== '')
      ? e.displayName
      : (typeof e?.profileId === 'string' && e.profileId !== '' ? e.profileId : '（未知档案）')
    return {
      index: i,
      label,
      role,
      // 原因**永远显示**（包括可用项）："为什么是它"与"为什么不是它"同样重要。
      note: typeof e?.reason === 'string' && e.reason !== '' ? e.reason : null,
    }
  })
}

// ------------------------------------------------------------------ 导入计划（接 PRT-508）

export interface ImportPlanLike {
  ok?: boolean
  conflicts?: readonly string[]
  keptLocal?: readonly string[]
  toCreate?: readonly string[]
  toUpdate?: readonly string[]
  refused?: readonly string[]
  code?: string
  message?: string
}

export interface ImportPlanView {
  ok: boolean
  headline: string
  /** 每一条都是"会发生什么"的一句话；空数组表示没有可说的。 */
  lines: string[]
  /** 需要用户显式确认才能继续。 */
  needsConfirm: boolean
  blocked: string | null
}

/**
 * 导入计划的展示。
 *
 * **拒绝优先**：包里有密钥或其他硬性不适用时，整个计划不可执行——
 * 此时不该再列出"将会更新 3 个档案"这种会让人以为"反正能导"的信息。
 */
export function importPlanView(plan: ImportPlanLike | null | undefined): ImportPlanView {
  if (plan === null || plan === undefined || typeof plan !== 'object') {
    return { ok: false, headline: '没有导入计划', lines: [], needsConfirm: false, blocked: '先选择一个配置文件。' }
  }
  const refused = Array.isArray(plan.refused) ? plan.refused : []
  const conflicts = Array.isArray(plan.conflicts) ? plan.conflicts : []
  const keptLocal = Array.isArray(plan.keptLocal) ? plan.keptLocal : []
  const toCreate = Array.isArray(plan.toCreate) ? plan.toCreate : []
  const toUpdate = Array.isArray(plan.toUpdate) ? plan.toUpdate : []

  if (plan.ok === false) {
    return {
      ok: false,
      headline: '这个包不能导入',
      lines: [],
      needsConfirm: false,
      blocked: typeof plan.message === 'string' && plan.message !== '' ? plan.message : '包的内容不适用。',
    }
  }

  const lines: string[] = []
  if (toCreate.length > 0) lines.push(`新建 ${toCreate.length} 个模型档案`)
  if (toUpdate.length > 0) lines.push(`更新 ${toUpdate.length} 个模型档案`)
  if (keptLocal.length > 0) {
    // **跳过的也要说出来**：否则用户以为导入把一切都覆盖了。
    lines.push(`保留本机现有设置 ${keptLocal.length} 项（导入不覆盖它们）`)
  }
  if (conflicts.length > 0) lines.push(`与现有配置冲突 ${conflicts.length} 项`)

  return {
    ok: true,
    headline: lines.length > 0 ? '可以导入' : '这个包里没有需要变更的内容',
    lines,
    needsConfirm: toCreate.length + toUpdate.length > 0,
    blocked: null,
  }
}
