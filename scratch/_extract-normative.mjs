// scratch/_extract-normative.mjs —— 抽出规格文档 §4 里的**规范性**句子（必须/不得/禁止/应当）
// 这些句子是"功能实现"的可核对单位：每一条都能回答"代码里有没有它的落点"。
import { readFileSync } from 'node:fs'

const t = readFileSync('D:/project/DSH/legion/docs/MULTI-AGENT-FEATURE-OPTIMIZATION.md', 'utf8')
const lines = t.split(/\r?\n/)

// 只看 §4（分层功能优化清单）到 §5 之前
let start = lines.findIndex((l) => /^## 4\./.test(l))
let end = lines.findIndex((l, i) => i > start && /^## 5\./.test(l))
if (end === -1) end = lines.length
console.log(`§4 范围：L${start + 1} ～ L${end}\n`)

const NORM = /必须|不得|禁止|应当|禁止|一律|只能是|不许/
let feature = ''
let n = 0
for (let i = start; i < end; i++) {
  const l = lines[i]
  const h = /^####\s*(F-\d+[^\n（(]*)/.exec(l)
  if (h) { feature = h[1].trim(); continue }
  if (!NORM.test(l)) continue
  // 把一行里按句号切开，只留带规范词的句子
  for (const s of l.split(/(?<=。)/)) {
    if (!NORM.test(s)) continue
    const clean = s.trim().replace(/^[-*\s>]+/, '')
    if (clean.length < 6) continue
    n += 1
    console.log(`[${feature}] ${clean}`)
  }
}
console.log(`\n共 ${n} 条规范性句子`)
