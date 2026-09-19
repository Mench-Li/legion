// scratch/_probe-basename-unique.mjs —— 那 11 个解不开的名字，全仓同名的有几个（**不提交**）
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = 'D:/project/DSH/legion'
// ★ 必须排掉 worktree 副本：第一版只跳了 node_modules 等，
//   于是 `.legion-worktrees/*/team-hub/server.mjs` 这些**同名副本**把计数撑成 38 ——
//   一个"看起来像发现"的读数，实际只是我的遍历没排干净（与第 24/26 轮同一种错）。
const SKIP = new Set(['.git', 'node_modules', '.ci', '.skills-cache', 'scratch', 'dist', 'build',
  '.legion-worktrees', '.worktrees'])

const index = new Map() // basename -> [相对路径]
;(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP.has(e.name)) continue
      walk(join(dir, e.name))
    } else {
      const rel = relative(ROOT, join(dir, e.name)).replace(/\\/g, '/')
      if (!index.has(e.name)) index.set(e.name, [])
      index.get(e.name).push(rel)
    }
  }
})(ROOT)

const NAMES = ['server.mjs', 'friction.test.mjs', 'graph.test.mjs', 'experience-store.test.mjs',
  'experience-http.test.mjs', 'assemble.mjs', 'tool-request.mjs', 'connector-feedback.mjs',
  'root.test.mjs', 'root-row.mjs', 'root-row.test.mjs']

for (const n of NAMES) {
  const hits = (index.get(n) ?? []).filter((p) => !p.includes('backup'))
  const tag = hits.length === 0 ? '✖ 全仓没有' : hits.length === 1 ? '✔ 唯一' : `△ ${hits.length} 个同名`
  console.log(`\n${n}  ${tag}`)
  for (const h of hits.slice(0, 6)) console.log(`    ${h}`)
  if (hits.length > 6) console.log(`    … 另 ${hits.length - 6} 个`)
}
