// scratch/_mutate-landing-paths.mjs —— 变异：文档侧 + 代码侧（**不提交**）
// ★ 每次都在**新进程**里跑门禁（ESM 缓存会让同进程内的变异"看起来没生效"）。
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/project/DSH/legion'
const DOC = `${ROOT}/docs/MULTI-AGENT-FEATURE-STATUS.md`
const MOD = `${ROOT}/scripts/prt/feature-landing-paths.mjs`

const gate = () => {
  try { return { code: 0, out: execFileSync('node', ['scripts/prt/feature-landing-paths.mjs'], { cwd: ROOT, encoding: 'utf8' }) } }
  catch (e) { return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') } }
}
const suiteGreen = () => {
  try { return /ℹ fail 0/.test(execFileSync('node', ['--test', 'scripts/prt/feature-landing-paths.test.mjs'], { cwd: ROOT, encoding: 'utf8' })) }
  catch (e) { return /ℹ fail 0/.test(String(e.stdout ?? '') + String(e.stderr ?? '')) }
}

const docOrig = readFileSync(DOC, 'utf8')
const modOrig = readFileSync(MOD, 'utf8')
let all = true

function docMutation(name, find, repl, wantTok) {
  if (!docOrig.includes(find)) { console.log(`⚠ ${name}: 变异串没找到`); all = false; return }
  writeFileSync(DOC, docOrig.replace(find, repl), 'utf8')
  const v = gate()
  const caught = v.code !== 0 && (wantTok === undefined || v.out.includes(wantTok))
  if (!caught) all = false
  console.log(`${caught ? '✓ 咬住' : '✖ 漏网'} ${name}  (exit=${v.code}${wantTok ? `，点名 ${wantTok} ? ${v.out.includes(wantTok)}` : ''})`)
  writeFileSync(DOC, docOrig, 'utf8')
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
  // ── 文档侧（这是这条判据当天抓到的那一处真缺陷）
  docMutation('M1 把 F-21 的落点改回短路径 `plugins/connector-feedback.mjs`',
    '`runtime/dsh-composition/plugins/connector-feedback.mjs`',
    '`plugins/connector-feedback.mjs`', 'connector-feedback.mjs')

  docMutation('M2 把一个带目录的落点改成不存在的路径',
    '`runtime/contracts/adapter.mjs`', '`runtime/contracts/no-such-file.mjs`', 'no-such-file')

  docMutation('M3 ★★ 删掉一格里的**第一个**带目录路径（后续裸名失去继承目录）',
    '`runtime/contracts/adapter.mjs`、`run.mjs`、`errors.mjs`',
    '`run.mjs`、`errors.mjs`', 'run.mjs')

  // ── 代码侧
  codeMutation('M4 去掉 R2（裸名全仓唯一）——只留"存在就行"',
    '        const hits = byName.get(t) ?? []', '        const hits = [t]  // 变异：永远当唯一')

  codeMutation('M5 去掉 R3（沿本格目录继承）',
    '      if (dir !== null) {', '      if (false) {')

  codeMutation('M6 去掉"扫到 0 个路径也失败"那条守卫',
    '  if (scanned === 0) {', '  if (false) {')

  codeMutation('M7 把通配符重新排除出"像路径"的字符集（globbed 会永远 0）',
    'export const PATH_RE = /^[\\w./*?-]+\\.(?:mjs|ts|js|json|yml|yaml|md|sql)$/',
    'export const PATH_RE = /^[\\w./-]+\\.(?:mjs|ts|js|json|yml|yaml|md|sql)$/')
} finally {
  writeFileSync(DOC, docOrig, 'utf8')
  writeFileSync(MOD, modOrig, 'utf8')
}

console.log('\n全部咬住 ? ' + all)
console.log('文档还原逐字相同 ? ' + (readFileSync(DOC, 'utf8') === docOrig))
console.log('代码还原逐字相同 ? ' + (readFileSync(MOD, 'utf8') === modOrig))
console.log(`还原后门禁 exit=${gate().code}（期望 0），套件全绿=${suiteGreen()}（期望 true）`)
