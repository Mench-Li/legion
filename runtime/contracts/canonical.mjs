// runtime/contracts/canonical.mjs
// ============================================================================
// Canonical JSON 与 domain-separated 哈希的**共享基础库**（PRT-401 / PRT-413）
//
// spec §6.5 最后一段要求：
//
//   「快照使用统一 canonical JSON 规则序列化后计算哈希，规则与审批哈希
//     **共享基础库**，但两者使用**不同的 Schema 和 domain separator**，
//     防止跨对象复用哈希。」
//
// 这个文件就是那句"共享基础库"。在此之前 `runtime/dsh-composition/enforcement.mjs`
// 里有一份**自己的** canonicalJson 实现（审批哈希用）。两份实现今天行为一致，
// 而这种一致性没有任何东西在维持它——只要有人改了其中一份的键排序或 -0 处理，
// 两个子系统就会对"同样的内容"给出不同的哈希，而**两边各自的用例都还是绿的**。
//
// 所以这里做的是**提取**，不是重写：把原来那份实现搬过来，让审批与快照都从这里取。
//
// ## domain separator 为什么是哈希的一部分，而不是注释
//
// 审批哈希与快照哈希可能对**结构相同**的两个对象取值。如果两者只算
// `sha256(canonicalJson(value))`，那么一个"工具调用参数"对象与一个"上下文来源"
// 对象只要字段恰好相同，就会得到**同一个哈希**。于是任何"这个哈希我见过/批准过"
// 的判断都可以跨用途复用——一个为读取某个文件签发的批准，可以冒充一次上下文快照。
//
// 把 domain + schemaVersion 拼进被哈希的字节里，让两个用途的哈希**在构造上**不可互换，
// 而不是靠"它们大概不会一样"。
//
// 注意拼的是 `domain \u0000 schemaVersion \u0000 json`：用 NUL 分隔，
// 因为 NUL 不可能出现在这三个部分各自的正常取值里，于是
// `("a\u0000b", "c")` 与 `("a", "b\u0000c")` 无法拼出同一串。
// 用空格或冒号就会留下这种拼接歧义。
// ============================================================================

import { createHash } from 'node:crypto'

/**
 * 规范化一个字符串：Unicode NFC。
 *
 * 不做 NFC 会让「看起来一样」的两个标识串得到不同哈希
 * （组合字符 vs 预组合字符），表现为「明明批准了却对不上」。
 */
export function nfc(value) {
  return String(value).normalize('NFC')
}

/** 数字与空值的表达：只保留一个规范的数值形式，避免 -0 / 1.0 / 1e0 三种写法。 */
export function canonicalScalar(value) {
  if (value === null) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`canonical JSON 不接受非有限数值：${value}`)
    if (Object.is(value, -0)) return 0 // -0 与 0 是同一个值
    return value
  }
  if (typeof value === 'string') return nfc(value)
  if (typeof value === 'boolean') return value
  return undefined
}

/**
 * 确定性 JSON 序列化：键**排序**、数组保序、只接受可无损表达的值。
 *
 * 键排序而不是依赖插入顺序：`{a,b}` 与 `{b,a}` 是同一个对象，
 * 但在 JSON 文本里不同。依赖插入顺序会让哈希取决于恰好怎么写出来的。
 * 数组**保序**：`[1,2]` 与 `[2,1]` 是不同的顺序。
 */
export function canonicalJson(value, path = '$') {
  const scalar = canonicalScalar(value)
  if (scalar !== undefined) return JSON.stringify(scalar)
  if (Array.isArray(value)) {
    return `[${value.map((v, i) => canonicalJson(v, `${path}[${i}]`)).join(',')}]`
  }
  if (typeof value === 'object') {
    // undefined 值的键**直接省略**（与 JSON.stringify 一致），
    // 否则 `{a:undefined}` 与 `{}` 会哈希不同，而它们在 JSON 语义下相同。
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).map(nfc).sort()
    const body = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k], `${path}.${k}`)}`)
    return `{${body.join(',')}}`
  }
  throw new Error(`canonical JSON 无法表达 ${path} 上的值（类型 ${typeof value}）`)
}

/** 计算 canonical 文本的明文（不加 domain）。仅供测试与诊断，**不用于跨用途比较**。 */
export function canonicalDigestOf(value) {
  return canonicalJson(value)
}

/**
 * domain-separated 哈希：`sha256(domain \u0000 schemaVersion \u0000 canonicalJson(value))`。
 *
 * @param {string} domain  用途标识，例如 `legion.tool-execution.v1`
 * @param {number} schemaVersion 该用途的对象 schema 版本
 * @param {unknown} value  要被哈希的对象
 * @returns {string} `sha256:<hex>`
 */
export function domainSeparatedHash(domain, schemaVersion, value) {
  if (typeof domain !== 'string' || domain === '') throw new Error('domain 必须是非空字符串')
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) throw new Error('schemaVersion 必须是 >= 1 的整数')
  if (domain.includes('\u0000')) throw new Error('domain 不得包含 NUL')
  const payload = `${nfc(domain)}\u0000${schemaVersion}\u0000${canonicalJson(value)}`
  return `sha256:${createHash('sha256').update(payload, 'utf8').digest('hex')}`
}
