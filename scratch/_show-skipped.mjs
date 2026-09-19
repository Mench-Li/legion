// scratch/_show-skipped.mjs —— feature-table-status 跳过的那些 F-* 行是什么（**不提交**）
import { readFileSync } from 'node:fs'
import { parseFeatureRows } from '../scripts/prt/feature-table-status.mjs'

const text = readFileSync('D:/project/DSH/legion/docs/MULTI-AGENT-FEATURE-STATUS.md', 'utf8')
const { rows, skipped } = parseFeatureRows(text)
console.log(`受管 ${rows.length} 行，跳过 ${skipped.length} 行\n`)
const lines = text.split(/\r?\n/)
for (const s of skipped) {
  console.log(`L${s.line}  列数=${s.cols}  id=${s.id}`)
  console.log(`      ${lines[s.line - 1].slice(0, 150)}`)
}
