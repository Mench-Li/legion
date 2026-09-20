// scratch/_mutate-r101-width.mjs —— 第 101 轮负控：把家族行豁免规则**改窄**，回归用例会不会红？
//   ★ 试两个变异：改回 `\d{1,2}`（原始的洞）、改成 `\d{2,3}`（"只把墙挪到 1000"的那种修法）
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const R = 'D:/project/DSH/legion'
const F = `${R}/scripts/prt/boundary-facts.test.mjs`
const SENTINEL = `${R}/scratch/.mutant-in-progress.json`
if (existsSync(SENTINEL)) { console.log('  ✖ 哨兵还在'); process.exit(1) }

const orig = readFileSync(F, 'utf8')
const LIVE = '/^\\|\\s*\\d+\\s*\\|/.test(c.text)'
if (orig.split(LIVE).length - 1 !== 1) { console.log('  ✖ 找不到唯一的活规则锚点'); process.exit(1) }

function run() {
  try {
    const o = execFileSync('node', ['--test', 'scripts/prt/boundary-facts.test.mjs'], { cwd: R, encoding: 'utf8', maxBuffer: 32e6 })
    return { pass: Number((o.match(/pass (\d+)/) ?? [])[1]), fail: Number((o.match(/fail (\d+)/) ?? [])[1]), out: o }
  } catch (e) {
    const s = `${e.stdout ?? ''}${e.stderr ?? ''}`
    return { pass: Number((s.match(/pass (\d+)/) ?? [])[1]), fail: Number((s.match(/fail (\d+)/) ?? [])[1]), out: s }
  }
}

const base = run()
console.log(`  基线：pass ${base.pass} / fail ${base.fail}`)

for (const [label, to] of [
  ['改回 \\d{1,2}（原始的洞）', '/^\\|\\s*\\d{1,2}\\s*\\|/.test(c.text)'],
  ['改成 \\d{2,3}（只把墙挪到 1000）', '/^\\|\\s*\\d{2,3}\\s*\\|/.test(c.text)'],
]) {
  writeFileSync(SENTINEL, JSON.stringify({ file: F, mutant: label }), 'utf8')
  writeFileSync(F, orig.replace(LIVE, to), 'utf8')
  const r = run()
  writeFileSync(F, orig, 'utf8')
  const caught = r.fail > base.fail
  console.log(`  ${label}：pass ${r.pass} / fail ${r.fail}  ${caught ? 'OK ★ 被咬住' : '★ 没咬住'}`)
  if (caught) {
    const line = (r.out.split(/\r?\n/).find((l) => /认不出编号 \d+/.test(l)) ?? '').trim()
    if (line) console.log(`      咬它的那句话：${line.slice(0, 130)}`)
  }
}
unlinkSync(SENTINEL)
console.log('  ✔ 原文件已还原，哨兵已清')
