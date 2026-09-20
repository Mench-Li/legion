// scratch/_probe-r98-relativedays.mjs —— 第 98 轮探针：**相对日数**这种写法还在哪些地方？（在我立判据之前先量）
//
// ★ 本仓已有明文规矩（交付物 §2.0）：「最早 **2026-09-24**（**绝对日期**，**不写"还差几天"**）」
//   —— 而第 89 与第 95 两轮，我**各抓到一处**违反它的地方，两次都是**用手找的**。
//   ⇒ 先量：今天还剩几处、分别在哪 —— 再决定要不要立判据。
import { readFileSync } from 'node:fs'

const R = 'D:/project/DSH/legion'
const DOCS = [
  'docs/superpowers/prt/PRT-HUMAN-INTERVENTION-2026-09-20.md',
  'docs/superpowers/prt/PRT-FINAL-REPORT-2026-09-18.md',
  'docs/DECISION-BRIEF.md',
  'docs/DECISION-RUNREQUEST-EXECUTION-PLANE.md',
]

// 相对日数的写法：还差 N 天 / 再过 N 天 / N 天后 / 距今 N 天 / 今天…还差
const PAT = /还差\s*\*{0,2}\d+\*{0,2}\s*天|\d+\s*天后|再过\s*\d+\s*天|距今\s*\d+\s*天/g

let total = 0
for (const rel of DOCS) {
  let t
  try { t = readFileSync(`${R}/${rel}`, 'utf8') } catch { console.log(`  （读不到 ${rel}）`); continue }
  const lines = t.split(/\r?\n/)
  const hits = []
  lines.forEach((l, i) => {
    const m = l.match(PAT)
    if (m) hits.push({ line: i + 1, what: [...new Set(m)].join(' / '), text: l.trim().slice(0, 96) })
  })
  console.log(`  ── ${rel}：${hits.length} 处 ──`)
  for (const h of hits) console.log(`    L${h.line}  [${h.what}]  ${h.text}`)
  total += hits.length
}
console.log(`  ⇒ 合计 ${total} 处`)

// 再看：这些是不是都在"更正说明"里（即引用旧值）而不是活读数
console.log('  ── 判读：以上各处**在不在更正说明里**（引用自己改掉的旧值属于历史，不算活读数）──')
for (const rel of DOCS) {
  let t
  try { t = readFileSync(`${R}/${rel}`, 'utf8') } catch { continue }
  const lines = t.split(/\r?\n/)
  lines.forEach((l, i) => {
    if (!PAT.test(l)) return
    const isCorrection = /更正|原来写|曾经那样|第 \d+ 轮我漏|原写/.test(l)
    console.log(`    ${isCorrection ? '★ 历史（更正说明里）' : '‼ 活读数'}  ${rel.split('/').pop()}:${i + 1}`)
    PAT.lastIndex = 0
  })
}
