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
  STATUS_MARKS,
  checkProgress,
  fixProgress,
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
  for (const [i, l] of lines.entries()) {
    // ★ 只读 `| F-xx | 名称 | 状态 | …` 这个形状的行。
    //   §2 的缺口表列序不同（第二列是"改动前的实际读数"、第三列是判据），
    //   按同一个形状去读它会把**判据**当成状态——那会让这条判据
    //   在真正的状态写错时保持沉默，同时对着一段正确的判据喊红。
    const m = /^\|\s*(F-\d\d)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|/.exec(l)
    if (m === null) continue
    const st = m[3]
    // 缺口表那类的第三列以数字或反引号开头（判据/用例名），不是状态。
    if (st === '' || /^[\d`]/.test(st)) continue
    if (!okStatus(st)) bad.push(`L${i + 1} ${m[1]} 状态=${JSON.stringify(st)}`)
  }
  assert.deepEqual(bad, [],
    `状态标记不在图例词表里（读者无法判断它到底做完了没有）：\n  ${bad.join('\n  ')}`)
  // 反向确认这条判据**真的读到了** §1 总表，而不是被上面那些过滤条件全部跳过。
  const seen = lines.filter((l) => /^\|\s*F-\d\d\s*\|/.test(l)).length
  assert.ok(seen >= 20, `只读到 ${seen} 行 F-行，锚点可能变了`)
})

