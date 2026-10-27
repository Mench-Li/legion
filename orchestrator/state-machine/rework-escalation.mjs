// orchestrator/state-machine/rework-escalation.mjs
// ============================================================================
// 返工**连续同因**升级（2026-10-27 决策 #1，方案 B）。
//
// ## 为什么不是"轮数上限"
//
// 2026-10 移除 `maxReworkRounds` 的理由仍然成立：数值上限会把**没修完的必改项**
// 晾在 `in_review`（`team-hub/server.mjs` 的注释原文：a numeric cap used to
// strand the workflow in `in_review` without fixing them）。
//
// 所以这次要治的不是"轮数多"，而是**同一件事反复修不好**：
//
//   > 一个"修了 5 轮、每轮都推进一点"的工作流，
//   > 与一个"修了 3 轮、同一个问题原样还在"的工作流，
//   > 在轮数上是前者多、在需要人介入上是后者急。
//
// ## 判据
//
// 给每条 finding 算一个**指纹**（kind + file + 归一化 summary），然后从最近一轮
// 往回数：**连续多少轮都还能看到同一指纹**。达到阈值 ⇒ 升级给人，不再自动返工。
//
// `evidence` 刻意**不进**指纹：它每轮都会变（不同的行号、不同的日志片段），
// 一旦进指纹就永远不会连续，这个判据会静默失效——而失效的表现是
// "看起来有保护，其实每次都放过"。
//
// ## 归一化到什么程度
//
// 只做空白折叠 + 大小写统一。**不做语义相似度**：那需要模型，而一个
// "大部分时候能猜对"的判据在这个位置比没有更糟——它会让人以为自己在看
// 一个可靠的收敛点。
// ============================================================================

/** 升级原因码（写进评论与审计，让"为什么停下来"可查）。 */
export const ESCALATION_CODES = Object.freeze({
  /** 同一 finding 连续 N 轮仍在。 */
  REPEATED_FINDING: 'AGENT_WORKFLOW_REWORK_REPEATED',
})

/** 默认阈值：同一指纹连续 3 轮仍在时升级。可用 `LEGION_REWORK_ESCALATE_AFTER` 覆盖。 */
export const DEFAULT_ESCALATE_AFTER = 3

/**
 * 一条 finding 的稳定指纹。
 *
 * @param {{kind?: unknown, file?: unknown, summary?: unknown, evidence?: unknown}} finding
 * @returns {string} `kind|file|summary`；无法识别的部分留空而不是编一个值
 */
export function findingFingerprint(finding) {
  const kind = typeof finding?.kind === 'string' ? finding.kind.trim() : ''
  const file = typeof finding?.file === 'string'
    ? finding.file.trim().split(String.fromCharCode(92)).join('/')
    : ''
  const summary = typeof finding?.summary === 'string'
    ? finding.summary.trim().replace(/\s+/g, ' ').toLowerCase()
    : ''
  return `${kind}|${file}|${summary}`
}

/** 一组 finding 里出现过的全部指纹（去重）。 */
export function fingerprintsOf(findings) {
  const list = Array.isArray(findings) ? findings : []
  return [...new Set(list.map(findingFingerprint).filter((value) => value !== '||'))]
}

/**
 * 连续重复的判定。
 *
 * @param {object} input
 * @param {Array} input.currentFindings 本轮 findings
 * @param {Array<{round: number, findings: Array}>} input.priorReviews **同一实例**的历史审查
 *        （顺序不敏感，内部按 `round` 倒序）
 * @param {number} [input.limit] 连续多少轮算"反复修不好"（含本轮）
 * @returns {{escalate: boolean, streak: number, limit: number, repeated: Array<{fingerprint: string, rounds: number[]}>}}
 */
export function escalateVerdict({ currentFindings, priorReviews, limit = DEFAULT_ESCALATE_AFTER } = {}) {
  const threshold = Number.isSafeInteger(limit) && limit >= 2 ? limit : DEFAULT_ESCALATE_AFTER
  const current = fingerprintsOf(currentFindings)
  const history = (Array.isArray(priorReviews) ? priorReviews : [])
    .filter((item) => item !== null && typeof item === 'object')
    .map((item) => ({
      round: Number(item.round),
      prints: fingerprintsOf(item.findings),
    }))
    .sort((a, b) => b.round - a.round)

  // streak 从 1 起算：本轮本身已经是一次"还在"。
  let streak = 1
  const matchedRounds = [Number.NaN]
  for (const review of history) {
    // ★ 只要有**任意一条**当前指纹在这一轮出现过，就算"还在"。
    //   要的是"这个问题没被解决"，不是"这一轮只出现了这一个问题"。
    const still = current.some((print) => review.prints.includes(print))
    if (!still) break
    streak += 1
    matchedRounds.push(review.round)
  }

  if (streak < threshold) {
    return { escalate: false, streak, limit: threshold, repeated: [] }
  }

  // 只报**连着出现的那些**指纹（以及它们各自出现在哪几轮），供评论写清楚。
  const repeated = current
    .map((print) => ({ fingerprint: print, rounds: matchedRounds.filter((round) => Number.isFinite(round)) }))
    .filter((item) => {
      // 每条指纹单独再数一遍：它必须自己也在那些轮里出现。
      const rounds = history.slice(0, streak - 1)
      return rounds.every((review) => review.prints.includes(item.fingerprint))
    })
  return { escalate: true, streak, limit: threshold, repeated }
}

/** 把 `kind/file/summary` 指纹还原成人能读的一行（评论用）。 */
export function describeFingerprint(fingerprint) {
  const [kind, file, summary] = String(fingerprint).split('|')
  const kindText = kind === 'design' ? '设计' : kind === 'implementation' ? '实现' : (kind || '未分类')
  return `[${kindText}]${file ? ` ${file}` : ''}${summary ? ` — ${summary}` : ''}`
}

/** 阈值来源：显式参数 > 环境变量 > 默认。环境变量非法时回落默认（不静默变成"永不升级"）。 */
export function escalateAfterFromEnv(env = {}) {
  const raw = env?.LEGION_REWORK_ESCALATE_AFTER
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_ESCALATE_AFTER
  const parsed = Number.parseInt(String(raw), 10)
  return Number.isSafeInteger(parsed) && parsed >= 2 ? parsed : DEFAULT_ESCALATE_AFTER
}
