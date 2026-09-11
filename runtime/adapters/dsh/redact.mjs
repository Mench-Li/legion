// runtime/adapters/dsh/redact.mjs
// ============================================================================
// 日志 / 异常 / 事件脱敏（PRT-208）
//
// 脱敏是**结构性**的，不是「把已知密钥值替换掉」。
// 后者依赖「我们知道密钥长什么样」，而真实泄漏往往来自我们没预料到的形态
// （用户把 key 拼进 URL、模型把它回显在输出里、错误消息带上 Authorization 头）。
// 因此这里做两件事：
//
//   ① 按键名脱敏：`token`/`secret`/`password`/`apiKey`/`authorization`/`credential`…
//      不论值长什么样一律替换。这条覆盖「新形态的密钥」——只要它挂在正确的键名下。
//   ② 按值形态脱敏：常见密钥前缀（`sk-`、`ghp_`、`AKIA`…）、`Bearer <x>`、
//      URL 内嵌凭证（`https://user:pass@host`）、以及超长的无空格高熵串。
//
// ## 输出的是「路径」不是「值」
//
// `redacted` 数组里放的是被替换字段的**路径**（如 `headers.authorization`），
// 不是它的值。审计记录「这里发生过脱敏」就够了；把原值写进审计
// 等于把泄漏从日志搬家到审计，问题一点没少。
// ============================================================================

/** 命中即整值替换的键名（大小写不敏感，允许 `_`/`-` 分隔）。 */
export const SENSITIVE_KEY_RE =
  /(^|[_-])(token|secret|password|passwd|pwd|apikey|api[_-]?key|authorization|auth|credential|credentials|cookie|session[_-]?key|private[_-]?key|access[_-]?key)([_-]|$)/i

/** 值形态：常见供应商密钥前缀。 */
export const SECRET_VALUE_PATTERNS = Object.freeze([
  { re: /\bsk-[A-Za-z0-9_-]{12,}\b/g, why: 'OpenAI 风格密钥' },
  { re: /\bghp_[A-Za-z0-9]{20,}\b/g, why: 'GitHub PAT' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, why: 'GitHub 细粒度 PAT' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, why: 'AWS Access Key ID' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, why: 'Slack token' },
  { re: /\bBearer\s+[A-Za-z0-9._~+/-]{10,}=*/gi, why: 'Bearer 凭证' },
  // URL 内嵌凭证：把 user:pass 换成脱敏标记，保留主机名（排查还需要它）
  { re: /([a-z][a-z0-9+.-]*:\/\/)[^/@\s:]+:[^/@\s]+@/gi, why: 'URL 内嵌凭证', replace: '$1[已脱敏]@' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, why: '私钥块' },
])

export const REDACTED = '[已脱敏]'

/** 单个值里替换所有已知密钥形态。 */
export function redactText(text) {
  let out = String(text)
  const hits = []
  for (const p of SECRET_VALUE_PATTERNS) {
    if (!p.re.test(out)) continue
    // 正则带 g 标志，test() 会推进 lastIndex → 重置后再 replace
    p.re.lastIndex = 0
    out = out.replace(p.re, p.replace ?? REDACTED)
    hits.push(p.why)
  }
  return { text: out, hits }
}

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
