#!/usr/bin/env node
/**
 * 迁移脚本：把 v1 文件任务池（legion/scrum/tasks.json）导入 team-hub v2 的 SQLite 任务池。
 *
 * 用法：
 *   node team-hub/scripts/migrate-tasks.mjs [--scope software] [--tasks ../scrum/tasks.json]
 *
 * - 幂等：INSERT OR IGNORE（已存在的 id 跳过，不覆盖 SQLite 中的新数据）。
 * - scope：v1 任务无 scope 字段，默认统一归入 `--scope` 指定的分区（默认 software，与守护 scope 一致）。
 * - 需要与 server.mjs 相同的环境变量（TEAM_HUB_DB / TEAM_HUB_PORT 不参与迁移）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from '../server.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULT_TASKS = join(ROOT, 'scrum', 'tasks.json')

const args = process.argv.slice(2)
function flag(key, fallback) {
  const i = args.indexOf(key)
  return i >= 0 ? args[i + 1] : fallback
}
const scope = flag('--scope', 'software')
const tasksFile = resolve(flag('--tasks', DEFAULT_TASKS))

const now = new Date().toISOString()
const raw = JSON.parse(readFileSync(tasksFile, 'utf8'))
const tasks = raw.tasks ?? {}

const insert = db.prepare(`
  INSERT OR IGNORE INTO tasks (id, title, description, acceptance, priority, status, version, soldier, claimedRound, claimedAt,
    ordersVersion, parent, role, scope, blocks, blockedBy, comments, evidence, patches, ttlMinutes, expiresAt, claimRequestId,
    createdAt, updatedAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
`)

let imported = 0
let skipped = 0
for (const t of Object.values(tasks)) {
  const info = insert.run(
    t.id,
    t.title,
    t.description ?? '',
    JSON.stringify(t.acceptance ?? []),
    t.priority ?? 'medium',
    t.status ?? 'backlog',
    Number.isInteger(t.version) ? t.version : 1,
    t.soldier ?? null,
    t.claimedRound ?? null,
    t.claimedAt ?? null,
    Number.isInteger(t.ordersVersion) ? t.ordersVersion : 1,
    t.parent ?? null,
    t.role ?? null,
    scope,
    JSON.stringify(t.blocks ?? []),
    JSON.stringify(t.blockedBy ?? []),
    JSON.stringify(t.comments ?? []),
    JSON.stringify(t.evidence ?? []),
    JSON.stringify(t.patches ?? []),
    t.createdAt ?? now,
    t.updatedAt ?? now,
  )
  if (info.changes > 0) imported += 1
  else skipped += 1
}

// 顺带登记将军成员（在线状态由 /api/heartbeat 维护）
db.prepare(`INSERT OR IGNORE INTO members (id, scope, kind, lastSeenAt, online) VALUES (?, ?, 'general', ?, 1)`)
  .run('general', scope, now)

console.log(`migrate-tasks: scope=${scope} file=${tasksFile} imported=${imported} skipped=${skipped} (总 ${Object.keys(tasks).length})`)
