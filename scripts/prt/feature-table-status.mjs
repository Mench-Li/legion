// scripts/prt/feature-table-status.mjs
// ============================================================================
// 功能表的「状态」格 与 「还差什么」格**必须相容**。
//
// ---------------------------------------------------------------------------
// ★ 起因：同一张表的两个格子，各由一个"没有任何东西核对"的断言填
//
// 本会话已经撞到这一族的四种形态：
//   ① 一条**注释**说"已实现"（`usage-rollup.mjs` 的降级）；
//   ② 一条**判据**只查行号范围（`boundary-facts` 的坐标检查）；
//   ③ 一个**计数**"套件 N 例"过期（§5.9）；
//   ④ 一份**报告**的标题说"都是机器读数，可复跑"（§5.10）。
//
// 第 27 轮撞到第五种，它在**同一张表内部**：
//
//   F-22「后端与工作区」  状态 **🟡**（没做完）  还差什么 **`—`**（不差什么）
//   F-24「ACL 与安全姿态」状态 **🟡**（没做完）  还差什么 **`—`**（不差什么）
//
// 两个格子都是人填的，而**没有任何东西**检查它们是否相容。
//
//   > 一行 🟡 配一个 `—`，与一行 ✅ 在表里长得一模一样——
//   > 而读者只会看「状态」那一列。
//
// ---------------------------------------------------------------------------
// ★ 规则（刻意只有一条，且不需要猜）
//
//   状态格的**终点**既不是 ✅ 也不是 ⏸ ⇒ 「还差什么」格**不许为空**。
//
// 为什么 ✅ 与 ⏸ 豁免：
//   · ✅ =「做完了」，本来就不该差什么（表中 21 行如此，是**正确**的写法）；
//   · ⏸ =「有意不做」，它自己那格（F-23/F-25）就写着"这是设计决定，
//     不是缺口"，所以 `—` 是**对**的。
//   ⇒ 一条"任何状态下都不许 `—`"的规则会红在 **23 个正确的地方**，
//     然后被人整体关掉。这与 §5.9「全仓 N 例都不许过期」是同一种错。
//
// ★ 状态可能是 `🟡→✅` 这种**迁移**写法，所以要取**终点**：
//   `⬜→🟡` 的终点是 🟡（要差什么）、`🟡→✅` 的终点是 ✅（不要求）。
// ============================================================================
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// ★★★ 第 48 轮：功能表的**数据行识别**归 `progress-check.mjs` 所有（本仓第五份手写已删除）。
import { featureTableRow } from './progress-check.mjs'

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const STATUS_DOC = 'docs/MULTI-AGENT-FEATURE-STATUS.md'

/** 功能表里的行：`| F-01 | … |`（也含 `| F-05 前半 |`、`| F-19 缺口① |`）。 */
export const FEATURE_ROW_RE = /^\|\s*(F-\d+[^|]*?)\s*\|/

/** 空占位符：一个破折号（半角/全角）或空串，**去掉空白后**判。 */
export function isEmptyGap(text) {
  const t = String(text).replace(/\s/g, '')
  return t === '' || t === '—' || t === '-' || t === '–'
}

/** 取状态格的**终点**：`🟡→✅` ⇒ `✅`；`⬜→🟡` ⇒ `🟡`。 */
export function endState(status) {
  const parts = String(status).split('→')
  return (parts[parts.length - 1] ?? String(status)).trim()
}

const DONE = '✅'
const PAUSED = '⏸'

/**
 * 找一个文本里所有功能表的行，返回 `{rows, skipped}`。
 *
 * ★ `skipped` 要**报出来**：一个"扫到 0 行"的门禁与一个"全部相容"的门禁，
 *   在只有 `ok: true` 的输出里是同一个东西。
 *
 * ★★★ 第 48 轮：**"哪一行算功能行"交给所有者**（`progress-check.featureTableRow`）。
 *
 *   本函数此前自己判行、自己分格、**自己定宽度**（`≠5 且 ≠6 ⇒ 跳过`）——
 *   是同一张功能表在本仓的**第五份**手写解析。
 *
 *   ★ 而它是这五份里**唯一做对了一件事**的：它把跳过**报出来**
 *     （`skipped`，第 23 轮 F-15 那一课的成果）——
 *     所以它的缺陷不是"静默少读"，而是"把 4 格 / 7 格的功能行**归错类**"：
 *     报成"另一张表"，于是那一行的状态与「还差什么」都不再被这条规则管。
 *
 *     > 一份"跳过并报出来"的清单，比一份"静默跳过"好得多——
 *     > 但它仍然可能把**自己看不懂的东西**说成**别人的东西**。
 *
 *   ⇒ 现在：**所有者说是行，就是行**；所有者说不是，而它看起来像功能行
 *     （`FEATURE_ROW_RE`），才记进 `skipped` 并说明原因。
 */
export function parseFeatureRows(text) {
  const rows = []
  const skipped = []
  String(text).split(/\r?\n/).forEach((line, i) => {
    const row = featureTableRow(line)
    if (row !== null) {
      rows.push({
        line: i + 1,
        id: row.id,
        status: row.status,
        end: endState(row.status),
        gap: row.cells[row.cells.length - 1],
        cols: row.cells.length,
      })
      return
    }
    // ★ 所有者不收，但它看起来**像**一个功能行 ⇒ 这是"跳过了"，必须报出来。
    const m = FEATURE_ROW_RE.exec(line)
    if (m !== null) {
      const cells = line.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim())
      skipped.push({ line: i + 1, id: m[1], cols: cells.length })
    }
  })
  return { rows, skipped }
}

/**
 * 核对：状态终点不是 ✅ / ⏸ ⇒ 「还差什么」不许为空。
 *
 * 返回体里 `checked` / `exempt` / `skipped` **分开报**。
 *   · `checked`  = 必须写差什么的行数（被规则约束的）；
 *   · `exempt`   = ✅/⏸ 因而豁免的行数；
 *   · `skipped`  = 列数不是 5/6、没被这条规则管的行数。
 *
 * ★ 三者分开报，是因为**"豁免 23 行"与"23 行都合规"在只报条数的输出里
 *   长得一样**（第 23 轮 F-15 `confidence` 那一课）。
 */
export function checkFeatureTable({ text }) {
  const { rows, skipped } = parseFeatureRows(text)
  const violations = []
  let checked = 0
  let exempt = 0
  for (const r of rows) {
    if (r.end === DONE || r.end.startsWith(PAUSED)) { exempt += 1; continue }
    checked += 1
    if (isEmptyGap(r.gap)) {
      violations.push({
        line: r.line,
        id: r.id,
        status: r.status,
        end: r.end,
        message: `第 ${r.line} 行 ${r.id}：状态是「${r.status}」（没做完），`
          + '而「还差什么」格是空的。'
          + '两者都由人填、没有任何东西核对——'
          + '**没做完却说"不差什么"**，与"已做完"在表里长得一模一样。'
          + '修法：要么把缺的东西写进那一格，要么把状态改成 ✅/⏸。',
      })
    }
  }
  return {
    ok: violations.length === 0,
    checked, exempt, skipped,
    rows: rows.length,
    violations,
  }
}

/** 从磁盘上按真实仓库核对。 */
export function checkRepo({ cwd = REPO } = {}) {
  return checkFeatureTable({ text: readFileSync(resolve(cwd, STATUS_DOC), 'utf8') })
}

// ── CLI：`node scripts/prt/feature-table-status.mjs`（只读，不写盘）─────────
const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) {
  const r = checkRepo()
  console.log(`feature-table-status: 功能表 ${r.rows} 行 —— 受规则约束 ${r.checked} 行、`
    + `豁免 ${r.exempt} 行（✅/⏸）、跳过 ${r.skipped.length} 行（列数不是 5/6）`)
  for (const v of r.violations) console.log(`  ✖ ${v.message}`)
  if (r.ok) console.log('  ✅ 没有一行「没做完却说不差什么」')
  process.exit(r.ok ? 0 : 1)
}
