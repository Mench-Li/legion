// scripts/probes/_probe-ruling22-naming-convention.mjs
// ============================================================================
// §5 第 22 条（2026-09-24 裁决采 ①「声明写**裸名**」）的**变异验证**。
//
// 约定的一半是**写下来的**（JSDoc + 文档），另一半是**钉住的**：
// "同一份声明里既写裸名、又写它的公开名 ⇒ 装配期就拒"。
// 后者才是会随代码漂的那一半 —— 所以这里把那个检查关掉，看 ①g 红不红。
//
// 用法：node scripts/probes/_probe-ruling22-naming-convention.mjs
// ============================================================================
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const MODULE = 'runtime/connectors/registry.mjs'
const SUITE = 'runtime/connectors/registry.test.mjs'
const ANCHOR = '  if (collide.length > 0) {'

function runSuite() {
  const r = spawnSync(process.execPath, ['--test', SUITE], { encoding: 'utf8' })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  const p = /^ℹ pass (\d+)/m.exec(out)
  const f = /^ℹ fail (\d+)/m.exec(out)
  return { code: r.status, pass: p === null ? -1 : Number(p[1]), fail: f === null ? -1 : Number(f[1]) }
}

const original = readFileSync(MODULE, 'utf8')
if ((original.split(ANCHOR).length - 1) !== 1) {
  console.log('  ✖ 锚点不是恰好一处 —— 实现改过了，先修这个探针')
  process.exit(1)
}

console.log('基线：')
const base = runSuite()
console.log(`  退出码 ${base.code} · pass ${base.pass} · fail ${base.fail}`)
if (base.code !== 0) { console.log('  ✖ 基线本应是绿的'); process.exit(1) }

let bad = 0
try {
  writeFileSync(MODULE, original.replace(ANCHOR, '  if (false) {'))
  const r = runSuite()
  const bit = r.code !== 0
  console.log('变异 ① 推导名撞车检查被关掉：')
  console.log(`  退出码 ${r.code} · pass ${r.pass} · fail ${r.fail} · ${bit ? '✔ 咬住了' : '✖ 没咬住'}`)
  if (!bit) bad += 1
  writeFileSync(MODULE, original)
} finally {
  writeFileSync(MODULE, original)
}

const after = readFileSync(MODULE, 'utf8')
const back = runSuite()
console.log('还原：')
console.log(`  逐字与变异前一致：${after === original ? '✔' : '✖'} · 退出码 ${back.code} · pass ${back.pass} · fail ${back.fail}`)
if (after !== original) bad += 1
if (back.code !== 0) bad += 1
console.log(bad === 0 ? '\n⇒ 咬住了，且文件已逐字还原。' : `\n⇒ 有 ${bad} 处不符合预期。`)
process.exit(bad === 0 ? 0 : 1)
