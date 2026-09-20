// scratch/_mutate-r58-tally.mjs —— 第 58 轮破验：⑯ 的两半各咬一次
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

// ★ 只跑 ⑯ 一条 —— 全量 58 例跑三次会撞上窗口上限，
//   而**被砍死的进程不会跑 `exit` 处理器**，改动会留在树里
//   （本脚本第一版就这样把破验 B 的改动留在了文档里，靠哨兵才抓回来）。
//   > 一个把改动写进磁盘、再靠 `exit` 处理器还原的脚本，
//   > 在被强制杀死时**什么都不会还原** —— 而"被杀死"和"跑完了"在退出码上都是非零。
const run = () => {
  try {
    return { code: 0, out: execFileSync('node',
      ['--test', '--test-name-pattern=每一处台账分档抄写', 'scripts/prt/boundary-facts.test.mjs'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (e) { return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') } }
}
const failLine = (o) => /^ℹ fail (\d+)$/m.exec(o)?.[1] ?? '?'
let pass = 0
const check = (l, ok, extra = '') => { console.log(`  ${ok ? 'OK' : 'x '} ${l}${extra ? '  ' + extra : ''}`); if (ok) pass += 1 }

const a = run()
check('① 改前 58/58 绿', a.code === 0 && failLine(a.out) === '0', `fail=${failLine(a.out)}`)

// ── 破验 A：把**开头那句现行摘要**上的数改错（§三 之前）──
const t = readFileSync(DOC, 'utf8')
const A = t.replace('**145 行 = 140 ✅ / 1 🟡 / 4 ⏸ / 0 ⬜**', '**145 行 = 139 ✅ / 1 🟡 / 4 ⏸ / 0 ⬜**')
if (A === t) { console.log('  x 破验 A 的锚点没改到'); process.exit(1) }
writeFileSync(SENTINEL, JSON.stringify({ doc: DOC, which: 'A' }))
writeFileSync(DOC, A)
const b = run()
check('② 改错开头那句现行摘要 ⇒ ⑯ 红', b.code !== 0 && /⑯/.test(b.out), `fail=${failLine(b.out)}`)
restore()

// ── 破验 B：fail closed —— 把一处**错的**抄写放进留档区、但**不在** `### 3.0*` 小节里 ──
const t2 = readFileSync(DOC, 'utf8')
const arch = t2.indexOf('## 三、逐轮留档')
const jump = t2.indexOf('\n## 四、', arch)   // §三 与 §四 之间
if (jump < 0) { console.log('  x 找不到 §三/§四 的边界'); process.exit(1) }
const B = t2.slice(0, jump) + '\n\n（游离读数）**145 行 = 111 ✅ / 1 🟡 / 4 ⏸ / 0 ⬜**\n' + t2.slice(jump)
writeFileSync(SENTINEL, JSON.stringify({ doc: DOC, which: 'B' }))
writeFileSync(DOC, B)
const c = run()
check('③ 把错的抄写塞进留档区（不在 3.0* 小节）⇒ fail closed 报红',
  c.code !== 0 && /不在 .?### 3\.0/.test(c.out), `fail=${failLine(c.out)}`)
restore()

const d = run()
check('④ 还原后逐字节相同且绿', sha(readFileSync(DOC)) === sha(pristine) && d.code === 0 && failLine(d.out) === '0', `fail=${failLine(d.out)}`)

console.log(`\n  汇总：${pass}/4 ${pass === 4 ? '—— 两半都咬住' : '—— 有失败'}`)
process.exit(pass === 4 ? 0 : 1)
