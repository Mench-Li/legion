// scratch/_show-landing-cells.mjs —— 打印「代码落点」整格，看它们的写法惯例（**不提交**）
import { readFileSync } from 'node:fs'
const t = readFileSync('D:/project/DSH/legion/docs/MULTI-AGENT-FEATURE-STATUS.md', 'utf8').split(/\r?\n/)
for (const want of [52, 56, 60, 62, 174, 187, 190]) {
  const l = t[want - 1]
  const cells = l.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim())
  console.log(`\n--- L${want}  ${cells[0]} ---`)
  console.log(`落点格：${cells[3]}`)
}
