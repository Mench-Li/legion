// 用生成器重渲 §5 状态索引，并**就地**替换掉文档里那一段（只改那一段）。
// 手工改这一段的代价：name 会被截到 46 字符、合计数字要重算——两处都会漂。
import { readFileSync, writeFileSync } from 'node:fs'
import { renderDecisionStateIndex, decisionStateRows, decisionStateIndex, decisionStateViolations } from '../scripts/prt/reachability.mjs'

const FILE = 'docs/MULTI-AGENT-FEATURE-STATUS.md'
const doc = readFileSync(FILE, 'utf8')
const rendered = renderDecisionStateIndex(doc)

const lines = doc.split('\n')
const h = lines.findIndex((l) => /决策表状态索引/.test(l))
if (h < 0) throw new Error('找不到索引标题')

// 索引表本体：从标题后第一行 `| # |` 表头开始，到"⇒ **合计**"那一行为止。
let tableStart = -1
for (let i = h; i < lines.length; i += 1) {
  if (/^\|\s*#\s*\|/.test(lines[i])) { tableStart = i; break }
}
if (tableStart < 0) throw new Error('找不到索引表头')
let tableEnd = -1
for (let i = tableStart; i < lines.length; i += 1) {
  if (/^⇒ \*\*合计\*\*/.test(lines[i])) { tableEnd = i; break }
  if (/^##\s/.test(lines[i])) break
}
if (tableEnd < 0) throw new Error('找不到合计行')

const before = lines.slice(0, tableStart)
const after = lines.slice(tableEnd + 1)
const next = [...before, ...rendered.split('\n'), ...after].join('\n')
writeFileSync(FILE, next)

// 立即用判据自证
const check = readFileSync(FILE, 'utf8')
const v = decisionStateViolations(check)
console.log('派生', decisionStateRows(check).length, '条 | 索引', decisionStateIndex(check).length, '条')
console.log('违规', v.length, v.length > 0 ? JSON.stringify(v.slice(0, 4)) : '（无）')
console.log('--- 重渲出来的最后两行 ---')
console.log(rendered.split('\n').slice(-3).join('\n'))
