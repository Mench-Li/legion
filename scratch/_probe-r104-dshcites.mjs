// scratch/_probe-r104-dshcites.mjs —— 第 104 轮量：`runtime/adapters/dsh/` 引了哪些 DSH 文件，哪些今天**不存在**？
//
// ★ 起因：`dsh-pin-drift` 的 JSON 自报只核对 **3 个文件 / 6 条结论**（全在 `packages/` 下），
//   而执行面适配器里到处引 `plugins/src/index.ts:NNNN` —— 那个路径**在 DSH 检出里不存在**
//   （非浅克隆、17177 个提交、HEAD 树顶层没有 `plugins/`、`git log -- plugins/src/index.ts` 为空）。
// ★★ 本探针把这个覆盖面**量出来**：到底引了多少个不同的 DSH 文件、有几个今天解析不到。
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const R = 'D:/project/DSH/legion'
const DSH = process.env.DSH_CHECKOUT || 'D:/project/DSH/dsh/deepseek-harness'
const dir = join(R, 'runtime/adapters/dsh')

// 只收"看起来指向 DSH 检出内部"的 `path:line`（跳过本仓自己的相对路径与 URL）
const CITE = /([A-Za-z0-9_./-]+\.[a-z]{2,3}):(\d+)(?:-(\d+))?/g

const cites = new Map() // file -> Set('src:line')
function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) { walk(p); continue }
    if (!/\.(mjs|js|ts)$/.test(e.name)) continue
    const text = readFileSync(p, 'utf8')
    text.split(/\r?\n/).forEach((line, i) => {
      for (const m of line.matchAll(CITE)) {
        const f = m[1]
        if (f.includes('://') || f.startsWith('./') || f.startsWith('../')) continue
        if (!f.includes('/')) continue
        if (!cites.has(f)) cites.set(f, new Set())
        cites.get(f).add(`${p.replace(R + '/', '')}:${i + 1}`)
      }
    })
  }
}
walk(dir)

const rows = [...cites.entries()].map(([f, where]) => {
  const abs = join(DSH, f)
  return { f, sites: where.size, exists: existsSync(abs), where: [...where].slice(0, 3) }
}).sort((a, b) => (a.exists === b.exists ? b.sites - a.sites : a.exists ? 1 : -1))

console.log(`  DSH 检出：${DSH}（存在：${existsSync(DSH)}）`)
console.log(`  \`runtime/adapters/dsh/\` 里共引到 **${rows.length}** 个不同的文件路径\n`)
console.log('  ── ★ 今天**解析不到**的 ──')
let miss = 0
for (const r of rows.filter((x) => !x.exists)) {
  miss += 1
  console.log(`    ✖ ${r.f}   （被引 ${r.sites} 处；例如 ${r.where.join('、')}）`)
}
if (miss === 0) console.log('    （无）')
console.log('\n  ── 能解析到的 ──')
for (const r of rows.filter((x) => x.exists)) {
  const n = (() => { try { return readFileSync(join(DSH, r.f), 'utf8').split(/\r?\n/).length } catch { return NaN } })()
  console.log(`    ✔ ${r.f}   ${n} 行   （被引 ${r.sites} 处）`)
}
console.log(`\n  ⇒ 引自 DSH 的路径 **${rows.length}** 个：能解析 ${rows.length - miss}、★**解析不到 ${miss}**`)
