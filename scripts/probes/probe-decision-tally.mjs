#!/usr/bin/env node
/**
 * 量具：把 `docs/MULTI-AGENT-FEATURE-STATUS.md` §5 那张决策表的**状态合计**
 * 按唯一的派生实现算一遍，并与文档里**写下来的两个地方**逐字对照。
 *
 * 为什么要这个量具（第三十八轮）：
 *   那张 29 行的表有 **两个** 会写状态的地方 —— ① §5.0.1 的索引表逐行，
 *   ② 索引表末尾那句「⇒ **合计**：已裁决 N · …」。
 *   而 `decisionStateViolations()` 此前只盯 ①（逐行是否等于派生值）。
 *   ⇒ ② 是一句**没人核对的数字**，而它和它正上方的 29 行处在**同一个代码块**里。
 *
 * > 一处"写下来但没人核对"的计数，与一处"会漂移"的计数，是同一个东西 ——
 * > 只不过前者的读者会以为它被核对过（那条纪律已经在本仓付过 6 次代价）。
 *
 * 用法：`node scripts/probes/probe-decision-tally.mjs`
 * 退出码：0 = 两处都与派生值一致；1 = 有不一致（打印差在哪）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decisionStateRows,
  decisionStateIndex,
  decisionStateViolations,
  ruledElsewhereViolations,
} from '../prt/reachability.mjs'
import { checkBrief } from '../prt/intervention-coverage.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DOC = path.join(ROOT, 'docs', 'MULTI-AGENT-FEATURE-STATUS.md')

const doc = fs.readFileSync(DOC, 'utf8')
const rows = decisionStateRows(doc)

/** ① 派生值：从 §5 正文那 29 行自己带的标记算出来 */
const derived = { 已裁决: 0, 待施工: 0, 待裁决: 0, 未标注: 0 }
for (const r of rows) derived[r.state] += 1

/** ② 索引表逐行写下来的值 */
const index = decisionStateIndex(doc)
const fromIndex = { 已裁决: 0, 待施工: 0, 待裁决: 0, 未标注: 0 }
for (const r of index) fromIndex[r.state] += 1

/** ③ 索引表末尾那句合计写下来的值 */
const line = doc.split('\n').map((l) => l.replace(/\r$/, ''))
  .find((l) => /^⇒ \*\*合计\*\*：已裁决/.test(l))
const fromLine = (() => {
  if (line === undefined) return null
  const g = (label) => {
    const m = new RegExp(`${label}\\s*\\*{0,2}(\\d+)\\*{0,2}`).exec(line)
    return m === null ? null : Number(m[1])
  }
  return {
    已裁决: g('已裁决'),
    待施工: g('待施工'),
    待裁决: g('待裁决'),
    未标注: g('未标注'),
  }
})()

const fmt = (t) => t === null
  ? '（那一句没找到）'
  : `已裁决 ${t.已裁决} · 待施工 ${t.待施工} · 待裁决 ${t.待裁决} · 未标注 ${t.未标注}`
const same = (a, b) => b !== null && a.已裁决 === b.已裁决 && a.待施工 === b.待施工
  && a.待裁决 === b.待裁决 && a.未标注 === b.未标注

console.log(`§5 决策表：派生 ${rows.length} 行；索引表 ${index.length} 行`)
console.log(`  ① 派生（§5 正文各行自己的标记）    ： ${fmt(derived)}`)
console.log(`  ② 索引表逐行相加                  ： ${fmt(fromIndex)}  ${same(derived, fromIndex) ? '✓' : '✗ 与①不符'}`)
console.log(`  ③ 索引表末尾那句「合计」          ： ${fmt(fromLine)}  ${same(derived, fromLine) ? '✓' : '✗ 与①不符'}`)
const v = decisionStateViolations(doc)
console.log(`\n既有判据 decisionStateViolations() 报出 ${v.length} 条：`)
for (const x of v) console.log(`  - ${x.code}: ${x.detail}`)

// ── ④ ★★★ 第四十轮新判据：**索引表滞后于施工**
//   三处齐口同声地说"待裁决"时，上面那条判据一个字都不会说 ——
//   而"待裁决"是不是真的，只有队列/交接文档知道（它记着哪一条已经被裁过、依据是哪个提交）。
const QUEUE_DOCS = fs.readdirSync(path.join(ROOT, 'docs', 'superpowers', 'prt'))
  .filter((f) => /^(PRT-TAKEOVER-QUEUE|PRT-SESSION-REPORT|PRT-HUMAN-INTERVENTION).*\.md$/.test(f))
  .map((f) => ({
    path: `docs/superpowers/prt/${f}`,
    text: fs.readFileSync(path.join(ROOT, 'docs', 'superpowers', 'prt', f), 'utf8'),
  }))
const w = ruledElsewhereViolations({ statusDoc: doc, queueTexts: QUEUE_DOCS })
console.log(`\n新判据 ruledElsewhereViolations()（扫 ${QUEUE_DOCS.length} 份队列/交接文档）报出 ${w.length} 条：`)
for (const x of w) console.log(`  - ${x.code}: ${x.detail}`)

// ── ⑤ ★★★ 第四十一轮：**"要您裁决的那几条，得真的写在给您的清单上"**
//   `checkBriefCount` 一直核**条数**，而**成员**没有判据 ——
//   2026-09-24 量到 §5 里 14 条「未标注」有 3 条（#11 / #15 / #22）根本没进简报。
const brief = checkBrief()
console.log(`\n决策简报覆盖检查：未列的「未标注」${brief.uncovered.length} 条`
  + `（§5 那张表 ${brief.count} 条；简报自己声明的条数 ${brief.stated.join('/') || '（没写）'}）`)
for (const x of brief.violations) console.log(`  - ${x.id}: ${x.message}`)

const bad = !same(derived, fromIndex) || !same(derived, fromLine) || v.length > 0 || w.length > 0
  || brief.violations.length > 0
console.log(`\n⇒ ${bad ? '**有不一致**（见上）' : '**两处都与派生值一致**'}`)
process.exit(bad ? 1 : 0)
