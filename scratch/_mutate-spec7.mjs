// scratch/_mutate-spec7.mjs —— 变异：§7 投影判据（第 37 轮）（**不提交**）
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/project/DSH/legion'
const MOD = `${ROOT}/scripts/prt/spec-tests-7.mjs`
const orig = readFileSync(MOD, 'utf8')
let all = true

const green = () => {
  try {
    return /ℹ fail 0/.test(execFileSync('node', ['--test', 'scripts/prt/spec-tests-7.test.mjs'],
      { cwd: ROOT, encoding: 'utf8' }))
  } catch (e) { return /ℹ fail 0/.test(String(e.stdout ?? '') + String(e.stderr ?? '')) }
}

function mut(name, find, repl) {
  if (!orig.includes(find)) { console.log(`⚠ ${name}: 变异串没找到`); all = false; return }
  writeFileSync(MOD, orig.replace(find, repl), 'utf8')
  const g = green()
  if (g) all = false
  console.log(`${g ? '✖ 漏网' : '✓ 咬住'} ${name}`)
  writeFileSync(MOD, orig, 'utf8')
}

try {
  // ★ M1 就是这一轮那个真事：套件别名漏前缀不再报
  mut('M1 去掉"漏了 `套件 ` 前缀"那条守卫（**这一轮的真事**）',
    '      if (m.suites.includes(tok)) continue', '      if (true) continue')

  mut('M2 去掉"一条要求没人认领"的判定',
    '    if (hit.length === 0) {', '    if (false) {')

  mut('M3 去掉"投影行过期"的判定',
    "    if (!used.has(p.key) && !bullets.some((b) => b.startsWith(p.excerpt))) {", '    if (false) {')

  mut('M4 退出条件的归属不再核对 §6（"托着某条退出条件"变回一句空话）',
    '      } else if (!exits.some((e) => e.exit.includes(p.exit))) {', '      } else if (false) {')

  mut('M5 观测档不再要求写"为什么不是退出条件"',
    "      if (why.trim().length < 20) {", '      if (false) {')

  mut('M6 `kind` 不再校验（乱写的档也放过）',
    '    if (!KINDS.includes(p.kind)) {', '    if (false) {')

  mut('M7 落点解不开时不再报（`found === 0` 那条）',
    "    if (found === 0) {", '    if (false) {')

  mut('M8 去掉"什么都没查"的下限（0 条也报绿）',
    "    return { ok: false, violations, reading: { bullets: 0, projection: 0, pointers: 0 } }",
    "    return { ok: true, violations, reading: { bullets: 0, projection: 0, pointers: 0 } }")

  mut('M9 小节解析在下一个 `## ` 处**不停**（把 §8 也吞进来）',
    "  const end = rest.findIndex((l) => /^## /.test(l))", '  const end = -1')

  // ★ M10 改真文档：把 §7 第 6 条删掉 ⇒ 投影行立刻过期，必须红
  const SPEC = `${ROOT}/docs/MULTI-AGENT-FEATURE-OPTIMIZATION.md`
  const specOrig = readFileSync(SPEC, 'utf8')
  try {
    const line = specOrig.split('\n').find((l) => l.includes('- 持续观察事件遗漏/重复率'))
    if (line === undefined) { console.log('⚠ M10: 找不到 §7 第 6 条'); all = false }
    else {
      writeFileSync(SPEC, specOrig.replace(line + '\n', ''), 'utf8')
      const g = green()
      if (g) all = false
      console.log(`${g ? '✖ 漏网' : '✓ 咬住'} M10 改真文档：删掉 §7 第 6 条（投影行必须立刻过期）`)
    }
  } finally { writeFileSync(SPEC, specOrig, 'utf8') }
} finally {
  writeFileSync(MOD, orig, 'utf8')
}

console.log(`\n全部咬住 ? ${all}`)
console.log(`逐字还原 ? ${readFileSync(MOD, 'utf8') === orig}`)
console.log(`还原后判据仍绿 ? ${green()}`)
