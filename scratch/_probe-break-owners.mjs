// scratch/_probe-break-owners.mjs —— 链上的每个断点，§5 里有没有人认领（**不提交**）
import { readFileSync } from 'node:fs'
import { traceChain } from '../scripts/prt/alpha-chain-trace.mjs'
import { decisionItemNumbers } from '../scripts/prt/intervention-coverage.mjs'

const REPO = 'D:/project/DSH/legion'
const raw = readFileSync(`${REPO}/docs/MULTI-AGENT-FEATURE-STATUS.md`, 'utf8')
const lines = raw.split(/\r?\n/)

// §5 裁决表：编号 -> 那一行的全文
const start = lines.findIndex((l) => l.trim().startsWith('| # | 事项 | 需要谁 |'))
const items = new Map()
for (let i = start + 1; i < lines.length; i += 1) {
  const t = lines[i].trim()
  if (t === '' || !t.startsWith('|')) break
  const m = /^\|\s*(\d+)\s*\|/.exec(t)
  if (m) items.set(Number(m[1]), lines[i])
}
console.log(`§5 裁决表：${items.size} 行\n`)

const t = traceChain()
const broken = []
for (const s of t.sections) {
  for (const m of s.modules) if (m.bad) broken.push({ sec: s.id, mod: m.module, core: m.core })
}

console.log('链上所有"坏"的结点：')
for (const b of broken) {
  const base = b.mod.split('/').pop()
  const owners = []
  for (const [n, row] of items) {
    // 行里点到这个文件（全路径或裸文件名）
    if (row.includes(b.mod) || row.includes(`\`${base}\``) || row.includes(base)) owners.push(n)
  }
  console.log(`  ${b.sec} [${b.core ? '核心' : '支撑'}] ${b.mod}`)
  console.log(`      §5 里点到它的条目：${owners.length === 0 ? '**没有**' : owners.map((n) => `第 ${n} 条`).join('、')}`)
}
