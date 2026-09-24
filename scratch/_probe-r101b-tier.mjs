// scratch/_probe-r101b-tier.mjs —— 找出那 1 处"没有登记"的台账分档抄写
import { readFileSync } from 'node:fs'

const t = readFileSync('D:/project/DSH/legion/docs/superpowers/prt/PRT-HUMAN-INTERVENTION-2026-09-20.md', 'utf8')
const lines = t.split(/\r?\n/)
const TIER = /140 ✅ \/ 1 🟡 \/ 4 ⏸ \/ 0 ⬜/
const FAM = /^\|\s*\d+\s*\|/

console.log('  ── 含台账分档串的行，以及它会不会被"家族行"豁免 ──')
lines.forEach((l, i) => {
  if (!TIER.test(l)) return
  const fam = FAM.test(l)
  console.log(`    L${i + 1}  ${fam ? '家族行（豁免）' : '★ 非家族行 ⇒ 必须登记'}   ${l.trim().slice(0, 92)}`)
})
