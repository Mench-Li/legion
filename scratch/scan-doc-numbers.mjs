/**
 * 找出状态文档里"**声称某个常量/文件有 N 个什么**"的句子——这些是我可能写错的数字。
 *
 * ## 为什么值得单独找
 *
 * 上一批我抓到自己文档里一个过期数字（`PATCH_LAYER_ROWS` 我写 4 行、实际 5 行，
 * 第 5 行 2026-09-15 就加了）。那是**顺路**发现的。
 *
 *   > 一个"顺路发现的过期数字"，与"文档里过期数字的总数"之间没有关系。
 *
 * 这个脚本只做第一步：把**可能被核对**的句子找出来（带 `IDENTIFIER` 或 `file.mjs`
 * 且带数字的）。第二步（真的去核）由人挑——因为"这个 N 说的是什么"需要读懂句子。
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FILE = process.argv[2] ?? 'docs/MULTI-AGENT-FEATURE-STATUS.md'
const text = readFileSync(resolve(ROOT, FILE), 'utf8')

// 反向引号包起来的标识符（常量、文件名、函数名）
const IDENT = '`[A-Za-z_][A-Za-z0-9_.-]{2,}`'
const NUM = '(\\d+)\\s*(行|条|个|项|处|例)'

const patterns = [
  new RegExp(`[^。\\n]{0,70}${IDENT}[^。\\n]{0,35}?${NUM}[^。\\n]{0,15}`, 'g'),
  new RegExp(`[^。\\n]{0,70}?${NUM}[^。\\n]{0,35}${IDENT}[^。\\n]{0,15}`, 'g'),
]

const seen = new Map()
for (const p of patterns) {
  let m
  while ((m = p.exec(text)) !== null) {
    const s = m[0].replace(/\s+/g, ' ').trim()
    // 只留含"看起来很具体"的标识符：全大写下划线常量，或带 .mjs 的文件名
    const ids = [...s.matchAll(/`([A-Za-z_][A-Za-z0-9_.-]{2,})`/g)].map((x) => x[1])
    const strong = ids.filter((x) => /^[A-Z][A-Z0-9_]{3,}$/.test(x) || /\.mjs$/.test(x))
    if (strong.length === 0) continue
    if (!seen.has(s)) seen.set(s, strong)
  }
}

const rows = [...seen.entries()]
console.log(`${FILE}：候选句子 ${rows.length} 条（带常量名/文件名 + 数字）\n`)
rows.forEach(([s, ids], i) => {
  console.log(`${String(i + 1).padStart(3)}. [${ids.join(' ')}]`)
  console.log(`     ${s.slice(0, 158)}`)
})

// 按标识符聚合：同一个常量被说成几个不同的数字 ⇒ 最可疑
const byId = new Map()
for (const [s, ids] of rows) {
  for (const id of ids) {
    if (!byId.has(id)) byId.set(id, [])
    byId.get(id).push(s)
  }
}
console.log('\n' + '='.repeat(72))
console.log('★ 最可疑的一类：同一标识符在不同句子里的数字**不一致**')
let flagged = 0
for (const [id, sents] of byId) {
  if (sents.length < 2) continue
  const nums = sents.map((s) => {
    const m = /(\d+)\s*(行|条|个|项|处|例)/.exec(s)
    return m ? m[1] : '?'
  })
  const uniq = [...new Set(nums)]
  if (uniq.length > 1) {
    flagged++
    console.log(`\n  ⚠️ \`${id}\` 被说成 ${uniq.join(' / ')}：`)
    sents.slice(0, 4).forEach((s) => console.log(`     · ${s.slice(0, 130)}`))
  }
}
if (flagged === 0) console.log('  （没有发现同一标识符数字不一致的情形）')
