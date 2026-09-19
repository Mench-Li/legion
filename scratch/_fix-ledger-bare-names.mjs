// scratch/_fix-ledger-bare-names.mjs —— 把 3 处歧义的裸名补成全路径（**不提交**，一次性）
//
// ★ 与第 31 轮修 F-21 同一条原则：**改的是文档，不是判据**。
//   读者解不开的点名，是文档的缺陷；把判据放松只会让下一个解不开的点名也通过。
//
// 目标文件由**内容**判定，不是猜的：
//   · `config.test.mjs` —— "凡 env 名含 TOKEN/SECRET/KEY 必须 sensitive" 那条判据
//     在 `scripts/config/config.test.mjs:454`；`FOREIGN_DYNAMIC_SUBSCRIPTS` 也在它里面。
//   · `secrets.test.mjs` —— 台账写 "9 → 19 例"，而 `security/secrets/secrets.test.mjs`
//     实测正好 19 例（`product/secrets.test.mjs` 是 37 例，且锁/ttl 只有 1 处 vs 53 处）。
import { readFileSync, writeFileSync } from 'node:fs'

const F = 'D:/project/DSH/legion/docs/superpowers/prt/PRT-PROGRESS.md'
const orig = readFileSync(F, 'utf8')
const lines = orig.split('\n')

const PLAN = [
  { prt: 'PRT-254', from: '`config.test.mjs`', to: '`scripts/config/config.test.mjs`', times: 2 },
  { prt: 'PRT-254', from: '`secrets.test.mjs`', to: '`security/secrets/secrets.test.mjs`', times: 1 },
  { prt: 'PRT-413', from: '`config.test.mjs`', to: '`scripts/config/config.test.mjs`', times: 1 },
]

for (const p of PLAN) {
  const idx = lines.findIndex((l) => l.trim().startsWith(`| ${p.prt} `))
  if (idx === -1) throw new Error(`找不到 ${p.prt}`)
  const n = lines[idx].split(p.from).length - 1
  if (n !== p.times) throw new Error(`${p.prt} 里 \`${p.from}\` 出现 ${n} 次，期望 ${p.times}`)
  lines[idx] = lines[idx].split(p.from).join(p.to)
  console.log(`✓ ${p.prt} L${idx + 1}  ${p.from} → ${p.to}（${n} 处）`)
}

writeFileSync(F, lines.join('\n'), 'utf8')
console.log('\n写回完成。')
