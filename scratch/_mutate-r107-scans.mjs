// scratch/_mutate-r107-scans.mjs —— 第 107 轮负控：把那四个下限**改大**，判据必须红
//
// ★ 为什么"改大"才是对的变异方向：判据是 `actual >= claimed`（`atLeast`）⇒
//   把文档里的数**改大**才会违反它。改小**不会**红（那正是下限的语义）。
//   ⇒ 所以这一步同时验证了"它咬得住"，和"它确实是下限而不是等于"。
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const R = 'D:/project/DSH/legion'
const DOC = `${R}/docs/superpowers/prt/PRT-FINAL-REPORT-2026-09-18.md`
const SENTINEL = `${R}/scratch/.mutant-in-progress.json`
if (existsSync(SENTINEL)) { console.log('  ✖ 哨兵还在'); process.exit(1) }

const IDS = [
  'design-boundary-scan-agent-loop',
  'design-boundary-scan-control-plane-db',
  'design-boundary-scan-single-harness',
  'design-boundary-scan-no-dsh-installer',
]

function run() {
  try { return execFileSync('node', ['scripts/prt/boundary-facts.mjs'], { cwd: R, encoding: 'utf8', maxBuffer: 64e6 }) } catch (e) { return `${e.stdout ?? ''}${e.stderr ?? ''}` }
}
const greens = (s) => IDS.filter((id) => new RegExp(`✔ ${id}\\b`).test(s))
const reds = (s) => IDS.filter((id) => new RegExp(`✖ ${id}\\b`).test(s))

const before = run()
console.log(`  变异前：绿 ${greens(before).length}/4、红 ${reds(before).length}`)

const orig = readFileSync(DOC, 'utf8')
// 把四个下限都改大（+1000）⇒ 四条都必须红
const mutated = orig
  .replace('★ **≥ 381** 个文件', '★ **≥ 1381** 个文件')
  .replace('★ **≥ 88** 个文件', '★ **≥ 1088** 个文件')
  .replace('★ **≥ 15** 个文件', '★ **≥ 1015** 个文件')
  .replace('★ **≥ 164** 个文件', '★ **≥ 1164** 个文件')
if (mutated === orig) { console.log('  ✖ 一处都没改到'); process.exit(1) }

writeFileSync(SENTINEL, JSON.stringify({ file: DOC, mutant: '四个扫描下限各 +1000' }), 'utf8')
writeFileSync(DOC, mutated, 'utf8')
const after = run()
writeFileSync(DOC, orig, 'utf8')
unlinkSync(SENTINEL)

const g = greens(after).length
const r = reds(after).length
console.log(`  变异后：绿 ${g}/4、红 ${r}`)
console.log(`  ${g === 0 && r === 4 ? 'OK ★ 四条全都咬住了' : `★ 没全咬住（绿 ${g}、红 ${r}）`}`)

// ★ 反向对照：只改大**一条** ⇒ 只有那一条该红（证明四条是**各判各的**，不是一红俱红）
const only = orig.replace('★ **≥ 381** 个文件', '★ **≥ 1381** 个文件')
writeFileSync(SENTINEL, JSON.stringify({ file: DOC, mutant: '只把 ① 的下限 +1000' }), 'utf8')
writeFileSync(DOC, only, 'utf8')
const one = run()
writeFileSync(DOC, orig, 'utf8')
unlinkSync(SENTINEL)
const oneReds = reds(one)
console.log(`  只改 ① 时：红 = ${JSON.stringify(oneReds)}`)
console.log(`  ${oneReds.length === 1 && oneReds[0] === IDS[0] ? 'OK ★ 四条各判各的（反向对照过）' : '★ 反向对照没过'}`)
console.log('  ✔ 原文件已还原，哨兵已清')
