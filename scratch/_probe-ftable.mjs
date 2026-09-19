// scratch/_probe-ftable.mjs —— F 表点名的证据解得开吗？（**不提交**）
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { suiteFilesFromCi } from '../scripts/prt/suite-counts.mjs'
import { ledgerEvidenceRows } from '../scripts/prt/ledger-evidence.mjs'

const REPO = 'D:/project/DSH/legion'
const tracked = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 })
  .split('\n').map((s) => s.trim()).filter(Boolean)
const trackedSet = new Set(tracked)
const byBase = new Map()
for (const f of tracked.filter((f) => f.endsWith('.test.mjs'))) {
  const b = f.split('/').pop()
  if (!byBase.has(b)) byBase.set(b, [])
  byBase.get(b).push(f)
}
const suites = suiteFilesFromCi(readFileSync(`${REPO}/scripts/ci/run-ci.mjs`, 'utf8'))
const ledgerPrts = new Set(ledgerEvidenceRows().map((r) => r.prt))

const lines = readFileSync(`${REPO}/docs/MULTI-AGENT-FEATURE-STATUS.md`, 'utf8').split(/\r?\n/)
const rows = []
for (const [i, l] of lines.entries()) {
  const t = l.trim()
  if (!/^\|\s*F-\d+/.test(t)) continue
  const cells = t.split('|').slice(1, -1).map((c) => c.trim())
  rows.push({ line: i + 1, id: cells[0], status: cells[2] ?? '', body: cells.slice(3).join(' | ') })
}
console.log(`F 表读到 ${rows.length} 行\n`)

const badPrts = new Map()
const badSuites = new Map()
const badFiles = new Map()
const ambigFiles = new Map()
const seenPrts = new Set()
const seenSuites = new Set()

for (const r of rows) {
  for (const m of r.body.matchAll(/\bPRT-(\d+)/g)) {
    const id = 'PRT-' + m[1]
    seenPrts.add(id)
    if (!ledgerPrts.has(id)) {
      if (!badPrts.has(id)) badPrts.set(id, [])
      badPrts.get(id).push(`F 表 L${r.line}`)
    }
  }
  for (const m of r.body.matchAll(/套件\s*`([^`]+)`/g)) {
    const v = m[1].trim()
    if (!/^[A-Za-z][\w./-]*$/.test(v) || v.endsWith('.test.mjs')) continue
    seenSuites.add(v)
    if (!suites.has(v)) {
      if (!badSuites.has(v)) badSuites.set(v, [])
      badSuites.get(v).push(`L${r.line}`)
    }
  }
  for (const m of r.body.matchAll(/`([A-Za-z0-9][\w./-]*\.test\.mjs)`/g)) {
    const v = m[1]
    if (v.includes('/')) {
      if (!trackedSet.has(v)) {
        if (!badFiles.has(v)) badFiles.set(v, [])
        badFiles.get(v).push(`L${r.line}`)
      }
    } else {
      const hits = byBase.get(v) ?? []
      if (hits.length === 0) {
        if (!badFiles.has(v)) badFiles.set(v, [])
        badFiles.get(v).push(`L${r.line}`)
      } else if (hits.length > 1) {
        if (!ambigFiles.has(v)) ambigFiles.set(v, [])
        ambigFiles.get(v).push(`L${r.line}（${hits.length} 个同名）`)
      }
    }
  }
}

console.log(`点到的 PRT 条目：${seenPrts.size} 个不同`)
console.log(`点到的套件：${seenSuites.size} 个不同`)
console.log(`\n★ 台账里**不存在**的 PRT：${badPrts.size}`)
for (const [k, v] of badPrts) console.log(`  ${k}  ← ${v.join('、')}`)
console.log(`\n★ 不是任何 CI 套件的"套件名"：${badSuites.size}`)
for (const [k, v] of badSuites) console.log(`  ${k}  ← ${v.join('、')}`)
console.log(`\n★ 不存在的用例文件：${badFiles.size}`)
for (const [k, v] of badFiles) console.log(`  ${k}  ← ${v.join('、')}`)
console.log(`\n★ 歧义裸名：${ambigFiles.size}`)
for (const [k, v] of ambigFiles) console.log(`  ${k}  ← ${v.join('、')}`)
