/**
 * 追一条 import 链：`external-api-scope.mjs` 到底**怎么**变成可达的？
 *
 * 触发点：CI 里 `reachability` 探针报"四族 gap 里有两个**已经变成可达**了"，
 * 其中 `external-api-scope.mjs` 我用 `git grep` **找不到任何生产 importer**
 * （只有注释、文档、和它自己的用例）——那它凭什么可达？
 *
 * 探针说"从真实入口顺着 import 边走得到它"。那就把那条路**打印出来**。
 * 若打印不出路，说明"可达"是探针的假象（例如把注释里的路径当成了边）。
 */
import { collectFiles, buildGraph, findEntries, reachableFrom } from '../scripts/prt/reachability.mjs'
import { readFileSync } from 'node:fs'

const TARGETS = [
  'runtime/dsh-composition/path-scope.mjs',
  'runtime/dsh-composition/external-api-scope.mjs',
]

const files = collectFiles()
const src = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]))
const { edges } = buildGraph(files)
const entriesMap = findEntries(files, src) // Map<file, 为什么算入口>
const entries = [...entriesMap.keys()]
const reach = reachableFrom(edges, entriesMap) // Map<file, 到达它的入口>

console.log(`入口 ${entries.length} 个；可达 ${reach.size} 个；图里有边的文件 ${edges.size} 个\n`)

/** 边的取出：`edges` 的值可能是 Set 也可能是数组，两种都吃。 */
const outs = (f) => {
  const v = edges.get(f)
  if (!v) return []
  return v instanceof Set ? [...v] : Array.isArray(v) ? v : []
}

/**
 * 反查：谁指向 target？用 BFS 的父指针重建一条入口→target 的路径。
 * ★ 若一个 target 可达但重建不出路径，那"可达"就不是通过 import 边得到的。
 */
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

for (const t of TARGETS) {
  console.log(`=== ${t} ===`)
  console.log(`  在可达集里？${reach.has(t) ? '是' : '否'}`)
  if (!reach.has(t)) {
    console.log(`  （不可达：${reach.has(t) ? '' : '无需追链'}）\n`)
    continue
  }
  console.log(`  探针记的"到达它的入口"：${reach.get(t)}`)
  const chain = []
  let cur = t
  let guard = 0
  while (cur !== undefined && guard++ < 500) {
    chain.unshift(cur)
    if (entriesMap.has(cur)) break
    cur = parent.get(cur)
  }
  if (chain.length > 0 && entriesMap.has(chain[0])) {
    const why = entriesMap.get(chain[0])
    console.log(`  从入口到它的链（${chain.length} 跳）：`)
    for (const c of chain) console.log(`    → ${c}`)
    console.log(`  起点为什么算入口：${why}`)
  } else {
    console.log(`  ★★ **重建不出从入口出发的链**（链头 ${chain[0]} 不是入口）。`)
  }
  const parents = []
  for (const [from, tos] of edges) {
    const arr = tos instanceof Set ? [...tos] : Array.isArray(tos) ? tos : []
    if (arr.includes(t)) parents.push(from)
  }
  console.log(`  直接 import 它的文件（${parents.length} 个）：`)
  for (const p of parents) console.log(`    ${p}${entriesMap.has(p) ? `  ← 是入口（${entriesMap.get(p)}）` : ''}`)
  console.log('')
}
