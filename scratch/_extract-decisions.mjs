// scratch/_extract-decisions.mjs —— 把 §5 的 29 条裁决项抽成"一句话 + 谁裁"（**不提交**）
import { readFileSync } from 'node:fs'
const t = readFileSync('D:/project/DSH/legion/docs/MULTI-AGENT-FEATURE-STATUS.md', 'utf8').split(/\r?\n/)
for (let i = 0; i < t.length; i++) {
  const l = t[i]
  const m = /^\|\s*(\d+)\s*\|/.exec(l)
  if (m === null) continue
  const cells = l.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim())
  if (cells.length < 3) continue
  // 标题：去掉星号，取到第一个「（」或 40 字
  const title = cells[1].replace(/\*\*/g, '').replace(/\s+/g, ' ')
  console.log(`${String(cells[0]).padStart(2)}. [${cells[2]}] ${title.slice(0, 90)}`)
}
