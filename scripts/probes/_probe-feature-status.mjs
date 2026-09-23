// scripts/probes/_probe-feature-status.mjs —— 第 45 轮续：**功能表**的状态词表有几处所有者？
//
// ★ 起因：`feature-table.mjs:59-74` 明写——
//
//     「状态词表（`✅/🟡/⬜/⏸` 加一种被许可的箭头写法）**已经有一个所有者**：
//      `scripts/prt/progress-check.test.mjs` 用例 ⑥」
//
//   那个所有者里的判据是（`feature-table.test.mjs:117-118` 逐字钉着它）：
//
//     const legend = ['✅', '🟡', '⬜', '⏸']
//     const okStatus = (s) => legend.includes(s) || /^[✅🟡⬜⏸]+→[✅🟡⬜⏸]+$/.test(s)
//
//   ★ 而 `scripts/prt/feature-evidence.mjs:49` **自己又写了一份**：
//
//     export const STATUS_RE = /^(?:✅|🟡|⏸|⬜|🟡→✅|⬜→🟡|✅→🟡)$/
//
//   两份**不是**同一个集合：所有者许可 **4×4 = 16** 种箭头写法，
//   而 `STATUS_RE` 只许可 **3** 种。
//
//   而 `feature-evidence.mjs:69` 的用法是：
//
//     if (!STATUS_RE.test(cells[2] ?? '')) continue     // ← 认不出就跳过
//
//   ⇒ **所有者明确许可的形状，在消费者这里会被静默丢掉**。
//
//   > 一个"词表归别人管"的声明，与一个"真的跟着那份词表走"的实现，
//   > 在今天**不会**露出差别——
//   > 只要今天那份文档里恰好只用到双方都认的那几种写法。
//
// ★ 本探针量三件事：
//   ① 两个集合各含哪些形状、差多少；
//   ② 真文档今天用到哪几种（决定差异是不是"只存在于理论上"）；
//   ③ 拿一个**所有者许可但消费者不认**的形状去喂 `featureRows`，看它是报错还是少一行。
import { readFileSync } from 'node:fs'

const R = (p) => `file:///D:/project/DSH/legion/${p}`
const { featureRows, STATUS_RE } = await import(R('scripts/prt/feature-evidence.mjs'))

// ── ① 所有者许可的集合（逐字复刻 `progress-check.test.mjs` 用例 ⑥ 里那条判据）──
const LEGEND = ['✅', '🟡', '⬜', '⏸']
const ownerOk = (s) => LEGEND.includes(s) || /^[✅🟡⬜⏸]+→[✅🟡⬜⏸]+$/.test(s)

const ALL_TERMINAL = [...LEGEND]
const ALL_ARROWS = []
for (const a of LEGEND) for (const b of LEGEND) ALL_ARROWS.push(`${a}→${b}`)

const ownerSet = [...ALL_TERMINAL, ...ALL_ARROWS].filter(ownerOk)
const consumerSet = [...ALL_TERMINAL, ...ALL_ARROWS].filter((s) => STATUS_RE.test(s))
const missing = ownerSet.filter((s) => !consumerSet.includes(s))

console.log('第 45 轮续探针：功能表状态词表 —— 所有者许可 vs 消费者认得\n')
console.log(`  所有者许可（逐字复刻用例 ⑥ 的判据）：${ownerSet.length} 种`)
console.log(`    ${ownerSet.join(' ')}`)
console.log(`\n  消费者 \`feature-evidence.STATUS_RE\` 认得：${consumerSet.length} 种`)
console.log(`    ${consumerSet.join(' ')}`)
console.log(`\n  ⇒ 所有者许可、消费者**不认**：**${missing.length}** 种`)
console.log(`    ${missing.join(' ')}`)

// ── ② 真文档今天用到哪几种 ──
const DOC = 'docs/MULTI-AGENT-FEATURE-STATUS.md'
const text = readFileSync(`D:/project/DSH/legion/${DOC}`, 'utf8')
const used = new Map()
for (const line of text.split(/\r?\n/)) {
  const m = /^\|\s*(F-\d+[^|]*?)\s*\|([^|]*)\|([^|]*)\|/.exec(line)
  if (m === null) continue
  const st = (m[3] ?? '').trim()
  if (st === '' || st === '状态' || /^-+$/.test(st)) continue
  used.set(st, (used.get(st) ?? 0) + 1)
}
console.log(`\n  ★ 真文档 \`${DOC}\` 今天用到的状态格：`)
for (const [s, n] of [...used.entries()].sort((a, b) => b[1] - a[1])) {
  const ownerSay = ownerOk(s) ? '所有者✔' : '所有者✖'
  const consSay = STATUS_RE.test(s) ? '消费者✔' : '消费者✖'
  console.log(`    ${s.padEnd(8)} ×${String(n).padEnd(4)} ${ownerSay}  ${consSay}`)
}
const usedButRejected = [...used.keys()].filter((s) => ownerOk(s) && !STATUS_RE.test(s))
console.log(`\n  ⇒ 真文档里"所有者许可但消费者不认"的格子：**${usedButRejected.length}** 种`
  + `${usedButRejected.length ? '（' + usedButRejected.join(' ') + '）' : '（差异目前只存在于理论上）'}`)

// ── ③ 拿一个消费者不认的形状去喂 featureRows：报错还是少一行？──
const head = [
  '# 对照表',
  '',
  '| 功能 | 名字 | 状态 | 说明 |',
  '| --- | --- | --- | --- |',
]
const mk = (st) => [...head, `| F-30 探针 | probe | ${st} | 说明 |`].join('\n')
const { mkdtempSync, writeFileSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')

console.log('\n  ③ 喂一个**所有者许可但消费者不认**的形状（🟡→⏸）：')
const p = join(mkdtempSync(join(tmpdir(), 'fs-')), 'd.md')
writeFileSync(p, mk('🟡→⏸'))
try {
  const rows = featureRows(p)
  console.log(`     featureRows ⇒ **${rows.length}** 行`
    + `${rows.length === 0 ? '  ✖ **静默丢掉**（所有者说这个形状是合法的）' : '  ✔ 收下了'}`)
} catch (e) {
  console.log(`     featureRows ⇒ threw —— ${String(e.message).slice(0, 90)}`)
}
console.log('\n  ③b 正对照（消费者认得的形状 ✅）：')
writeFileSync(p, mk('✅'))
console.log(`     featureRows ⇒ **${featureRows(p).length}** 行`)
