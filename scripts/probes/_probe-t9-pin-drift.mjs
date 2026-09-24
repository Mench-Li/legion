// scripts/probes/_probe-t9-pin-drift.mjs
// ============================================================================
// **T9**（`dsh-pin-drift` 本地红的处置，2026-09-24）的**变异验证**。
//
// 这条门禁只有两个读数：0（锚点都在）与 1（有锚点找不到）。所以"咬得住"这件事
// 必须证明**是哪些锚点在起作用** —— 否则"我把锚点换成今天真有的那一句"与
// "我把锚点换成了另一句同样找不到的话"，在只看一次 PASS 的读数上是同一个绿。
//
//   ① 把锚点**换回旧的那句**（`plugin: 'user-approval'`）⇒ 门禁必须 FAIL
//      —— 证明旧锚点**真的已经不在了**，这次的绿不是"换个写法凑出来的"；
//   ② 换成一句**看起来很像、但不存在**的 ⇒ 门禁必须 FAIL（判据不是"像不像"）；
//   ③ 砍掉同一条结论的**另一个**锚点（`(changed by the user).`）。
//      ★★ 这一条**门禁看不见**：它核的是"声明的锚点还在不在"，把数组从 2 个删成
//         1 个之后它照样 PASS（15 → 14）。这是本探针当场量到的**真边界**，不是猜的
//         —— 所以"锚点数是声明的强度"单独立了一条判据
//         （`runtime/adapters/dsh/pin-drift.test.mjs` ①），③ 由**它**来咬。
//
//      > 一次"删掉一条引用、而门禁仍然是绿的"提交，
//      > 与一次"引用完好"的提交，在只看门禁的世界里是同一个绿。
//
// 用法：node scripts/probes/_probe-t9-pin-drift.mjs
// ============================================================================
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const FILE = 'runtime/adapters/dsh/session-boundary.mjs'
const GATE = 'scripts/prt/dsh-pin-drift.mjs'
const TEST = 'runtime/adapters/dsh/pin-drift.test.mjs'
const NEW_ANCHOR = "      \"kind: 'user-approval'\","
const OTHER_ANCHOR = "      '(changed by the user).',"

const runGate = () => {
  const r = spawnSync(process.execPath, [GATE], { encoding: 'utf8' })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  return { code: r.status, line: (out.split('\n').find((l) => /^dsh-pin-drift:/.test(l)) ?? '').trim() }
}
const runTest = () => {
  const r = spawnSync(process.execPath, ['--test', TEST], { encoding: 'utf8' })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  const p = /^ℹ pass (\d+)/m.exec(out)
  const f = /^ℹ fail (\d+)/m.exec(out)
  return { code: r.status, line: `pass ${p === null ? '?' : p[1]} · fail ${f === null ? '?' : f[1]}` }
}

const original = readFileSync(FILE, 'utf8')
for (const [label, anchor] of [['当前锚点', NEW_ANCHOR], ['同结论的另一个锚点', OTHER_ANCHOR]]) {
  if ((original.split(anchor).length - 1) !== 1) { console.log(`  ✖ 锚点不唯一：${label}`); process.exit(1) }
}

console.log('基线：')
const baseGate = runGate()
const baseTest = runTest()
console.log(`  门禁 退出码 ${baseGate.code} · ${baseGate.line}`)
console.log(`  判据 退出码 ${baseTest.code} · ${baseTest.line}`)
if (baseGate.code !== 0 || baseTest.code !== 0) { console.log('  ✖ 基线本应是绿的'); process.exit(1) }

let bad = 0
const step = (name, from, to, run, why) => {
  writeFileSync(FILE, original.replace(from, to))
  const r = run()
  const bit = r.code !== 0
  console.log(`变异 ${name}（由${why}咬）：`)
  console.log(`  退出码 ${r.code} · ${r.line} · ${bit ? '✔ 咬住了' : '✖ 没咬住'}`)
  writeFileSync(FILE, original)
  if (!bit) bad += 1
}

try {
  step("① 换回旧锚点 plugin: 'user-approval'", NEW_ANCHOR, "      \"plugin: 'user-approval'\",", runGate, '门禁')
  step('② 换成相似但不存在的一句', NEW_ANCHOR, "      \"kind: 'user-approval-v2'\",", runGate, '门禁')
  step('③ 砍掉同一条结论的另一个锚点', OTHER_ANCHOR, '      // （变异：这个锚点故意删掉）', runTest, 'pin-drift.test ①')
} finally {
  writeFileSync(FILE, original)
}

const same = readFileSync(FILE, 'utf8') === original
const backGate = runGate()
const backTest = runTest()
console.log('还原：')
console.log(`  逐字与变异前一致：${same ? '✔' : '✖'}`)
console.log(`  门禁 退出码 ${backGate.code} · ${backGate.line}`)
console.log(`  判据 退出码 ${backTest.code} · ${backTest.line}`)
if (!same) bad += 1
if (backGate.code !== 0 || backTest.code !== 0) bad += 1
console.log(bad === 0 ? '\n⇒ 三个方向都咬住（③ 由另一条判据咬），且文件已逐字还原。' : `\n⇒ 有 ${bad} 处不符合预期。`)
process.exit(bad === 0 ? 0 : 1)
