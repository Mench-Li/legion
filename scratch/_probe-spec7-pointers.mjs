// scratch/_probe-spec7-pointers.mjs（**不提交**）
import { SPEC7_PROJECTION } from '../scripts/prt/spec-tests-7.mjs'
import { extractMentions } from '../scripts/prt/ledger-evidence.mjs'

let n = 0
for (const p of SPEC7_PROJECTION) {
  const m = extractMentions(p.evidence)
  console.log(`\n[${p.key}]  suites=${m.suites.length} paths=${m.paths.length} bare=${m.bare.length}`)
  for (const s of m.suites) { n++; console.log(`   套件  ${s}`) }
  for (const f of m.paths) { n++; console.log(`   路径  ${f}`) }
  for (const b of m.bare) { n++; console.log(`   裸名  ${b}`) }
}
console.log(`\n合计 ${n} 处`)
// 反查：evidence 里出现的所有后引号 token（看看有没有没被算进去的 .test.mjs）
console.log('\n=== evidence 里的全部后引号 token ===')
for (const p of SPEC7_PROJECTION) {
  const toks = [...p.evidence.matchAll(/`([^`]+)`/g)].map((x) => x[1])
  console.log(`[${p.key}]`)
  for (const t of toks) {
    const counted = t.endsWith('.test.mjs')
    console.log(`   ${counted ? '计数' : '不计'}  ${t}`)
  }
}
