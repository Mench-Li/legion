// scratch/_probe-spec-status.mjs —— 规格文档标题里的状态注记 vs 状态表的实际状态（**不提交**）
import { readFileSync } from 'node:fs'

const ROOT = 'D:/project/DSH/legion'
const spec = readFileSync(`${ROOT}/docs/MULTI-AGENT-FEATURE-OPTIMIZATION.md`, 'utf8')
const status = readFileSync(`${ROOT}/docs/MULTI-AGENT-FEATURE-STATUS.md`, 'utf8')

// ── 规格侧：`#### F-NN 标题（注记）`
const INCOMPLETE = /待补|收口|待完成|尚未|未完成|部分/
const specMap = new Map()
for (const m of spec.matchAll(/^####\s*(F-\d+)\s+([^\n（(]*)(?:[（(]([^）)]*)[）)])?\s*$/gm)) {
  const [, id, title, note] = m
  specMap.set(id, { title: title.trim(), note: note === undefined ? null : note.trim() })
}

// ── 状态侧：主表 + P1/P2 表的 F-NN → 状态集合
const statusMap = new Map()
for (const line of status.split(/\r?\n/)) {
  if (!/^\|\s*F-\d+/.test(line)) continue
  const cells = line.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim())
  if (cells.length !== 5 && cells.length !== 6) continue
  const key = /^(F-\d+)/.exec(cells[0])[1]
  if (!statusMap.has(key)) statusMap.set(key, [])
  statusMap.get(key).push({ row: cells[0], status: cells[2] })
}

console.log('规格侧带注记的标题：')
let stale = 0
for (const [id, v] of specMap) {
  if (v.note === null) continue
  const srows = statusMap.get(id) ?? []
  const assertInc = INCOMPLETE.test(v.note)
  // 该 F-NN 的每一行状态是否都已 ✅
  const allDone = srows.length > 0 && srows.every((r) => /✅\s*$/.test(r.status.replace(/\s/g, '')))
  const mark = assertInc && allDone ? '  ✖ 注记说没做完，表里全 ✅' : ''
  if (assertInc && allDone) stale += 1
  console.log(`  ${id}  注记=「${v.note}」`)
  console.log(`       规格说没做完 ? ${assertInc}   表里全 ✅ ? ${allDone}（${srows.map((r) => r.row + '=' + r.status).join(' / ') || '表里没有这一行'}）${mark}`)
}
console.log(`\n✖ 过期的注记：${stale} 条（共 ${[...specMap.values()].filter((v) => v.note !== null).length} 条带注记）`)
