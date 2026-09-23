// scripts/probes/_mutate-r52-report.mjs —— 第 52 轮破验：交付物目录那两条判据会咬人吗
//
//   W1 标题退回过期轮次（`截至第 51 轮` → `截至第 15 轮`）⇒ 事实必须红
//   W2 把真实文件里相邻两节**换个位置**（16 与 17）⇒ ⑱ 必须红
//
// ★★ 两条都是**把真缺陷放回去**：W1 是本轮量到的那个已经发生的过期，
//   W2 是本轮修掉的那个倒序的**最小复现**。
//   ⇒ 不放回去就看不出判据在管它们（第 49 轮那次 X2"不咬"就是这么发现的）。
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/project/DSH/legion'
const SENTINEL = `${ROOT}/scripts/probes/.mutant-in-progress.json（**已随批次丢弃**）`
const DOC = `${ROOT}/docs/superpowers/prt/PRT-FINAL-REPORT-2026-09-18.md`
const SUITE = 'scripts/prt/boundary-facts.test.mjs'

const sha = (b) => createHash('sha256').update(b).digest('hex')
const pristine = readFileSync(DOC)
const restore = () => { writeFileSync(DOC, pristine); rmSync(SENTINEL, { force: true }) }
if (existsSync(SENTINEL)) { console.error('  !! 哨兵在场：上次变异没正常收尾 ⇒ 已还原。'); restore() }
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

const results = []
function mutate(label, apply) {
  const err = apply()
  if (err !== null) { console.log(`  x ${label}：${err}`); results.push(false); return }
  writeFileSync(SENTINEL, JSON.stringify({ label, doc: DOC }, null, 2))
  let res
  try { res = runSuite() } finally { restore() }
  const restored = sha(readFileSync(DOC)) === sha(pristine)
  const bit = res.ok === false
  console.log(`  ${bit && restored ? 'OK' : 'x '} ${label}`)
  console.log(`      pass=${res.pass} fail=${res.fail}  咬住=${bit} 还原=${restored}`)
  if (res.failed.length > 0) console.log(`      红的：${res.failed.join(' / ')}`)
  results.push(bit && restored)
}

console.log('第 52 轮破验：最终报告 §三 的目录\n')

mutate('W1 标题退回过期轮次（截至第 51 → 截至第 15）⇒ 事实必须红', () => {
  const text = readFileSync(DOC).toString('utf8')
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const from = '## 三、逐轮留档：第 16 轮起，截至第 51 轮'
  const to = '## 三、逐轮留档：第 16 轮起，截至第 15 轮'
  if (text.split(from).length - 1 !== 1) return '锚点没命中 1 次'
  writeFileSync(DOC, text.replace(from, to))
  void eol
  return null
})

mutate('W2 真实文件里把 16 与 17 两节换位 ⇒ ⑱ 必须红', () => {
  const lines = readFileSync(DOC).toString('utf8').split('\n')
  const i16 = lines.findIndex((l) => /^### 3\.0 第 16 轮/.test(l))
  const i17 = lines.findIndex((l) => /^### 3\.0b 第 17 轮/.test(l))
  const i18 = lines.findIndex((l) => /^### 3\.0c 第 18 轮/.test(l))
  if (!(i16 >= 0 && i16 < i17 && i17 < i18)) return `锚点次序不对：${i16} ${i17} ${i18}`
  const a = lines.slice(i16, i17)          // 第 16 轮那一节
  const b = lines.slice(i17, i18)          // 第 17 轮那一节
  const out = [...lines.slice(0, i16), ...b, ...a, ...lines.slice(i18)]
  if (out.length !== lines.length) return '行数不守恒'
  writeFileSync(DOC, out.join('\n'))
  return null
})

const good = results.filter(Boolean).length
console.log(`\n  汇总：${good}/${results.length} 咬住`)
if (results.length > 0 && good === results.length) console.log('  逐字节还原 OK')
process.exit(good === results.length ? 0 : 1)
