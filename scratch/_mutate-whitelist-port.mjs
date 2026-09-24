// 破坏性验证（破验）：每一条判据都必须能变红。
//
// 纪律（本仓既有）：**"全绿"不是证据**——一条从来没红过的判据，
// 与一条空判据，在摘要里长得一样。所以这里对被测模块做**具名变体**，
// 每一个变体都必须让某个套件变红；若某个变体下套件仍全绿，
// 说明那一条判据是空的（**同样是失败**）。
//
// 用法：node scratch/_mutate-whitelist-port.mjs
import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const MODULE = fileURLToPath(new URL('../runtime/dsh-composition/whitelist-port.mjs', import.meta.url))
const SUITE = fileURLToPath(new URL('../runtime/dsh-composition/whitelist-port.test.mjs', import.meta.url))
const BACKUP = `${MODULE}.mutbak`

/** 变体：一段源码 → 另一段。每个都对应一个**具体的**缺陷形态。 */
const MUTATIONS = [
  {
    id: 'M1-裁决态被当成失败（本轮真实踩过的坑）',
    from: "    if (translated.state !== 'unique' && translated.state !== 'decided') {",
    to: "    if (translated.state !== 'unique') {",
    expectRed: ['⑥'],
  },
  {
    id: 'M2-歧义时按"最宽的那个候选"猜（只读岗位就能按下 git-push 判）',
    from: '    const decided = isPlainObject(registry) ? registry[name] : undefined',
    to: '    const decided = isPlainObject(registry) ? (registry[name] ?? candidates[candidates.length - 1]) : candidates[candidates.length - 1]',
    expectRed: ['⑤', '⑥'],
  },
  {
    id: 'M3-把 DSH 名直接喂给判定器（不翻译 —— 第 21 轮量出来的洞）',
    from: '    const verdict = permitsTool({ permit: normalized, toolName: translated.legionTool })',
    to: '    const verdict = permitsTool({ permit: normalized, toolName: projection.toolName })',
    expectRed: ['③', '⑤', '⑥'],
  },
  {
    id: 'M4-裁决表值不校验：候选之外的值被接受（"看起来解决了歧义"）',
    from: "    if (typeof value !== 'string' || !cands.includes(value)) {",
    to: "    if (typeof value !== 'string') {",
    expectRed: ['④c'],
  },
  {
    id: 'M5-缺席退化成"永远放行"的函数（enforcementSurfaces().whitelist 会假绿）',
    from: '      port: null,\n      permit: null,\n      decisions: Object.freeze({}),',
    to: '      port: () => ({ allowed: true, rule: null, reason: null }),\n      permit: null,\n      decisions: Object.freeze({}),',
    expectRed: ['④'],
  },
  {
    // ★ 这一条守的是 `reverseRouting` 里那行 hosted 守卫。它对**真实**路由表
    //   不可观测（hosted 行的 dshTools 都是 null），所以判据用**合成表**把它逼出来。
    id: 'M6-hosted 守卫被删（宿主平面能力被猜出一个执行面名字）',
    from: '    if (route.hosted === true) continue',
    to: '    if (false) continue',
    expectRed: ['①b'],
  },
  {
    id: 'M7-候选不排序（读数取决于路由表书写顺序）',
    from: '  for (const [k, v] of back) back.set(k, Object.freeze([...v].sort()))',
    to: '  for (const [k, v] of back) back.set(k, Object.freeze([...v].reverse()))',
    expectRed: ['①'],
  },
]

function runSuite() {
  const r = spawnSync(process.execPath, ['--test', SUITE], { encoding: 'utf8' })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const failed = [...out.matchAll(/^✖ ([①②③④⑤⑥⑦⑧][^\n(]*)/gm)].map((m) => m[1].trim())
  const failCount = Number(/^ℹ fail (\d+)$/m.exec(out)?.[1] ?? '-1')
  return { code: r.status, out, failed, failCount }
}

copyFileSync(MODULE, BACKUP)
const original = readFileSync(MODULE, 'utf8')
const results = []
try {
  const baseline = runSuite()
  console.log(`基准（未变体）：exit=${baseline.code} fail=${baseline.failCount}`)
  if (baseline.code !== 0) {
    console.log('⚠ 基准不是绿的 —— 变体实验没有意义，先修基准。')
    process.exitCode = 1
  }
  for (const m of MUTATIONS) {
    if (!original.includes(m.from)) {
      results.push({ id: m.id, verdict: 'ANCHOR-MISSING', detail: `找不到锚点：${m.from.slice(0, 70)}` })
      console.log(`\n### ${m.id}\n  ✖ 锚点没命中 —— 变体没生效，这一格**测不了**（不是通过）`)
      continue
    }
    writeFileSync(MODULE, original.replace(m.from, m.to))
    const r = runSuite()
    writeFileSync(MODULE, original)
    const red = r.code !== 0
    // 命中的是哪几条判据（把变体期望的编号与实际红的编号对上）
    const hit = m.expectRed.filter((n) => r.failed.some((f) => f.startsWith(n)))
    const verdict = red ? (hit.length > 0 ? 'RED-AS-EXPECTED' : 'RED-ELSEWHERE') : 'STILL-GREEN'
    results.push({ id: m.id, verdict, detail: `exit=${r.code} fail=${r.failCount} 红=${JSON.stringify(r.failed.slice(0, 6))} 期望命中=${JSON.stringify(hit)}` })
    console.log(`\n### ${m.id}\n  ${red ? '✔ 变红了' : '✖ 仍然全绿 —— 这一族判据是空的'}  ${verdict}`)
    console.log(`  期望变红：${JSON.stringify(m.expectRed)}  实际命中：${JSON.stringify(hit)}`)
    console.log(`  红的判据：${JSON.stringify(r.failed.slice(0, 6))}`)
  }
} finally {
  writeFileSync(MODULE, original)
  try { unlinkSync(BACKUP) } catch {}
}

console.log('\n================ 汇总 ================')
for (const r of results) console.log(`${r.verdict.padEnd(18)} ${r.id}`)
const bad = results.filter((r) => r.verdict !== 'RED-AS-EXPECTED')
console.log(`\n变体 ${results.length} 个；按预期变红 ${results.length - bad.length} 个；不达标 ${bad.length} 个`)
if (bad.length > 0) process.exitCode = 1
