// runtime/adapters/dsh/redact.mjs
// ============================================================================
// 模式表已提取到 `runtime/contracts/redact-patterns.mjs`（PRT-408）。
//
// 上下文脱敏（PRT-408）要认的"什么算密钥"与这里**是同一件事**，只是目的不同：
// 这里是"别写进日志"，那里是"别发给模型"。两份表会漂移，而漂移的那一次
// 就是漏掉一种新密钥形态的那一次——所以只留一份。
//
// 下面这些导出保留原有的名字与形状（`redactText` 等仍从这里出去），
// 于是既有调用方一行都不用改。
// ============================================================================

export { SENSITIVE_KEY_RE, SECRET_VALUE_PATTERNS, REDACTED, redactText } from '../../contracts/redact-patterns.mjs'

import { REDACTED, SENSITIVE_KEY_RE, redactText } from '../../contracts/redact-patterns.mjs'


/**
 * 递归脱敏任意 JSON 可序列化值。
 *
 * 有界：`maxDepth` 与 `maxStringLength` 兜底。事件里出现巨大字符串时
 * 不截断会让审计表膨胀，而审计是热路径。
 *
 * 非 JSON 值（函数/Symbol/循环引用）不参与序列化，替换为诊断标记——
 * 对活对象做递归枚举在这里是明确的错误（本工具只应看到已序列化的叶子数据）。
 */
export function redactValue(input, options = {}) {
  const { maxDepth = 8, maxStringLength = 8000, onUnserializable = '[不可序列化]' } = options
  const redacted = []
  const seen = new WeakSet()
  let truncated = 0

  const walk = (value, path, depth) => {
    if (depth > maxDepth) {
      redacted.push(`${path}（超出最大深度 ${maxDepth}）`)
      return '[超出深度]'
    }
    if (value === null || value === undefined) return value
    const t = typeof value
    if (t === 'string') {
      let s = value
      if (s.length > maxStringLength) {
        s = `${s.slice(0, maxStringLength)}…[已截断 ${value.length - maxStringLength} 字符]`
        truncated += 1
      }
      const { text, hits } = redactText(s)
      if (hits.length > 0) redacted.push(path)
      return text
    }
    if (t === 'number' || t === 'boolean' || t === 'bigint') return value
    if (t === 'function' || t === 'symbol') return onUnserializable
    if (t === 'object') {
      if (seen.has(value)) return '[循环引用]'
      seen.add(value)
      if (Array.isArray(value)) {
        return value.map((v, i) => walk(v, `${path}[${i}]`, depth + 1))
      }
      const out = {}
      for (const [k, v] of Object.entries(value)) {
        if (k === '__proto__' || k === 'constructor') continue
        const childPath = path === '' ? k : `${path}.${k}`
        // ① 按键名脱敏：值是什么都不看一眼
        if (SENSITIVE_KEY_RE.test(k)) {
          redacted.push(childPath)
          out[k] = v === null || v === undefined || v === '' ? v : REDACTED
          continue
        }
        out[k] = walk(v, childPath, depth + 1)
      }
      return out
    }
    return onUnserializable
  }

  const value = walk(input, '', 0)
  return { value, redacted, truncated }
}

/** 安全 JSON 字符串化（脱敏 + 不因循环引用抛错）。 */
export function redactJson(input, options = {}) {
  const r = redactValue(input, options)
  try {
    return { json: JSON.stringify(r.value), redacted: r.redacted }
  } catch (err) {
    return { json: JSON.stringify({ error: 'JSON 序列化失败', detail: String(err?.message ?? err) }), redacted: r.redacted }
  }
}
