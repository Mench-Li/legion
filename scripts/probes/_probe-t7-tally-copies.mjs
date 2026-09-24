// scripts/probes/_probe-t7-tally-copies.mjs
// ============================================================================
// **T7**（台账分档串的纳管范围，2026-09-24）的**变异验证**。
//
// "抄了台账分档的文档全部被纳管"这句话有三个可以坏掉的半边：
//   ① 纳管的文档里那个数**被改错**（判据应当数值不符 ⇒ 红）；
//   ② 历史那一处**从登记表里被删掉**（判据应当报"有 1 处没有登记" ⇒ 红）；
//   ③ **新来一份**抄了分档串的文档（普查应当报"未纳管" ⇒ 红）。
//
// ★ ①② 由 ⑰ 咬，③ 由普查（`census-tally-copies.mjs`）咬 —— 两个方向由两个判据分工：
//   只做 ①② 的话，"名单本身不全会长回来"这件事没有人管，而那正是 T7 当初的病因。
//
// 用法：node scripts/probes/_probe-t7-tally-copies.mjs
// ============================================================================
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const TEST = 'scripts/prt/boundary-facts.test.mjs'
const BRIEF = 'docs/DECISION-BRIEF.md'
const TMP = 'docs/_census-probe-tmp.md'
const FROZEN_LINE = "  { doc: 'docs/superpowers/prt/PRT-SESSION-REPORT-2026-09-17.md', starts: '台账 145 行是 138 ✅', where: '会话报告 2026-09-17（T7 登记）' },"

const runTest = () => {
  const r = spawnSync(process.execPath, ['--test', '--test-name-pattern=⑰', TEST], { encoding: 'utf8' })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  return { code: r.status, pass: Number((/^ℹ pass (\d+)/m.exec(out) ?? [])[1] ?? -1), fail: Number((/^ℹ fail (\d+)/m.exec(out) ?? [])[1] ?? -1) }
}
const runCensus = () => {
  const r = spawnSync(process.execPath, ['scripts/probes/census-tally-copies.mjs'], { encoding: 'utf8' })
  return r.status
}

const test0 = readFileSync(TEST, 'utf8')
const brief0 = readFileSync(BRIEF, 'utf8')
if ((test0.split(FROZEN_LINE).length - 1) !== 1) { console.log('  ✖ FROZEN 锚点不唯一'); process.exit(1) }
if ((brief0.split('**146 行 = 141 ✅').length - 1) !== 1) { console.log('  ✖ 简报锚点不唯一'); process.exit(1) }

console.log('基线：')
const b1 = runTest(); const b2 = runCensus()
console.log(`  ⑰ 退出码 ${b1.code} · pass ${b1.pass} · fail ${b1.fail} · 普查退出码 ${b2}`)
if (b1.code !== 0 || b2 !== 0) { console.log('  ✖ 基线本应是绿的'); process.exit(1) }

let bad = 0
const restore = () => {
  writeFileSync(TEST, test0); writeFileSync(BRIEF, brief0)
  if (existsSync(TMP)) rmSync(TMP)
}
try {
  // ① 纳管文档里的数被改错
  writeFileSync(BRIEF, brief0.replace('**146 行 = 141 ✅', '**146 行 = 148 ✅'))
  let r = runTest()
  let bit = r.code !== 0
  console.log('变异 ① 决策简报那个数被改成 148 ✅：')
  console.log(`  ⑰ 退出码 ${r.code} · pass ${r.pass} · fail ${r.fail} · ${bit ? '✔ 咬住了' : '✖ 没咬住'}`)
  if (!bit) bad += 1
  restore()

  // ② 历史那一处从登记表里被删掉
  writeFileSync(TEST, test0.replace(FROZEN_LINE, '  // （变异：这一行故意删掉）'))
  r = runTest()
  bit = r.code !== 0
  console.log('变异 ② 会话报告那条历史登记被删掉：')
  console.log(`  ⑰ 退出码 ${r.code} · pass ${r.pass} · fail ${r.fail} · ${bit ? '✔ 咬住了' : '✖ 没咬住'}`)
  if (!bit) bad += 1
  restore()

  // ③ 新来一份抄了分档串的文档
  writeFileSync(TMP, '# 临时探针文档\n\n台账 **146 行 = 141 ✅ / 1 🟡 / 4 ⏸ / 0 ⬜**\n', 'utf8')
  const c = runCensus()
  bit = c !== 0
  console.log('变异 ③ 新加一份抄了分档串、而没登记的文档：')
  console.log(`  普查退出码 ${c} · ${bit ? '✔ 咬住了' : '✖ 没咬住'}`)
  if (!bit) bad += 1
  restore()
} finally {
  restore()
}

const same = readFileSync(TEST, 'utf8') === test0 && readFileSync(BRIEF, 'utf8') === brief0 && !existsSync(TMP)
const back1 = runTest(); const back2 = runCensus()
console.log('还原：')
console.log(`  两份文件逐字一致：${same ? '✔' : '✖'} · ⑰ 退出码 ${back1.code} · 普查退出码 ${back2}`)
if (!same) bad += 1
if (back1.code !== 0 || back2 !== 0) bad += 1
console.log(bad === 0 ? '\n⇒ 三个方向都咬住，且文件已逐字还原、临时文件已删。' : `\n⇒ 有 ${bad} 处不符合预期。`)
process.exit(bad === 0 ? 0 : 1)
