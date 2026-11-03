#!/usr/bin/env node
// team-hub/scripts/merge-open-questions.mjs
// ============================================================================
// F2 · M3-0：把「同一任务多个未答问题」归并掉，再建部分唯一索引（设计稿 §3 F2 / DEC-4）。
//
//   node team-hub/scripts/merge-open-questions.mjs --dry-run   # 只报数，不动数据
//   node team-hub/scripts/merge-open-questions.mjs             # 归并 + 建索引
//
// 顺序不能反：
//   ① 查重（同一 task_id 多条 status='open'）
//   ② 归并：**保留最新一条**，其余置 `superseded`，并写一条 `question_merge` 审计
//   ③ 建索引：`UNIQUE(task_id) WHERE status='open'` —— 从此「一个任务一个未答问题」由 DB 保证
//
// ★ 只改状态，不删行：被归并的问题仍可查（"我问过什么"必须可证明）。
// ★ 审计条目通过可选回调传出；CLI 侧打印出来，留作证据。
// ============================================================================
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

/** 建部分唯一索引（SQLite 支持 `WHERE` 的 partial index）。已存在则无副作用。 */
export function ensureOpenQuestionIndex(db) {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_question_open
      ON agent_questions(task_id) WHERE status = 'open'
  `)
}

/**
 * 归并同一任务的多个未答问题。
 *
 * @param db
 * @param {{ dryRun?: boolean, audit?: (entry: object) => void }} [options]
 * @returns {{ dryRun: boolean, tasks: number, planned: number, merged: number, kept: Array<{taskId: string, id: string}> }}
 */
export function mergeOpenQuestions(db, { dryRun = false, audit = null } = {}) {
  const groups = db.prepare(`
    SELECT task_id, COUNT(*) AS c FROM agent_questions
     WHERE status = 'open' GROUP BY task_id HAVING c > 1
     ORDER BY task_id
  `).all()

  const report = { dryRun, tasks: groups.length, planned: 0, merged: 0, kept: [] }

  for (const group of groups) {
    const rows = db.prepare(
      "SELECT id FROM agent_questions WHERE task_id=? AND status='open' ORDER BY rowid DESC",
    ).all(group.task_id)
    const [newest, ...older] = rows
    report.planned += older.length
    report.kept.push({ taskId: group.task_id, id: newest.id })
    if (dryRun) continue

    const supersede = db.prepare("UPDATE agent_questions SET status='superseded' WHERE id=?")
    for (const row of older) supersede.run(row.id)
    report.merged += older.length
    if (typeof audit === 'function') {
      audit({
        kind: 'question_merge',
        taskId: group.task_id,
        kept: newest.id,
        superseded: older.map((r) => r.id),
      })
    }
  }

  return report
}

// ── CLI ────────────────────────────────────────────────────────────────────
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('merge-open-questions.mjs')
if (invokedDirectly) {
  const dbFile = process.env.TEAM_HUB_DB ?? join(process.cwd(), 'team.db')
  const dryRun = process.argv.includes('--dry-run')
  const db = new DatabaseSync(dbFile)
  try {
    const audits = []
    const report = mergeOpenQuestions(db, { dryRun, audit: (entry) => audits.push(entry) })
    if (!dryRun) ensureOpenQuestionIndex(db)
    process.stdout.write(JSON.stringify({ db: dbFile, ...report, audits }, null, 2) + '\n')
  } catch (error) {
    process.stderr.write(`merge-open-questions 失败：${error?.message ?? error}\n`)
    process.exitCode = 1
  } finally {
    try { db.close() } catch { /* 已关闭 */ }
  }
}
