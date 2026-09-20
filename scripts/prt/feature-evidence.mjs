// scripts/prt/feature-evidence.mjs
// ============================================================================
// 目标文档的实现投影表（`docs/MULTI-AGENT-FEATURE-STATUS.md`）**点名的证据必须解得开**，
// 而且**非 ✅ 的行必须说清还差什么**。
//
// ---------------------------------------------------------------------------
// ## 它补的是哪一格（第 36 轮）
//
// 第 35 轮核的是**台账**（`PRT-PROGRESS.md`）里 140 条 ✅ 的可复跑证据。
// 而本仓对"目标文档实现了没有"还有**第二份**权威表——F-01～F-25 的实现投影。
// 它此前**没有任何判据核对**，于是两类形状都能长期存在：
//
//   ① **凭空点名**：引用一个台账里不存在的 PRT 编号、一个不是任何 CI 套件的"套件名"、
//      或一个全仓同名的裸用例文件名。读者按它去复核会**找不到**，
//      而这与"证据真的在那里"在这张表里长得一模一样。
//
//   ② ★★ **一个 🟡 行说"不差什么"**——本仓第 27 轮**真的**发生过：
//      F-22 与 F-24 的「还差什么」格此前是 `—`，而真正的缺口写在**「依据」格**里。
//
//      > 一个 🟡 行说「不差什么」，与「已做完」，在表里长得一模一样。
//
//      格子里有信息、而**放错了格子**，按「还差什么」那一列读表的机器与人就都读不到它。
//      —— 这正是本表自己 §5.11 写下来的那条自我更正。
//
// ## 规则（五条，全部形状无歧义）
//
//   R1  引用的 `PRT-nnn` 必须**在台账里存在**（两份文档不许对同一个编号有两种说法）
//   R2  引用的套件别名必须是**一行 CI 套件**（别名在磁盘上没有同名文件）
//   R3  裸 `x.test.mjs` 必须全仓**恰好一个**同名；带 `/` 的路径必须原样存在
//   R4 ★ **非 ✅ 的行**（🟡/⏸/⬜）的「还差什么」不许是空的或只有 `—`
//   R5  同一个 F 编号的**状态行**不许出现两次（两份声明会漂，且没人知道哪份算）
//
// ★ 不判的：✅ 行「还差什么」可以为 `—`（那就是"不差"），也可以有内容
//   （本表刻意用它记"刻意不做的事"，例如 F-05 前半的"明细不进 `/api/events`"）。
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

import { REPO } from './reachability.mjs'
import { suiteFilesFromCi } from './suite-counts.mjs'
import { ledgerEvidenceRows } from './ledger-evidence.mjs'
import { CI_PATH } from './stage-scope.mjs'
// ★★★ 第 45 轮：状态词表的**唯一所有者**是 `progress-check.mjs`（它同时拥有
//   台账那张表）。本模块原来自己抄了第二份，见下面 `STATUS_RE` 那一段。
import {
  FEATURE_STATUS_MARKS,
  FEATURE_STATUS_MUST_SAY_MISSING,
  FEATURE_STATUS_RE,
  // ★★★ 第 48 轮：**数据行**的识别权也在所有者那里（本模块不再自己判行/分格）。
  featureTableRow,
} from './progress-check.mjs'

export const FEATURE_DOC = join(REPO, 'docs', 'MULTI-AGENT-FEATURE-STATUS.md')

/** 状态列的**封闭词表**——用它把"真状态行"从同文档的其它表里分出来。 */
// ★★★ 第 45 轮：状态词表**不再抄在这里**。
//
// 本模块原来自己写了一份：
//
//     export const STATUS_RE = /^(?:✅|🟡|⏸|⬜|🟡→✅|⬜→🟡|✅→🟡)$/     // 7 种
//
// 而所有者（`progress-check.mjs` 的 `FEATURE_STATUS_RE`，由
// `FEATURE_STATUS_MARKS` 派生）许可 **20 种**（4 个终态 + 16 种箭头写法）。
// ⇒ **所有者许可而这份不认：13 种**。
//
// 而第 69 行原来是 `if (!STATUS_RE.test(...)) continue`
// ⇒ **所有者明确许可的形状在这里被静默丢掉**
//   （实测：往合成文档里喂 `🟡→⏸` ⇒ 收 **0** 行、**不报错**；喂 `✅` ⇒ 收 1 行）。
//
//   > 一份"词表归别人管"的声明，与一份**真的**跟着它走的实现，
//   > 在今天不会露出差别——只要今天那份文档里恰好只用双方都认的写法。
//   > （实测：真文档只用 5 种，全在交集中 ⇒ 差异当时**只存在于理论上**。）
//
// ★ 名字 `STATUS_RE` 保留（`feature-evidence.test.mjs` 与别处在 import 它），
//   但它现在**就是**所有者那张表本身，不是它的副本。
export const STATUS_RE = FEATURE_STATUS_RE

/** 只有这两种状态**要求**写出"还差什么"（⏸/⬜ 的理由可以正当写在别处）。 */
// ★★★ 第 45 轮：这也是词表的**一个子集**，同处一个模块（它原来也抄在这里）。
export const MUST_SAY_MISSING = FEATURE_STATUS_MUST_SAY_MISSING

/** 一个"像名字"的后引号 token（与 `ledger-evidence.mjs` 同形）。 */
export const NAME_RE = /^[A-Za-z][\w./-]*$/

/**
 * 抽出所有**状态行**（只认状态列落在封闭词表里的那些）。
 *
 * ★★★ 第 48 轮：**行识别交给所有者**（`progress-check.featureTableRow`）。
 *   本函数此前自己判行、自己分格、自己定格子数、自己抛 —— 而
 *   `spec-status-calibration` 与 `feature-landing-paths` **各自又抄了一份**。
 *   第 45 轮在这里补的"认不出就抛"是对的，但它只补了**这一个**消费者。
 *
 *   ⇒ 认出来之后，本函数只负责**它自己这一层的形状**
 *     （`line` 行号、`citers`、`missing`）——行是什么，由所有者说了算。
 */
export function featureRows(path = FEATURE_DOC) {
  const rows = []
  // ★ 换行兼容：CRLF 文件按 `\n` 切，行尾会留一个 `\r`——
  //   `featureTableRow` 内有 `trim()`，所以这里不必先处理。
  const lines = readFileSync(path, 'utf8').split('\n')
  for (const [i, line] of lines.entries()) {
    const row = featureTableRow(line)
    if (row === null) continue
    rows.push({
      ...row,
      line: i + 1,
      citers: row.citations,
      missing: row.cells[row.cells.length - 1] ?? '',
    })
  }
  return rows
}

/**
 * 核对一张 F 表。
 *
 * @param {{rows: Array, ledgerPrts: Set, suiteFiles: Map, tracked: string[]}} input
 */
export function checkFeatureEvidence({ rows, ledgerPrts, suiteFiles, tracked }) {
  const violations = []
  // ★★★ "什么都没查"不许报绿：一行都没读到 ⇒ 红。
  //   第一版把状态列写成了 `cells[1]`（那是**名称**），于是**读到 0 行**，
  //   而 CLI 兴高采烈地印出「✅ 每一条点名的证据都解得开」。**我自己的判据
  //   在我自己手里犯了一次它专门要抓的那个形状**——所以这里要有一条下限，
  //   与 `stage-scope` 的 `no-stages` / `suite-counts` 的 `files.length > 300` 同形。
  if (rows.length === 0) {
    violations.push({
      id: 'no-feature-rows',
      message: '一个 F 状态行都没读到 ⇒ 这条判据**什么都没查**（列序变了？状态词表变了？）。',
    })
    return { ok: false, violations, reading: { rows: 0, pointers: 0, statuses: {} } }
  }
  if (ledgerPrts.size === 0) {
    violations.push({ id: 'no-ledger', message: '台账一条都没读到 ⇒ R1 无从核对。' })
  }
  const trackedSet = new Set(tracked)
  const byBase = new Map()
  for (const f of tracked) {
    if (!f.endsWith('.test.mjs')) continue
    const b = f.split('/').pop()
    if (!byBase.has(b)) byBase.set(b, [])
    byBase.get(b).push(f)
  }

  let ptrs = 0
  const seenLabels = new Map()
  for (const r of rows) {
    const body = r.citers.join(' | ')
    // R5：同一**整格标签**的状态行不许出现两次。
    //
    // ★★ 第一版把标签**削成编号**（`F-05 前半` → `F-05`）再比，于是
    //    `F-05 前半` / `F-05 后半`（两半各一行）与 `F-18 缺口①/②/③`
    //    （每个缺口各一行）全部被报成"重复"——**4 处全是假阳性**。
    //
    //    > 一个把限定词削掉再去重的编号，
    //    > 会把「同一件事的两半」与「同一件事写了两遍」看成同一个东西。
    //
    //    限定词（`前半` / `缺口①`）正是**区分**它们的东西，去掉它，两份不同的
    //    声明与一份声明重复了两次，在比对里完全同形。
    if (seenLabels.has(r.label)) {
      violations.push({
        id: 'feature-label-duplicated',
        line: r.line,
        message: `\`${r.label}\` 的状态行出现了两次（L${seenLabels.get(r.label)} 与 L${r.line}）⇒ `
          + '表里有两份**同名**声明，读的人不知道哪份算。',
      })
    } else {
      seenLabels.set(r.label, r.line)
    }

    // R4：非 ✅ 的行必须说清还差什么
    if (MUST_SAY_MISSING.includes(r.status) && /^[—–-]*$/.test(r.missing.trim())) {
      violations.push({
        id: 'partial-row-says-nothing-missing',
        line: r.line,
        message: `${r.id}（L${r.line}）状态是 **${r.status}**，而「还差什么」是空/破折号 ⇒ `
          + '它与 ✅ 在表里长得一模一样。★ 本仓第 27 轮真发生过（F-22/F-24 的缺口'
          + '写在了「依据」格里）——**格子里有信息、而放错了格子，按这一列读表的人读不到它**。',
      })
    }

    // R1：PRT 编号必须在台账里存在
    for (const m of body.matchAll(/\bPRT-(\d+)/g)) {
      ptrs += 1
      const prt = 'PRT-' + m[1]
      if (!ledgerPrts.has(prt)) {
        violations.push({
          id: 'feature-cites-unknown-prt',
          line: r.line,
          message: `${r.id}（L${r.line}）点名了 \`${prt}\`，而台账里没有这一条 ⇒ `
            + '两份文档对同一个编号有两种说法，读者按它去查会查不到。',
        })
      }
    }
    // R2：套件别名必须是一行 CI 套件
    for (const m of body.matchAll(/套件\s*`([^`]+)`/g)) {
      const v = m[1].trim()
      if (!NAME_RE.test(v) || v.endsWith('.test.mjs')) continue
      ptrs += 1
      if (!suiteFiles.has(v)) {
        violations.push({
          id: 'feature-cites-unknown-suite',
          line: r.line,
          message: `${r.id}（L${r.line}）点名了套件 \`${v}\`，而 \`run-ci.mjs\` 里没有这一行。`,
        })
      }
    }
    // R3：用例文件
    for (const m of body.matchAll(/`([A-Za-z0-9][\w./-]*\.test\.mjs)`/g)) {
      const v = m[1]
      ptrs += 1
      if (v.includes('/')) {
        if (!trackedSet.has(v)) {
          violations.push({
            id: 'feature-cites-missing-test-path',
            line: r.line,
            message: `${r.id}（L${r.line}）点名了 \`${v}\`，而它不是一个被跟踪的文件。`,
          })
        }
      } else {
        const hits = byBase.get(v) ?? []
        if (hits.length === 0) {
          violations.push({
            id: 'feature-cites-missing-test',
            line: r.line,
            message: `${r.id}（L${r.line}）点名了 \`${v}\`，而全仓没有这个文件。`,
          })
        } else if (hits.length > 1) {
          violations.push({
            id: 'feature-cites-ambiguous-test',
            line: r.line,
            message: `${r.id}（L${r.line}）点名了裸名 \`${v}\`，而全仓有 **${hits.length}** 个同名`
              + `（${hits.join('、')}）⇒ 读者找不开，写全路径即可。`,
          })
        }
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    reading: {
      rows: rows.length,
      pointers: ptrs,
      statuses: rows.reduce((a, r) => { a[r.status] = (a[r.status] ?? 0) + 1; return a }, {}),
    },
  }
}

/** 从磁盘按真实仓库核对。 */
export function checkRepo({ docPath = FEATURE_DOC, ciPath = CI_PATH, tracked = null } = {}) {
  const list = tracked ?? execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' })
    .split('\0').filter(Boolean).map((f) => f.replace(/\\/g, '/'))
  return checkFeatureEvidence({
    rows: featureRows(docPath),
    ledgerPrts: new Set(ledgerEvidenceRows().map((r) => r.prt)),
    suiteFiles: suiteFilesFromCi(readFileSync(ciPath, 'utf8')),
    tracked: list,
  })
}

// ── CLI：`node scripts/prt/feature-evidence.mjs`（只读）─────────────────────
const isMain = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url).replace(/\\/g, '/') === process.argv[1].replace(/\\/g, '/')

if (isMain) {
  const r = checkRepo()
  console.log(`F 表状态行 ${r.reading.rows} 条：${JSON.stringify(r.reading.statuses)}`)
  console.log(`点名的证据指针 ${r.reading.pointers} 处`)
  if (r.ok) {
    console.log('\n✅ 每一条点名的证据都解得开，且每个 🟡 行都说清了还差什么')
    process.exit(0)
  }
  console.log(`\n✖ ${r.violations.length} 处：`)
  for (const v of r.violations) console.log(`  [${v.id}] ${v.message}`)
  process.exit(1)
}
