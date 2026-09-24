// scratch/_read-d19.mjs —— §5 第 19 条全文（**不提交**）
import { readFileSync } from 'node:fs'

const t = readFileSync('D:/project/DSH/legion/docs/MULTI-AGENT-FEATURE-STATUS.md', 'utf8').split(/\r?\n/)
for (const line of t) {
  if (!/^\|\s*19\s*\|/.test(line)) continue
  const cells = line.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim())
  for (let i = 0; i < cells.length; i++) {
    console.log(`--- 列 ${i} ---`)
    console.log(cells[i])
    console.log('')
  }
}
