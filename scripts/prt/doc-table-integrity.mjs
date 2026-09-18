// scripts/prt/doc-table-integrity.mjs
// ============================================================================
// 文档表格**列数一致性**检查器（PRT-610 续 / 第 22 轮）。
//
// ## 为什么需要它
//
// 一个 markdown 表格行里如果出现**未转义的竖线**（哪怕它在一个代码跨度里，
// 例如 `` `string|null` `` 或 `` `/api/create|claim` ``），那一行会被切成**多一格**。
// 后果不是"渲染难看"，是**整行右移一格**：
//
//   > 一个"单元格里有一个未转义竖线"的表格行，
//   > 与一个"整行内容都对、只是列标题对不上"的表格行，是同一个东西——
//   > 只不过读它的人会把**后果**当成**决定**来读。
//
// 第 22 轮就是这么发现问题的：`MULTI-AGENT-FEATURE-STATUS.md` 决策表**第 23 条**的
// "具体决定"格里有个 `` `string|null` ``，把它切成 6 列，于是"具体决定"与
// "不决定的后果"各错位一格——而那张表**正是承载裁决的表**。
//
// ★ **CommonMark 的代码跨度里反斜杠不转义**（`\|` 在 `` ` `` 里渲染成 `\|`），
// 所以修法**不能**是把竖线转义，只能换记号（`或` / `｜` / `{a,b}`）。
//
// ## 检查器的两半
//
// ① **权威文档必须 0 处**（硬断言）。权威文档 = 承载裁决 / 台账 / 报告的那几份，
//    它们的列错位会让**一个读数被当成另一个读数**。
// ② **全仓已跟踪 md 不许增长**（棘轮）。历史评审记录里还有一批（基线 87），
//    它们是**时点记录**、不再改动，所以做棘轮而不是清零：新出现的会判红。
//
// ## 一个刻意的取舍（与可达性探针同一条纪律）
//
// 基线**过期（处数变少）不判红，只报警**——理由与
// `docs/MULTI-AGENT-FEATURE-STATUS.md` §5.4 那条逐字相同：
//
//   > 一个「把别人修好的好消息判成回归」的闸门，
//   > 与一个「逼着人把好消息重新基线一遍」的闸门，是同一个东西——
//   > 只不过前者会在**共享工作树上天天红**。
//
// 新增（处数变多）**判红**——那才是本检查要挡的方向。
//
// @module scripts/prt/doc-table-integrity
// ============================================================================

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * **权威文档**：承载裁决、台账、进度与报告的那几份。
 *
 * ★ 这个清单是**硬断言**（必须 0 处），所以它要短而准：
 * 往里加文件 = 承诺它也保持 0 处。跑一次就知道能不能守住。
 */
export const AUTHORITATIVE_DOCS = Object.freeze([
  'README.md',
  'docs/FEATURES.md',
  'docs/STATUS.md',
  'docs/MULTI-AGENT-FEATURE-STATUS.md',
  'docs/DECISION-RUNREQUEST-EXECUTION-PLANE.md',
  'docs/superpowers/prt/PRT-PROGRESS.md',
  'docs/superpowers/prt/PRT-SESSION-REPORT-2026-09-17.md',
  'docs/superpowers/prt/PRT-FINAL-REPORT-2026-09-18.md',
])

/**
 * 全仓已跟踪 md 的缺陷处数基线（**只许减少**）。
 *
 * 2026-09-18 第 22 轮实测：**87 处 / 16 个文件**，全部落在 `docs/review/*`
 * 与 `scratch/*evidence-backup/*` 这类**时点记录**里——它们记录的是当时发生的事，
 * 不再改动，所以做棘轮而不是清零。
 */
export const REPO_WIDE_BASELINE = 87

/** 逐行切格。★ 只有**未转义**的竖线才分格（`\|` 是字面竖线）。 */
export function splitRow(line) {
  const t = line.trim()
  if (!t.startsWith('|')) return null
  return t.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/)
}

/** 是不是分隔行（`| --- | :--: |`）。 */
export function isSeparatorRow(cells) {
  return Array.isArray(cells) && cells.length > 0
    && cells.every((c) => /^\s*:?-{2,}:?\s*$/.test(c))
}

/**
 * 找出一份 markdown 文本里**所有**表格的列数不一致。
 *
 * 判据：表头 N 格 ⇒ 分隔行与表内每一行都必须 N 格。
 *
 * @param {string} text
 * @returns {ReadonlyArray<{line: number, got: number, want: number, kind: string}>}
 */
export function findTableDefects(text) {
  const lines = String(text).split(/\r?\n/)
  const out = []
  let i = 0
  while (i < lines.length) {
    const head = splitRow(lines[i])
    if (head === null) { i += 1; continue }
    const sep = i + 1 < lines.length ? splitRow(lines[i + 1]) : null
    if (sep === null || !isSeparatorRow(sep)) { i += 1; continue }
    // 找到了一个表格：表头在第 i 行
    const want = head.length
    if (sep.length !== want) {
      out.push(Object.freeze({ line: i + 2, got: sep.length, want, kind: 'separator' }))
    }
    let j = i + 2
    while (j < lines.length) {
      const row = splitRow(lines[j])
      if (row === null) break
      if (row.length !== want) {
        out.push(Object.freeze({ line: j + 1, got: row.length, want, kind: 'row' }))
      }
      j += 1
    }
    i = j
  }
  return Object.freeze(out)
}

/** 已跟踪的 md 文件（相对仓库根的 posix 路径）。 */
export function trackedMarkdownFiles({ cwd } = {}) {
  // ★★ 必须用 `-z`：默认 `git ls-files` 会把**非 ASCII 路径**按 `core.quotePath`
  //    转义成 C 风格八进制并**加上双引号**——于是
  //    `whiteboard/docs/adr/ADR-0001-同步引擎.md` 回来的是
  //    `"whiteboard/docs/adr/ADR-0001-\345\220\214\346\255\245\345\274\225\346\223\216.md"`，
  //    那种路径**打不开**。本仓有 8 个这样的文件。
  //
  //    后果不是"少查 8 个文件"这么轻：那 8 个会在 `auditFiles` 里变成 8 条
  //    `kind:'missing'`，于是① 总数被**虚高**，② 它们自己的真缺陷**一处都数不到**。
  //    ⇒ 一个"文件清单里带着带引号的名字"的检查，与一个"对某些文件永远看不见"
  //      的检查，是同一个东西——只不过前者的症状（总数偏高）看起来像**坏消息**，
  //      而真正危险的方向（漏报）藏在里面。
  return Object.freeze(
    execFileSync('git', ['ls-files', '-z', '*.md'], { cwd, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean),
  )
}

/**
 * 对一批文件跑检查。
 *
 * @returns {Readonly<{defects: ReadonlyArray<object>, total: number, files: number}>}
 */
export function auditFiles({ cwd, files } = {}) {
  const defects = []
  for (const rel of files) {
    const p = join(cwd, rel)
    if (!existsSync(p)) {
      defects.push(Object.freeze({ file: rel, line: 0, got: -1, want: -1, kind: 'missing' }))
      continue
    }
    for (const d of findTableDefects(readFileSync(p, 'utf8'))) {
      defects.push(Object.freeze({ file: rel, ...d }))
    }
  }
  return Object.freeze({ defects: Object.freeze(defects), total: defects.length, files: files.length })
}

/** 按"改了哪个文件、改了几处"分组，便于把基线写成人能读的一张表。 */
export function groupByFile(defects) {
  const m = new Map()
  for (const d of defects) m.set(d.file, (m.get(d.file) ?? 0) + 1)
  return m
}

export const DOC_TABLE_INTEGRITY_CHECKED = Object.freeze({
  authoritativeDocs: AUTHORITATIVE_DOCS.length,
  repoWideBaseline: REPO_WIDE_BASELINE,
})
