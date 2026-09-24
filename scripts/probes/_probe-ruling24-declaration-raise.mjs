// scripts/probes/_probe-ruling24-declaration-raise.mjs
// ============================================================================
// §5 第 24 条（2026-09-24 裁决 **(c)**）的**变异验证**：
//   "声明只许抬升"这条纪律，是不是**真的**被判据钉住了？
//
// 一个判据"通过"与一个判据"会咬"，在它没有被变异喂过的时候长得一样 ——
// 所以这里不引用测试结论，而是**把那条纪律改坏，再看它红不红**。
//
// 两次变异（各改一处，跑完即还原）：
//   ① `maxRisk(base.risk, floor)` → `floor`
//      ⇒ "以声明为准"（正是裁决 (c) 排除的那条路）⇒ 期望 ⑩ / ⑭ 红；
//   ② `direction: facts.direction === 'write' ? 'write' : base.direction`
//      → `facts.direction`  ⇒ 声明能把未知工具的**方向**退回 read ⇒ 期望 ⑩ 红。
//
// 用法：node scripts/probes/_probe-ruling24-declaration-raise.mjs
// ============================================================================
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const MODULE = 'runtime/dsh-composition/tool-capability.mjs'
const SUITE = 'runtime/dsh-composition/tool-capability.test.mjs'

const MUTATIONS = [
  {
    name: '① 以声明为准（去掉 max）',
    from: '  const risk = maxRisk(base.risk, floor)',
    to: '  const risk = floor',
    expect: /⑩|⑭/,
  },
  {
    name: '② 方向可退回 read（去掉 base 那半）',
    from: "    direction: facts.direction === 'write' ? 'write' : base.direction,",
    to: '    direction: facts.direction,',
    expect: /⑩/,
  },
]

function runSuite() {
  const r = spawnSync(process.execPath, ['--test', SUITE], { encoding: 'utf8' })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  const pass = /^ℹ pass (\d+)/m.exec(out)
  const fail = /^ℹ fail (\d+)/m.exec(out)
  return {
    code: r.status,
    pass: pass === null ? -1 : Number(pass[1]),
    fail: fail === null ? -1 : Number(fail[1]),
    out,
  }
}

const original = readFileSync(MODULE, 'utf8')
console.log('基线：')
const base = runSuite()
console.log(`  退出码 ${base.code} · pass ${base.pass} · fail ${base.fail}`)
if (base.code !== 0) {
  console.log('  ✖ 基线本应是绿的 —— 变异验证没有意义，先修基线')
  process.exit(1)
}

let bad = 0
try {
  for (const m of MUTATIONS) {
    if (!original.includes(m.from)) {
      console.log(`  ✖ 变异 ${m.name}：锚点没找到（实现改过了？）`)
      bad += 1
      continue
    }
    writeFileSync(MODULE, original.replace(m.from, m.to))
    const r = runSuite()
    const bit = r.code !== 0 && m.expect.test(r.out)
    console.log(`变异 ${m.name}：`)
    console.log(`  退出码 ${r.code} · pass ${r.pass} · fail ${r.fail} · ${bit ? '✔ 咬住了' : '✖ 没咬住'}`)
    if (!bit) {
      bad += 1
      console.log('  期望红的判据：' + m.expect)
      console.log('  ' + r.out.split('\n').filter((l) => /not ok|✖/.test(l)).slice(0, 3).join('\n  '))
    }
    writeFileSync(MODULE, original)
  }
} finally {
  writeFileSync(MODULE, original)
}

const after = readFileSync(MODULE, 'utf8')
console.log('还原：')
const back = runSuite()
console.log(`  逐字与变异前一致：${after === original ? '✔' : '✖'} · 退出码 ${back.code} · pass ${back.pass} · fail ${back.fail}`)
if (after !== original) bad += 1
if (back.code !== 0) bad += 1

console.log(bad === 0 ? '\n⇒ 两次变异都咬住，且文件已逐字还原。' : `\n⇒ 有 ${bad} 处不符合预期。`)
process.exit(bad === 0 ? 0 : 1)
