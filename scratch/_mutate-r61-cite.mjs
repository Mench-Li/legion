// scratch/_mutate-r61-cite.mjs —— 第 61 轮破验：⑲ 的两半各咬一次
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
      ['--test', '--test-name-pattern=必须带限定词', 'scripts/prt/boundary-facts.test.mjs'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (e) { return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') } }
}
let pass = 0
const check = (l, ok, extra = '') => { console.log(`  ${ok ? 'OK' : 'x '} ${l}${extra ? '  ' + extra : ''}`); if (ok) pass += 1 }

check('① 改前 ⑲ 绿', run().code === 0)

// 破验 A：去掉限定词（把 `§5 第 19 条` 改回 `第 19 条`）—— 排名与 §5 项又撞在一起
let t = readFileSync(DOC, 'utf8')
const A = t.replace('| **A** | **§5 第 19 条**：部署配置键 → 组合根 |', '| **A** | **第 19 条**：部署配置键 → 组合根 |')
if (A === t) { console.log('  x 破验 A 锚点没改到'); process.exit(1) }
writeFileSync(SENT, JSON.stringify({ which: 'A' }))
writeFileSync(DOC, A)
const b = run()
check('② 去掉 `§5` 限定词 ⇒ ⑲ 红', b.code !== 0 && /不带限定词/.test(b.out))
restore()

// 破验 B：引用一个**不存在**的条号
let t2 = readFileSync(DOC, 'utf8')
const B = t2.replace('| **C** | **§5 第 16 条**：死代码处置 |', '| **C** | **§5 第 99 条**：死代码处置 |')
if (B === t2) { console.log('  x 破验 B 锚点没改到'); process.exit(1) }
writeFileSync(SENT, JSON.stringify({ which: 'B' }))
writeFileSync(DOC, B)
const c = run()
check('③ 引用 §5 里不存在的条号 ⇒ ⑲ 红', c.code !== 0 && /不存在/.test(c.out))
restore()

check('④ 还原后逐字节相同且绿', sha(readFileSync(DOC)) === sha(pristine) && run().code === 0)
console.log(`\n  汇总：${pass}/4 ${pass === 4 ? '—— 两半都咬住' : '—— 有失败'}`)
process.exit(pass === 4 ? 0 : 1)
