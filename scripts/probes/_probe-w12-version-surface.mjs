// scripts/probes/_probe-w12-version-surface.mjs
// ============================================================================
// §13.1 **W-12**（七类版本面写实，2026-09-24）的**变异验证**。
//
// "七类都被看着"这句话有两个可以坏掉的半边：
//   ① 对账循环**漏掉一类**（`verifyRolePack` 少看一节）⇒ 那一类换了版本没人报；
//   ② **版本面本身缺一格**（某一类的字段闭包里没有 `version`）⇒ 那一类根本没有版本可看。
//
// ★ 只改一个方向的探针会给出一条假的安全感：漏看一类时，⑩（表覆盖）仍然全绿；
//   缺一格时，⑪（逐一漂移）也仍然全绿 —— 两条判据各守一半，必须各喂一次变异。
//
// 用法：node scripts/probes/_probe-w12-version-surface.mjs
// ============================================================================
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const MODULE = 'runtime/employee/role-pack.mjs'
const SUITE = 'runtime/employee/role-pack.test.mjs'
const MUTATIONS = [
  {
    name: '① 对账循环漏掉 model（那一类换了版本没人报）',
    from: '  for (const section of ROLE_PACK_SECTIONS) {',
    to: "  for (const section of ROLE_PACK_SECTIONS.filter((x) => x !== 'model')) {",
  },
  {
    name: '② 版本面缺一格（model 的字段闭包里没有 version）',
    from: "  model: Object.freeze(['profileId', 'version']),",
    to: "  model: Object.freeze(['profileId']),",
  },
]

function runSuite() {
  const r = spawnSync(process.execPath, ['--test', SUITE], { encoding: 'utf8' })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  const p = /^ℹ pass (\d+)/m.exec(out)
  const f = /^ℹ fail (\d+)/m.exec(out)
  return { code: r.status, pass: p === null ? -1 : Number(p[1]), fail: f === null ? -1 : Number(f[1]) }
}

const original = readFileSync(MODULE, 'utf8')
for (const m of MUTATIONS) {
  if ((original.split(m.from).length - 1) !== 1) {
    console.log(`  ✖ 锚点不唯一：${m.name}`)
    process.exit(1)
  }
}

console.log('基线：')
const base = runSuite()
console.log(`  退出码 ${base.code} · pass ${base.pass} · fail ${base.fail}`)
if (base.code !== 0) { console.log('  ✖ 基线本应是绿的'); process.exit(1) }

let bad = 0
try {
  for (const m of MUTATIONS) {
    writeFileSync(MODULE, original.replace(m.from, m.to))
    const r = runSuite()
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
const back = runSuite()
console.log('还原：')
console.log(`  逐字与变异前一致：${after === original ? '✔' : '✖'} · 退出码 ${back.code} · pass ${back.pass} · fail ${back.fail}`)
if (after !== original) bad += 1
if (back.code !== 0) bad += 1
console.log(bad === 0 ? '\n⇒ 两个方向都咬住，且文件已逐字还原。' : `\n⇒ 有 ${bad} 处不符合预期。`)
process.exit(bad === 0 ? 0 : 1)
