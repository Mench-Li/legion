// scratch/_read-pending.mjs —— 读台账里那 5 条非 ✅ 行的完整内容（**不提交**）
import { readFileSync } from 'node:fs'

const t = readFileSync('D:/project/DSH/legion/docs/superpowers/prt/PRT-PROGRESS.md', 'utf8').split(/\r?\n/)
for (const l of t) {
  if (!/^\|\s*PRT-\d+/.test(l)) continue
  const cells = l.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim())
  const st = cells[1] ?? ''
  if (/^✅/.test(st)) continue
  console.log('='.repeat(100))
  console.log(`任务: ${cells[0]}`)
  console.log(`状态: ${st}`)
  console.log(`证据: ${(cells[2] ?? '').slice(0, 1400)}`)
  console.log('')
}
