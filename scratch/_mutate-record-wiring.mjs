// scratch/_mutate-record-wiring.mjs —— 变异：RunRecord 的接线门禁（第 40 轮）（**不提交**）
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/project/DSH/legion'
const MOD = `${ROOT}/product/launcher/run-record.mjs`
const TEST = 'product/launcher/run-record.test.mjs'
const orig = readFileSync(MOD, 'utf8')
let all = true

const green = () => {
  try {
    return /ℹ fail 0/.test(execFileSync('node', ['--test', TEST], { cwd: ROOT, encoding: 'utf8' }))
  } catch (e) { return /ℹ fail 0/.test(String(e.stdout ?? '') + String(e.stderr ?? '')) }
}

// ★★ 换行无关（本文件是 CRLF，第一版用裸 `\n` 去找 ⇒ 四条多行变异全部"没找到"）。
//
//   > 一个"变异串没找到"的告警，与一个"变异被咬住"，
//   > 在"这一轮到底测到了什么"这个读数上是**同一个东西**：
//   > 都是"没有漏网"——只不过前者什么都没测。
const CRLF = orig.includes('\r\n')
const toRe = (s) => new RegExp(
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\n/g, '\\r?\\n'))
const toFile = (s) => (CRLF ? s.replace(/\n/g, '\r\n') : s)

function mut(name, find, repl) {
  if (find === repl) { console.log(`⚠ ${name}: 假变异体（find === repl，两版行为相同）`); all = false; return }
  const re = toRe(find)
  if (!re.test(orig)) { console.log(`⚠ ${name}: 变异串没找到`); all = false; return }
  writeFileSync(MOD, orig.replace(re, toFile(repl)), 'utf8')
  const g = green()
  if (g) all = false
  console.log(`${g ? '✖ 漏网' : '✓ 咬住'} ${name}`)
  writeFileSync(MOD, orig, 'utf8')
}

try {
  // ── 一类：退回"手写名字"（这正是本轮修掉的那个形状）──
  mut('M1 ★★★ buildRunRecord 退回**手写** peakResource（声明表再次没有消费者）',
    `      const row = {}
      for (const f of requiredFields) row[f] = requiredReaders[f](p)
      for (const f of optionalFields) {`,
    `      const row = {}
      for (const f of requiredFields) row[f] = requiredReaders[f](p)
      for (const f of ['peakResource']) {`)

  mut('M2 ★★★ validateRunRecord 退回**手写** peakResource（新字段静默不校验）',
    '      for (const f of optionalFields) {\n        if (!(f in p) || p[f] === null || p[f] === undefined) continue',
    "      for (const f of ['peakResource']) {\n        if (!(f in p) || p[f] === null || p[f] === undefined) continue")

  // ── 二类：把"具名上抛"退回"静默跳过" ──
  mut('M3 ★★★ 未登记的声明**静默跳过**（回到修复前那种"不报错、也不出现"）',
    `  if (unwired.length > 0) {`,
    `  if (false) {`)

  mut('M4 上抛的错误码换成别的（消费方按 code 分支时抓不到）',
    "    err.code = RUN_RECORD_CODES.FIELD_NOT_WIRED", "    err.code = 'SOMETHING_ELSE'")

  // ── 三类：门禁自己的四个方向各瞎一个 ──
  mut('M5 `recordWiring` 不再查"声明了没登记取法"（门禁自己变瞎）',
    "  const missingOptionalReader = optionalFields.filter((f) => typeof optionalReaders[f] !== 'function')",
    '  const missingOptionalReader = []')

  mut('M6 `recordWiring` 不再查"登记了没声明"（另一个方向的静默）',
    '  const undeclared = [...Object.keys(requiredReaders), ...Object.keys(optionalReaders)]\n    .filter((f) => !requiredFields.includes(f) && !optionalFields.includes(f))',
    '  const undeclared = []')

  mut('M7 `ok` 恒为 true（门禁永远说"对得上"）',
    "    ok: missingReader.length + missingOptionalReader.length\n      + missingValidator.length + undeclared.length === 0,",
    '    ok: true,')

  // ── 四类：可选字段漏掉校验器 ──
  // ★ 第一版写的是"给调用加一个 `typeof === 'function'` 判断"——那是个**假变异体**：
  //   生产里那个校验器**就是**函数，所以两个版本行为完全相同，
  //   而"没咬住"会被误读成"判据漏网"。改成真的不调用。
  mut('M8 可选字段的校验器**根本不被调用**（"在了但是坏的"被放行）',
    '        optionalValidators[f](p[f], `processes[${i}]`, problems)',
    '        continue')

  // ── 反向控制：不许把"旧记录必须放行"改坏 ──
  mut('M9 ★★ 把 peakResource 加进**必填**表（旧记录会被判死、孤儿进程清不掉）',
    "export const RUN_RECORD_OPTIONAL_FIELDS = Object.freeze(['peakResource'])",
    "export const RUN_RECORD_OPTIONAL_FIELDS = Object.freeze([])")
} finally {
  writeFileSync(MOD, orig, 'utf8')
}

console.log(`\n全部咬住 ? ${all}`)
console.log(`逐字还原 ? ${readFileSync(MOD, 'utf8') === orig}`)
console.log(`还原后判据仍绿 ? ${green()}`)
