// scratch/_r97b-dedupe.mjs —— 第 97 轮：把**重复的**那处声明去掉，只留一处可判的
//
// ★ 量到：同一句「家族表（逐轮到第 N 行）」在交付物里出现**两次**（L10 与 L230）。
//   ★★ 而本套件的 claim 模型**要求锚点唯一**（命中多于一处 ⇒ `ANCHOR_AMBIGUOUS` 判红；
//      见 `boundary-facts.mjs:1054-1064` 那段，它在同一个形状上踩过一次）。
//   ★★★ 所以正确做法**不是**"用加粗形状只钉住其中一处"（那会把另一处**留给手**），
//       而是**把那处重复的声明去掉** —— 让这个数**只在一处**被声明，然后钉住它。
//
//   > 一个"两处都写着同一个数"的文档，与一个"只有一处写了、另一处指向它"的文档，
//   > 在"下一轮会不会漂"这个读数上不一样：前者要改两处，后者只需改一处。
import { readFileSync, writeFileSync } from 'node:fs'

const D = 'D:/project/DSH/legion/docs/superpowers/prt/PRT-FINAL-REPORT-2026-09-18.md'
let t = readFileSync(D, 'utf8')
const eol = t.includes('\r\n') ? '\r\n' : '\n'
const bad = []
const sub = (from, to) => {
  const f = from.split('\n').join(eol)
  const tt = to.split('\n').join(eol)
  const n = t.split(f).length - 1
  if (n !== 1) { bad.push(`  x 命中 ${n} 次：${from.slice(0, 50)}`); return }
  t = t.replace(f, tt)
}

// 把 L230 那处**重复的**声明去掉数字（改成指向唯一那处）
sub(
  '> `./PRT-HUMAN-INTERVENTION-2026-09-20.md` 的 §三之三（第 63 轮起）与家族表（逐轮到第 77 行）。',
  '> `./PRT-HUMAN-INTERVENTION-2026-09-20.md` 的 §三之三（第 63 轮起）与家族表（逐轮一行）。\n'
  + '> ★★ **第 97 轮**：这里原来也写着一个行数（「逐轮到第 **77** 行」），而本报告头部那行**也写**着同一个数\n'
  + '> ⇒ 同一个声明**散在两处**，改一处漏一处。本轮把那处去掉了数字，只留头部**一处**可判\n'
  + '> （判据 `report-family-rows-round`），**并且**它当时**已经是错的**（77，真实是 96）。',
)

if (bad.length > 0) { for (const b of bad) console.log(b); process.exit(1) }
writeFileSync(D, t)
console.log('  OK L230 那处重复声明已去掉数字（只留一处可判）')
