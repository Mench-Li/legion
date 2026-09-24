// scratch/_audit-code-landing.mjs —— 主表「代码落点」列声称的路径**是否真的存在**（**不提交**）
//
// 与 §5.9（计数）、§5.11（表内两格）同一族：**一句没有任何东西核对的断言**。
// 这次核的是"这个功能落在哪个文件"——表里写着的那个文件。
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const ROOT = 'D:/project/DSH/legion'
const tracked = new Set(
  execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0').filter(Boolean).map((p) => p.replace(/\\/g, '/')),
)
const lines = readFileSync(`${ROOT}/docs/MULTI-AGENT-FEATURE-STATUS.md`, 'utf8').split(/\r?\n/)

// 反引号里、看起来像仓库路径的东西
const PATH_RE = /`([A-Za-z][\w./@-]*\.(?:mjs|cjs|js|ts|tsx|json|ya?ml|sql|md))`/g
// 允许"通配"写法：`runtime/adapters/dsh/*`
let checked = 0
const missing = []
const globbed = []
for (let i = 0; i < lines.length; i++) {
  const l = lines[i]
  if (!/^\|\s*F-\d+/.test(l)) continue
  const cells = l.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim())
  if (cells.length !== 5 && cells.length !== 6) continue
  const id = cells[0]
  // 「代码落点」列：主表是 cells[3]，P1/P2 表也是 cells[3]
  const locCell = cells[3] ?? ''
  for (const m of locCell.matchAll(PATH_RE)) {
    const p = m[1]
    if (p.includes('*')) { globbed.push(`${id} ${p}`); continue }
    // 只查看起来是仓库相对路径的（带 / 或已知顶层目录）
    if (!p.includes('/')) continue
    checked += 1
    if (!tracked.has(p)) missing.push({ line: i + 1, id, p })
  }
}
console.log(`「代码落点」里带目录的路径 ${checked} 条；通配写法 ${globbed.length} 条`)
console.log(`不存在的 ${missing.length} 条\n`)
for (const m of missing) console.log(`  ✖ L${m.line} ${m.id}  \`${m.p}\``)
if (globbed.length) { console.log('\n通配写法（跳开不查）：'); for (const g of globbed) console.log('  · ' + g) }
