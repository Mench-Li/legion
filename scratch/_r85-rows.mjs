// scratch/_r85-rows.mjs —— 第 85 轮：那 21 条红**今天仍然红**，逐套件复现
import { readFileSync, writeFileSync } from 'node:fs'

const I = 'D:/project/DSH/legion/docs/superpowers/prt/PRT-HUMAN-INTERVENTION-2026-09-20.md'
let t = readFileSync(I, 'utf8')
const eol = t.includes('\r\n') ? '\r\n' : '\n'
const bad = []
const sub = (from, to) => {
  const f = from.split('\n').join(eol)
  const tt = to.split('\n').join(eol)
  const n = t.split(f).length - 1
  if (n !== 1) { bad.push(`  x 命中 ${n} 次：${from.slice(0, 44)}`); return }
  t = t.replace(f, tt)
}
sub('**第 84 轮结束时的读数**（全部可复跑）：', '**第 85 轮结束时的读数**（全部可复跑）：')

if (!/^\| 85 \|/m.test(t)) {
  const ROW = '| 85 | ★★★★★ **那 21 条红今天仍然红（逐套件复现，数一模一样）** —— '
    + '第 84 轮那次完整 CI **没量到**它们（`test` 在**套件登记闸门**上 4.9 秒就退了），'
    + '所以本轮**直接跑那五个套件**，把数摊开：'
    + '`runtime-contract-cross-process` **10 通过 / 9 失败**、`runtime-host-row-dsh-process` **5 / 5**、'
    + '`runtime-host-binding-unblocked-dsh-process` **3 / 4**、`runtime-host-registrar-row-dsh-process` **4 / 2**、'
    + '`model-api` **14 / 1** ⇒ **合计 36 通过 / 21 失败**。'
    + '★★★★★ **与第 63 轮量到的 21 条一字不差** ⇒ 那一批读数**被独立复现了**（不是一次性的）。'
    + '★ 于是"要不要允许自动执行"（**Ⅰ**）现在有一个精确的分母：**21 条用例，今天在 HEAD 上仍然红，可随时复跑**。'
    + '★ 同时把两件事分开记：这 21 条是**产品侧的**；而完整 CI 的 `test` FAIL 是**另一件事**'
    + '（~16 个 `team-hub/*-routes.test.mjs` 未登记 = 并行会话的 WIP）。'
    + '> 一个"CI 是红的"里，同时装着"产品有 21 条红"与"有人还没登记新套件" ——'
    + '> 而这两件事的**负责人、修法、紧急度都不同**。 |'
  const lines = t.split('\n')
  const i84 = lines.findIndex((l) => /^\| 84 \|/.test(l))
  if (i84 < 0) bad.push('  x 找不到 | 84 |')
  else { lines.splice(i84 + 1, 0, ROW); t = lines.join('\n'); console.log('  OK 家族表加第 85 行') }
}

if (bad.length > 0) { for (const b of bad) console.log(b); process.exit(1) }
writeFileSync(I, t)
const m = /⇒ \S*套件合计 \*\*(\d+) 通过 \/ 0 失败\*\*/.exec(t)
const head = t.slice(0, m.index)
const block = head.slice(head.lastIndexOf('结束时的读数'))
let sum = 0
for (const x of block.matchAll(/\*\*(\d+)\/(\d+)\*\*/g)) sum += Number(x[1])
console.log(`  逐项求和 = ${sum}；声明 ${m[1]}  ${sum === Number(m[1]) ? 'OK 一致' : 'x 不一致'}`)
process.exit(sum === Number(m[1]) ? 0 : 1)
