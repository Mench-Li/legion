// scripts/probes/_mutate-r48-landing.mjs —— 第 48 轮破验：四个解析器收敛成一个所有者之后会咬人吗
//
// ★ 被验的三条性质：
//
//     W1 落点解析器**不再自己认行**（4 格 / 7 格也要读）—— 退回 `≠5 且 ≠6` 必须红
//     W2 所有者认的**词表是派生的**（注入第 5 个标记必须当场认）
//     W3 所有者的**格数阈值是参数**（注入 `minCells` 必须生效）
//
// ★★ 为什么必须用**变异**：真文档里既没有 4/7 格的功能行，也没有第 5 个状态标记
//   ⇒ 三条性质在**今天**的任何真实输入下**都不显形**（实测：四个解析器都是 29 行）。
//
// ★ 沿用第 46 轮加的**哨兵**：一个被强杀的变异跑会把源文件留在变异形态，
//   而它下次的症状「锚点命中 0 次」与"锚点打错字"**同形**。
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/project/DSH/legion'
const SENTINEL = `${ROOT}/scripts/probes/.mutant-in-progress.json（**已随批次丢弃**）`
const OWNER = `${ROOT}/scripts/prt/progress-check.mjs`
const LANDING = `${ROOT}/scripts/prt/feature-landing-paths.mjs`
const TSTATUS = `${ROOT}/scripts/prt/feature-table-status.mjs`

const sha = (b) => createHash('sha256').update(b).digest('hex')
const files = [OWNER, LANDING, TSTATUS]
const pristine = new Map(files.map((f) => [f, readFileSync(f)]))

const restore = () => { for (const [f, b] of pristine) writeFileSync(f, b); rmSync(SENTINEL, { force: true }) }

if (existsSync(SENTINEL)) {
  let info = {}
  try { info = JSON.parse(readFileSync(SENTINEL, 'utf8')) } catch { /* ignore */ }
  console.error(`  ✖✖ 哨兵在场：上一次变异跑没有正常收尾（${info.label ?? '未记录'}）⇒ 源文件可能仍是变异形态，已还原。`)
  restore()
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { restore(); process.exit(130) })
process.on('exit', () => {
  try { for (const [f, b] of pristine) if (sha(readFileSync(f)) !== sha(b)) { restore(); break } } catch { /* ignore */ }
})

function runSuite(file) {
  try {
    const out = execFileSync('node', ['--test', file], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
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

function mutate({ label, file, from, to, suite }) {
  if (ONLY !== null && !label.startsWith(ONLY)) return
  const err = swap(file, from, to)
  if (err !== null) {
    console.log(`  ✖ ${label}：${err}`)
    console.log('     ⚠️ 也请核对：上一次变异跑是不是被杀了、把这个文件留在变异形态？')
    results.push(false)
    return
  }
  writeFileSync(SENTINEL, JSON.stringify({ label, file }, null, 2))
  let res
  try { res = runSuite(suite) } finally { restore() }
  const restored = files.every((f) => sha(readFileSync(f)) === sha(pristine.get(f)))
  const bit = res.ok === false
  const ok = bit && restored
  console.log(`  ${ok ? '✔' : '✖'} ${label}`)
  console.log(`      ${suite.split('/').pop()}：pass=${res.pass} fail=${res.fail}  咬住=${bit} 还原=${restored}`)
  if (res.failed.length > 0) console.log(`      红的：${res.failed.join(' / ')}`)
  results.push(ok)
}

console.log('第 48 轮破验：功能表四个解析器收敛成一个所有者之后会不会咬人\n')

// ── W1：落点解析器退回自己的 `≠5 且 ≠6`（即不再委派）──
mutate({
  label: 'W1 落点解析器退回「≠5 且 ≠6」⇒ ⑬/⑭ 必须红',
  file: LANDING,
  suite: 'scripts/prt/feature-landing-paths.test.mjs',
  from: '    const row = featureTableRow(lines[i])\n    if (row === null) continue\n'
    + '    out.push({ line: i + 1, id: row.label, cell: row.cells[LANDING_COLUMN] ?? \'\' })',
  to: '    const l = lines[i]\n'
    + '    if (!FEATURE_ROW_RE.test(l)) continue\n'
    + '    const cells = l.replace(/^\\|/, \'\').replace(/\\|$/, \'\').split(/(?<!\\\\)\\|/).map((c) => c.trim())\n'
    + '    if (cells.length !== 5 && cells.length !== 6) continue\n'
    + '    out.push({ line: i + 1, id: cells[0], cell: cells[LANDING_COLUMN] ?? \'\' })',
})

// ── W2：所有者的词表退回**写死一份**（摘掉注入）──
mutate({
  label: 'W2 所有者词表退回写死一份 ⇒ ⑨ 必须红',
  file: OWNER,
  suite: 'scripts/prt/progress-check.test.mjs',
  from: '  const fm = marks.join(\'|\')\n  const re = new RegExp(`^(?:${fm}|(?:${fm})→(?:${fm}))$`)',
  to: '  const re = /^(?:✅|🟡|⬜|⏸|(?:✅|🟡|⬜|⏸)→(?:✅|🟡|⬜|⏸))$/',
})

// ── W3：所有者的格数阈值**忽略注入参数** ──
mutate({
  label: 'W3 所有者的 `minCells` 被忽略 ⇒ ⑨ 必须红',
  file: OWNER,
  suite: 'scripts/prt/progress-check.test.mjs',
  from: '  if (cells.length < minCells) return null   // 另一张表（见 FEATURE_ROW_MIN_CELLS）',
  to: '  if (cells.length < 4) return null          // 另一张表（阈值写死）',
})

// ── W4：第五份手写解析（`feature-table-status`）退回自己的宽度规则 ──
mutate({
  label: 'W4 `feature-table-status` 退回「≠5 且 ≠6 ⇒ 跳过」⇒ ⑧ 必须红',
  file: TSTATUS,
  suite: 'scripts/prt/feature-table-status.test.mjs',
  from: '    const row = featureTableRow(line)\n    if (row !== null) {',
  to: '    const _m = FEATURE_ROW_RE.exec(line)\n'
    + '    const _c = line.replace(/^\\|/, \'\').replace(/\\|$/, \'\').split(/(?<!\\\\)\\|/).map((x) => x.trim())\n'
    + '    const row = (_m === null || (_c.length !== 5 && _c.length !== 6)) ? null : {\n'
    + '      id: _m[1], status: _c[2], cells: _c,\n'
    + '    }\n'
    + '    if (row !== null) {',
})

const good = results.filter(Boolean).length
console.log(`\n  汇总：${good}/${results.length} 咬住`)
if (results.length > 0 && good === results.length) console.log('  逐字节还原 ✔')
process.exit(good === results.length ? 0 : 1)
