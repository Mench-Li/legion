// scratch/_mutate-boundaries.mjs —— 变异：§2 那 5 条「不可突破的边界」的判据（第 38 轮）（**不提交**）
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/project/DSH/legion'
const MOD = `${ROOT}/scripts/prt/design-boundaries.mjs`
const SPEC = `${ROOT}/docs/MULTI-AGENT-FEATURE-OPTIMIZATION.md`
// ★ M10 用：一个真实的编排层文件——往它里面塞一处 `agentLoop`，边界判据**必须**红
const VICTIM = `${ROOT}/orchestrator/worker/run.mjs`
const TEST = 'scripts/prt/design-boundaries.test.mjs'

const orig = readFileSync(MOD, 'utf8')
const specOrig = readFileSync(SPEC, 'utf8')
const victimOrig = readFileSync(VICTIM, 'utf8')
let all = true

/** ★ 每次都在**新进程**里跑（模块级缓存与状态不会串）。 */
const green = () => {
  try {
    return /ℹ fail 0/.test(execFileSync('node', ['--test', TEST], { cwd: ROOT, encoding: 'utf8' }))
  } catch (e) { return /ℹ fail 0/.test(String(e.stdout ?? '') + String(e.stderr ?? '')) }
}

function mut(name, find, repl) {
  if (!orig.includes(find)) { console.log(`⚠ ${name}: 变异串没找到`); all = false; return }
  writeFileSync(MOD, orig.replace(find, repl), 'utf8')
  const g = green()
  if (g) all = false
  console.log(`${g ? '✖ 漏网' : '✓ 咬住'} ${name}`)
  writeFileSync(MOD, orig, 'utf8')
}

try {
  mut('M1 去掉"判据扫了 0 个文件"的空转守卫（**这一轮的真事**）',
    '      if (!(r.scanned > 0)) {', '      if (false) {')

  mut('M2 去掉"一条边界没人认领"的判定',
    "        id: 'boundary-unowned',", "        id: '__disabled_unowned',")

  mut('M3 去掉"声明过期"的判定',
    "        id: 'stale-declaration',", "        id: '__disabled_stale',")

  mut('M4 去掉"声称有判据而判据解析不到"的判定',
    "          id: 'check-missing',", "          id: '__disabled_missing',")

  mut('M5 去掉"边界被破了"的比对（期望 vs 实测不再比）',
    "      if (JSON.stringify(got) !== JSON.stringify(want)) {", '      if (false) {')

  mut('M6 设计档不再要求写出"为什么没有机械形状"',
    "      if (why.trim().length < 20) {", '      if (false) {')

  mut('M7 `kind` 不再校验',
    "      violations.push({ id: 'bad-kind'", "      void ({ id: 'bad-kind'")

  mut('M8 锚取不到时改为报绿（"什么都没查"变成绿的）',
    "    return { ok: false, violations, reading: { boundaries: 0, declarations: declarations.length, mechanical: 0 } }\n  }\n  if (boundaries.length === 0) {",
    "    return { ok: true, violations, reading: { boundaries: 0, declarations: declarations.length, mechanical: 0 } }\n  }\n  if (boundaries.length === 0) {")

  mut('M9 锚解析取不到时返回 `[]` 而不是 `null`（"没找到那一节"混成"没有边界"）',
    '  if (line === undefined) return null', '  if (line === undefined) return []')
} finally {
  writeFileSync(MOD, orig, 'utf8')
}

// ★★★ M10：**往真实产品代码里塞一处真的越界**，边界判据必须当场红。
//   这一条与上面九条不同：上面改的是**判据**，这一条改的是**被判据看着的世界**。
try {
  writeFileSync(VICTIM, victimOrig + '\n// 越界注入：自己起一套 agentLoop（第 38 轮变异验证）\nexport const agentLoop = null\n', 'utf8')
  const g = green()
  if (g) all = false
  console.log(`${g ? '✖ 漏网' : '✓ 咬住'} M10 往 orchestrator/worker/run.mjs 塞一处真的 ` + '`agentLoop`（**边界被破，判据必须红**）')
} finally { writeFileSync(VICTIM, victimOrig, 'utf8') }

// ★★ M11：改**真文档**，删掉 §2 那一条边界 ⇒ 声明立刻过期，必须红。
try {
  const line = specOrig.split('\n').find((l) => l.includes('不可突破的边界：'))
  if (line === undefined) { console.log('⚠ M11: 找不到那一段'); all = false }
  else {
    writeFileSync(SPEC, specOrig.replace(line, line.replace('；不把 worktree 当安全沙箱', '')), 'utf8')
    const g = green()
    if (g) all = false
    console.log(`${g ? '✖ 漏网' : '✓ 咬住'} M11 改真文档：从 §2 删掉「不把 worktree 当安全沙箱」（声明必须立刻过期）`)
  }
} finally { writeFileSync(SPEC, specOrig, 'utf8') }

console.log(`\n全部咬住 ? ${all}`)
console.log(`判据逐字还原 ? ${readFileSync(MOD, 'utf8') === orig}`)
console.log(`文档逐字还原 ? ${readFileSync(SPEC, 'utf8') === specOrig}`)
console.log(`被注入的文件逐字还原 ? ${readFileSync(VICTIM, 'utf8') === victimOrig}`)
console.log(`还原后判据仍绿 ? ${green()}`)
