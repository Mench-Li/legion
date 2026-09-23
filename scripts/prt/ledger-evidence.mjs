// scripts/prt/ledger-evidence.mjs
// ============================================================================
// 台账里**每一条 ✅ 的"可复跑证据"必须解得开**。
//
// ---------------------------------------------------------------------------
// ## 它补的是哪一格（这一格最靠近"目标完成了没有"）
//
// 台账 145 行是本仓对"任务完没完成"的**唯一权威**，而成功的判据是
// 目标文档 + 本表的 140 个 ✅。到第 34 轮为止，本仓为**非 ✅** 的那 5 行立过判据
// （`intervention-coverage`：非 ✅ 的行必须被 §5 点名），也为 §5 的裁决表立过判据
// （`alpha-chain-trace`：断点必须有归属）。
//
// **而那 140 个 ✅ 的证据栏，从来没有被任何东西核对过。**
// 它自己的口径写着（`PRT-PROGRESS.md` 文件头）：
//
//     ✅ 已完成：有代码/文档交付物 + **可复跑的用例或实测证据**
//
// ⇒ "可复跑"是 ✅ 的定义的一部分。而一篇点名了一个**不存在**的套件的证据，
//   与一篇点名了一个真套件的证据，在这张表里长得**一模一样**——
//   两者都是"✅ + 一句读起来很有道理的话"。
//
//   > 一份"写着有证据"的台账，与一份"证据真的找得到"的台账，
//   > 在只看状态那一列的时候是同一个东西。
//
// ---------------------------------------------------------------------------
// ## 三条规则，以及**为什么只有三条**
//
// 判据要能红，就不能猜。本仓已经为"猜语义"付过六次假发现的代价
// （worktree 副本撑出 38 个同名、两次拼写变体"零命中"、23 处坏引用、
//  §5 用中文名指 `retention.mjs`、以及"第 20 条"被读成"20 条"）。
// 所以只收**形状无歧义**的点名：
//
//   R1  套件 `X`        —— `X` 必须是一行 **CI 套件行的名字**
//                          （别名在磁盘上没有同名文件，这是它唯一能落地的解释）
//   R2  `a/b/x.test.mjs` —— 含 `/` 的路径必须**原样**是被跟踪的文件
//   R3  `x.test.mjs`    —— 裸文件名必须在全仓**恰好一个**同名文件
//                          （这正是"简写合法"的条件；有 3 个同名时读者找不开）
//
// ★ 不做的事（写在这里是为了让下一个人不必重新论证）：
//   · **不**解析"裸名沿本格目录继承"——台账的证据栏不是表格的落点列，
//     它是一段散文，没有"本格目录"这个位置概念。硬套会造出静默的错解。
//   · **不**把"没有点名任何套件"判红——口径允许"实测证据"（一份文档、
//     一份基线 JSON）。那一批只作为一个**读数**报出来。
//   · **不**去散文里找文件名。点名必须是**反引号里**的那一个 token。
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { REPO } from './reachability.mjs'
import { suiteFilesFromCi, trackedTests } from './suite-counts.mjs'
// ★ 台账状态词表与"任务行长什么样"的**唯一所有者**是 `progress-check.mjs`
//   （它是台账格式的所有者）。本模块**不再**自己写一份 `^(✅|🟡|⏸|⬜)$`——
//   第 44～45 轮实测：手抄的那一份在 🟡 出现时**静默丢行**
//   （`scripts/probes/_probe-status-poison.mjs`：毒药行数 4 → 3，一声不响）。
import { ledgerTaskRow } from './progress-check.mjs'

export const LEDGER_PATH = join(REPO, 'docs', 'superpowers', 'prt', 'PRT-PROGRESS.md')
export const CI_PATH = join(REPO, 'scripts', 'ci', 'run-ci.mjs')

/** 一个"像名字"的后引号 token：字母开头，只含 `[\w./-]`（所以 `tests 21 / pass 20` 不算）。 */
export const NAME_RE = /^[A-Za-z][\w./-]*$/

/**
 * 台账里所有 PRT 行。
 *
 * ★ 与 `intervention-coverage.mjs` 的 `ledgerRows()` 同形——但那个只取
 *   `prt/status/line/desc`，这一格要的是**证据栏**。两处都从同一个文件读、
 *   用同一条"第一格以 `PRT-` 开头"的判据，所以形状不会漂。
 *
 * ★★ 第 45 轮：取法收敛到 `progress-check.ledgerTaskRow()`（状态词表的唯一所有者）。
 *   认不出的状态格现在**抛**，不再 `continue`——理由见 `progress-check.mjs` 里那段。
 */
export function ledgerEvidenceRows(path = LEDGER_PATH) {
  const rows = []
  const lines = readFileSync(path, 'utf8').split('\n')
  for (const [i, line] of lines.entries()) {
    const r = ledgerTaskRow(line)
    if (r === null) continue
    rows.push({ prt: r.prt, status: r.status, line: i + 1, desc: r.cells[0], evidence: r.cells[2] })
  }
  return rows
}

/**
 * 从一条证据栏里抽出**形状无歧义**的点名。
 *
 * @returns {{suites: string[], paths: string[], bare: string[], proseSpans: string[]}}
 */
export function extractMentions(evidence) {
  const suites = []
  const paths = []
  const bare = []
  const proseSpans = []
  const text = String(evidence)

  for (const m of text.matchAll(/套件\s*`([^`]*)`/g)) {
    const v = m[1].trim()
    if (NAME_RE.test(v) && !v.endsWith('.test.mjs')) suites.push(v)
    else proseSpans.push(v)
  }
  // 后引号里的 `*.test.mjs`
  for (const m of text.matchAll(/`([A-Za-z0-9][\w./-]*\.test\.mjs)`/g)) {
    const v = m[1]
    if (v.includes('/')) paths.push(v)
    else bare.push(v)
  }
  return {
    suites: [...new Set(suites)],
    paths: [...new Set(paths)],
    bare: [...new Set(bare)],
    proseSpans: [...new Set(proseSpans)],
  }
}

/**
 * 核对每一条 ✅ 的可复跑证据是否解得开。
 *
 * @param {{rows: Array, suiteFiles: Map, tracked: string[]}} input
 */
export function checkEvidence({ rows, suiteFiles, tracked }) {
  const violations = []
  const trackedSet = new Set(tracked)
  const byBase = new Map()
  for (const f of tracked) {
    const b = f.split('/').pop()
    if (!byBase.has(b)) byBase.set(b, [])
    byBase.get(b).push(f)
  }

  let suiteMentions = 0
  let pathMentions = 0
  let bareMentions = 0
  const noPointer = []
  const proseOnly = []

  for (const r of rows) {
    if (r.status !== '✅') continue
    const { suites, paths, bare, proseSpans } = extractMentions(r.evidence)
    suiteMentions += suites.length
    pathMentions += paths.length
    bareMentions += bare.length

    // R1：套件别名必须是一行 CI 套件
    for (const s of suites) {
      if (!suiteFiles.has(s)) {
        violations.push({
          id: 'suite-not-a-ci-row',
          prt: r.prt,
          line: r.line,
          message: `${r.prt}（L${r.line}）的证据点名了套件 \`${s}\`，而 \`scripts/ci/run-ci.mjs\` 里`
            + '没有任何一行的套件名是它 ⇒ 这份证据**不可复跑**（读者找不到跑哪一个）。',
        })
      }
    }
    // R2：带目录的路径必须原样存在
    for (const p of paths) {
      if (!trackedSet.has(p)) {
        violations.push({
          id: 'test-path-missing',
          prt: r.prt,
          line: r.line,
          message: `${r.prt}（L${r.line}）的证据点名了 \`${p}\`，而它不是一个被跟踪的文件。`,
        })
      }
    }
    // R3：裸文件名必须在全仓恰好一个
    for (const b of bare) {
      const hits = byBase.get(b) ?? []
      if (hits.length === 0) {
        violations.push({
          id: 'bare-test-missing',
          prt: r.prt,
          line: r.line,
          message: `${r.prt}（L${r.line}）的证据点名了 \`${b}\`，而全仓没有这个文件。`,
        })
      } else if (hits.length > 1) {
        violations.push({
          id: 'bare-test-ambiguous',
          prt: r.prt,
          line: r.line,
          message: `${r.prt}（L${r.line}）的证据点名了 \`${b}\`，而全仓有 **${hits.length}** 个同名文件`
            + `（${hits.join('、')}）⇒ 读者找不开，写全路径即可。`,
        })
      }
    }

    const hasPointer = suites.length > 0 || paths.length > 0 || bare.length > 0
      || /`[^`]*\.(?:md|json|mjs|ts|sql|ya?ml)`/.test(r.evidence)
    if (!hasPointer) noPointer.push(r.prt)
    if (!hasPointer && proseSpans.length > 0) proseOnly.push(r.prt)
  }

  return {
    ok: violations.length === 0,
    violations,
    reading: { suiteMentions, pathMentions, bareMentions, noPointer, proseOnly },
  }
}

/** 从磁盘按真实仓库核对。 */
export function checkRepo({ ledgerPath = LEDGER_PATH, ciPath = CI_PATH, tracked = null } = {}) {
  return checkEvidence({
    rows: ledgerEvidenceRows(ledgerPath),
    suiteFiles: suiteFilesFromCi(readFileSync(ciPath, 'utf8')),
    tracked: tracked ?? trackedTests(),
  })
}

// ── CLI：`node scripts/prt/ledger-evidence.mjs`（只读）───────────────────────
const isMain = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url).replace(/\\/g, '/') === process.argv[1].replace(/\\/g, '/')

if (isMain) {
  const res = checkRepo()
  const { suiteMentions, pathMentions, bareMentions, noPointer } = res.reading
  const okRows = ledgerEvidenceRows().filter((r) => r.status === '✅').length
  console.log(`台账 ✅ 行 ${okRows} 条`)
  console.log(`点名的可复跑证据：套件 ${suiteMentions} 处、带目录的用例 ${pathMentions} 处、裸名 ${bareMentions} 处`)
  console.log(`没有点名任何套件/用例的 ✅ 行：${noPointer.length} 条（口径允许"实测证据"，只作读数）`)
  if (res.violations.length === 0) {
    console.log('\n✅ 每一条 ✅ 的可复跑证据都解得开')
    process.exit(0)
  }
  console.log(`\n✖ ${res.violations.length} 处解得开：`)
  for (const v of res.violations) console.log(`  [${v.id}] ${v.message}`)
  process.exit(1)
}
