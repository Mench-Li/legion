// runtime/contracts/redact-patterns.mjs
// ============================================================================
// 密钥脱敏的**共享模式表**（从 `runtime/adapters/dsh/redact.mjs` 提取，PRT-408）
//
// ## 为什么要提取而不是各写一份
//
// 脱敏在 Legion 里有两个消费方，而它们的目的**不同**：
//
//   · 日志 / 异常 / 事件脱敏（PRT-208）—— 别把密钥写进日志；
//   · 上下文脱敏（PRT-408）         —— 别把密钥**发给模型**。
//
// 后者其实更严：发给第三方模型是不可撤回的，而写进本地日志至少还在本机。
// 但两者要认的"什么算密钥"是同一件事：供应商前缀、`Bearer`、URL 内嵌凭证、
// 私钥块、以及挂在敏感键名下的值。
//
// 两份表会漂移，而漂移的那一次就是漏掉一种新密钥形态的那一次。
// 所以这里是**唯一**的一份，两个消费方都从这里取。
//
// 这条与 PRT-413 的 canonical JSON 是同一种做法：**提取共享基础库，
// 而不是重写一份**——重写的那一份不会有人记得同步。
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

/** 脱敏标记。**不含原文任何片段**——标记本身不该成为第二个泄漏点。 */
export const REDACTED = '[已脱敏]'

/**
 * 单个值里替换所有已知密钥形态。
 *
 * 返回 `hits`（命中说明）而**不是**被替换掉的内容：
 * 把原值写进审计等于把泄漏从日志搬家到审计，问题一点没少。
 *
 * @param {unknown} text
 * @returns {{text: string, hits: string[]}}
 */
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
