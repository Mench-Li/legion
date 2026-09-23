// scripts/probes/_mutate-r51-intervention.mjs —— 第 51 轮破验：人工介入清单那两条判据会咬人吗
//
//   Z1 把读数块的标题**退回过期值**（第 50 → 第 49）⇒ ⑰ 真仓库那条必须红
//   Z2 把声明总数改掉（216 → 217）⇒ ⑰b 真仓库那条必须红
//
// ★★ 这两条都是**把真缺陷放回去**：Z1 正是本轮量到的那个已经发生的过期
//    （标题停在旧轮次），Z2 正是我本轮写那条判据时**当场犯的错**
//    （改了列表没改总数）。⇒ 不放回去就看不出判据在管它们。
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/project/DSH/legion'
const SENTINEL = `${ROOT}/scripts/probes/.mutant-in-progress.json（**已随批次丢弃**）`
const DOC = `${ROOT}/docs/superpowers/prt/PRT-HUMAN-INTERVENTION-2026-09-20.md`
const SUITE = 'scripts/prt/boundary-facts.test.mjs'

const sha = (b) => createHash('sha256').update(b).digest('hex')
const pristine = readFileSync(DOC)
const restore = () => { writeFileSync(DOC, pristine); rmSync(SENTINEL, { force: true }) }

if (existsSync(SENTINEL)) { console.error('  ✖✖ 哨兵在场：上次变异没正常收尾 ⇒ 已还原。'); restore() }
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { restore(); process.exit(130) })
process.on('exit', () => { try { if (sha(readFileSync(DOC)) !== sha(pristine)) restore() } catch { /* ignore */ } })

function runSuite() {
  try {
    const out = execFileSync('node', ['--test', SUITE], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return summarize(out, 0)
  } catch (e) { return summarize(String(e.stdout ?? ''), e.status ?? 1) }
}
function summarize(out, code) {
  const g = (re) => { const m = re.exec(out); return m === null ? null : Number(m[1]) }
  return { ok: code === 0, pass: g(/^ℹ pass (\d+)$/m), fail: g(/^ℹ fail (\d+)$/m),
    failed: [...out.matchAll(/^✖ (.+?) \(/gm)].map((m) => m[1]).slice(0, 2) }
}
function swap(from, to) {
  const text = readFileSync(DOC).toString('utf8')
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const f = from.split('\n').join(eol)
  const t = to.split('\n').join(eol)
  const hits = text.split(f).length - 1
  if (hits !== 1) return `锚点命中 ${hits} 次（应为 1）`
  writeFileSync(DOC, text.replace(f, t))
  return null
}

const ONLY = process.argv[2] ?? null
const results = []
function mutate({ label, from, to }) {
  if (ONLY !== null && !label.startsWith(ONLY)) return
  const err = swap(from, to)
  if (err !== null) { console.log(`  ✖ ${label}：${err}`); results.push(false); return }
  writeFileSync(SENTINEL, JSON.stringify({ label, doc: DOC }, null, 2))
  let res
  try { res = runSuite() } finally { restore() }
  const restored = sha(readFileSync(DOC)) === sha(pristine)
  const bit = res.ok === false
  console.log(`  ${bit && restored ? '✔' : '✖'} ${label}`)
  console.log(`      pass=${res.pass} fail=${res.fail}  咬住=${bit} 还原=${restored}`)
  if (res.failed.length > 0) console.log(`      红的：${res.failed.join(' / ')}`)
  results.push(bit && restored)
}

console.log('第 51 轮破验：人工介入清单的读数块\n')

mutate({
  label: 'Z1 标题退回过期轮次（第 50 → 第 49）⇒ ⑰ 必须红',
  from: '**第 50 轮结束时的读数**（全部可复跑）：',
  to: '**第 49 轮结束时的读数**（全部可复跑）：',
})

mutate({
  label: 'Z2 声明总数改掉（216 → 217）⇒ ⑰b 必须红',
  from: '⇒ 十二个套件合计 **216 通过 / 0 失败**',
  to: '⇒ 十二个套件合计 **217 通过 / 0 失败**',
})

const good = results.filter(Boolean).length
console.log(`\n  汇总：${good}/${results.length} 咬住`)
if (results.length > 0 && good === results.length) console.log('  逐字节还原 ✔')
process.exit(good === results.length ? 0 : 1)
