// scratch/_extract-ledger-evidence.mjs —— 提取台账每条 ✅ 的证据栏（**不提交**）
import { readFileSync } from 'node:fs'

const REPO = 'D:/project/DSH/legion'
const lines = readFileSync(`${REPO}/docs/superpowers/prt/PRT-PROGRESS.md`, 'utf8').split(/\r?\n/)

const rows = []
for (const [i, line] of lines.entries()) {
  const t = line.trim()
  if (!t.startsWith('|')) continue
  const cells = t.split('|').slice(1, -1).map((c) => c.trim())
  if (cells.length < 3) continue
  const m = /^(PRT-\d+)/.exec(cells[0])
  if (m === null) continue
  if (!/^(✅|🟡|⏸|⬜)$/.test(cells[1])) continue
  rows.push({ prt: m[1], status: cells[1], line: i + 1, evidence: cells[2], desc: cells[0] })
}

const by = {}
for (const r of rows) by[r.status] = (by[r.status] ?? 0) + 1
console.log(`台账 ${rows.length} 行：`, JSON.stringify(by))

// 证据栏里出现的「套件 `name`」
const suiteMentions = []
for (const r of rows) {
  for (const m of r.evidence.matchAll(/套件\s*`([^`]+)`/g)) suiteMentions.push({ prt: r.prt, name: m[1], status: r.status })
  for (const m of r.evidence.matchAll(/`([a-z0-9][\w./-]*\.test\.mjs)`/g)) suiteMentions.push({ prt: r.prt, name: m[1], status: r.status, isFile: true })
}
console.log(`\n证据栏里点名的套件：${suiteMentions.length} 处`)
const uniq = new Map()
for (const s of suiteMentions) {
  if (!uniq.has(s.name)) uniq.set(s.name, [])
  uniq.get(s.name).push(s.prt)
}
console.log(`去重后 ${uniq.size} 个不同的套件名：`)
for (const [name, prts] of [...uniq].sort()) console.log(`  ${name.padEnd(34)} ${prts.join(',')}` + (name.includes('.test.mjs') ? '   [文件名]' : ''))

// 没有点名任何套件的 ✅ 行
const noSuite = rows.filter((r) => r.status === '✅' && !/套件\s*`/.test(r.evidence) && !/\.test\.mjs/.test(r.evidence))
console.log(`\n✅ 行里**没有点名任何套件**的：${noSuite.length} 条`)
for (const r of noSuite) console.log(`  ${r.prt} L${r.line}  ${r.evidence.slice(0, 110)}`)
