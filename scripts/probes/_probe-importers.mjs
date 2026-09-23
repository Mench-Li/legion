// scripts/probes/_probe-importers.mjs —— 第 50 轮：为 6 条"内容为空"的 reason 量出**真事实**
//
// ⚠️ 本脚本第一版有**两个错**，都是"看起来量到了"的错：
//
//   ① 它走进了 `.worktrees/`（同仓的**兄弟工作树**）⇒ 报出 10 个"import 者"，
//      而它们全都不是这棵树里的代码。
//   ② 它按**文件名**匹配 import 路径 ⇒ `from './context-retention.mjs'`
//      被算成了 `retention.mjs` 的 import 者（**子串**命中）。
//      ⇒ 于是 `product/lifecycle/retention.mjs` 报出"被 team-hub/server.mjs 引用，
//      而它可达" —— 一个**根本不存在**的引用。
//
//   > 一个按**子串**匹配的探针，报出的是"某个名字里含这个名字的东西"，
//   > 而它和"这个名字本身"在输出里长得一模一样。
//
//   ★ 这个坑我在**第 49 轮已经踩过一次**（当时的 `git grep -l` 把
//     `context-retention.mjs` 与 `lifecycle/retention.mjs` 混在一起）。
//     ⇒ 所以这一版把"路径分段匹配"和"跳过兄弟工作树"都写成**显式**的，
//       并**断言**跳过确实生效（否则下次它又悄悄扫回去）。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = 'D:/project/DSH/legion'
const base = JSON.parse(readFileSync(`${ROOT}/docs/superpowers/prt/prt-reachability-baseline.json`, 'utf8'))
const unreachable = new Set(base.unreachable.map((e) => e.file))

// ★ `.worktrees`（兄弟工作树）必须跳过：它们不在本树的 import 图里。
const SKIP = new Set(['node_modules', '.git', 'scratch', 'dist', 'build', '.ci', 'coverage', '.worktrees'])
let walked = 0
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.mjs')) { out.push(relative(ROOT, p).replace(/\\/g, '/')); walked += 1 }
  }
  return out
}
const all = walk(ROOT)

// ★ 断言：跳过真的生效，且这棵树里没有任何 `.worktrees` 文件被收进来
const leaked = all.filter((f) => f.includes('.worktrees'))
if (leaked.length > 0) { console.log(`  ✖ 兄弟工作树漏进来了 ${leaked.length} 个文件`); process.exit(1) }
console.log(`  扫描 ${walked} 个 .mjs（已排除 .worktrees/、scratch/、scripts/）\n`)

/** ★ 按**路径分段**匹配：`/retention.mjs'` 或 `'./retention.mjs'`，
 *  而不是"以 retention.mjs 结尾"（那会把 context-retention.mjs 算进来）。 */
function importersOf(target) {
  const leaf = target.split('/').pop().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`from\\s+'(?:[^']*[/'])?${leaf}'`)
  const out = []
  for (const f of all) {
    if (f === target || f.endsWith('.test.mjs') || f.startsWith('scripts/')) continue
    const src = readFileSync(join(ROOT, f), 'utf8')
    if (re.test(src)) out.push(f)
  }
  return out
}

const TARGETS = [
  'product/lifecycle/data-export.mjs',
  'product/lifecycle/retention.mjs',
  'product/lifecycle/uninstall.mjs',
  'product/release/checklist.mjs',
  'product/release/privacy.mjs',
  'product/support/runbook.mjs',
  'runtime/experience/graph.mjs',
  'runtime/packs/compiled-plan.mjs',
]
for (const t of TARGETS) {
  const imps = importersOf(t)
  console.log(`  ${t}`)
  if (imps.length === 0) { console.log('      **零生产 import 者**'); continue }
  for (const f of imps) {
    const u = unreachable.has(f)
    console.log(`      被 ${f}${u ? '  ← 它自己也在 unreachable 里 ⇒ 传递不可达' : '  ← ★ 可达（那就不是"没人接"）'}`)
  }
}
