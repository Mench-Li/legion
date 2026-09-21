// scratch/_probe-schema-notnull.mjs — 量：新代码建出来的库里，有没有
// 「NOT NULL 且没有 DEFAULT」的列。那是唯一会让**老代码的 INSERT** 直接失败的东西
// （老语句只写它知道的列，新列拿不到值 ⇒ NOT NULL 违约）。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'probe-schema-'))
process.env.TEAM_HUB_DB = join(dir, 'team.db')
const mod = await import('../team-hub/server.mjs?probe=' + Date.now())
const db = mod.db

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name)
console.log(`表 ${tables.length} 个`)

const bad = []
const withDefault = []
for (const t of tables) {
  for (const c of db.prepare(`PRAGMA table_info(${t})`).all()) {
    if (c.notnull !== 1) continue
    if (c.dflt_value !== null && c.dflt_value !== undefined) { withDefault.push(`${t}.${c.name}`); continue }
    bad.push(`${t}.${c.name} (${c.type}) pk=${c.pk}`)
  }
}
console.log(`\nNOT NULL 且有 DEFAULT：${withDefault.length} 列`)
console.log(`NOT NULL 且**无** DEFAULT：${bad.length} 列`)
for (const b of bad) console.log('  ✖ ' + b)
db.close()
rmSync(dir, { recursive: true, force: true })
