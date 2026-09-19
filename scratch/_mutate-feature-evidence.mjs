// scratch/_mutate-feature-evidence.mjs —— 变异：F 表证据判据（**不提交**）
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/project/DSH/legion'
const MOD = `${ROOT}/scripts/prt/feature-evidence.mjs`
const DOC = `${ROOT}/docs/MULTI-AGENT-FEATURE-STATUS.md`
const orig = readFileSync(MOD, 'utf8')
const docOrig = readFileSync(DOC, 'utf8')
let all = true

const green = () => {
  try {
    return /ℹ fail 0/.test(execFileSync('node', ['--test', 'scripts/prt/feature-evidence.test.mjs'],
      { cwd: ROOT, encoding: 'utf8' }))
  } catch (e) { return /ℹ fail 0/.test(String(e.stdout ?? '') + String(e.stderr ?? '')) }
}

function mut(name, find, repl, { file = MOD, original = orig } = {}) {
  if (!original.includes(find)) { console.log(`⚠ ${name}: 变异串没找到`); all = false; return }
  writeFileSync(file, original.replace(find, repl), 'utf8')
  const g = green()
  if (g) all = false
  console.log(`${g ? '✖ 漏网' : '✓ 咬住'} ${name}`)
  writeFileSync(file, original, 'utf8')
}

try {
  // ★ M1 就是这一轮那个 bug 本身：状态列读错一格 ⇒ 读到 0 行
  mut('M1 状态列读 `cells[1]`（**这一轮那个 bug 本身**：读到 0 行）',
    "if (!STATUS_RE.test(cells[2] ?? '')) continue",
    "if (!STATUS_RE.test(cells[1] ?? '')) continue")

  mut('M2 去掉"0 行不许报绿"的下限（假绿回来）',
    "    return { ok: false, violations, reading: { rows: 0, pointers: 0, statuses: {} } }",
    "    return { ok: true, violations, reading: { rows: 0, pointers: 0, statuses: {} } }")

  mut('M3 去掉 R1：引用不存在的 PRT 不报',
    '      if (!ledgerPrts.has(prt)) {', '      if (false) {')

  mut('M4 去掉 R4：🟡 行说"不差什么"不报（第 27 轮那个形状回来）',
    "    if (MUST_SAY_MISSING.includes(r.status) && /^[—–-]*$/.test(r.missing.trim())) {",
    '    if (false) {')

  mut('M5 把 ✅ 也塞进"必须说清缺口"的表（反向控制会红）',
    "export const MUST_SAY_MISSING = Object.freeze(['🟡', '🟡→✅', '✅→🟡'])",
    "export const MUST_SAY_MISSING = Object.freeze(['🟡', '🟡→✅', '✅→🟡', '✅'])")

  mut('M6 ★ 去掉 R3 的歧义分支（裸名撞名不再报）',
    '        } else if (hits.length > 1) {', '        } else if (false) {')

  mut('M7 ★ 回到"把限定词削掉再去重"（**这一轮的 4 处假阳性本身**）',
    '    if (seenLabels.has(r.label)) {', '    if (seenLabels.has(r.id)) {')

  mut('M8 状态词表放宽成 `.+`（把文档里别的表也读成状态行）',
    "export const STATUS_RE = /^(?:✅|🟡|⏸|⬜|🟡→✅|⬜→🟡|✅→🟡)$/",
    'export const STATUS_RE = /^.+$/')

  // ★ M9 是真仓库那处**真的**歧义引用：把它放回去 ⇒ 必须红
  mut('M9 ★ 把 F-01 那处裸名引用**放回文档**（真缺陷重现）',
    '套件 `runtime-contract`（64 例）、`runtime/contracts/contract.test.mjs`（45 例）',
    '套件 `runtime-contract`（64 例）、`contract.test.mjs`',
    { file: DOC, original: docOrig })
} finally {
  writeFileSync(MOD, orig, 'utf8')
  writeFileSync(DOC, docOrig, 'utf8')
}

console.log(`\n全部咬住 ? ${all}`)
console.log(`两处逐字还原 ? ${readFileSync(MOD, 'utf8') === orig} ${readFileSync(DOC, 'utf8') === docOrig}`)
console.log(`还原后判据仍绿 ? ${green()}`)
