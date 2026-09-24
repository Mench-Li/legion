// scratch/_probe-landing-paths.mjs —— 功能表「代码落点」列里引的路径，逐个看**解不解得开**（**不提交**）
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'D:/project/DSH/legion'
const t = readFileSync(`${ROOT}/docs/MULTI-AGENT-FEATURE-STATUS.md`, 'utf8')
const lines = t.split(/\r?\n/)

let n = 0
const bad = []
for (let i = 0; i < lines.length; i++) {
  const l = lines[i]
  if (!/^\|\s*F-\d+/.test(l)) continue
  const cells = l.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim())
  if (cells.length !== 5 && cells.length !== 6) continue
  const landing = cells[3]
  // 取出反引号里的东西，只要"看起来像路径"的
  for (const m of landing.matchAll(/`([^`]+)`/g)) {
    const raw = m[1].trim()
    if (!/^[\w./-]+\.(mjs|ts|js|json|yml|yaml|md|sql)$/.test(raw)) continue
    n += 1
    const p = join(ROOT, raw)
    if (!existsSync(p)) bad.push({ line: i + 1, id: cells[0], raw })
  }
}
console.log(`「代码落点」列里共 ${n} 个路径引用，**解不开的 ${bad.length} 个**：\n`)
for (const b of bad) console.log(`  L${b.line}  ${b.id.padEnd(22)} \`${b.raw}\``)
