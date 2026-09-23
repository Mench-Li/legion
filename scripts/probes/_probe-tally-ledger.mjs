// scripts/probes/_probe-tally-ledger.mjs —— `tallyLedger` 认不出 🟡 时会怎样？
//
// ★ 起因（第 44 轮）：`PRT-316` 的状态从 ⬜ 变成 **🟡**（"部分"，台账汇总行
//   写的是「已完成 140 / **部分 1** / 未开始 0 / 需外部输入 4 / 合计 145」）。
//
//   而 `scripts/prt/boundary-facts.mjs` 的 `tallyLedger` 只认三个标记：
//
//       const st = cells.map(c => c.trim()).find(c => /^(✅|⏸|⬜)/.test(c))
//       if (st === undefined) continue          // ← ★ 不认识的**静默跳过**
//
//   ⇒ 那一条既不计入 `total`、也不计入任何一档。
//
//   > 一个"不认识的标记就跳过"的解析器，与一个"台账真的只有 144 行"的台账，
//   > 在它的返回值里是同一个东西——
//   > 只不过前者会随着**每一个新状态**安静地少算一条。
//
//   本探针量三件事：
//     ① 🟡 那一条到底有没有被数进去；
//     ② 全仓有多少条 `| PRT-` 行**没有任何可识别的状态标记**（决定能不能"抛"）；
//     ③ 台账自己写的合计行是多少（拿它当独立的一侧来对）。
import { readFileSync } from 'node:fs'

const F = 'D:/project/DSH/legion/docs/superpowers/prt/PRT-PROGRESS.md'
const text = readFileSync(F, 'utf8')
const lines = text.split(/\r?\n/)

const KNOWN = /^(✅|🟡|⏸|⬜)/

// ── ① 复刻 tallyLedger（旧版）的实际行为 ──
let done = 0, paused = 0, todo = 0, total = 0
const skipped = []
for (let i = 0; i < lines.length; i++) {
  const line = lines[i]
  if (!/^\|\s*PRT-\d+/.test(line)) continue
  const cells = line.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/)
  if (cells.length < 2) continue
  const st = cells.map((c) => c.trim()).find((c) => /^(✅|⏸|⬜)/.test(c))
  if (st === undefined) { skipped.push({ ln: i + 1, head: line.slice(0, 60) }); continue }
  total += 1
  if (st.startsWith('✅')) done += 1
  else if (st.includes('⏸')) paused += 1
  else if (st.includes('⬜')) todo += 1
}
console.log('  旧 tallyLedger 读数：', JSON.stringify({ total, done, paused, todo }))

// ── ② 列出被跳过 / 被认识的每一个状态标记 ──
const tallyByMarker = new Map()
for (let i = 0; i < lines.length; i++) {
  const line = lines[i]
  if (!/^\|\s*PRT-\d+/.test(line)) continue
  const cells = line.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/)
  if (cells.length < 2) continue
  const st = cells.map((c) => c.trim()).find((c) => KNOWN.test(c))
  const key = st === undefined ? '（没有任何已知标记）' : st[0]
  tallyByMarker.set(key, (tallyByMarker.get(key) ?? 0) + 1)
}
console.log('  按标记分（含 🟡）：')
for (const [k, v] of [...tallyByMarker.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${k}  ${v}`)
}

// ── ③ 真实 PRT- 行总数（不看状态，只看行）──
const prtRows = lines.filter((l) => /^\|\s*PRT-\d+/.test(l)).length
console.log(`  ★ 真实 | PRT- 行数 = ${prtRows} ；旧版数出的 total = ${total}`)
if (prtRows !== total) {
  console.log(`  ⇒ **少算了 ${prtRows - total} 条**，而被跳过的正是：`)
  for (const s of skipped) console.log(`     L${s.ln}: ${s.head}`)
}

// ── ④ 台账自己写的合计行（独立的一侧）──
const sumRow = lines.find((l) => /^\|\s*\*\*合计\*\*/.test(l))
console.log('  台账合计行：', sumRow ? sumRow.trim() : '（没找到）')
