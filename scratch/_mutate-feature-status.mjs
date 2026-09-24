// scratch/_mutate-feature-status.mjs —— 变异：文档侧与代码侧**都要打**（**不提交**）
//
// ★ 两个方向要分开打，因为它们由**不同的东西**捉住：
//   · 改**文档**（把缺口格退回 `—`）⇒ 由 `checkRepo()` 在真仓库上捉住；
//   · 改**代码**（把规则弄瞎/弄宽）⇒ 由**套件自己**捉住。
//     只打文档会漏掉"规则被架空了却仍然绿"这一整类。
//
// ★★ 每次都在**新进程**里跑：ESM 模块缓存会让同进程内的变异"看起来没生效"，
//    而"变异没执行"与"守卫没咬住"在输出里长得一模一样（第 24/26 轮的坑）。
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/project/DSH/legion'
const DOC = `${ROOT}/docs/MULTI-AGENT-FEATURE-STATUS.md`
const MOD = `${ROOT}/scripts/prt/feature-table-status.mjs`

const runJson = (script, args = []) =>
  execFileSync('node', [script, ...args], { cwd: ROOT, encoding: 'utf8' })

/** 在新进程里跑一次门禁，拿它的退出码与输出。 */
function gateVerdict() {
  try {
    const out = execFileSync('node', ['scripts/prt/feature-table-status.mjs'],
      { cwd: ROOT, encoding: 'utf8' })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') }
  }
}

/** 在新进程里跑套件，返回是否全绿。 */
function suiteGreen() {
  try {
    const out = execFileSync('node', ['--test', 'scripts/prt/feature-table-status.test.mjs'],
      { cwd: ROOT, encoding: 'utf8' })
    return { green: /ℹ fail 0/.test(out), out }
  } catch (e) {
    const out = String(e.stdout ?? '') + String(e.stderr ?? '')
    return { green: /ℹ fail 0/.test(out), out }
  }
}

const docOrig = readFileSync(DOC, 'utf8')
const modOrig = readFileSync(MOD, 'utf8')
let all = true
const done = []

// ── 文档侧变异：由真仓库门禁捉住 ─────────────────────────────────────────
function docMutation(name, id, find, repl) {
  if (!docOrig.includes(find)) { console.log(`⚠ ${name}\n    变异串没找到`); all = false; return }
  writeFileSync(DOC, docOrig.replace(find, repl), 'utf8')
  const v = gateVerdict()
  const caught = v.code !== 0 && v.out.includes(id)
  if (!caught) all = false
  console.log(`${caught ? '✓ 咬住' : '✖ 漏网'} ${name}`)
  console.log(`      exit=${v.code}  输出里有 ${id} ? ${v.out.includes(id)}`)
  writeFileSync(DOC, docOrig, 'utf8')
  done.push(name)
}

// ── 代码侧变异：由套件自己捉住 ───────────────────────────────────────────
function codeMutation(name, find, repl) {
  if (!modOrig.includes(find)) { console.log(`⚠ ${name}\n    变异串没找到`); all = false; return }
  writeFileSync(MOD, modOrig.replace(find, repl), 'utf8')
  const s = suiteGreen()
  const caught = !s.green
  if (!caught) all = false
  console.log(`${caught ? '✓ 咬住' : '✖ 漏网'} ${name}`)
  console.log(`      套件全绿 ? ${s.green}（期望 false）`)
  writeFileSync(MOD, modOrig, 'utf8')
  done.push(name)
}

try {
  // ── 文档：把本轮修好的两格退回 `—`
  const f22 = /(\| F-22 \| 后端与工作区 \| 🟡 \|[^|]*\| )[^|]*\|/
  const f24 = /(\| F-24 \| ACL 与安全姿态 \| 🟡 \|[^|]*\| )[^|]*\|/
  const m22 = f22.exec(docOrig)
  const m24 = f24.exec(docOrig)
  if (m22) {
    writeFileSync(DOC, docOrig.slice(0, m22.index) + m22[1] + ' — |' + docOrig.slice(m22.index + m22[0].length), 'utf8')
    const v = gateVerdict()
    const caught = v.code !== 0 && v.out.includes('F-22')
    if (!caught) all = false
    console.log(`${caught ? '✓ 咬住' : '✖ 漏网'} M1 把 F-22 的缺口格退回 \`—\``)
    console.log(`      exit=${v.code}  提到 F-22 ? ${v.out.includes('F-22')}`)
    writeFileSync(DOC, docOrig, 'utf8'); done.push('M1 F-22 退回 —')
  } else { console.log('⚠ 找不到 F-22 行'); all = false }

  if (m24) {
    writeFileSync(DOC, docOrig.slice(0, m24.index) + m24[1] + ' — |' + docOrig.slice(m24.index + m24[0].length), 'utf8')
    const v = gateVerdict()
    const caught = v.code !== 0 && v.out.includes('F-24')
    if (!caught) all = false
    console.log(`${caught ? '✓ 咬住' : '✖ 漏网'} M2 把 F-24 的缺口格退回 \`—\``)
    console.log(`      exit=${v.code}  提到 F-24 ? ${v.out.includes('F-24')}`)
    writeFileSync(DOC, docOrig, 'utf8'); done.push('M2 F-24 退回 —')
  } else { console.log('⚠ 找不到 F-24 行'); all = false }

  // ── 代码：把规则弄瞎 / 弄宽
  codeMutation('M3 把 isEmptyGap 弄瞎（恒 false ⇒ 门禁永远绿）',
    '  return t === \'\' || t === \'—\' || t === \'-\' || t === \'–\'',
    '  return false')

  codeMutation('M4 把 🟡 也当豁免（规则被架空）',
    "    if (r.end === DONE || r.end.startsWith(PAUSED)) { exempt += 1; continue }",
    "    if (r.end === DONE || r.end.startsWith(PAUSED) || r.end.startsWith('🟡')) { exempt += 1; continue }")

  codeMutation('M5 把 ✅ 也算受约束（规则变太宽 ⇒ 红在 21 个正确的地方）',
    "    if (r.end === DONE || r.end.startsWith(PAUSED)) { exempt += 1; continue }",
    "    if (r.end.startsWith(PAUSED)) { exempt += 1; continue }")
} finally {
  writeFileSync(DOC, docOrig, 'utf8')
  writeFileSync(MOD, modOrig, 'utf8')
}

console.log('\n全部咬住 ? ' + all)
console.log('文档还原逐字相同 ? ' + (readFileSync(DOC, 'utf8') === docOrig))
console.log('代码还原逐字相同 ? ' + (readFileSync(MOD, 'utf8') === modOrig))
const back = gateVerdict()
console.log(`还原后门禁 exit=${back.code}（期望 0）`)
const s = suiteGreen()
console.log(`还原后套件全绿 ? ${s.green}（期望 true）`)
