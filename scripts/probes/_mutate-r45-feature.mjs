// scripts/probes/_mutate-r45-feature.mjs —— 第 45 轮（续）破验：**功能表**那两张判据会咬人吗
//
// ★ 被验的三条性质（对应三个消费者侧的形状）：
//
//     F1 消费者**从所有者取**词表（而不是自己抄一份 7 种的）
//     F2 认不出的状态格**抛**（而不是 `continue`）
//     F3 所有者的词表**派生**自 `FEATURE_STATUS_MARKS`（而不是又一份字面量）
//
// ★★ 为什么要单独破验：第 45 轮上半场已经吃过一次亏——
//    "🔵 会抛"这个读数**区分不了**"跟着词表走"与"把词表抄在本地"，
//    因为两者在词表没变时**行为完全一样**。
//    这里 F1/F3 是同一类（"取"vs"抄"），所以必须用**变异**把它分开：
//    只有把缺陷**放回去**、看判据是不是真的红，才能说明判据有分辨力。
//
// ★ 纪律（第 44 轮被杀那次的教训）：一条一跑；信号与 `exit` 上补还原；
//   逐字节还原（sha256）后才算通过。
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/project/DSH/legion'
const OWNER = `${ROOT}/scripts/prt/progress-check.mjs`
const CONSUMER = `${ROOT}/scripts/prt/feature-evidence.mjs`
const SUITE_CONSUMER = 'scripts/prt/feature-evidence.test.mjs'
const SUITE_PROGRESS = 'scripts/prt/progress-check.test.mjs'

const sha = (b) => createHash('sha256').update(b).digest('hex')

const PRISTINE = new Map()
for (const f of [OWNER, CONSUMER]) PRISTINE.set(f, readFileSync(f))
const restoreAll = () => { for (const [f, b] of PRISTINE) writeFileSync(f, b) }
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { restoreAll(); process.exit(130) })
}
process.on('exit', () => {
  for (const [f, b] of PRISTINE) {
    if (sha(readFileSync(f)) !== sha(b)) writeFileSync(f, b)
  }
})

/** 跑一条套件，返回 `{ok, pass, fail, tail}`。 */
function runSuite(file) {
  try {
    const out = execFileSync('node', ['--test', file], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return summarize(out, 0)
  } catch (e) {
    return summarize(String(e.stdout ?? ''), e.status ?? 1)
  }
}
function summarize(out, code) {
  const g = (re) => { const m = re.exec(out); return m === null ? null : Number(m[1]) }
  return {
    ok: code === 0,
    pass: g(/^ℹ pass (\d+)$/m),
    fail: g(/^ℹ fail (\d+)$/m),
    tail: out.trim().split('\n').slice(-4).join(' | ').slice(0, 200),
  }
}

/** 期望换行符无关的替换。 */
function swap(file, from, to) {
  const buf = readFileSync(file)
  const text = buf.toString('utf8')
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const f = from.split('\n').join(eol)
  const t = to.split('\n').join(eol)
  const hits = text.split(f).length - 1
  if (hits !== 1) return { err: `锚点命中 ${hits} 次（应为 1）；文件换行=${eol === '\r\n' ? 'CRLF' : 'LF'}` }
  writeFileSync(file, text.replace(f, t))
  return { ok: true }
}

const ONLY = process.argv[2] ?? null
const results = []

/** 一条变异：改 → 跑套件 → 还原 → 报"是否被咬住"。 */
function mutate({ label, file, from, to, suite, expectRed = true }) {
  if (ONLY !== null && !label.startsWith(ONLY)) return
  const buf = readFileSync(file)
  const r = swap(file, from, to)
  if (r.err !== undefined) {
    console.log(`  ✖ ${label}：${r.err}`)
    console.log('     ⚠️ 也请核对：**上一次变异跑是不是被杀了、把这个文件留在变异形态**？')
    results.push(false)
    return
  }
  let res
  try {
    res = runSuite(suite)
  } finally {
    writeFileSync(file, buf)
  }
  const restored = sha(readFileSync(file)) === sha(buf)
  const red = res.ok === false
  const ok = red === expectRed && restored
  console.log(`  ${ok ? '✔' : '✖'} ${label}`)
  console.log(`      ${suite}：exit=${res.ok ? 0 : 1} pass=${res.pass} fail=${res.fail}`
    + `  期望红=${expectRed} 实际红=${red} 还原=${restored}`)
  if (!ok && res.ok === false) console.log(`      ⇒ ${res.tail}`)
  results.push(ok)
}

console.log('第 45 轮（续）破验：功能表词表的两条性质会不会咬人\n')

// ── F1：消费者退回**自己抄一份**（7 种，丢掉 13 种）──
//    ★ 期望红：`🟡→⏸` 又被静默丢掉，用例 ⑪/⑫ 会报。
mutate({
  label: 'F1 消费者退回手抄的 7 种 ⇒ 套件必须红',
  file: CONSUMER,
  from: 'export const STATUS_RE = FEATURE_STATUS_RE',
  to: "export const STATUS_RE = /^(?:✅|🟡|⏸|⬜|🟡→✅|⬜→🟡|✅→🟡)$/",
  suite: SUITE_CONSUMER,
})

// ── F2：`throw` 退回 `continue` ⇒ 退回"静默丢行" ──
mutate({
  label: 'F2 认不出就 `continue`（退回静默丢行）⇒ 套件必须红',
  file: CONSUMER,
  from: "      throw new Error(`功能对照表的状态格不是已知形状：第 ${i + 1} 行`",
  to: "      if (true) continue; throw new Error(`功能对照表的状态格不是已知形状：第 ${i + 1} 行`",
  suite: SUITE_CONSUMER,
})

// ── F3：所有者退回**字面量**（不再派生，且丢掉箭头）──
//    ★ 期望红：用例 ⑯ 钉的是"由 `FEATURE_STATUS_MARKS` 派生 + 16 种箭头都认"。
mutate({
  label: 'F3 所有者退回字面量四个终态（不再派生）⇒ 套件必须红',
  file: OWNER,
  from: 'export const FEATURE_STATUS_RE = new RegExp(`^(?:${_FM}|(?:${_FM})→(?:${_FM}))$`)',
  to: 'export const FEATURE_STATUS_RE = /^(?:✅|🟡|⬜|⏸)$/',
  suite: SUITE_PROGRESS,
})

const good = results.filter(Boolean).length
console.log(`\n  汇总：${good}/${results.length} 咬住`)
if (results.length > 0 && good === results.length) console.log('  逐字节还原 ✔')
process.exit(good === results.length ? 0 : 1)
