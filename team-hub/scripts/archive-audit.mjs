#!/usr/bin/env node
// team-hub/scripts/archive-audit.mjs
// ============================================================================
// 把"什么都没发生"的审计挪进冷表（`audit_archive`），默认**只演练不落地**。
//
//   node team-hub/scripts/archive-audit.mjs                       # 干跑：只报数
//   node team-hub/scripts/archive-audit.mjs --apply               # 真归档
//   node team-hub/scripts/archive-audit.mjs --action=release-stale --before=2026-11-10
//   node team-hub/scripts/archive-audit.mjs --apply --action=release-stale
//
// 安全线（都写在 audit-archive.mjs 的判据里）：
//   · 只搬**空载荷**的同 action 行（`{"released":[],"quarantined":[]}` 这种）
//   · 永远不动当前最大 seq 那一行 ⇒ `audit.seq = MAX(seq)+1` 不会回退，游标不重放
//   · 搬进 `audit_archive` 而不是删除，带 archived_at 与原因
//   · 幂等：重复跑归档 0 行
// ============================================================================
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'

import { ensureArchiveSchema, planArchive, applyArchive } from '../audit-archive.mjs'

const DB_FILE = process.env.TEAM_HUB_DB || new URL('../team.db', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const args = process.argv.slice(2)
const flag = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}
const apply = args.includes('--apply')
const action = flag('action') ?? 'release-stale'
const before = flag('before')
const keepNewest = Number(flag('keep-newest') ?? '1')

if (!existsSync(DB_FILE)) {
  process.stdout.write(`找不到库文件：${DB_FILE}\n（用 TEAM_HUB_DB 指定，或从 team-hub/ 目录运行）\n`)
  process.exit(2)
}

// ★ 只读打开做规划；只有 --apply 才用可写连接——干跑绝不可能改动你的库。
const db = new DatabaseSync(DB_FILE, { readOnly: !apply })
try {
  // 干跑用只读连接：建表会被拒；归档表还没建时跳过（规划只读 audit）
  try { ensureArchiveSchema(db) } catch (error) { if (apply) throw error }
  const plan = planArchive(db, { action, before, keepNewest })
  const total = Number(db.prepare('SELECT COUNT(*) c FROM audit').get().c)
  const ofAction = Number(db.prepare('SELECT COUNT(*) c FROM audit WHERE action=?').get(action).c)

  process.stdout.write(`库文件      : ${DB_FILE}\n`)
  process.stdout.write(`审计总行数  : ${total}\n`)
  process.stdout.write(`“${action}” 行数: ${ofAction}\n`)
  process.stdout.write(`可归档空载荷: ${plan.count}（seq 上限 ${plan.ceiling}，当前最大 ${plan.maxSeq}）\n`)

  if (!apply) {
    process.stdout.write('\n这是干跑。加 --apply 才会真的搬。\n')
  } else {
    // 分批搬：每批一个短事务，避免长时间独占写锁把正在跑的 hub 挡住
    const batch = Math.max(1, Number(flag('batch') ?? '5000'))
    let archived = 0
    let remaining = Number(db.prepare('SELECT COUNT(*) AS c FROM audit WHERE action=?').get(action)?.c ?? 0)
    for (;;) {
      const out = applyArchive(db, { action, before, keepNewest, limit: batch })
      archived += out.archived
      remaining = out.remaining
      if (out.archived === 0) break
      process.stdout.write(`  已搬 ${archived} 行，还剩 ${remaining} 行…\n`)
    }
    const afterTotal = Number(db.prepare('SELECT COUNT(*) c FROM audit').get().c)
    const archivedTotal = Number(db.prepare('SELECT COUNT(*) c FROM audit_archive').get().c)
    process.stdout.write(`\n已归档      : ${archived} 行\n`)
    process.stdout.write(`审计剩余    : ${afterTotal} 行（${action} 还剩 ${remaining} 行）\n`)
    process.stdout.write(`归档表累计  : ${archivedTotal} 行\n`)
    process.stdout.write('提示：VACUUM 才会把文件空间收回去（这里刻意不做——它是重操作，由人挑时间）。\n')
  }
} finally {
  try { db.close() } catch { /* 已关闭 */ }
}
