#!/usr/bin/env node
// team-hub/scripts/check-baseline.mjs
// ============================================================================
// F11 · 不退化门（设计稿 §8.6 / M12-2，CI 步骤）
//
//   node team-hub/scripts/check-baseline.mjs [--scope=default] [--since=ISO] [--force]
//
// 退出码：0 = 未退化（或无基线时按 --allow-empty 放行）；1 = 退化 ⇒ **阻止合并**；2 = 运行失败。
//
// ★ 门是硬的（I-11.3）：`--force` **不会**让退化通过，它只会让输出里写明
//   "你传了 force，但它被忽略了"。紧急放行必须走单独审批并留痕——那是流程问题，
//   不该靠一个命令行开关解决。
// ============================================================================
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

import { ensureDecisionSchema } from '../decisions.mjs'
import { weeklyReport } from '../weekly-report.mjs'
import { ensureBaselineSchema, checkGate, listBaselines } from '../regression-gate.mjs'

const argOf = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? null : hit.slice(`--${name}=`.length)
}

const dbFile = argOf('db') ?? process.env.TEAM_HUB_DB ?? join(process.cwd(), 'team.db')
const scope = argOf('scope') ?? 'default'
const since = argOf('since')
const force = process.argv.includes('--force')

const db = new DatabaseSync(dbFile)
try {
  ensureDecisionSchema(db)
  ensureBaselineSchema(db)

  const report = weeklyReport(db, { since })
  const metrics = report.metrics
  const gate = checkGate(db, { metrics, scope, force })

  process.stdout.write(JSON.stringify({
    db: dbFile,
    scope,
    since: since ?? null,
    metrics,
    baselines: listBaselines(db, { scope }).map((b) => ({ metric: b.metric, value: b.value, set_by: b.set_by })),
    ok: gate.ok,
    reason: gate.reason,
    violations: gate.violations,
    forcedIgnored: gate.forcedIgnored,
    text: gate.text,
    at: new Date().toISOString(),
  }, null, 2) + '\n')

  // 没有基线时：不通过（"没基线就算过"是最容易出事的一种放行），除非显式 --allow-empty
  if (!gate.ok) process.exitCode = 1
} catch (error) {
  process.stderr.write(`check-baseline 失败：${error?.message ?? error}\n`)
  process.exitCode = 2
} finally {
  try { db.close() } catch { /* 已关闭 */ }
}
