// scripts/prt/progress-check.mjs
// ============================================================================
// PRT 进度表自检（docs/superpowers/prt/PRT-PROGRESS.md）
//
// 为什么需要它：这张表的「汇总」区是**人手维护的**，而这些数字由上面各阶段的
// 行推导出来。两者不一致时后果很具体——读者看汇总得到"还剩多少"，而看明细
// 得到另一个答案；由于汇总在文件末尾、明细在中部，几乎没人会去核对。
//
// 这个脚本的作者在两次不同的批次里把阶段 3 的计数写错过两次（一次 6/4/6、
// 一次 11/16 而实际是 9/16）。手写的派生数字就是会错——不是粗心，
// 而是它天然要求每次改动都完整地重新做一遍加法，而人只会更新自己刚改的那一行。
//
// 用法：
//   node scripts/prt/progress-check.mjs           # 只检查，不一致则非零退出
//   node scripts/prt/progress-check.mjs --fix     # 用明细重算并改写汇总区
//   node scripts/prt/progress-check.mjs --json    # 输出机器可读结果
//
// 口径（与文件头声明一致）：
//   ✅ 已完成 / 🟡 部分 / ⬜ 未开始 / ⏸ 需外部输入
//   汇总每一行的四列就是这四类计数，**部分不与已完成相加**。
// ============================================================================
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const PROGRESS = join(ROOT, 'docs', 'superpowers', 'prt', 'PRT-PROGRESS.md')

/** 状态标记 → 汇总列的次序。顺序即汇总表四列的顺序。 */
export const STATUS_MARKS = Object.freeze([
  { mark: '✅', label: '已完成' },
  { mark: '🟡', label: '部分' },
  { mark: '⬜', label: '未开始' },
  { mark: '⏸', label: '需外部输入' },
])

/**
 * 解析进度表。
 *
 * 用行扫描而不是一次正则：文件里既有阶段表也有汇总表，两者的行形状相似
 * （都以 `| ` 开头），一律靠"当前处于哪一节"来区分，比试图写一个能同时
 * 匹配两者的正则可靠得多。
 */
export function parseProgress(text) {
  const lines = text.split(/\r?\n/)
  const phases = []
  let current = null
  let inSummary = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const phaseHeading = /^##\s+阶段\s*([0-9.]+)\s*[:：]\s*(.*?)\s*(?:（\s*([0-9]+)\s*\/\s*([0-9]+)\s*）)?\s*$/.exec(line)
    if (phaseHeading !== null) {
      current = {
        lineNumber: i + 1,
        key: phaseHeading[1],
        title: phaseHeading[2],
        declaredDone: phaseHeading[3] === undefined ? null : Number(phaseHeading[3]),
        declaredTotal: phaseHeading[4] === undefined ? null : Number(phaseHeading[4]),
        tasks: [],
      }
      phases.push(current)
      inSummary = false
      continue
    }
    if (/^##\s+汇总\s*$/.test(line)) {
      inSummary = true
      current = null
      continue
    }
    if (inSummary) continue
    if (current === null) continue

    // 任务行：`| PRT-xxx 标题 | 状态 | 证据 |`
    if (!line.startsWith('|')) continue
    const cells = line.split('|').map((c) => c.trim())
    // cells[0] 是首个 `|` 之前的部分（空串），因此字段从 1 开始
    const idCell = cells[1] ?? ''
    const idMatch = /^(PRT-[0-9]+)\b/.exec(idCell)
    if (idMatch === null) continue
    const statusCell = cells[2] ?? ''
    const found = STATUS_MARKS.find((s) => statusCell.includes(s.mark))
    current.tasks.push({
      lineNumber: i + 1,
      id: idMatch[1],
      title: idCell.slice(idMatch[1].length).trim(),
      // 找不到已知标记就记成 null：宁可让自检报"这行的状态我读不出来"，
      // 也不要默认成「未开始」——那会让一个已完成的条目被静默地算成没做。
      status: found === undefined ? null : found.mark,
      rawStatus: statusCell,
    })
  }

  return { phases, lines }
}

/**
 * 解析汇总表。
 *
 * 行形状：`| 3 Orchestrator Core | 6 | 4 | 6 | 0 | 16 |`
 * 最后一列是合计。标题列的第 0 个词是阶段编号（`0`、`1`、`2.5`、`3`…）。
 */
export function parseSummary(lines) {
  const out = []
  let inSummary = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^##\s+汇总\s*$/.test(line)) { inSummary = true; continue }
    if (!inSummary) continue
    if (!line.startsWith('|')) continue
    const cells = line.split('|').map((c) => c.trim())
    const nameCell = cells[1] ?? ''
    if (nameCell === '' || /^-+$/.test(nameCell) || /^阶段$/.test(nameCell)) continue
    const nums = cells.slice(2, 7).map((c) => c.replace(/\*\*/g, ''))
    if (nums.length < 5 || nums.some((n) => !/^-?\d+$/.test(n))) continue
    const key = /^([0-9]+(?:\.[0-9]+)?)/.exec(nameCell)
    out.push({
      lineNumber: i + 1,
      name: nameCell,
      key: key === null ? null : key[1],
      counts: nums.slice(0, 4).map(Number),
      total: Number(nums[4]),
      raw: line,
    })
  }
  return out
}

/** 按明细重算每个阶段的计数。 */
export function tally(phase) {
  const counts = STATUS_MARKS.map((s) => phase.tasks.filter((t) => t.status === s.mark).length)
  const unreadable = phase.tasks.filter((t) => t.status === null).map((t) => `${t.id}（第 ${t.lineNumber} 行：${t.rawStatus}）`)
  return { counts, total: phase.tasks.length, unreadable }
}

/** 跑一次自检，返回问题清单（空数组 = 一致）。 */
export function checkProgress(text) {
  const { phases, lines } = parseProgress(text)
  const summary = parseSummary(lines)
  const problems = []

  if (phases.length === 0) problems.push({ kind: 'NO_PHASES', message: '没有解析到任何阶段小节：文件结构可能变了，自检失去意义' })

  for (const phase of phases) {
    const t = tally(phase)
    for (const u of t.unreadable) {
      problems.push({ kind: 'UNREADABLE_STATUS', phase: phase.key, message: `状态标记无法识别：${u}` })
    }
    if (phase.declaredDone !== null && phase.declaredDone !== t.counts[0]) {
      problems.push({
        kind: 'HEADING_DONE_MISMATCH',
        phase: phase.key,
        message: `标题写「已完成 ${phase.declaredDone}/${phase.declaredTotal}」，明细是 ${t.counts[0]}/${t.total}`,
      })
    }
    if (phase.declaredTotal !== null && phase.declaredTotal !== t.total) {
      problems.push({
        kind: 'HEADING_TOTAL_MISMATCH',
        phase: phase.key,
        message: `标题写总数 ${phase.declaredTotal}，明细有 ${t.total} 条任务`,
      })
    }
    const row = summary.find((s) => s.key !== null && Number(s.key) === Number(phase.key))
    if (row === undefined) {
      problems.push({ kind: 'SUMMARY_ROW_MISSING', phase: phase.key, message: `汇总表里没有阶段 ${phase.key} 的行` })
      continue
    }
    for (let c = 0; c < 4; c++) {
      if (row.counts[c] !== t.counts[c]) {
        problems.push({
          kind: 'SUMMARY_COUNT_MISMATCH',
          phase: phase.key,
          message: `汇总表阶段 ${phase.key} 的「${STATUS_MARKS[c].label}」写 ${row.counts[c]}，明细是 ${t.counts[c]}`,
        })
      }
    }
    if (row.total !== t.total) {
      problems.push({
        kind: 'SUMMARY_TOTAL_MISMATCH',
        phase: phase.key,
        message: `汇总表阶段 ${phase.key} 的合计写 ${row.total}，明细有 ${t.total}`,
      })
    }
  }

  // 汇总表自身：每列纵向合计必须等于「合计」行
  const grandRow = summary.find((s) => s.name.includes('合计'))
  if (grandRow === undefined) {
    problems.push({ kind: 'GRAND_TOTAL_MISSING', message: '汇总表里没有「合计」行' })
  } else {
    for (let c = 0; c < 4; c++) {
      const colSum = summary
        .filter((s) => !s.name.includes('合计'))
        .reduce((acc, s) => acc + s.counts[c], 0)
      if (colSum !== grandRow.counts[c]) {
        problems.push({
          kind: 'GRAND_TOTAL_MISMATCH',
          message: `合计行的「${STATUS_MARKS[c].label}」写 ${grandRow.counts[c]}，各阶段相加是 ${colSum}`,
        })
      }
    }
    const colTotal = summary.filter((s) => !s.name.includes('合计')).reduce((acc, s) => acc + s.total, 0)
    if (colTotal !== grandRow.total) {
      problems.push({ kind: 'GRAND_TOTAL_MISMATCH', message: `合计行的合计写 ${grandRow.total}，各阶段相加是 ${colTotal}` })
    }
  }

  return { phases: phases.map((p) => ({ ...p, tally: tally(p) })), summary, grandRow, problems }
}

/**
 * 用明细重算并改写所有派生数字（标题括号里的 `n/m`、汇总表的各列与合计行）。
 *
 * 只改**数字**：行名、任务行、证据文字一律不动。因此这个函数的输出与输入的
 * 差异应当永远只是几个数字——若 diff 里出现了别的东西，那是解析器把内容吃掉了一行。
 */
export function fixProgress(text) {
  const { phases } = parseProgress(text)
  const tallies = new Map(phases.map((p) => [p.key, tally(p)]))
  const lines = text.split(/\r?\n/)

  // ① 阶段标题：`## 阶段 3：Orchestrator Core（9/16）`
  for (const phase of phases) {
    const t = tallies.get(phase.key)
    const idx = phase.lineNumber - 1
    lines[idx] = lines[idx].replace(
      /（\s*[0-9]+\s*\/\s*[0-9]+\s*）/,
      `（${t.counts[0]}/${t.total}）`,
    )
  }

  // ② 汇总表行 + 合计行
  let inSummary = false
  const grand = [0, 0, 0, 0]
  let grandTotal = 0
  const summaryIdx = []
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+汇总\s*$/.test(lines[i])) { inSummary = true; continue }
    if (!inSummary) continue
    if (!lines[i].startsWith('|')) continue
    const cells = lines[i].split('|').map((c) => c.trim())
    const nameCell = cells[1] ?? ''
    if (nameCell === '' || /^-+$/.test(nameCell) || /^阶段$/.test(nameCell)) continue
    const isTotalCol = cells.slice(2, 6).every((c) => /^-?\d+$/.test(c.replace(/\*\*/g, '')))
    if (!isTotalCol) continue
    // 「合计」行必须**先**判定：它的名字是 `**合计**`，没有数字前缀，
    // 因此下面那个 keyMatch 会把它筛掉——把顺序写反的后果是合计行永远不被重算，
    // 而各阶段行都被重算，于是自检会报一个看起来像"某个阶段算错了"的不一致。
    if (nameCell.includes('合计')) { summaryIdx.push({ i, kind: 'grand' }); continue }
    const keyMatch = /^([0-9]+(?:\.[0-9]+)?)/.exec(nameCell)
    if (keyMatch === null) continue
    const key = keyMatch[1]
    const t = tallies.get(key)
    if (t === undefined) continue
    for (let c = 0; c < 4; c++) grand[c] += t.counts[c]
    grandTotal += t.total
    summaryIdx.push({ i, kind: 'phase', key, t })
  }
  for (const s of summaryIdx) {
    if (s.kind === 'grand') {
      lines[s.i] = `| **合计** | ${grand.map((n) => `**${n}**`).join(' | ')} | **${grandTotal}** |`
    } else {
      const bold = /^\|\s*\*\*/.test(lines[s.i])
      const nums = s.t.counts.map((n) => (bold ? `**${n}**` : String(n))).concat([bold ? `**${s.t.total}**` : String(s.t.total)])
      const cells = lines[s.i].split('|')
      const namePart = cells[1]
      lines[s.i] = `|${namePart}| ${nums.join(' | ')} |`
    }
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------- CLI
const isMain = process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) {
  const argv = process.argv.slice(2)
  const text = readFileSync(PROGRESS, 'utf8')
  const result = checkProgress(text)

  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({
      phases: result.phases.map((p) => ({ key: p.key, title: p.title, counts: p.tally.counts, total: p.tally.total })),
      grand: result.grandRow === undefined ? null : { counts: result.grandRow.counts, total: result.grandRow.total },
      problems: result.problems,
    }, null, 2)}\n`)
    process.exit(result.problems.length === 0 ? 0 : 1)
  }

  if (argv.includes('--fix')) {
    if (result.problems.length === 0) {
      process.stdout.write('progress-check: 已一致，无需改写\n')
      process.exit(0)
    }
    const fixed = fixProgress(text)
    // 改写后再自检一次：修完还不一致就说明解析器本身有问题，
    // 那种情况下**不写文件**比写一个半对的版本好。
    const after = checkProgress(fixed)
    if (after.problems.length !== 0) {
      process.stderr.write('progress-check: 重算后仍不一致，未写入文件：\n')
      for (const p of after.problems) process.stderr.write(`  ✖ [${p.kind}] ${p.message}\n`)
      process.exit(2)
    }
    // 保留原行尾风格
    const eol = /\r\n/.test(text) ? '\r\n' : '\n'
    const body = fixed.includes('\r\n') || eol === '\n' ? fixed : fixed.replace(/\n/g, '\r\n')
    writeFileSync(PROGRESS, body, 'utf8')
    process.stdout.write(`progress-check: 已按明细重算并改写 ${result.problems.length} 处派生数字\n`)
    process.exit(0)
  }

  if (result.problems.length === 0) {
    process.stdout.write('progress-check: PASS（各阶段明细与汇总一致）\n')
    for (const p of result.phases) {
      process.stdout.write(`  ${p.key} ${p.title}：✅${p.tally.counts[0]} 🟡${p.tally.counts[1]} ⬜${p.tally.counts[2]} ⏸${p.tally.counts[3]} = ${p.tally.total}\n`)
    }
    process.exit(0)
  }

  process.stdout.write('progress-check: FAIL\n')
  for (const p of result.problems) {
    process.stdout.write(`  ✖ [${p.kind}]${p.phase === undefined ? '' : ` 阶段 ${p.phase}：`}${p.message}\n`)
  }
  process.stdout.write('（这些数字都是派生量：跑 --fix 用明细重算）\n')
  process.exit(1)
}
