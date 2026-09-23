// scripts/probes/_probe-landing-owner.mjs —— 第 48 轮：功能表**第四次**被人手写解析
//
// ★ 第 45 轮（词表）→ 46 轮（台账行）→ 47 轮（`parseStatusTable`）——
//   这一轮问的是：**同一张功能表还有没有第四个读者？**
//
//   有：`feature-landing-paths.parseLandingCells()`。它自己判行
//   （`FEATURE_ROW_RE`）、自己分格、**自己定格子数**（`≠5 且 ≠6 ⇒ continue`）、
//   自己取第 4 格当"代码落点"。
//
// ★★ 而后果比第 47 轮那次**更重**：这个模块的职责是
//   "功能表声明的代码落点必须指向**存在的文件**"。
//   一行被静默跳过 ⇒ **它声明的路径一个都不会被核**，
//   而门禁报的是"全部通过"。
//
//   > 一个"这一行我没看懂所以跳过"的默认动作，
//   > 与"这一行真的没问题"，在输出里都是"没有报错"。
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = 'D:/project/DSH/legion'
const { parseLandingCells, FEATURE_ROW_RE } = await import(`file://${ROOT}/scripts/prt/feature-landing-paths.mjs`)
const { featureRows } = await import(`file://${ROOT}/scripts/prt/feature-evidence.mjs`)
const { parseStatusTable } = await import(`file://${ROOT}/scripts/prt/spec-status-calibration.mjs`)

const DIR = mkdtempSync(join(tmpdir(), 'landing-'))
let seq = 0
const asFile = (t) => { const p = join(DIR, `t${seq++}.md`); writeFileSync(p, t); return p }

console.log('第 48 轮探针：功能表有几个解析器\n')

// ── 控制：这三条通路都真的在读内容 ──
{
  const ok = ['| 编号 | 名称 | 状态 | 代码落点 | 判据 | 还差什么 |',
    '|---|---|---|---|---|---|',
    '| F-01 甲 | a | ✅ | `scripts/prt/progress-check.mjs` | 证据 | — |', ''].join('\n')
  const [land, feat] = [parseLandingCells(ok).length, featureRows(asFile(ok)).length]
  if (land !== 1 || feat !== 1) {
    console.error(`  ✖✖ 控制失败：落点=${land} 行、所有者=${feat} 行 ⇒ 下面的读数全是假的`)
    process.exit(1)
  }
  console.log(`  ✔ 控制：合法单行表 —— 落点解析器 ${land} 行、所有者 ${feat} 行\n`)
}

// ── ① 真文档 ──
const real = readFileSync(`${ROOT}/docs/MULTI-AGENT-FEATURE-STATUS.md`, 'utf8')
const landRows = parseLandingCells(real)
const ownerRows = featureRows(`${ROOT}/docs/MULTI-AGENT-FEATURE-STATUS.md`)
console.log('① 真文档')
console.log(`  parseLandingCells ：${landRows.length} 行`)
console.log(`  featureRows       ：${ownerRows.length} 行`)
console.log(`  parseStatusTable  ：${[...parseStatusTable(real).values()].reduce((a, e) => a + e.rows.length, 0)} 行`)
const lset = new Set(landRows.map((r) => r.line))
const missing = ownerRows.filter((r) => !lset.has(r.line)).map((r) => r.line)
console.log(`  ⇒ 所有者读到、而落点解析器**没读到**的行：${missing.length === 0 ? '（无）' : missing.join(' ')}`)

// ── ② 格子数 ──
console.log('\n② 格子数不是 5 / 6 时（"它声明的落点一个都不会被核"）')
for (const [n, cells] of [
  [4, ['F-09 壬', 'r', '✅', '`scripts/prt/progress-check.mjs`']],
  [5, ['F-09 壬', 'r', '✅', '`scripts/prt/progress-check.mjs`', '证据']],
  [6, ['F-09 壬', 'r', '✅', '`scripts/prt/progress-check.mjs`', '证据', '—']],
  [7, ['F-09 壬', 'r', '✅', '`scripts/prt/progress-check.mjs`', '证据', '—', '附注']],
]) {
  const text = ['| 编号 | 名称 | 状态 | 代码落点 | 判据 | 还差什么 |',
    '|---|---|---|---|---|---|', `| ${cells.join(' | ')} |`, ''].join('\n')
  let feat
  try { feat = `${featureRows(asFile(text)).length} 行` } catch (e) { feat = '抛' }
  console.log(`  ${n} 格：落点解析器 ${parseLandingCells(text).length} 行 ※（0 = **静默跳过**）`
    + `  ｜  所有者 ${feat}`)
}
rmSync(DIR, { recursive: true, force: true })

console.log('\n  ⇒ ★ 4 格与 7 格的行，**落点列完全不检查**，而输出里没有任何东西说"有行被跳过"。')
console.log('     `FEATURE_ROW_RE` 也只认 `F-` 开头，**连"这一行是不是状态行"都不问**。')
console.log(`     （该常量就在 feature-landing-paths.mjs L54：${FEATURE_ROW_RE}）`)
