// security/secrets/dsh-credentials.mjs
// ============================================================================
// DSH `$DSH_HOME/.credentials.yaml` 的**只读子集读取器**（PRT-509 路线 A′）
//
// ## 先说清楚这份模块**不**做什么
//
//   ① **不写。** 这个文件一个字节都不会被写回；Legion 自己的 DPAPI 密钥库
//      （`security/secrets/store.mjs`）仍然是**唯一权威写入路径**。
//   ② **不迁移。** 不做一次性搬迁，也不在两个文件之间同步。
//   ③ **不猜。** 只认 DSH 自己写出的那个确切子集；子集之外的任何一个字节
//      都让**整份文件被拒绝**，而不是被跳过、被截断或被近似理解。
//
// ## 为什么"猜"在这里是不可接受的
//
// 这个文件里只有凭证：key 名是明文的，值就是密钥本身。YAML 在标量上的
// 边角极多——锚点/别名、标签、块标量、流式集合、引号转义、指令、多文档、
// 制表符缩进、重复键——**每一种猜错都不是"少读一条"，而是"读出一个不是
// 用户存进去的值"**，而它会被拿去发一次真实的请求。所以这里的判据不是
// "能不能读出来"，而是"**能不能证明读对了**"：证不出来就拒绝。
//
//   > 一个猜错的凭证解析器与一个正确的凭证解析器，在返回值上完全一样，
//   > 直到那把钥匙属于别人。
//
// DSH 自己的 `credentials-local` 把 `parseCredentialsDocument` 写成
// "everything is rejected rather than skipped"，并明确说明**连错误消息都
// 不带源码行**，因为那一行就是密钥（`describeYamlError` 只留 code 与行列号）。
// 本模块继承这条纪律，并且更严：
//
//   · 错误里**只有 code、key 名与行号**；没有值、没有路径、没有源码片段。
//   · `assertSecretRef`（Legion 自己的引用名权威）先判引用名合法性，
//     再判它能不能被 DSH 的两个键空间寻址——**不能寻址与"不存在"是两个答案**。
//
// ## 为什么自己写解析器而不是用 `yaml`
//
// Legion 有零第三方依赖纪律，而 DSH 用的是 `yaml` 包。子集读取器因此必须
// 自己写，代价是：**DSH 一旦扩写它写出的子集，这里必须跟着改**。这一条
// 写在 `docs/superpowers/prt/PRT-509-dsh-credentials-read-bridge.md` 的
// 诚实边界里，并且由 `dsh-credentials.test.mjs` 的**条件交叉核对**守着：
// 只要 `$DSH_CHECKOUT` 可达，同一批夹具会同时喂给 DSH 真的
// `parseCredentialsDocument`，两边必须对"接受"给出同一个答案。
//
// ## 分层：本模块**不是** store，也不是 resolver
//
//   backend / store（`store.mjs`）   Legion 自己的受保护库，唯一的写路径
//   本模块                           一个**只读**来源：只回答"这个引用有没有值"
//   resolver（`runtime/probe/secret-resolver.mjs`）  决定先问谁、并公开"谁回答的"
//
// 本模块只产出与 `store.get()` **同形**的记录（`{ref, value, resolvedAt}`，
// 外加一个 `source`），因此它可以直接当作 resolver 的 fallback，而不需要
// 一个平行的结果约定。
// ============================================================================

import { readFile as nodeReadFile, stat as nodeStat } from 'node:fs/promises'

import { SecretStoreError } from './errors.mjs'
import { assertSecretRef } from './ref.mjs'

/** DSH 凭证文档在 `$DSH_HOME` 下的文件名（DSH 的 `CREDENTIALS_FILENAME`）。 */
export const DSH_CREDENTIALS_FILENAME = '.credentials.yaml'

/** DSH 文档布局版本（DSH 的 `DOCUMENT_VERSION`）。只认这一个值。 */
export const DSH_DOCUMENT_VERSION = 1

/** 本来源在解析结果里的名字（`source` 字段），供诊断回答"这个值是谁给的"。 */
export const DSH_CREDENTIALS_SOURCE = 'dsh-credentials-file'

/**
 * 单份文档的字节上限。凭证文件是几十行的东西；一条 1 MiB 的线不是为了
 * "性能"，而是为了让"一个被错误指到的巨大文件"以具名码失败，而不是把
 * 整个文件读进内存后再逐行报错。
 */
export const DSH_CREDENTIALS_MAX_BYTES = 1 << 20

/**
 * 拒绝码。**每一个都是具名的、可被用例钉住的**：读取器拒绝一份文档时
 * 必须说得出"我不认识哪一类东西"，而不是笼统的"解析失败"——后者会让
 * "换一行写法就好了"与"这个文件根本不是 DSH 写的"看起来一模一样。
 */
export const DSH_CREDENTIALS_CODES = Object.freeze({
  // ── 文件层 ────────────────────────────────────────────────────────────
  UNREADABLE: 'DSH_CREDENTIALS_UNREADABLE',
  TOO_LARGE: 'DSH_CREDENTIALS_TOO_LARGE',

  // ── 词法层：本读取器不承认的 YAML 特性（一律 fail closed） ─────────────
  TAB_INDENT: 'DSH_CREDENTIALS_TAB_INDENT',
  BAD_INDENT: 'DSH_CREDENTIALS_BAD_INDENT',
  DIRECTIVE: 'DSH_CREDENTIALS_DIRECTIVE',
  DOCUMENT_MARKER: 'DSH_CREDENTIALS_DOCUMENT_MARKER',
  ANCHOR: 'DSH_CREDENTIALS_ANCHOR',
  ALIAS: 'DSH_CREDENTIALS_ALIAS',
  TAG: 'DSH_CREDENTIALS_TAG',
  BLOCK_SCALAR: 'DSH_CREDENTIALS_BLOCK_SCALAR',
  FLOW_STYLE: 'DSH_CREDENTIALS_FLOW_STYLE',
  QUOTED_SCALAR: 'DSH_CREDENTIALS_QUOTED_SCALAR',
  UNSAFE_CHARACTER: 'DSH_CREDENTIALS_UNSAFE_CHARACTER',
  BAD_ENTRY: 'DSH_CREDENTIALS_BAD_ENTRY',
  INLINE_MAPPING: 'DSH_CREDENTIALS_INLINE_MAPPING',
  MIXED_BLOCK: 'DSH_CREDENTIALS_MIXED_BLOCK',
  DUPLICATE_KEY: 'DSH_CREDENTIALS_DUPLICATE_KEY',
  TRAILING_CONTENT: 'DSH_CREDENTIALS_TRAILING_CONTENT',

  // ── 结构层 ────────────────────────────────────────────────────────────
  ROOT_NOT_MAPPING: 'DSH_CREDENTIALS_ROOT_NOT_MAPPING',
  ROOT_IS_SEQUENCE: 'DSH_CREDENTIALS_ROOT_IS_SEQUENCE',
  NO_VERSION: 'DSH_CREDENTIALS_NO_VERSION',
  BAD_VERSION: 'DSH_CREDENTIALS_BAD_VERSION',
  UNKNOWN_TOP_KEY: 'DSH_CREDENTIALS_UNKNOWN_TOP_KEY',
  SECTION_NOT_MAPPING: 'DSH_CREDENTIALS_SECTION_NOT_MAPPING',
  REF_KEY_INVALID: 'DSH_CREDENTIALS_REF_KEY_INVALID',
  REF_VALUE_MISSING: 'DSH_CREDENTIALS_REF_VALUE_MISSING',
  REF_VALUE_NOT_STRING: 'DSH_CREDENTIALS_REF_VALUE_NOT_STRING',
  RECORD_KEY_INVALID: 'DSH_CREDENTIALS_RECORD_KEY_INVALID',
  RECORD_NOT_MAPPING: 'DSH_CREDENTIALS_RECORD_NOT_MAPPING',
  RECORD_NO_KIND: 'DSH_CREDENTIALS_RECORD_NO_KIND',
  RECORD_UNKNOWN_KIND: 'DSH_CREDENTIALS_RECORD_UNKNOWN_KIND',
  RECORD_UNKNOWN_FIELD: 'DSH_CREDENTIALS_RECORD_UNKNOWN_FIELD',
  GRANT_PAYLOAD_MISSING: 'DSH_CREDENTIALS_GRANT_PAYLOAD_MISSING',
  API_KEY_VALUE_INVALID: 'DSH_CREDENTIALS_API_KEY_VALUE_INVALID',
  ENV_NOT_MAPPING: 'DSH_CREDENTIALS_ENV_NOT_MAPPING',
  ENV_NAME_INVALID: 'DSH_CREDENTIALS_ENV_NAME_INVALID',
  ENV_VALUE_INVALID: 'DSH_CREDENTIALS_ENV_VALUE_INVALID',
  PAYLOAD_NOT_JSON: 'DSH_CREDENTIALS_PAYLOAD_NOT_JSON',

  // ── 寻址层：引用名 → 条目（不是解析错误，是"这一条读不出一个字符串"） ──
  RECORD_NOT_A_STRING: 'DSH_CREDENTIALS_RECORD_NOT_A_STRING',
  RECORD_VALUE_AMBIGUOUS: 'DSH_CREDENTIALS_RECORD_VALUE_AMBIGUOUS',
})

// ------------------------------------------------------------------ 词法

/** refs 键：DSH 的 `credentialRef` 语法（POSIX 标识符）。 */
const REF_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** records 键的**单段**语法：DSH 的 `credentialKey` 要求小写连字符标识符。 */
const KEY_SEGMENT_RE = /^[a-z][a-z0-9-]*$/

/** YAML 1.2 core 会解析成**非字符串**的标量拼法（保守超集：多判不算错，漏判是安全事件）。 */
const NULL_RE = /^(?:~|null|Null|NULL)$/
const TRUE_RE = /^(?:true|True|TRUE)$/
const FALSE_RE = /^(?:false|False|FALSE)$/
const INT_RE = /^(?:[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)$/
const FLOAT_RE = /^(?:[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/

/**
 * 允许出现在**普通标量**首位的字符。
 *
 * YAML 的 c-indicator 是 `- ? : , [ ] { } # & * ! | > ' " % @ \``，首位取它们
 * 里任何一个都会改变这一行的**结构**（而不只是值）。所以首位只允许
 * 字母数字与 `. _ ~ + = /`——这几个都不是指示符。
 *
 * 这一条同时把所有"猜到结构上"的路堵死：没有引号、没有别名、没有标签、
 * 没有块标量、没有流式集合，读取器就不需要在任何地方判断"这个符号
 * 到底是内容还是结构"。
 */
const TOKEN_FIRST_RE = /^[A-Za-z0-9._~+=/]/

/**
 * 普通标量首位之后的允许字符。
 *
 * `#` 在集合里是**安全**的：`stripComment` 已经把所有"前面是空白的 `#`"
 * 当成注释切掉了，剩下的 `#` 只可能紧贴内容（`a#b`），而在 YAML 里
 * 那就是内容本身。`:` 同理——`plainToken` 单独拒绝 `: ` 与行尾 `:`，
 * 只有夹在中间的 `:`（`abc:def`）留得下来，而它也是一个普通标量。
 *
 * **空格是内容**：单行普通标量内部的空白原样保留（`a  b` 是两个空格），
 * 首尾空白由 YAML 折掉、因此这里 `.trim()` 掉。这一条必须对，因为
 * DSH 自己就会写出带空格的值（`A: a b`）——把它拒了会让一份**合法**
 * 文档整份不可用；而把它截断则会读出一把错的钥匙。两条都不可接受，
 * 所以按 YAML 的规则原样保留。
 */
const TOKEN_REST_RE = /^[A-Za-z0-9._+\-/=~:@,# ]*$/

/** 行内空白：普通标量内部的空格是内容，首尾空白由 YAML 折掉。 */
const TOKEN_SPACE = ' '

/** 具名拒绝。**只带 code、key 名与行号**；不带值、不带路径、不带源码片段。 */
function refuse(code, { ref = null, line = null, cause = null } = {}) {
  const where = line === null ? cause : (cause === null ? `line ${line}` : `line ${line}; ${cause}`)
  return new SecretStoreError(code, { ref, cause: where })
}

/**
 * 去掉行内注释：`#` 只在其前一个字符是**空白**（或行首）时才是注释起点。
 *
 * 这是 YAML 的普通标量终止规则，也是 DSH 写出来的那种文件里唯一出现的
 * 注释形态。它必须在结构解析**之前**做：`A: sk-x # rotated` 的值是
 * `sk-x`，若把注释一起当成值，读出来的就是一把不存在的钥匙。
 * （制表符在此之前已被整行拒绝，所以这里只需判空格。）
 */
function stripComment(text) {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '#') continue
    if (i === 0) return ''
    if (text[i - 1] === ' ') return text.slice(0, i)
  }
  return text
}

/**
 * 预处理：把原文切成"有内容的行"，并记下每行的缩进与原始行号。
 *
 * 原样保留行号是因为诊断只能给行号：这一行的内容就是密钥，不进错误。
 */
function prepareLines(text) {
  if (text.length > DSH_CREDENTIALS_MAX_BYTES) {
    throw refuse(DSH_CREDENTIALS_CODES.TOO_LARGE, { cause: `bytes>${DSH_CREDENTIALS_MAX_BYTES}` })
  }
  // CRLF 是 Windows 上的常态（DSH 自己也读得下）；**孤立 CR** 不是，拒绝。
  const normalized = text.replace(/\r\n/g, '\n')
  if (normalized.includes('\r')) throw refuse(DSH_CREDENTIALS_CODES.UNSAFE_CHARACTER, { cause: 'lone CR' })

  const out = []
  const raw = normalized.split('\n')
  for (let i = 0; i < raw.length; i += 1) {
    const lineNo = i + 1
    const rawLine = raw[i]
    // 制表符一律拒绝：YAML 禁止用 tab 缩进，而 tab 与空格的混用在
    // "看起来对齐"和"真的对齐"之间有一条只有解析器知道的缝。
    if (rawLine.includes('\t')) throw refuse(DSH_CREDENTIALS_CODES.TAB_INDENT, { line: lineNo })
    const content = stripComment(rawLine)
    const trimmed = content.trim()
    if (trimmed === '') continue
    const indent = content.length - content.trimStart().length
    if (indent % 2 !== 0) throw refuse(DSH_CREDENTIALS_CODES.BAD_INDENT, { line: lineNo })
    if (trimmed.startsWith('%')) throw refuse(DSH_CREDENTIALS_CODES.DIRECTIVE, { line: lineNo })
    if (trimmed.startsWith('---') || trimmed.startsWith('...')) {
      throw refuse(DSH_CREDENTIALS_CODES.DOCUMENT_MARKER, { line: lineNo })
    }
    if (trimmed.includes('&')) throw refuse(DSH_CREDENTIALS_CODES.ANCHOR, { line: lineNo })
    if (trimmed.includes('*')) throw refuse(DSH_CREDENTIALS_CODES.ALIAS, { line: lineNo })
    if (trimmed.includes('!')) throw refuse(DSH_CREDENTIALS_CODES.TAG, { line: lineNo })
    if (trimmed.startsWith('|') || trimmed.startsWith('>')) {
      throw refuse(DSH_CREDENTIALS_CODES.BLOCK_SCALAR, { line: lineNo })
    }
    out.push(Object.freeze({ no: lineNo, indent, text: trimmed }))
  }
  return out
}

/** 这一行是一条块序列项（`-` 或 `- ...`）吗。 */
function isSeqEntry(line) {
  return line.text === '-' || line.text.startsWith('- ')
}

/**
 * 找块映射的分隔冒号。YAML 里 `:` 只有在**后面跟空白或行尾**时才是分隔符——
 * `a:b` 是一个普通标量，不是一个映射。找错了这个位置，就会把"值的一部分"
 * 当成键，或者反过来。
 * @returns `{key, rest}`，或 `null`（这一行不是映射项）。
 */
function splitEntry(text) {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== ':') continue
    const next = text[i + 1]
    if (next === undefined) return { key: text.slice(0, i), rest: '' }
    if (next === TOKEN_SPACE) {
      let end = text.length
      while (end > i + 1 && text[end - 1] === TOKEN_SPACE) end -= 1
      return { key: text.slice(0, i), rest: text.slice(i + 1, end) }
    }
  }
  return null
}

/** 校验一个普通标量 token 的字符集与结构歧义。返回折掉首尾空白的内容。 */
function plainToken(raw, line, ref) {
  const token = raw.trim()
  if (token === '') return token
  if (token.startsWith('[') || token.startsWith('{')) throw refuse(DSH_CREDENTIALS_CODES.FLOW_STYLE, { ref, line })
  if (token.startsWith("'") || token.startsWith('"')) throw refuse(DSH_CREDENTIALS_CODES.QUOTED_SCALAR, { ref, line })
  if (token.startsWith('|') || token.startsWith('>')) throw refuse(DSH_CREDENTIALS_CODES.BLOCK_SCALAR, { ref, line })
  // `key: value` 出现在**值**里 = 行内嵌套映射。读不出它的边界就不读它。
  if (token.endsWith(':') || token.includes(': ')) throw refuse(DSH_CREDENTIALS_CODES.INLINE_MAPPING, { ref, line })
  const head = token[0]
  if (!TOKEN_FIRST_RE.test(head)) throw refuse(DSH_CREDENTIALS_CODES.UNSAFE_CHARACTER, { ref, line })
  const tail = token.slice(1)
  if (tail !== '' && !TOKEN_REST_RE.test(tail)) throw refuse(DSH_CREDENTIALS_CODES.UNSAFE_CHARACTER, { ref, line })
  return token
}

/** 按 YAML 1.2 core 把普通标量分类；分类不出来的一律当字符串。 */
function classifyScalar(token) {
  if (NULL_RE.test(token)) return { t: 'null' }
  if (TRUE_RE.test(token)) return { t: 'bool', v: true }
  if (FALSE_RE.test(token)) return { t: 'bool', v: false }
  if (INT_RE.test(token)) return { t: 'num', v: Number(token) }
  if (FLOAT_RE.test(token)) return { t: 'num', v: Number(token) }
  return { t: 'str', v: token }
}

/** 一个标量节点：token 是原文，`line`/`ref` 只用于诊断。 */
function scalarNode(raw, line, ref) {
  const token = plainToken(raw, line, ref)
  if (token === '') return null
  return classifyScalar(token)
}

// ------------------------------------------------------------------ 块解析

/**
 * 解析一层块。返回 `[node, nextIndex]`。
 *
 * 缩进**必须**是 2 的倍数且逐层 +2——这就是 DSH 的 `Document.toString()`
 * 写出来的形状（实测）。比 DSH 更严是刻意的：本读取器只承诺读懂
 * "DSH 写出来的那个子集"，而不是"DSH 能读懂的所有 YAML"。
 *
 * 一个节点的三种形态在这里分流：序列（`- `）、映射（有分隔冒号）、
 * 标量（一行，没有分隔冒号）。标量这一路是必须的——否则一个标量根
 * （`hello`）会被报成"这不是一个映射项"，而**根不是映射**与**这一行
 * 不成项**是两条不同的诊断。
 */
function parseBlock(lines, start, indent) {
  const line = lines[start]
  if (line.indent !== indent) throw refuse(DSH_CREDENTIALS_CODES.BAD_INDENT, { line: line.no })
  if (isSeqEntry(line)) return parseSequence(lines, start, indent)
  if (splitEntry(line.text) === null) {
    // 本子集里标量只能占**一行**：多行标量（块标量）在词法层就被拒了，
    // 所以这里多出任何一行同层或更深的行都意味着我们理解错了边界。
    const node = scalarNode(line.text, line.no, null)
    const next = start + 1
    if (next < lines.length && lines[next].indent >= indent) {
      throw refuse(DSH_CREDENTIALS_CODES.BAD_INDENT, { line: lines[next].no })
    }
    return [node, next]
  }
  return parseMapping(lines, start, indent)
}

function parseMapping(lines, start, indent) {
  const entries = new Map()
  let i = start
  while (i < lines.length && lines[i].indent === indent) {
    const line = lines[i]
    if (isSeqEntry(line)) throw refuse(DSH_CREDENTIALS_CODES.MIXED_BLOCK, { line: line.no })
    const entry = splitEntry(line.text)
    if (entry === null || entry.key === '') throw refuse(DSH_CREDENTIALS_CODES.BAD_ENTRY, { line: line.no })
    const key = plainToken(entry.key, line.no, null)
    if (entries.has(key)) throw refuse(DSH_CREDENTIALS_CODES.DUPLICATE_KEY, { ref: key, line: line.no })
    i += 1
    let node
    if (entry.rest === '') {
      if (i < lines.length && lines[i].indent > indent) {
        ;[node, i] = parseBlock(lines, i, indent + 2)
      } else {
        node = null
      }
    } else {
      node = scalarNode(entry.rest, line.no, key)
    }
    entries.set(key, node)
  }
  if (i < lines.length && lines[i].indent > indent) throw refuse(DSH_CREDENTIALS_CODES.BAD_INDENT, { line: lines[i].no })
  return [{ t: 'map', v: entries }, i]
}

function parseSequence(lines, start, indent) {
  const items = []
  let i = start
  while (i < lines.length && lines[i].indent === indent) {
    const line = lines[i]
    if (!isSeqEntry(line)) throw refuse(DSH_CREDENTIALS_CODES.MIXED_BLOCK, { line: line.no })
    const rest = line.text === '-' ? '' : line.text.slice(2).trim()
    i += 1
    let node
    if (rest === '') {
      if (i < lines.length && lines[i].indent > indent) {
        ;[node, i] = parseBlock(lines, i, indent + 2)
      } else {
        node = null
      }
    } else {
      // `- key: value` 是"行内开始的映射项"。它在本子集里没有位置：DSH 写
      // 序列时总是把每一项放在自己的行上，而批准这个形状需要一套我们
      // 没有证明过的续行规则。
      if (splitEntry(rest) !== null) throw refuse(DSH_CREDENTIALS_CODES.INLINE_MAPPING, { line: line.no })
      node = scalarNode(rest, line.no, null)
    }
    items.push(node)
  }
  if (i < lines.length && lines[i].indent > indent) throw refuse(DSH_CREDENTIALS_CODES.BAD_INDENT, { line: lines[i].no })
  return [{ t: 'seq', v: items }, i]
}

// ------------------------------------------------------------------ 结构

/** 节点 → 可 JSON 化的值。**只有 JSON 能表示的东西才走得出去。** */
function toJsonValue(node, ref) {
  if (node === null) return null
  switch (node.t) {
    case 'null': return null
    case 'bool':
    case 'str': return node.v
    case 'num':
      if (!Number.isFinite(node.v)) throw refuse(DSH_CREDENTIALS_CODES.PAYLOAD_NOT_JSON, { ref })
      return node.v
    case 'seq': return node.v.map((child) => toJsonValue(child, ref))
    case 'map': {
      const out = {}
      for (const [key, child] of node.v) {
        // `defineProperty` 而不是 `out[key] = ...`：payload 的键来自文件，
        // 而 `__proto__` 这类键用赋值会改掉原型（原型污染）而不是建一个字段。
        Object.defineProperty(out, key, {
          value: toJsonValue(child, ref), enumerable: true, writable: true, configurable: true,
        })
      }
      return out
    }
    /* c8 ignore next 2 -- node.t 只有上面六种，switch 已穷尽 */
    default: throw refuse(DSH_CREDENTIALS_CODES.PAYLOAD_NOT_JSON, { ref })
  }
}

function asSection(node, name) {
  // `undefined` = 这个顶层键**不在文档里**（`Map.get` 的缺席），`null` = 键在但
  // 没有值（`refs:` 后面什么都没有）。两者都是"空段"：DSH 的 `asSection`
  // 对 undefined/null 都返回 `{}`，而 `version: 1` 之后一个 refs 都没有
  // 是一份完全正常的文档。
  if (node === null || node === undefined) return null
  if (node.t !== 'map') throw refuse(DSH_CREDENTIALS_CODES.SECTION_NOT_MAPPING, { ref: name })
  return node.v
}

/** `refs`：POSIX 标识符 → 非空字符串。 */
function parseRefsSection(node) {
  const out = new Map()
  const entries = asSection(node, 'refs')
  if (entries === null) return out
  for (const [key, value] of entries) {
    if (!REF_NAME_RE.test(key)) throw refuse(DSH_CREDENTIALS_CODES.REF_KEY_INVALID, { ref: key })
    if (value === null) throw refuse(DSH_CREDENTIALS_CODES.REF_VALUE_MISSING, { ref: key })
    if (value.t !== 'str') throw refuse(DSH_CREDENTIALS_CODES.REF_VALUE_NOT_STRING, { ref: key })
    out.set(key, value.v)
  }
  return out
}

/** `records`：`<scope>/<id>` → 带 tag 的记录映射。 */
function parseRecordsSection(node) {
  const out = new Map()
  const entries = asSection(node, 'records')
  if (entries === null) return out
  for (const [key, value] of entries) {
    const segments = key.split('/')
    if (segments.length !== 2 || !segments.every((s) => KEY_SEGMENT_RE.test(s))) {
      throw refuse(DSH_CREDENTIALS_CODES.RECORD_KEY_INVALID, { ref: key })
    }
    out.set(key, parseRecord(key, value))
  }
  return out
}

function parseRecord(key, node) {
  if (node === null || node.t !== 'map') throw refuse(DSH_CREDENTIALS_CODES.RECORD_NOT_MAPPING, { ref: key })
  const fields = node.v
  const kind = fields.get('kind')
  if (kind === undefined) throw refuse(DSH_CREDENTIALS_CODES.RECORD_NO_KIND, { ref: key })
  if (kind === null || kind.t !== 'str' || (kind.v !== 'api-key' && kind.v !== 'grant')) {
    throw refuse(DSH_CREDENTIALS_CODES.RECORD_UNKNOWN_KIND, { ref: key })
  }
  if (kind.v === 'api-key') {
    for (const field of fields.keys()) {
      if (field !== 'kind' && field !== 'key' && field !== 'env') {
        throw refuse(DSH_CREDENTIALS_CODES.RECORD_UNKNOWN_FIELD, { ref: key, cause: field })
      }
    }
    const apiKey = fields.get('key')
    if (apiKey !== undefined && (apiKey === null || apiKey.t !== 'str')) {
      throw refuse(DSH_CREDENTIALS_CODES.API_KEY_VALUE_INVALID, { ref: key })
    }
    const env = fields.get('env')
    let parsedEnv
    if (env !== undefined) {
      if (env === null || env.t !== 'map') throw refuse(DSH_CREDENTIALS_CODES.ENV_NOT_MAPPING, { ref: key })
      parsedEnv = {}
      for (const [name, value] of env.v) {
        if (!REF_NAME_RE.test(name)) throw refuse(DSH_CREDENTIALS_CODES.ENV_NAME_INVALID, { ref: key, cause: name })
        if (value === null || value.t !== 'str') throw refuse(DSH_CREDENTIALS_CODES.ENV_VALUE_INVALID, { ref: key, cause: name })
        parsedEnv[name] = value.v
      }
    }
    return Object.freeze({
      kind: 'api-key',
      ...apiKey === undefined ? {} : { key: apiKey.v },
      ...parsedEnv === undefined ? {} : { env: Object.freeze(parsedEnv) },
    })
  }
  for (const field of fields.keys()) {
    if (field !== 'kind' && field !== 'payload') {
      throw refuse(DSH_CREDENTIALS_CODES.RECORD_UNKNOWN_FIELD, { ref: key, cause: field })
    }
  }
  if (!fields.has('payload')) throw refuse(DSH_CREDENTIALS_CODES.GRANT_PAYLOAD_MISSING, { ref: key })
  return Object.freeze({ kind: 'grant', payload: toJsonValue(fields.get('payload'), key) })
}

/**
 * 解析一份 DSH 凭证文档。
 *
 * @param {string} text 文档原文。
 * @returns {{refs: Map<string,string>, records: Map<string,object>}} 只读快照。
 * @throws {SecretStoreError} 具名拒绝码（见 {@link DSH_CREDENTIALS_CODES}）。
 *
 * **刻意不接文件名参数。** Legion 的密钥诊断不带路径：路径里可能出现
 * 账户名，而这一层的错误会被显示、被导出、被附进工单。DSH 自己会打印
 * 文件名，本模块不跟——它给的是行号。
 */
export function parseDshCredentialsDocument(text) {
  if (typeof text !== 'string') throw new TypeError('parseDshCredentialsDocument 需要文档原文')
  const lines = prepareLines(text)
  // 空文档（含只有注释/空行的）是**空库**，不需要 version——与 DSH 一致。
  if (lines.length === 0) return { refs: new Map(), records: new Map() }
  if (lines[0].indent !== 0) throw refuse(DSH_CREDENTIALS_CODES.BAD_INDENT, { line: lines[0].no })

  const [root, next] = parseBlock(lines, 0, 0)
  if (next < lines.length) throw refuse(DSH_CREDENTIALS_CODES.TRAILING_CONTENT, { line: lines[next].no })

  // `null` 根（一行 `~` / `null`）在 DSH 里也是空库：`document.toJS() ?? {}`。
  // 这是唯一一个"非映射根"被接受的形状。
  if (root.t === 'null') return { refs: new Map(), records: new Map() }
  if (root.t === 'seq') throw refuse(DSH_CREDENTIALS_CODES.ROOT_IS_SEQUENCE)
  if (root.t !== 'map') throw refuse(DSH_CREDENTIALS_CODES.ROOT_NOT_MAPPING)

  const keys = [...root.v.keys()]
  if (keys.length === 0) return { refs: new Map(), records: new Map() }
  if (!keys.includes('version')) throw refuse(DSH_CREDENTIALS_CODES.NO_VERSION)

  const version = root.v.get('version')
  if (version === null || version.t !== 'num' || version.v !== DSH_DOCUMENT_VERSION) {
    throw refuse(DSH_CREDENTIALS_CODES.BAD_VERSION)
  }
  for (const key of keys) {
    if (key !== 'version' && key !== 'refs' && key !== 'records') {
      throw refuse(DSH_CREDENTIALS_CODES.UNKNOWN_TOP_KEY, { ref: key })
    }
  }
  return { refs: parseRefsSection(root.v.get('refs')), records: parseRecordsSection(root.v.get('records')) }
}

// ------------------------------------------------------------------ 寻址

/**
 * 一个 Legion 引用名能不能被 DSH 的两个键空间寻址，以及怎么寻。
 *
 * 两个键空间的语法**不同**（这正是 DSH 让它们不碰撞的手法）：
 *   `refs`    键是 POSIX 标识符（`DEEPSEEK_API_KEY`）；
 *   `records` 键是**恰好两段**的小写连字符标识符（`deepseek/main`）。
 *
 * Legion 的 `secretRef` 比两者都宽：它允许单段，也允许任意多段斜杠段。
 * 于是"不能寻址"是一条**真实且常见**的结论，必须与"文件里没有这一条"
 * 分开报——把前者说成后者，用户会去 DSH 里找一条根本不可能存在的记录。
 */
export function planDshLookup(ref) {
  if (!ref.includes('/')) {
    if (!REF_NAME_RE.test(ref)) return Object.freeze({ addressable: false, space: null })
    return Object.freeze({ addressable: true, space: 'refs' })
  }
  const segments = ref.split('/')
  if (segments.length !== 2 || !segments.every((s) => KEY_SEGMENT_RE.test(s))) {
    return Object.freeze({ addressable: false, space: null })
  }
  return Object.freeze({ addressable: true, space: 'records' })
}

/**
 * 在一个已解析的文档里找一条记录。**不抛**——把它读成什么由调用方决定：
 * `get()` 把"读不出字符串"变成具名错误，`explain()` 把它如实报成读法。
 */
function lookup(document, ref, space) {
  if (space === 'refs') {
    const value = document.refs.get(ref)
    return value === undefined
      ? { found: false, reason: 'absent' }
      : { found: true, value }
  }
  const record = document.records.get(ref)
  if (record === undefined) return { found: false, reason: 'absent' }
  // grant 的 payload 是个 JSON 值，**不是**一把字符串钥匙。把它序列化成
  // 字符串再当凭证用，等于给供应商发一段 JSON——那不是猜，那是编。
  if (record.kind === 'grant') return { found: false, reason: 'record-not-a-string' }
  if (record.key !== undefined) return { found: true, value: record.key }
  const names = Object.keys(record.env ?? {})
  if (names.length === 1) return { found: true, value: record.env[names[0]] }
  // 既没有 `key`、env 又不恰好一条：**没有唯一答案**。
  // 挑一条（比如字典序第一条）就是编一个用户没选过的凭证。
  return { found: false, reason: 'record-ambiguous' }
}

// ------------------------------------------------------------------ 来源

function assertRefOrThrow(ref) {
  try {
    assertSecretRef(ref)
  } catch {
    throw new SecretStoreError('SECRET_REF_INVALID', { ref: typeof ref === 'string' ? ref : null, cause: 'ref-grammar' })
  }
  return ref
}

/**
 * 构造一个**只读**的 DSH 凭证来源。
 *
 * 它满足 resolver 对 fallback 的唯一要求（`get(ref)`，与 `store.get` 同形），
 * 另外提供两个**只读**读数：
 *   · `explain(ref)` —— 为什么没有值（`absent` / `not-addressable` / …）；
 *   · `inspect()`    —— 文件层的状态（`absent` / `loaded` / `unrecognized`）。
 * 这两个读数的存在理由是同一条："没有文件"、"读不懂"与"文件里没有这条"
 * **不得被塌成同一个值**。
 *
 * 每次调用都真的去读一次文件：不缓存明文（与 `runtime/probe` 的
 * 「不缓存明文」同一条纪律），并且让编辑过的文件下一次就被看见。
 *
 * @param {object} deps
 * @param {string} deps.file       `.credentials.yaml` 的**绝对路径**
 * @param {Function} [deps.readFile] `async (path, enc) => string`（用例注入）
 * @param {Function} [deps.stat]     `async (path) => {mtimeMs}`（用例注入）
 * @param {Function} [deps.now]      时钟（用例注入；默认 ISO 字符串）
 */
export function createDshCredentialsSource({
  file,
  readFile = null,
  stat = null,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof file !== 'string' || file === '') throw new TypeError('createDshCredentialsSource 需要 file 路径')
  const ioRead = readFile ?? nodeReadFile
  const ioStat = stat ?? nodeStat

  /** 读并解析；**ENOENT 不是错误**（从没用过 DSH Models 页的机器就是这个形状）。 */
  async function load() {
    let text
    try {
      text = await ioRead(file, 'utf8')
    } catch (err) {
      if (err?.code === 'ENOENT') return { present: false }
      // 只带 errno 这类结构信息：路径与底层 message 都可能是账户名。
      throw new SecretStoreError(DSH_CREDENTIALS_CODES.UNREADABLE, { cause: err?.code ?? 'read-error' })
    }
    return { present: true, document: parseDshCredentialsDocument(text) }
  }

  async function probe(ref) {
    assertRefOrThrow(ref)
    const plan = planDshLookup(ref)
    if (!plan.addressable) return { found: false, reason: 'not-addressable' }
    const loaded = await load()
    if (!loaded.present) return { found: false, reason: 'no-file' }
    return lookup(loaded.document, ref, plan.space)
  }

  async function get(ref) {
    const reading = await probe(ref)
    if (reading.found === true) {
      return Object.freeze({ ref, value: reading.value, resolvedAt: now(), source: DSH_CREDENTIALS_SOURCE })
    }
    // 条目**在**文件里，但它读不出一把字符串钥匙。报 `SECRET_NOT_FOUND`
    // 会是一句假话（"本机密钥库里没有这条"），所以这里具名拒绝。
    if (reading.reason === 'record-not-a-string') {
      throw new SecretStoreError(DSH_CREDENTIALS_CODES.RECORD_NOT_A_STRING, { ref })
    }
    if (reading.reason === 'record-ambiguous') {
      throw new SecretStoreError(DSH_CREDENTIALS_CODES.RECORD_VALUE_AMBIGUOUS, { ref })
    }
    return null
  }

  async function describe(ref) {
    const reading = await probe(ref)
    if (reading.found !== true) return null
    // DSH 不存每条记录的时间戳，所以"版本"只能是**文件**的修改时间。
    // 它是**过粗**而不是过细：任何一个条目的改动都会让所有 DSH 来源的
    // 缓存失效。方向是安全的（宁可多探一次），理由是 `credentialVersionOf`
    // 存在的唯一目的就是"轮换之后判定自动重来"。
    let mtimeMs = null
    try {
      mtimeMs = (await ioStat(file)).mtimeMs
    } catch {
      // 文件刚被删掉：描述不出来就是 null，而不是编一个时间。
      return null
    }
    return Object.freeze({ ref, source: DSH_CREDENTIALS_SOURCE, updatedAt: new Date(Math.floor(mtimeMs)).toISOString() })
  }

  async function explain(ref) {
    const reading = await probe(ref)
    return Object.freeze({
      ref,
      source: DSH_CREDENTIALS_SOURCE,
      found: reading.found === true,
      reason: reading.found === true ? 'value' : reading.reason,
    })
  }

  /**
   * 文件层读数。**不抛**：它是给人看的状态，不是形状错误。
   *
   * 四态，且四态**互不相等**：
   *   `absent`       文件不在（从未用过 DSH 的 Models 页时这是常态，不是错误）
   *   `loaded`       文件在且读懂了（`refs`/`records` 是**计数**，不带名字）
   *   `unrecognized` 文件在、但不在本读取器认识的确切子集内（`code` 说明哪一类）
   *   `unreadable`   文件在、但读不出来（权限/磁盘/句柄）
   *
   * 后两者分开的理由与 `security/secrets/acl.mjs` 的 `ACL_TOO_PERMISSIVE` /
   * `ACL_UNVERIFIABLE` 完全一样：**"看过了，是坏的"与"根本没看到"是两条
   * 不同的信息**，而它们的下一步动作也不同（前者去修文件，后者去修权限）。
   */
  async function inspect() {
    try {
      const loaded = await load()
      if (!loaded.present) {
        return Object.freeze({ source: DSH_CREDENTIALS_SOURCE, file, state: 'absent', code: null, refs: 0, records: 0 })
      }
      return Object.freeze({
        source: DSH_CREDENTIALS_SOURCE,
        file,
        state: 'loaded',
        code: null,
        refs: loaded.document.refs.size,
        records: loaded.document.records.size,
      })
    } catch (err) {
      const code = typeof err?.code === 'string' ? err.code : DSH_CREDENTIALS_CODES.UNREADABLE
      return Object.freeze({
        source: DSH_CREDENTIALS_SOURCE,
        file,
        state: code === DSH_CREDENTIALS_CODES.UNREADABLE ? 'unreadable' : 'unrecognized',
        code,
        refs: 0,
        records: 0,
      })
    }
  }

  return Object.freeze({ source: DSH_CREDENTIALS_SOURCE, file, get, describe, explain, inspect })
}
