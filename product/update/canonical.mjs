// product/update/canonical.mjs
// ============================================================================
// 严格 JSON：**签名与摘要的地基**
//
// 自动更新设计 §5（line 108）要求：签名覆盖 `canonicalJson(payload)` 的
// UTF-8 字节，验证器拒绝「重复 JSON 键、非法数字、未知格式、超大输入」。
//
// 这三条不是洁癖，每一条都对应一次真实的信任事故：
//
//   · **重复键** —— `JSON.parse('{"a":1,"a":2}')` 得到 `{a:2}`，**静默**丢掉
//     第一个。于是签名的实现与验签的实现只要对"取哪一个 a"有不同意见，
//     同一串字节就能同时是"合法签名"和"另一个 payload"。这不是理论问题：
//     凡是"先解析再规范化再验签"的实现，都必然在这里和解析器语义绑定。
//     所以本模块**在扫描阶段就拒绝**重复键，而不是挑一个。
//
//   · **非法数字** —— `JSON.stringify` 会把 `NaN`/`Infinity` 写成 `null`，
//     把 `1e999` 写成 `null`。一份含这些值的 payload 规范化之后与另一份
//     真正含 `null` 的 payload **字节相同**。
//
//   · **超大输入** —— 没有上限的解析器就是一个"让对方决定你分配多少内存"
//     的接口。上限放在这里，而不是放在调用方"记得检查"的地方。
//
// ## 为什么不用 `JSON.parse` + 正则查重键
//
// 正则查不出 `{"a":1,"\u0061":2}`（同一个键的两种写法），也查不出嵌套在
// 字符串里的 `"a":`。判据必须建立在**词法**上，也就是"自己扫一遍"。
//
// 扫描器只做一件事：把一个 JSON 文本变成值，并在途中对上面三条各留一个
// 明确的拒绝点。它不追求性能，它追求**拒绝的理由能被读出来**。
// ============================================================================

import { createHash } from 'node:crypto'

/** 解析类失败的错误码。每一个都对应一条"必须拒绝"的判据。 */
export const CANONICAL_CODES = Object.freeze({
  TOO_LARGE: 'json-too-large',
  MALFORMED: 'json-malformed',
  DUPLICATE_KEY: 'json-duplicate-key',
  BAD_NUMBER: 'json-bad-number',
  TOO_DEEP: 'json-too-deep',
  TRAILING: 'json-trailing-content',
  NOT_SERIALIZABLE: 'json-not-serializable',
  UNPAIRED_SURROGATE: 'json-unpaired-surrogate',
})

/** 默认上限：与设计 §6 的「清单上限 256 KiB」同源。 */
export const DEFAULT_MAX_JSON_BYTES = 256 * 1024

/** 默认深度上限。够表达任何真实清单，且让递归不会先撞上栈。 */
export const DEFAULT_MAX_DEPTH = 32

function fail(code, message, detail = null) {
  const error = new Error(message)
  error.code = code
  if (detail !== null) error.detail = detail
  return error
}

function isDigit(ch) {
  return ch >= 0x30 && ch <= 0x39
}

/**
 * 把无原型累加器变回普通对象。
 *
 * 直接用 `Object.fromEntries`：它按 `CreateDataProperty` 定义属性，
 * 所以 `__proto__` 变成一个**普通的自有键**而不是原型设置器，
 * 同时结果对象又带着正常的 `Object.prototype`（`deepStrictEqual`
 * 与 `value.hasOwnProperty(...)` 的用法都不受影响）。
 */
function plainOf(acc) {
  return Object.fromEntries(Object.entries(acc))
}

/**
 * 扫描 JSON 文本。
 *
 * 与 `JSON.parse` 的**故意**差异，每一条都是拒收而不是兼容：
 *   · 重复键               → `json-duplicate-key`
 *   · `1e999` / `-0`       → `json-bad-number`
 *   · 前后有多余内容       → `json-trailing-content`
 *   · 深度超过 maxDepth    → `json-too-deep`
 *   · 字符串里的孤立代理项 → `json-unpaired-surrogate`
 */
export function parseJsonStrict(text, {
  maxBytes = DEFAULT_MAX_JSON_BYTES,
  maxDepth = DEFAULT_MAX_DEPTH,
} = {}) {
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(String(text), 'utf8')
  if (bytes.length > maxBytes) {
    throw fail(CANONICAL_CODES.TOO_LARGE, `JSON 输入 ${bytes.length} 字节，超过上限 ${maxBytes}`, { bytes: bytes.length, maxBytes })
  }
  const src = bytes.toString('utf8')
  let i = 0

  const err = (code, message, detail) => fail(code, `${message}（偏移 ${i}）`, detail)

  function skipWs() {
    while (i < src.length) {
      const c = src.charCodeAt(i)
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i += 1
      else break
    }
  }

  function parseString() {
    // 进入时 src[i] === '"'
    i += 1
    let out = ''
    for (;;) {
      if (i >= src.length) throw err(CANONICAL_CODES.MALFORMED, '字符串没有结束引号')
      const c = src.charCodeAt(i)
      if (c === 0x22) { i += 1; return out }
      if (c === 0x5c) {
        i += 1
        const esc = src[i]
        if (esc === undefined) throw err(CANONICAL_CODES.MALFORMED, '转义序列被截断')
        if (esc === 'u') {
          const hex = src.slice(i + 1, i + 5)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw err(CANONICAL_CODES.MALFORMED, '\\u 转义不是 4 位十六进制')
          let code = Number.parseInt(hex, 16)
          i += 5
          // ★ 代理项必须成对。孤立的 `\uD800` 在 UTF-8 编码时会被替换成
          //   U+FFFD，于是"验签时的字节"与"签名时的字节"不同——而两边的
          //   实现都会认为自己是对的。
          if (code >= 0xd800 && code <= 0xdbff) {
            if (src[i] !== '\\' || src[i + 1] !== 'u') {
              throw err(CANONICAL_CODES.UNPAIRED_SURROGATE, '高位代理项没有配对的低位代理项')
            }
            const low = Number.parseInt(src.slice(i + 2, i + 6), 16)
            if (!(low >= 0xdc00 && low <= 0xdfff)) {
              throw err(CANONICAL_CODES.UNPAIRED_SURROGATE, '高位代理项后面的不是低位代理项')
            }
            i += 6
            code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00)
            out += String.fromCodePoint(code)
            continue
          }
          if (code >= 0xdc00 && code <= 0xdfff) {
            throw err(CANONICAL_CODES.UNPAIRED_SURROGATE, '孤立的低位代理项')
          }
          out += String.fromCharCode(code)
          continue
        }
        const simple = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[esc]
        if (simple === undefined) throw err(CANONICAL_CODES.MALFORMED, `未知转义 \\${esc}`)
        out += simple
        i += 1
        continue
      }
      if (c < 0x20) throw err(CANONICAL_CODES.MALFORMED, '字符串里出现未转义的控制字符')
      out += src[i]
      i += 1
    }
  }

  function parseNumber() {
    const start = i
    if (src[i] === '-') i += 1
    if (!isDigit(src.charCodeAt(i))) throw err(CANONICAL_CODES.MALFORMED, '数字缺少整数部分')
    if (src[i] === '0' && isDigit(src.charCodeAt(i + 1))) {
      throw err(CANONICAL_CODES.BAD_NUMBER, '数字有前导零')
    }
    while (isDigit(src.charCodeAt(i))) i += 1
    if (src[i] === '.') {
      i += 1
      if (!isDigit(src.charCodeAt(i))) throw err(CANONICAL_CODES.BAD_NUMBER, '小数点后没有数字')
      while (isDigit(src.charCodeAt(i))) i += 1
    }
    if (src[i] === 'e' || src[i] === 'E') {
      i += 1
      if (src[i] === '+' || src[i] === '-') i += 1
      if (!isDigit(src.charCodeAt(i))) throw err(CANONICAL_CODES.BAD_NUMBER, '指数部分没有数字')
      while (isDigit(src.charCodeAt(i))) i += 1
    }
    const raw = src.slice(start, i)
    const value = Number(raw)
    // ★ `1e999` → `Infinity`，而 `JSON.stringify(Infinity)` 是 `null`。
    //   放它过去，一份"含一个不可能的数字"的 payload 就会和"含 null"的
    //   payload 得到同一段被签名的字节。
    if (!Number.isFinite(value)) throw err(CANONICAL_CODES.BAD_NUMBER, `数字不可表示：${raw}`)
    // ★ `-0` 与 `0` 的 `JSON.stringify` 分别是 `"0"` 和 `"0"`：
    //   往返不一致的值不进签名覆盖面。
    if (Object.is(value, -0)) throw err(CANONICAL_CODES.BAD_NUMBER, '不接受 -0')
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw err(CANONICAL_CODES.BAD_NUMBER, `整数超出安全范围：${raw}`)
    }
    return value
  }

  function parseValue(depth) {
    if (depth > maxDepth) throw err(CANONICAL_CODES.TOO_DEEP, `嵌套深度超过 ${maxDepth}`)
    skipWs()
    const c = src[i]
    if (c === '{') {
      i += 1
      // ★ 累加器必须是**无原型**的。用 `{}` 时 `out['__proto__'] = v` 走的是
      //   原型设置器而不是定义属性：一份 `{"__proto__":{...}}` 的清单会静默
      //   丢掉那个键（于是验签的 payload 和签名的 payload 不同），
      //   严重时还会污染 `Object.prototype`。
      const acc = Object.create(null)
      skipWs()
      if (src[i] === '}') { i += 1; return plainOf(acc) }
      for (;;) {
        skipWs()
        if (src[i] !== '"') throw err(CANONICAL_CODES.MALFORMED, '对象的键必须是字符串')
        const key = parseString()
        // ★ 重复键在这里被拒，而不是被"最后一个赢"或者"第一个赢"。
        if (Object.hasOwn(acc, key)) throw err(CANONICAL_CODES.DUPLICATE_KEY, `对象里出现重复键 ${JSON.stringify(key)}`, { key })
        skipWs()
        if (src[i] !== ':') throw err(CANONICAL_CODES.MALFORMED, '键之后缺少冒号')
        i += 1
        acc[key] = parseValue(depth + 1)
        skipWs()
        if (src[i] === ',') { i += 1; continue }
        if (src[i] === '}') { i += 1; return plainOf(acc) }
        throw err(CANONICAL_CODES.MALFORMED, '对象里缺少逗号或右花括号')
      }
    }
    if (c === '[') {
      i += 1
      const out = []
      skipWs()
      if (src[i] === ']') { i += 1; return out }
      for (;;) {
        out.push(parseValue(depth + 1))
        skipWs()
        if (src[i] === ',') { i += 1; continue }
        if (src[i] === ']') { i += 1; return out }
        throw err(CANONICAL_CODES.MALFORMED, '数组里缺少逗号或右方括号')
      }
    }
    if (c === '"') return parseString()
    if (c === 't') { if (src.startsWith('true', i)) { i += 4; return true } throw err(CANONICAL_CODES.MALFORMED, '未知字面量') }
    if (c === 'f') { if (src.startsWith('false', i)) { i += 5; return false } throw err(CANONICAL_CODES.MALFORMED, '未知字面量') }
    if (c === 'n') { if (src.startsWith('null', i)) { i += 4; return null } throw err(CANONICAL_CODES.MALFORMED, '未知字面量') }
    if (c === undefined) throw err(CANONICAL_CODES.MALFORMED, 'JSON 意外结束')
    if (c === '-' || isDigit(src.charCodeAt(i))) return parseNumber()
    // ★ `NaN` / `Infinity` 不是 JSON。`JSON.parse` 也会拒绝它，
    //   但这里的错误码要能让调用方区分"语法错"与"数字不可表示"。
    throw err(CANONICAL_CODES.MALFORMED, `无法解析的值：${JSON.stringify(c)}`)
  }

  const value = parseValue(1)
  skipWs()
  if (i !== src.length) throw err(CANONICAL_CODES.TRAILING, 'JSON 之后还有多余内容')
  return value
}

/**
 * 规范化 JSON —— 签名与摘要**唯一**允许的字节化方式。
 *
 * 规则（与设计 §5 的 envelope 口径一致）：
 *   · 对象键按 UTF-16 码元升序；
 *   · 无空白；
 *   · 只接受本模块认得的有限数值；
 *   · 字符串按 `JSON.stringify` 转义（唯一可逆的写法）。
 *
 * 遇到不可序列化的值**抛错**，不返回 `undefined`：一个"默默产出 undefined"
 * 的规范化函数会让签名覆盖面变成字符串 `"undefined"`，而调用方不会知道。
 */
export function canonicalJson(value) {
  const walk = (v, depth) => {
    if (depth > DEFAULT_MAX_DEPTH) throw fail(CANONICAL_CODES.TOO_DEEP, `规范化深度超过 ${DEFAULT_MAX_DEPTH}`)
    if (v === null) return 'null'
    const t = typeof v
    if (t === 'boolean') return v ? 'true' : 'false'
    if (t === 'number') {
      if (!Number.isFinite(v)) throw fail(CANONICAL_CODES.BAD_NUMBER, `不可序列化的数字：${v}`)
      if (Object.is(v, -0)) throw fail(CANONICAL_CODES.BAD_NUMBER, '不接受 -0')
      if (Number.isInteger(v) && !Number.isSafeInteger(v)) {
        throw fail(CANONICAL_CODES.BAD_NUMBER, `整数超出安全范围：${v}`)
      }
      return JSON.stringify(v)
    }
    if (t === 'string') return JSON.stringify(v)
    if (Array.isArray(v)) return `[${v.map((item) => walk(item, depth + 1)).join(',')}]`
    if (t === 'object') {
      const keys = Object.keys(v).sort()
      const parts = keys.map((k) => `${JSON.stringify(k)}:${walk(v[k], depth + 1)}`)
      return `{${parts.join(',')}}`
    }
    throw fail(CANONICAL_CODES.NOT_SERIALIZABLE, `不可规范化的类型：${t}`)
  }
  return walk(value, 1)
}

/** 规范化后的 UTF-8 字节。签名吃的就是这个，不是字符串。 */
export function canonicalBytes(value) {
  return Buffer.from(canonicalJson(value), 'utf8')
}

/** `sha256:<hex>` —— 与 `product/upgrade` 的摘要口径一致。 */
export function digestOf(value) {
  return `sha256:${sha256Hex(canonicalBytes(value))}`
}

/** 裸十六进制 sha256。发行清单里的 `sha256` 字段用的是这个口径。 */
export function sha256Hex(bytes) {
  return createHash('sha256').update(Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8')).digest('hex')
}

/** 设计 §5 要求摘要字段是「64 位十六进制」。 */
export function isSha256Hex(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

/**
 * 固定向量。
 *
 * 设计 §5（line 108）：「现有 canonicalJson 需经过跨发布端/客户端的固定向量
 * 验证后才复用」。发布端（脚本）与客户端（本模块）跑的是同一份代码，
 * 但**发布端将来换成别的语言时**，这一组向量就是那份实现必须逐字节对上的
 * 契约。因此每个向量的 `canonical` 与 `sha256` 都是字面量，不是算出来的。
 */
export const CANONICAL_VECTORS = Object.freeze([
  Object.freeze({
    name: '键序与嵌套',
    value: { b: 1, a: { d: [3, 2, 1], c: null }, '': true },
    canonical: '{"":true,"a":{"c":null,"d":[3,2,1]},"b":1}',
  }),
  Object.freeze({
    name: '数字形态',
    value: { int: 0, neg: -1, dec: 1.5, small: 1e-7, big: 123456789 },
    canonical: '{"big":123456789,"dec":1.5,"int":0,"neg":-1,"small":1e-7}',
  }),
  Object.freeze({
    name: '字符串转义',
    value: { s: 'a"b\\c\nd\te\u0001f', u: '中文🙂' },
    canonical: '{"s":"a\\"b\\\\c\\nd\\te\\u0001f","u":"中文🙂"}',
  }),
  Object.freeze({
    name: 'envelope 形状',
    value: {
      payload: {
        format: 'legion/update-feed@1', channel: 'stable', platform: 'win32', arch: 'x64',
        sequence: 42, issuedAt: '2026-10-02T00:00:00Z', expiresAt: '2026-10-09T00:00:00Z',
        releaseId: 'example-release-id', productVersion: '1.2.0',
        manifestPath: 'releases/example-release-id/manifest.json',
        manifestSha256: '0'.repeat(64),
      },
      keyId: 'release-2026-a',
      signature: 'AA==',
    },
    canonical: '{"keyId":"release-2026-a","payload":{"arch":"x64","channel":"stable","expiresAt":"2026-10-09T00:00:00Z",'
      + '"format":"legion/update-feed@1","issuedAt":"2026-10-02T00:00:00Z","manifestPath":"releases/example-release-id/manifest.json",'
      + `"manifestSha256":"${'0'.repeat(64)}","platform":"win32","productVersion":"1.2.0","releaseId":"example-release-id","sequence":42},`
      + '"signature":"AA=="}',
  }),
])

/**
 * 装载期自检：固定向量逐条对齐，且扫描器对每条"必须拒绝"的输入都真的拒绝。
 *
 * 这些判据在**装载时**算，是为了让"有人放宽了某条拒绝"在下一次启动就暴露，
 * 而不是在某一次真实更新的验签里。
 */
export function selfCheckCanonical() {
  const problems = []

  for (const vector of CANONICAL_VECTORS) {
    let got
    try { got = canonicalJson(vector.value) } catch (e) { problems.push(`向量「${vector.name}」规范化抛错：${e.message}`); continue }
    if (got !== vector.canonical) problems.push(`向量「${vector.name}」字节不一致：期望 ${vector.canonical}，实际 ${got}`)
    // 往返：规范化之后的字节必须能被严格扫描器读回同一个值。
    try {
      const round = parseJsonStrict(got)
      if (canonicalJson(round) !== got) problems.push(`向量「${vector.name}」往返不稳定`)
    } catch (e) { problems.push(`向量「${vector.name}」无法被严格扫描器读回：${e.message}`) }
  }

  const mustReject = [
    ['重复键', '{"a":1,"a":2}', CANONICAL_CODES.DUPLICATE_KEY],
    ['转义重复键', '{"a":1,"\\u0061":2}', CANONICAL_CODES.DUPLICATE_KEY],
    ['指数溢出', '{"a":1e999}', CANONICAL_CODES.BAD_NUMBER],
    ['前导零', '{"a":01}', CANONICAL_CODES.BAD_NUMBER],
    ['负零', '{"a":-0}', CANONICAL_CODES.BAD_NUMBER],
    ['不安全整数', '{"a":9007199254740993}', CANONICAL_CODES.BAD_NUMBER],
    ['尾随内容', '{"a":1} x', CANONICAL_CODES.TRAILING],
    ['孤立代理项', '{"a":"\\ud800"}', CANONICAL_CODES.UNPAIRED_SURROGATE],
    ['NaN 字面量', '{"a":NaN}', CANONICAL_CODES.MALFORMED],
    ['单引号', "{'a':1}", CANONICAL_CODES.MALFORMED],
  ]
  for (const [name, text, code] of mustReject) {
    let thrown = null
    try { parseJsonStrict(text) } catch (e) { thrown = e }
    if (thrown === null) problems.push(`「${name}」被接受了：${text}`)
    else if (thrown.code !== code) problems.push(`「${name}」拒绝码是 ${thrown.code}，期望 ${code}`)
  }

  // 深度上限：刚好超过就拒。
  let deep = '0'
  for (let i = 0; i < 40; i += 1) deep = `[${deep}]`
  let depthRejected = false
  try { parseJsonStrict(deep, { maxDepth: 8 }) } catch (e) { depthRejected = e.code === CANONICAL_CODES.TOO_DEEP }
  if (!depthRejected) problems.push('超深嵌套没有被拒绝')

  // 体积上限。
  let sizeRejected = false
  try { parseJsonStrict(`"${'x'.repeat(100)}"`, { maxBytes: 16 }) } catch (e) { sizeRejected = e.code === CANONICAL_CODES.TOO_LARGE }
  if (!sizeRejected) problems.push('超限体积没有被拒绝')

  // canonicalJson 不能对不可序列化的值静默产出。
  let silent = false
  try { canonicalJson({ a: Number.NaN }) } catch { silent = true }
  if (!silent) problems.push('canonicalJson 对 NaN 静默产出了字节')

  // ★ `__proto__` 必须是**普通自有键**：既不能污染原型，也不能被静默丢掉。
  //   丢掉它会让"签名的 payload"和"验签后重算的 payload"不同——同一串字节
  //   于是能验过两份不同的清单。
  const polluted = parseJsonStrict('{"__proto__":{"polluted":true},"b":1}')
  if (Object.hasOwn(polluted, '__proto__') !== true) problems.push('`__proto__` 键被静默丢弃')
  else if (polluted.__proto__?.polluted !== true) problems.push('`__proto__` 键的值不是被解析出来的那个')
  if (({}).polluted !== undefined) problems.push('解析 `__proto__` 污染了 Object.prototype')
  if (canonicalJson(polluted) !== '{"__proto__":{"polluted":true},"b":1}') {
    problems.push('`__proto__` 参与规范化之后字节不对')
  }

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    vectorCount: CANONICAL_VECTORS.length,
    rejectedCount: mustReject.length,
  })
}

/** 装载时算一次。`problems` 非空即本模块自己的判据不自洽。 */
export const CANONICAL_CHECKED = selfCheckCanonical()
