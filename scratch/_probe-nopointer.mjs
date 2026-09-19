// scratch/_probe-nopointer.mjs —— 那 6 条"没有点名任何套件/用例"的 ✅ 行（**不提交**）
import { ledgerEvidenceRows, extractMentions } from '../scripts/prt/ledger-evidence.mjs'

for (const r of ledgerEvidenceRows()) {
  if (r.status !== '✅') continue
  const { suites, paths, bare } = extractMentions(r.evidence)
  const hasDoc = /`[^`]*\.(?:md|json|mjs|ts|sql|ya?ml)`/.test(r.evidence)
  if (suites.length || paths.length || bare.length || hasDoc) continue
  console.log(`${r.prt} L${r.line}`)
  console.log(`   ${r.evidence.slice(0, 300)}`)
  console.log('')
}
