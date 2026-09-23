// 破坏性验证（churn 探针的窗口计数）：改 → 跑 → **无论如何还原**。
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const SRC = 'scripts/prt/hot-file-churn.mjs'
const TEST = 'scripts/prt/hot-file-churn.test.mjs'

const run = () => {
  let out = ''
  try {
    out = execFileSync(process.execPath, ['--test', TEST], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000,
    })
  } catch (e) { out = String(e.stdout ?? '') + String(e.stderr ?? '') }
  const f = /ℹ fail (\d+)/.exec(out)
  return { failed: f === null ? -1 : Number(f[1]) }
}

const MUTATIONS = [
  {
    id: '㉟ 回到第一版：`<oldest>^..<newest> -- <file>`（合并历史上会多算）',
    re: /const count = countWindowTouches\(slice, f, cwd\)/,
    to: "const count = git(['log', '--format=%h', `${slice[slice.length - 1]}^..${slice[0]}`, '--', f], cwd)\n        .split('\\n').filter(Boolean).length",
  },
  {
    id: '㊱ 回到第二版：`--no-walk --stdin -- <file>`（路径过滤被关掉，恒等于窗口大小）',
    re: /\['log', '--no-walk', '--format=%x1f%h', '--stdin', '--name-only'\]/,
    to: "['log', '--no-walk', '--format=%h', '--stdin', '--', file]",
  },
  {
    id: '㊲ 让 `countWindowTouches` 恒返回窗口大小（"满格条形图"那个假象）',
    re: /if \(lines\.slice\(1\)\.includes\(file\)\) n\+\+/,
    to: 'if (lines.length > 0) n++',
  },
  {
    id: '㊳ 路径用 `endsWith` 而不是精确相等（会算上 `x/team-hub/server.mjs`）',
    re: /if \(lines\.slice\(1\)\.includes\(file\)\) n\+\+/,
    to: 'if (lines.slice(1).some((l) => l.endsWith(file))) n++',
  },
]

const original = readFileSync(SRC, 'utf8')
let ok = 0
try {
  const base = run()
  console.log(`基线：fail=${base.failed}`)
  if (base.failed !== 0) throw new Error('基线不绿，先修基线')

  for (const m of MUTATIONS) {
    if (!m.re.test(original)) { console.log(`⚠ ${m.id}：锚点没找到，跳过`); continue }
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
process.exit(restored && ok === MUTATIONS.length ? 0 : 1)
