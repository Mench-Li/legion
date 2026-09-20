// scratch/_r88-row.mjs —— 第 88 轮：家族表第 88 行
import { readFileSync, writeFileSync } from 'node:fs'

const I = 'D:/project/DSH/legion/docs/superpowers/prt/PRT-HUMAN-INTERVENTION-2026-09-20.md'
let t = readFileSync(I, 'utf8')
const lines = t.split('\n')
const i87 = lines.findIndex((l) => /^\| 87 \|/.test(l))
if (i87 < 0) { console.log('  x 找不到 | 87 |'); process.exit(1) }

const ROW = '| 88 | ★★★★★ **"请先看它"那一节把**症状**写成了"根因"**（读的人会去修一个修不好门禁的地方）—— '
  + '§三之三 开头那五行把 `isRuntimeOnlyRow` / `inject: [ENFORCEMENT_ROOT_SERVICE]` 讲成 ★★★ **根因**，'
  + '而**同节下面引的那两行注释**说的是**另一层**（"四项必需能力里三项如实报未确认"）。'
  + '★ 第 63～68 轮量到**决定性的那一层是后者**：那三项在源码里是**写死的 `satisfied: false` 字面量**'
  + '（`runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs` 的 `runtimeCapabilityEvidence()` 函数体内恰好 3 处），'
  + '而 probe 要求"**显式为 true**" ⇒ **`autoExecutionForbidden` 恒为 true，与本机平台无关**。'
  + '⇒ **一个照那五行去修 `isRuntimeOnlyRow` / `inject` 的人，会发现门禁还是红的** —— '
  + '那两行**挂上或摘掉行为等价**（它们自己的注释就这么写）⇒ "未激活"是**症状**，真正的开关是**那三个常量**。'
  + '★ 已加一条**标了轮次**的定界注（第 63 轮那段读数**一字未改**）。'
  + '> 一份把**症状**写成"根因"的报告，会让接手的人**修一个修不好门禁的地方**，'
  + '> 然后得出"这个仓库的自检根本修不动"这个结论 —— 而那个结论是错的。 |'

lines.splice(i87 + 1, 0, ROW)
t = lines.join('\n')
writeFileSync(I, t)
console.log('  OK 家族表加第 88 行')

const m = /⇒ \S*套件合计 \*\*(\d+) 通过 \/ 0 失败\*\*/.exec(t)
const head = t.slice(0, m.index)
const block = head.slice(head.lastIndexOf('结束时的读数'))
let sum = 0
for (const x of block.matchAll(/\*\*(\d+)\/(\d+)\*\*/g)) sum += Number(x[1])
console.log(`  逐项求和 = ${sum}；声明 ${m[1]}  ${sum === Number(m[1]) ? 'OK 一致' : 'x 不一致'}`)
process.exit(sum === Number(m[1]) ? 0 : 1)
