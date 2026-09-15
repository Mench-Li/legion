// runtime/adapters/dsh/pin-drift.mjs
// ============================================================================
// PRT-211（缺口收口）：**DSH 出处锚点的漂移核对**。
//
// ## 补的是哪一截
//
// `session-boundary.mjs` 把六条"改变了适配器该怎么写"的结论固化成了代码，
// 每条都带出处（`source` + `lines`）。但 DSH **不是冻结依赖**——
// 那两项是给人看的字符串，**没有任何东西在核对**。升级一次 DSH：
// 行号会漂、措辞可能改，而结论会**继续以原来的语气留在代码里**。
//
//   > 一条"写着出处、但没人再核对过"的结论，
//   > 与一条"当初就是编的"结论，在下一个读者眼里是同一个东西——
//   > 只不过前者在库里看起来更像有依据。
//
// 本模块让"出处"变成一件**可核对的事**：每条结论声明 `anchors`
// （必须在被引文件里出现的原文），这里逐条去核。
//
// ## 两个判据上的决定，都是量出来的
//
// ### ① 锚点取**原文**，不取行号
//
// 本批第一版核对器按"**单行**里包含锚点"匹配，六条里有两条报"找不到"——
// 而那两句只是**被折行**了：`agent/src/index.ts` 的注释在 573/574 两行，
// `continuation.ts` 的在 194/195 两行。也就是说：
//
//   > 一条因为探针自己写坏而报出来的"漂移"，
//   > 与一条真的漂移，在只看"✖ 找不到"这一行时是同一个东西——
//   > 只不过前者会让人去改一句本来正确的话。
//
// 所以匹配前**把空白折叠掉**（`\s+` → 单空格），行号只作为**报告**里给人
// 二次核实的提示，不参与判定。用行号判定的话，DSH 每次顺手重排注释都会让它变红，
// 而一个总是叫狼来了的门禁会被关掉——那与没有门禁是同一个结果。
//
// ### ② "没观察"与"没漂移"必须是两个读数
//
// DSH 检出不在时，本模块**不说"通过"**：它返回 `observed: false`。
// 本仓库为这件事付过学费（PRT-214 的 `BOOTSTRAP_COMPOSITION_UNOBSERVED`）：
// "没人给观察结果"静默变成"观察结果是空"，会**报出一个错的诊断**，
// 顺着它排查会去重装补丁层，而真因是接线缺一截。
//
//   > "没接"和"没做"是两个不同的问题，修法也不同。
//
// ## 它**不**做什么
//
// 它不判断那些结论**对不对**——它判断的是"**当初引用的那句话还在不在**"。
// 锚点还在、而结论已经错了，是另一类问题（需要人读实现），本模块不假装能发现。
// 这个分级与 `EVIDENCE_LEVEL` 同一个立场：说清楚证明了什么，不借名字。
// ============================================================================
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { IMPLEMENTATION_FINDINGS } from './session-boundary.mjs'

/** 锚点核对的状态码。闭集：调用方按码分支，不按文案。 */
export const PIN_STATUS = Object.freeze({
  /** 每一条声明的锚点都在被引文件里找到了。 */
  OK: 'pin-ok',
  /** 有锚点找不到：被引文件变了（措辞改了、函数删了、文件搬了）。 */
  DRIFT: 'pin-drift',
  /** 被引的文件在检出里不存在（改路径 / 不在这个包集合里）。 */
  FILE_MISSING: 'pin-file-missing',
  /** 这条结论**一个锚点都没声明**——"声明了要核对"与"没有这条声明"是同一个东西。 */
  NO_ANCHOR: 'pin-no-anchor',
  /** 锚点短到没有判别力（见 `MIN_ANCHOR_CHARS`）。 */
  ANCHOR_TOO_SHORT: 'pin-anchor-too-short',
})

/**
 * 锚点长度的下限。
 *
 * 太短的锚点（`}`、`id`）在任何文件里都能找到，于是它**永远通过**——
 * 而一个永远通过的核对，与没有核对，在读数上是同一个东西。
 * 下限取 8：够短到能放一个标识符（`overrideOf`），够长到排除掉结构符号。
 */
export const MIN_ANCHOR_CHARS = 8

/** 一条结论的锚点必须**逐字**出现在被引文件里；匹配前把空白折叠掉（见文件头 ①）。 */
export function normalizePinText(text) {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 把源码折成"一句话"，同时保留每个字符回到**原文件**的位置。
 *
 * 这是本模块的核心，也是第一版栽跟头的地方。DSH 的注释是折行的：
 *
 *     * scoped context. Runtime ownership is independent of durable session
 *     * lineage and remains unambiguous when unrelated providers reuse an id.
 *
 * 两句之间隔着 `\n   * `——里面有一个 **`*`**。所以哪怕把锚点里的空格换成
 * `\s+`，也匹配不上：`*` 不是空白。第一版就是这么写的，于是六条里两条误报"漂移"。
 *
 * ⇒ 正确做法是**把源码本身也折起来**：去掉每行的注释引导符（`//` / `*`），
 * 再把空白压成单空格。于是"折行的注释"与"没折行的同一句话"折出来**是同一个字符串**。
 *
 * 返回 `map`：折叠后第 n 个字符对应原文件的第几个字符——
 * 于是行号仍然报得出来（行号只用于**给人二次核实**，不参与判定）。
 */
export function foldSource(text) {
  const chars = []
  const map = []
  let i = 0
  while (i <= text.length) {
    let j = i
    while (j < text.length && text[j] !== '\n') j++
    const line = text.slice(i, j)
    // 注释引导符（`//` 或行首的 `*`）。`/**` 不匹配 `*` 分支（它以 `/` 开头），保持原样。
    const lead = /^\s*(?:\/\/|\*)\s?/.exec(line)
    const from = i + (lead === null ? 0 : lead[0].length)
    for (let k = from; k < j; k++) { chars.push(text[k]); map.push(k) }
    if (j >= text.length) break
    chars.push(' ')
    map.push(j)
    i = j + 1
  }

  let folded = ''
  const fmap = []
  let prevSpace = true // 起始为 true：折叠后的前导空白被丢掉
  for (let n = 0; n < chars.length; n++) {
    if (/\s/.test(chars[n])) {
      if (prevSpace) continue
      folded += ' '
      fmap.push(map[n])
      prevSpace = true
    } else {
      folded += chars[n]
      fmap.push(map[n])
      prevSpace = false
    }
  }
  return { text: folded, map: fmap }
}

/**
 * 锚点在**折叠后**的文本里对应的正则。
 *
 * 折叠后的文本里空白已经压成单空格，所以这里把锚点也归一化后**逐字**匹配即可。
 */
export function anchorPattern(anchor) {
  const escaped = normalizePinText(anchor).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(escaped)
}

/**
 * 锚点是**逐字原文**吗（而不是一段描述）？
 *
 * 这条判据本身不完美（没法自动看出"这段文本是不是原文"），但它能挡住
 * 最坏的一种：把一句**人写的说明**当锚点——那种锚点永远找不到，
 * 于是门禁一上来就红，然后被人把门禁删掉。
 */
export function anchorShapeProblem(anchor) {
  if (typeof anchor !== 'string' || anchor.trim() === '') return '不是非空字符串'
  if (anchor.length < MIN_ANCHOR_CHARS) return `只有 ${anchor.length} 个字符（下限 ${MIN_ANCHOR_CHARS}）`
  if (/[「」“”]/.test(anchor)) return '含中文引号，像是人写的说明而不是原文'
  return null
}

/**
 * **机制自检**：每条结论都得有可核对的锚点。
 *
 * 这一条不是关于 DSH 的，是关于**本模块自己的**：没有它，
 * 以后新增一条结论而忘了写 `anchors` 时，核对会**静默跳过**它——
 * 而"跳过了"与"核对通过"在报告里长得一样。
 *
 *   > 一个"记下来但从不检查"的要求，与一个"没有这个要求"，
 *   > 在库里的表现是同一个东西——只不过前者在事件流里看起来像一句保证。
 */
export function auditFindingAnchors(findings = IMPLEMENTATION_FINDINGS) {
  const problems = []
  for (const f of findings) {
    const anchors = f?.anchors
    if (!Array.isArray(anchors) || anchors.length === 0) {
      problems.push(Object.freeze({
        code: f?.code ?? '(无码)',
        status: PIN_STATUS.NO_ANCHOR,
        detail: '这条结论没有声明任何锚点，于是漂移核对**跳过了它**',
      }))
      continue
    }
    for (const a of anchors) {
      const why = anchorShapeProblem(a)
      if (why !== null) {
        problems.push(Object.freeze({
          code: f.code,
          status: PIN_STATUS.ANCHOR_TOO_SHORT,
          detail: `锚点 ${JSON.stringify(a)} 不合格：${why}`,
        }))
      }
    }
  }
  return Object.freeze(problems)
}

/**
 * 逐个锚点去核。
 *
 * @param {object} o
 * @param {string|null} o.checkoutRoot  DSH 检出根；`null` ⇒ **不观察**（不是通过）
 * @param {ReadonlyArray<object>} [o.findings]
 * @param {(p: string) => string} [o.readFile]  注入以便用例构造"文件变了"
 */
export function checkDshPins({ checkoutRoot = null, findings = IMPLEMENTATION_FINDINGS, readFile = null } = {}) {
  const observed = typeof checkoutRoot === 'string' && checkoutRoot !== '' && existsSync(checkoutRoot) &&
    statSync(checkoutRoot).isDirectory()

  // ★ 没观察到就**不报通过**：`observed: false` 是一个分得开的读数。
  if (!observed) {
    return Object.freeze({
      observed: false,
      ok: false,
      rows: Object.freeze([]),
      drift: Object.freeze([]),
      problems: auditFindingAnchors(findings),
      driftCount: 0,
      checkedAnchors: 0,
    })
  }

  const read = readFile === null
    ? (p) => readFileSync(p, 'utf8')
    : readFile

  const rows = []
  let driftCount = 0
  let checkedAnchors = 0

  for (const f of findings) {
    const anchors = Array.isArray(f.anchors) ? f.anchors : []
    const abs = isAbsolute(f.source) ? f.source : join(checkoutRoot, f.source)

    let text = null
    try {
      text = read(abs)
    } catch {
      text = null
    }

    if (text === null) {
      rows.push(Object.freeze({
        code: f.code,
        source: f.source,
        status: PIN_STATUS.FILE_MISSING,
        anchors: Object.freeze([]),
      }))
      driftCount++
      continue
    }

    if (anchors.length === 0) {
      rows.push(Object.freeze({ code: f.code, source: f.source, status: PIN_STATUS.NO_ANCHOR, anchors: Object.freeze([]) }))
      driftCount++
      continue
    }

    const folded = foldSource(text)
    const results = anchors.map((a) => {
      checkedAnchors++
      let line = null
      try {
        const m = anchorPattern(a).exec(folded.text)
        // 行号用 `map` 回到原文件：折叠后的下标 → 原文件偏移 → 行号。
        if (m !== null) {
          const orig = folded.map[m.index]
          line = text.slice(0, orig).split(/\r?\n/).length
        }
      } catch {
        line = null
      }
      return Object.freeze({ anchor: a, found: line !== null, line })
    })

    const missing = results.filter((r) => !r.found)
    if (missing.length > 0) driftCount++

    rows.push(Object.freeze({
      code: f.code,
      source: f.source,
      status: missing.length === 0 ? PIN_STATUS.OK : PIN_STATUS.DRIFT,
      anchors: Object.freeze(results),
      missing: Object.freeze(missing.map((r) => r.anchor)),
    }))
  }

  const problems = auditFindingAnchors(findings)
  const drift = rows.filter((r) => r.status !== PIN_STATUS.OK)
  return Object.freeze({
    observed: true,
    ok: drift.length === 0 && problems.length === 0,
    rows: Object.freeze(rows),
    drift: Object.freeze(drift),
    problems,
    driftCount: drift.length,
    checkedAnchors,
  })
}

/** 被引用的 DSH 文件（去重，按出现次序）。给人看"这一批在核哪几个文件"。 */
export function pinnedSources(findings = IMPLEMENTATION_FINDINGS) {
  return Object.freeze([...new Set(findings.map((f) => f.source))])
}
