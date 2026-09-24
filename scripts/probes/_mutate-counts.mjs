// scripts/probes/_mutate-counts.mjs —— 变异验证：把修好的数改回去，门禁必须红（**不提交**）
import { readFileSync, writeFileSync } from 'node:fs'
import { checkRepo } from '../../scripts/prt/suite-counts.mjs'

const F = 'D:/project/DSH/legion/docs/MULTI-AGENT-FEATURE-STATUS.md'
const orig = readFileSync(F, 'utf8')
const MUT = [
  ['M1 把 dsh-adapter 改回 25（本轮修掉的三个之一）', '套件 `dsh-adapter`（98 例）', '套件 `dsh-adapter`（25 例）'],
  ['M2 把 runtime-contract 改回 13', '套件 `runtime-contract`（64 例）', '套件 `runtime-contract`（13 例）'],
  ['M3 把 registry 改回 32', '`registry.test.mjs` 37 例', '`registry.test.mjs` 32 例'],
  ['M4 把预算套件改成一个漂亮但错的数', '`usage-rollup.test.mjs` 12 例', '`usage-rollup.test.mjs` 15 例'],
]
let all = true
try {
  for (const [name, find, repl] of MUT) {
    if (!orig.includes(find)) { console.log(`⚠ ${name}\n    变异串没找到`); all = false; continue }
    writeFileSync(F, orig.replace(find, repl), 'utf8')
    const r = checkRepo()
    const hit = r.violations.length > 0
    if (!hit) all = false
    console.log(`${hit ? '✓ 咬住' : '✖ 漏网'} ${name}`)
    if (hit) console.log('     ' + r.violations.map((v) => `${v.name}: 说 ${v.claim} 实测 ${v.real}`).join(' | '))
    writeFileSync(F, orig, 'utf8')
  }
} finally { writeFileSync(F, orig, 'utf8') }
console.log('\n全部咬住 ? ' + all)
console.log('还原逐字相同 ? ' + (readFileSync(F, 'utf8') === orig))
const back = checkRepo()
console.log(`还原后：ok=${back.ok} 已核 ${back.checked}/${back.total} 跳过 ${back.skipped.length}`)
