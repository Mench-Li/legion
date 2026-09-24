// scratch/_probe-r118r4-frows.mjs —— 一次性：非 ✅ 的 9 行到底"还差什么"（用完即删，**具名**删）
import { readFileSync, existsSync } from 'node:fs'

const S = 'docs/MULTI-AGENT-FEATURE-STATUS.md'
const L = readFileSync(S, 'utf8').split('\n')

// 取权威表：以 `| F-xx |` 开头、且行里带分档标记的那一批
const rows = []
for (const l of L) {
  const m = /^\|\s*\*{0,2}(F-\d{2})\*{0,2}\s*\|/.exec(l)
  if (m === null) continue
  const cells = l.split('|').slice(1).map((c) => c.trim())
  const si = cells.findIndex((c) => /✅|🟡|⬜|⏸/.test(c))
  if (si < 0) continue
  rows.push({ id: m[1], status: cells[si], cells })
}

const FINAL = (s) => { const m = /→\s*(✅|🟡|⬜|⏸)/.exec(s); return m === null ? (s.match(/✅|🟡|⬜|⏸/) ?? ['?'])[0] : m[1] }
const nonGreen = rows.filter((r) => FINAL(r.status) !== '✅')
console.log(`权威表 ${rows.length} 行；非 ✅ 的 ${nonGreen.length} 行\n`)

for (const r of nonGreen) {
  console.log(`── ${r.id}  ${r.status}`)
  for (let i = 0; i < r.cells.length; i += 1) {
    const c = r.cells[i]
    if (c === '' || /^[✅🟡⬜⏸→\s★]+$/.test(c)) continue
    console.log(`   [${i}] ${c.replace(/\s+/g, ' ').slice(0, 300)}`)
  }
  // 行里引用的路径：存在性当场核
  const paths = [...new Set((r.cells.join(' ').match(/[a-z][a-z0-9-]*(?:\/[a-z0-9._-]+)+\.(?:mjs|md)/g) ?? []))]
  const missing = paths.filter((p) => !existsSync(p))
  if (paths.length > 0) {
    console.log(`   引用路径 ${paths.length} 个；**不存在** ${missing.length} 个`
      + (missing.length ? `：${missing.slice(0, 4).join(' / ')}` : ' ✓'))
  }
  console.log('')
}
