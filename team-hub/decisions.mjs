// team-hub/decisions.mjs
// ============================================================================
// F4 · 受理台账（设计稿 §3 F4 / M5）
//
// 要回答的问题：**这个候选为什么没做？**
//   「没做」有四种，混成一种就没人能复盘：
//     accept      受理了（凭什么：matchedRuleIds / manual）
//     stop        闸门没过（哪一条、为什么，必须写清）
//     ignore      本来可以，但这次没进（容量满 / 推断受理未获空间授权）→ would_accept=1
//     unavailable 依赖不可用（上游没就绪、目标不存在 …）
//
// ★ 两条硬要求
//   ① `accept` 必须有依据（I-4.1）：既无 `matchedRuleIds` 又非 `manual` ⇒ 拒收
//   ② **每条评估都要有 reason**：沉默的拒绝等于没拒绝（"为什么没做"必须可读）
// ============================================================================

import { mandateAllows } from './mandate-policy.mjs'

export const DECISION_KINDS = Object.freeze(['accept', 'stop', 'ignore', 'unavailable'])

export const DECISION_ERRORS = Object.freeze({
  UNKNOWN_KIND: 'DECISION_UNKNOWN_KIND',
  MISSING_BASIS: 'MISSING_BASIS',
  MISSING_SUBJECT: 'DECISION_MISSING_SUBJECT',
})

export class DecisionError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`)
    this.name = 'DecisionError'
    this.code = code
    this.statusCode = 422
  }
}

/** 建表（幂等）。 */
export function ensureDecisionSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS policy_rules (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL,
      scope TEXT, enabled INTEGER NOT NULL DEFAULT 1, rule_ref TEXT
    );
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY, subject TEXT NOT NULL,
      thread_id TEXT, trigger_id TEXT,
      kind TEXT NOT NULL, matched_rule_ids TEXT DEFAULT '[]',
      would_accept INTEGER NOT NULL DEFAULT 0,
      reason TEXT, by TEXT NOT NULL, at TEXT NOT NULL,
      policy_version TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dec_kind ON decisions(kind, at);
    CREATE INDEX IF NOT EXISTS idx_dec_subject ON decisions(subject, at);
  `)
}

const nextId = () => `dec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/**
 * 记一条决策。
 * @throws DecisionError UNKNOWN_KIND / MISSING_BASIS / MISSING_SUBJECT
 */
export function recordDecision(db, input = {}) {
  const kind = String(input.kind ?? '')
  if (!DECISION_KINDS.includes(kind)) throw new DecisionError(DECISION_ERRORS.UNKNOWN_KIND, `未知决策类型 ${JSON.stringify(input.kind)}`)
  const subject = String(input.subject ?? '').trim()
  if (subject === '') throw new DecisionError(DECISION_ERRORS.MISSING_SUBJECT, '决策必须指向一个主体（task:<id> / goal:<id>）')

  const matchedRuleIds = Array.isArray(input.matchedRuleIds) ? input.matchedRuleIds.map(String) : []
  // I-4.1：受理必须有依据
  if (kind === 'accept' && matchedRuleIds.length === 0 && input.manual !== true) {
    throw new DecisionError(DECISION_ERRORS.MISSING_BASIS, '受理决策必须有 matchedRuleIds 或 manual')
  }

  const row = {
    id: String(input.id ?? nextId()),
    subject,
    thread_id: input.threadId ?? null,
    trigger_id: input.triggerId ?? null,
    kind,
    matched_rule_ids: JSON.stringify(matchedRuleIds),
    would_accept: input.wouldAccept === true ? 1 : 0,
    reason: String(input.reason ?? ''),
    by: String(input.by ?? 'system'),
    at: String(input.at ?? new Date().toISOString()),
    policy_version: String(input.policyVersion ?? 'legion/policy@1'),
  }
  db.prepare(`INSERT INTO decisions
    (id, subject, thread_id, trigger_id, kind, matched_rule_ids, would_accept, reason, by, at, policy_version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(row.id, row.subject, row.thread_id, row.trigger_id, row.kind, row.matched_rule_ids,
      row.would_accept, row.reason, row.by, row.at, row.policy_version)
  return row
}

/** 只读列表（带过滤）。 */
export function listDecisions(db, { kind = null, wouldAccept = null, subject = null, from = null, to = null, limit = 200, offset = 0 } = {}) {
  const where = []
  const params = []
  if (kind) { where.push('kind = ?'); params.push(String(kind)) }
  if (wouldAccept !== null && wouldAccept !== undefined) { where.push('would_accept = ?'); params.push(wouldAccept ? 1 : 0) }
  if (subject) { where.push('subject = ?'); params.push(String(subject)) }
  if (from) { where.push('at >= ?'); params.push(String(from)) }
  if (to) { where.push('at <= ?'); params.push(String(to)) }
  const sql = `SELECT * FROM decisions${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY at ASC, rowid ASC LIMIT ? OFFSET ?`
  return db.prepare(sql).all(...params, Math.max(1, Number(limit) || 200), Math.max(0, Number(offset) || 0))
}

/**
 * 纯函数：给一个候选算出决策（不落库，便于 dry-run 与单测）。
 *
 * @param input.mandate  任务的授权记录（可为 null）
 * @param input.ctx      { paths, acceptMode }
 * @param input.hasRoom  当前还有没有并发容量
 * @returns {{ kind: string, wouldAccept: boolean, reason: string, code: string|null, matchedRuleIds: string[] }}
 */
export function decideForCandidate({ mandate = null, ctx = {}, hasRoom = true } = {}) {
  const verdict = mandateAllows(mandate, { paths: ctx?.paths ?? [], acceptMode: ctx?.acceptMode ?? 'manual' })
  const matchedRuleIds = Array.isArray(mandate?.basisRuleIds) ? mandate.basisRuleIds : []

  if (verdict.ok !== true) {
    // I-4.5：推断受理但空间不允许 ⇒ 不是拒绝，是"本来可以"
    if (verdict.wouldAcceptOnly === true) {
      return {
        kind: 'ignore', wouldAccept: true, code: verdict.code,
        reason: `推断受理但空间受理模式为 ${ctx?.acceptMode ?? 'manual'}，只记 would_accept 不入队`,
        matchedRuleIds,
      }
    }
    return {
      kind: 'stop', wouldAccept: false, code: verdict.code,
      reason: `准入未通过（${verdict.failedGate}）：${verdict.userText}`,
      matchedRuleIds,
    }
  }

  if (hasRoom !== true) {
    return {
      kind: 'ignore', wouldAccept: true, code: null,
      reason: '准入通过，但并发容量已满（本轮不派工）',
      matchedRuleIds,
    }
  }

  return {
    kind: 'accept', wouldAccept: false, code: null,
    reason: matchedRuleIds.length > 0 ? `命中规则 ${matchedRuleIds.join('、')}` : '人工受理',
    matchedRuleIds,
  }
}
