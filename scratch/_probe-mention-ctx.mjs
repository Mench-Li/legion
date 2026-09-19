// scratch/_probe-mention-ctx.mjs —— 每个 .test.mjs 点名及其上下文（**不提交**）
import { readFileSync } from 'node:fs'
const lines = readFileSync('D:/project/DSH/legion/docs/superpowers/prt/PRT-PROGRESS.md', 'utf8').split(/\r?\n/)
const rows = []
for (const [i, line] of lines.entries()) {
  const t = line.trim()
  if (!t.startsWith('|')) continue
  const cells = t.split('|').slice(1, -1).map((c) => c.trim())
  if (cells.length < 3 || cells[1] !== '✅') continue
  const m = /^(PRT-\d+)/.exec(cells[0])
  if (m) rows.push({ prt: m[1], line: i + 1, evidence: cells[2] })
}
for (const r of rows) {
  for (const mm of r.evidence.matchAll(/([^\s`（(]{0,26}`[A-Za-z0-9][\w./-]*\.test\.mjs`)/g)) {
    const name = /`([^`]+)`/.exec(mm[1])[1]
    if (name.includes('/')) continue // 只看裸名
    console.log(`${r.prt} L${r.line}  ${name}`)
    console.log(`      …${mm[1].slice(0, 60)}`)
  }
}
