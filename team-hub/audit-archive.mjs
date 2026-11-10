// team-hub/audit-archive.mjs
// ============================================================================
// 审计归档：把"什么都没发生"的历史从热表挪到冷表
//
// 为什么要它（2026-11-09 真实库读数）：audit 136,476 行里 132,198 行是 `release-stale`，
// 其中 84,253 行载荷是 `{"released":[],"quarantined":[]}`。**97% 的审计在记"无事发生"**——
// 真出事时想找"哪几件事被回收了"，得在这堆噪音里翻。
//
// 三件必须同时成立的事（任何一件破了都比噪音更糟）：
//
//   ① **seq 天花板不许被削低**：`audit.seq = MAX(seq)+1`（server.mjs 的 audit()），
//      把最大的那行归档掉，seq 就会回退 ⇒ 游标（sinceSeq）会重放、事件去重会失效。
//      所以归档条件里恒有 `seq < MAX(seq)`，`keepNewest` 再兜一层。
//   ② **可追溯**：挪走的行必须能在 `audit_archive` 里查到（含归档时间与原因），
//      归档不是删除的同义词。
//   ③ **幂等**：重复跑归档 0 行；同一次运行内不重复搬。
//
// ★ 只搬"空载荷"的同 action 行是刻意的：`release-stale` 不盖事件章
//   （不在 EVENT_ACTION_KINDS 里），所以挪它不影响 F5 的 audit↔event 对账。
// ============================================================================

/** 归档表的列与 audit 一致，外加归档元数据。 */
const ARCHIVE_DDL = `
CREATE TABLE IF NOT EXISTS audit_archive (
  seq INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  member TEXT,
  scope TEXT,
  action TEXT NOT NULL,
  taskId TEXT,
  detail TEXT,
  actor_kind TEXT,
  addressed INTEGER,
  human INTEGER,
  event_id TEXT,
  goalId TEXT,
  archived_at TEXT NOT NULL,
  archive_reason TEXT
)`

export function ensureArchiveSchema(db) {
  db.exec(ARCHIVE_DDL)
  db.exec('CREATE INDEX IF NOT EXISTS ix_audit_archive_action ON audit_archive(action, ts)')
}

/**
 * 载荷是否"什么都没发生"。
 *
 * ★ 读不出来时一律返回 `false`（保守）：坏 JSON / null / 缺字段都不当空，
 *   宁可留下噪音，也不能把可能有内容的审计搬走。
 */
export function isEmptyDetail(detail) {
  let value = detail
  if (typeof detail === 'string') {
    try { value = JSON.parse(detail) } catch { return false }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const released = value.released
  const quarantined = value.quarantined
  return Array.isArray(released) && released.length === 0
    && Array.isArray(quarantined) && quarantined.length === 0
}

/**
 * 规划一次归档（**只读**）。
 * @returns {{ candidates: number[], count: number, maxSeq: number, ceiling: number, action: string }}
 */
export function planArchive(db, { action = 'release-stale', before = null, keepNewest = 1 } = {}) {
  const ceilingRow = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM audit').get()
  const maxSeq = Number(ceilingRow?.m ?? 0)
  // 天花板留 keepNewest 行：`seq < maxSeq` 保证 seq 不会回退
  const keep = Math.max(1, Number(keepNewest) || 1)
  const ceiling = maxSeq - keep + 1

  const params = [action, ceiling]
  let sql = `SELECT seq, detail FROM audit WHERE action = ? AND seq < ?`
  if (before !== null && before !== undefined && String(before) !== '') {
    sql += ' AND ts < ?'
    params.push(String(before))
  }
  sql += ' ORDER BY seq'

  const rows = db.prepare(sql).all(...params)
  const candidates = rows.filter((r) => isEmptyDetail(r.detail)).map((r) => Number(r.seq))
  return { candidates, count: candidates.length, maxSeq, ceiling, action }
}

/**
 * 执行归档：一次事务内"搬进冷表 + 从热表删掉"。
 * @returns {{ archived: number, remaining: number, action: string }}
 */
export function applyArchive(db, { action = 'release-stale', before = null, keepNewest = 1, reason = 'empty-payload', limit = Infinity } = {}) {
  const plan = planArchive(db, { action, before, keepNewest })
  // 一次搬太多会长时间独占写锁（hub 正在写审计时会阻塞）⇒ 调用方可分批
  if (Number.isFinite(limit)) plan.candidates = plan.candidates.slice(0, Math.max(0, Number(limit)))
  if (plan.candidates.length === 0) {
    // 没有可搬的行：直接返回当前剩余
    const remaining = Number(db.prepare('SELECT COUNT(*) AS c FROM audit WHERE action=?').get(action)?.c ?? 0)
    return { archived: 0, remaining, action }
  }

  const archivedAt = new Date().toISOString()
  const insert = db.prepare(`INSERT OR IGNORE INTO audit_archive
    (seq, ts, member, scope, action, taskId, detail, actor_kind, addressed, human, event_id, goalId, archived_at, archive_reason)
    SELECT seq, ts, member, scope, action, taskId, detail, actor_kind, addressed, human, event_id, goalId, ?, ?
    FROM audit WHERE seq = ?`)
  const remove = db.prepare('DELETE FROM audit WHERE seq = ?')

  let archived = 0
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const seq of plan.candidates) {
      const result = insert.run(archivedAt, reason, seq)
      if (Number(result?.changes ?? 0) === 0) continue // 已在冷表里（幂等）
      remove.run(seq)
      archived += 1
    }
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* 回滚失败时保持原异常 */ }
    throw error
  }

  const remaining = Number(db.prepare('SELECT COUNT(*) AS c FROM audit WHERE action=?').get(action)?.c ?? 0)
  return { archived, remaining, action }
}
