// scripts/probes/_probe-tally-owner.mjs —— 第 46 轮：`tallyLedger` 是不是台账行规则的**第二个所有者**
//
// ★ 起因：上一轮我把"台账状态词表"收敛到 `progress-check.mjs` 一处，
//   并在 `boundary-facts.mjs` L155-157 写下"不再在这里列"。
//
//   **但那只收敛了"有哪些标记"，没收敛"哪些行算台账行、每个标记进哪一档"。**
//   `tallyLedger` 仍然自己：
//     · 自己判"是不是台账行"（`/^\|\s*PRT-\d+/`）—— 与 `ledgerTaskRow` 的规则不同；
//     · 自己分格；
//     · **自己为每个标记写一个 if 分支**（L205-208）—— 这是词表的**第四种**手写形式。
//
// ★ 量三件事：
//   ① 两个所有者对**真台账**的读数一致吗？
//   ② 把第 5 个标记**加进词表**（而不是只放进文档）会怎样？
//      —— 这是 L199 能"找到"它、而 L205-208 没有分支的那条路。
//   ③ 两个所有者的"接受规则"一致吗？（找一行能分开它们的）
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = 'D:/project/DSH/legion'
const { tallyLedger, LEDGER_STATUS_MARKERS } = await import(`file://${ROOT}/scripts/prt/boundary-facts.mjs`)
const { ledgerTaskRow, STATUS_MARKS } = await import(`file://${ROOT}/scripts/prt/progress-check.mjs`)

const LEDGER = `${ROOT}/docs/superpowers/prt/PRT-PROGRESS.md`
const real = readFileSync(LEDGER, 'utf8')

console.log('第 46 轮探针：`tallyLedger` 是台账行规则的第二个所有者吗\n')
console.log('  词表（所有者）：' + STATUS_MARKS.map((s) => s.mark).join(' '))
console.log('  tallyLedger 认的：' + LEDGER_STATUS_MARKERS.join(' '))
console.log('  ⇒ 两者' + (STATUS_MARKS.map((s) => s.mark).join() === LEDGER_STATUS_MARKERS.join() ? '相同' : '**不同**'))

// ── ① 真台账：两个所有者各数出什么 ──
const tl = tallyLedger(real)
console.log('\n① 真台账')
console.log(`  tallyLedger   ：total=${tl.total} done=${tl.done} partial=${tl.partial} paused=${tl.paused} todo=${tl.todo}`)
const sum = tl.done + tl.partial + tl.paused + tl.todo
console.log(`  「四档之和」   ：${sum}  ${sum === tl.total ? '== total ✔' : '≠ total ✖'}`)
let rows = 0
const byStatus = new Map()
for (const line of real.split(/\r?\n/)) {
  let r = null
  try { r = ledgerTaskRow(line) } catch (e) { console.log('  ✖ ledgerTaskRow 抛了：' + e.message.slice(0, 90)); continue }
  if (r === null) continue
  rows += 1
  byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1)
}
console.log(`  ledgerTaskRow ：total=${rows}  ` + [...byStatus].map(([k, v]) => `${k}=${v}`).join(' '))
console.log(`  ⇒ 两个所有者${rows === tl.total ? '一致 ✔（今天）' : `**不一致**：${rows} vs ${tl.total} ✖`}`)

// ── ② 第 5 个标记**进词表**（L199 找得到、L205-208 没分支的那条路）──
//    ★ 做法：不碰仓库文件，而是**复制一份 boundary-facts.mjs**，在副本里
//      给 `STATUS_MARKS` 加第 5 项，再让它 import 真 progress-check 的那个函数。
//      更简单且等价的测法：直接读源码确认 L205-208 的形状，并用一支"影子实现"
//      （与 L199/L205-208 逐行同形）在内存里跑。
console.log('\n② 把第 5 个标记**加进词表**会怎样（L199 能找到、L205-208 没有分支）')
const bfSrc = readFileSync(`${ROOT}/scripts/prt/boundary-facts.mjs`, 'utf8')
const hasFifthBranch = /\b🔵\b/.test(bfSrc)
console.log(`  源码里 L205-208 的分档写法：`)
for (const m of ['✅', '🟡', '⏸', '⬜']) {
  const re = new RegExp(`if \\(st\\.(?:startsWith|includes)\\('${m}'\\)\\)`)
  console.log(`      ${re.test(bfSrc) ? '有分支' : '**缺**   '} ${m}`)
}
console.log(`  ⇒ 分档是**四个手写的 if**（不是从词表派生的）`)
console.log(`     第 5 个标记被加进词表之后：L199 的 \`find\` 会**找到**它 ⇒ 不再抛；`)
console.log(`     然后 L204 \`total += 1\`，而 L205-208 **四个 if 都不成立** ⇒ 那一档**谁都没加**。`)
console.log(`     ⇒ 症状：\`total\` 与「四档之和」**不再相等**，而两个数都会照常返回。`)
console.log('\n  ★ 影子验证（与 L199/L204-208 逐行同形，只是词表多一个）：')
const shadow = (marks, text) => {
  let done = 0; let partial = 0; let paused = 0; let todo = 0; let total = 0
  for (const line of text.split(/\r?\n/)) {
    if (!/^\|\s*PRT-\d+/.test(line)) continue
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/)
    if (cells.length < 2) continue
    const st = cells.map((c) => c.trim()).find((c) => marks.some((m) => c.startsWith(m)))
    if (st === undefined) throw new Error('认不出（这一档与真实现同形）')
    total += 1
    if (st.startsWith('✅')) done += 1
    else if (st.startsWith('🟡')) partial += 1
    else if (st.includes('⏸')) paused += 1
    else if (st.includes('⬜')) todo += 1
  }
  return { total, done, partial, paused, todo }
}
const synth = ['## 阶段 0', '| 任务 | 状态 |', '| --- | --- |',
  '| PRT-001 甲 | ✅ | `a.md` |', '| PRT-002 乙 | 🟡 | `b.md` |',
  '| PRT-003 丙 | ⏸ | `c.md` |', '| PRT-004 丁 | ⬜ | `d.md` |',
  '| PRT-005 戊 | 🔵 | `e.md` |', ''].join('\n')
const s5 = shadow([...STATUS_MARKS.map((s) => s.mark), '🔵'], synth)
const s5sum = s5.done + s5.partial + s5.paused + s5.todo
console.log(`     total=${s5.total} done=${s5.done} partial=${s5.partial} paused=${s5.paused} todo=${s5.todo}`)
console.log(`     四档之和=${s5sum}  vs total=${s5.total}  ⇒ ${s5sum === s5.total ? '平衡' : '**不平衡** ◆'}`)
console.log(`     ${s5sum === s5.total ? '' : '★ 5 条行，四档只收到 4 条 —— 而返回值里没有任何字段说"有一条没归到档里"'}`)

// ── ③ 两个所有者的"接受规则"一致吗 ──
console.log('\n③ 接受规则对照（同一行，两个所有者各怎么读）')
const CASES = [
  ['| PRT-006 己 | ✅🟡 | `f.md` |', '状态格是两个标记'],
  ['| PRT-007 庚 |  ⏸  | `g.md` |', '状态格带空格'],
  ['| PRT-008 辛 | ✅（待复核） | `h.md` |', '状态格带后缀'],
  ['| PRT-009 壬 | ⏸→🟡 | `i.md` |', '箭头写法'],
]
let diverged = 0
for (const [row, label] of CASES) {
  let a
  try { a = '认：' + JSON.stringify(ledgerTaskRow(row)?.status ?? null) } catch (e) { a = '抛：' + e.message.slice(0, 30) }
  let b
  try {
    const r = tallyLedger(['## 阶段 0', '| 任务 | 状态 |', '| --- | --- |', row, ''].join('\n'))
    b = '认：total=' + r.total + ' ✅' + r.done + ' 🟡' + r.partial + ' ⏸' + r.paused + ' ⬜' + r.todo
  } catch (e) { b = '抛：' + e.message.slice(0, 30) }
  const same = (a.startsWith('抛')) === (b.startsWith('抛'))
  if (!same) diverged += 1
  console.log(`  ${same ? '·' : '★'} ${label}`)
  console.log(`      ledgerTaskRow: ${a}`)
  console.log(`      tallyLedger  : ${b}`)
}
console.log(`\n  ⇒ ★ 分歧 ${diverged} 处：两个所有者对**同一行**给出不同读数，而它们都是"台账解析器"。`)
