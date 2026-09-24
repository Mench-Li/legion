// scripts/probes/census-tally-copies.mjs
// ============================================================================
// **T7**（2026-09-24）：台账分档串的**普查** —— 谁抄了它，谁在盯它。
//
// `scripts/prt/boundary-facts.test.mjs` 的 ⑰ 只盯 `TALLY_DOCS` 里那几份。而
// 「我盯的这几份」与「全仓抄了这个数的所有文档」在此之前一直是**两件事** ——
// 于是抄在第 5、第 6 份文档里的那个数**既不红也不被核**。
//
// 本脚本把这两件事合成一件：
//   · 在 `docs/`、`scripts/`、`runtime/` 下扫出所有带分档串的 `.md`；
//   · 任何一份**不在** `TALLY_DOCS` 里的 ⇒ 退出码非零，并把它抄的那一行打出来。
//
// ★ 它还自查一处会腐烂的东西：本脚本的 `TALLY_DOCS` 与 ⑰ 那份**必须一致** ——
//   两边各存一份名单时，"名单漂了"与"没有漏抄"在只看其中一边时是同一个绿。
//
// 用法：node scripts/probes/census-tally-copies.mjs
// ============================================================================
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')

/** 与 ⑰ 同一条判据（分档串的形状）。 */
const TALLY_COPY = /(?:\d+)\s*✅\s*[/／]\s*(?:\d+)\s*🟡\s*[/／]\s*(?:\d+)\s*⏸\s*[/／]\s*(?:\d+)\s*⬜/

/** ⑰ 盯的那几份。★ 与 `boundary-facts.test.mjs` 的 `TALLY_DOCS` 由本脚本末尾的自查约束。 */
const TALLY_DOCS = [
  'docs/superpowers/prt/PRT-FINAL-REPORT-2026-09-18.md',
  'docs/superpowers/prt/PRT-HANDOVER-2026-09-18-ROUND22.md',
  'docs/superpowers/prt/PRT-HUMAN-INTERVENTION-2026-09-20.md',
  'docs/MULTI-AGENT-FEATURE-STATUS.md',
  'docs/DECISION-BRIEF.md',
  'docs/superpowers/prt/PRT-SESSION-REPORT-2026-09-17.md',
]

const SKIP = new Set(['.git', 'node_modules', '.worktrees', 'releases', 'dist', '.ci', '.turbo'])
const ROOTS = ['docs', 'scripts', 'runtime']

const found = []
const walk = (dir) => {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) { walk(p); continue }
    if (!e.name.endsWith('.md')) continue
    const rel = relative(REPO, p).split(sep).join('/')
    const hits = readFileSync(p, 'utf8').split('\n')
      .map((l, i) => [i + 1, l.trim()])
      .filter(([, l]) => TALLY_COPY.test(l))
    if (hits.length > 0) found.push({ rel, hits })
  }
}
for (const r of ROOTS) walk(join(REPO, r))

// ── 自查：本脚本的名单与 ⑰ 的名单必须一致
const testSrc = readFileSync(join(REPO, 'scripts', 'prt', 'boundary-facts.test.mjs'), 'utf8')
const block = testSrc.slice(testSrc.indexOf('const TALLY_DOCS = ['), testSrc.indexOf('const TALLY_LIVE = ['))
const inTest = [...block.matchAll(/'([^']+\.md)'/g)].map((m) => m[1])
const missing = inTest.filter((d) => !TALLY_DOCS.includes(d))
const extra = TALLY_DOCS.filter((d) => !inTest.includes(d))
if (missing.length > 0 || extra.length > 0) {
  console.log(`  ✖ 本脚本的 TALLY_DOCS 与 ⑰ 的不一致：⑰ 有而这里没有 ${JSON.stringify(missing)}；`
    + `这里有而 ⑰ 没有 ${JSON.stringify(extra)}`)
  process.exit(1)
}
console.log(`  名单自查：与 ⑰ 一致（${TALLY_DOCS.length} 份）`)

let unmanaged = 0
console.log('  带分档串的文档：')
for (const f of found) {
  const managed = TALLY_DOCS.includes(f.rel)
  if (!managed) unmanaged += 1
  console.log(`    ${managed ? '[已纳管]' : '★[未纳管]'} ${f.rel}  ${f.hits.length} 处`)
  if (!managed) for (const [ln, l] of f.hits) console.log(`        L${ln}: ${l.slice(0, 100)}`)
}
const gone = TALLY_DOCS.filter((d) => !found.some((f) => f.rel === d))
if (gone.length > 0) {
  console.log(`  ✖ 名单里有 ${JSON.stringify(gone)}，但那里**一处分档串都没有** —— `
    + '锚点会因为"文档被改写/删掉"而静默失配，名单要先跟着改')
}
if (unmanaged > 0 || gone.length > 0) {
  console.log(`\n  ⇒ 未纳管 ${unmanaged} 份 · 名单里已无量 ${gone.length} 份`)
  process.exit(1)
}
console.log(`\n  ⇒ 共 ${found.length} 份，全部纳管（无遗漏、无失效条目）。`)
