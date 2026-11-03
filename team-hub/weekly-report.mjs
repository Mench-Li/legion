// team-hub/weekly-report.mjs
// ============================================================================
// F5 · 周报六个数（设计稿 §3 F5 观测 / M6-4）
//
// 一张周报的价值不在"数很多"，而在**每一格都答得出为什么**。所以这里只出六个，
// 每个都能追到一张表：
//   accepted / stopped / ignored / unavailable  ← decisions.kind
//   wouldAccept                                 ← decisions.would_accept=1（"本来能做"）
//   mandateMissingRatio                         ← 在途任务里没有授权记录的比例（必须趋 0）
//
// ★ 只读：本模块不写任何表。周报不该有副作用——否则"看一次数据"会改一次数据。
// ============================================================================

export const WEEKLY_METRICS = Object.freeze([
  'accepted', 'stopped', 'ignored', 'unavailable', 'wouldAccept', 'mandateMissingRatio',
])

/** P0 失败的定义：被闸门拦下的（stop）与依赖不可用的（unavailable）。 */
const P0_KINDS = Object.freeze(['stop', 'unavailable'])

/** 算在途任务的状态（有授权要求的那些）。 */
const IN_FLIGHT = Object.freeze(['todo', 'in_progress', 'in_review', 'blocked'])

/**
 * 生成周报。
 *
 * @param db
 * @param opts.since 起始时间（ISO）；null 表示不限
 * @param opts.now   当前时间（ISO），用于窗口右界
 */
export function weeklyReport(db, { since = null, now = null } = {}) {
  const window = []
  const params = []
  if (since) { window.push('at >= ?'); params.push(String(since)) }
  if (now) { window.push('at <= ?'); params.push(String(now)) }
  const where = window.length > 0 ? ` WHERE ${window.join(' AND ')}` : ''

  const counts = { accept: 0, stop: 0, ignore: 0, unavailable: 0 }
  for (const row of db.prepare(`SELECT kind, COUNT(*) AS c FROM decisions${where} GROUP BY kind`).all(...params)) {
    if (counts[row.kind] !== undefined) counts[row.kind] = Number(row.c)
  }

  const wouldParams = [...params]
  const wouldRow = db.prepare(`SELECT COUNT(*) AS c FROM decisions${where.length > 0 ? `${where} AND` : ' WHERE'} would_accept = 1`)
    .get(...wouldParams)

  const placeholders = IN_FLIGHT.map(() => '?').join(',')
  const inFlight = db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE status IN (${placeholders})`).get(...IN_FLIGHT)
  const missing = db.prepare(`SELECT COUNT(*) AS c FROM tasks
    WHERE status IN (${placeholders}) AND (mandate IS NULL OR mandate = 'null' OR mandate = '')`).get(...IN_FLIGHT)

  const inFlightTasks = Number(inFlight?.c ?? 0)
  const mandateMissing = Number(missing?.c ?? 0)

  let events = 0
  let eventBacklog = 0
  try {
    events = Number(db.prepare('SELECT COUNT(*) AS c FROM audit WHERE event_id IS NOT NULL').get()?.c ?? 0)
    const cursor = Number(db.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM event_cursor').get()?.s ?? 0)
    const lastEvent = Number(db.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM audit WHERE event_id IS NOT NULL').get()?.s ?? 0)
    eventBacklog = Math.max(0, lastEvent - cursor)
  } catch { /* 事件表还没建：积压按 0 记 */ }

  // I-9.3：P0 失败**必须**有 active 回归用例才算闭环。
  // 口径：一条 P0 决策的 subject 任务，若没有任何 active 用例把它记成 source_task，就算没闭环。
  // 只统计、不替人补用例——补用例要人判断（I-9.1）。
  const closure = (() => {
    try {
      const rows = db.prepare(`SELECT DISTINCT subject FROM decisions
        ${where.length > 0 ? `${where} AND` : ' WHERE'} kind IN ('stop','unavailable')`).all(...params)
      const covered = new Set(
        db.prepare("SELECT source_task FROM regression_cases WHERE state='active' AND source_task IS NOT NULL")
          .all().map((r) => String(r.source_task)),
      )
      const taskIds = rows.map((r) => String(r.subject ?? '').replace(/^task:/, '')).filter((id) => id !== '')
      const uncovered = taskIds.filter((id) => !covered.has(id))
      return {
        p0Total: taskIds.length,
        uncovered: uncovered.length,
        uncoveredTasks: uncovered.slice(0, 20),
        ok: uncovered.length === 0,
      }
    } catch {
      // 还没有回归表（阶段一单独部署）：不把这个当成"闭环失败"
      return { p0Total: 0, uncovered: 0, uncoveredTasks: [], ok: true }
    }
  })()

  return {
    since: since ?? null,
    now: now ?? null,
    metrics: {
      accepted: counts.accept,
      stopped: counts.stop,
      ignored: counts.ignore,
      unavailable: counts.unavailable,
      wouldAccept: Number(wouldRow?.c ?? 0),
      mandateMissingRatio: inFlightTasks === 0 ? 0 : Number((mandateMissing / inFlightTasks).toFixed(4)),
    },
    // 支撑数（不占"六个数"的名额，但要能自证）
    support: { inFlightTasks, mandateMissing, events, eventBacklog, closure },
  }
}
