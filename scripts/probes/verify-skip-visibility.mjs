// 破坏性验证（跳过可见性这道门禁的判据）：改 → 跑 → **无论如何还原**。
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const SRC = 'scripts/ci/run-ci.mjs'
const TEST = 'scripts/ci/skip-visibility.test.mjs'

const run = () => {
  let out = ''
  try {
    out = execFileSync(process.execPath, ['--test', TEST], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
    })
  } catch (e) { out = String(e.stdout ?? '') + String(e.stderr ?? '') }
  const f = /ℹ fail (\d+)/.exec(out)
  return { failed: f === null ? -1 : Number(f[1]) }
}

const MUTATIONS = [
  {
    id: '㉚ `counts` 里删掉 skipped 的解析（回到"摘要说不出跳过了几条"）',
    re: /\n\s*skipped: num\(\/\\bskipped\\s\+\(\\d\+\)\/\),/,
    to: '',
  },
  {
    id: '㉛ detail 行里删掉 skipped=',
    re: /\n\s*\+ ' skipped=' \+ \(Number\.isNaN\(counts\.skipped\) \? 0 : counts\.skipped\)/,
    to: '',
  },
  {
    id: '㉜ 把 skipped 改成用减法反推（tests - pass - fail）',
    re: /skipped: num\(\/\\bskipped\\s\+\(\\d\+\)\/\)/,
    to: 'skipped: counts.tests - counts.pass - counts.fail',
  },
  {
    id: '㉝ summary.json 里删掉 skippedTotal',
    re: /failed, skippedTotal,/,
    to: 'failed,',
  },
  {
    id: '㉞ ★ 把跳过数塞进 `ok`（= 有跳过就判红，应当被 ⑤ 拦住）',
    re: /const ok = r\.code === 0 && \(Number\.isNaN\(counts\.fail\) \|\| counts\.fail === 0\)/,
    to: 'const ok = r.code === 0 && (Number.isNaN(counts.fail) || counts.fail === 0) && (Number.isNaN(counts.skipped) || counts.skipped === 0)',
  },
]

const original = readFileSync(SRC, 'utf8')
let ok = 0
try {
  const base = run()
  console.log(`基线：fail=${base.failed}`)
  if (base.failed !== 0) throw new Error('基线不绿，先修基线')

  for (const m of MUTATIONS) {
    const hits = [...original.matchAll(new RegExp(m.re.source, 'g'))].length + (m.re.source.includes('\n') ? 1 : 0)
    if (hits === 0) { console.log(`⚠ ${m.id}：锚点没找到，跳过`); continue }
    const mutated = original.replace(m.re, m.to)
    if (mutated === original) { console.log(`⚠ ${m.id}：替换无变化，跳过`); continue }
    writeFileSync(SRC, mutated)
    let r
    try { r = run() } finally { writeFileSync(SRC, original) }
    const bit = r.failed > 0
    if (bit) ok++
    console.log(`${bit ? '✔' : '✖'} ${m.id} → 实际 fail=${r.failed}`)
  }
} finally {
  if (readFileSync(SRC, 'utf8') !== original) { writeFileSync(SRC, original); console.log('已还原') }
}

const restored = readFileSync(SRC, 'utf8') === original
console.log(`\n破坏性验证：${ok}/${MUTATIONS.length} 条咬住；还原逐字节一致 = ${restored}`)
process.exit(restored ? 0 : 1)
