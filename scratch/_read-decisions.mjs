// scratch/_read-decisions.mjs —— 读 §5 裁决表的每一行（**不提交**）
import { readFileSync } from 'node:fs'

const t = readFileSync('D:/project/DSH/legion/docs/MULTI-AGENT-FEATURE-STATUS.md', 'utf8').split(/\r?\n/)
let inTable = false
for (let i = 0; i < t.length; i++) {
  const l = t[i]
  if (/^##\s*5\.\s/.test(l)) { inTable = true; console.log(`\n### ${l}\n`); continue }
  if (inTable && /^##\s*5\.\d/.test(l)) { inTable = false }
  if (!inTable) continue
  if (!/^\|\s*\d+\s*\|/.test(l)) continue
  const cells = l.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim())
  console.log(`#${cells[0]}  对象=${(cells[1] ?? '').slice(0, 40)}`)
  console.log(`    谁定=${(cells[2] ?? '').slice(0, 30)}`)
  console.log(`    内容=${(cells[3] ?? '').slice(0, 200)}`)
  console.log('')
}
