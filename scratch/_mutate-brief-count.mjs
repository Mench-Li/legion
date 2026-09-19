// scratch/_mutate-brief-count.mjs —— 变异：简报条数判据（**不提交**）
// ★ 文档侧两种变异形状很不同：改**数字**，和**把一行挪出表外**。后者才是当天那个真错。
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/project/DSH/legion'
const BRIEF = `${ROOT}/docs/DECISION-BRIEF.md`
const STATUS = `${ROOT}/docs/MULTI-AGENT-FEATURE-STATUS.md`
const MOD = `${ROOT}/scripts/prt/intervention-coverage.mjs`

const suiteGreen = () => {
  try { return /ℹ fail 0/.test(execFileSync('node', ['--test', 'scripts/prt/intervention-coverage.test.mjs'], { cwd: ROOT, encoding: 'utf8' })) }
  catch (e) { return /ℹ fail 0/.test(String(e.stdout ?? '') + String(e.stderr ?? '')) }
}

const briefOrig = readFileSync(BRIEF, 'utf8')
const statusOrig = readFileSync(STATUS, 'utf8')
const modOrig = readFileSync(MOD, 'utf8')
let all = true

function docMutation(name, file, orig, find, repl) {
  if (!orig.includes(find)) { console.log(`⚠ ${name}: 变异串没找到`); all = false; return }
  writeFileSync(file, orig.replace(find, repl), 'utf8')
  const g = suiteGreen()
  if (g) all = false
  console.log(`${g ? '✖ 漏网' : '✓ 咬住'} ${name}`)
  writeFileSync(file, orig, 'utf8')
}
function codeMutation(name, find, repl) {
  if (!modOrig.includes(find)) { console.log(`⚠ ${name}: 变异串没找到`); all = false; return }
  writeFileSync(MOD, modOrig.replace(find, repl), 'utf8')
  const g = suiteGreen()
  if (g) all = false
  console.log(`${g ? '✖ 漏网' : '✓ 咬住'} ${name}`)
  writeFileSync(MOD, modOrig, 'utf8')
}

try {
  // 文档侧
  docMutation('M1 简报把 29 写成 31（摘要与来源脱钩）', BRIEF, briefOrig, '**29 条**裁决项', '**31 条**裁决项')
  // ★★ 这一条才是当天那个真错：把第 29 条挪到空行之后 ⇒ 它掉到表外面
  docMutation('M2 ★★★ 在 §5 第 29 条**前面插一个空行**（把它挪出表格）',
    STATUS, statusOrig, '| 28 |', '\n| 28 |')
  // 更贴近原错：在第 29 条那一行前加空行
  docMutation('M2b ★★★ 直接在 `| 29 |` 前插空行（复现第 30 轮的原错）',
    STATUS, statusOrig, '\n| 29 | ★★ **`RunRequest.env`', '\n\n| 29 | ★★ **`RunRequest.env`')

  // 代码侧
  codeMutation('M3 去掉"简报声明的条数"核对', '    if (n !== numbers.length) {', '    if (false) {')
  codeMutation('M4 去掉"编号连续"核对', '  if (gaps.length !== 0) {', '  if (false) {')
  codeMutation('M5 去掉"简报一处都没声明也失败"守卫',
    "  if (stated.length === 0) {", '  if (false) {')
  codeMutation('M6 去掉"表头找不到也失败"守卫',
    "  if (!found) {", '  if (false) {')
} finally {
  writeFileSync(BRIEF, briefOrig, 'utf8')
  writeFileSync(STATUS, statusOrig, 'utf8')
  writeFileSync(MOD, modOrig, 'utf8')
}

console.log('\n全部咬住 ? ' + all)
console.log('三个文件都逐字还原 ? ' + (readFileSync(BRIEF, 'utf8') === briefOrig)
  + ' ' + (readFileSync(STATUS, 'utf8') === statusOrig) + ' ' + (readFileSync(MOD, 'utf8') === modOrig))
console.log('还原后套件全绿 ? ' + suiteGreen() + '（期望 true）')
