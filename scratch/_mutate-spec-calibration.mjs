// scratch/_mutate-spec-calibration.mjs —— 变异：文档侧（两份文档都要打）+ 代码侧（**不提交**）
//
// ★ 这条判据的输入是**两份文档**，所以文档侧有两个方向：
//   · 打**规格文档**（拿掉校准表 / 改校准表里的状态）
//   · 打**状态表**（把某个功能退回 🟡 ⇒ 校准表应立刻过期）
//   只打一边会漏掉"另一边的漂移没人发现"。
// ★ 每次都在新进程里跑（ESM 缓存会让同进程内的变异"看起来没生效"）。
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/project/DSH/legion'
const SPEC = `${ROOT}/docs/MULTI-AGENT-FEATURE-OPTIMIZATION.md`
const STATUS = `${ROOT}/docs/MULTI-AGENT-FEATURE-STATUS.md`
const MOD = `${ROOT}/scripts/prt/spec-status-calibration.mjs`

const gate = () => {
  try {
    return { code: 0, out: execFileSync('node', ['scripts/prt/spec-status-calibration.mjs'],
      { cwd: ROOT, encoding: 'utf8' }) }
  } catch (e) { return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') } }
}
const suiteGreen = () => {
  try {
    const out = execFileSync('node', ['--test', 'scripts/prt/spec-status-calibration.test.mjs'],
      { cwd: ROOT, encoding: 'utf8' })
    return /ℹ fail 0/.test(out)
  } catch (e) {
    const out = String(e.stdout ?? '') + String(e.stderr ?? '')
    return /ℹ fail 0/.test(out)
  }
}

const specOrig = readFileSync(SPEC, 'utf8')
const statusOrig = readFileSync(STATUS, 'utf8')
const modOrig = readFileSync(MOD, 'utf8')
let all = true

function fileMutation(name, file, orig, find, repl, wantId) {
  if (!orig.includes(find)) { console.log(`⚠ ${name}: 变异串没找到`); all = false; return }
  writeFileSync(file, orig.replace(find, repl), 'utf8')
  const v = gate()
  const caught = v.code !== 0 && (wantId === undefined || v.out.includes(wantId))
  if (!caught) all = false
  console.log(`${caught ? '✓ 咬住' : '✖ 漏网'} ${name}  (exit=${v.code}${wantId ? `，点名 ${wantId} ? ${v.out.includes(wantId)}` : ''})`)
  writeFileSync(file, orig, 'utf8')
}
function codeMutation(name, find, repl) {
  if (!modOrig.includes(find)) { console.log(`⚠ ${name}: 变异串没找到`); all = false; return }
  writeFileSync(MOD, modOrig.replace(find, repl), 'utf8')
  const g = suiteGreen()
  if (g) all = false
  console.log(`${g ? '✖ 漏网' : '✓ 咬住'} ${name}  (套件全绿=${g}，期望 false)`)
  writeFileSync(MOD, modOrig, 'utf8')
}

try {
  // ── 文档侧 A：把 §1.2 整节拿掉（回到第 29 轮之前的样子）
  const calibStart = specOrig.indexOf('## 1.2 状态注记校准')
  const nextSec = specOrig.indexOf('\n## 2. 架构基线', calibStart)
  if (calibStart === -1 || nextSec === -1) { console.log('⚠ 找不到 §1.2 的边界'); all = false }
  else {
    const removed = specOrig.slice(0, calibStart) + specOrig.slice(nextSec + 1)
    writeFileSync(SPEC, removed, 'utf8')
    const v = gate()
    const caught = v.code !== 0 && v.out.includes('F-01')
    if (!caught) all = false
    console.log(`${caught ? '✓ 咬住' : '✖ 漏网'} M1 拿掉 §1.2 校准表整节  (exit=${v.code}，点名 F-01 ? ${v.out.includes('F-01')})`)
    writeFileSync(SPEC, specOrig, 'utf8')
  }

  // ── 文档侧 B：把校准表里 F-12 的状态改成 🟡（与状态表不一致）
  fileMutation('M2 校准表把 F-12 从 ✅ 改成 🟡',
    SPEC, specOrig,
    '| F-12 | 产品级 Launcher 待完成 | ✅ |', '| F-12 | 产品级 Launcher 待完成 | 🟡 |',
    'F-12')

  // ── 文档侧 C：给仍然没做完的 F-04 也写一条校准（不该有的条目）
  fileMutation('M3 给 F-04（仍 🟡）写一条校准',
    SPEC, specOrig,
    '| F-12 | 产品级 Launcher 待完成 | ✅ |',
    '| F-04 | 尚未完成大规模提取 | ✅ | x |\n| F-12 | 产品级 Launcher 待完成 | ✅ |',
    'F-04')

  // ── 文档侧 D：打**状态表**（把 F-01 退回 🟡 ⇒ 校准表应立刻过期）
  fileMutation('M4 状态表把 F-01 退回 🟡（校准表应立即过期）',
    STATUS, statusOrig,
    '| F-01 | Runtime Contract | ✅ |', '| F-01 | Runtime Contract | 🟡 |',
    'F-01')

  // ── 代码侧
  codeMutation('M5 把"注记说没做完"的识别弄瞎（封闭词表清空）',
    "  '待补', '收口', '待完成', '尚未', '未完成', '部分',", '')

  codeMutation('M6 R1 不比对状态（凡带注记都要求登记）',
    "    if (st.aggregate !== '✅') continue     // 还没做完 ⇒ 注记仍然成立",
    "    // 变异：去掉这条")

  codeMutation('M7 R2 放宽成"只要有条目就行"（不比对状态）',
    '    if (c.status !== st.aggregate) {', '    if (false) {')

  codeMutation('M8 只认 §1.1 的表（把校准表读成空 ⇒ 应触发"什么都没查"）',
    "  if (calib.length === 0) {", "  if (false) {")
} finally {
  writeFileSync(SPEC, specOrig, 'utf8')
  writeFileSync(STATUS, statusOrig, 'utf8')
  writeFileSync(MOD, modOrig, 'utf8')
}

console.log('\n全部咬住 ? ' + all)
console.log('规格还原逐字相同 ? ' + (readFileSync(SPEC, 'utf8') === specOrig))
console.log('状态表还原逐字相同 ? ' + (readFileSync(STATUS, 'utf8') === statusOrig))
console.log('代码还原逐字相同 ? ' + (readFileSync(MOD, 'utf8') === modOrig))
console.log(`还原后门禁 exit=${gate().code}（期望 0），套件全绿=${suiteGreen()}（期望 true）`)
