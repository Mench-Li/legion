// scratch/_mutate-r100-regex.mjs —— 第 100 轮负控：把派生量**改回 `\d{2}`**，⑰e 会不会红？
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const R = 'D:/project/DSH/legion'
const F = `${R}/scripts/prt/boundary-facts.mjs`
const SENTINEL = `${R}/scratch/.mutant-in-progress.json`
if (existsSync(SENTINEL)) { console.log('  ✖ 哨兵还在'); process.exit(1) }

const orig = readFileSync(F, 'utf8')
const FROM = '/^\\| (\\d{2,3}) \\|/gm'
const TO = '/^\\| (\\d{2}) \\|/gm'
const n = orig.split(FROM).length - 1
if (n !== 3) { console.log(`  ✖ 锚点命中 ${n} 次（应恰好 3 —— 三处派生量）`); process.exit(1) }

function runTest() {
  try {
    const out = execFileSync('node', ['--test', 'scripts/prt/boundary-facts.test.mjs'], { cwd: R, encoding: 'utf8', maxBuffer: 32e6 })
    return { pass: Number((out.match(/pass (\d+)/) ?? [])[1]), fail: Number((out.match(/fail (\d+)/) ?? [])[1]), out }
  } catch (e) {
    const s = `${e.stdout ?? ''}${e.stderr ?? ''}`
    return { pass: Number((s.match(/pass (\d+)/) ?? [])[1]), fail: Number((s.match(/fail (\d+)/) ?? [])[1]), out: s }
  }
}

const before = runTest()
writeFileSync(SENTINEL, JSON.stringify({ file: F, mutant: '派生量 \\d{2,3} → \\d{2}（第 100 行的洞）' }), 'utf8')
writeFileSync(F, orig.split(FROM).join(TO), 'utf8')
const after = runTest()
writeFileSync(F, orig, 'utf8')
unlinkSync(SENTINEL)

console.log(`  变异前：pass ${before.pass} / fail ${before.fail}`)
console.log(`  变异后：pass ${after.pass} / fail ${after.fail}`)
const caught = /⑰e/.test(after.out) && /✖ ⑰e/.test(after.out)
console.log(`  ${caught ? 'OK ★ ⑰e 咬住了（改回 \\d{2} 会红）' : '★ 没咬住 —— 观察一下别的用例有没有抓到'}`)
console.log('  ✔ 原文件已还原，哨兵已清')
