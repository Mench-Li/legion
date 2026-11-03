#!/usr/bin/env node
// team-hub/scripts/comment-column-readers.mjs
// ============================================================================
// F0 · B 段前置：统计"还在直接读三列"的地方（设计稿 §11.4，D3 决策）
//
//   node team-hub/scripts/comment-column-readers.mjs [--roots=team-hub,scrum,workbench,plugins]
//
// 「什么时候可以删 `tasks.comments/evidence/feedback`」不该靠感觉。这个脚本给出一个数，
// 并列出每一处 `文件:行`，让人可以直接跳过去改。
//
// ★ 它是**指标**，不是门：永远 exit 0（阈值只作为 `readyToDrop` 提示）。
//   把"能不能删"做成阻断式门，会诱使人去改计数规则而不是改代码。
// ============================================================================
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'

export const DROP_THRESHOLD = 5
const COLUMNS = ['comments', 'evidence', 'feedback']
const SCAN_EXT = new Set(['.mjs', '.js', '.ts', '.tsx', '.jsx'])
/** 这些文件是"收敛的终点"或"不算线上读取"的地方。 */
const EXCLUDE_PATH = [
  /task-input\.mjs$/,           // 投影/同步的唯一写点
  /\.test\.mjs$/, /\.test\.ts$/, // 测试
  /comment-column-readers/,     // 本脚本自己
]

function isExcluded(path) {
  const normalized = path.replace(/\\/g, '/')
  return EXCLUDE_PATH.some((re) => re.test(normalized))
}

/**
 * 逐行判定：这一行在读**哪些**列（一行可能同时读多列，例如解构 `{comments, evidence}`）。
 * 返回空数组 = 这一行不是读取点。
 */
function columnsOfLine(line) {
  // 建表语句 / 列定义不是读取点
  if (/CREATE TABLE|ADD COLUMN|TEXT\s+DEFAULT/i.test(line)) return []
  const hit = []
  for (const column of COLUMNS) {
    const patterns = [
      new RegExp(`\\.${column}\\b`),                    // t.comments / task.evidence
      new RegExp(`\\{[^}]*\\b${column}\\b[^}]*\\}`),    // 解构
      new RegExp(`SELECT[^;]*\\b${column}\\b`, 'i'),    // SQL 列名
      new RegExp(`JSON\\.parse\\([^)]*\\.${column}\\b`), // 显式解析
    ]
    if (patterns.some((re) => re.test(line))) hit.push(column)
  }
  return hit
}

/**
 * 纯函数：把 {path, text} 列表分类成读取点。
 * @returns {{ sites: Array<{path, line, column, text}>, columns: string[], readyToDrop: boolean }}
 */
export function classifyReadSites(files) {
  const sites = []
  for (const file of Array.isArray(files) ? files : []) {
    if (isExcluded(file.path)) continue
    const lines = String(file.text ?? '').split(/\r?\n/)
    lines.forEach((text, index) => {
      const columns = columnsOfLine(text)
      if (columns.length === 0) return
      sites.push({
        path: file.path, line: index + 1,
        column: columns[0], columns,
        text: text.trim().slice(0, 120),
      })
    })
  }
  return {
    sites,
    // 一行可能读多列：并集要用每行的 columns，而不是只看第一列
    columns: [...new Set(sites.flatMap((s) => (s.columns ?? [s.column])))].sort(),
    readyToDrop: sites.length < DROP_THRESHOLD,
  }
}

/** 递归收集待扫描文件。 */
function collect(root, out = []) {
  let entries = []
  try { entries = readdirSync(root) } catch { return out }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git' || name === 'lib' || name === 'dist') continue
    const full = join(root, name)
    let info = null
    try { info = statSync(full) } catch { continue }
    if (info.isDirectory()) collect(full, out)
    else if (SCAN_EXT.has(extname(name))) {
      try { out.push({ path: relative(process.cwd(), full).replace(/\\/g, '/'), text: readFileSync(full, 'utf8') }) } catch { /* 跳过不可读 */ }
    }
  }
  return out
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('comment-column-readers.mjs')
if (invokedDirectly) {
  const rootsArg = process.argv.find((a) => a.startsWith('--roots='))
  const roots = rootsArg ? rootsArg.slice('--roots='.length).split(',') : ['team-hub', 'scrum', 'workbench', 'plugins/src']
  const files = []
  for (const root of roots) collect(root, files)

  const report = classifyReadSites(files)
  process.stdout.write(JSON.stringify({
    scanned: files.length,
    count: report.sites.length,
    threshold: DROP_THRESHOLD,
    readyToDrop: report.readyToDrop,
    columns: report.columns,
    sites: report.sites,
    at: new Date().toISOString(),
  }, null, 2) + '\n')
}
