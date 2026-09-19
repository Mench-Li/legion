// scratch/_read-5col-full.mjs —— 读 5 列表（第 173–191 行）整行（**不提交**）
import { readFileSync } from 'node:fs'

const lines = readFileSync('D:/project/DSH/legion/docs/MULTI-AGENT-FEATURE-STATUS.md', 'utf8').split(/\r?\n/)
for (let i = 168; i < 195; i++) {
  const l = lines[i]
  if (l === undefined) break
  if (!l.trim()) { console.log(`L${i + 1}  （空行）`); continue }
  console.log(`L${i + 1}: ${l.slice(0, 700)}`)
  console.log('')
}
