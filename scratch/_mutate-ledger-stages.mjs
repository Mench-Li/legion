// scratch/_mutate-ledger-stages.mjs —— 变异：台账证据判据 + 阶段范围判据（**不提交**）
//
// ★ 这两个套件里有大量"造出来的输入"（正向/反向控制），所以变异要**分别**验证：
//   把规则关掉，那些控制用例必须变红。若关掉规则而套件仍绿 ⇒ 那条控制用例是**假的**。
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/project/DSH/legion'
const LEDGER_MOD = `${ROOT}/scripts/prt/ledger-evidence.mjs`
const STAGE_MOD = `${ROOT}/scripts/prt/stage-scope.mjs`
const LEDGER_LEDGER = `${ROOT}/docs/superpowers/prt/PRT-PROGRESS.md`

const ledgerOrig = readFileSync(LEDGER_MOD, 'utf8')
const stageOrig = readFileSync(STAGE_MOD, 'utf8')
const progressOrig = readFileSync(LEDGER_LEDGER, 'utf8')
let all = true

const suiteGreen = (which) => {
  const f = which === 'ledger' ? 'scripts/prt/ledger-evidence.test.mjs' : 'scripts/prt/stage-scope.test.mjs'
  try {
    return /ℹ fail 0/.test(execFileSync('node', ['--test', f], { cwd: ROOT, encoding: 'utf8' }))
  } catch (e) { return /ℹ fail 0/.test(String(e.stdout ?? '') + String(e.stderr ?? '')) }
}

function mut(name, find, repl, { which = 'ledger', file = null, original = null } = {}) {
  const target = file ?? (which === 'ledger' ? LEDGER_MOD : STAGE_MOD)
  const orig = original ?? (which === 'ledger' ? ledgerOrig : stageOrig)
  if (!orig.includes(find)) { console.log(`⚠ ${name}: 变异串没找到`); all = false; return }
  writeFileSync(target, orig.replace(find, repl), 'utf8')
  const g = suiteGreen(which)
  if (g) all = false
  console.log(`${g ? '✖ 漏网' : '✓ 咬住'} ${name}`)
  writeFileSync(target, orig, 'utf8')
}

try {
  // ── 台账证据判据 ──────────────────────────────────────────────────────
  mut('L1 关掉 R1（套件别名必须是一行 CI 套件）',
    '      if (!suiteFiles.has(s)) {', '      if (false) {')

  mut('L2 关掉 R2（带目录的用例路径必须存在）',
    '      if (!trackedSet.has(p)) {', '      if (false) {')

  mut('L3 关掉 R3 的**歧义**那一支（>1 个同名也算过）',
    '      } else if (hits.length > 1) {', '      } else if (false) {')

  mut('L4 R3 太严：0 个同名也报"歧义"（两种坏消息同形）',
    "        violations.push({\n          id: 'bare-test-missing',",
    "        violations.push({\n          id: 'bare-test-ambiguous',")

  mut('L5 R3 太严：唯一同名也报红（简写永远不合法）',
    '      if (hits.length === 0) {', '      if (hits.length >= 0) {')

  mut('L6 把非 ✅ 行也一起判（⏸/⬜ 的证据栏被卷进来）',
    "    if (r.status !== '\u2705') continue", "    if (r.status === '\u4e0d\u5b58\u5728\u7684\u72b6\u6001') continue")

  mut('L7 NAME_RE 放宽到允许空格（"tests 21 / pass 20"会被当成套件名）',
    'export const NAME_RE = /^[A-Za-z][\\w./-]*$/',
    'export const NAME_RE = /^[A-Za-z][\\w./ -]*$/')

  // ★★ L8 第一版是**假变异**：`cells.length < 3` → `< 2`。
  //    实测：`PRT-` 开头的 145 行里，**2 格的 0 条** ⇒ 两个条件行为完全相同，
  //    变异什么都没改。真正的把关者是"第一格以 PRT- 开头"与状态词表，
  //    所以改成**收窄状态词表**（丢掉 ⏸/⬜ 两行）——那才会改读数。
  mut('L8 状态词表收窄成只认 ✅（丢掉 ⏸/⬜ 两行，读数 145 会变）',
    "    if (!/^(\u2705|\ud83d\udfe1|\u23f8|\u2b1c)$/.test(cells[1])) continue",
    "    if (!/^(\u2705)$/.test(cells[1])) continue")

  // ── 阶段范围判据 ──────────────────────────────────────────────────────
  mut('S1 碰撞判定从"前缀"放宽成"包含"（表会长到没人读）',
    '      if (t.startsWith(s) || s.startsWith(t)) out.push({ stage: s, suite: t })',
    '      if (t.includes(s) || s.includes(t)) out.push({ stage: s, suite: t })', { which: 'stage' })

  mut('S2 未声明的碰撞不报（回到"没人写下来也过"）',
    '    if (declared === undefined) {', '    if (false) {', { which: 'stage' })

  mut('S3 过期声明不报（表会越长越假）',
    "      if (!seen.has(`${stage}\\u0000${suite}`)) {", '      if (false) {', { which: 'stage' })

  mut('S4 去掉"阶段名读到空就失败"的守卫',
    "    violations.push({ id: 'no-stages',", "    void ({ id: 'no-stages',", { which: 'stage' })

  // ★★ S5 第一版是**假变异**：我的替换串只是往 `Object.freeze({` 后面**加了一个键**，
  //    原来的 boundary/doc 条目一个都没动 ⇒ 表根本没被清空。
  //    改成把默认参数换成空表，那才是真的"什么都没声明"。
  mut('S5 默认声明表换成空表（真仓库立刻该红）',
    'export function checkStageScope({ stages, suites, table = DISAMBIGUATION }) {',
    'export function checkStageScope({ stages, suites, table = {} }) {', { which: 'stage' })

  mut('S6 阶段名解析放宽成任何 name 声明（把非阶段也收进来）',
    "  return [...new Set([...String(ciText).matchAll(/name:\\s*'([a-z][a-z0-9-]*)',\\s*label:/g)].map((m) => m[1]))]",
    "  return [...new Set([...String(ciText).matchAll(/name:\\s*'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]))]",
    { which: 'stage' })

  mut('S7 说明长度下限去掉（"记了一笔"也算声明）',
    '    } else if (typeof declared !== \'string\' || declared.length < 20) {', '    } else if (false) {',
    { which: 'stage' })

  // ── 台账文档侧：把修好的歧义裸名改回去（判据必须立刻红）────────────────
  mut('D1 台账里 `scripts/config/config.test.mjs` 改回裸名 `config.test.mjs`（第 35 轮修的那处）',
    '`scripts/config/config.test.mjs` **37 → 42 例**', '`config.test.mjs` **37 → 42 例**',
    { file: LEDGER_LEDGER, original: progressOrig })
} finally {
  writeFileSync(LEDGER_MOD, ledgerOrig, 'utf8')
  writeFileSync(STAGE_MOD, stageOrig, 'utf8')
  writeFileSync(LEDGER_LEDGER, progressOrig, 'utf8')
}

const ledgerBack = readFileSync(LEDGER_MOD, 'utf8') === ledgerOrig
const stageBack = readFileSync(STAGE_MOD, 'utf8') === stageOrig
const progBack = readFileSync(LEDGER_LEDGER, 'utf8') === progressOrig
console.log(`\n全部咬住 ? ${all}`)
console.log(`三处逐字还原 ? ${ledgerBack} ${stageBack} ${progBack}`)
console.log(`还原后两个套件都绿 ? ${suiteGreen('ledger')} ${suiteGreen('stage')}`)
