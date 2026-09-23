// scripts/probes/_mutate-r50-positional.mjs —— 第 50 轮破验：严格规则会咬人吗
//
// ★ 被验的：
//     Y1 规则的**模式**被打坏（`/同上/` → 认得出来才怪）⇒ 严格规则那条必须红
//     Y2 **数据**：把 `product/upgrade/backup.mjs` 的 reason 退回"同上" ⇒
//        真基线那条必须红
//
// ★★ Y2 是**反向**的：前几轮的变异都是"把代码改坏"，
//   这一轮还要证明"**把 14 条里任意一条放回去**"都会被抓住 ——
//   否则"真基线 0 条"可能只是因为那条断言写成了恒绿。
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
  if (hits !== 1) return `锚点命中 ${hits} 次（应为 1）`
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
  console.log(`  ${bit && restored ? '✔' : '✖'} ${label}`)
  console.log(`      pass=${res.pass} fail=${res.fail}  咬住=${bit} 还原=${restored}`)
  if (res.failed.length > 0) console.log(`      红的：${res.failed.join(' / ')}`)
  results.push(bit && restored)
}

console.log('第 50 轮破验：`reason` 必须自足（不许位置指称）\n')

mutate({
  label: 'Y1 把规则的模式打坏 ⇒ 严格规则那条必须红',
  file: RULE,
  from: "  const POSITIONAL = /同上|上面那条|上一条/\n  return entries\n    .filter((e) => POSITIONAL.test(e.reason ?? ''))",
  to: "  const POSITIONAL = /这条模式故意不匹配任何东西/\n  return entries\n    .filter((e) => POSITIONAL.test(e.reason ?? ''))",
})

mutate({
  label: 'Y2 把 backup.mjs 的 reason 退回"同上" ⇒ 真基线那条必须红',
  file: BASE,
  // ★ 锚点必须带上 `file` 那一行：6 条 product/upgrade/* 现在共享**同一句**
  //   指名理由（这正是本轮要的形状）⇒ 只锚 reason 会命中 6 次。
  //   ★ 那次"锚点命中 6 次"本身就是证据：六条真的指到**同一个**名字上了。
  from: '"file": "product/upgrade/backup.mjs",\n'
    + '      "class": "deliberate",\n'
    + '      "reason": "同 `product/upgrade/index.mjs`：升级链的一环（Launcher 刻意不 import，进程卫生）"',
  to: '"file": "product/upgrade/backup.mjs",\n'
    + '      "class": "deliberate",\n'
    + '      "reason": "同上（升级链的一环）"',
})

const good = results.filter(Boolean).length
console.log(`\n  汇总：${good}/${results.length} 咬住`)
if (results.length > 0 && good === results.length) console.log('  逐字节还原 ✔')
process.exit(good === results.length ? 0 : 1)
