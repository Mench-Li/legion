// runtime/context/tokenizer.mjs
// ============================================================================
// token 计量：精确 tokenizer 的注册点 + **保守估算器**（PRT-413，spec §6.5）
//
// spec §6.5：「token 预算由选定 ModelProfile 的 tokenizer/限制决定；
// 无法获得精确 tokenizer 时使用**明确标记的**保守估算器。」
//
// ## 为什么"估算"的方向必须是**高估**
//
// 两个方向的错法代价完全不对称：
//
//   · **低估**（说 8000，实际 12000）→ 我们以为放得下，把超限的内容发出去。
//     请求在**供应商那一侧**失败，或者被截断，而**钱已经花了**。
//     更坏的是：装配器以为自己守住了预算，于是预算这道防线是假的。
//   · **高估**（说 12000，实际 8000）→ 我们提前裁掉一点内容。
//     模型少看到一些上下文。**没有金钱代价，也不会失败。**
//
// 所以估算器**必须**是一个保证的上界。这不是"尽量准一点"的工程偏好，
// 而是这条防线唯一能成立的形态：一个可能低估的估算器提供的是**虚假的**预算保证。
//
// ## 保证上界的推导
//
// 任何 BPE / WordPiece / sentencepiece 类 tokenizer 都有一个共同性质：
// token 是输入的**切分**——把 token 按顺序拼起来就是原文，且每个 token 非空。
// 于是：
//
//     词元数 ≤ 码点数 ≤ UTF-8 字节数
//
// 取**码点数**作为上界：它保证不低估，同时比字节数紧（中文只差 3 倍而不是 4 倍）。
// 代价是对英文会高估约 3~4 倍（真实 BPE 约 4 字符/token）。
// **这是有意的选择**：宁可早裁，不可低估。
//
// 注册了真的 tokenizer 之后，`exact` 才是可以声明的——本文件拒绝
// "自称精确"却拿不出依据的情况（见 `defineExactTokenizer`）。
// ============================================================================

import { TOKEN_ESTIMATOR_KINDS } from '../contracts/context.mjs'

/** 估算器标识。 */
export const TOKENIZER_KINDS = Object.freeze({
  EXACT: 'exact',
  CONSERVATIVE: 'conservative',
})

/** 码点计数（不是 UTF-16 长度：emoji 等代理对算 1，而不是 2）。 */
export function codePointCount(text) {
  if (typeof text !== 'string') throw new TypeError('codePointCount 需要字符串')
  let n = 0
  // 用 `for...of`（它按**码点**迭代）而不是 `.length`（那是 UTF-16 码元数）：
  // 一个 emoji 的 `.length` 是 2，按它计数会让上界虚高一倍。
  for (const ch of text) {
    void ch
    n += 1
  }
  return n
}

/** UTF-8 字节数（零依赖实现，不引 Buffer 以便在浏览器侧同样可用）。 */
export function utf8ByteLength(text) {
  if (typeof text !== 'string') throw new TypeError('utf8ByteLength 需要字符串')
  let bytes = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (cp <= 0x7f) bytes += 1
    else if (cp <= 0x7ff) bytes += 2
    else if (cp <= 0xffff) bytes += 3
    else bytes += 4
  }
  return bytes
}

/**
 * 保守估算器。
 *
 * 返回的计量对象带 `kind: 'conservative-estimate'` 与一句 `note`——
 * 那个 `note` 不是装饰：`createTokenMeasurement` 会要求它存在且注明是估算，
 * 否则一个估算值在界面上与精确值**长得一模一样**。
 *
 * @param {object} [opts]
 * @param {string} [opts.note] 覆盖默认说明
 * @param {'code-points'|'utf8-bytes'} [opts.bound] 上界取哪个（默认码点，更紧）
 */
export function createConservativeTokenizer({ note, bound = 'code-points' } = {}) {
  if (bound !== 'code-points' && bound !== 'utf8-bytes') {
    throw new Error(`未知的上界基准：${bound}（只能是 'code-points' 或 'utf8-bytes'）`)
  }
  const count = bound === 'code-points' ? codePointCount : utf8ByteLength
  const basis = bound === 'code-points' ? '码点数' : 'UTF-8 字节数'
  return Object.freeze({
    kind: TOKEN_ESTIMATOR_KINDS.CONSERVATIVE_ESTIMATE,
    bound,
    count,
    // 说明里必须出现"估算"（`createTokenMeasurement` 的判据），
    // 而且要说出**上界的依据**——只说"估算"没法复核。
    note: note ?? `按${basis}保守估算（任何 BPE 类 tokenizer 的上界，只会高估、不会低估）`,
  })
}

/**
 * 注册一个**精确** tokenizer。
 *
 * 要求调用方给出 `evidence`：说明它凭什么算精确（例如"绑定了某模型的
 * 词表文件，逐字符复现其分词"）。没有依据就声明 `exact`，
 * 会让一份**估算出来的**预算看起来有权威——而预算是否可靠正是
 * `tokens.kind` 这个字段存在的唯一理由。
 *
 * @param {object} input
 * @param {(text: string) => number} input.count
 * @param {string} input.evidence 为什么它是精确的
 * @param {string} [input.note]
 */
export function defineExactTokenizer({ count, evidence, note } = {}) {
  if (typeof count !== 'function') throw new TypeError('defineExactTokenizer 需要 count 函数')
  if (typeof evidence !== 'string' || evidence.trim() === '') {
    throw new Error(
      '声明精确 tokenizer 必须给出 evidence（依据）：没有依据的"精确"会让一份估算出来的预算' +
      '看起来有权威，而 tokens.kind 存在的唯一理由就是区分这两者。',
    )
  }
  return Object.freeze({
    kind: TOKEN_ESTIMATOR_KINDS.EXACT,
    evidence: evidence.trim(),
    count,
    note: note ?? null,
  })
}

/**
 * 为一个 ModelProfile 选 tokenizer。
 *
 * **不猜**：拿不到该模型的精确 tokenizer 时返回保守估算器，并把 `kind` 标成估算。
 * 一个"看起来精确"的默认值会让 `tokens.kind` 失去意义。
 *
 * @param {object} profile 至少要有 `model`（用于从注册表里找）
 * @param {Map<string, object>} [registry] `model → 精确 tokenizer`
 */
export function tokenizerForProfile(profile, registry = null) {
  if (profile === null || typeof profile !== 'object') throw new TypeError('tokenizerForProfile 需要 ModelProfile')
  const model = profile.model
  if (registry !== null && registry !== undefined && typeof registry.get === 'function') {
    const found = registry.get(model)
    if (found !== undefined) return found
  }
  return createConservativeTokenizer()
}

/**
 * 断言一个估算值确实是上界（自检用）。
 *
 * 用途：把"保守"这个词变成可测量的东西。测试与诊断可以拿一批真实文本比对，
 * 一旦某个估算器给出的值小于某个已知 tokenizer 的结果，这里就红。
 */
export function isUpperBoundOf(estimate, referenceCount) {
  if (!Number.isFinite(estimate) || !Number.isFinite(referenceCount)) {
    throw new TypeError('isUpperBoundOf 需要两个有限数值')
  }
  return estimate >= referenceCount
}
