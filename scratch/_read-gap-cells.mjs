// scratch/_read-gap-cells.mjs —— 把 §3/§4 表里"还差什么"为 `—` 的行整行读出来（**不提交**）
//
// 一个 🟡 的行，如果"还差什么"格写的是 `—`，有两种可能：
//   ① 真的没缺什么（那为什么不是 ✅？）
//   ② **那一格根本没人写**
// 两者在表里长得一模一样。
import { readFileSync } from 'node:fs'

const doc = readFileSync('D:/project/DSH/legion/docs/MULTI-AGENT-FEATURE-STATUS.md', 'utf8')
const lines = doc.split(/\r?\n/)

// 主表：| 编号 | 名称 | 状态 | 代码落点 | 判据/证据 | 还差什么 |
console.log('=== 主表里"还差什么"为 — 或空的行 ===\n')
lines.forEach((l, i) => {
  if (!/^\|\s*F-\d+/.test(l)) return
  const cells = l.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/)
  if (cells.length !== 6) { console.log(`L${i + 1} 列数=${cells.length}（不是 6，跳过）`); return }
  const [id, name, status, loc, ev, gap] = cells.map((c) => c.trim())
  if (gap === '—' || gap === '' || gap === '-') {
    console.log(`L${i + 1}  ${id}  ${name}   状态=${status}`)
    console.log(`     代码落点: ${loc.slice(0, 110)}`)
    console.log(`     判据/证据: ${ev.slice(0, 200)}`)
    console.log(`     还差什么: ${JSON.stringify(gap)}   ← ${gap === '' ? '**空格**' : '一个破折号'}`)
    console.log('')
  }
})
