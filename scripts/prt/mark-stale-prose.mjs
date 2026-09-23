// scripts/prt/mark-stale-prose.mjs
// ============================================================================
// 给台账**行内**过期的状态词就地补标记（`docs/superpowers/prt/PRT-PROGRESS.md`）。
//
// 为什么需要它：这份台账是**编年体**——每一批把进展追加在行内，「当前状态」只在
// 第 2 格。于是行内会长期留着"当时"的口径（`故本行仍 🟡` 之类），而它读起来
// 与结论一模一样。2026-09-23 一次真实的误读就是这么发生的：一份递过来的状态表
// 按行内正文拼出来，7 条里 4 条与状态格相反（当天实测 33 处）。
//
// 判据在 `scripts/prt/progress-check.mjs`（`PROSE_STATUS_STALE`）——**本脚本只是
// 执行者**：标记的文本从那里取（`staleProseMarker`），不许在这里再写一份。
//
// 用法：
//   node scripts/prt/mark-stale-prose.mjs            # 只列出要补哪些（dry-run，默认）
//   node scripts/prt/mark-stale-prose.mjs --write    # 落盘
//
// ⚠️ 两个都做过的坑，写在这里省得下一个人再踩：
//   · 台账是 **CRLF**：改写必须保住行尾（本脚本先断言行尾统一，混合就拒写）；
//   · 插入是**行内**的 ⇒ 行数不变 ⇒ 所有 `行:号` 引文坐标**不会**漂。
//     用整行替换或 PowerShell 的 `Get-Content|Set-Content` 往返，会把中文写坏
//     （本仓第 118 轮第十一轮真出过 mojibake + 语法错）。
// ============================================================================
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  STALE_PROSE_MARKER_PREFIX,
  findProseStatusClaims,
  ledgerTaskRow,
  markerAfterClaim,
  staleProseMarker,
} from './progress-check.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const PROGRESS = join(ROOT, 'docs', 'superpowers', 'prt', 'PRT-PROGRESS.md')

/**
 * 算出"要补哪些标记"。**纯函数**（收文本、回计划），便于用例拿合成台账试。
 *
 * @returns {{rows: {line: number, id: string, status: string, stale: object[]}[],
 *            total: number, conflicts: number, eol: string, lines: string[]}}
 */
export function planStaleProseMarks(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length
  if (crlf !== 0 && lf !== 0) {
    throw new Error(`台账行尾不统一（CRLF=${crlf} LF=${lf}）——先查清楚再改写，`
      + '否则一次改写会把其中一半的行尾翻掉')
  }
  const eol = crlf !== 0 ? '\r\n' : '\n'
  const lines = text.split(eol)
  const rows = []
  let total = 0
  let conflicts = 0

  for (let i = 0; i < lines.length; i++) {
    let row = null
    try { row = ledgerTaskRow(lines[i]) } catch { continue }
    if (row === null) continue
    const stale = []
    for (const claim of findProseStatusClaims(lines[i])) {
      if (claim.value === row.status) continue
      if (markerAfterClaim(lines[i], claim) === row.status) continue
      // ★ 已经有标记但状态不对 ⇒ **不叠加第二个**：判据只读紧邻的那一个，
      //   叠加出来的第二个标记永远不会被读到，而它会让人以为已经标过了。
      if (lines[i].slice(claim.endIndex, claim.endIndex + 40).includes(STALE_PROSE_MARKER_PREFIX)) {
        conflicts += 1
        continue
      }
      stale.push(claim)
    }
    if (stale.length === 0) continue
    rows.push({ line: i + 1, id: row.prt, status: row.status, stale })
    total += stale.length
  }
  return { rows, total, conflicts, eol, lines }
}

/** 落盘：每行内**从后往前**插，前面的下标才不受影响。 */
export function applyStaleProseMarks({ rows, eol, lines }) {
  let written = 0
  for (const r of rows) {
    let line = lines[r.line - 1]
    for (const claim of [...r.stale].sort((a, b) => b.endIndex - a.endIndex)) {
      line = line.slice(0, claim.endIndex) + staleProseMarker(r.status) + line.slice(claim.endIndex)
      written += 1
    }
    lines[r.line - 1] = line
  }
  return { text: lines.join(eol), written }
}

const isMain = process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) {
  const write = process.argv.includes('--write')
  const text = readFileSync(PROGRESS, 'utf8')
  const plan = planStaleProseMarks(text)

  process.stdout.write(`行尾=${plan.eol === '\r\n' ? 'CRLF' : 'LF'} · 需补标记的行=${plan.rows.length} · 处=${plan.total}\n`)
  if (plan.conflicts !== 0) {
    process.stdout.write(`⚠️ 已有标记但状态不对（需人工处理，未动）= ${plan.conflicts}\n`)
  }
  for (const r of plan.rows) {
    const values = [...new Set(r.stale.map((c) => c.value))].join('/')
    process.stdout.write(`  行 ${String(r.line).padStart(4)}  ${r.id}  状态格=${r.status}  ${r.stale.length} 处  ${values}\n`)
  }

  if (plan.total === 0) {
    process.stdout.write('（没有需要补的：行内状态词要么与状态格一致，要么已经带标记）\n')
    process.exit(plan.conflicts === 0 ? 0 : 1)
  }
  if (!write) {
    process.stdout.write('\n（dry-run；确认无误后加 --write 落盘）\n')
    process.exit(0)
  }

  const { text: out, written } = applyStaleProseMarks(plan)
  writeFileSync(PROGRESS, out, 'utf8')
  process.stdout.write(`\n已写入 ${written} 处标记（${plan.rows.length} 行）\n`)
  process.stdout.write('复核：node scripts/prt/progress-check.mjs\n')
  process.exit(0)
}
