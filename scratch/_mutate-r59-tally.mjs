// scratch/_mutate-r59-tally.mjs —— 第 59 轮破验：⑰ 咬住**此前完全没有判据**的那几处
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/project/DSH/legion'
const SENT = `${ROOT}/scratch/.mutant-in-progress.json`
const HAND = `${ROOT}/docs/superpowers/prt/PRT-HANDOVER-2026-09-18-ROUND22.md`
const INT = `${ROOT}/docs/superpowers/prt/PRT-HUMAN-INTERVENTION-2026-09-20.md`
const sha = (x) => createHash('sha256').update(x).digest('hex')
const pristine = new Map([[HAND, readFileSync(HAND)], [INT, readFileSync(INT)]])
const restore = () => { for (const [f, b] of pristine) writeFileSync(f, b); rmSync(SENT, { force: true }) }
if (existsSync(SENT)) { restore(); console.log('  · 清掉遗留哨兵') }
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => { restore(); process.exit(130) })
process.on('exit', () => { try { for (const [f, b] of pristine) if (sha(readFileSync(f)) !== sha(b)) restore() } catch {} })

const run = () => {
  try {
    return { code: 0, out: execFileSync('node',
      ['--test', '--test-name-pattern=每一处抄写都被登记', 'scripts/prt/boundary-facts.test.mjs'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (e) { return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') } }
}
let pass = 0
const check = (l, ok, extra = '') => { console.log(`  ${ok ? 'OK' : 'x '} ${l}${extra ? '  ' + extra : ''}`); if (ok) pass += 1 }

check('① 改前 ⑰ 绿', run().code === 0)

// ★ 破验 A：交接报告 §一（L15）—— 这一处**此前没有任何判据**
let t = readFileSync(HAND, 'utf8')
const A = t.replace('台账 **145 行 = 140 ✅ / 1 🟡 / 4 ⏸ / 0 ⬜**', '台账 **145 行 = 138 ✅ / 1 🟡 / 4 ⏸ / 0 ⬜**')
if (A === t) { console.log('  x 破验 A 锚点没改到'); process.exit(1) }
writeFileSync(SENT, JSON.stringify({ which: 'A' }))
writeFileSync(HAND, A)
const b = run()
check('② 改交接报告 §一 那句（**此前无判据**）⇒ ⑰ 红', b.code !== 0 && /交接报告 §一/.test(b.out))
restore()

// ★ 破验 B：人工清单抬头（L8）—— 同样此前无判据
let t2 = readFileSync(INT, 'utf8')
const B = t2.replace('**145 行 = 140 ✅ / 1 🟡 / 4 ⏸ / 0 ⬜**。', '**145 行 = 137 ✅ / 1 🟡 / 4 ⏸ / 0 ⬜**。')
if (B === t2) { console.log('  x 破验 B 锚点没改到'); process.exit(1) }
writeFileSync(SENT, JSON.stringify({ which: 'B' }))
writeFileSync(INT, B)
const c = run()
check('③ 改人工清单抬头那句（**此前无判据**）⇒ ⑰ 红', c.code !== 0 && /人工清单抬头/.test(c.out))
restore()

// ★ 破验 C：**新增第 11 处**抄写 ⇒ 必须报"没有登记"
let t3 = readFileSync(INT, 'utf8')
const C = t3.replace('\n## 四、', '\n\n（新加的一处）**145 行 = 1 ✅ / 1 🟡 / 4 ⏸ / 0 ⬜**\n\n## 四、')
if (C === t3) { console.log('  x 破验 C 锚点没改到'); process.exit(1) }
writeFileSync(SENT, JSON.stringify({ which: 'C' }))
writeFileSync(INT, C)
const d = run()
check('④ 新增第 11 处抄写 ⇒ 报"没有登记"', d.code !== 0 && /没有登记/.test(d.out))
restore()

const e = run()
const identical = [...pristine].every(([f, b]) => sha(readFileSync(f)) === sha(b))
check('⑤ 还原后逐字节相同且绿', identical && e.code === 0)

console.log(`\n  汇总：${pass}/5 ${pass === 5 ? '—— 三处此前无判据的抄写全部咬住，且新增一处会被要求登记' : '—— 有失败'}`)
process.exit(pass === 5 ? 0 : 1)
