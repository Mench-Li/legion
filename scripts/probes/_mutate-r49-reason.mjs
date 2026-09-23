// scripts/probes/_mutate-r49-reason.mjs —— 第 49 轮破验：位置指称那条规则会咬人吗
//
// ★ 被验的三条：
//
//     X1 规则的**类相同**那一检查（摘掉 ⇒ "类不同"那种漏掉）
//     X2 规则的**裁决处相同**那一检查（摘掉 ⇒ spool 那种漏掉）
//     X3 **数据**：把 spool 的 reason 退回错位形态 ⇒ 真基线断言必须红
//
// ★★ 为什么必须变异：
//   X1/X2：今天的真表上这两种情形**已经被修掉了** ⇒ 摘掉检查也照样 0 条违规。
//   X3  ：这正是本轮修的那个真缺陷 —— 不放回去就看不出判据在管它。
//
// ★ 沿用**哨兵**：被强杀的变异跑会把文件留在变异形态，
//   而它下次的症状「锚点命中 0 次」与"锚点打错字"同形。
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/project/DSH/legion'
const SENTINEL = `${ROOT}/scripts/probes/.mutant-in-progress.json（**已随批次丢弃**）`
const RULE = `${ROOT}/scripts/prt/reachability.mjs`
const BASE = `${ROOT}/docs/superpowers/prt/prt-reachability-baseline.json`
const SUITE = 'scripts/prt/reachability.test.mjs'

const sha = (b) => createHash('sha256').update(b).digest('hex')
const files = [RULE, BASE]
const pristine = new Map(files.map((f) => [f, readFileSync(f)]))
const restore = () => { for (const [f, b] of pristine) writeFileSync(f, b); rmSync(SENTINEL, { force: true }) }

if (existsSync(SENTINEL)) {
  let info = {}
  try { info = JSON.parse(readFileSync(SENTINEL, 'utf8')) } catch { /* ignore */ }
  console.error(`  ✖✖ 哨兵在场：上一次变异跑没有正常收尾（${info.label ?? '未记录'}）⇒ 已还原。`)
  restore()
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { restore(); process.exit(130) })
process.on('exit', () => {
  try { for (const [f, b] of pristine) if (sha(readFileSync(f)) !== sha(b)) { restore(); break } } catch { /* ignore */ }
})

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

function swap(file, from, to) {
  const text = readFileSync(file).toString('utf8')
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const f = from.split('\n').join(eol)
  const t = to.split('\n').join(eol)
  const hits = text.split(f).length - 1
  if (hits !== 1) return `锚点命中 ${hits} 次（应为 1）；换行=${eol === '\r\n' ? 'CRLF' : 'LF'}`
  writeFileSync(file, text.replace(f, t))
  return null
}

const ONLY = process.argv[2] ?? null
const results = []

function mutate({ label, file, from, to }) {
  if (ONLY !== null && !label.startsWith(ONLY)) return
  const err = swap(file, from, to)
  if (err !== null) { console.log(`  ✖ ${label}：${err}`); results.push(false); return }
  writeFileSync(SENTINEL, JSON.stringify({ label, file }, null, 2))
  let res
  try { res = runSuite() } finally { restore() }
  const restored = files.every((f) => sha(readFileSync(f)) === sha(pristine.get(f)))
  const bit = res.ok === false
  const ok = bit && restored
  console.log(`  ${ok ? '✔' : '✖'} ${label}`)
  console.log(`      pass=${res.pass} fail=${res.fail}  咬住=${bit} 还原=${restored}`)
  if (res.failed.length > 0) console.log(`      红的：${res.failed.join(' / ')}`)
  results.push(ok)
}

console.log('第 49 轮破验：`reason` 里的位置指称这条规则会不会咬人\n')

// ── X1：摘掉"类相同"检查 ──
mutate({
  label: 'X1 摘掉"class 相同"检查 ⇒ 三种指不上那条必须红',
  file: RULE,
  from: '    if (prev.class !== e.class) {\n'
    + '      bad.push({ file: e.file, why: `上一条（${prev.file}）是 ${prev.class}，本条是 ${e.class}` })\n'
    + '      return\n'
    + '    }',
  to: '    if (false) { /* 摘掉 */ }',
})

// ── X2：摘掉"裁决处相同"检查 ──
mutate({
  label: 'X2 摘掉"裁决处相同"检查 ⇒ 三种指不上那条必须红',
  file: RULE,
  from: '    if (mine !== null && mine !== theirs) {',
  to: '    if (false) {',
})

// ── X3：★ 把 spool 的 reason 退回**错位**形态（本轮修的那个真缺陷）──
mutate({
  label: 'X3 spool 的 reason 退回"上面那条收账侧" ⇒ 真基线断言必须红',
  file: BASE,
  from: '它的消费者就是 `orchestrator/worker/toolcall-drain.mjs`（收账侧）',
  to: '它的消费者就是上面那条收账侧',
})

const good = results.filter(Boolean).length
console.log(`\n  汇总：${good}/${results.length} 咬住`)
if (results.length > 0 && good === results.length) console.log('  逐字节还原 ✔')
process.exit(good === results.length ? 0 : 1)
