// scripts/probes/_mutate-r45-vocab.mjs —— 第 45 轮破验：状态词表**是不是真的一处所有**
//
// ★ 被验的性质，以及为什么它**不能**用"🔵 会抛"来验：
//
//     `ledgerTaskRow` 今天认不出 🔵 就抛。这只证明了"它认不出 🔵"，
//     **区分不了**下面两种实现：
//
//       ① 它查的是 `LEDGER_STATUS_MARKS`（由 `STATUS_MARKS` **派生**）；
//       ② 它自己写死 `['✅','🟡','⏸','⬜']`（**抄了一份**）。
//
//     两者在**今天**行为完全一样——这正是第 42/43 轮反复遇到的
//     "行为等价 ⇒ 不可证伪"形状。
//
//   > 一个"跟着词表走"的实现，与一个"把词表抄在本地"的实现，
//   > 在词表**没变**的时候是同一个东西——
//   > 只不过前者加第 5 个状态只改一处，后者要改 N 处，
//   > 而漏掉的那几处**不报错**，只是安静地少算。
//
// ★ 所以破验这样设计（**决定性**）：
//
//     M1 往**唯一所有者** `progress-check.mjs` 的 `STATUS_MARKS` 里加第 5 个
//        标记 🔵 ⇒ 三个消费者（`boundary-facts.tallyLedger`、
//        `ledgerEvidenceRows`、`ledgerRows`）都必须**立刻**收下 🔵。
//        任何一个仍然抛 / 仍然丢行 ⇒ 它**没有**在跟那张表。
//
//     这一条同时验了"一处所有"与"派生"，而且**只有在真的派生时才可能通过**。
//
//     M2 反面控制：把 `STATUS_MARKS` 里的 🟡 **删掉** ⇒ 三个消费者都必须
//        开始对真实台账里的 🟡 行报错。若不红，说明它们没有在跟这张表
//        （或者根本没用真实台账跑）。
//
// ★ 纪律（第 44 轮被杀的那次教训）：
//   · 一条一跑（`node <本脚本> M1`）——跑满会超过单次命令的 600 秒上限，
//     而被强杀时 `finally` **不会**跑，文件会被**留在变异形态**；
//   · 信号与 `exit` 上补还原；
//   · 逐字节还原（sha256）后才算通过。
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/project/DSH/legion'
const OWNER = `${ROOT}/scripts/prt/progress-check.mjs`

const sha = (b) => createHash('sha256').update(b).digest('hex')

// ── 还原基线：进程开始时把会被改的文件留一份 ──
const PRISTINE = new Map()
for (const f of [OWNER]) PRISTINE.set(f, readFileSync(f))
const restoreAll = () => { for (const [f, b] of PRISTINE) writeFileSync(f, b) }
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { restoreAll(); process.exit(130) })
}
process.on('exit', () => {
  for (const [f, b] of PRISTINE) {
    if (sha(readFileSync(f)) !== sha(b)) writeFileSync(f, b)
  }
})

/**
 * 在**新进程**里问三个消费者"认不认 🔵"。
 *
 * 返回 `{ tally, evidence, rows, errors}`：
 *   · `errors` 里列出**抛了**的那些（抛 = 不认）。
 *   · `ok` 为真表示**三个都收下了** 🔵。
 */
function askConsumers() {
  // ★ 子脚本住在 `scratch/`，所以用**相对说明符**导入。
  //   ⚠️ 这里第一版写的是绝对路径（`'D:/project/...'`）——Windows 上
  //      默认 ESM 加载器只接受 `file:`/`data:`/`node:`，于是子脚本当场崩，
  //      而我的错误分支返回 `{error}`，外层却去读 `.errors` ⇒
  //      报出来的是 `Cannot read properties of undefined`。
  //   > 一个"子进程没跑起来"的错误，与一个"探针自己写错了"的错误，
  //   > 在只有一行 TypeError 的输出里是同一个东西。
  //   ⇒ 下面**先判**子进程有没有正常返回，再取字段。
  const probe = `
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'm45-'))
const p = join(dir, 'l.md')
writeFileSync(p, ['# T', '', '| 任务 | 状态 | 证据 |', '| --- | --- | --- |',
  '| PRT-001 甲 | 🔵 | \\\`a.md\\\` |', '| PRT-002 乙 | ✅ | \\\`b.md\\\` |'].join('\\n'))
const out = { tally: null, evidence: null, rows: null, errors: [] }
const { tallyLedger } = await import('../scripts/prt/boundary-facts.mjs')
const { ledgerEvidenceRows } = await import('../scripts/prt/ledger-evidence.mjs')
const { ledgerRows } = await import('../scripts/prt/intervention-coverage.mjs')
try { out.tally = tallyLedger(readFileSync(p, 'utf8')).total } catch (e) { out.errors.push('tallyLedger: ' + e.message.slice(0, 50)) }
try { out.evidence = ledgerEvidenceRows(p).length } catch (e) { out.errors.push('ledgerEvidenceRows: ' + e.message.slice(0, 50)) }
try { out.rows = ledgerRows(p).length } catch (e) { out.errors.push('ledgerRows: ' + e.message.slice(0, 50)) }
console.log(JSON.stringify(out))
`
  const sp = `${ROOT}/scratch/_m45-child.mjs`
  writeFileSync(sp, probe)
  try {
    const raw = execFileSync('node', ['scratch/_m45-child.mjs'], { cwd: ROOT, encoding: 'utf8' })
    const parsed = JSON.parse(raw.trim().split('\n').pop())
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.errors)) {
      return { tally: null, evidence: null, rows: null, errors: ['子脚本返回了意外形状：' + raw.slice(0, 120)] }
    }
    return parsed
  } catch (e) {
    const stderr = String(e.stderr ?? '').trim().split('\n').slice(-3).join(' / ')
    return { tally: null, evidence: null, rows: null, errors: ['子进程没跑起来：' + stderr.slice(0, 200)] }
  }
}

const ONLY = process.argv[2] ?? null
console.log('第 45 轮破验：状态词表**是不是真的一处所有**（往唯一所有者里加第 5 个标记）\n')

const before = askConsumers()
console.log('  基线（词表 = ✅ 🟡 ⏸ ⬜，合成台账含 🔵 + ✅ 两行）：')
console.log(`    tallyLedger.total=${before.tally}  ledgerEvidenceRows=${before.evidence}  ledgerRows=${before.rows}`)
console.log(`    抛了的：${before.errors.length === 0 ? '（没有）' : before.errors.join(' | ')}`)
console.log('    ★ 三个都因为认不出 🔵 而抛/少算 ⇒ 这正是"今天行为等价"的那一面\n')

/** 做一次变异，问一次消费者，再还原。 */
function mutate({ label, from, to, expectAllAccept }) {
  const buf = readFileSync(OWNER)
  const text = buf.toString('utf8')
  // ★★★ 换行无关：`progress-check.mjs` 是 **CRLF**（497 CR / 497 LF 实测），
  //   而锚点是用 `\n` 写的 ⇒ 一个用 `\n` 的 find-string 在 CRLF 文件里
  //   **静默匹配不到**（不是报错，是"命中 0 次"）。
  //
  //   > 一个"锚点写错了"的报错，与一个"文件是 CRLF 而锚点写成 LF"的报错，
  //   > 在这一步是同一个读数——
  //   > 而后者会让每一次变异都报同一句话，看起来像锚点永远写不对。
  //
  //   ⇒ 按**文件自己的**换行符重写锚点，让调用方永远只写 `\n`。
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const fix = (s) => s.split('\n').join(eol)
  const fromN = fix(from)
  const toN = fix(to)
  const hits = text.split(fromN).length - 1
  if (hits !== 1) {
    console.log(`  ✖ ${label}：锚点命中 ${hits} 次（应为 1）；文件换行=${eol === '\r\n' ? 'CRLF' : 'LF'}`)
    console.log(`     ⚠️ 也请核对：**上一次变异跑是不是被杀了、把这个文件留在变异形态**？`)
    return false
  }
  writeFileSync(OWNER, text.replace(fromN, toN))
  let res
  try {
    res = askConsumers()
  } finally {
    writeFileSync(OWNER, buf)
  }
  const restored = sha(readFileSync(OWNER)) === sha(buf)
  const allAccept = res.errors.length === 0 && res.tally === 2 && res.evidence === 2 && res.rows === 2
  const ok = allAccept === expectAllAccept && restored
  console.log(`  ${ok ? '✔' : '✖'} ${label}`)
  console.log(`      tallyLedger.total=${res.tally}  ledgerEvidenceRows=${res.evidence}  ledgerRows=${res.rows}`
    + `  抛了的=${res.errors.length === 0 ? 0 : res.errors.length}`)
  if (res.errors.length > 0) for (const e of res.errors) console.log(`        ⇒ ${e}`)
  console.log(`      期望"三个都收下"=${expectAllAccept} ；实际=${allAccept} ；还原=${restored}`)
  return ok
}

const results = []

if (ONLY === null || ONLY === 'M1') {
  // ── M1：往**唯一所有者**的 `STATUS_MARKS` 里加第 5 个标记 🔵 ──
  //    ★ 期望**三个消费者全部收下**（total=2、evidence=2、rows=2，零抛出）。
  //    ★ 任何一个仍然抛 ⇒ 它自己抄了一份词表 ⇒ 判红。
  results.push(mutate({
    label: 'M1 往 `STATUS_MARKS` 加第 5 个标记 🔵 ⇒ 三个消费者必须**都**收下',
    from: "  { mark: '⏸', label: '需外部输入' },\n])",
    to: "  { mark: '⏸', label: '需外部输入' },\n  { mark: '🔵', label: '第 5 个（破验用）' },\n])",
    expectAllAccept: true,
  }))
}

if (ONLY === null || ONLY === 'M2') {
  // ── M2：反面控制——把 🟡 从词表里**删掉** ──
  //    ★ 期望：真台账**立刻读不动**（因为里面有一条 🟡 行）。
  //      若它照样读得出来，说明那个消费者**没有**在跟这张表。
  const buf = readFileSync(OWNER)
  const text = buf.toString('utf8')
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const from = `  { mark: '🟡', label: '部分' },`.replace(/\n/g, eol) + eol
  if (text.split(from).length - 1 !== 1) {
    console.log('  ✖ M2：锚点命中数不为 1')
    results.push(false)
  } else {
    writeFileSync(OWNER, text.replace(from, ''))
    let detail = ''
    let realThrew = false
    try {
      const probe = `${ROOT}/scratch/_m45-real.mjs`
      writeFileSync(probe, `
const { ledgerEvidenceRows } = await import('../scripts/prt/ledger-evidence.mjs')
const { ledgerRows } = await import('../scripts/prt/intervention-coverage.mjs')
const out = []
try { out.push('evidence=' + ledgerEvidenceRows().length) }
catch (e) { out.push('evidence=THREW') }
try { out.push('rows=' + ledgerRows().length) }
catch (e) { out.push('rows=THREW') }
console.log(out.join(' '))
`)
      detail = execFileSync('node', ['scratch/_m45-real.mjs'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop()
      realThrew = detail.includes('THREW')
    } finally {
      writeFileSync(OWNER, buf)
    }
    const restored = sha(readFileSync(OWNER)) === sha(buf)
    const ok = realThrew && restored
    console.log(`  ${ok ? '✔' : '✖'} M2 把 🟡 从词表里删掉 ⇒ 真台账必须读不动`)
    console.log(`      ${detail} ；还原=${restored}`)
    results.push(ok)
  }
}

if (ONLY === null || ONLY === 'M3') {
  // ══════════════════════════════════════════════════════════════════════
  // ── M3 ★★★ **假变异检验**：M1 真的会咬住"某个消费者把手抄回去"吗？──
  //
  //   这是本脚本最要紧的一条。前两条只能说"今天的实现通过了 M1"；
  //   它们**不能**说明 M1 是一个**有分辨力**的判据——
  //   万一 M1 无论如何都会通过（比如我判据写反了），那它就是个装饰。
  //
  //   > 一个"永远通过"的判据，与一个"实现真的对"的判据，
  //   > 在输出上都是 ✔——
  //   > 只不过前者在任何实现下都 ✔，包括把缺陷放回去的那一版。
  //
  //   ⇒ 这里**故意把缺陷放回去**：让 `ledger-evidence.mjs` 重新手抄一份
  //     `^(✅|🟡|⏸|⬜)$`（就是第 45 轮修掉的那个形状），
  //     同时往唯一所有者里加 🔵。
  //     期望结果：`tallyLedger` 与 `ledgerRows` 收下 🔵，而
  //     `ledgerEvidenceRows` **仍然不认** ⇒ M1 的"三个都收下"变成 false。
  //     若它**照样 true**，说明 M1 没有分辨力，必须重做。
  //
  //   ⚠️ 两个文件都要还原。
  // ══════════════════════════════════════════════════════════════════════
  const CONSUMER = `${ROOT}/scripts/prt/ledger-evidence.mjs`
  const bufOwner = readFileSync(OWNER)
  const bufConsumer = readFileSync(CONSUMER)
  const fixEol = (text, s) => s.split('\n').join(text.includes('\r\n') ? '\r\n' : '\n')

  // ① 所有者：加第 5 个标记
  const ownerText = bufOwner.toString('utf8')
  const addFrom = fixEol(ownerText, "  { mark: '⏸', label: '需外部输入' },\n])")
  const addTo = fixEol(ownerText, "  { mark: '⏸', label: '需外部输入' },\n  { mark: '🔵', label: '第 5 个（破验用）' },\n])")
  // ② 消费者：把手抄的词表放回去（`ledgerTaskRow` 改成自己判）
  const cText = bufConsumer.toString('utf8')
  const regressFrom = "    const r = ledgerTaskRow(line)\n    if (r === null) continue"
  const regressTo = "    const r = ledgerTaskRow(line, { marks: ['✅', '🟡', '⏸', '⬜'] })\n"
    + "    if (r === null) continue"
  const oHits = ownerText.split(addFrom).length - 1
  const cHits = cText.split(fixEol(cText, regressFrom)).length - 1

  if (oHits !== 1 || cHits !== 1) {
    console.log(`  ✖ M3：锚点命中不对（owner=${oHits}、consumer=${cHits}，都应为 1）`)
    results.push(false)
  } else {
    let res
    try {
      writeFileSync(OWNER, ownerText.replace(addFrom, addTo))
      writeFileSync(CONSUMER, cText.replace(fixEol(cText, regressFrom), fixEol(cText, regressTo)))
      res = askConsumers()
    } finally {
      writeFileSync(OWNER, bufOwner)
      writeFileSync(CONSUMER, bufConsumer)
    }
    const restored = sha(readFileSync(OWNER)) === sha(bufOwner)
      && sha(readFileSync(CONSUMER)) === sha(bufConsumer)
    const allAccept = res.errors.length === 0 && res.tally === 2 && res.evidence === 2 && res.rows === 2
    // ★ 期望：**不是**三个都收下——那个手抄回去的消费者会**抛**。
    const ok = allAccept === false && restored
    console.log(`  ${ok ? '✔' : '✖'} M3 假变异：把一个消费者改回手抄 ⇒ M1 必须**不再**通过`)
    console.log(`      tallyLedger.total=${res.tally}  ledgerEvidenceRows=${res.evidence}  ledgerRows=${res.rows}`)
    if (res.errors.length > 0) for (const e of res.errors) console.log(`        ⇒ ${e}`)
    console.log(`      期望"三个都收下"=false ；实际=${allAccept} ；还原=${restored}`)
    if (ok) console.log('      ⇒ M1 有分辨力：它能咬住"某个消费者把手抄的词表放回去"')
    results.push(ok)
  }
}

const kept = results
const good = kept.filter(Boolean).length
console.log(`\n  汇总：${good}/${kept.length} 通过`)
process.exit(good === kept.length ? 0 : 1)