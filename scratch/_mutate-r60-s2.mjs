// scratch/_mutate-r60-s2.mjs —— 第 60 轮破验：把 §2 那两处 ⬜ 混淆放回去 ⇒ ⑱ 必须红
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/project/DSH/legion'
const DOC = `${ROOT}/docs/superpowers/prt/PRT-FINAL-REPORT-2026-09-18.md`
const SENT = `${ROOT}/scratch/.mutant-in-progress.json`
const sha = (x) => createHash('sha256').update(x).digest('hex')
const pristine = readFileSync(DOC)
const restore = () => { writeFileSync(DOC, pristine); rmSync(SENT, { force: true }) }
if (existsSync(SENT)) { restore(); console.log('  · 清掉遗留哨兵') }
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => { restore(); process.exit(130) })
process.on('exit', () => { try { if (sha(readFileSync(DOC)) !== sha(pristine)) restore() } catch {} })

const run = () => {
  try {
    return { code: 0, out: execFileSync('node',
      ['--test', '--test-name-pattern=现行区里每一处分档说法', 'scripts/prt/boundary-facts.test.mjs'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (e) { return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') } }
}
let pass = 0
const check = (l, ok, extra = '') => { console.log(`  ${ok ? 'OK' : 'x '} ${l}${extra ? '  ' + extra : ''}`); if (ok) pass += 1 }

check('① 改前 ⑱ 绿', run().code === 0)

// 破验 A：把「唯一的 🟡」改回「唯一的 ⬜」
let t = readFileSync(DOC, 'utf8')
const A = t.replace('| 台账里唯一的 **🟡** |', '| 台账里唯一的 ⬜ |')
if (A === t) { console.log('  x 破验 A 锚点没改到'); process.exit(1) }
writeFileSync(SENT, JSON.stringify({ which: 'A' }))
writeFileSync(DOC, A)
const b = run()
check('② 「唯一的 ⬜」⇒ ⑱ 红', b.code !== 0 && /唯一的 ⬜/.test(b.out))
restore()

// 破验 B：把「1 🟡 + 4 ⏸」改回「1 ⬜ + 4 ⏸」
let t2 = readFileSync(DOC, 'utf8')
const B = t2.replace('非 ✅ 行数（**1 🟡 + 4 ⏸**）', '非 ✅ 行数（1 ⬜ + 4 ⏸）')
if (B === t2) { console.log('  x 破验 B 锚点没改到'); process.exit(1) }
writeFileSync(SENT, JSON.stringify({ which: 'B' }))
writeFileSync(DOC, B)
const c = run()
check('③ 「1 ⬜ + 4 ⏸」⇒ ⑱ 红', c.code !== 0 && /1 ⬜/.test(c.out))
restore()

check('④ 还原后逐字节相同且绿', sha(readFileSync(DOC)) === sha(pristine) && run().code === 0)
console.log(`\n  汇总：${pass}/4 ${pass === 4 ? '—— 两种散文形状都咬住' : '—— 有失败'}`)
process.exit(pass === 4 ? 0 : 1)
