// scratch/_probe-r97-report-round.mjs —— 第 97 轮探针：交付物 §一 的「追加至第 N 轮」到底该等于**哪一个**可派生的量？
//
// ★ 上一轮（第 96 轮）那条判据的派生量是**唯一且清晰**的（家族表最大轮次）。
//   本轮先去量：这份报告里几个候选量分别是多少 —— 若没有清晰的，就**不加判据**（编一条规矩比不编更坏）。
import { readFileSync } from 'node:fs'

const R = 'D:/project/DSH/legion'
const rep = readFileSync(`${R}/docs/superpowers/prt/PRT-FINAL-REPORT-2026-09-18.md`, 'utf8')
const itv = readFileSync(`${R}/docs/superpowers/prt/PRT-HUMAN-INTERVENTION-2026-09-20.md`, 'utf8')

const all = (t) => [...t.matchAll(/第 (\d{1,3}) 轮/g)].map((m) => Number(m[1]))
const maxOf = (t) => Math.max(...all(t))

console.log('  ── 候选量 ──')
console.log(`  ① 交付物 §一 自称「追加至第 N 轮」        = ${/追加至第 (\d+) 轮/.exec(rep)?.[1]}`)
console.log(`  ② 交付物 §三 标题「截至第 N 轮」          = ${/截至第 (\d+) 轮/.exec(rep)?.[1]}`)
console.log(`  ③ 交付物里**提到过**的最大轮次            = ${maxOf(rep)}`)
console.log(`  ④ 人工介入清单家族表最大轮次              = ${Math.max(...[...itv.matchAll(/^\| (\d{2}) \|/gm)].map((m) => Number(m[1])))}`)
console.log(`  ⑤ 人工介入清单里**提到过**的最大轮次      = ${maxOf(itv)}`)
console.log(`  ⑥ 交付物 §三 里 「### 3.0*」 小节的轮次最大值 = ${Math.max(...[...rep.matchAll(/^### 3\.0(\d+)/gm)].map((m) => Number(m[1])))}`)

console.log('  ── 交付物里出现过的轮次（去重、降序，前 12） ──')
console.log('    ' + [...new Set(all(rep))].sort((a, b) => b - a).slice(0, 12).join(' '))

console.log('  ── ⇒ 结论 ──')
console.log('  ①②③⑥ 四个候选**互不相同** ⇒ 没有一个"显然"的派生量。')
console.log('  ★ 而 §一 那句的语义是"这份报告被追加/修订到了第几轮"——')
console.log('    那是**最后一次动它**那个轮次，**文档本身推不出来**（它不记录自己被修订过几次）。')
