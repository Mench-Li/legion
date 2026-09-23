// scripts/probes/_probe-status-table-owner.mjs —— 第 47 轮：功能对照表**有几个解析器**
//
// ★ 第 45 轮我把"功能表状态词表"收敛到 `progress-check.mjs` 一处，
//   并让 `feature-evidence.featureRows()` **认不出就抛**。
//
//   **但同一张表还有别的读者。** `spec-status-calibration.parseStatusTable()`
//   自己：判行（`/^\|\s*F-\d+/`）、分格、**自己定格子数**（`≠5 且 ≠6 ⇒ continue`）、
//   再用 `endState(cells[2])` 取状态。
//
// ★ 而它的 `aggregate` 规则是：
//     全部 === '✅' ⇒ ✅ ／ 全部 startsWith '⏸' ⇒ ⏸ ／ **其余 ⇒ 🟡**
//
//   ⇒ 一个**认不出的**状态会安静地落进"其余" ⇒ 被当成 **🟡（部分）**。
//
//   > 一个"认不出就算部分完成"的默认值，与一份"真的有一部分没做完"的表，
//   > 在汇总里是同一个读数——
//   > 只不过前者会把**读不出来的东西**报成一个**看起来需要关注**的数。
//
// ★ 量三件事：
//   ① 真文档：两个解析器对同一张表读出的是不是同一批行？
//   ② 合成表里放一个第 5 个状态标记 ⇒ 两边各怎么办？
//   ③ 格子数不是 5/6 时，`parseStatusTable` 会怎么办？
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = 'D:/project/DSH/legion'
const { parseStatusTable } = await import(`file://${ROOT}/scripts/prt/spec-status-calibration.mjs`)
const { featureRows } = await import(`file://${ROOT}/scripts/prt/feature-evidence.mjs`)

const DOC = `${ROOT}/docs/MULTI-AGENT-FEATURE-STATUS.md`
const real = readFileSync(DOC, 'utf8')

// ★★★ 纪律（本次差点自己踩）：`featureRows(path)` 收的是**路径**，不是文本。
//   我第一版把**表格文本**直接传了进去 ⇒ 每一个 `featureRows` 读数都是
//   `ENAMETOOLONG / ENOENT` 的"抛"，而它**看起来**恰好等于"它 fail closed ✔"。
//
//   > 一个"因为参数传错而抛"的读数，与一个"因为内容非法而抛"的读数，
//   > 在 `try/catch` 的 `e.message` 被截断到 40 个字符之后，是同一个东西。
const DIR = mkdtempSync(join(tmpdir(), 'ftable-'))
let seq = 0
/** 把一段表格文本落成临时文件，返回路径（`featureRows` 需要路径）。 */
const asFile = (text) => {
  const p = join(DIR, `t${seq++}.md`)
  writeFileSync(p, text)
  return p
}
/** 统一读数：文本 → 一行描述（不管它是抛还是收）。 */
const readFeature = (text) => {
  try { return `收下 ${featureRows(asFile(text)).length} 行` } catch (e) { return '抛：' + e.message.slice(0, 46) }
}
/** 控制：这条读数**真的**是在读内容，而不是在读"文件在不在"。 */
{
  const ctl = readFeature('| 编号 | 功能 | 状态 | 阶段 | 备注 |\n| --- | --- | --- | --- | --- |\n| F-01 甲 | a | ✅ | P0 | `x.mjs` |')
  if (!ctl.startsWith('收下 1 行')) {
    console.error(`  ✖✖ 控制失败：合法表读成「${ctl}」 ⇒ 本探针的 featureRows 读数全是假的`)
    process.exit(1)
  }
  console.log(`  ✔ 控制：合法单行表读作「${ctl}」（说明这条通路真的在读内容）\n`)
}

console.log('第 47 轮探针：功能对照表有几个解析器\n')

// ── ① 真文档 ──
let featRows
try { featRows = featureRows(DOC) } catch (e) { featRows = `抛：${e.message.slice(0, 80)}` }
const m = parseStatusTable(real)
const fromCal = [...m.keys()].sort()
const fromFeat = Array.isArray(featRows)
  ? [...new Set(featRows.map((r) => r.id))].sort() : []

console.log('① 真文档')
console.log(`  featureRows(path)      ：${Array.isArray(featRows) ? featRows.length : featRows} 行`)
console.log(`  parseStatusTable()     ：${fromCal.length} 个 F-NN，${[...m.values()].reduce((a, e) => a + e.rows.length, 0)} 行`)
const onlyCal = fromCal.filter((k) => !fromFeat.includes(k))
const onlyFeat = fromFeat.filter((k) => !fromCal.includes(k))
console.log(`  ⇒ 只有 parseStatusTable 读到的：${onlyCal.length === 0 ? '（无）' : onlyCal.join(' ')}`)
console.log(`  ⇒ 只有 featureRows 读到的：     ${onlyFeat.length === 0 ? '（无）' : onlyFeat.join(' ')}`)

// ── ② 合成表：第 5 个状态标记 ──
const SYNTH = [
  '| 编号 | 功能 | 状态 | 阶段 | 备注 |',
  '| --- | --- | --- | --- | --- |',
  '| F-01 甲 | a | ✅ | P0 | `x.mjs` |',
  '| F-02 乙 | b | 🔵 | P0 | `y.mjs` |',
].join('\n')

/** 统一读数：文本 → 一行描述（`parseStatusTable` 认不出时会抛）。 */
const readStatus = (text) => {
  try {
    const m = parseStatusTable(text)
    const keys = [...m.keys()].sort()
    return keys.length === 0
      ? '**静默跳过**（0 个 F-NN）◆'
      : `收下 ${keys.length} 个 F-NN（${keys.map((k) => `${k}=${m.get(k).aggregate}`).join(' ')}）`
  } catch (e) { return '抛：' + e.message.slice(0, 46) }
}

console.log('\n② 合成表里放一个第 5 个状态标记 🔵（F-02）')
console.log(`  parseStatusTable       ：${readStatus(SYNTH)}`)
console.log(`  featureRows            ：${readFeature(SYNTH)}`)
console.log('  ⇒ 修好之后两边都必须**抛**（不再有"认不出 ⇒ 🟡"这一支）。')

// ── ③ 格子数 ──
console.log('\n③ 格子数不是 5 / 6 时（旧规则 `≠5 且 ≠6 ⇒ continue`）')
for (const [n, row] of [
  [4, '| F-03 丙 | c | ✅ | P0 |'],
  [5, '| F-03 丙 | c | ✅ | P0 | `z.mjs` |'],
  [6, '| F-03 丙 | c | ✅ | P0 | `z.mjs` | 附注 |'],
  [7, '| F-03 丙 | c | ✅ | P0 | `z.mjs` | 附注 | 又一段 |'],
]) {
  const text = ['| 编号 | 功能 | 状态 | 阶段 | 备注 |', '| --- | --- | --- | --- | --- |', row].join('\n')
  console.log(`  ${n} 格：parseStatusTable ${readStatus(text)}  ｜  featureRows：${readFeature(text)}`)
}
rmSync(DIR, { recursive: true, force: true })
console.log('\n  ⇒ ★ 修好之前：4 格与 7 格被 `parseStatusTable` **静默跳过**，而所有者收下；')
console.log('     同一个文件里的 `parseCalibration()` 用的却是 `< 4` ——')
console.log('     同一张表、同一个文件、**两条不同的接受规则**。')
