// runtime/context/assembler.mjs
// ============================================================================
// Context Assembler（PRT-407，spec §6.5）
//
// 把一批**候选来源**变成一份冻结的 `RunContextSnapshot`：
// 过滤越权与过期 → 按固定优先级排序 → 按 token 预算裁剪 → 记录全过程。
//
// 纯模块：不依赖 Cordis / DSH / 网络 / 文件系统（装配结果由调用方负责持久化）。
//
// ## 本文件的核心判断：**"部分包含"是第三种状态**
//
// `sources[]` 与 `excluded[]` 只能表达两件事：整个进去了 / 整个没进去。
// 而裁剪会产出第三种：**一个来源的正文只进去了一半**。
//
// 如果只记前两种，那么一份**截断过的**快照会声称模型看过了全文——
// 而 spec §6.5 要的恰恰是「还原其**实际**输入」。用户看到"文档 A 已包含"，
// 于是以为模型读完了整份规范，而模型实际上只看到前 2000 字。
//
// 所以快照有**三个**账本：
//
//     sources[]      整个（或按声明截断地）进去了
//     excluded[]     没进去，且**写明为什么**
//     truncations[]  进去了，但是**部分**——写明截掉多少
//
// 并且 `segments[]` 把最终文本切回来源：每一段给出 charStart/charEnd。
// 于是"模型看到的第 4000 个字符来自哪个来源的哪一版"是可回答的。
//
// ## 第二条判断：**权限判定先于一切**
//
// 越权来源在**读正文之前**就被排除。把正文读进来再过滤，会让正文短暂存在于
// 内存与日志里——而它的存在本身就是越权。所以 `canRead` 判定只用**元数据**
// （id / type / scope），不接受正文。
//
// ## 第三条判断：**必需的来源放不下时必须失败，不能静默省略**
//
// 一个"任务定义"没放进去的运行会照常跑，然后基于错误的上下文产出结论。
// 所以标记 `required` 的来源放不下时，装配**失败**并返回 `CONTEXT_TOO_LARGE`，
// 而不是交出一份看起来正常、实际缺了前提的快照。
// ============================================================================

import {
  CONTEXT_SNAPSHOT_SCHEMA_VERSION,
  EXCLUSION_REASONS,
  SOURCE_TRUST,
  TOKEN_ESTIMATOR_KINDS,
  createExclusion,
  createTokenMeasurement,
  freezeContextSnapshot,
} from '../contracts/context.mjs'
import { domainSeparatedHash } from '../contracts/canonical.mjs'
import { redactSource, REDACTION_SCHEMA } from './redaction.mjs'

/** 装配失败码。**装配失败没有快照**——半成品的快照比没有更坏。 */
export const ASSEMBLY_CODES = Object.freeze({
  /** 裁剪后仍超出预算（或必需来源放不下）。 */
  CONTEXT_TOO_LARGE: 'CONTEXT_TOO_LARGE',
  /** 没给 tokenizer，于是无法判断"放不放得下"——不猜。 */
  TOKENIZER_REQUIRED: 'TOKENIZER_REQUIRED',
  /** 候选不是数组 / 元素形状不对。 */
  BAD_CANDIDATE: 'BAD_CANDIDATE',
  /** 预算不是正整数（`null` 表示不限，是合法的）。 */
  BAD_BUDGET: 'BAD_BUDGET',
})

export class AssemblyError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'AssemblyError'
    this.code = code
    Object.assign(this, extra)
  }
}

const TRUST_RANK = { [SOURCE_TRUST.TRUSTED]: 0, [SOURCE_TRUST.UNTRUSTED]: 1 }

/**
 * 装配顺序的确定性排序键。
 *
 * 三级：**显式优先级**（`policy.priority` 里该来源类型的位次，未列出的排在最后）
 * → **可信性**（可信的在前）→ `(type, id, version)` 字典序。
 *
 * 为什么要拿可信性做第二级：同一优先级下把不可信内容排在前面，会让"模型先读到
 * 一段外部文本"成为默认——而外部文本是 prompt injection 的载体。
 * 这不是安全边界（边界是 ToolGuard/sandbox/审批），但默认顺序不该倒过来。
 */
function assemblyRank(source, priorityIndex) {
  const p = priorityIndex.has(source.type) ? priorityIndex.get(source.type) : Number.MAX_SAFE_INTEGER
  return { p, trust: TRUST_RANK[source.trust] ?? 1 }
}

function compareForAssembly(a, b, priorityIndex) {
  const ra = assemblyRank(a, priorityIndex)
  const rb = assemblyRank(b, priorityIndex)
  if (ra.p !== rb.p) return ra.p - rb.p
  if (ra.trust !== rb.trust) return ra.trust - rb.trust
  if (a.type !== b.type) return a.type < b.type ? -1 : 1
  if (a.id !== b.id) return a.id < b.id ? -1 : 1
  return a.version < b.version ? -1 : (a.version > b.version ? 1 : 0)
}

/**
 * 把正文按**字符**预算截断。
 *
 * 按字符而不是 token 截：tokenizer 只保证能数，不保证能切
 * （切在哪两个字符之间是 tokenizer 的实现细节）。所以这里先按比例估一个字符数，
 * 再向前收缩到真的放得下为止。收缩一定终止：每次至少减一个字符。
 */
function truncateToBudget(text, budgetTokens, count) {
  if (budgetTokens <= 0) return { kept: '', keptTokens: 0 }
  // 先按比例猜一个上界，再收缩。比例只是起点，正确性由后面的循环保证。
  const total = count(text)
  if (total <= budgetTokens) return { kept: text, keptTokens: total }
  let hi = text.length
  let lo = 0
  // 二分：count 对前缀是单调不减的（同一 tokenizer 下），因此可以二分。
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (count(text.slice(0, mid)) <= budgetTokens) lo = mid
    else hi = mid - 1
  }
  const kept = text.slice(0, lo)
  return { kept, keptTokens: count(kept) }
}

/** 把最终文本切成可回溯到来源的段落。 */
function renderSegment(source, effectiveContent, offset) {
  const header = `[${source.type}:${source.id}@${source.version} trust=${source.trust}]\n`
  const body = `${header}${effectiveContent ?? ''}\n`
  return { text: body, start: offset, end: offset + body.length }
}

/**
 * 把一个来源换成"**实际发出去的那一版**"。
 *
 * ## 这是第一个版本错了的地方，而错的正是本模块存在的理由
 *
 * 第一版把 `sources[]` 直接填成原始来源对象。于是对一份 200 字、只发了 30 字的文档：
 *
 *     truncations[0].keptChars = 30      ← 副账本说截了
 *     sources[0].content.length = 200    ← 主账本说模型看到了 200 字
 *
 * `truncations[]` 是对的，而任何人去看 `sources`（最自然的那一步）都会得出
 * "模型读完了整份文档"。**一个说了实话的副账本救不了一个说假话的主账本。**
 *
 * 所以这里重建来源对象：
 *   · `content` **就是**发出去的那部分；
 *   · `contentHash` 是**这个** `content` 的哈希——同名字段必须自洽，
 *     否则读者拿它去校验 `content` 会得到一个说不清的失败；
 *   · 被截断时另加 `fullContentHash` / `fullChars` / `truncated`，
 *     让"它原本是什么"仍然可查，而不是消失。
 */
function withEffectiveContent(source, effective, truncated) {
  const contentHash = `sha256:${domainSeparatedHash(
    'legion.context-source-content.v1', 1, { type: source.type, version: source.version, content: effective },
  ).slice(7)}`
  const out = {
    ...source,
    content: effective,
    chars: effective.length,
    contentHash,
    truncated: truncated === true,
  }
  if (truncated === true) {
    // 原文的哈希与长度留着：截断之后还要能回答"它原本多长、有没有变过"。
    out.fullContentHash = source.contentHash
    out.fullChars = source.content === null ? 0 : source.content.length
  }
  return Object.freeze(out)
}

/**
 * 装配一份上下文快照。
 *
 * @param {object} input
 * @param {string} input.attemptId
 * @param {string} input.runId
 * @param {number} input.frozenAtMs
 * @param {object} input.associations `{goalId, taskId, employeeId, teamPlanId}`
 * @param {Array<{source: object, scope?: string, required?: boolean, allowTruncate?: boolean, supersededBy?: string,
 *   missing?: boolean, missingReason?: string}>} input.candidates
 * @param {object} input.policy
 * @param {string} input.policy.scope 本次运行的空间
 * @param {(meta: object) => boolean} input.policy.canRead 只用元数据判定；**不给正文**
 * @param {number[]} [input.policy.priority] 来源类型从高到低
 * @param {number|null} [input.policy.maxTokens] `null` = 不限
 * @param {object} input.tokenizer `{kind, count(text)}`
 */
export function assembleContext(input) {
  if (input === null || typeof input !== 'object') throw new TypeError('assembleContext 需要对象参数')
  const candidates = input.candidates
  if (!Array.isArray(candidates)) {
    throw new AssemblyError(ASSEMBLY_CODES.BAD_CANDIDATE, 'candidates 必须是数组（没有来源时给空数组）')
  }
  const policy = input.policy
  if (policy === null || typeof policy !== 'object') throw new TypeError('policy 必须是对象')
  if (typeof policy.canRead !== 'function') {
    // 不给判定函数就等于"全都可读"，而那是默认放行——最不该成为默认值的默认值。
    throw new TypeError('policy.canRead 必须是函数：没有权限判定时装配只能默认放行')
  }

  const tokenizer = input.tokenizer
  if (tokenizer === null || typeof tokenizer !== 'object' || typeof tokenizer.count !== 'function') {
    // 没有 tokenizer 就无法判断放不放得下。**不猜字符数**：不同模型差好几倍。
    throw new AssemblyError(ASSEMBLY_CODES.TOKENIZER_REQUIRED,
      '缺少 tokenizer：无法得知内容放不放得下，而一个猜出来的预算会让运行在真正发送时才失败')
  }
  const kind = tokenizer.kind
  if (kind !== TOKEN_ESTIMATOR_KINDS.EXACT && kind !== TOKEN_ESTIMATOR_KINDS.CONSERVATIVE_ESTIMATE) {
    throw new AssemblyError(ASSEMBLY_CODES.TOKENIZER_REQUIRED,
      `tokenizer.kind 必须是 '${TOKEN_ESTIMATOR_KINDS.EXACT}' 或 '${TOKEN_ESTIMATOR_KINDS.CONSERVATIVE_ESTIMATE}'`)
  }

  const maxTokens = policy.maxTokens === undefined ? null : policy.maxTokens
  if (maxTokens !== null && (!Number.isInteger(maxTokens) || maxTokens < 1)) {
    throw new AssemblyError(ASSEMBLY_CODES.BAD_BUDGET, 'policy.maxTokens 必须是 >= 1 的整数或 null（不限）')
  }
  const priorityIndex = new Map((policy.priority ?? []).map((t, i) => [t, i]))

  const included = []
  const excluded = []
  const truncations = []
  const pending = []

  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i]
    if (c === null || typeof c !== 'object' || c.source === null || typeof c.source !== 'object') {
      throw new AssemblyError(ASSEMBLY_CODES.BAD_CANDIDATE, `candidates[${i}] 必须是 { source } 形状`)
    }
    const source = c.source

    // ① 越权：**只拿元数据**判定，正文根本不被读进装配流程。
    const meta = { id: source.id, type: source.type, version: source.version, trust: source.trust, scope: c.scope ?? null }
    let readable
    try {
      readable = policy.canRead(meta) === true
    } catch (e) {
      // 判定本身抛错时**不放行**：无法判断不等于可以。
      readable = false
      excluded.push(createExclusion({
        id: source.id,
        reason: EXCLUSION_REASONS.UNAUTHORIZED,
        detail: `权限判定失败，按不可读处理：${e instanceof Error ? e.message : String(e)}`,
      }))
      continue
    }
    if (!readable) {
      excluded.push(createExclusion({
        id: source.id,
        reason: EXCLUSION_REASONS.UNAUTHORIZED,
        detail: '该员工无权读取这个来源',
      }))
      continue
    }

    // ② 过期：已有更新版本取代它。
    if (typeof c.supersededBy === 'string' && c.supersededBy !== '') {
      excluded.push(createExclusion({
        id: source.id,
        reason: EXCLUSION_REASONS.STALE,
        detail: `已被 ${c.supersededBy} 取代`,
      }))
      continue
    }

    // ③ 作用域不匹配。
    if (c.scope !== undefined && c.scope !== null && policy.scope !== undefined && c.scope !== policy.scope) {
      excluded.push(createExclusion({
        id: source.id,
        reason: EXCLUSION_REASONS.OUT_OF_SCOPE,
        detail: `来源属于空间 ${c.scope}，本次运行在 ${policy.scope}`,
      }))
      continue
    }

    // ④ **来源不存在**（`missing: true`）。
    //
    // 为什么这一条必须存在：没有它，一个"我试着去取，但那个产物不在"
    // 的调用方**唯一能做的事就是什么都不说**——不把这个候选放进 `candidates`。
    // 守恒断言仍然成立，快照也仍然"完整"，而少掉的那个来源**不留痕迹**。
    // spec §6.5 点名的三种情况里，「这个来源不存在」正是第一种，
    // 而在此之前装配器只能表达另外两种。
    //
    // 放在最后一道（权限/过期/作用域之后）是有意的：
    //   · 无权的来源先按**无权**记 —— 系统不该向读不到它的人确认它是否存在；
    //   · 已被新版本取代的先按**过期**记 —— "v1 已被 v2 取代"比"v1 没了"更有用，
    //     因为我们本来就要用 v2；
    //   · 不在本空间的根本不提。
    // 于是 `missing` 是这几条之后的兜底，含义明确：**该在的，不在了。**
    //
    // 注意 `content === null` **不是** missing：那是"只有出处、没有正文"的
    // 引用型来源，合法且常见。把它自动当成缺失会让引用型来源被误报。
    //
    // `EXCLUSION_REASONS.REDACTED` 目前**没有产出路径**：它是留给脱敏（PRT-408）的
    // 预留值——脱敏改变内容是因为**策略**，而截断是因为**预算**，两者不能合并成
    // 同一个理由。装配器的用例里有一条专门钉住"可达集合 + 预留集合 = 全部枚举值"，
    // 所以新增一个理由却忘了写产出路径时，那条用例会红。
    if (c.missing === true) {
      const why = typeof c.missingReason === 'string' && c.missingReason !== '' ? c.missingReason : null
      excluded.push(createExclusion({
        id: source.id,
        reason: EXCLUSION_REASONS.MISSING,
        detail: why === null
          ? `${source.type} ${source.id}@${source.version} 不存在或无法取得`
          : `${source.type} ${source.id}@${source.version} 无法取得：${why}`,
      }))
      continue
    }

    pending.push({ candidate: c, source })
  }

  // ④ 脱敏（PRT-408）。**必须在预算裁剪之前**——反过来的话，脱敏会作用在一段
  // 已经被裁过的文本上，于是 `preRedactionChars` 记的是截断后的长度，
  // 那个数字会被误读成"原文长度"。
  //
  // 脱敏是**内容变换**，不是排除：被脱敏的来源仍然在 `sources[]` 里，
  // 只是正文的一部分变成了标记。整条排除会丢掉"我看过这份文档"这个事实。
  //
  // spec §6.5 要的"脱敏结果"就是这里的 `redactions[]`：只记路径与命中说明，
  // **不记原值**——把原值写进快照等于把泄漏从正文搬家到审计。
  const redactions = []
  for (const p of pending) {
    const r = redactSource(p.source)
    if (r.redactions.length > 0) {
      p.source = r.source
      redactions.push(...r.redactions)
    }
  }

  // ⑤ 按固定优先级排出确定顺序：同一批输入在任何路径下都得到同样的顺序与哈希。
  pending.sort((a, b) => compareForAssembly(a.source, b.source, priorityIndex))

  // ⑥ 预算裁剪。
  let usedTokens = 0
  const requiredDropped = []
  for (const { candidate, source } of pending) {
    const content = source.content === null ? '' : String(source.content)
    const fullTokens = content === '' ? 0 : tokenizer.count(content)
    const remaining = maxTokens === null ? Number.POSITIVE_INFINITY : maxTokens - usedTokens

    if (fullTokens <= remaining) {
      included.push({ source, effective: content, tokens: fullTokens, truncated: false })
      usedTokens += fullTokens
      continue
    }

    // 放不下。先看能不能按声明截断。
    if (candidate.allowTruncate === true && remaining > 0) {
      const { kept, keptTokens } = truncateToBudget(content, remaining, tokenizer.count)
      if (keptTokens > 0) {
        included.push({ source, effective: kept, tokens: keptTokens, truncated: true })
        truncations.push(Object.freeze({
          id: source.id,
          type: source.type,
          version: source.version,
          originalChars: content.length,
          keptChars: kept.length,
          originalTokens: fullTokens,
          keptTokens,
          // 明确说出"模型没看到后面的部分"——这一条就是这一整个账本存在的理由。
          detail: `正文被截断：${content.length} 字中的前 ${kept.length} 字进入本次运行（其余未发送）`,
        }))
        usedTokens += keptTokens
        continue
      }
    }

    if (candidate.required === true) {
      requiredDropped.push({ id: source.id, type: source.type, needed: fullTokens, remaining: maxTokens === null ? null : maxTokens - usedTokens })
      continue
    }

    excluded.push(createExclusion({
      id: source.id,
      reason: EXCLUSION_REASONS.OVER_BUDGET,
      detail: `需要 ${fullTokens} token，剩余 ${maxTokens === null ? '不限' : maxTokens - usedTokens}`,
    }))
  }

  // ⑦ 必需来源放不下 → 失败。一份"看起来正常但缺了前提"的快照比失败坏得多。
  if (requiredDropped.length > 0) {
    throw new AssemblyError(
      ASSEMBLY_CODES.CONTEXT_TOO_LARGE,
      `裁剪后仍无法容纳必需的来源：${requiredDropped.map((r) => `${r.type}:${r.id}（需要 ${r.needed} token）`).join('、')}。` +
      '这些来源是运行的前提，缺了它们应当失败而不是带着错误的上下文继续。',
      { requiredDropped, usedTokens, maxTokens },
    )
  }

  // ⑦ 渲染最终文本，并记录每段对应哪个来源。
  let offset = 0
  const segments = []
  let text = ''
  for (const item of included) {
    const seg = renderSegment(item.source, item.effective, offset)
    segments.push(Object.freeze({
      id: item.source.id,
      type: item.source.type,
      version: item.source.version,
      trust: item.source.trust,
      charStart: seg.start,
      charEnd: seg.end,
      tokens: item.tokens,
      truncated: item.truncated,
    }))
    text += seg.text
    offset = seg.end
  }

  const budgetTrimmed = truncations.length > 0 || excluded.some((e) => e.reason === EXCLUSION_REASONS.OVER_BUDGET)

  const snapshot = freezeContextSnapshot({
    attemptId: input.attemptId,
    runId: input.runId,
    frozenAtMs: input.frozenAtMs,
    associations: input.associations ?? {},
    candidateCount: candidates.length,
    // **发出去的那一版**，不是原始来源（见 withEffectiveContent 的说明）。
    sources: included.map((i) => withEffectiveContent(i.source, i.effective, i.truncated)),
    excluded,
    tokens: createTokenMeasurement({
      kind,
      tokens: usedTokens,
      note: kind === TOKEN_ESTIMATOR_KINDS.CONSERVATIVE_ESTIMATE
        ? (tokenizer.note ?? '保守估算（只会高估）')
        : (tokenizer.note ?? null),
    }),
    budget: { maxTokens, trimmed: budgetTrimmed },
    finalText: text,
    // 段与两个账本一起进快照、一起进哈希。
    // **不是**第二个真源：`sources`/`excluded` 仍是账本，段只是把 finalText 切回去，
    // 用于回答"模型看到的第 N 个字符来自哪里"。
    segments,
    truncations,
    // PRT-408：脱敏结果进哈希。**形态本身也进**——脱敏规则变了，
    // 同一份输入就该是两个不同的快照，否则"回放"会给出与当初不同的结果
    // 而哈希说它们是同一份。
    redactions,
    redactionSchema: REDACTION_SCHEMA,
  })

  return snapshot
}

/** 装配结果的摘要（给界面/审计用，只读）。 */
export function describeAssembly(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') throw new TypeError('describeAssembly 需要快照')
  const parts = [`包含 ${snapshot.sources.length} 个来源（约 ${snapshot.tokens.tokens} token`]
  parts.push(snapshot.tokens.kind === TOKEN_ESTIMATOR_KINDS.CONSERVATIVE_ESTIMATE ? '，保守估算）' : '）')
  if (snapshot.truncations.length > 0) parts.push(`，其中 ${snapshot.truncations.length} 个被截断`)
  // 脱敏**不是**排除：被脱敏的来源仍在 `sources[]` 里，所以这里先于排除说它。
  // 说成"排除"会让用户以为那份文档没进去——而它进去了，只是正文变了。
  const redactedIds = new Set((snapshot.redactions ?? []).map((r) => r.sourceId))
  if (redactedIds.size > 0) {
    const whys = [...new Set((snapshot.redactions ?? []).map((r) => r.why))]
    parts.push(`，其中 ${redactedIds.size} 个已脱敏（${whys.join(' / ')}）`)
  }
  if (snapshot.excluded.length > 0) {
    const byReason = new Map()
    for (const e of snapshot.excluded) byReason.set(e.reason, (byReason.get(e.reason) ?? 0) + 1)
    const label = { unauthorized: '越权', stale: '过期', 'over-budget': '超预算', redacted: '已脱敏', missing: '找不到', 'out-of-scope': '不在本空间' }
    parts.push(`；排除 ${snapshot.excluded.length} 个（${[...byReason].map(([r, n]) => `${label[r] ?? r} ${n}`).join('、')}）`)
  }
  return `${parts.join('')}。`
}
