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
