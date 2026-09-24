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
//
// ## ⚠️ 本模块**没有 CLI**
//
// 它是一份库，判据跑在 `intervention-coverage.test.mjs` 里（`run-ci` 按那个文件注册）。
// 所以 `node scripts/prt/intervention-coverage.mjs` **什么都不做、并且 exit 0**。
//
//   > 一个"没有入口、跑起来静默退出 0"的脚本，
//   > 与一道"查过了、全过"的门禁，在 CI 日志里是同一个东西——
//   > 只不过前者从来没查过任何东西。
//
// ★ 2026-09-20 记：本仓常跑的那十道门禁里**只有这一个**没有 CLI（其余九个都有）。
//   这条读数是在它被人列进门禁清单、连着跑了很多轮之后才被发现的。
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { REPO, MATRIX_PATH, sectionFiveText, decisionStateIndex } from './reachability.mjs'
// ★ 台账状态词表与"任务行长什么样"的**唯一所有者**是 `progress-check.mjs`。
//   本模块此前把同一条状态正则写了**三**遍（`ledgerRows`、`ledgerRowTexts`，
//   外加 `NON_DONE_STATUSES` 那张子集表），而它自己的文件头就在警告这件事。
//
// ★★★ 第 45 轮：三处**全部**改成取它。⚠️ 中途我犯过一次——
//   改完前两处，上面这段注释**已经**把第三处（`NON_DONE_STATUSES`）写成
//   "已收敛"，而那一行**还是** `Object.freeze(['🟡', '⏸', '⬜'])` 的手写表。
//
//     > 一段写着"这个词表只有一处"的注释，与一段**真的**只有一处的代码，
//     > 在读者眼里是同一件事——
//     > 只不过前者在下一次加状态时**不会**跟着变。
//
//   这张表漏一个标记的后果是**具体的**：`ledgerNotDone()` 会少收一条，
//   于是那条非 ✅ 的任务**不会出现在人工介入清单里**——
//   而"清单里没有它"与"它已经完成了"读数同形。
import { DONE_STATUS_MARK, LEDGER_STATUS_MARKS, ledgerTaskRow, nonDoneStatuses } from './progress-check.mjs'

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

/**
 * 台账里"还没完"的状态标记 —— **由词表派生**，不手写一份。
 *
 * ★★★ 第 45 轮：这里原来是 `Object.freeze(['🟡', '⏸', '⬜'])`。
 *   它就是 `progress-check.mjs` 那段注释里列的"四处各写一遍"中的一处，
 *   而我改完另外两处时**漏了它**（注释却已经宣称改完了）。
 *
 * ★ 用 `nonDoneStatuses()` 而不是在这里 `filter`：派生规则（"去掉完成的那一个"）
 *   也只该有一份，而且它**可注入**——用例能拿一张多一个标记的词表去试。
 */
export const NON_DONE_STATUSES = nonDoneStatuses()

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
    const r = ledgerTaskRow(line)
    if (r === null) continue
    rows.push({ prt: r.prt, status: r.status, line: i + 1, desc: r.cells[0].slice(0, 80) })
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

// ── 第三格：§4 第 15 条（Windows 平台边界）的名单 ↔ 台账里引用它的行 ─────────
//
// ★ 2026-09-20 加。起因与本模块上面那两次**同形**，但这次漏人的是**名单自己**：
//
//   `docs/STATUS.md` §4 第 15 条（"Windows 上不会有自动执行"）自带一份
//   "这条边界还对谁成立"的名单。那份名单**改过两次**（本节里就记着第一次），
//   而 2026-09-20 又发现它漏了 `PRT-253`——那一行的"缺口"栏逐字写着
//   「`docs/STATUS.md` §4 第 15 条……**与 PRT-009 是同一条**」。
//
//   漏掉的代价是**可量化**的：有人（就是我）照着那份名单读了一遍，得出
//   "`PRT-253` 不在这条边界名下"，于是去查它是不是被别的批次解开了——**白查一轮**。
//
//   > 一份"名单里没有它"的边界，与一份"它其实不受这条边界管"的边界，
//   > 对读的人是同一个东西——区别只在读完之后他去干了什么。

/** 状态文档（`docs/STATUS.md`）。 */
export const STATUS_PATH = join(REPO, 'docs', 'STATUS.md')

/** 这条边界在正文里的引用写法（台账行里逐字出现的那个串）。 */
export const BOUNDARY_CITE = '§4 第 15 条'

/** 那句"这条边界还对谁成立"的名单起头。 */
export const BOUNDARY_LIST_MARKER = '这条 15 只对'

/**
 * 台账每一行的**原文**。
 *
 * ★ 与 `ledgerRows()` 分开写：那个只留 `{prt, status, line, desc}`，
 *   而"这一行有没有引用某条边界"要查**整行**。取法（`split('|')` + 状态词表）
 *   与它逐字相同——两处各写一遍取法，正是本模块文件头警告的那种漂移。
 */
export function ledgerRowTexts(path = LEDGER_PATH) {
  const out = []
  const lines = readFileSync(path, 'utf8').split('\n')
  for (const [i, line] of lines.entries()) {
    const r = ledgerTaskRow(line)
    if (r === null) continue
    out.push({ prt: r.prt, status: r.status, line: i + 1, text: line })
  }
  return out
}

/**
 * 对账：**台账里引用了这条边界、且还没做完的行**，必须被 §4 第 15 条那句名单点到名。
 *
 * 口径两侧都取"能被机器核的最小单位"：
 *   · 左侧 = 台账行的**原文里出现** `§4 第 15 条` 且状态非 ✅；
 *   · 右侧 = 那句名单（`BOUNDARY_LIST_MARKER` 起到第一个句号）里出现的 `PRT-\d+`。
 *
 * ★ 两个方向都堵：锚点找不到 ⇒ 失败（"没查到"与"查过了"不许同形）；
 *   左侧为空集 ⇒ 失败（判据在空集上通过时，它与没写这条判据长得一样）。
 */
export function boundaryCoverageGaps({ ledgerPath = LEDGER_PATH, statusPath = STATUS_PATH } = {}) {
  const violations = []
  const rows = ledgerRowTexts(ledgerPath).filter(
    (r) => NON_DONE_STATUSES.includes(r.status) && r.text.includes(BOUNDARY_CITE),
  )
  const status = readFileSync(statusPath, 'utf8')
  const at = status.indexOf(BOUNDARY_LIST_MARKER)
  if (at < 0) {
    violations.push({
      id: 'boundary-list-missing',
      message: `找不到那句名单（锚点 \`${BOUNDARY_LIST_MARKER}\`）⇒ 这条判据**什么都没查**。`
        + '名单被改写/移动时，"查不到"必须红，而不是安静地放行。',
    })
    return { ok: false, cited: rows.map((r) => r.prt), named: [], violations }
  }
  const dot = status.indexOf('。', at)
  const sentence = status.slice(at, dot < 0 ? Math.min(at + 400, status.length) : dot + 1)
  const named = new Set([...sentence.matchAll(/PRT-\d+/g)].map((m) => m[0]))
  if (rows.length === 0) {
    violations.push({
      id: 'boundary-nobody-cites',
      message: '台账里**一条**非 ✅ 的行都没引用这条边界 ⇒ 判据在空集上通过。'
        + '请确认这条边界是否已被解除——若已解除，本节名单与这条判据都该一起删掉。',
    })
  }
  for (const r of rows) {
    if (named.has(r.prt)) continue
    violations.push({
      id: 'boundary-item-unnamed',
      message: `${r.prt}（台账第 ${r.line} 行，状态 ${r.status}）在"缺口"栏里引用了 `
        + `\`${BOUNDARY_CITE}\`，而 §4 第 15 条那句名单（"${BOUNDARY_LIST_MARKER}…"）**没有**点到它 ⇒ `
        + '下一个人会以为这一条不受这条边界管，于是去查它为什么还卡着——白查一轮。',
    })
  }
  return { ok: violations.length === 0, cited: rows.map((r) => r.prt), named: [...named], violations }
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

/**
 * 简报里声明的条数（`**29 条**裁决项` 这类写法）。返回全部说法，供"互相矛盾"检查。
 *
 * ★★ 第 33 轮补的区分：**序数**不是**计数**。
 *
 * 简报里那句话自然的中文写法是「它正好就是**第 20 条裁决项**」——那是在**指第 20 条**，
 * 不是"有 20 条"。而第一版的正则 `/(\d+)\s*条\s*裁决项/` 把两者读成同一个东西，
 * 于是我在简报里**加了一句指路的话**，判据就报「简报写着 20 条、§5 有 29 条」。
 *
 *   > 一个分不清"第 20 条"与"20 条"的计数器，
 *   > 会在**引用**某一条的时候，报出一个**条数**上的错误。
 *
 * ⇒ 前面带「第」（允许中间有空白）的一律**不算计数**。
 *   注意 `\s*` 会吃掉换行，所以"第 20 条"与"裁决项"之间若隔着空行也会被连起来——
 *   这正是第一版误报能发生的条件之一。
 */
export function briefStatedCounts(briefText) {
  const out = []
  for (const m of String(briefText).matchAll(/(?:(第)\s*)?(\d+)\s*条\*{0,2}\s*裁决项/g)) {
    if (m[1] !== undefined) continue // 「第 N 条裁决项」是指路，不是计数
    out.push(Number(m[2]))
  }
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

/**
 * ★★★ 第 118 轮第四十一轮：**"要您裁决的那几条，得真的写在给您的清单上"**。
 *
 * 现场：`DECISION-BRIEF.md` 的**条数**一直有判据双向核（`checkBriefCount`），
 * 而**成员**一个判据都没有 —— 2026-09-24 量到：§5 里那 14 条「未标注」有 **3 条**
 * （`#11` / `#15` / `#22`）**根本没出现在简报的条号列里**。
 * ⇒ 一份"条数对得上、成员对不上"的清单，**读起来像完整的**：它算得出 15 条，
 * 却漏掉了三条真正要人说话的东西。★ 而漏掉的那三条里，有一条（`#15`）的正文
 * 自己就写着"已从本条移出、立为第 **28** 条" —— 也就是说它**被裁决追上了却没被盘点**。
 *
 * ★ 口径：简报里**表格行的首格**里出现的整数才算"被列上了"。
 *   （散文里提一句不算 —— 读者按条号找清单，找的是那一行。）
 *
 * @param {{section?: string, briefText?: string}} [input]
 * @returns {number[]} 没被列上的条号（升序）
 */
export function briefCoverageGaps({ section, briefText } = {}) {
  const index = decisionStateIndex(String(section ?? ''))
  const covered = briefItemNumbers(briefText)
  return index
    .filter((r) => r.state === '未标注' && !covered.has(r.no))
    .map((r) => r.no)
    .sort((a, b) => a - b)
}

/** 简报表格**首格**里出现的条号（读者"按号找那一行"找的就是它）。 */
export function briefItemNumbers(briefText) {
  const out = new Set()
  for (const line of String(briefText ?? '').split('\n')) {
    if (!/^\s*\|/.test(line)) continue
    const first = line.split('|')[1] ?? ''
    for (const m of first.matchAll(/\d{1,2}/g)) out.add(Number(m[0]))
  }
  return out
}

/** 从磁盘按真实仓库核对。 */
export function checkBrief({ briefPath = DECISION_BRIEF_PATH, matrixPath = MATRIX_PATH } = {}) {
  const section = sectionFive(matrixPath)
  const briefText = readFileSync(briefPath, 'utf8')
  const base = checkBriefCount({ section, briefText })
  const missing = briefCoverageGaps({ section, briefText })
  if (missing.length !== 0) {
    base.violations.push({
      id: 'brief-uncovered-items',
      message: `§5 里标「未标注」的这几条**没出现在决策简报的条号列**里：`
        + `${missing.map((n) => `#${n}`).join('、')} ⇒ `
        + '一份漏了成员、却算得对条数的清单，**读起来像完整的**。',
    })
  }
  return { ...base, ok: base.violations.length === 0, uncovered: missing }
}


