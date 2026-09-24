// scratch/_r95-row.mjs —— 第 95 轮家族行
import { readFileSync, writeFileSync } from 'node:fs'

const I = 'D:/project/DSH/legion/docs/superpowers/prt/PRT-HUMAN-INTERVENTION-2026-09-20.md'
let t = readFileSync(I, 'utf8')
const lines = t.split('\n')
const i94 = lines.findIndex((l) => /^\| 94 \|/.test(l))
if (i94 < 0) { console.log('  x 找不到 | 94 |'); process.exit(1) }

const ROW = '| 95 | ★★★★★ **本文件开头那一节给您的动作是错的**（第 67/68/70 轮已证伪）—— '
  + '§一 原来写「需要谁做什么：**给一个能跑真实自动执行的环境**（非 Windows，或把 §4 第 15 条那条边界解除）。'
  + '拿到之后，PRT-009 与 PRT-253 两条可以**一起**收口」。'
  + '★ 而**第 67/68 轮量到的主因不是那个边界**：真正的拦路是**启动自检恒不兼容** —— '
  + '`runtimeCapabilityEvidence()` 要的四项必需能力里**三项是写死的 `satisfied: false` 字面量**，'
  + '而 probe 要求"显式为 true" ⇒ **`autoExecutionForbidden` 恒为 true，与平台无关**；'
  + '★★ 第 70 轮又量到 `docs/STATUS.md:13264` 那条「Windows 上不会有自动执行」是一次**裁定**'
  + '（它自己在 `:13280` 标注「① 这是**裁定**，不是量出来的结论」），覆盖的是**另一类**待办。'
  + '⇒ **两条独立原因，而换平台不会解除任何一条**（换 Linux，自检仍恒不兼容）。'
  + '★★★ **所以那一节把您引向一个"做了也没用"的动作** —— 而它是这份文件的**第一节**。已加更正（保留原文）。'
  + '★ 同时修两处陈旧读数：**口径行**（原文 HEAD `062130e` / `.ci/r45c` 7/9 / 复核到第 45 轮 —— 三处都是第 45 轮那会儿的）'
  + '改成 r84-full **8/9** + 复核到第 95 轮 + 记明"那次 test 4.9 秒就退、没测到 21 条"；'
  + '以及 **L24 那处相对日数**（「今天 2026-09-20，还差 4 天」）—— ★★ **第 89 轮我漏了它**'
  + '（当时 grep 到了那一行，但我按截断的 140 字**以为**它写的是绝对日期）。'
  + '★★★★★ 一句：**这份文件的"第一节"与"第 94 轮修的那份简报的 §3"犯的是同一个错** —— '
  + '都在第一屏把一个项说成"您不用做什么"或"您做这个"，而两种说法的方向都错了。 |'

lines.splice(i94 + 1, 0, ROW)
t = lines.join('\n')
writeFileSync(I, t)
console.log('  OK 家族表加第 95 行')

const m = /⇒ \S*套件合计 \*\*(\d+) 通过 \/ 0 失败\*\*/.exec(t)
const head = t.slice(0, m.index)
const block = head.slice(head.lastIndexOf('结束时的读数'))
let sum = 0
for (const x of block.matchAll(/\*\*(\d+)\/(\d+)\*\*/g)) sum += Number(x[1])
console.log(`  逐项求和 = ${sum}；声明 ${m[1]}  ${sum === Number(m[1]) ? 'OK 一致' : 'x 不一致'}`)
process.exit(sum === Number(m[1]) ? 0 : 1)
