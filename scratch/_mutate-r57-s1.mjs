// scratch/_mutate-r57-s1.mjs —— 第 57 轮破验：把报告 §一 的 🟡/⬜ 改回错的 ⇒ 判据必须红
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/project/DSH/legion'
const DOC = `${ROOT}/docs/superpowers/prt/PRT-FINAL-REPORT-2026-09-18.md`
const SENTINEL = `${ROOT}/scratch/.mutant-in-progress.json`
const sha = (x) => createHash('sha256').update(x).digest('hex')
const pristine = readFileSync(DOC)
const restore = () => { writeFileSync(DOC, pristine); rmSync(SENTINEL, { force: true }) }
if (existsSync(SENTINEL)) { console.error('  !! 哨兵在场：先还原。'); restore() }
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => { restore(); process.exit(130) })
process.on('exit', () => { try { if (sha(readFileSync(DOC)) !== sha(pristine)) restore() } catch {} })

const run = () => {
  try { return { code: 0, out: execFileSync('node', ['scripts/prt/boundary-facts.mjs'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } }
  catch (e) { return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') } }
}
let pass = 0
const check = (l, ok, extra = '') => { console.log(`  ${ok ? 'OK' : 'x '} ${l}${extra ? '  ' + extra : ''}`); if (ok) pass += 1 }

const a = run()
check('① 改前 boundary-facts 绿', a.code === 0 && /PASS/.test(a.out), `exit=${a.code}`)

// ★ 把 🟡 与 ⬜ 改回互换的错值 —— 也就是**制造那个"总数照样对"的错**
const t = readFileSync(DOC, 'utf8')
const mut = t
  .replace('| 🟡 部分 | **1** | PRT-316（team-hub 模块提取），**日期未到**：最早 2026-09-24 |', '| 🟡 部分 | **0** | **本批把最后一个 🟡 收掉了** |')
  .replace('| ⬜ 未开始 | **0** | ——（上一个 ⬜ 早已转 🟡） |', '| ⬜ 未开始 | **1** | PRT-316，**日期未到** |')
if (mut === t) { console.log('  x 锚点没改到 —— 这个破验是假的'); process.exit(1) }
writeFileSync(SENTINEL, JSON.stringify({ doc: DOC }))
writeFileSync(DOC, mut)

const b2 = run()
check('② 🟡/⬜ 互换回来 ⇒ boundary-facts 红', b2.code !== 0, `exit=${b2.code}`)
check('② 报的正是这一条事实', /report-section-one-ledger-tallies/.test(b2.out))
// ★★ 而**总数没变** —— 这正是它此前藏住自己的原因
const stillTotal = /\*\*145\*\*/.test(mut)
check('★★ 被改坏的版本里**总数仍是 145**（所以只核总数的检查看不见它）', stillTotal)

restore()
const c = run()
check('③ 还原后逐字节相同且绿', sha(readFileSync(DOC)) === sha(pristine) && c.code === 0 && /PASS/.test(c.out), `exit=${c.code}`)

console.log(`\n  汇总：${pass}/5 ${pass === 5 ? '—— 判据确实咬住，且总数掩盖不了它' : '—— 有失败'}`)
process.exit(pass === 5 ? 0 : 1)
