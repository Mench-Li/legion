// scratch/_probe-anchors.mjs —— 测候选锚点在交接报告里的命中次数（必须恰好 1 次）（**不提交**）
import { readFileSync } from 'node:fs'

const H = 'D:/project/DSH/legion/docs/superpowers/prt/PRT-HANDOVER-2026-09-18-ROUND22.md'
const text = readFileSync(H, 'utf8')

const cands = [
  ['handover-ledger-done', /台账 \| \*\*145 行 = (\d+) ✅/],
  ['handover-suites-total', /套件清单完备 \| \*\*(\d+) 个/],
  ['handover-reach-unreachable', /不可达 \*\*(\d+)\*\* 条/],
  ['handover-doc-ratchet', /全仓棘轮 \*\*(\d+)\*\*/],
  ['handover-ci-prose-seconds', /`test` 阶段那 (\d+) 秒里/],
  ['handover-ci-latest-ms', /全量 CI（\*\*交付 HEAD\*\*）[^\n]*?`test` (\d+)ms/],
  ['handover-todos-pause', /(\d+) 条 ⏸/],
  ['handover-todos-todo', /(\d+) 条 ⬜/],
]
for (const [name, re] of cands) {
  const all = [...text.matchAll(new RegExp(re.source, 'g'))]
  const mark = all.length === 1 ? '✓' : (all.length === 0 ? '✖ 找不到' : `✖ 命中 ${all.length} 处`)
  console.log(`${mark}  ${name}`)
  console.log(`      ${re}`)
  for (const m of all.slice(0, 4)) {
    const line = text.slice(0, m.index).split('\n').length
    console.log(`      L${line}: ${JSON.stringify(m[0].replace(/\s+/g, ' ').slice(0, 90))}  → [${m[1]}]`)
  }
}
