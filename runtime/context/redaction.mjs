// runtime/context/redaction.mjs
// ============================================================================
// 上下文脱敏（PRT-408，spec §6.5）
//
// ## 与日志脱敏（PRT-208）的区别不是程度，是**不可撤回性**
//
//   日志脱敏   —— 别把密钥写进日志。写错了至少还在本机，能删。
//   上下文脱敏 —— 别把密钥**发给模型**。发出去就撤不回来了：
//                 它进了对方的日志、对方的训练管道、对方的缓存。
//
// 所以这里的默认比日志那一侧**更严**，而且严的方向是明确的：
// **可疑即脱敏**。漏脱一个真实密钥的代价（不可撤回的外泄）远大于
// 多脱一个普通字符串的代价（模型少看到一段文本，而脱敏记录会说明发生了什么）。
//
// ## 三条判断
//
// ① **脱敏是内容变换，不是排除。** spec §6.5 要求记录「权限过滤和脱敏结果」。
//    一个被脱敏的来源**仍然在 `sources[]` 里**——它还是这次运行的输入，
//    只是正文的一部分变成了标记。把它整条排除会丢掉"我看过这份文档"这个事实。
//
// ② **脱敏改变哈希，且这件事必须可见。** `contentHash` 是**脱敏后**内容的哈希
//    （同名字段必须自洽，否则读者拿它去校验 `content` 会得到一个说不清的失败），
//    而原文的哈希与长度另外留着（`preRedactionContentHash` / `preRedactionChars`）。
//    "它原本是什么"因此仍然可查，而不是消失。
//
// ③ **脱敏先于截断，且账本按"发生过"记，不按"发出去了"记。**
//
//    顺序不能反：先截断再脱敏的话，一次裁剪可能正好切在一个密钥中间，
//    剩下的片段不再匹配任何模式，于是**一段残缺的密钥被发了出去**。
//    所以脱敏作用在完整正文上，然后才裁剪。
//
//    这带来一个必须说清的后果：被裁掉的那部分里的密钥**也会进脱敏账本**。
//    这不是多报——"这份来源含有一个密钥，我们把它脱敏了"是**真话**；
//    "那一部分有没有被发出去"由 `truncations[]` 单独回答。
//
//    两个方向的风险不对称：多记一条脱敏（安全侧）与漏记一条**真的发出去**的脱敏
//    （灾难侧）不能同日而语。而当前顺序**不可能**漏记——脱敏覆盖了整份正文，
//    任何后来进入 `finalText` 的字符都已经过脱敏。
//
// ④ **被权限排除的来源根本不进脱敏账本**，因为它的正文从来没被读进来
//    （排除发生在 `pending` 之前）。这是真的"不发出去"，与上一条不同。
//
// ## 脱敏账本只记**路径与说明**，不记原值
//
// 把原值写进快照的审计等于把泄漏从正文搬家到审计，问题一点没少。
// 所以 `redactions[]` 里是 `{sourceId, at, why}`：`at` 是稳定路径（如 `content`），
// `why` 是命中的模式说明（如 `OpenAI 风格密钥`）。
// ============================================================================

import { REDACTED, redactText } from '../contracts/redact-patterns.mjs'

/** 脱敏在快照上的形态版本。进哈希——形态变了，快照就该是两个。 */
export const REDACTION_SCHEMA = 'legion.context-redaction.v1'

/**
 * 对一段文本脱敏，返回**只有**脱敏后的文本与命中说明。
 *
 * 不返回被替换掉的内容：调用方拿不到原值，就写不进审计、日志、快照。
 * 这不是"不方便"，这是这个函数存在的理由。
 *
 * @param {unknown} text
 * @returns {{text: string, hits: string[], changed: boolean}}
 */
export function redactForModel(text) {
  if (text === null || text === undefined) return { text: '', hits: [], changed: false }
  const r = redactText(text)
  return { text: r.text, hits: r.hits, changed: r.text !== String(text) || r.hits.length > 0 }
}

/**
 * 脱敏一个来源的正文，返回重建后的来源与脱敏记录。
 *
 * **注意顺序**：本函数应在**截断之前**应用到候选上。
 * 反过来的话，脱敏会作用在一段已经被裁过的文本上，于是
 * `preRedactionChars` 记的是截断后的长度——那个数字就会被误读成"原文长度"。
 * 装配器里的调用点按这个顺序安排。
 *
 * @param {object} source 由 `createContextSource` 构造的来源
 * @returns {{source: object, redactions: Array<{sourceId: string, at: string, why: string}>}}
 */
export function redactSource(source) {
  if (source === null || typeof source !== 'object') {
    throw new TypeError('redactSource 需要来源对象')
  }
  // `content === null` 是"只有出处、没有正文"的引用型来源：没有正文可脱敏，
  // 也**不要**因此把它标成已脱敏——那会让"这份文档被脱敏过"变成假话。
  if (source.content === null || source.content === undefined) {
    return { source, redactions: [] }
  }
  const { text, hits } = redactForModel(source.content)
  if (hits.length === 0) return { source, redactions: [] }

  // 命中说明去重但保持**首次出现顺序**：审计里"先命中哪个"是有信息量的，
  // 而一个 Set 的顺序恰好是插入顺序，所以不需要额外排序。
  const uniq = [...new Set(hits)]
  return {
    source: {
      ...source,
      content: text,
      chars: text.length,
      // 脱敏是**内容的第三次形态**（原文 → 脱敏后 → 截断后）。
      // 到装配器手里 `contentHash` 会被再算一次（对截断后的内容），
      // 所以这里同时留下"脱敏后"这一版的哈希，让每一跳都可核对。
      preRedactionContentHash: source.contentHash,
      preRedactionChars: source.content.length,
      redacted: true,
      redactionSchema: REDACTION_SCHEMA,
    },
    redactions: uniq.map((why) => ({ sourceId: source.id, at: 'content', why })),
  }
}

/**
 * 对整批候选脱敏。
 *
 * 这是装配流程里的**一道独立工序**，而不是混在预算裁剪里：
 * 两者的失败模式不同（脱敏漏了会外泄，裁剪漏了会超限），
 * 混在一处会让一个的红掩盖另一个的红。
 *
 * @param {Array<{source: object}>} candidates
 * @returns {{candidates: Array<object>, redactions: Array<object>, redactedSourceIds: string[],
 *   estimatedPreRedactionTokens: number|null}}
 */
export function redactCandidates(candidates) {
  if (!Array.isArray(candidates)) throw new TypeError('redactCandidates 需要候选数组')
  const out = []
  const redactions = []
  const redactedSourceIds = []
  for (const c of candidates) {
    if (c === null || typeof c !== 'object' || c.source === null || typeof c.source !== 'object') {
      throw new TypeError('redactCandidates 的每个元素必须是 { source } 形状')
    }
    const r = redactSource(c.source)
    out.push({ ...c, source: r.source })
    if (r.redactions.length > 0) {
      redactedSourceIds.push(c.source.id)
      redactions.push(...r.redactions)
    }
  }
  return { candidates: out, redactions, redactedSourceIds }
}

/**
 * 脱敏结果的**人读摘要**（给 `describeAssembly` 与界面用）。
 *
 * 不泄露任何原文：只说到"几个来源、哪几种形态"。
 */
export function describeRedaction(redactions) {
  if (!Array.isArray(redactions) || redactions.length === 0) return null
  const ids = [...new Set(redactions.map((r) => r.sourceId))]
  const whys = [...new Set(redactions.map((r) => r.why))]
  return `已脱敏 ${ids.length} 个来源（命中 ${whys.join(' / ')}）`
}

/** 脱敏标记本身（重新导出，免得消费方去 import 两个模块）。 */
export { REDACTED }
