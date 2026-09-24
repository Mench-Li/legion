// scripts/probes/probe-original-citation-face.mjs
// ============================================================================
// 量具：**「原文/原句」引文面**在哪些目录里、有多少处。
//
// ## 为什么需要它（P3-3 那条读数是被它推翻的）
//
// 接管队列 P3-3 记的是："`security/` 下 15 个 `.mjs` 里有 **6 处**「原文/原句」形状，
// 今天都不在任何判据的扫描面里。" —— 那条读数是**数词**数出来的。
//
// 本量具按判据**一模一样的正则**（`scripts/prt/boundary-facts.mjs:736` 的
// `ORIGINAL_CITATION_RE`）再数一遍，把两件事分开：
//
//   · **用词**命中：任何出现「原文 / 原句」这两个词的地方
//     —— 大多数是普通中文用法（"文档原文"、"blob 原文"＝明文），**不是引文**；
//   · **引文面**命中：`路径:行 … 原文：「…」` 这个形状（判据真正扫的东西）。
//
//   > 一个"数了词"的扫描器，与一个"数了引文"的扫描器，
//   > 在只看那个数字的时候给出的是同一个读数 ——
//   > 只不过前者会把"这份代码里没引用过别处的原话"读成"有一个没被覆盖的面"。
//
// ## 可复跑
//
//   node scripts/probes/probe-original-citation-face.mjs
//
// 2026-09-23（第 118 轮第十七轮）实测：
//   根表六目录（runtime/product/orchestrator/team-hub/scripts/plugins）：
//     **用词 448 处、引文面 4 处**；
//   security/：**用词 6 处、引文面 0 处**
//   ⇒ 把 `security` 并进 `ORIGINAL_CITATION_ROOTS`，读数 **4 → 4**（一处都不变）。
// ============================================================================
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 与 `scripts/prt/boundary-facts.mjs:736` **逐字相同**（改一处就要改两处，判据会红）。 */
const ORIGINAL_CITATION_RE =
  /([A-Za-z0-9_./-]+\.[a-z]{2,3}):(\d+)(?:-(\d+))?[^\n]*?(?:原文|原句)[^\n]*?[：:]\s*([「『“"])/g

const SKIP = new Set(['node_modules', '.git', 'dist', 'releases', '.ci'])
const ROOTS = ['runtime', 'product', 'orchestrator', 'team-hub', 'scripts', 'plugins']
const EXTRA = ['security']

const walk = (dir, out = []) => {
  let ents = []
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    if (SKIP.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) { walk(p, out); continue }
    if (/\.(mjs|js|ts)$/.test(e.name)) out.push(p)
  }
  return out
}

/** 量一个目录：用词命中与引文面命中分开数，并把引文面的每一处打出来。 */
const tally = (root) => {
  let words = 0
  const citations = []
  for (const f of walk(join(REPO, root))) {
    let text = ''
    try { text = readFileSync(f, 'utf8') } catch { continue }
    words += [...text.matchAll(/原文|原句/g)].length
    for (const m of text.matchAll(ORIGINAL_CITATION_RE)) {
      citations.push(`${relative(REPO, f).split('\\').join('/')}:${text.slice(0, m.index).split('\n').length}`)
    }
  }
  return { root, files: walk(join(REPO, root)).length, words, citations }
}

const main = () => {
  let baseTotal = 0
  console.log('== 判据今天的根表 ==')
  for (const r of ROOTS) {
    const t = tally(r)
    baseTotal += t.citations.length
    console.log(`  ${r.padEnd(13)} 文件 ${String(t.files).padStart(4)}  用词 ${String(t.words).padStart(4)}  引文面 ${t.citations.length}`)
    for (const c of t.citations) console.log(`      [引文] ${c}`)
  }
  console.log(`  ${'合计'.padEnd(12)} 引文面 **${baseTotal}** 处`)
  console.log('== 根表之外的目录（候选并进去的那些）==')
  for (const r of EXTRA) {
    const t = tally(r)
    console.log(`  ${r.padEnd(13)} 文件 ${String(t.files).padStart(4)}  用词 ${String(t.words).padStart(4)}  引文面 ${t.citations.length}`)
    for (const c of t.citations) console.log(`      [引文] ${c}`)
    console.log(`  ⇒ 并进根表后读数：${baseTotal} → ${baseTotal + t.citations.length}`)
  }
}

main()
