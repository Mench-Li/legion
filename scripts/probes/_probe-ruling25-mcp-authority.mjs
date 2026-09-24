// scripts/probes/_probe-ruling25-mcp-authority.mjs
// ============================================================================
// §5 第 25 条（2026-09-24 裁决 **①**，F-21 连接器登记表为权威）的**变异验证**。
//
// 裁决把 `mcp` 段从"工具级授权表"降级为"本岗位允不允许调 MCP"一个布尔，
// 于是这一段的**三种**结局都成了判据：没有段 ⇒ 拒；有段 + 工具级声明 ⇒ 拒；
// 有段 + 无工具级声明 ⇒ **放行**。
//
// ★ 一个"分三种"的实现，与一个"实际上只有两种"的实现，在**只测了拒**的用例上
//   长得一模一样 —— 而"放行"那一支正是这次裁决要立起来的东西。
//   所以这里把两个方向各改坏一次：
//
//   ① `toolLevel.length === 0` → `true`  ⇒ 工具级声明被静默放过（"配了却没生效"又回来了）
//   ② `toolLevel.length === 0` → `false` ⇒ 布尔那一支消失（"段在=允许"永不可达）
//
// 用法：node scripts/probes/_probe-ruling25-mcp-authority.mjs
// ============================================================================
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const MODULE = 'runtime/dsh-composition/execution-scope-port.mjs'
const SUITES = [
  'runtime/dsh-composition/execution-scope-port.test.mjs',
  'runtime/dsh-composition/production-scope-wiring.test.mjs',
]
const ANCHOR = '      if (toolLevel.length === 0) {'
const MUTATIONS = [
  { name: '① 工具级声明被静默放过', to: '      if (true) {' },
  { name: '② 布尔那一支消失（永远拒）', to: '      if (false) {' },
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
  return { code, pass, fail, out }
}

const original = readFileSync(MODULE, 'utf8')
if ((original.split(ANCHOR).length - 1) !== 1) {
  console.log('  ✖ 锚点不是恰好一处 —— 实现改过了，先修这个探针')
  process.exit(1)
}

console.log('基线：')
const base = runSuites()
console.log(`  退出码 ${base.code} · pass ${base.pass} · fail ${base.fail}`)
if (base.code !== 0) {
  console.log('  ✖ 基线本应是绿的 —— 变异验证没有意义')
  process.exit(1)
}

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
