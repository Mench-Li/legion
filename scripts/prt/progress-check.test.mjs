// scripts/prt/progress-check.test.mjs
// ============================================================================
// PRT 进度表自检器的测试。
//
// 这个脚本本身值得测，理由与它存在的理由相同：它**改写一份文档**。
// 一个会改文件的工具如果解析错了一行，后果不是"报错了"，而是"把内容吃掉了"。
// 因此这里的用例分两类：
//   ① 判定类：每种不一致都必须被报出来（否则自检是装饰）；
//   ② 保守类：--fix 的输出与输入之差**只能**是数字
//      （出现别的差异就说明解析器把内容吃掉了一行）。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  LEDGER_STATUS_MARKS,
  STATUS_CELL_RE,
  STATUS_MARKS,
  checkProgress,
  fixProgress,
  ledgerTaskRow,
  parseProgress,
  parseSummary,
  tally,
} from './progress-check.mjs'

/** 造一份最小但结构完整的进度表。 */
function doc({ headingDone = null, summaryCounts = null, grand = null, statuses = [['✅', '🟡']] } = {}) {
  /** 按状态标记算出四列计数——这是"明细"，一切派生数字都从它来。 */
  const derive = (marks) => STATUS_MARKS.map((s) => marks.filter((m) => m === s.mark).length)
  const lines = []

  statuses.forEach((marks, i) => {
    // 阶段 0 的标题可以被显式写错（那是用例要验的不一致）；
    // 其余阶段一律按明细算——夹具自己不能是不一致的，否则测不出东西。
    const done = i === 0 && headingDone !== null ? headingDone : derive(marks)[0]
    lines.push(`## 阶段 ${i}：阶段${i}（${done}/${marks.length}）`)
    lines.push('')
    lines.push('| 任务 | 状态 | 说明 |')
    lines.push('| --- | --- | --- |')
    marks.forEach((m, j) => lines.push(`| PRT-${i}0${j} 任务${j} | ${m} | 证据 |`))
    lines.push('')
  })

  const rows = statuses.map((marks, i) => (i === 0 && summaryCounts !== null ? summaryCounts : derive(marks)))
  const grandCounts = grand ?? rows.reduce((a, r) => a.map((n, j) => n + r[j]), [0, 0, 0, 0])
  const grandTotal = grand === null
    ? statuses.reduce((a, m) => a + m.length, 0)
    : grand.reduce((a, n) => a + n, 0)

  lines.push('## 汇总')
  lines.push('')
  lines.push('| 阶段 | 已完成 | 部分 | 未开始 | 需外部输入 | 合计 |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  rows.forEach((counts, i) => {
    lines.push(`| ${i} 阶段${i} | ${counts.join(' | ')} | ${statuses[i].length} |`)
  })
  lines.push(`| **合计** | ${grandCounts.map((n) => `**${n}**`).join(' | ')} | **${grandTotal}** |`)
  return `${lines.join('\n')}\n`
}

const kinds = (problems) => problems.map((p) => p.kind)

test('① 一致的文档不报任何问题', () => {
  const text = doc({ headingDone: 1, summaryCounts: [1, 1, 0, 0] })
  const r = checkProgress(text)
  assert.deepEqual(r.problems, [], `本该一致却报了：${JSON.stringify(r.problems)}`)
})

test('① 标题括号里的「已完成」与明细不符时必须报出来', () => {
  // 明细是 1 个 ✅ + 1 个 🟡，标题却写 2/2——这正是本仓库最容易出现的宽松说法：
  // 把「有交付物」写成「已完成」。读者看到的是"这一阶段全做完了"。
  const text = doc({ headingDone: 2, summaryCounts: [1, 1, 0, 0] })
  const r = checkProgress(text)
  assert.ok(kinds(r.problems).includes('HEADING_DONE_MISMATCH'),
    `应当报标题不一致：${JSON.stringify(r.problems)}`)
  const p = r.problems.find((x) => x.kind === 'HEADING_DONE_MISMATCH')
  assert.match(p.message, /标题写「已完成 2\/2」，明细是 1\/2/)
})

test('① 汇总表的某一列与明细不符时必须报出来', () => {
  const text = doc({ headingDone: 1, summaryCounts: [0, 2, 0, 0] })
  const r = checkProgress(text)
  assert.ok(kinds(r.problems).includes('SUMMARY_COUNT_MISMATCH'))
  const p = r.problems.find((x) => x.kind === 'SUMMARY_COUNT_MISMATCH')
  assert.match(p.message, /「已完成」写 0，明细是 1/)
})

test('① 合计行与各阶段之和不符时必须报出来', () => {
  // 各阶段只有 1 个 ✅，合计却写 5。这一条最隐蔽：每个阶段行都对，
  // 只有末尾那一个数字错——而读者通常只看那一个数字。
  const text = doc({ headingDone: 1, summaryCounts: [1, 1, 0, 0], grand: [5, 1, 0, 0] })
  const r = checkProgress(text)
  assert.ok(kinds(r.problems).includes('GRAND_TOTAL_MISMATCH'),
    `应当报合计不一致：${JSON.stringify(r.problems)}`)
  assert.match(r.problems.find((x) => x.kind === 'GRAND_TOTAL_MISMATCH').message, /写 5，各阶段相加是 1/)
})

test('① 认不出的状态标记必须报「读不出来」，而**不是**默认成未开始', () => {
  // 默认成「未开始」会把一个已完成的条目静默地算成没做——
  // 自检因此变成"帮忙把错误藏起来"。
  const text = doc({ headingDone: 1, summaryCounts: [1, 0, 0, 0], statuses: [['✅', '🟦']] })
  const r = checkProgress(text)
  const p = r.problems.find((x) => x.kind === 'UNREADABLE_STATUS')
  assert.ok(p !== undefined, `未能识别的状态标记必须报出来：${JSON.stringify(r.problems)}`)
  assert.match(p.message, /PRT-001/)
  assert.match(p.message, /🟦/)
})

test('② --fix 的输出与输入之差只能是数字（不能吃掉内容）', () => {
  const text = doc({ headingDone: 2, summaryCounts: [0, 2, 0, 0], grand: [9, 9, 9, 9] })
  const before = text.split(/\r?\n/)
  const fixed = fixProgress(text)
  const after = fixed.split(/\r?\n/)

  assert.equal(after.length, before.length, '行数变了：解析器吃掉了或插入了行')
  /** 把一行里所有数字抹掉，剩下的"骨架"必须逐行相同。 */
  const skeleton = (l) => l.replace(/[0-9]+/g, '#')
  for (let i = 0; i < before.length; i++) {
    assert.equal(skeleton(after[i]), skeleton(before[i]),
      `第 ${i + 1} 行除了数字之外还被改了：\n  - ${before[i]}\n  + ${after[i]}`)
  }
})

test('② --fix 之后必须自检通过（不放大问题）', () => {
  const text = doc({ headingDone: 2, summaryCounts: [0, 2, 0, 0], grand: [9, 9, 9, 9] })
  const fixed = fixProgress(text)
  assert.deepEqual(checkProgress(fixed).problems, [],
    `重算后应当一致：${JSON.stringify(checkProgress(fixed).problems)}`)

  // 重算是幂等的：再修一遍不应有任何变化
  assert.equal(fixProgress(fixed), fixed, '--fix 必须是幂等的')
})

test('② --fix 会把阶段标题与汇总、合计一起改对', () => {
  const text = doc({ headingDone: 2, summaryCounts: [0, 2, 0, 0], grand: [9, 9, 9, 9] })
  const fixed = fixProgress(text)
  assert.match(fixed, /## 阶段 0：阶段0（1\/2）/)
  assert.match(fixed, /\| 0 阶段0 \| 1 \| 1 \| 0 \| 0 \| 2 \|/)
  assert.match(fixed, /\| \*\*合计\*\* \| \*\*1\*\* \| \*\*1\*\* \| \*\*0\*\* \| \*\*0\*\* \| \*\*2\*\* \|/)
})

test('③ 真实的进度表当前是一致的（这个自检不是装饰）', async () => {
  const { readFileSync } = await import('node:fs')
  const { dirname, join, resolve } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const text = readFileSync(join(ROOT, 'docs', 'superpowers', 'prt', 'PRT-PROGRESS.md'), 'utf8')
  const r = checkProgress(text)
  assert.deepEqual(r.problems, [],
    `进度表的派生数字与明细不一致：\n${r.problems.map((p) => `  ✖ [${p.kind}] ${p.phase ?? ''} ${p.message}`).join('\n')}\n` +
    '修法：node scripts/prt/progress-check.mjs --fix')
  // 145 是 spec §12 的权威任务总数；各阶段之和必须等于它
  assert.equal(r.phases.reduce((a, p) => a + p.tally.total, 0), 145)
})

test('④ 解析器认得 2.5 这种小数阶段号', () => {
  // 三个阶段，其中的 🟡 落在被改名为 2.5 的那一个上——
  // 断言必须盯住**同一个**阶段，否则测的是另一个阶段的计数。
  const text = doc({ statuses: [['✅'], ['🟡'], ['✅']] })
    .replace('## 阶段 1：阶段1（0/1）', '## 阶段 2.5：商业薄切片（0/1）')
  const { phases } = parseProgress(text)
  assert.deepEqual(phases.map((p) => p.key), ['0', '2.5', '2'])
  const half = phases.find((p) => p.key === '2.5')
  assert.equal(half.title, '商业薄切片')
  assert.equal(tally(half).counts[1], 1, '🟡 应计入「部分」列')
})

test('④ 汇总表里的「合计」行不参与阶段匹配，但会被单独识别', () => {
  const text = doc({ headingDone: 1, summaryCounts: [1, 1, 0, 0] })
  const { lines } = parseProgress(text)
  const rows = parseSummary(lines)
  assert.equal(rows.length, 2, `两个阶段 + 合计应当解析出 3 行，实际 ${rows.length}：${JSON.stringify(rows.map((r) => r.name))}`)
  assert.equal(rows.filter((r) => r.name.includes('合计')).length, 1)
  assert.deepEqual(rows.find((r) => r.name.includes('合计')).counts, [1, 1, 0, 0])
})

test('④ 缺汇总行的阶段会被报出来，而不是静默跳过', () => {
  const text = doc({ statuses: [['✅', '🟡'], ['✅', '🟡']] })
  // 先确认这份夹具本身是一致的，否则"缺行"的结论可能来自别处
  assert.deepEqual(checkProgress(text).problems, [])
  const stripped = text.split(/\r?\n/).filter((l) => !/^\|\s*1\s+阶段1\s*\|/.test(l)).join('\n')
  assert.notEqual(stripped, text, '夹具里应当有一条阶段 1 的汇总行可删')
  const r = checkProgress(stripped)
  assert.ok(kinds(r.problems).includes('SUMMARY_ROW_MISSING'),
    `缺行必须报出来：${JSON.stringify(r.problems)}`)
})

// ============================================================================
// ⑤⑥ 《F-01～F-25 对照表》也带数字，而它**此前完全没有门禁**。
//
// `check-docs.mjs` 的校验对象只有 `README.md` 与 `docs/FEATURES.md`，
// `progress-check.mjs` 只管 PRT-PROGRESS 自己的派生数字——
// 于是 `docs/MULTI-AGENT-FEATURE-STATUS.md` 里手抄的任何数字
// **没有任何东西会去核对**。实测后果：F-04 那一行写着
// 「已完成 143、部分 19、未开始 1、需外部输入 2」，而台账当时是
// 「145 行 = 138 / 4 / 1 / 2」——**它对不上**，而且它在那里放了很久，
// 因为**没有任何门禁看得见这一类改动**。
//
//   > 一道看不见某类改动的闸门，比没有闸门更危险——它给人"已经守住了"的错觉。
//   > 而这里更糟的是：**连闸门都没有**，于是读者默认"这份表被核对过"。
// ============================================================================

/** 两份进度文档的绝对路径。 */
async function paths() {
  const { dirname, join, resolve } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  return {
    ROOT,
    status: join(ROOT, 'docs', 'MULTI-AGENT-FEATURE-STATUS.md'),
    ledger: join(ROOT, 'docs', 'superpowers', 'prt', 'PRT-PROGRESS.md'),
  }
}

test('⑤ ★★★ 对照表**不许手抄台账的四列合计**（手抄件没人核对，就会漂）', async () => {
  const { readFileSync } = await import('node:fs')
  const p = await paths()
  const status = readFileSync(p.status, 'utf8')
  // ★ 判据刻意**窄**：只禁台账那一种形状（四个状态标记按序、带斜杠的合计），
  //   因为那正是"复制台账的权威读数"的形状。
  //   不禁"16 项全部 ✅"这类**子范围**的说法——那是另一件事，不是这份台账的读数。
  //   ★ 这条判据的**已知边界**（写在这里以免下一个人以为它覆盖了更多）：
  //   用别的措辞手抄同一组数字（例如写成"已完成 138、部分 4…"）它**看不见**。
  //   所以配套的是 ⑥：数字可以不给，但**引用必须对得上号**。
  const tuples = [...status.matchAll(/\d+\s*✅\s*\/\s*\d+\s*🟡\s*\/\s*\d+\s*⬜\s*\/\s*\d+\s*⏸/g)]
  assert.deepEqual(
    tuples.map((m) => m[0]), [],
    '对照表里出现了手抄的台账四列合计。台账是唯一权威，'
    + '这里要么不写数字，要么由脚本从台账读——不要手抄一份没人核对的副本',
  )
})

test('⑥ ★★★ 对照表引用的每个 PRT 号都必须在台账里真实存在', async () => {
  const { readFileSync } = await import('node:fs')
  const p = await paths()
  const status = readFileSync(p.status, 'utf8')
  const ledger = readFileSync(p.ledger, 'utf8')
  const inLedger = new Set([...ledger.matchAll(/^\|\s*(PRT-\d+)/gm)].map((m) => m[1]))
  assert.equal(inLedger.size, 145, `台账行数变了（解析到 ${inLedger.size} 行），这条判据的基准要一起复核`)
  // 引用一个**不存在**的任务号是最坏的一种：读者会去找那一条，
  // 找不到时会以为是自己看错了，而不是"这份文档编了一个号"。
  const cited = [...new Set([...status.matchAll(/PRT-(\d+)/g)].map((m) => `PRT-${m[1]}`))]
  assert.ok(cited.length > 10, `只解析到 ${cited.length} 个引用，锚点可能变了`)
  const missing = cited.filter((id) => !inLedger.has(id))
  assert.deepEqual(missing, [], `对照表引用了台账里不存在的任务号：${missing.join(', ')}`)
})

test('⑥ ★★ 对照表里每个 F-行都必须用图例里的状态标记', async () => {
  const { readFileSync } = await import('node:fs')
  const p = await paths()
  const lines = readFileSync(p.status, 'utf8').split(/\r?\n/)
  // 图例（本文件开头那段引用块）声明了四个标记。用别的写法时读者无法判断
  // 这一条到底做完了没有，而"状态"这一列的全部意义就是回答那个问题。
  const legend = ['✅', '🟡', '⬜', '⏸']
  const okStatus = (s) => legend.includes(s) || /^[✅🟡⬜⏸]+→[✅🟡⬜⏸]+$/.test(s)
  const bad = []
  let checked = 0
  // ★ 锚点不是"看起来像 F-行"，而是**表的表头**：只有第三列恰好写着「状态」的
  //   那张表，第三列才是状态。
  //   第一版按行形状读，于是 §2 的缺口表（`| 缺口 | 改动前的实际读数 | 关掉它的判据 |`）
  //   也被读了进去——那三列里第三列是**判据**。后果不是"漏报"，而是更糟的一种：
  //   *这条判据会在真正的状态写错时保持沉默，同时对着一段正确的判据喊红。*
  //   （第一次跑就撞上了：F-21 刚改成 `⬜→🟡`，它报的却是 §2 里那段判据文本。）
  let header = null
  for (const [i, l] of lines.entries()) {
    if (!/^\s*\|/.test(l)) { header = null; continue }
    // 分隔行（`| --- | --- |`）不改变当前表头。
    if (/^\s*\|[\s|:-]+\|\s*$/.test(l) && l.includes('-')) continue
    const cells = l.split('|').map((c) => c.trim())
    if (header === null) { header = cells; continue }
    // 表头第三列（split 后下标 3）必须是「状态」。
    if ((header[3] ?? '') !== '状态') continue
    const m = /^\|\s*(F-\d\d)\s*\|/.exec(l)
    if (m === null) continue
    checked += 1
    const st = cells[3] ?? ''
    if (!okStatus(st)) bad.push(`L${i + 1} ${m[1]} 状态=${JSON.stringify(st)}`)
  }
  assert.deepEqual(bad, [],
    `状态标记不在图例词表里（读者无法判断它到底做完了没有）：\n  ${bad.join('\n  ')}`)
  // 反向确认这条判据**真的读到了**那三张状态表（§1 的 13 条 + §3 的 6 条 +
  // §4 的 5 条 = 24），而不是被表头锚点全部跳过——一条"什么都没检查"的
  // 判据永远是绿的，这正是它最危险的地方。
  assert.ok(checked >= 24, `只检查了 ${checked} 行状态，锚点可能变了`)
})

// ── 表格行的**格子数**：与「有没有收尾 |」是两种不同的损伤 ──────────────────
//
// 这一组来自一次真实误读：本仓的一次会话按 `|` 切分读 PRT-214 那一行的正文，
// 读到的是被截断的半句，并据此写下了错误结论。当时表里这样的行有 **15 条**，
// 而它们**全都通过了**当时所有门禁——因为旧判据只查"有没有收尾 `|`"，
// 而多余的那条竖线在**正文靠后**，`cells[1]`/`cells[2]` 照样是对的。

test('① 正文里的裸竖线必须被具名报出来（旧的「未收尾」判据发现不了它）', () => {
  const text = doc().replace('| ✅ | 证据 |', '| ✅ | 证据 `a | b` 续 |')
  const r = checkProgress(text)
  const p = r.problems.find((x) => x.kind === 'ROW_PIPE_UNESCAPED')
  assert.ok(p !== undefined, `应当报裸竖线：${JSON.stringify(kinds(r.problems))}`)
  assert.match(p.message, /未转义的 `\|`/)
  // ★ 这一条是**关键的对照**：那一行的收尾 `|` 是**完好的**，
  //   所以旧判据（ROW_NOT_CLOSED）必须**不**报——否则说明我没把两种损伤分开。
  assert.ok(!kinds(r.problems).includes('ROW_NOT_CLOSED'),
    '收尾竖线是好的，不该报 ROW_NOT_CLOSED')
  // 而且 ID/状态两格仍然读得对——这正是"门禁旧判据读不出来"的机理。
  const t = parseProgress(text).phases[0].tasks[0]
  assert.equal(t.id, 'PRT-000')
  assert.equal(t.status, '✅')
})

test('① 转义成 `\\|` 之后必须**不**报（证明判据数的是未转义竖线，不是 split 的段数）', () => {
  // ★ 这条最要紧：`\|` 里**仍然有一个 `|` 字符**，所以
  //   `line.split('|').length` 依旧是 6——如果判据写成"段数 ≠ 5"，修法就永远关不掉它。
  //   判据必须自己数前导反斜杠的奇偶。
  const broken = doc().replace('| ✅ | 证据 |', '| ✅ | 证据 `a | b` 续 |')
  const fixed = broken.replace('`a | b`', '`a \\| b`')
  assert.equal(fixed.split('\n').find((l) => l.includes('a \\| b')).split('|').length, 6,
    '前提校验：转义后按 split 数**仍然**是 6 段')
  assert.deepEqual(checkProgress(fixed).problems, [],
    '转义之后应当一致——否则修法关不掉这条判据')
})

test('① 收尾正常但格子不够时必须报出来，且**不**与「未收尾」重复报', () => {
  const short = doc().replace('| ✅ | 证据 |', '| ✅ 证据 |')
  const r = checkProgress(short)
  assert.ok(kinds(r.problems).includes('ROW_CELLS_MISSING'),
    `应当报格子不够：${JSON.stringify(kinds(r.problems))}`)
  assert.ok(!kinds(r.problems).includes('ROW_PIPE_UNESCAPED'))
})

test('① 少了收尾竖线时只报「未收尾」，不再叠加报格子数（一个缺陷不报成两个）', () => {
  const unclosed = doc().replace('| ✅ | 证据 |', '| ✅ | 证据')
  const r = checkProgress(unclosed)
  assert.ok(kinds(r.problems).includes('ROW_NOT_CLOSED'))
  assert.ok(!kinds(r.problems).includes('ROW_CELLS_MISSING'),
    '没收尾的行按切分天然少一条，不该再报格子数')
  assert.ok(!kinds(r.problems).includes('ROW_PIPE_UNESCAPED'))
})

test('① 真实台账里没有裸竖线，也没有格子数不对的行', async () => {
  // 判据对着**真文件**跑一次：合成夹具永远是对的，而这条判据要防的
  // 恰恰是真实台账在多年追加中长出来的形状。
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const path = fileURLToPath(new URL('../../docs/superpowers/prt/PRT-PROGRESS.md', import.meta.url))
  const r = checkProgress(readFileSync(path, 'utf8'))
  const bad = r.problems.filter((p) => p.kind === 'ROW_PIPE_UNESCAPED' || p.kind === 'ROW_CELLS_MISSING')
  assert.deepEqual(bad, [], `真实台账里有形状不对的行：\n${bad.map((p) => p.message).join('\n')}`)
})

// ══════════════════════════════════════════════════════════════════════════
// ★★★ 第 45 轮：台账状态词表是**一处所有**，且认不出来就**抛**
//
// 起因：第 44 轮 `PRT-316` 由 ⬜ 转 **🟡**，而"认得 🟡"这件事在**四个**地方
// 各写了一遍，改到第四处才认全。其中最坏的一处 `boundary-facts.tallyLedger`
// 认不出就 `continue` ⇒ 报 **144** 而台账有 145 条，**而那个错数正好能过门禁**。
//
// 第 45 轮把这个问题做成**可证伪**的：往合成台账里放一个今天**不存在**的
// 第 5 个标记（🔵），看每个解析器的**行数**有没有少
// （`scratch/_probe-status-poison.mjs`）。读数：**两个**解析器静默丢行
// （`ledgerEvidenceRows`、`ledgerRows`）。
//
//   > 一个"认不出的标记就跳过"的解析器，在今天**不会**被任何真实输入触发，
//   > 所以它与一个正确的解析器读数**完全一样**；
//   > 而"要不要加第 5 个状态"这件事一旦发生，
//   > 它们会**同时**安静地少算——而不是报错。
// ══════════════════════════════════════════════════════════════════════════

test('⑫ ★★★ 词表**只有一处**：`LEDGER_STATUS_MARKS` 由 `STATUS_MARKS` 派生', () => {
  // 这条钉的是"**一处所有**"这个性质本身，而不是那四个字面量。
  assert.deepEqual([...LEDGER_STATUS_MARKS], STATUS_MARKS.map((s) => s.mark),
    '`LEDGER_STATUS_MARKS` 不再等于 `STATUS_MARKS` 的标记列 ⇒ 词表被抄成了第二份')

  // ★ 反面控制：**顺序无关**的判据不能替我们证明"是派生的"。
  //   所以再钉一条**位置**性质：往 `STATUS_MARKS` 里加一个标记，
  //   `LEDGER_STATUS_MARKS` 必须**立刻**跟着变——派生量不是快照。
  //   （用的是同一个冻结数组的 `map` 结果，所以这条只能靠"同一个来源"成立。）
  const derived = Object.freeze(STATUS_MARKS.map((s) => s.mark))
  assert.deepEqual([...LEDGER_STATUS_MARKS], [...derived],
    '两处各算一遍的结果不同 ⇒ 其中至少一处不是从 `STATUS_MARKS` 来的')
})

test('⑬ ★★★ `STATUS_CELL_RE` 与词表同源（加一个标记，正则跟着认）', () => {
  for (const { mark } of STATUS_MARKS) {
    assert.equal(STATUS_CELL_RE.test(mark), true, `${mark} 是词表成员，但正则不认`)
  }
  // ★ 反面控制：**不在**词表里的必须不认——否则这条正则在验"它认得一切"。
  assert.equal(STATUS_CELL_RE.test('🔵'), false, '正则认了一个不在词表里的标记')
  assert.equal(STATUS_CELL_RE.test('✅ '), false, '正则接受了带空格的格子（它要求**整格**相等）')
  assert.equal(STATUS_CELL_RE.test('✅→🟡'), false,
    '迁移写法是**功能表**的词表，不是台账状态格——台账里只放终态')
})

test('⑭ ★★★ `ledgerTaskRow`：认不出的状态格**抛**，不许静默跳过', () => {
  // ★ 正对照：认得的那四个都要**收下**（否则下面那条"抛"可能是"它什么都抛"）。
  for (const { mark } of STATUS_MARKS) {
    const r = ledgerTaskRow(`| PRT-001 甲 | ${mark} | \`a.md\` |`)
    assert.notEqual(r, null, `${mark} 是词表成员，却被当成"不是任务行"`)
    assert.equal(r.status, mark)
    assert.equal(r.prt, 'PRT-001')
    assert.deepEqual(r.cells, ['PRT-001 甲', mark, '`a.md`'])
  }

  // ★ 核心：任务行形状但状态认不出 ⇒ **抛**。
  assert.throws(() => ledgerTaskRow('| PRT-004 丁 | 🔵 | `d.md` |'),
    /状态格不是已知标记/,
    '认不出的状态被跳过了 ⇒ 那一行会安静地从每个读数里消失')

  // ★ 反向控制：**不是**任务行的一律 `null`（不是抛）。
  //   如果这条不成立，"抛"会变成"它在任何表格上都炸"，判据就没法用了。
  for (const notTask of [
    '| 任务 | 状态 | 证据 |',            // 表头：第一格不是 PRT 编号
    '| --- | --- | --- |',                 // 分隔行
    '| PRT-001 甲 | ✅ |',                // 只有 2 个格子（形状不对，不归这条管）
    '不是表格行',
    '| F-22 摩擦 | 🟡 | `x.md` |',        // 功能表：第一格不是 PRT 编号
  ]) {
    assert.equal(ledgerTaskRow(notTask), null, `这条不是任务行，却报了：${notTask}`)
  }
})

test('⑮ ★★★ `marks` 可注入：它跟着**给它的那张表**走，而不是跟着四个字面量', () => {
  // ★★★ 这一条是本轮最关键的判据。
  //
  //   只用"🔵 会抛"来验，无法区分这两种实现：
  //     ① 它查的是 `LEDGER_STATUS_MARKS`（**派生**，加状态只改一处）；
  //     ② 它自己写死 `['✅','🟡','⏸','⬜']`（**抄了一份**，加状态要改 N 处）。
  //   两者在**今天**行为完全一样（🔵 都会抛）——这正是第 42/43 轮反复遇到的
  //   "行为等价 ⇒ 不可证伪"形状。
  //
  //   ⇒ 处置不是加断言，而是**把被跟随的那张表做成可注入的参数**：
  //     拿一张**多一个标记**的表去试，实现必须跟着认。
  const withFifth = ['✅', '🟡', '⏸', '⬜', '🔵']
  const r = ledgerTaskRow('| PRT-004 丁 | 🔵 | `d.md` |', { marks: withFifth })
  assert.notEqual(r, null, '把 🔵 加进词表后仍然不认 ⇒ 它跟的不是这张表')
  assert.equal(r.status, '🔵')

  // ★ 反面控制：注入一张**少一个**标记的表，那个标记就必须开始抛。
  const withoutTodo = ['✅', '🟡', '⏸']
  assert.throws(() => ledgerTaskRow('| PRT-003 丙 | ⬜ | `c.md` |', { marks: withoutTodo }),
    /状态格不是已知标记/,
    '抽掉 ⬜ 之后仍认 ⇒ 它跟的不是这张表（是写死的四个字面量）')
})


