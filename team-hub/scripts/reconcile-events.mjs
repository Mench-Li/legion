#!/usr/bin/env node
// team-hub/scripts/reconcile-events.mjs
// ============================================================================
// F5 · 对账 CLI（设计稿 §3 F5 / M6-3，验收 A12「差异 0」）
//
//   node team-hub/scripts/reconcile-events.mjs [--scope=default] [--until-seq=N]
//
// 退出码：0 = 差异 0；1 = 有差异（CI/守护据此报警）；2 = 运行失败。
//
// ★ 只读：本脚本**绝不**修改任何状态。它存在的意义是"发现问题"，
//   而不是"把问题抹平"——后者只会让下一次对账看起来一切正常。
// ============================================================================
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

import { ensureEventSchema, reconcileEvents } from '../event-log.mjs'

const argOf = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? null : hit.slice(`--${name}=`.length)
}

const dbFile = process.env.TEAM_HUB_DB ?? join(process.cwd(), 'team.db')
const db = new DatabaseSync(dbFile)
try {
  ensureEventSchema(db)
  const report = reconcileEvents(db, {
    scope: argOf('scope'),
    untilSeq: argOf('until-seq') === null ? null : Number(argOf('until-seq')),
  })
  process.stdout.write(JSON.stringify({
    db: dbFile,
    checked: report.checked,
    mismatched: report.mismatched,
    ok: report.mismatched.length === 0,
    at: new Date().toISOString(),
  }, null, 2) + '\n')
  if (report.mismatched.length > 0) process.exitCode = 1
} catch (error) {
  process.stderr.write(`reconcile-events 失败：${error?.message ?? error}\n`)
  process.exitCode = 2
} finally {
  try { db.close() } catch { /* 已关闭 */ }
}
