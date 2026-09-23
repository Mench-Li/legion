// 破坏性验证（argv 段顺序的两条不变式 + app 段齐全）：改 → 跑 → **无论如何还原**。
//
// ★ 两个套件都要跑：`dsh-overlay` 覆盖的是 `runtimeCommand` 那条分支，
//   `process-manifest` 覆盖的是 `node-file` 那条分支与 app 段的齐全性。
//   只跑一个的话，锚在另一个分支上的变异会报"没咬住"，而那不是用例的问题、
//   是**验证脚本选错了靶场**。
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const SRC = 'product/process-manifest.mjs'
const SUITES = ['product/launcher/dsh-overlay.test.mjs', 'product/process-manifest.test.mjs']
const ENV = { ...process.env, DSH_CHECKOUT: 'D:/project/DSH/dsh/deepseek-harness' }

const run = () => {
  let out = ''
  try {
    out = execFileSync(process.execPath, ['--test', ...SUITES], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000, env: ENV,
    })
  } catch (e) { out = String(e.stdout ?? '') + String(e.stderr ?? '') }
  const f = /ℹ fail (\d+)/.exec(out)
  return { failed: f === null ? -1 : Number(f[1]), out }
}

const MUTATIONS = [
  {
    id: '㊴ `runtimeCommand` 分支：`valueArgs` 挪到 `extras` 之前（`--patch` 掉进 app 段）',
    re: /args: Object\.freeze\(\[\.\.\.configured\.args, \.\.\.args, \.\.\.extras, \.\.\.effectiveValueArgs, \.\.\.effectiveBoolArgs\]\)/,
    to: 'args: Object.freeze([...configured.args, ...args, ...effectiveValueArgs, ...extras, ...effectiveBoolArgs])',
  },
  {
    id: '㊵ `node-file` 分支：`appArgs` 挪到 `extras` 之前',
    re: /Object\.freeze\(\[entryAbs, \.\.\.args, \.\.\.extras, \.\.\.appArgs\]\)/,
    to: 'Object.freeze([entryAbs, ...args, ...appArgs, ...extras])',
  },
  {
    id: '㊶ `effectiveBoolArgs` 恒为空（app 段里少了 `--no-open`）',
    re: /const effectiveBoolArgs = boolArgs\.filter\(\(flag\) => !configured\.args\.includes\(flag\)\)/,
    to: 'const effectiveBoolArgs = []',
  },
  {
    id: '㊷ `portArgv` 从清单里删掉（端口回不到 DSH）',
    re: /    portArgv: Object\.freeze\(\['--port'\]\),\r?\n/,
    to: '',
  },
]

const original = readFileSync(SRC, 'utf8')
let ok = 0
try {
  const base = run()
  console.log(`基线（两个套件一起）：fail=${base.failed}`)
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
    console.log(`${bit ? '✔' : '✖'} ${m.id} → fail=${r.failed}`)
  }
} finally {
  if (readFileSync(SRC, 'utf8') !== original) { writeFileSync(SRC, original); console.log('已还原') }
}

const restored = readFileSync(SRC, 'utf8') === original
console.log(`\n破坏性验证：${ok}/${MUTATIONS.length} 条咬住；还原逐字节一致 = ${restored}`)
process.exit(restored && ok === MUTATIONS.length ? 0 : 1)
