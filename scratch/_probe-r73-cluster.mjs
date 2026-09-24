// scratch/_probe-r73-cluster.mjs —— 第 73 轮：谁缺 subagents、谁不缺（用 readFileSync，不用 shell 转义）
//
// ★ 第 72 轮的教训：**不要**用 shell 里带 \\| 的 git grep —— 报错会被读成空结果。
//   这里直接读文件内容，**报错就是报错**。
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const R = 'D:/project/DSH/legion'
// 候选：仓库里所有 *dsh-process*.test.mjs + 跨进程那个
const out = execFileSync('git', ['ls-files', '*.test.mjs'], { cwd: R, encoding: 'utf8' })
const files = out.split('\n').map((s) => s.trim()).filter(Boolean)

const rows = []
for (const f of files) {
  if (!/dsh-process|cross-process/.test(f)) continue
  const src = readFileSync(`${R}/${f}`, 'utf8')
  const hasSub = src.includes("provide('subagents'")
  const hasFactory = src.includes('setDshRuntimeInputsFactory')
  rows.push({ f, hasSub, hasFactory })
}
console.log('  文件'.padEnd(74) + 'subagents  注册工厂')
console.log('  ' + '-'.repeat(96))
for (const r of rows) {
  console.log(`  ${r.f.padEnd(72)} ${(r.hasSub ? '有' : '——').padEnd(10)} ${r.hasFactory ? '有' : '——'}`)
}
const lack = rows.filter((r) => r.hasFactory && !r.hasSub)
console.log(`\n  ⇒ **注册了工厂但缺 subagents** 的文件（= A 簇）：${lack.length} 个`)
for (const r of lack) console.log(`     · ${r.f}`)
