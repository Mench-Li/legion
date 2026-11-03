#!/usr/bin/env node
// team-hub/scripts/migrate-task-input.mjs
// ============================================================================
// F0 · A 段迁移 CLI：把历史批注列回填成 `task_input` 行（设计稿 §3 F0 / M1-4）。
//
//   node team-hub/scripts/migrate-task-input.mjs --dry-run   # 只报数，不落库
//   node team-hub/scripts/migrate-task-input.mjs             # 真搬
//
// 库地址：`TEAM_HUB_DB`；缺省用 cwd 下的 `team.db`（与 team-hub 一致）。
// 输出：一行 JSON，字段与 `migrateLegacyNotes()` 的返回一致，便于证据留档。
//
// ★ 不删不改列：迁移只写行；迁移完成后 `GET /api/reconcile/inputs` 必须为 0 差异。
// ============================================================================
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

import { ensureTaskInputSchema, migrateLegacyNotes } from '../task-input.mjs'

const dbFile = process.env.TEAM_HUB_DB ?? join(process.cwd(), 'team.db')
const dryRun = process.argv.includes('--dry-run')

const db = new DatabaseSync(dbFile)
try {
  ensureTaskInputSchema(db)
  const report = migrateLegacyNotes(db, { dryRun })
  process.stdout.write(JSON.stringify({ db: dbFile, ...report }, null, 2) + '\n')
} catch (error) {
  process.stderr.write(`migrate-task-input 失败：${error?.message ?? error}\n`)
  process.exitCode = 1
} finally {
  try { db.close() } catch { /* 已关闭 */ }
}
