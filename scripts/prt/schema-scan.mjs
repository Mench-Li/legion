// scripts/prt/schema-scan.mjs — 一次性核查：旧路径是否记录了 token / 费用 / 资源
// （阶段 0 证据采集用；同时也给 PRT-009 的「记不到」结论留下可复核的判据）
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync(process.argv[2] ?? 'D:/project/DSH/legion/team-hub/team.db', { readOnly: true })

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name)

console.log(`=== 表清单（${tables.length}）===`)
console.log('  ' + tables.join(', '))

const nameHits = tables.filter((t) => /token|cost|usage|price/i.test(t))
console.log('')
console.log('=== 表名含 token/cost/usage/price ===')
console.log('  ' + (nameHits.join(', ') || '（无）'))

const colHits = []
for (const t of tables) {
  for (const c of db.prepare(`PRAGMA table_info(${t})`).all()) {
    // 包含 `ms`（精确词）：`web_fetch_history.ms` 是旧路径里唯一的耗时列，
    // 之前的正则漏了它，会得出「连一个耗时列都没有」的错误结论。
    if (/token|cost|usage|price|elapsed|duration|latency|memory|cpu/i.test(c.name) || /^ms$/i.test(c.name)) {
      colHits.push(`${t}.${c.name} (${c.type || '无类型'})`)
    }
  }
}
console.log('')
console.log('=== 列名含 token/cost/usage/price/elapsed/duration/latency/memory/cpu/ms ===')
console.log(colHits.length > 0 ? '  ' + colHits.join('\n  ') : '  （无）')

// 全表全列转储一次，作为「确实没有」的可复核判据（比正则更可靠）
console.log('')
console.log('=== 全部表的全部列（供逐列核对）===')
for (const t of tables) {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
  console.log(`  ${t}: ${cols.join(', ')}`)
}

// 有耗时含义的列，看它实际装了什么
console.log('')
console.log('=== 候选耗时/资源列的行数与样本 ===')
for (const col of colHits) {
  const [t, c] = col.split(' ')[0].split('.')
  try {
    const n = db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ${c} IS NOT NULL`).get().n
    const sample = db.prepare(`SELECT ${c} v FROM ${t} WHERE ${c} IS NOT NULL LIMIT 3`).all().map((r) => r.v)
    console.log(`  ${t}.${c}: ${n} 行，样本 ${JSON.stringify(sample)}`)
  } catch (e) {
    console.log(`  ${t}.${c}: 读取失败 ${e.message}`)
  }
}

db.close()
