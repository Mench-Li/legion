// scripts/probes/_probe-t8-branch-disposition.mjs
// ============================================================================
// **T8**（`w/*` 存档分支的处置，2026-09-24）的**变异验证**。
//
// 处置账（`scripts/probes/branch-disposition.mjs` 的 `DISPOSITIONS`）里，
// 每一行都可能**登记成假的**，而判据必须在三个方向上都咬住：
//
//   ① 把"不并入"的那条改登记成"已并入" ⇒ 必须红（它不是 HEAD 的祖先）；
//   ② 把已经并进来的那条改个名 ⇒ 必须红（真分支还在、处置没了）；
//   ③ 把已并入那条的**提交号写错**（指向另一个存档提交）⇒ 必须红
//      —— "处置写错对象"与"处置写错结果"是两件事。
//
// ★ 不做的变异：删分支/删提交。"处置记错"与"存档真的丢了"是两件事，
//   后者不该由本探针来制造。
//
// 用法：node scripts/probes/_probe-t8-branch-disposition.mjs
// ============================================================================
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const PROBE = 'scripts/probes/branch-disposition.mjs'
const run = () => {
  const r = spawnSync(process.execPath, [PROBE], { encoding: 'utf8' })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  const last = out.split('\n').filter((l) => l.trim() !== '').slice(-1)[0].trim()
  return { code: r.status, line: last }
}

const original = readFileSync(PROBE, 'utf8')
// ★ 单行锚点（这个仓库的文件是 CRLF，多行锚点会失配）
const anchors = [
  ["    fate: 'discarded',", '①'],
  ["    branch: 'w/T-065',", '②'],
  ["    commit: '5c0ce26',", '③'],
]
for (const [a, label] of anchors) {
  if ((original.split(a).length - 1) !== 1) { console.log(`  ✖ 锚点不唯一：${label}  ${a}`); process.exit(1) }
}

console.log('基线：')
const base = run()
console.log(`  退出码 ${base.code} · ${base.line}`)
if (base.code !== 0) { console.log('  ✖ 基线本应是绿的'); process.exit(1) }

let bad = 0
const step = (label, mutated) => {
  writeFileSync(PROBE, mutated)
  const r = run()
  const bit = r.code !== 0
  console.log(`变异 ${label}：`)
  console.log(`  退出码 ${r.code} · ${r.line} · ${bit ? '✔ 咬住了' : '✖ 没咬住'}`)
  writeFileSync(PROBE, original)
  if (!bit) bad += 1
}

try {
  step('① 把「不并入」改登记成「已并入」', original.replace("    fate: 'discarded',", "    fate: 'merged',"))
  step('② 把已并入那条的登记改个名（真分支于是没人管）', original.replace("    branch: 'w/T-065',", "    branch: 'w/T-XXX-REMOVED',"))
  step('③ 把已并入那条的提交号写错（指向另一个存档提交）', original.replace("    commit: '5c0ce26',", "    commit: '3c78cce',"))
} finally {
  writeFileSync(PROBE, original)
}

const same = readFileSync(PROBE, 'utf8') === original
const back = run()
console.log('还原：')
console.log(`  逐字与变异前一致：${same ? '✔' : '✖'} · 退出码 ${back.code} · ${back.line}`)
if (!same) bad += 1
if (back.code !== 0) bad += 1
console.log(bad === 0 ? '\n⇒ 三个方向都咬住，且文件已逐字还原。' : `\n⇒ 有 ${bad} 处不符合预期。`)
process.exit(bad === 0 ? 0 : 1)
