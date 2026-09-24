// scratch/_probe-stage-collisions.mjs —— `--only <阶段>` 会不会**看起来**覆盖了某个套件（**不提交**）
import { readFileSync } from 'node:fs'
import { suiteFilesFromCi } from '../scripts/prt/suite-counts.mjs'

const ci = readFileSync('D:/project/DSH/legion/scripts/ci/run-ci.mjs', 'utf8')

// 阶段名：从阶段登记表里取
const stages = [...ci.matchAll(/name:\s*'([a-z]+)',\s*label:/g)].map((m) => m[1])
const uniqStages = [...new Set(stages)]
console.log('CI 阶段：', uniqStages.join('、'))

const suites = [...suiteFilesFromCi(ci).keys()]
console.log(`套件行 ${suites.length} 个\n`)

console.log('=== 阶段名是某套件名的**前缀**（`--only X` 看起来会跑它，其实不会）===')
let hits = 0
for (const s of uniqStages) {
  const clash = suites.filter((t) => t !== s && (t.startsWith(s) || s.startsWith(t)))
  if (clash.length === 0) continue
  hits += clash.length
  console.log(`  阶段 \`${s}\`  ↔  套件：${clash.join('、')}`)
}
console.log(`\n共 ${hits} 处名字上的相似`)
