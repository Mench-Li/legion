// scripts/prt/intervention-coverage.mjs
// ============================================================================
// 「没有任何人在等它」的检出器：台账里每一条**非 ✅** 的行，都必须被 §5 点到名。
//
// ## 它补的是哪一格
//
// 台账（`docs/superpowers/prt/PRT-PROGRESS.md`）是"任务有没有完成"的权威。
// §5（`docs/MULTI-AGENT-FEATURE-STATUS.md`）是"哪些要人回答"的权威。
// 两者是**两份不同的清单**，而没有任何东西要求它们交叉核对。
//
// 后果就是这种行可以长期存在：一条既**不是 ✅**、又**不在 §5 上**的台账行。
// 它的处境是"**没有任何人在等它**"——
// 读台账的人以为 §5 在管，读 §5 的人以为台账已闭环。
//
//   > 一份"谁也没在看"的待办，与一份"已经做完"的待办，
//   > 在只看其中一份清单时是同一个东西。
//
// ## 本仓实测过两次（都是同一个形状）
//
//   · 2026-09-18 第一次：`runtime-contract-server-row.mjs` 那一族被标着
//     `in-flight`（正确动作那一格写的是一个字「等」），而真实内容是
//     "接不上、要人裁决"，且**不在** §5 上。⇒ 立为 §5 第 20 条。
//   · 2026-09-18 第二次：`PRT-256` 与 `PRT-910` 两条 ⏸ 的"缺口"那一列逐字写着
//     `需真实外部用户` / `需真实用户项目`，而它们**不在** §5 上。
//     ⇒ 立为 §5 第 21 条。
//
// 立完这两条之后，本模块把这条交叉核对**变成判据**：下一个孤儿会红，
// 而不是再等三天被人偶然读到。
//
// ## 判据为什么取"PRT 编号被点名"
//
// 不取"描述文字出现在散文里"——那要靠读懂散文，而且会随措辞变化而假绿/假红。
// §5 的每一格都写编号（`PRT-903`、`PRT-707`…），这是它能被机器核的最小单位。
//
//   > 一个靠"名字有没有出现在散文里"判定的覆盖度，
//   > 与一个靠"我读没读懂那段散文"判定的覆盖度，是同一个东西——
//   > 只不过前者会输出一个数字。
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { REPO, MATRIX_PATH, sectionFiveText } from './reachability.mjs'

/**
 * §5 的正文（转手 `reachability.mjs` 的解析器）。
 *
 * ★ 这里**故意**是转手而不是重写：§5 正文的区间规则只该有一份。
 *   两处各写一遍，然后慢慢漂移到"一个说从 `## 5.` 起、另一个说从 `## 5 ` 起"，
 *   是本仓见过的失效形状。
 */
export function sectionFive(path = MATRIX_PATH) {
  return sectionFiveText(path)
}

export const LEDGER_PATH = join(REPO, 'docs', 'superpowers', 'prt', 'PRT-PROGRESS.md')

/** 台账里的状态标记。非 ✅ 的都要有人认领。 */
export const NON_DONE_STATUSES = Object.freeze(['🟡', '⏸', '⬜'])

/**
 * 台账里所有 **PRT 行**（`| PRT-XXX … | 状态 | 证据 |`）。
 *
 * ★ 只认"第一格以 `PRT-` 开头"的行。台账里还有别的表格（比如新增用例清单），
 *   按形状取会把它们一起吃进来，于是"非 ✅ 的行"会混进一堆不是任务的东西。
 *
 * @returns {Array<{prt: string, status: string, line: number, desc: string}>}
 */
export function ledgerRows(path = LEDGER_PATH) {
  const rows = []
  const lines = readFileSync(path, 'utf8').split('\n')
  for (const [i, line] of lines.entries()) {
    const t = line.trim()
    if (!t.startsWith('|')) continue
    const cells = t.split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length < 3) continue
    const m = /^(PRT-\d+)/.exec(cells[0])
    if (!m) continue
    if (!/^(✅|🟡|⏸|⬜)$/.test(cells[1])) continue
    rows.push({ prt: m[1], status: cells[1], line: i + 1, desc: cells[0].slice(0, 80) })
  }
  return rows
}

/** 台账里**不是 ✅** 的那些行——它们要么等人回答，要么在等人用。 */
export function ledgerNotDone(path = LEDGER_PATH) {
  return ledgerRows(path).filter((r) => NON_DONE_STATUSES.includes(r.status))
}

/**
 * 找出**没有任何人在等**的台账行：既不是 ✅，又没被 §5 点到名。
 *
 * @param {Array<{prt: string, status: string, line: number}>} notDone
 * @param {string} section §5 那一段的正文
 * @returns {Array} 未被点名的行
 */
export function uncoveredLedgerRows(notDone, section) {
  return notDone.filter((r) => !section.includes(r.prt))
}

// ── 第二格：§5 的裁决项条数 ↔ 决策简报里写的那个数 ──────────────────────────
//
// ★ 第 32 轮加。起因是这一族自己：`docs/DECISION-BRIEF.md` 是一页纸，
//   开头写着「§5 里那 **29 条**裁决项」。§5 哪天多出一条（第 30 轮就多过一条：
//   第 29 条），这一页纸**不会红**——它会继续对读者说"29 条"，而读者信它，
//   因为它是**专门为这件事写的那一页**。
//
//   > 一份"专门给人做决定用"的摘要，一旦与它的来源脱钩，
//   > 比来源本身更难发现——因为读者是**因为不想读来源**才去读它的。
//
// ## 为什么按**表头**定位，不按行号或"§5 里第几张表"
//
// 行号会漂（本仓的记录里同一处先后是 485-509 → 508-536 → 540/545）。
// §5 里还有别的编号表（开头那张 1～5 的优先级表、后面 13/14/15/18 的缺口表），
// 按"编号行"取会把它们一起吃进来。表头是那张表**唯一**稳的锚点。

export const DECISION_BRIEF_PATH = join(REPO, 'docs', 'DECISION-BRIEF.md')

/** §5 里"裁决项"那张表的表头（前三个表头格）。 */
export const DECISION_TABLE_HEADER = '| # | 事项 | 需要谁 |'

/**
 * §5 那张裁决表的编号序列。
 *
 * @returns {{found: boolean, numbers: number[]}}
 */
export function decisionItemNumbers(section) {
  const lines = String(section).split(/\r?\n/)
  let start = -1
  for (const [i, l] of lines.entries()) {
    if (l.trim().startsWith(DECISION_TABLE_HEADER)) { start = i; break }
  }
  if (start === -1) return { found: false, numbers: [] }
  const numbers = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const t = lines[i].trim()
    if (t === '' || !t.startsWith('|')) break
    const m = /^\|\s*(\d+)\s*\|/.exec(t)
    if (m !== null) numbers.push(Number(m[1]))
  }
  return { found: true, numbers }
}

/** 简报里声明的条数（`**29 条**裁决项` 这类写法）。返回全部说法，供"互相矛盾"检查。 */
export function briefStatedCounts(briefText) {
  const out = []
  for (const m of String(briefText).matchAll(/(\d+)\s*条\*{0,2}\s*裁决项/g)) out.push(Number(m[1]))
  return out
}

/**
 * 核对：简报声明的条数 = §5 裁决表的条数，且编号连续无缺号。
 *
 * ★ 扫到 0 种说法 ⇒ 失败（"没声明"与"声明对了"在只看结论时是同一个东西）。
 */
export function checkBriefCount({ section, briefText }) {
  const violations = []
  const { found, numbers } = decisionItemNumbers(section)
  if (!found) {
    violations.push({
      id: 'decision-table-missing',
      message: `§5 里找不到裁决表（表头应为 \`${DECISION_TABLE_HEADER}\`）⇒ 这条判据**什么都没查**。`,
    })
    return { ok: false, count: 0, stated: [], violations }
  }
  const gaps = []
  for (let i = 1; i <= numbers.length; i += 1) if (numbers[i - 1] !== i) gaps.push(i)
  if (gaps.length !== 0) {
    violations.push({
      id: 'decision-numbers-not-contiguous',
      message: `§5 裁决表的编号不连续（第 ${gaps.join('、')} 位对不上）—— `
        + '一份"编号连续"的清单被插入/删除过而没重排，读者按号找会找不到。',
    })
  }

  const stated = briefStatedCounts(briefText)
  if (stated.length === 0) {
    violations.push({
      id: 'brief-states-no-count',
      message: '`docs/DECISION-BRIEF.md` **一处都没写**"N 条裁决项" ⇒ 这条判据什么都没查。',
    })
    return { ok: violations.length === 0, count: numbers.length, stated, violations }
  }
  for (const n of stated) {
    if (n !== numbers.length) {
      violations.push({
        id: 'brief-count-stale',
        message: `决策简报写着「${n} 条裁决项」，而 §5 那张表有 **${numbers.length}** 条 ⇒ `
          + '一份专门给人做决定用的摘要已经与它的来源脱钩了。',
      })
    }
  }
  return { ok: violations.length === 0, count: numbers.length, stated, violations }
}

/** 从磁盘按真实仓库核对。 */
export function checkBrief({ briefPath = DECISION_BRIEF_PATH, matrixPath = MATRIX_PATH } = {}) {
  return checkBriefCount({
    section: sectionFive(matrixPath),
    briefText: readFileSync(briefPath, 'utf8'),
  })
}


