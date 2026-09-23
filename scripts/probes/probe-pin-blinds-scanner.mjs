/**
 * 因果实验：**我上一轮加的手钉判据，是不是把"哑声明"扫描器弄瞎了？**
 *
 * ## 假设
 *
 * `scripts/probes/scan-silent-declarations3.mjs` 的判法是
 * 「全仓出现次数 ≤ 声明次数 ⇒ 哑声明」。它扫的是
 * `ROOTS = [product, runtime, team-hub, orchestrator, security, scrum, plugins, scripts, tests]`
 * 下的**所有 .mjs**。
 *
 * 而我上一轮在 `scripts/prt/boundary-facts.mjs` 里加了一条手钉：
 *
 *     text: 'wireChecked: true,',
 *
 * ——**`scripts/` 就在扫描面里**，而这句话里含有 `wireChecked` 这个词。
 * 于是 `wireChecked` 的"全仓出现次数"从 1 变成 2，`total > decls`，**不再被报出来**。
 *
 * ## 所以这个脚本做一件事
 *
 * 跑两遍同一个判法：**A** 含 `scripts/prt/boundary-facts.mjs`（今天的样子）、
 * **B** 把它排除掉。若 `wireChecked` 只在 B 里出现 ⇒ 假设成立。
 *
 * ★ 正对照：若两遍结果**完全一样**，那这个实验什么也没证明
 *   （可能我连扫描面都没改对），必须如实说"没测到"。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const ROOTS = ['product', 'runtime', 'team-hub', 'orchestrator', 'security', 'scrum', 'plugins', 'scripts', 'tests']
const SUSPECT = 'scripts/prt/boundary-facts.mjs'

const allTracked = () => execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 1 << 28 })
  .split('\n').map((s) => s.trim()).filter((s) => s.endsWith('.mjs'))

function boolFields(src) {
  const m = new Map()
  const re = /^\s{2,}([a-zA-Z_][\w]*)\s*:\s*(true|false)\s*,\s*$/gm
  for (const x of src.matchAll(re)) m.set(x[1], (m.get(x[1]) ?? 0) + 1)
  return m
}
const word = (key) => new RegExp(`(?<![A-Za-z0-9_$])${key.replace(/\$/g, '\\$')}(?![A-Za-z0-9_$])`, 'g')
const countIn = (src, key) => (src.match(word(key)) ?? []).length

/** 跑一遍判法。`exclude` 里的文件不进"出现次数"的累加（但仍在声明扫描里）。 */
function run({ exclude = new Set(), label }) {
  const files = allTracked().filter((f) => ROOTS.some((r) => f.startsWith(`${r}/`)))
  const source = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]))
  const counter = new Map([...source].filter(([f]) => !exclude.has(f)))

  const rows = []
  const seen = new Set()
  for (const [f, src] of source) {
    for (const [key, decls] of boolFields(src)) {
      if (seen.has(key)) continue
      seen.add(key)
      const isProd = !f.includes('.test.mjs') && !f.includes('/tests/')
      if (!isProd) continue
      let total = 0
      for (const s of counter.values()) total += countIn(s, key)
      if (total <= decls) rows.push({ key, file: f, decls, total })
    }
  }
  rows.sort((a, b) => b.decls - a.decls || a.key.localeCompare(b.key))
  console.log(`\n=== ${label} ===`)
  console.log(`  参与累加的文件：${counter.size}（扫描面 ${source.size}）`)
  if (rows.length === 0) console.log('  （一个哑声明都没有）')
  for (const r of rows) console.log(`  ★ ${r.key.padEnd(22)} 声明 ${r.decls} 次，全仓出现 ${r.total} 次   ${r.file}`)
  return new Set(rows.map((r) => r.key))
}

const A = run({ label: 'A：今天的样子（含 scripts/prt/boundary-facts.mjs）' })
const B = run({ exclude: new Set([SUSPECT]), label: `B：把 ${SUSPECT} 排除出"出现次数"累加` })

const onlyB = [...B].filter((k) => !A.has(k))
const onlyA = [...A].filter((k) => !B.has(k))

console.log('\n=== 结论 ===')
if (onlyB.length > 0) {
  console.log(`  ★★ 只在 B（排除我那个文件）里被报出来的：${onlyB.join(', ')}`)
  console.log('  ⇒ 假设成立：**我上一轮加的手钉文本，让这个哑声明扫描器报了 0。**')
} else if (onlyA.length === 0 && A.size === B.size) {
  console.log('  ⚠️ 两遍**完全一样** ⇒ 这个实验什么也没证明（扫描面可能没改对）。')
  console.log('     不要读成"假设不成立"——要读成"我没测到"。')
} else {
  console.log(`  两遍有差异但不在预期方向：onlyA=${JSON.stringify(onlyA)}`)
}
if (onlyA.length > 0) console.log(`  （反向差异，值得看一眼：${onlyA.join(', ')}）`)
