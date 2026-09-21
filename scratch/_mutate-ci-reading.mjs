// scratch/_mutate-ci-reading.mjs —— 变异：文档侧与代码侧分开打（**不提交**）
//
// ★ 每次都在新进程里跑（ESM 缓存会让同进程内的变异"看起来没生效"）。
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/project/DSH/legion'
const DOC = `${ROOT}/docs/superpowers/prt/PRT-HANDOVER-2026-09-18-ROUND22.md`
const MOD = `${ROOT}/scripts/prt/ci-reading-integrity.mjs`

function gate() {
  try {
    const out = execFileSync('node', ['scripts/prt/ci-reading-integrity.mjs'],
      { cwd: ROOT, encoding: 'utf8' })
    return { code: 0, out }
  } catch (e) { return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') } }
}
function suiteGreen() {
  try {
    const out = execFileSync('node', ['--test', 'scripts/prt/ci-reading-integrity.test.mjs'],
      { cwd: ROOT, encoding: 'utf8' })
    return /ℹ fail 0/.test(out)
  } catch (e) {
    const out = String(e.stdout ?? '') + String(e.stderr ?? '')
    return /ℹ fail 0/.test(out)
  }
}

const docOrig = readFileSync(DOC, 'utf8')
const modOrig = readFileSync(MOD, 'utf8')
let all = true

function docMutation(name, find, repl) {
  if (!docOrig.includes(find)) { console.log(`⚠ ${name}: 变异串没找到`); all = false; return }
  writeFileSync(DOC, docOrig.replace(find, repl), 'utf8')
  const v = gate()
  const caught = v.code !== 0
  if (!caught) all = false
  console.log(`${caught ? '✓ 咬住' : '✖ 漏网'} ${name}  (exit=${v.code})`)
  writeFileSync(DOC, docOrig, 'utf8')
}
function codeMutation(name, find, repl) {
  if (!modOrig.includes(find)) { console.log(`⚠ ${name}: 变异串没找到`); all = false; return }
  writeFileSync(MOD, modOrig.replace(find, repl), 'utf8')
  const green = suiteGreen()
  if (green) all = false
  console.log(`${green ? '✖ 漏网' : '✓ 咬住'} ${name}  (套件全绿=${green}，期望 false)`)
  writeFileSync(MOD, modOrig, 'utf8')
}

try {
  // ★★ 从**真文档**现算那个树状态串，不写死。
  //   第一版把「脏树 14 改 + 441 未跟踪」抄进了变异串，于是**读数一更新，
  //   这两条变异就静默失效**（"变异串没找到"）——而"变异没执行"与
  //   "守卫没咬住"在输出里长得很像（第 24/26 轮的坑）。
  const m = /脏树\s*\d+\s*改\s*\+\s*\d+\s*未跟踪/.exec(docOrig)
  if (m === null) { console.log('⚠ 真文档里找不到树状态串，控制写不出来'); all = false }
  const treeTok = m === null ? '' : m[0]

  // ── 文档侧：把树的状态说明拿掉（这正是第 27 轮之前那份报告的样子）
  docMutation('M1 交付 HEAD 那一行删掉树的状态串', `，**${treeTok}**`, '')

  // ── 文档侧：换成自由文本（看起来提了树）
  docMutation('M2 换成自由文本「已确认工作树」', `**${treeTok}**`, '已确认工作树')

  // ── 文档侧：把「交付 HEAD」这个标志词改掉 ⇒ 应触发"扫到 0 行"
  docMutation('M3 把「交付 HEAD」改成别的词（判据扫到 0 行必须红）',
    '全量 CI（**交付 HEAD**）', '全量 CI（**最终读数**）')

  // ── 代码侧
  codeMutation('M4 把封闭词表放宽成"任何非空都行"',
    '  dirty: /脏树\\s*\\d+\\s*改\\s*\\+\\s*\\d+\\s*未跟踪/,\n}',
    '  dirty: /./,\n}')

  codeMutation('M5 把"扫到 0 行也报绿"（去掉 headRows===0 那条）',
    "  if (headRows === 0) {", "  if (false) {")

  codeMutation('M6 把 readSummaryTree 的"缺字段"当成干净',
    "    return { known: false, reason: '这份 summary 没有 `tree` 字段（第 28 轮之前跑的）' }",
    "    return { known: true, dirty: false }")
} finally {
  writeFileSync(DOC, docOrig, 'utf8')
  writeFileSync(MOD, modOrig, 'utf8')
}

console.log('\n全部咬住 ? ' + all)
console.log('文档还原逐字相同 ? ' + (readFileSync(DOC, 'utf8') === docOrig))
console.log('代码还原逐字相同 ? ' + (readFileSync(MOD, 'utf8') === modOrig))
console.log(`还原后门禁 exit=${gate().code}（期望 0），套件全绿=${suiteGreen()}（期望 true）`)
