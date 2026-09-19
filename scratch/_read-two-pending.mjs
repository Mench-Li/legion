// scratch/_read-two-pending.mjs —— PRT-009 / PRT-253 的完整证据格（**不提交**）
import { readFileSync } from 'node:fs'

const t = readFileSync('D:/project/DSH/legion/docs/superpowers/prt/PRT-PROGRESS.md', 'utf8').split(/\r?\n/)
for (const l of t) {
  if (!/^\|\s*PRT-\d+/.test(l)) continue
  const cells = l.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim())
  if (!/^PRT-(009|253)\b/.test(cells[0])) continue
  console.log('='.repeat(110))
  console.log(`任务: ${cells[0]}   状态: ${cells[1]}`)
  console.log(`证据全文（${(cells[2] ?? '').length} 字）:`)
  console.log(cells[2])
  console.log('')
}
