// team-hub/regression-store.mjs
// ============================================================================
// F9 · 错误归纳机械化（设计稿 §8.4 / M7）
//
// 失败不该只留在 `docs/bugs/` 的手写记录里。但"全自动把失败变成 CI 用例"也不对：
// 自动晋升的回归集会迅速长出一堆永远红的用例，然后所有人学会忽略它。
//
// 所以这里只做三件事，而且边界很清楚：
//   ① **收集**失败事件（decisions 的 stop/unavailable + audit 的 rework）
//   ② **聚类**成稳定的簇（键 = stage:rule:pathPrefix）
//   ③ 为每个簇生成 **draft** 草稿——`active` 必须由人晋升（I-9.1）
//
// ★ 三条纪律
//   · 聚类键稳定（I-9.2）：同一失败重复出现不会被拆成两个簇
//   · 草稿幂等：同一簇同 id，重复跑不产生第二份
//   · 晋升只认人：`agent:*` / `system` 一律拒绝
// ============================================================================

export const CASE_STATES = Object.freeze(['draft', 'active', 'retired'])
export const CASE_KINDS = Object.freeze(['unit', 'e2e', 'manual'])

export const REGRESSION_ERRORS = Object.freeze({
  HUMAN_REQUIRED: 'REGRESSION_HUMAN_REQUIRED',
  CASE_NOT_FOUND: 'REGRESSION_CASE_NOT_FOUND',
  BAD_STATE: 'REGRESSION_BAD_STATE',
})

export class RegressionError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`)
    this.name = 'RegressionError'
    this.code = code
    this.statusCode = code === REGRESSION_ERRORS.CASE_NOT_FOUND ? 404 : 422
  }
}

/** 建表（幂等）。 */
export function ensureRegressionSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS regression_cases (
      id TEXT PRIMARY KEY,
      cluster_key TEXT NOT NULL,
      source_task TEXT,
      kind TEXT NOT NULL DEFAULT 'unit',
      command TEXT,
      expect TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      promoted_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_reg_state ON regression_cases(state, created_at);
  `)
}

const text = (v) => (typeof v === 'string' ? v.trim() : '')

/** 聚类键：`stage:rule:pathPrefix`。缺失部分落 `unknown`，保证**永远有值**（键要稳定）。 */
export function clusterKeyOf({ stage = null, rule = null, pathPrefix = null } = {}) {
  return `${text(stage) || 'unknown'}:${text(rule) || 'unknown'}:${text(pathPrefix)}`
}

/** 从 detail/reason 里挑一个"看起来是路径"的前缀（没有就空）。 */
function pathPrefixOf(input) {
  const source = text(input)
  const match = source.match(/([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]*)/)
  if (!match) return ''
  const parts = match[1].split('/')
  return parts.length > 1 ? `${parts.slice(0, 2).join('/')}/` : ''
}

/**
 * 收集失败事件。
 * @returns {Array<{kind: string, taskId: string, at: string, reason: string, rule: string|null, stage: string|null, pathPrefix: string}>}
 */
export function collectFailures(db, { since = null, limit = 500 } = {}) {
  const failures = []

  const decisionSql = `SELECT subject, kind, at, reason, matched_rule_ids FROM decisions
    WHERE kind IN ('stop','unavailable')${since ? ' AND at >= ?' : ''} ORDER BY at ASC LIMIT ?`
  const params = since ? [String(since), Number(limit) || 500] : [Number(limit) || 500]
  // 新库/夹具可能还没有某张表：缺表就当"这一类没有失败"，而不是让整个 CLI 崩掉。
  const rowsOf = (sql, values) => { try { return db.prepare(sql).all(...values) } catch { return [] } }

  for (const row of rowsOf(decisionSql, params)) {
    const matches = safeJson(row.matched_rule_ids) ?? []
    failures.push({
      kind: row.kind,
      taskId: String(row.subject ?? '').replace(/^task:/, ''),
      at: row.at,
      reason: text(row.reason),
      rule: matches.length > 0 ? String(matches[0]) : null,
      stage: null,
      pathPrefix: pathPrefixOf(row.reason),
      source: 'decision',
    })
  }

  const auditSql = `SELECT taskId, ts, detail FROM audit
    WHERE action='rework'${since ? ' AND ts >= ?' : ''} ORDER BY ts ASC LIMIT ?`
  for (const row of rowsOf(auditSql, params)) {
    const detail = safeJson(row.detail) ?? {}
    failures.push({
      kind: 'rework',
      taskId: String(row.taskId ?? ''),
      at: row.ts,
      reason: text(detail.reason) || text(row.detail),
      rule: detail.rule ? String(detail.rule) : null,
      stage: detail.stage ? String(detail.stage) : null,
      pathPrefix: pathPrefixOf(detail.reason ?? row.detail),
      source: 'audit',
    })
  }
  return failures
}

/** 给每个失败补上任务角色（stage 的默认来源）。 */
function stageFor(db, taskId) {
  if (!taskId) return 'unknown'
  try {
    const row = db.prepare('SELECT role FROM tasks WHERE id=?').get(taskId)
    return text(row?.role) || 'unknown'
  } catch { return 'unknown' }
}

/**
 * 聚类成"失败簇"，按出现次数降序。
 * @returns {Array<{clusterKey, count, samples, reason, rule, stage, pathPrefix}>}
 */
export function clusterFailures(db, { since = null, limit = 500 } = {}) {
  const failures = collectFailures(db, { since, limit })
  const buckets = new Map()
  for (const failure of failures) {
    const stage = failure.stage ?? stageFor(db, failure.taskId)
    const key = clusterKeyOf({ stage, rule: failure.rule, pathPrefix: failure.pathPrefix })
    const bucket = buckets.get(key) ?? {
      clusterKey: key, count: 0, samples: [], reasons: [], rule: failure.rule, stage, pathPrefix: failure.pathPrefix,
    }
    bucket.count += 1
    if (failure.taskId && !bucket.samples.includes(failure.taskId)) bucket.samples.push(failure.taskId)
    if (failure.reason) bucket.reasons.push(failure.reason)
    buckets.set(key, bucket)
  }
  return [...buckets.values()]
    .map((b) => ({ ...b, reason: b.reasons[0] ?? '' }))
    .sort((a, b) => b.count - a.count || a.clusterKey.localeCompare(b.clusterKey))
}

/** 草稿 id：由聚类键决定 ⇒ 同一簇永远同一份草稿（幂等）。 */
export function caseIdFor(clusterKey) {
  let hash = 0
  const source = String(clusterKey)
  for (let i = 0; i < source.length; i += 1) hash = (hash * 31 + source.charCodeAt(i)) >>> 0
  return `rc-${hash.toString(16).padStart(8, '0')}`
}

/**
 * 由簇生成回归用例**草稿**（永远 `state='draft'`，I-9.1）。
 */
export function draftCaseFor(cluster, { at = null, kind = 'unit' } = {}) {
  const clusterKey = String(cluster?.clusterKey ?? 'unknown:unknown:')
  const source = Array.isArray(cluster?.samples) && cluster.samples.length > 0 ? cluster.samples[0] : null
  const reason = text(cluster?.reason) || '未记录原因'
  const scope = cluster?.pathPrefix ? ` ${cluster.pathPrefix}` : ''
  return {
    id: caseIdFor(clusterKey),
    cluster_key: clusterKey,
    source_task: source,
    kind: CASE_KINDS.includes(kind) ? kind : 'unit',
    command: `node --test team-hub/*.test.mjs  # 复现簇 ${clusterKey}`,
    expect: `簇「${clusterKey}」不再以「${reason.slice(0, 80)}」失败${scope}`,
    state: 'draft',
    created_at: at ?? new Date().toISOString(),
    promoted_by: null,
  }
}

/** 落一份草稿（同 id 幂等：已存在则原样返回，不覆盖已有状态）。 */
export function saveDraft(db, draft) {
  const existing = db.prepare('SELECT * FROM regression_cases WHERE id=?').get(draft.id)
  if (existing) return existing
  db.prepare(`INSERT INTO regression_cases
    (id, cluster_key, source_task, kind, command, expect, state, created_at, promoted_by)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    draft.id, draft.cluster_key, draft.source_task ?? null, draft.kind,
    draft.command ?? null, draft.expect, 'draft', draft.created_at, null,
  )
  return db.prepare('SELECT * FROM regression_cases WHERE id=?').get(draft.id)
}

/** 只读列表。 */
export function listCases(db, { state = null } = {}) {
  return state
    ? db.prepare('SELECT * FROM regression_cases WHERE state=? ORDER BY created_at ASC').all(String(state))
    : db.prepare('SELECT * FROM regression_cases ORDER BY created_at ASC').all()
}

/**
 * 给 CI 的执行计划：**只取 active**（I-9.1），没有命令的用例跳过并如实列出。
 * 返回纯数据，便于先在本地看清楚"CI 会跑什么"，再决定要不要跑。
 */
export function planRun(db, { state = 'active' } = {}) {
  const cases = listCases(db, { state })
  const runnable = []
  const skipped = []
  for (const item of cases) {
    const command = String(item.command ?? '').trim()
    if (command === '') { skipped.push({ id: item.id, reason: 'no-command' }); continue }
    runnable.push({ id: item.id, clusterKey: item.cluster_key, command, expect: item.expect })
  }
  return { planned: runnable, skipped }
}

/**
 * 晋升 draft → active。**只有人能晋升**（I-9.1）。
 * @throws RegressionError HUMAN_REQUIRED / CASE_NOT_FOUND / BAD_STATE
 */
export function promoteCase(db, { id, by, at = null } = {}) {
  const who = text(by)
  const looksHuman = who !== '' && !who.startsWith('agent:') && !['system', 'daemon', 'bot', 'worker'].includes(who.toLowerCase())
  if (!looksHuman) throw new RegressionError(REGRESSION_ERRORS.HUMAN_REQUIRED, `只有人能晋升回归用例（收到 ${JSON.stringify(by)}）`)

  const row = db.prepare('SELECT * FROM regression_cases WHERE id=?').get(String(id))
  if (!row) throw new RegressionError(REGRESSION_ERRORS.CASE_NOT_FOUND, `用例不存在: ${id}`)
  if (row.state !== 'draft') throw new RegressionError(REGRESSION_ERRORS.BAD_STATE, `只有 draft 能晋升（当前 ${row.state}）`)

  db.prepare("UPDATE regression_cases SET state='active', promoted_by=? WHERE id=?").run(who, String(id))
  if (at !== null) db.prepare('UPDATE regression_cases SET created_at=created_at WHERE id=?').run(String(id))
  return db.prepare('SELECT * FROM regression_cases WHERE id=?').get(String(id))
}

function safeJson(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return value
  try { return JSON.parse(String(value)) } catch { return null }
}
