// scratch/_r86-rows.mjs —— 第 86 轮：用第 75 轮的方法去核 §5 第 16 条 —— **它不是同一个形状**
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
sub('**第 85 轮结束时的读数**（全部可复跑）：', '**第 86 轮结束时的读数**（全部可复跑）：')

const ANCHOR = '#### ★★★★ 第 76 轮：#28 的施工清单钉到**三个改点**'
const at = t.indexOf(ANCHOR)
if (at < 0) bad.push('  x 找不到第 76 轮那节的锚点')
else {
  const SEC = [
    '#### ★★★★ 第 86 轮：拿第 75 轮的方法去核 §5 第 16 条 —— **它不是同一个形状**（负结果）',
    '',
    '第 75 轮把 **§5 第 28 条**从"待裁决"改判成"待施工"（缺的是一处接线，不是一次取舍）。',
    '一个自然的下一步是：**§5 第 16 条是不是同一种？** 本轮去核了，答案是否。',
    '',
    '**怎么核的**：§5 第 16 条管的是阶段 9 的产品级动作（含 §7 那几个度量模块），',
    '投影到 §9 链上是 **L9** 的 `product/lifecycle/retention.mjs`。读它的签名：',
    '',
    '```js',
    'export function planRetention({ entries = [], policy = DEFAULT_RETENTION, nowMs, activeRefs = [] } = {})',
    'export function assertRetentionBounded(policy = DEFAULT_RETENTION)',
    '```',
    '',
    '★ **它是纯的**：不看 `process.env`、不要 `dataDir`、不碰进程 —— 是个 `(entries, policy, now) → plan` 的规划器。',
    '',
    '#### ⇒ 两条结论',
    '',
    '1. **它与 #28 不同形**：#28 缺的是"**把已经定死的位置告诉第三个读者**"（三处接线）；',
    '   而 `retention` 缺的是"**谁来提供 `entries`、谁来按节奏触发**" —— 那是一**归属**问题，',
    '   本仓的规矩是周期动作归 **Launcher**（`product/launcher/supervisor.mjs` 管进程生命周期）。',
    '2. **所以 §5 第 16 条仍然是一条裁决**，我**没有**照第 75 轮的样子把它也改成"我施工"。',
    '',
    '★★★★★ **这一条负结果比一条正结果更值得记**：',
    '',
    '> 第 75 轮那次改判是**对一个具体缺陷形状**的读数，不是一条"所有裁决其实都是接线"的规律。',
    '> 一个把那次读数推广成规律的 agent，会接着去**替业主选一个 `retention` 的归属** ——',
    '> 而那正是这个仓库一直在防的那类改动：**用一个看起来合理的决定，替掉一个该被问的问题。**',
    '',
    '★ 我把它写成负结果，是为了让下一个读到 §5 第 16 条的人**不必重新核一遍**，',
    '而不是为了说明"两条很像"。',
    '',
  ].join('\n')
  t = t.slice(0, at) + SEC + t.slice(at)
  console.log('  OK §三之三 已插入第 86 轮负结果')
}

if (!/^\| 86 \|/m.test(t)) {
  const ROW = '| 86 | ★★★★ **拿第 75 轮的方法去核 §5 第 16 条 —— 它不是同一个形状（负结果）** —— '
    + '第 75 轮把 **§5 第 28 条**从"待裁决"改判成"待施工"；自然的下一步是问"第 16 条是不是同一种？"。'
    + '★ 本轮去核：第 16 条投影到 §9 链上是 **L9** 的 `product/lifecycle/retention.mjs`，而读它的签名 ——'
    + '`planRetention({ entries, policy, nowMs, activeRefs })` / `assertRetentionBounded(policy)` —— '
    + '**它是纯的**：不看 `process.env`、不要 `dataDir`、不碰进程（是个 `(entries, policy, now) → plan` 的规划器）。'
    + '⇒ **它与 #28 不同形**：#28 缺的是"把已经定死的位置告诉第三个读者"（三处接线）；'
    + '`retention` 缺的是"**谁来提供 `entries`、谁来按节奏触发**" = 一**归属**问题（本仓规矩：周期动作归 Launcher）。'
    + '★★ **所以 §5 第 16 条仍然是一条裁决**，我**没有**照第 75 轮的样子把它也改成"我施工"。'
    + '★★★★★ **这一条负结果比一条正结果更值得记**：'
    + '> 第 75 轮那次改判是**对一个具体缺陷形状**的读数，不是一条"所有裁决其实都是接线"的规律。'
    + '> 一个把那次读数推广成规律的 agent，会接着去**替业主选一个 `retention` 的归属** ——'
    + '> 而那正是这个仓库一直在防的那类改动：**用一个看起来合理的决定，替掉一个该被问的问题。** |'
  const lines = t.split('\n')
  const i85 = lines.findIndex((l) => /^\| 85 \|/.test(l))
  if (i85 < 0) bad.push('  x 找不到 | 85 |')
  else { lines.splice(i85 + 1, 0, ROW); t = lines.join('\n'); console.log('  OK 家族表加第 86 行') }
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
