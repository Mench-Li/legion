// scripts/probes/_probe-ruling23-connector-shape.mjs
// ============================================================================
// §5 第 23 条（2026-09-24 裁决采 ①「`connectorShape` 谓词端口」）的**变异验证**。
//
// 新端口的判据有**两个方向**，而这个探针把两个方向各改坏一次：
//
//   ① `if (shape?.shaped === true)` → `if (false)`
//      ⇒ 未知命名空间**又悄悄落回政策门**（"未知工具"可以被批准）⇒ 期望 ⑩/⑮ 红；
//   ② `if (shape?.shaped === true)` → `if (true)`
//      ⇒ "**认不出就拒掉一切**"（文件头逐字写着不许）⇒ 非 MCP 形状的名字也被拒
//        ⇒ 期望 ⑪ 红。
//
// ★ 只测一个方向的探针会给出一条**假的**安全感：只有"拒"的那一支被钉住时，
//   "不许拒掉一切"那一支坏掉是**看不出来**的。
//
// 用法：node scripts/probes/_probe-ruling23-connector-shape.mjs
// ============================================================================
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const MODULE = 'runtime/connectors/decision-port.mjs'
const SUITES = [
  'runtime/connectors/decision-port.test.mjs',
  'runtime/dsh-composition/connector-port.test.mjs',
]
const ANCHOR = '      if (shape?.shaped === true) {'
const MUTATIONS = [
  { name: '① 谓词被忽略（未知命名空间又落回政策门）', to: '      if (false) {' },
  { name: '② 认不出就拒掉一切', to: '      if (true) {' },
]

function runSuites() {
  let pass = 0
  let fail = 0
  let code = 0
  let out = ''
  for (const s of SUITES) {
    const r = spawnSync(process.execPath, ['--test', s], { encoding: 'utf8' })
    out += (r.stdout ?? '') + (r.stderr ?? '')
    const p = /^ℹ pass (\d+)/m.exec(out)
    const f = /^ℹ fail (\d+)/m.exec(out)
    if (p !== null) pass += Number(p[1])
    if (f !== null) fail += Number(f[1])
    if (r.status !== 0) code = r.status
  }
  return { code, pass, fail }
}

const original = readFileSync(MODULE, 'utf8')
if ((original.split(ANCHOR).length - 1) !== 1) {
  console.log('  ✖ 锚点不是恰好一处 —— 实现改过了，先修这个探针')
  process.exit(1)
}
console.log('基线：')
const base = runSuites()
console.log(`  退出码 ${base.code} · pass ${base.pass} · fail ${base.fail}`)
if (base.code !== 0) { console.log('  ✖ 基线本应是绿的'); process.exit(1) }

let bad = 0
try {
  for (const m of MUTATIONS) {
    writeFileSync(MODULE, original.replace(ANCHOR, m.to))
    const r = runSuites()
    const bit = r.code !== 0
    console.log(`变异 ${m.name}：`)
    console.log(`  退出码 ${r.code} · pass ${r.pass} · fail ${r.fail} · ${bit ? '✔ 咬住了' : '✖ 没咬住'}`)
    if (!bit) bad += 1
    writeFileSync(MODULE, original)
  }
} finally {
  writeFileSync(MODULE, original)
}
const after = readFileSync(MODULE, 'utf8')
const back = runSuites()
console.log('还原：')
console.log(`  逐字与变异前一致：${after === original ? '✔' : '✖'} · 退出码 ${back.code} · pass ${back.pass} · fail ${back.fail}`)
if (after !== original) bad += 1
if (back.code !== 0) bad += 1
console.log(bad === 0 ? '\n⇒ 两个方向都咬住，且文件已逐字还原。' : `\n⇒ 有 ${bad} 处不符合预期。`)
process.exit(bad === 0 ? 0 : 1)
