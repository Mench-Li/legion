// scripts/probes/_probe-w4-sandbox-caliber.mjs
// ============================================================================
// §5 第 4 条口径（**W-4**，2026-09-24）的**变异验证**。
//
// 口径 = `probeSandbox` 八条拒绝理由的**闭集**。它可以坏在两个方向上：
//   ① **少一条**：某一项判据被删掉（这里删"拒绝签名"那一项）⇒ 那一项不再被拒；
//   ② **判错档**：`full` 的判据松成"只要不是 partial 就算过" ⇒ `partial` 变成生效。
//
// ★ ② 是这条口径**最要紧**的那一半：`partial` 的字面意思是"存在不被管制的路径"，
//   一旦它被读成"通过"，win32 上那个"只能做到部分管制"的平台边界就会**静默地**
//   变成"已完全管制"——而两者在只看 `effective` 的读数上是同一个绿。
//
// 用法：node scripts/probes/_probe-w4-sandbox-caliber.mjs
// ============================================================================
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const MODULE = 'runtime/dsh-composition/selfcheck.mjs'
const SUITE = 'runtime/dsh-composition/composition.test.mjs'
const PATTERN = '⑳'
const MUTATIONS = [
  {
    name: '① 少一条判据：拒绝签名那一项永远不触发',
    from: '  if (denialSignatures === null || denialSignatures.length === 0) {',
    to: '  if (false) {',
  },
  {
    name: '② 判错档：把 full 的判据松成"不是 partial 就算过"',
    from: "  } else if (enforcement !== 'full') {",
    to: "  } else if (enforcement !== 'partial') {",
  },
]

function runOne() {
  const r = spawnSync(process.execPath, ['--test', `--test-name-pattern=${PATTERN}`, SUITE], { encoding: 'utf8' })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  const p = /^ℹ pass (\d+)/m.exec(out)
  const f = /^ℹ fail (\d+)/m.exec(out)
  return { code: r.status, pass: p === null ? -1 : Number(p[1]), fail: f === null ? -1 : Number(f[1]) }
}

const original = readFileSync(MODULE, 'utf8')
for (const m of MUTATIONS) {
  if ((original.split(m.from).length - 1) !== 1) { console.log(`  ✖ 锚点不唯一：${m.name}`); process.exit(1) }
}

console.log('基线（只跑 ⑳）：')
const base = runOne()
console.log(`  退出码 ${base.code} · pass ${base.pass} · fail ${base.fail}`)
if (base.code !== 0 || base.pass !== 1) { console.log('  ✖ 基线本应是 1 条绿'); process.exit(1) }

let bad = 0
try {
  for (const m of MUTATIONS) {
    writeFileSync(MODULE, original.replace(m.from, m.to))
    const r = runOne()
    const bit = r.code !== 0
    console.log(`变异 ${m.name}：`)
    console.log(`  退出码 ${r.code} · pass ${r.pass} · fail ${r.fail} · ${bit ? '✔ 咬住了' : '✖ 没咬住'}`)
    if (!bit) bad += 1
    writeFileSync(MODULE, original)
  }
} finally {
  writeFileSync(MODULE, original)
}
const same = readFileSync(MODULE, 'utf8') === original
const back = runOne()
console.log('还原：')
console.log(`  逐字与变异前一致：${same ? '✔' : '✖'} · 退出码 ${back.code} · pass ${back.pass} · fail ${back.fail}`)
if (!same) bad += 1
if (back.code !== 0) bad += 1
console.log(bad === 0 ? '\n⇒ 两个方向都咬住，且文件已逐字还原。' : `\n⇒ 有 ${bad} 处不符合预期。`)
process.exit(bad === 0 ? 0 : 1)
