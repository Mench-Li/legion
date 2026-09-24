// scratch/_audit-counts.mjs —— "套件 X，N 例" vs 实测（**不提交**）
//
// ## 第一版把 135 处报成"不一致"，而绝大多数是**我的解析器的错**
//
// 第一版拿"CI 的套件行"当分母。而 CI 的一个套件行**聚合多个文件**：
//   `path-scope` 那一行 = 4 个文件 ⇒ tests=67，而文档说的 `path-scope` 22 例
//   指的是**其中那一个文件**。两个数都真，只是**分母不同**
//   ——这与"拿窗口聚合去比单次上限"是同一类错（第 23 轮 `perRunBudget` 那一课）。
//
//   > 一个"解析器拿错了分母"与一个"文档里 135 处计数都过期"，
//   > 在报告里长得一模一样——而后者看起来**更像个大发现**。
//
// ## 所以这一版只信**分母唯一**的那一档
//
// 只有当 CI 那一行**恰好一个文件**时，那个文件的用例数才是**实测**的。
// 多文件行只知道总和 ⇒ **跳过**（不猜）。文档声明再按文件名解析到唯一文件，
// 只有落到"实测档"上才比较。
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/project/DSH/legion'

// ── ① run-ci.mjs：套件行 → 文件清单（顺带拿到 label）
const ci = readFileSync(`${ROOT}/scripts/ci/run-ci.mjs`, 'utf8')
const rows = []
for (const m of ci.matchAll(/label:\s*'([^']*)'/g)) {
  const start = m.index
  const next = ci.indexOf("label: '", start + 8)
  const seg = ci.slice(start, next === -1 ? start + 2000 : next)
  const files = [...seg.matchAll(/'([^']*\.test\.mjs)'/g)].map((x) => x[1])
  rows.push({ label: m[1], files: [...new Set(files)] })
}

// ── ② CI 日志：label → tests
const log = readFileSync(`${ROOT}/.ci-r24.log`, 'utf8')
const counts = new Map()
for (const line of log.split('\n')) {
  const m = /^(PASS|FAIL)\s+(.*?):\s+exit=\d+\s+tests=(\d+)/.exec(line.trim())
  if (m) counts.set(m[2], Number(m[3]))
}

// ── ③ 只保留"单文件行"，建立 文件 basename → 实测用例数
const fileCount = new Map()
const dup = new Set()
for (const r of rows) {
  if (r.files.length !== 1) continue
  const n = counts.get(r.label)
  if (n === undefined) continue
  const base = r.files[0].split('/').pop()
  if (fileCount.has(base) && fileCount.get(base) !== n) dup.add(base)
  fileCount.set(base, n)
}
for (const d of dup) fileCount.delete(d)   // 同名冲突 ⇒ 不猜
console.log(`套件行 ${rows.length}；其中单文件 ${[...rows].filter((r) => r.files.length === 1).length} 行`
  + ` ⇒ 实测到的文件 ${fileCount.size} 个（同名冲突剔除 ${dup.size}）`)

// ── ④ 文档里的计数声明
const DOCS = execFileSync('git', ['ls-files', '-z', 'docs'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0').filter((f) => f.endsWith('.md'))
const CLAIM = /`([A-Za-z][\w./-]*)`[^。\n]{0,24}?(\d+)\s*(?:例|个用例)/g

let checked = 0
const mism = []
for (const doc of DOCS) {
  const lines = readFileSync(`${ROOT}/${doc}`, 'utf8').split('\n')
  lines.forEach((line, li) => {
    for (const m of line.matchAll(CLAIM)) {
      const name = m[1].split('/').pop()
      const claim = Number(m[2])
      // 解析到唯一文件：`X` → `X.test.mjs`；也允许 `X.test.mjs` 直接写出来
      const cands = [...fileCount.keys()].filter((b) => b === `${name}.test.mjs` || b === name)
      if (cands.length !== 1) continue
      const real = fileCount.get(cands[0])
      checked += 1
      if (real !== claim) mism.push({ doc, line: li + 1, name: cands[0], claim, real })
    }
  })
}
console.log(`可落到"实测档"的计数声明 ${checked} 处；不一致 ${mism.length} 处\n`)
for (const x of mism) {
  console.log(`  ✖ ${x.doc}:${x.line}`)
  console.log(`      \`${x.name}\` —— 文档说 ${x.claim} 例，实测 ${x.real} 例`)
}
