// scratch/_audit-main-table.mjs —— 只查**主表**（当前状态）里的计数声明（**不提交**）
//
// 为什么收窄：106 处含大量**历史读数**（"本轮…5 例"、evidence 日志里的当时读数）。
// 改它们是**篡改历史**。而主表（`F-01..F-25` 那 15 行）与 §2 是**今天的状态**，
// 那里的计数过期就是**真的错**。
//
//   > 一个"当时的读数"与一个"现在的读数"，在文本里长得一样——
//   > 而前者**必须**留着旧值，后者**必须**跟着代码走。
import { readFileSync } from 'node:fs'

const ROOT = 'D:/project/DSH/legion'
const ci = readFileSync(`${ROOT}/scripts/ci/run-ci.mjs`, 'utf8')
const rows = []
for (const m of ci.matchAll(/label:\s*'([^']*)'/g)) {
  const start = m.index
  const next = ci.indexOf("label: '", start + 8)
  const seg = ci.slice(start, next === -1 ? start + 2000 : next)
  const files = [...new Set([...seg.matchAll(/'([^']*\.test\.mjs)'/g)].map((x) => x[1]))]
  rows.push({ label: m[1], files })
}
const log = readFileSync(`${ROOT}/.ci-r24.log`, 'utf8')
const counts = new Map()
for (const line of log.split('\n')) {
  const m = /^(PASS|FAIL)\s+(.*?):\s+exit=\d+\s+tests=(\d+)/.exec(line.trim())
  if (m) counts.set(m[2], Number(m[3]))
}
const fileCount = new Map()
const multi = new Map()      // 套件名(标签前缀) → {files, total}
for (const r of rows) {
  const n = counts.get(r.label)
  if (n === undefined) continue
  const name = (r.label.split('（')[0] || r.label).trim()
  if (r.files.length === 1) fileCount.set(r.files[0].split('/').pop(), n)
  else multi.set(name, { files: r.files, total: n })
}
// 全仓 test 文件清单，用来判断"文件是否存在"
import { execFileSync } from 'node:child_process'
const allTests = execFileSync('git', ['ls-files', '-z', '*.test.mjs'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0').filter(Boolean)

const doc = readFileSync(`${ROOT}/docs/MULTI-AGENT-FEATURE-STATUS.md`, 'utf8')
const lines = doc.split('\n')
// 主表 = 从表头到下一个空行后的分隔；用行前缀 `| F-` 定位
const CLAIM = /`([A-Za-z][\w./-]*)`[^。\n]{0,20}?(\d+)\s*(?:例|个用例)/g
console.log('=== 主表（| F- 开头）里的计数声明 ===')
let n = 0
lines.forEach((l, i) => {
  if (!/^\|\s*F-\d+/.test(l)) return
  for (const m of l.matchAll(CLAIM)) {
    const name = m[1].split('/').pop()
    const claim = Number(m[2])
    n += 1
    const cand = allTests.filter((f) => f.split('/').pop() === `${name}.test.mjs` || f.split('/').pop() === name)
    let real = null
    let note = ''
    if (cand.length === 1) {
      const b = cand[0].split('/').pop()
      real = fileCount.get(b) ?? null
      if (real === null) note = '（该文件在 CI 的多文件行里，无单文件实测）'
    } else if (cand.length === 0) {
      const mm = multi.get(name)
      if (mm) { real = mm.total; note = `（CI 行聚合 ${mm.files.length} 个文件的总和）` }
      else note = '（找不到同名测试文件）'
    } else note = `（${cand.length} 个同名文件，不猜）`
    const ok = real === null ? '?' : (real === claim ? '✓' : '✖')
    console.log(`  ${ok} 第 ${i + 1} 行  \`${name}\` 文档 ${claim} 例；实测 ${real ?? '—'} ${note}`)
  }
})
console.log(`主表里计数声明 ${n} 处`)
