// scratch/_mutate-parse-output.mjs —— 变异：计数解析 + "用例名不许像摘要"守卫（**不提交**）
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/project/DSH/legion'
const MOD = `${ROOT}/scripts/ci/parse-suite-output.mjs`
const VICTIM = `${ROOT}/scripts/prt/stage-scope.test.mjs`
const orig = readFileSync(MOD, 'utf8')
const victimOrig = readFileSync(VICTIM, 'utf8')
let all = true

const green = () => {
  try {
    return /ℹ fail 0/.test(execFileSync('node', ['--test', 'scripts/ci/parse-suite-output.test.mjs'],
      { cwd: ROOT, encoding: 'utf8' }))
  } catch (e) { return /ℹ fail 0/.test(String(e.stdout ?? '') + String(e.stderr ?? '')) }
}

/** ★ 接线断言住在 `skip-visibility.test.mjs` 里——它读 run-ci 的**源码文本**。 */
const greenSkipVis = () => {
  try {
    return /ℹ fail 0/.test(execFileSync('node', ['--test', 'scripts/ci/skip-visibility.test.mjs'],
      { cwd: ROOT, encoding: 'utf8' }))
  } catch (e) { return /ℹ fail 0/.test(String(e.stdout ?? '') + String(e.stderr ?? '')) }
}

const RUNCI = `${ROOT}/scripts/ci/run-ci.mjs`
const runciOrig = readFileSync(RUNCI, 'utf8')

/** 变异 run-ci.mjs，用 skip-visibility 那一组来判它咬不咬。 */
function mutRunci(name, find, repl) {
  if (!runciOrig.includes(find)) { console.log(`⚠ ${name}: 变异串没找到`); all = false; return }
  writeFileSync(RUNCI, runciOrig.replace(find, repl), 'utf8')
  const g = greenSkipVis()
  if (g) all = false
  console.log(`${g ? '✖ 漏网' : '✓ 咬住'} ${name}`)
  writeFileSync(RUNCI, runciOrig, 'utf8')
}

// ★★ 注意这个签名：`file`/`original` 是**对象解构**。
//    第一版写成位置参数 `(name, find, repl, file = MOD, original = orig)`，
//    而 P6 传的是 `{ file: VICTIM, original: victimOrig }` ⇒ 那个对象整个落进了
//    `file`，`original` 仍是 `MOD` 的内容 ⇒ `orig.includes(find)` 永远为假
//    ⇒ P6 **静默什么都没变异**，报的是"变异串没找到"。
//    与 `_mutate-ledger-stages.mjs` 保持同一个形状。
function mut(name, find, repl, { file = MOD, original = orig } = {}) {
  const target = file
  if (!original.includes(find)) { console.log(`⚠ ${name}: 变异串没找到`); all = false; return }
  writeFileSync(target, original.replace(find, repl), 'utf8')
  const g = green()
  if (g) all = false
  console.log(`${g ? '✖ 漏网' : '✓ 咬住'} ${name}`)
  writeFileSync(target, original, 'utf8')
}

try {
  // 回到"取第一个匹配"——这就是第 35 轮那个 bug 本身
  mut('P1 回到取**第一个**匹配（第 35 轮的 bug 本身）',
    'return { first: all2.length === 0 ? NaN : all2[0], last: all2.length === 0 ? NaN : all2[all2.length - 1], count: all2.length }',
    'return { first: all2.length === 0 ? NaN : all2[0], last: all2.length === 0 ? NaN : all2[0], count: all2.length }')

  mut('P2 不报干扰（`spoofed` 恒空）',
    '    if (v.count > 1 && v.first !== v.last) spoofed.push(`${name}(${v.first}→${v.last})`)',
    '    if (false) spoofed.push(`${name}(${v.first}→${v.last})`)')

  mut('P3 干扰只活在对象里，不写进摘要行',
    "      ? ' ⚠计数被输出干扰:' + counts.spoofed.join(',') : '')", "      ? '' : '')")

  mut('P4 取不到时把 NaN 悄悄当 0（"看不见"那一课）',
    'return { tests: tests.last, pass: pass.last, fail: fail.last, skipped: skipped.last, spoofed }',
    'return { tests: tests.last | 0, pass: pass.last | 0, fail: fail.last | 0, skipped: skipped.last | 0, spoofed }')

  mut('P5 摘要行里 `skipped` 恒写 0（"看得见"变回假的）',
    "+ ' skipped=' + (Number.isNaN(counts.skipped) ? 0 : counts.skipped)",
    "+ ' skipped=0'")

  // ★ 守卫本身：往一个真套件的**用例名**里塞摘要形状的字样 ⇒ 必须红
  mut('P6 往 `stage-scope` 的一个用例名里塞 `tests 21 / pass 20`（守卫必须咬）',
    "test('② ★★★ 正向控制：未声明的碰撞",
    "test('② ★★★ tests 21 / pass 20 正向控制：未声明的碰撞",
    { file: VICTIM, original: victimOrig })
  // ★ 接线：搬走了不等于接上了（`skip-visibility` 新加的 ①b 负责咬这两条）
  mutRunci('P7 摘要行改回手写那几个数（不再调 `countsFragment`）',
    "' ' + countsFragment(counts)", "' tests=' + counts.tests + ' pass=' + counts.pass")
  mutRunci('P8 去掉 `parseSuiteCounts` 的 import（代码搬走了、没人调它）',
    "import { parseSuiteCounts, countsFragment } from './parse-suite-output.mjs'", '')
} finally {
  writeFileSync(MOD, orig, 'utf8')
  writeFileSync(VICTIM, victimOrig, 'utf8')
  writeFileSync(RUNCI, runciOrig, 'utf8')
}

console.log(`\n全部咬住 ? ${all}`)
console.log(`三处逐字还原 ? ${readFileSync(MOD, 'utf8') === orig} ${readFileSync(VICTIM, 'utf8') === victimOrig} ${readFileSync(RUNCI, 'utf8') === runciOrig}`)
console.log(`还原后套件仍绿 ? ${green()} ${greenSkipVis()}`)
