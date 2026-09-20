// scratch/_mutate-r55-s5index.mjs —�?�?55 轮破验：�?*真文�?*上把索引改陈�?�?判据必须�?import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/project/DSH/legion'
const DOC = `${ROOT}/docs/MULTI-AGENT-FEATURE-STATUS.md`
const SENTINEL = `${ROOT}/scratch/.mutant-in-progress.json`
const sha = (b) => createHash('sha256').update(b).digest('hex')
const pristine = readFileSync(DOC)
const restore = () => { writeFileSync(DOC, pristine); rmSync(SENTINEL, { force: true }) }
if (existsSync(SENTINEL)) { console.error('  !! 哨兵在场：先还原�?); restore() }
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => { restore(); process.exit(130) })
process.on('exit', () => { try { if (sha(readFileSync(DOC)) !== sha(pristine)) restore() } catch { /* ignore */ } })

const run = () => {
  try {
    const out = execFileSync('node', ['--test', 'scripts/prt/reachability.test.mjs'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (e) { return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') } }
}
const fails = (o) => { const m = /^�?fail (\d+)$/m.exec(o); return m === null ? null : Number(m[1]) }

let pass = 0
const check = (l, ok, extra = '') => { console.log(`  ${ok ? 'OK' : 'x '} ${l}${extra ? '  ' + extra : ''}`); if (ok) pass += 1 }

const a = run()
check('�?改前：reachability �?, a.code === 0 && fails(a.out) === 0, `fail=${fails(a.out)}`)

// �?在真文档里把索引�?#1 的「已裁决」改成「未标注」⇒ 索引与派生值不一�?const text = readFileSync(DOC, 'utf8')
const i = text.indexOf('决策表状态索�?)
const mutated = text.slice(0, i) + text.slice(i).replace(/(\| 1 \| [^|]+ \| )已裁�? \|)/, '$1**未标�?*$2')
if (mutated === text) { console.log('  x 锚点没改�?—�?这个破验是假�?); process.exit(1) }
writeFileSync(SENTINEL, JSON.stringify({ doc: DOC }))
writeFileSync(DOC, mutated)

const b = run()
check('�?索引改陈�?�?reachability �?, b.code !== 0 && fails(b.out) > 0, `fail=${fails(b.out)}`)
check('�?报的正是 ⑭（INDEX_STALE 那条�?, /�?.test(b.out))

restore()
const c = run()
check('�?还原后逐字节相同且�?, sha(readFileSync(DOC)) === sha(pristine) && c.code === 0 && fails(c.out) === 0, `fail=${fails(c.out)}`)

console.log(`\n  汇总：${pass}/3 ${pass === 3 ? '—�?判据在真文档上确实咬住，且只改该改的那一�? : '—�?有失�?}`)
process.exit(pass === 4 ? 0 : 1)
