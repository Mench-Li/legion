// scripts/probes/_mutate-r44-tally.mjs —— 第 44 轮 `tallyLedger` 那个缺陷的破验
//
// ★ 被修的东西（`scripts/prt/boundary-facts.mjs`）：
//
//     const st = cells.map(c => c.trim()).find(c => /^(✅|⏸|⬜)/.test(c))
//     if (st === undefined) continue        // ← 认不出就跳过
//
//   `PRT-316` 转 🟡 之后，那一条**从总数里消失**：报 144，而台账有 145 条。
//   最坏的不是少算，而是**少算出来的数正好能过门禁**——
//   报告里写「144 行」，`handover-ledger-tallies` 就判绿。
//
// ★ 本脚本逐条把"修法"退回缺陷形态，确认**每一条都有用例咬得住**：
//
//   M1  🟡 从认得的标记里去掉（退回"认不出"）
//   M2  `throw` 退回 `continue`（退回"静默跳过"）
//   M3  台账里把一条 ✅ 改成别的（钳住"数错个数"）
//   M4  交接报告那句里的 `1 🟡` 改成 `0 🟡`（钳住"四个数都核"）
//   M5  🟡 归到 ✅ 那一档（钳住"四档不许互相吞并"）
//
// ★ 纪律（第 42～44 轮反复踩过）：
//   · 变异必须跑在**新进程**里（`node --test` 本来就是）；
//   · 变异必须覆盖缺陷的**每一行**（M1 与 M2 是两行，分开验）；
//   · 锚点必须**唯一**，改完要核对"恰好变了 1 处"；
//   · 逐字节还原（sha256 相等），否则会把别人的工作树写坏。
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/project/DSH/legion'
const FACTS = `${ROOT}/scripts/prt/boundary-facts.mjs`
const TEST = 'scripts/prt/boundary-facts.test.mjs'
const HANDOVER = `${ROOT}/docs/superpowers/prt/PRT-HANDOVER-2026-09-18-ROUND22.md`
const LEDGER = `${ROOT}/docs/superpowers/prt/PRT-PROGRESS.md`

const sha = (b) => createHash('sha256').update(b).digest('hex')

/** 跑一次用例；返回 `true` = 被咬住（红了）。 */
function bites() {
  try {
    execFileSync('node', ['--test', TEST], { cwd: ROOT, stdio: 'pipe' })
    return false // exit 0 ⇒ 全绿 ⇒ 变异没被咬住
  } catch {
    return true // 非 0 ⇒ 有用例红了
  }
}

/** 对某文件做一次**唯一**字面替换，跑用例，再逐字节还原。 */
function grow({ label, file, from, to, expect = true }) {
  const before = readFileSync(file)
  const text = before.toString('utf8')
  const hits = text.split(from).length - 1
  if (hits !== 1) {
    // ★★★ 第 44 轮踩过：这个报错**有两种完全不同的原因**——
    //   ① 锚点写错了（我写错字符串）；
    //   ② **上一次变异跑被杀了，`finally` 没跑到，文件现在还是变异形态**。
    //
    //   实测：M5 那一次整个命令在 600 秒上限被杀，文件被留在 `done += 1`；
    //   下一次跑报的就是「锚点命中 0 次」——与"我把锚点写错了"**同一个读数**。
    //
    //   > 一个"锚点写错了"的报错，与一个"上一轮把文件留在变异形态"，
    //   > 在这句话里是同一个东西——
    //   > 只不过前者改一个字就好，后者会让**后面每一条变异都报同一个错**。
    //
    //   ⇒ 所以这里把两种可能**都印出来**，并且：先把文件与 git HEAD 或
    //     本次进程开始时的那份比对，让"被留在变异形态"一眼可见。
    console.log(`  ✖ ${label}：锚点命中 ${hits} 次（应为 1）⇒ 变异串没找到或不止一处`)
    console.log(`     ⚠️ 也请核对：**上一次变异跑是不是被杀了、把这个文件留在变异形态**？`)
    console.log(`        （试：\`git diff -- ${file.slice(ROOT.length + 1)}\` 看有没有不属于本次修法的改动）`)
    return { label, ok: false, note: `锚点命中 ${hits} 次` }
  }
  writeFileSync(file, text.replace(from, to))
  let bitten
  try {
    bitten = bites()
  } finally {
    writeFileSync(file, before)
  }
  const restored = sha(readFileSync(file)) === sha(before)
  const ok = bitten === expect && restored
  console.log(`  ${ok ? '✔' : '✖'} ${label}：咬住=${bitten}（期望 ${expect}）还原=${restored}`)
  return { label, ok, note: `咬住=${bitten} 还原=${restored}` }
}

// ★★★ 第 44 轮踩过之后加的：命令被杀时 `finally` **不会**跑（SIGKILL），
//   文件会被留在变异形态。这里对可捕获的信号补一道还原。
//
//   ⚠️ 但 `try/finally` + 信号处理**都不是万无一失**（SIGKILL / 超时强杀都绕过去），
//   所以真正的防线是：**一次只跑一条变异**（`node <本脚本> M5`），
//   让单次命令远低于超时上限。整轮跑满会超过 600 秒。
const PRISTINE = new Map()
for (const f of [FACTS, TEST, HANDOVER, LEDGER]) PRISTINE.set(f, readFileSync(f))
const restoreAll = () => {
  for (const [f, b] of PRISTINE) writeFileSync(f, b)
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { restoreAll(); process.exit(130) })
}
process.on('exit', () => {
  // ★ 只在"还有文件与进程开始时不同"时才写，避免无谓地改动 mtime。
  for (const [f, b] of PRISTINE) {
    if (sha(readFileSync(f)) !== sha(b)) writeFileSync(f, b)
  }
})

console.log('第 44 轮破验：tallyLedger 认不出 🟡 / 不认识的标记静默跳过\n')
// ★ 可只跑一条：`node scripts/probes/_mutate-r44-tally.mjs M5`
//   （每一次变异都要跑一遍 `boundary-facts.test.mjs`，约 100～150 秒；
//    整轮跑满会超过单次命令的 600 秒上限 ⇒ 支持按前缀挑。）
const ONLY = process.argv[2] ?? null
if (ONLY) console.log(`  （只跑标签以 "${ONLY}" 开头的那一条）\n`)
const results = []
/** 与 `grow` 同一件事，但受 `ONLY` 过滤。 */
const growIf = (spec) => {
  if (ONLY !== null && !spec.label.startsWith(ONLY)) return null
  return grow(spec)
}

// ── M1：把**派生**退回**手抄**（第 45 轮改写；原锚点已被那次重构消灭）──
//    ★ 期望**被咬住**：手抄的那份**不含 🟡** ⇒ 真实台账里那条 🟡 行认不出来。
//
//    ★★★ 注意这条变异**自己在讲一个故事**：第 45 轮之前，这一行的样子是
//
//        export const LEDGER_STATUS_MARKERS = Object.freeze(['✅', '🟡', '⏸', '⬜'])
//
//    也就是说，"词表在这里被抄了一份"**就是**当时的代码。第 45 轮把它改成
//    从 `progress-check.mjs` 取（一处所有）之后，**"把这四个字面量写回来"
//    本身**就成了一条缺陷变异——这正是那条重构有效的证据。
//
//    > 一次重构如果**没法**用一个变异表达"退回去"，那它就没有改变形状；
//    > 而这一次，退回缺陷的写法恰好是**删掉等号右边**。
results.push(growIf({
  label: 'M1 词表退回手抄的三个（丢掉 🟡 且不再派生）',
  file: FACTS,
  from: 'export const LEDGER_STATUS_MARKERS = LEDGER_STATUS_MARKS',
  to: "export const LEDGER_STATUS_MARKERS = Object.freeze(['✅', '⏸', '⬜'])",
}))

// ── M2：`throw` 退回 `continue` ⇒ 退回"静默跳过" ──
//    ★ 期望**被咬住**：⑭b-2 那条"认不出必须抛"直接红。
//    ★ 这一条与 M1 是**两个不同的行**，必须分开验：
//      M1 管"认不认得 🟡"，M2 管"认不出来时怎么办"。
//      只验其中一条，另一条可以在保持绿色的情况下退回缺陷形态。
results.push(growIf({
  label: 'M2 认不出时报错 → 改成静默跳过',
  file: FACTS,
  from: '      throw new Error(`台账第 ${i + 1} 行是一个',
  to: '      void `台账第 ${i + 1} 行是一个',
}))

// ── M3：台账里把一条 ✅ 改成 🟡（钳住"数错个数"）──
//    ★ 期望**被咬住**：真实台账的分布立刻与用例写死的 140 ✅ 不符。
results.push(growIf({
  label: 'M3 台账里一条 ✅ → 🟡（分布变了）',
  file: LEDGER,
  from: '| PRT-010 DSH 组合层/profile/bundle/patch 锚点基线 | ✅ |',
  to: '| PRT-010 DSH 组合层/profile/bundle/patch 锚点基线 | 🟡 |',
}))

// ── M4：交接报告那句 `1 🟡` → `0 🟡`（钳住"四个数都核"）──
//    ★ 期望**被咬住**：`handover-ledger-tallies` 的 claim 与 derive 对不上。
results.push(growIf({
  label: 'M4 报告里 `1 🟡` → `0 🟡`',
  file: HANDOVER,
  from: '| 台账 | **145 行 = 140 ✅ / 1 🟡 / 4 ⏸ / 0 ⬜** |',
  to: '| 台账 | **145 行 = 140 ✅ / 0 🟡 / 4 ⏸ / 1 ⬜** |',
}))

// ── M5：把 🟡 折进 ✅（四档互相吞并）──
//    ★ 期望**被咬住**：真实台账会数出 141 ✅，与用例写死的 140 不符。
results.push(growIf({
  label: 'M5 🟡 归到 ✅ 那一档（两档吞并）',
  file: FACTS,
  from: "    else if (st.startsWith('🟡')) partial += 1",
  to: "    else if (st.startsWith('🟡')) done += 1",
}))

const kept = results.filter((r) => r !== null)
const bad = kept.filter((r) => !r.ok)
console.log(`\n  汇总：${kept.length - bad.length}/${kept.length} 咬住`)
if (bad.length > 0) {
  for (const b of bad) console.log(`    ✖ ${b.label} —— ${b.note}`)
  process.exit(1)
}
console.log('  0 漏网、逐字节还原 ✔')
