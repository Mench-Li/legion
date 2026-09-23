// scripts/probes/_probe-positional-reason.mjs —— 第 49 轮：位置指称在今天的真表上报出几条
import { readFileSync } from 'node:fs'

const ROOT = 'D:/project/DSH/legion'
const { positionalReasonViolations } = await import(`file://${ROOT}/scripts/prt/reachability.mjs`)
const arr = JSON.parse(readFileSync(`${ROOT}/docs/superpowers/prt/prt-reachability-baseline.json`, 'utf8')).unreachable

console.log('第 49 轮：`reason` 里的位置指称\n')
const bad = positionalReasonViolations(arr)
console.log(`  44 条里用位置指称的 ${arr.filter((e) => /同上|上面那条|上一条/.test(e.reason ?? '')).length} 条`)
console.log(`  其中**指不上**的：${bad.length} 条\n`)
for (const b of bad) {
  console.log(`    ✖ ${b.file}`)
  console.log(`        ${b.why}`)
}

// ★ 反向控制：一条**合法**的同组指称不许被报出来
const OK = [
  { file: 'a.mjs', class: 'deliberate', reason: '升级链的一环' },
  { file: 'b.mjs', class: 'deliberate', reason: '同上（升级链的一环）' },
  { file: 'c.mjs', class: 'deliberate', reason: '同上（升级链的一环）' },
]
console.log(`\n  反向控制（三条同组 deliberate）：报出 ${positionalReasonViolations(OK).length} 条（应为 0）`)

// ★ 正对照：把 spool 那条的错位**复原**（把收账侧移到它上面）⇒ 应该不再报
const fixedOrder = arr.filter((e) => e.file !== 'orchestrator/worker/toolcall-drain.mjs')
const di = fixedOrder.findIndex((e) => e.file === 'runtime/toolcall/spool.mjs')
fixedOrder.splice(di, 0, arr.find((e) => e.file === 'orchestrator/worker/toolcall-drain.mjs'))
const after = positionalReasonViolations(fixedOrder).filter((b) => b.file === 'runtime/toolcall/spool.mjs')
console.log(`  正对照（把收账侧移到 spool 上面）：spool 仍被报 ${after.length} 条（应为 0）`)
