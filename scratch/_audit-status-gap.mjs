// scratch/_audit-status-gap.mjs —— 功能表的"状态"格与"还差什么"格**互相对不上**的行（**不提交**）
//
// 家族第四次换位置：这次是**同一张表的两个格子互相矛盾**。
//   · 状态说"没做完"（🟡 / ⬜）
//   · 而唯一会说"差什么"的那一格写着 `—`
// 两个格子都由人写，**没有任何东西核对它们是否相容**。
import { readFileSync } from 'node:fs'

const lines = readFileSync('D:/project/DSH/legion/docs/MULTI-AGENT-FEATURE-STATUS.md', 'utf8').split(/\r?\n/)

const DONE = /^✅/
const rows = []
lines.forEach((l, i) => {
  if (!/^\|\s*F-\d+/.test(l)) return
  const cells = l.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim())
  if (cells.length !== 5 && cells.length !== 6) return
  const [id, name, status] = cells
  const gap = cells[cells.length - 1]
  rows.push({ line: i + 1, id, name, status, gap, cols: cells.length })
})

console.log(`功能表里 F-* 行共 ${rows.length} 条\n`)
const norm = (s) => s.replace(/\s/g, '')
const isDone = (s) => DONE.test(s.replace(/→.*$/, '').trim()) // `🟡→✅` 的**终点**是 ✅
const endState = (s) => {
  const parts = s.split('→')
  return (parts[parts.length - 1] || s).trim()
}

console.log('=== 逐行：状态终点 / 还差什么是否为空 ===')
for (const r of rows) {
  const end = endState(r.status)
  const empty = r.gap === '—' || r.gap === '' || r.gap === '-'
  const done = DONE.test(end)
  const paused = end.includes('⏸')
  const flag = (!done && !paused && empty) ? '  ✖ 没做完却说"不差什么"' : ''
  console.log(`L${String(r.line).padStart(4)} ${r.cols}列 ${r.id.padEnd(12)} 终点=${end.padEnd(4)}`
    + ` 空格=${empty ? '是' : '否'}${flag}`)
}
