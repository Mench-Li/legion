// scripts/probes/_mutate-r47-status-table.mjs —— 第 47 轮破验：第三个解析器收敛之后会咬人吗
//
// ★ 被验的两条性质：
//
//     V1 认不出的状态格必须**抛**（不许静默归成 🟡）
//     V2 格子数阈值与 `parseCalibration()` / 所有者**同一条**（`>= 4`）
//
// ★★ 为什么必须用**变异**：真文档里既没有不认识的状态、也没有 4/7 格的状态行
//   ⇒ 两条性质在**今天**的任何真实输入下**都不显形**（实测：两个解析器读数一致）。
//
// ★ 沿用第 46 轮加的**哨兵**纪律：变异前落下、还原后删除、启动时查残留。
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/project/DSH/legion'
const TARGET = `${ROOT}/scripts/prt/spec-status-calibration.mjs`
const SUITE = 'scripts/prt/spec-status-calibration.test.mjs'
const SENTINEL = `${ROOT}/scripts/probes/.mutant-in-progress.json（**已随批次丢弃**）`

const sha = (b) => createHash('sha256').update(b).digest('hex')
const PRISTINE = readFileSync(TARGET)

function restore() { writeFileSync(TARGET, PRISTINE); rmSync(SENTINEL, { force: true }) }

if (existsSync(SENTINEL)) {
  let info = {}
  try { info = JSON.parse(readFileSync(SENTINEL, 'utf8')) } catch { /* ignore */ }
  console.error(`  ✖✖ 发现哨兵：上一次变异跑没有正常收尾（${info.label ?? '未记录'}）`)
  console.error('      ⇒ 源文件可能还停在变异形态。已按启动快照还原。')
  restore()
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { restore(); process.exit(130) })
process.on('exit', () => {
  try { if (sha(readFileSync(TARGET)) !== sha(PRISTINE)) restore() } catch { /* ignore */ }
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

function swap(from, to) {
  const text = readFileSync(TARGET).toString('utf8')
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const f = from.split('\n').join(eol)
  const t = to.split('\n').join(eol)
  const hits = text.split(f).length - 1
  if (hits !== 1) return `锚点命中 ${hits} 次（应为 1）；换行=${eol === '\r\n' ? 'CRLF' : 'LF'}`
  writeFileSync(TARGET, text.replace(f, t))
  return null
}

const ONLY = process.argv[2] ?? null
const results = []

function mutate({ label, from, to }) {
  if (ONLY !== null && !label.startsWith(ONLY)) return
  const err = swap(from, to)
  if (err !== null) { console.log(`  ✖ ${label}：${err}`); results.push(false); return }
  writeFileSync(SENTINEL, JSON.stringify({ label, file: TARGET }, null, 2))
  let res
  try { res = runSuite() } finally { restore() }
  const restored = sha(readFileSync(TARGET)) === sha(PRISTINE)
  const bit = res.ok === false
  const ok = bit && restored
  console.log(`  ${ok ? '✔' : '✖'} ${label}`)
  console.log(`      pass=${res.pass} fail=${res.fail}  咬住=${bit} 还原=${restored}`)
  if (res.failed.length > 0) console.log(`      红的：${res.failed.join(' / ')}`)
  results.push(ok)
}

console.log('第 47 轮破验：功能对照表的第三个解析器收敛之后会不会咬人\n')

// ── V1：认不出改成静默归档（退回"其余 ⇒ 🟡"那条路）──
mutate({
  label: 'V1 认不出改成静默归档 ⇒ ⑫ 必须红',
  from: '    if (!FEATURE_STATUS_RE.test(cells[2] ?? \'\')) {',
  to: '    if (false) {',
})

// ── V2：格子数阈值退回 `≠5 且 ≠6` ──
//    ★ 锚点必须带上上面那行注释：`if (cells.length < 4) continue` 在本文件里
//      **出现两次**（`parseStatusTable` 与 `parseCalibration`）——
//      而"锚点命中 2 次"本身就是"两个函数现在真的用了同一条阈值"的证据。
mutate({
  label: 'V2 阈值退回「≠5 且 ≠6」⇒ ⑬ 必须红',
  from: '    // ★ 阈值 `< 4` 与 `parseCalibration()` 及所有者一致（见上面那段）。\n    if (cells.length < 4) continue',
  to: '    if (cells.length !== 5 && cells.length !== 6) continue',
})

const good = results.filter(Boolean).length
console.log(`\n  汇总：${good}/${results.length} 咬住`)
if (results.length > 0 && good === results.length) console.log('  逐字节还原 ✔')
process.exit(good === results.length ? 0 : 1)
