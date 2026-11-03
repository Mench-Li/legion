// team-hub/shadow-report.mjs
// ============================================================================
// F10 · 规则候选影子验证（设计稿 §8.5 / M11，E2）
//
// 改规则之前先问一句：**这条新规则要是早就在，历史决策会怎么变？**
//
// 三条边界（写死在这里，而不是靠调用方自觉）：
//   I-10.1 影子跑**只读**：不产生任务、不写 tasks、不写 decisions
//   I-10.2 差异率 > 阈值 ⇒ `needsReview=true`，禁止自动晋升
//   · 候选规则不存在时**报错**，而不是给一份"零差异"的假报告——后者比报错危险得多
//
// 判定口径（rule kind 驱动，可解释）：
//   `always` 候选：缺依据被拒的决策 ⇒ 翻成 accept
//   `never`  候选：已受理的决策     ⇒ 翻成 stop
//   `when`   候选：没有上下文可判 ⇒ 视为不变（**不许**猜）
// ============================================================================

export const SHADOW_ERRORS = Object.freeze({
  RULE_NOT_FOUND: 'SHADOW_RULE_NOT_FOUND',
  CANDIDATE_REQUIRED: 'SHADOW_CANDIDATE_REQUIRED',
})

export class ShadowError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`)
    this.name = 'ShadowError'
    this.code = code
    this.statusCode = code === SHADOW_ERRORS.RULE_NOT_FOUND ? 404 : 422
  }
}

export const SHADOW_DEFAULT_THRESHOLD = 0.2

/** 建只读视图（幂等）。设计稿明确"不新增表"，这里只补一个方便查询的视图。 */
export function ensureShadowSchema(db) {
  db.exec(`
    CREATE VIEW IF NOT EXISTS decision_history AS
      SELECT subject, kind, would_accept, reason, matched_rule_ids, policy_version, at
        FROM decisions;
  `)
}

const text = (v) => (typeof v === 'string' ? v.trim() : '')
const safeJson = (value) => {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return value
  try { return JSON.parse(String(value)) } catch { return null }
}

/**
 * 生成影子差异报告。**纯读**。
 *
 * @param db
 * @param opts.candidateRuleId 候选规则（必须在 policy_rules 里）
 * @param opts.from / opts.to  时间窗
 * @param opts.threshold       差异率阈值（默认 0.2）
 */
export function shadowReport(db, { candidateRuleId = null, from = null, to = null, threshold = SHADOW_DEFAULT_THRESHOLD } = {}) {
  const id = text(candidateRuleId)
  if (id === '') throw new ShadowError(SHADOW_ERRORS.CANDIDATE_REQUIRED, '缺少 candidateRuleId')

  const rule = db.prepare('SELECT id, kind, text, enabled FROM policy_rules WHERE id=?').get(id)
  if (!rule) throw new ShadowError(SHADOW_ERRORS.RULE_NOT_FOUND, `候选规则不存在: ${id}`)

  const where = []
  const params = []
  if (from) { where.push('at >= ?'); params.push(String(from)) }
  if (to) { where.push('at <= ?'); params.push(String(to)) }
  const sql = `SELECT subject, kind, would_accept, reason, matched_rule_ids, at FROM decisions
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at ASC, rowid ASC`
  const rows = db.prepare(sql).all(...params)

  let same = 0
  let flipToAccept = 0
  let flipToIgnore = 0
  const flips = []

  for (const row of rows) {
    const current = String(row.kind)
    const matches = safeJson(row.matched_rule_ids) ?? []
    const hasBasis = matches.length > 0
    let candidate = current
    let why = ''

    if (String(rule.kind) === 'always' && current === 'stop' && !hasBasis) {
      candidate = 'accept'
      why = `规则 ${id}（always）补上了受理依据`
    } else if (String(rule.kind) === 'never' && current === 'accept') {
      candidate = 'stop'
      why = `规则 ${id}（never）禁止此类受理`
    }

    if (candidate === current) { same += 1; continue }
    if (candidate === 'accept') flipToAccept += 1
    else flipToIgnore += 1
    flips.push({ subject: row.subject, current, candidate, why, at: row.at })
  }

  const n = rows.length
  const flipRate = n === 0 ? 0 : Number(((flipToAccept + flipToIgnore) / n).toFixed(4))
  return {
    candidateRuleId: id,
    candidateKind: String(rule.kind),
    n, same, flipToAccept, flipToIgnore,
    flipRate,
    threshold: Number(threshold),
    // I-10.2：差异太大就别谈自动晋升
    needsReview: flipRate > Number(threshold),
    flips,
  }
}
