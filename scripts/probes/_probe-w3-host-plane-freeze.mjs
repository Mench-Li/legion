// scripts/probes/_probe-w3-host-plane-freeze.mjs
// ============================================================================
// §13.1 **W-3**（host 平面冻结的边界，2026-09-24）的**变异验证**。
//
// 冻结这件事有三个可以坏掉的半边，各喂一次变异：
//   ① **声明里加一行**（有人往 host 平面塞了一个新插件）⇒ 清单没动 ⇒ ⑯ 必须红；
//   ② **清单里删一个 id**（有人为了让它变绿而改清单）⇒ ⑯ 必须红；
//   ③ **清单里加一个越界 id**（不在 `legion-enforcement-` 命名空间里）⇒ ⑰ 必须红。
//
// ★ 只跑"清单"那两个方向的探针会漏掉棘轮的**主方向**：真正要拦的不是"清单被改坏"，
//   而是"**代码里多了一行而清单没人动**"。所以 ① 改的是 `patch-layer.mjs`。
// ★ ① 会连带让别的用例红（YAML 新鲜度等），所以三次都只跑 ⑯～⑲ 这四条
//   （`--test-name-pattern`），让"是哪一条咬住的"不含糊。
//
// 用法：node scripts/probes/_probe-w3-host-plane-freeze.mjs
// ============================================================================
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const SUITE = 'runtime/dsh-composition/composition.test.mjs'
const CODE = 'runtime/dsh-composition/patch-layer.mjs'
const MANIFEST = 'runtime/dsh-composition/host-plane.manifest.json'
const PATTERN = '⑯|⑰|⑱|⑲'
const CODE_ANCHOR = 'export const PATCH_LAYER_ROWS = Object.freeze(['
const FAKE_ROW = "  { id: 'legion-enforcement-probe-fake', plane: 'host', mount: { anchor: 'insert' }, module: '../probe-fake.mjs' },"

function runNew() {
  const r = spawnSync(process.execPath, ['--test', `--test-name-pattern=${PATTERN}`, SUITE], { encoding: 'utf8' })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  const p = /^ℹ pass (\d+)/m.exec(out)
  const f = /^ℹ fail (\d+)/m.exec(out)
  return { code: r.status, pass: p === null ? -1 : Number(p[1]), fail: f === null ? -1 : Number(f[1]) }
}

const code0 = readFileSync(CODE, 'utf8')
const man0 = readFileSync(MANIFEST, 'utf8')
if ((code0.split(CODE_ANCHOR).length - 1) !== 1) { console.log('  ✖ 代码锚点不唯一'); process.exit(1) }

console.log('基线（只跑 ⑯～⑲）：')
const base = runNew()
console.log(`  退出码 ${base.code} · pass ${base.pass} · fail ${base.fail}`)
if (base.code !== 0 || base.pass !== 4) { console.log('  ✖ 基线本应是 4 条全绿'); process.exit(1) }

let bad = 0
const restore = () => { writeFileSync(CODE, code0); writeFileSync(MANIFEST, man0) }
try {
  // ① 代码里加一行 host 行，清单不动
  writeFileSync(CODE, code0.replace(CODE_ANCHOR, `${CODE_ANCHOR}\n${FAKE_ROW}`))
  let r = runNew()
  let bit = r.code !== 0
  console.log('变异 ① 往 PATCH_LAYER_ROWS 加一行（清单没人动）：')
  console.log(`  退出码 ${r.code} · pass ${r.pass} · fail ${r.fail} · ${bit ? '✔ 咬住了' : '✖ 没咬住'}`)
  if (!bit) bad += 1
  restore()

  // ② 清单里删一个 id
  writeFileSync(MANIFEST, man0.replace('    "legion-enforcement-root",\n', ''))
  r = runNew()
  bit = r.code !== 0
  console.log('变异 ② 清单里删掉一个 id：')
  console.log(`  退出码 ${r.code} · pass ${r.pass} · fail ${r.fail} · ${bit ? '✔ 咬住了' : '✖ 没咬住'}`)
  if (!bit) bad += 1
  restore()

  // ③ 清单里加一个越界 id
  writeFileSync(MANIFEST, man0.replace('  "rows": [\n', '  "rows": [\n    "agent-preset-row",\n'))
  r = runNew()
  bit = r.code !== 0
  console.log('变异 ③ 清单里加一个不在 legion-enforcement- 命名空间里的 id：')
  console.log(`  退出码 ${r.code} · pass ${r.pass} · fail ${r.fail} · ${bit ? '✔ 咬住了' : '✖ 没咬住'}`)
  if (!bit) bad += 1
  restore()
} finally {
  restore()
}

const same = readFileSync(CODE, 'utf8') === code0 && readFileSync(MANIFEST, 'utf8') === man0
const back = runNew()
console.log('还原：')
console.log(`  两份文件逐字与变异前一致：${same ? '✔' : '✖'} · 退出码 ${back.code} · pass ${back.pass} · fail ${back.fail}`)
if (!same) bad += 1
if (back.code !== 0) bad += 1
console.log(bad === 0 ? '\n⇒ 三个方向都咬住，且两份文件已逐字还原。' : `\n⇒ 有 ${bad} 处不符合预期。`)
process.exit(bad === 0 ? 0 : 1)
