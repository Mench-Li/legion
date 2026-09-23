// scripts/probes/_mutate-r46-tally.mjs —— 第 46 轮破验：`tallyLedger` 收敛到所有者之后会咬人吗
//
// ★ 被验的三条性质：
//
//     T1 `tallyLedger` 与所有者**对同一行同判**（接受规则不许比所有者宽）
//     T2 分档是**派生**的（词表加一个标记 ⇒ 它立刻多一档）
//     T3 `canonicalJson` 键序无关（那条事实不许依赖对象插入顺序）
//
// ★★ 为什么必须用**变异**：
//   T1：`✅🟡` 这类格子**真台账里一条都没有** ⇒ 今天的仓库碰不到它。
//   T2：在**今天**这张四标记词表上，"派生分档"与"四个手写 if"返回值**完全一样**。
//   T3：`tallyLedger` 在词表不变时永远按同一顺序建键 ⇒ 顺序差异碰不到。
//
//   > 三条性质里，有两条在**今天**的输入下**没有任何区别**。
//
// ★ 纪律：一条一跑；信号与 `exit` 上补还原；逐字节还原（sha256）后才算通过。
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/project/DSH/legion'
const FACTER = `${ROOT}/scripts/prt/boundary-facts.mjs`
const SUITE = 'scripts/prt/boundary-facts.test.mjs'

// ── ★★★ 第 46 轮新增：**"被杀的变异跑"必须留下痕迹** ──────────────────────
//
// 这个坑已经踩过**两次**（第 44 轮 `_mutate-r44-tally.mjs` M5、本轮 T3）：
// 变异跑的时长会超过工具的执行上限，进程被强杀 ⇒ `finally` / `process.on('exit')`
// **都不会跑** ⇒ 源文件被留在**变异形态**。
//
// 而它下一次的症状是「锚点命中 0 次」——
// **和"锚点打错字"是同一个读数**。于是人会去改锚点，而真凶是上一次的残留。
//
//   > 一个"上一次被杀了"的状态，与一个"这次锚点写错了"的状态，
//   > 在输出里都是同一句话。而前者只需要还原文件，后者需要改代码。
//
// ⇒ 处置：变异**之前**落下哨兵，还原**之后**删掉；启动时先查哨兵。
const SENTINEL = `${ROOT}/scripts/probes/.mutant-in-progress.json（**已随批次丢弃**）`

const sha = (b) => createHash('sha256').update(b).digest('hex')
const PRISTINE = readFileSync(FACTER)

function restore() { writeFileSync(FACTER, PRISTINE); rmSync(SENTINEL, { force: true }) }

if (existsSync(SENTINEL)) {
  let info = {}
  try { info = JSON.parse(readFileSync(SENTINEL, 'utf8')) } catch { /* ignore */ }
  console.error('  ✖✖ 发现哨兵：**上一次变异跑没有正常收尾**（很可能是被强制杀掉的）。')
  console.error(`      它当时正在跑的变异：${info.label ?? '(未记录)'}`)
  console.error(`      它改的文件：${info.file ?? FACTER}`)
  console.error('      ⇒ 源文件可能**还停在变异形态**。本脚本已按启动时的快照还原它。')
  console.error('      ⚠️ 但"启动时的快照"若本身就是变异的，就还原不回来——')
  console.error('         那时请用 `git diff` / `git checkout -- <file>` 核对。')
  restore()
  console.error('      ✔ 已按本脚本启动时读到的内容写回，并删除哨兵。\n')
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { restore(); process.exit(130) })
process.on('exit', () => {
  try { if (sha(readFileSync(FACTER)) !== sha(PRISTINE)) restore() } catch { /* ignore */ }
})

function runSuite() {
  try {
    const out = execFileSync('node', ['--test', SUITE], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return summarize(out, 0)
  } catch (e) {
    return summarize(String(e.stdout ?? ''), e.status ?? 1)
  }
}
function summarize(out, code) {
  const g = (re) => { const m = re.exec(out); return m === null ? null : Number(m[1]) }
  return { ok: code === 0, pass: g(/^ℹ pass (\d+)$/m), fail: g(/^ℹ fail (\d+)$/m),
    failed: [...out.matchAll(/^✖ (.+?) \(/gm)].map((m) => m[1]).slice(0, 3) }
}

/** 换行符无关的替换。 */
function swap(from, to) {
  const text = readFileSync(FACTER).toString('utf8')
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const f = from.split('\n').join(eol)
  const t = to.split('\n').join(eol)
  const hits = text.split(f).length - 1
  if (hits !== 1) return `锚点命中 ${hits} 次（应为 1）；换行=${eol === '\r\n' ? 'CRLF' : 'LF'}`
  writeFileSync(FACTER, text.replace(f, t))
  return null
}

const ONLY = process.argv[2] ?? null
const results = []

function mutate({ label, from, to, expect }) {
  if (ONLY !== null && !label.startsWith(ONLY)) return
  const err = swap(from, to)
  if (err !== null) {
    console.log(`  ✖ ${label}：${err}`)
    console.log('     ⚠️ 也请核对：**上一次变异跑是不是被杀了、把这个文件留在变异形态**？')
    console.log('        （本脚本启动时会自己查哨兵并报出来——若没报，就不是那个原因。）')
    results.push(false)
    return
  }
  // ★ 变异已落盘 ⇒ 落哨兵。被强杀时它会留下，下次启动就能认出来。
  writeFileSync(SENTINEL, JSON.stringify({ label, file: FACTER, at: new Date().toISOString() }, null, 2))
  let res
  try { res = runSuite() } finally { restore() }
  const restored = sha(readFileSync(FACTER)) === sha(PRISTINE)
  const bit = res.ok === false
  const ok = bit && restored
  console.log(`  ${ok ? '✔' : '✖'} ${label}`)
  console.log(`      pass=${res.pass} fail=${res.fail}  咬住=${bit} 还原=${restored}`)
  if (res.failed.length > 0) console.log(`      红的：${res.failed.join(' / ')}`)
  results.push(ok)
}

console.log('第 46 轮破验：`tallyLedger` 的判定权交回所有者之后会不会咬人\n')

// ── T1：接受规则退回 `startsWith`（比所有者宽）──
//    模拟旧实现：把"整格等于"换成"以某个标记开头"。
mutate({
  label: 'T1 接受规则退回 startsWith（比所有者宽）⇒ ⑯c 必须红',
  from: '      row = ledgerTaskRow(line, { marks: marks.map((m) => m.mark) })',
  to: '      row = (() => {'
    + '\n        const t = String(line).trim()'
    + '\n        if (!t.startsWith(\'|\')) return null'
    + '\n        const cells = t.split(\'|\').slice(1, -1).map((c) => c.trim())'
    + '\n        if (cells.length < 3) return null'
    + '\n        if (!/^(PRT-\\d+)/.exec(cells[0])) return null'
    + '\n        const st = cells.map((c) => c.trim()).find((c) => marks.some((m) => c.startsWith(m.mark)))'
    + '\n        if (st === undefined) throw new Error(\'抬头\')'
    + '\n        return { prt: \'x\', status: st, cells }'
    + '\n      })()',
})

// ── T2：分档退回**四个手写 if**（丢掉派生）──
mutate({
  label: 'T2 分档退回手写 if（丢掉派生）⇒ ⑯d 必须红',
  from: '  for (const { mark, tallyKey } of marks) out[tallyKey] += counts.get(mark)',
  to: '  out.done = counts.get(\'✅\')'
    + '\n  out.partial = counts.get(\'🟡\')'
    + '\n  out.paused = counts.get(\'⏸\')'
    + '\n  out.todo = counts.get(\'⬜\')',
})

// ── T3：`canonicalJson` 退回插入顺序 ──
mutate({
  label: 'T3 `canonicalJson` 退回插入顺序 ⇒ ⑯e 必须红',
  from: '  const sorted = {}\n  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k]\n  return JSON.stringify(sorted)',
  to: '  return JSON.stringify(obj)',
})

const good = results.filter(Boolean).length
console.log(`\n  汇总：${good}/${results.length} 咬住`)
if (results.length > 0 && good === results.length) console.log('  逐字节还原 ✔')
process.exit(good === results.length ? 0 : 1)
