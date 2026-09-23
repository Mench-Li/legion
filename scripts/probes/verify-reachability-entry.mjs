// 破坏性验证（针对可达性探针的两处改动）：改 → 跑 → **无论如何还原**。
//
// 为什么不用 scripts/probes/mutate.mjs：那个 harness 的还原写在"跑完之后"，
// 于是任何中断（超时/被杀/Ctrl+C）都留下一个改过的源码文件，
// 而下一步的 `git add -A` 会把它收进索引（本会话真的发生过一次）。
// 这里用 try/finally，把"还原"从"跑完之后"改成"无论如何"。
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const FILES = {
  probe: 'scripts/prt/reachability.mjs',
  test: 'scripts/prt/reachability.test.mjs',
}

function runTests() {
  let out = ''
  try {
    out = execFileSync(process.execPath, ['--test', FILES.test], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
    })
  } catch (error) {
    out = String(error.stdout ?? '') + String(error.stderr ?? '')
  }
  const m = /ℹ fail (\d+)/.exec(out)
  const failed = m === null ? -1 : Number(m[1])
  const names = [...out.matchAll(/^✖ (.+?) \(/gm)].map((x) => x[1].trim())
  return { failed, names }
}

const MUTATIONS = [
  {
    id: '㉗ `scrum/serve.mjs` 从入口表里删掉（回到那处假阳性）',
    apply: (s) => s.replace(/\n  'scrum\/serve\.mjs',/, ''),
    expect: '①',
  },
  {
    id: '㉘ `scrum` 从 SCAN_DIRS 里删掉（整目录不扫）',
    apply: (s) => s.replace(/, 'packages', 'scrum',/, ", 'packages',"),
    expect: '①',
  },
]

const originals = new Map()
for (const f of Object.values(FILES)) originals.set(f, readFileSync(f, 'utf8'))

let ok = 0
try {
  const base = runTests()
  console.log(`基线：fail=${base.failed}`)
  if (base.failed !== 0) throw new Error('基线不是全绿，先修基线')

  for (const m of MUTATIONS) {
    const file = FILES.probe
    const before = originals.get(file)
    const after = m.apply(before)
    if (after === before) { console.log(`⚠ ${m.id}：锚点没找到，跳过`); continue }
    writeFileSync(file, after)
    let r
    try {
      r = runTests()
    } finally {
      writeFileSync(file, before)          // ★ 无论如何还原
    }
    const bit = r.failed > 0
    if (bit) ok++
    console.log(`${bit ? '✔' : '✖'} ${m.id}  → 期望 ${m.expect} 变红；实际 fail=${r.failed}`)
    for (const n of r.names.slice(0, 3)) console.log(`      ✖ ${n}`)
  }
} finally {
  for (const [f, s] of originals) {
    if (readFileSync(f, 'utf8') !== s) { writeFileSync(f, s); console.log(`已还原 ${f}`) }
  }
}

const restored = [...originals].every(([f, s]) => readFileSync(f, 'utf8') === s)
console.log(`\n破坏性验证：${ok}/${MUTATIONS.length} 条咬住；还原逐字节一致 = ${restored}`)
process.exit(ok === MUTATIONS.length && restored ? 0 : 1)
