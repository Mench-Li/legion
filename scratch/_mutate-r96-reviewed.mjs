// scratch/_mutate-r96-reviewed.mjs —— 第 96 轮负控：新判据 `intervention-reviewed-round` **真的会红**吗
//
// ★ 纪律（本仓记过多次）：一条**绿**的判据，与一条**恒绿**的判据，在输出里长得一样。
//   ⇒ 必须把它要抓的东西**改坏一次**，看它红不红。
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const R = 'D:/project/DSH/legion'
const I = `${R}/docs/superpowers/prt/PRT-HUMAN-INTERVENTION-2026-09-20.md`
const SENTINEL = `${R}/scratch/.mutant-in-progress.json`
if (existsSync(SENTINEL)) { console.log('  ✖ 哨兵还在'); process.exit(1) }

const orig = readFileSync(I, 'utf8')
const FROM = '本文件已**复核到第 95 轮**'
const TO = '本文件已**复核到第 94 轮**'
if (orig.split(FROM).length - 1 !== 1) { console.log(`  ✖ 锚点命中 ${orig.split(FROM).length - 1} 次`); process.exit(1) }

function run() {
  try {
    const out = execFileSync('node', ['scripts/prt/boundary-facts.mjs'], { cwd: R, encoding: 'utf8', maxBuffer: 32e6 })
    return { red: /红 [1-9]/.test(out), out }
  } catch (e) {
    const both = `${e.stdout ?? ''}${e.stderr ?? ''}`
    return { red: /红 [1-9]/.test(both), out: both }
  }
}

// ① 先把**已知的那条红**（台账 server.mjs:2375，非本批）的条数记下来：只要它**没增加**，就说明新判据没红
const before = run()
const nBefore = (before.out.match(/红 (\d+)/) ?? [])[1]

writeFileSync(SENTINEL, JSON.stringify({ file: I, mutant: '复核到第 95→94 轮' }), 'utf8')
writeFileSync(I, orig.replace(FROM, TO), 'utf8')
const after = run()
writeFileSync(I, orig, 'utf8')
unlinkSync(SENTINEL)

const nAfter = (after.out.match(/红 (\d+)/) ?? [])[1]
const caught = after.out.includes('intervention-reviewed-round') === false
  || /✖ intervention-reviewed-round/.test(after.out)
console.log(`  基线红 ${nBefore} 条 → 变异后红 ${nAfter} 条`)
console.log(`  ${caught && Number(nAfter) > Number(nBefore) ? 'OK ★ 新判据咬住了（红条数增加）' : '★ 没咬住 —— 它是恒绿的'}`)
console.log('  ✔ 原文件已还原，哨兵已清')
