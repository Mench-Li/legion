// scratch/_mutate-r97-familyrows.mjs —— 第 97 轮负控：`report-family-rows-round` 真的会红吗
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const R = 'D:/project/DSH/legion'
const F = `${R}/docs/superpowers/prt/PRT-FINAL-REPORT-2026-09-18.md`
const SENTINEL = `${R}/scratch/.mutant-in-progress.json`
if (existsSync(SENTINEL)) { console.log('  ✖ 哨兵还在'); process.exit(1) }

const orig = readFileSync(F, 'utf8')
const FROM = '逐轮到第 96 行'
const TO = '逐轮到第 95 行'
const n = orig.split(FROM).length - 1
if (n !== 1) { console.log(`  ✖ 锚点命中 ${n} 次（应恰好 1）`); process.exit(1) }

function run() {
  try {
    const out = execFileSync('node', ['scripts/prt/boundary-facts.mjs'], { cwd: R, encoding: 'utf8', maxBuffer: 32e6 })
    return out
  } catch (e) { return `${e.stdout ?? ''}${e.stderr ?? ''}` }
}
const redOf = (s) => Number((s.match(/红 (\d+)/) ?? [])[1])

const before = run()
writeFileSync(SENTINEL, JSON.stringify({ file: F, mutant: '逐轮到第 96→95 行' }), 'utf8')
writeFileSync(F, orig.replace(FROM, TO), 'utf8')
const after = run()
writeFileSync(F, orig, 'utf8')
unlinkSync(SENTINEL)

console.log(`  基线红 ${redOf(before)} 条 → 变异后红 ${redOf(after)} 条`)
console.log(`  ${redOf(after) > redOf(before) ? 'OK ★ 新判据咬住了' : '★ 没咬住 —— 它是恒绿的'}`)
console.log('  ✔ 原文件已还原，哨兵已清')
