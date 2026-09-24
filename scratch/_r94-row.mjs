// scratch/_r94-row.mjs —— 第 94 轮家族行
import { readFileSync, writeFileSync } from 'node:fs'

const I = 'D:/project/DSH/legion/docs/superpowers/prt/PRT-HUMAN-INTERVENTION-2026-09-20.md'
let t = readFileSync(I, 'utf8')
const lines = t.split('\n')
const i93 = lines.findIndex((l) => /^\| 93 \|/.test(l))
if (i93 < 0) { console.log('  x 找不到 | 93 |'); process.exit(1) }

const ROW = '| 94 | ★★★★★ **用第 91～93 轮的量法把 Ⅰ 的重量称准：`DECISION-BRIEF.md` 原来把 PRT-253 归进了"您不需要做任何事"** —— '
  + '本轮按第 91～93 轮的读数重写了 Ⅰ 那三条路的代价，并顺着去核**另一份决策文档**，撞到一件更重的事：'
  + '`docs/DECISION-BRIEF.md` §3 的标题是「不是裁决——等日期 / 等环境（**您不需要做任何事**）」，'
  + '**而 PRT-253 就在那张表里**（原文：「剩下是平台边界（Windows 上不会有自动执行）」）。'
  + '★★ 而**第 68 轮已把那个读法证伪**（启动自检**恒**判不兼容：四项必需能力里三项是写死的 `satisfied: false`，'
  + '`autoExecutionForbidden` 恒 true、与本机平台无关）⇒ PRT-253 等的对象**在这条路上不存在**；'
  + '★★★ 而这一页**通篇没有提到那 21 条红**（`git grep` 过：无 "21 条"、无 "转红"）。'
  + '⇒ 一份"告诉业主该说什么话"的文档，把一个**需要决定**的项归进"您不需要做任何事" —— '
  + '那是这份文档能犯的**最重**的一种错：它把一个项从业主的视野里**移出去**。'
  + '★ 已修：§3 标题加限定 + 那一格**划掉并指向新写的 §3A**（§3A 记了那 21 条的三簇、【乙不是发明】（第 93 轮）、'
  + '以及重写后的三条路代价）。'
  + '★ 同时重写了 Ⅰ 那三条路：**乙** 原文写「等于把"执行器不可用"**写成**预期」，而第 93 轮量到'
  + '**那个预期仓里已经有**（同文件头 `:374` 写 `dshRuntimeBound() === false`、② 断言 `incompatible` 且 **② 是绿的**）'
  + '⇒ **乙不是发明规范**，且**甲（放宽自检）因此更不该选**，**丙**要改引擎契约（不在本仓范围内）。'
  + '★★★★★ 一句：**您只需要说"按乙办"** —— 而这一页原来把这一项写成"您不需要做任何事"。 |'

lines.splice(i93 + 1, 0, ROW)
t = lines.join('\n')
writeFileSync(I, t)
console.log('  OK 家族表加第 94 行')

const m = /⇒ \S*套件合计 \*\*(\d+) 通过 \/ 0 失败\*\*/.exec(t)
const head = t.slice(0, m.index)
const block = head.slice(head.lastIndexOf('结束时的读数'))
let sum = 0
for (const x of block.matchAll(/\*\*(\d+)\/(\d+)\*\*/g)) sum += Number(x[1])
console.log(`  逐项求和 = ${sum}；声明 ${m[1]}  ${sum === Number(m[1]) ? 'OK 一致' : 'x 不一致'}`)
process.exit(sum === Number(m[1]) ? 0 : 1)
