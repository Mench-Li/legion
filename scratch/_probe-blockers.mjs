// scratch/_probe-blockers.mjs —— 5 条非 ✅ 的台账行，逐条看"阻塞在哪"（**不提交**）
import { ledgerEvidenceRows } from '../scripts/prt/ledger-evidence.mjs'

for (const r of ledgerEvidenceRows()) {
  if (r.status === '✅') continue
  console.log(`\n${'='.repeat(78)}`)
  console.log(`${r.prt}  [${r.status}]  L${r.line}`)
  console.log(`${r.desc}`)
  console.log('-'.repeat(78))
  console.log(r.evidence)
}
