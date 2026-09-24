/**
 * ★★★ 我的「手钉」列表，把几个模块**假装成了生产入口**。
 *
 * ## 怎么发现的
 *
 * CI 里 `reachability` 探针报"两族 gap 已经变成可达"（好消息、要清基线）。
 * 但 `external-api-scope.mjs` 我用 `git grep` **找不到任何生产 importer**
 * ——只有注释、文档、和它自己的用例。追链之后原因写得很清楚：
 *
 *     起点为什么算入口：清单声明（scripts/prt/boundary-facts.mjs）
 *
 * 我上一轮加的手钉数组用的键是 **`path:`**：
 *
 *     Object.freeze({ path: 'runtime/dsh-composition/external-api-scope.mjs', line: 1061, … })
 *
 * 而探针的 `MANIFEST_PATTERNS` 里有一条
 * `/\bpath:\s*'([^']+\.mjs)'/g`（本意是读 `process-manifest.mjs` 的 `entry.path`）。
 * ⇒ **我那张"文档坐标表"被当成了"清单：这个模块会被加载"。**
 *
 *   > 一个"某处声明了这个模块会被加载"与一个"某处**提到了**这个模块的坐标"，
 *   > 在只看 `path: '...mjs'` 这个形状的判据里是同一个东西——
 *   > 而前者是**接线**，后者是**记账**。
 *
 * ## 为什么这比"少报"更危险
 *
 * 它报的是**好消息**，而探针的红会**指导人去执行清理**：
 * 删 READINGS、更新裁决、跑 `--record` 清基线 ⇒ **把一个没接线的模块记成已接线**。
 * 前面那一次（`wireChecked`）是让判据**变瞎**；这一次是让判据**说谎**。
 *
 * ## 这个脚本做什么
 *
 * 算出"可达集"，然后列出**我那 5 条手钉命名的文件**各自的可达性，
 * 以及**它算作入口的理由**——理由里若出现 `boundary-facts`，那就是我造的假象。
 */
import { collectFiles, buildGraph, findEntries, reachableFrom } from '../scripts/prt/reachability.mjs'
import { readFileSync } from 'node:fs'

/**
 * 从 `boundary-facts.mjs` 源码里取出 `PINNED_CITATIONS` 的路径。
 * ★ 不用 import：那个数组**没有导出**（导出的是 `checkPinnedCitations`）。
 *   顺带把"取到了几条"印出来——取到 0 条时下面的结论是**空的**而不是"没问题"。
 */
const bfSrc = readFileSync(new URL('../scripts/prt/boundary-facts.mjs', import.meta.url), 'utf8')
const block = bfSrc.slice(bfSrc.indexOf('const PINNED_CITATIONS'), bfSrc.indexOf('export function checkPinnedCitations'))
const pinPaths = [...block.matchAll(/path:\s*'([^']+\.(?:mjs|ts))'/g)].map((m) => m[1])

const files = collectFiles()
const src = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]))
const { edges } = buildGraph(files)
const entriesMap = findEntries(files, src)
const entries = [...entriesMap.keys()]
const reach = reachableFrom(edges, entriesMap)

const outs = (f) => {
  const v = edges.get(f)
  return !v ? [] : v instanceof Set ? [...v] : Array.isArray(v) ? v : []
}

// 重建父指针，以便追"到它为止的链"
const parent = new Map()
const seen = new Set(entries)
const q = [...entries]
while (q.length) {
  const cur = q.shift()
  for (const nxt of outs(cur)) {
    if (seen.has(nxt)) continue
    seen.add(nxt)
    parent.set(nxt, cur)
    q.push(nxt)
  }
}

console.log(`入口 ${entries.length} 个；可达 ${reach.size} 个`)
console.log(`手钉表里取到 ${pinPaths.length} 条路径：${pinPaths.length ? '' : '★ 一条都没取到 ⇒ 下面的结论是空的，不是"没问题"'}`)
for (const p of pinPaths) console.log(`  · ${p}`)
console.log('')
console.log('=== 它们各自的可达性 ===\n')

let falseEntries = []
for (const f of pinPaths) {
  const isReach = reach.has(f)
  console.log(`${f}`)
  console.log(`  可达？${isReach ? '**是**' : '否'}`)
  const why = entriesMap.get(f)
  if (why !== undefined) {
    const mine = String(why).includes('boundary-facts')
    console.log(`  ★ 它自己就是**入口**，理由是：${why}`)
    if (mine) {
      console.log(`  ★★★ 这个入口是**我的手钉表造的**（不是任何生产清单）⇒ 假的可达。`)
      falseEntries.push(f)
    }
  }
  if (isReach) {
    const chain = []
    let cur = f
    let g = 0
    while (cur !== undefined && g++ < 200) {
      chain.unshift(cur)
      if (entriesMap.has(cur)) break
      cur = parent.get(cur)
    }
    if (entriesMap.has(chain[0])) console.log(`  链：${chain.join(' → ')}\n      起点理由：${entriesMap.get(chain[0])}`)
  }
  // 真正的 import 者（排除用例）
  const importers = []
  for (const [from, tos] of edges) {
    const arr = tos instanceof Set ? [...tos] : Array.isArray(tos) ? tos : []
    if (arr.includes(f)) importers.push(from)
  }
  const prod = importers.filter((p) => !p.endsWith('.test.mjs'))
  console.log(`  生产 import 者（排除 .test.mjs）：${prod.length ? prod.join(', ') : '**零个**'}`)
  console.log('')
}

console.log('=== 结论 ===')
if (falseEntries.length) {
  console.log(`  ★★★ ${falseEntries.length} 个模块的"可达"是**我的手钉表造的**：`)
  for (const f of falseEntries) console.log(`      ${f}`)
  console.log('  ⇒ 修法：把 `path:` 这个键改掉（它不是清单，是坐标表）。')
} else {
  console.log('  （没有发现我造出的假入口——那也要如实说：这条路这次没测到东西）')
}
