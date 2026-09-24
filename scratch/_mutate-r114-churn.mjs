// scratch/_mutate-r114-churn.mjs — 破验：新加的两条守卫必须真的咬得住
//   M1: 空读数守卫失效（=== 0 → === -1）      ⇒ 期望 ⑤ 红
//   M2: --strict 失效（process.exitCode = 2 → 0）⇒ 期望 ⑥ 红
//   M3: 判定恒「已降温」（cooled → true）        ⇒ 期望 ⑥ 红
// 逐条改坏 → 跑 → 还原；用字节比较确认还原干净。
import { readFileSync, writeFileSync, copyFileSync, existsSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const SRC = 'scripts/prt/hot-file-churn.mjs'
const BAK = `${SRC}.mutbak`
const MUTANTS = [
  ['M1 空读数守卫失效', 'if (Object.keys(perFile).length === 0) {', 'if (Object.keys(perFile).length === -1) {'],
  ['M2 --strict 失效', "if (argv.includes('--strict') && !v.cooled) process.exitCode = 2", "if (argv.includes('--strict') && !v.cooled) process.exitCode = 0"],
  ['M3 判定恒已降温', 'const cooled = recentMax <= COOLED_ABSOLUTE_BAR && recentMax <= Math.max(busiestPast, 1)', 'const cooled = true'],
]

copyFileSync(SRC, BAK)
const orig = readFileSync(SRC)
let bad = 0
try {
  for (const [name, from, to] of MUTANTS) {
    const text = readFileSync(BAK, 'utf8')
    if (!text.includes(from)) { console.log(`✖ ${name}：变异点找不到（${from}）`); bad++; continue }
    writeFileSync(SRC, text.replace(from, to))
    let red = false
    try {
      execFileSync(process.execPath, ['--test', 'scripts/prt/hot-file-churn.test.mjs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch { red = true }
    console.log(`${red ? '✔' : '✖'} ${name} → ${red ? '咬住（红）' : '**没咬住**'}`)
    if (!red) bad++
    copyFileSync(BAK, SRC)
  }
} finally {
  copyFileSync(BAK, SRC)
  unlinkSync(BAK)
}
// 还原确认：逐字节
const restored = readFileSync(SRC)
const same = Buffer.compare(orig, restored) === 0
console.log(`还原逐字节相同：${same ? '✔' : '✖'}`)
if (!same || bad > 0) process.exit(1)
