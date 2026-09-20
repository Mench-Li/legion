// scratch/_probe-r101-width.mjs —— 第 101 轮：`isFamilyHistoryRow` 的 `\d{1,2}` 是不是与第 100 轮那个洞同一类？
//
// ★ 假设：家族表第 100 行（`| 100 |`，三位）**不匹配** `/^\|\s*\d{1,2}\s*\|/`，
//   于是它**不被当成"历史行"豁免** ⇒ 一旦它的正文里出现台账分档串（`140 ✅ / 1 🟡 / 4 ⏸ / 0 ⬜`），
//   判据会报"有 1 处**没有登记**" —— 而真正的病根是"正则只认两位"。
//
// ① 先量：今天家族表里有没有三位数行、它们的正文里有没有分档串
// ② 再量：造一行三位数 + 分档串，判据会不会红（红 ⇒ 确认是同一个洞）
import { readFileSync } from 'node:fs'

const R = 'D:/project/DSH/legion'
const I = `${R}/docs/superpowers/prt/PRT-HUMAN-INTERVENTION-2026-09-20.md`
const t = readFileSync(I, 'utf8')
const lines = t.split(/\r?\n/)

const TIER = /140 ✅ \/ 1 🟡 \/ 4 ⏸ \/ 0 ⬜/
const FAM2 = /^\|\s*\d{1,2}\s*\|/
const FAM3 = /^\|\s*\d{1,3}\s*\|/

console.log('  ── ① 家族表里三位数行（`| 100 |` 起）──')
lines.forEach((l, i) => {
  if (/^\|\s*\d{3}\s*\|/.test(l)) {
    console.log(`    L${i + 1}  ${l.trim().slice(0, 72)}`)
    console.log(`         匹配 \\d{1,2} 豁免？ ${FAM2.test(l) ? '是' : '★ 否（会被当成"抄写"）'}`)
    console.log(`         正文含台账分档串？ ${TIER.test(l) ? '★ 是 ⇒ 今天就会红' : '否 ⇒ 今天侥幸不红'}`)
  }
})

console.log('  ── ② 两位与三位豁免的命中总数 ──')
console.log(`    \\d{1,2} 命中 ${lines.filter((l) => FAM2.test(l)).length} 行`)
console.log(`    \\d{1,3} 命中 ${lines.filter((l) => FAM3.test(l)).length} 行`)

console.log('  ── ③ 造一行「三位数 + 分档串」会怎样 ──')
const probe = `| 101 | ★ 探针行：这里故意写一遍台账分档 140 ✅ / 1 🟡 / 4 ⏸ / 0 ⬜ |`
console.log(`    该行匹配 \\d{1,2} 豁免？ ${FAM2.test(probe) ? '是' : '★ 否'}  ⇒ ${
  FAM2.test(probe) ? '会被豁免，不会红' : '会被判为未登记的抄写 ⇒ 报"没有登记"（而病根是正则）'}`)
console.log(`    该行匹配 \\d{1,3} 豁免？ ${FAM3.test(probe) ? '是' : '否'}`)

console.log('  ── ④ 顺手量另一处 `\\d{1,2}`（`第 N 条`）──')
const sec = [...t.matchAll(/第\s*(\d{1,2})\s*条/g)].map((m) => Number(m[1]))
const sec3 = [...t.matchAll(/第\s*(\d{1,3})\s*条/g)].map((m) => Number(m[1]))
console.log(`    本文件：\\d{1,2} 命中 ${sec.length} 处 max=${Math.max(...sec)}；\\d{1,3} 命中 ${sec3.length} 处 max=${Math.max(...sec3)}`)
console.log(`    ⇒ ${Math.max(...sec3) === Math.max(...sec) ? '今天两者一致（但 §5 的条目数一旦过 99 就会分叉）' : '★ 今天就已经分叉'}`)
