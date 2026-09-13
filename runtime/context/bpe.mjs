// runtime/context/bpe.mjs
// ============================================================================
// PRT-413：字节级 BPE 编码器（零依赖）
//
// 为什么这里有一份自己写的 BPE：`TOKENIZER_REGISTRY` 一直**默认为空**，
// 而"默认为空"在那条注释里被解释成"零依赖拿不到供应商词表，空表不是缺陷而是如实"。
// 那句话前半段是对的（我们确实拿不到词表），后半段只对了一半——
// **空表加上一个只等着被 `set` 的接入点，等于把"精确"这件事永远挂在别人身上。**
//
//   > 一个"留了接入点、但没有任何东西能走进去"的注册表，
//   > 与一个"根本没有注册表"的实现，在没人提供词表的时候是同一个东西——
//   > 只不过前者会让"精确 tokenizer 这条路径"看起来是**通的**。
//
// 所以本模块把"走进去"那一段补上：**词表仍然必须由使用者提供**（我们不装供应商数据，
// 那是零依赖与许可两件事共同决定的），但只要给了一份词表，这个编码器就能真的用它算出
// 与那个模型一致的 token 数——不是一个"以后再接"的占位。
//
// 算法本身不需要任何第三方数据：字节↔可打印字符的映射（`bytesToUnicode`）是**算法**
// 而不是**数据**，merge 规则与词表才是数据。所以本文件里没有一个硬编码的模型常量。
// ============================================================================

import { defineExactTokenizer } from './tokenizer.mjs'

/** 分词产物里"有东西没被词表覆盖"的记号——见 `encode` 的 `misses`。 */
export const BPE_ARTIFACT_FIELDS = Object.freeze(['name', 'model', 'pattern', 'vocab', 'merges', 'evidence'])

/**
 * GPT-2/CL100K 系列的字节↔字符映射。
 *
 * 它把 256 个字节值映射到可打印的 Unicode 码点：可打印字节原样保留，
 * 其余字节按顺序挪到 256 以上。**这是纯算法**——不依赖任何词表，
 * 所以本项目零依赖也能算对，而 `decode(encode(x)) === x` 是可测的。
 */
export function bytesToUnicode() {
  const bs = []
  for (let i = 0x21; i <= 0x7e; i += 1) bs.push(i) // '!'..'~'
  for (let i = 0xa1; i <= 0xac; i += 1) bs.push(i) // '¡'..'¬'
  for (let i = 0xae; i <= 0xff; i += 1) bs.push(i) // '®'..'ÿ'
  const cs = [...bs]
  let n = 0
  for (let b = 0; b < 256; b += 1) {
    if (!bs.includes(b)) {
      bs.push(b)
      cs.push(256 + n)
      n += 1
    }
  }
  const byteToChar = new Map()
  const charToByte = new Map()
  for (let i = 0; i < bs.length; i += 1) {
    const ch = String.fromCodePoint(cs[i])
    byteToChar.set(bs[i], ch)
    charToByte.set(ch, bs[i])
  }
  return { byteToChar, charToByte }
}

const { byteToChar: BYTE_TO_CHAR, charToByte: CHAR_TO_BYTE } = bytesToUnicode()

/**
 * 把一段文本编码成**字节级字符串**：每个 UTF-8 字节换成它对应的可打印字符。
 *
 * 这样 BPE 的合并才在"字节"这一层进行（任何 Unicode 都能表达，不会出现未登录词），
 * 也才能 `decode` 回原文。
 */
export function toByteLevel(text) {
  const bytes = new TextEncoder().encode(String(text))
  let out = ''
  for (const b of bytes) out += BYTE_TO_CHAR.get(b)
  return out
}

/** `toByteLevel` 的逆。**不抛错**：遇到不认识的字符按原样跳过字节。 */
export function fromByteLevel(s) {
  const bytes = []
  for (const ch of String(s)) {
    const b = CHAR_TO_BYTE.get(ch)
    if (b !== undefined) bytes.push(b)
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/**
 * 校验一份 tokenizer 产物（JSON 解出来的对象）。
 *
 * **失败一律抛错，不降级**：一份坏掉的词表被静默当成"能用的词表"，
 * 会让预算基于错的 token 数——而 token 数错了的表现是"运行到一半超限"，
 * 那时已经花掉钱了。宁可在加载期就拒绝。
 */
export function parseTokenizerArtifact(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('tokenizer 产物必须是一个对象')
  }
  const name = requireNonEmptyString(raw.name, 'name')
  const model = requireNonEmptyString(raw.model, 'model')
  const evidence = requireNonEmptyString(raw.evidence, 'evidence')
  if (raw.vocab === null || typeof raw.vocab !== 'object' || Array.isArray(raw.vocab)) {
    throw new TypeError('tokenizer 产物必须有 vocab（token → id 的对象）')
  }
  if (!Array.isArray(raw.merges)) throw new TypeError('tokenizer 产物必须有 merges（数组）')

  const vocab = new Map()
  for (const [token, id] of Object.entries(raw.vocab)) {
    if (!Number.isInteger(id) || id < 0) throw new Error(`vocab 里 ${JSON.stringify(token)} 的 id 必须是非负整数`)
    vocab.set(token, id)
  }
  if (vocab.size === 0) throw new Error('vocab 是空的：一份空词表会让每个字符都变成"没覆盖"')

  // merge 的**次序就是优先级**（越靠前越先合并）。用秩而不是"反复扫全表"，
  // 否则同一段文本在不同实现里会因为扫描次序不同而得到不同的切分。
  const ranks = new Map()
  raw.merges.forEach((m, i) => {
    const pair = typeof m === 'string' ? m : (Array.isArray(m) ? m.join(' ') : null)
    if (pair === null || !pair.includes(' ')) {
      throw new Error(`merges[${i}] 必须形如 "a b"（两个 token 之间一个空格）`)
    }
    ranks.set(pair, i)
  })

  let pattern = null
  if (raw.pattern !== undefined && raw.pattern !== null && raw.pattern !== '') {
    if (typeof raw.pattern !== 'string') throw new TypeError('pattern 必须是正则字符串')
    // 早失败：坏的正则会让每一次 `count` 都抛错，而那时错误发生在运行中间。
    // eslint-disable-next-line no-new
    new RegExp(raw.pattern, 'gu')
    pattern = raw.pattern
  }

  return Object.freeze({ name, model, evidence, vocab, merges: raw.merges, ranks, pattern })
}

/**
 * 用一份产物造一个**真的**编码器。
 *
 * `encode(text)` 返回 `{ ids, tokens, misses }`；
 * `count(text)` 返回 token 数——**并且在没有覆盖满时给出的是上界**（见下）。
 *
 * ★ "没覆盖"的方向性：某个合并出来的 token 不在词表里时，真正的 tokenizer
 *   会把它继续拆成更小的片段，也就是**更多** token。所以此时**按字节数计**
 *   （每个字节至少是一个 token）才是上界。
 *
 *   > 一个"词表里查不到就记 1 个 token"的计数器，
 *   > 与一个"记上界"的计数器，在词表完整的时候是同一个东西——
 *   > 只不过前者会在词表缺一段时**低估**预算，于是"放得下"是假的。
 */
export function createBpeTokenizer(artifact) {
  const { vocab, ranks, pattern } = artifact
  const re = pattern === null ? null : new RegExp(pattern, 'gu')

  /** 把一段字节级字符串切成 BPE token（**不做 pre-tokenize**）。 */
  function bpePiece(piece) {
    let parts = Array.from(piece)
    if (parts.length === 0) return []
    for (;;) {
      let best = null
      let bestRank = Number.POSITIVE_INFINITY
      for (let i = 0; i < parts.length - 1; i += 1) {
        const rank = ranks.get(`${parts[i]} ${parts[i + 1]}`)
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank
          best = i
        }
      }
      if (best === null) break
      parts = [...parts.slice(0, best), parts[best] + parts[best + 1], ...parts.slice(best + 2)]
    }
    return parts
  }

  function encode(text) {
    const s = toByteLevel(text)
    if (s === '') return { ids: [], tokens: [], misses: [] }
    const pieces = re === null ? [s] : (s.match(re) ?? [s])
    const ids = []
    const tokens = []
    const misses = []
    for (const piece of pieces) {
      for (const tok of bpePiece(piece)) {
        const id = vocab.get(tok)
        if (id === undefined) {
          // ★ 落在词表之外：**这一个至少算一个 token**（真正的 tokenizer 只会把它拆得更碎），
          //   所以绝不能"查不到就当 0 个"——那正是低估的方向。
          //
          //   `tok` 一定是**单个字符**：`bpePiece` 的结果来自 `Array.from(piece)`，
          //   而在字节级串里一个字符就是一个字节。所以"按字节数计"这件事
          //   是由**上游的切分粒度**保证的，不是靠这里再乘一次。
          //
          //   第一版这里写的是 `for (let i = 0; i < [...tok].length; i += 1) ids.push(-1)`。
          //   断验证探针⑥⑤ 把它换成一个 push，**整套用例读数不变**——那个循环
          //   永远不会转第二圈。
          //
          //     > 一个"看起来在按字节数计"的循环，
          //     > 与一个"只 push 一次"的语句，在切分粒度恒为一时是同一个东西——
          //     > 只不过前者会让人以为**这段代码**在保证上界，
          //     > 于是有人改动 `bpePiece` 的切分粒度时，不会想到上界还能不能守住。
          ids.push(-1)
          // `misses` 是**诊断**（"词表没覆盖住什么"），所以去重但保持首次出现顺序——
          // 与 `redactText` 的 `hits`、`redactSource` 的 `uniq` 同一口径。
          // 次数不在这个数组里：想知道"落空了几次"看 `ids` 里 -1 的个数。
          if (!misses.includes(tok)) misses.push(tok)
        } else {
          ids.push(id)
        }
        tokens.push(tok)
      }
    }
    return { ids, tokens, misses }
  }

  function count(text) {
    return encode(text).ids.length
  }

  return Object.freeze({
    kind: 'exact',
    evidence: artifact.evidence,
    note: `字节级 BPE：${artifact.name}（${artifact.model}）`,
    vocabSize: vocab.size,
    mergeCount: ranks.size,
    encode,
    count,
    /** 这段文本有没有落到词表之外（`count` 仍是上界，但它就在用上界）。 */
    coverage(text) {
      const { misses } = encode(text)
      return { covered: misses.length === 0, misses }
    },
  })
}

/**
 * 把一份产物直接变成 `defineExactTokenizer` 要的形状。
 *
 * ★ 这里**必须**走 `defineExactTokenizer`，而不是自己拼一个 `{kind:'exact'}`：
 *   那个函数是本仓库唯一把"声明精确必须有依据"这条规则落实到代码里的地方，
 *   绕过它等于让"精确"可以没有依据。
 *
 *   > 一个"自己拼 kind: 'exact'"的便利函数，
 *   > 与一个"走公共入口"的便利函数，在每份产物都写了 evidence 的时候
 *   > 是同一个东西——只不过前者会让那份**没写 evidence** 的产物
 *   > 悄悄变成一条"精确"记录，而 `tokens.kind` 存在的唯一理由就是区分这个。
 */
export function exactTokenizerFromArtifact(raw, { source = null } = {}) {
  const artifact = parseTokenizerArtifact(raw)
  const tok = createBpeTokenizer(artifact)
  const evidence = source === null
    ? artifact.evidence
    : `${artifact.evidence}（来自 ${source}）`
  const defined = defineExactTokenizer({
    count: tok.count,
    evidence,
    note: tok.note,
  })
  return Object.freeze({ ...defined, vocabSize: tok.vocabSize, mergeCount: tok.mergeCount, encode: tok.encode })
}

function requireNonEmptyString(v, field) {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new TypeError(`tokenizer 产物的 ${field} 必须是非空字符串`)
  }
  return v.trim()
}
