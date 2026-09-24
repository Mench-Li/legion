// scratch/_mutate-r118-caps.mjs — 破验：把 tool-permission-enforcement 移出必需表之后，
// 新判据真的咬得住吗？而且**安全方向**有没有被放松？
//
//   M1: 那一项**又回到** REQUIRED_CAPABILITIES        ⇒ 期望红（wire/contract/registrar 各一条）
//   M2: PRODUCT_PLANE_CAPABILITIES 清空               ⇒ 期望红（整张表从两个表里一起消失）
//   M3: row 侧又对它表态（加回 evidence 条目）        ⇒ 期望红
//   M4: 两句措辞**合并**（产品面那一项塞进"应禁用对应功能"） ⇒ 期望红（★ 最危险的一条）
//   M5: 反向——把引擎可选能力说成产品面                 ⇒ 期望红（反向对照）
//   M6: ★★ 安全方向：让自检① 恒 ok（强制面判定被废）  ⇒ 期望红（这条证明我**没有**削弱 fail-closed）
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const ADAPTER = 'runtime/contracts/adapter.mjs'
const ROW = 'runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs'
const SELFCHECK = 'runtime/dsh-composition/selfcheck.mjs'
const SUITES = [
  'runtime/contracts/contract.test.mjs',
  'runtime/contracts/wire.test.mjs',
  'runtime/dsh-composition/plugins/runtime-host-registrar-row.test.mjs',
]
const SELFCHECK_SUITE = 'runtime/dsh-composition/bootstrap.test.mjs'

const FILES = [ADAPTER, ROW, SELFCHECK]
const snaps = new Map()
for (const f of FILES) { snaps.set(f, readFileSync(f)); copyFileSync(f, `${f}.mutbak`) }
// ★ 变异锚点按**换行风格无关**的方式找：本仓文件是 CRLF，而源码里写的字面串是 LF
//   ⇒ 直接用 `includes(from)` 会"找不到"，而"变异点找不到"与"判据没咬住"
//   在输出里只差一个字符（我第一次就是这么被骗过去的）。
//
//   ⚠️ 第一版我写成 `from.replace(/\\n/g, '\\r?\\n')` —— 那匹配的是**字面的
//   反斜杠加 n**，而 `from` 里是**真换行**，所以正则永远对不上。正确做法是
//   把**两边**都规范化成 LF 再比对。
const toLF = (s) => s.replace(/\r\n/g, '\n')
const applyMutant = (text, from, to) => {
  const norm = toLF(text)
  const i = norm.indexOf(toLF(from))
  if (i < 0) return null
  const mutated = norm.slice(0, i) + toLF(to) + norm.slice(i + toLF(from).length)
  // 还原原来的换行风格（若原文件是 CRLF，写回也用 CRLF）
  return text.includes('\r\n') ? mutated.replace(/\n/g, '\r\n') : mutated
}
const restore = (f) => copyFileSync(`${f}.mutbak`, f)
const restoreAll = () => { for (const f of FILES) restore(f) }
const assertClean = (when) => {
  for (const [f, s] of snaps) {
    if (Buffer.compare(s, readFileSync(f)) !== 0) {
      console.log(`✖ ${when}：${f} 与快照不同——上一轮留了残渣`); restoreAll(); process.exit(1)
    }
  }
}
/** 返回 true = 绿（没咬住）。 */
const green = (suites) => {
  try { execFileSync(process.execPath, ['--test', ...suites], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); return true }
  catch { return false }
}

const MUTANTS = [
  // M1：产品面表被清空 ⇒ 那一项从**两张表一起消失**（"产品面"这一档不存在了）
  ['M1 产品面表被清空', ADAPTER,
    "export const PRODUCT_PLANE_CAPABILITIES = Object.freeze([\n  /** 按 `RunRequest.permissions` 约束工具与文件范围：由 Legion 补丁层实现，自检判定。 */\n  'tool-permission-enforcement',\n])",
    'export const PRODUCT_PLANE_CAPABILITIES = Object.freeze([])'],
  // M2：★ 措辞合并——产品面那一项被塞进"应禁用对应功能"那一句（最危险的一条）
  ['M2 ★ 措辞合并（产品面塞进"禁用功能"句）', ADAPTER,
    '  const missingEngineOptional = missingOptional.filter((c) => !PRODUCT_PLANE_CAPABILITIES.includes(c))',
    '  const missingEngineOptional = missingOptional'],
  // M3：row 侧又对产品面那一项表态（替引擎答它不负责的问题）
  ['M3 row 侧又对它表态', ROW,
    "    'cancel-and-timeout': {",
    "    'tool-permission-enforcement': { satisfied: false, code: CAPABILITY_EVIDENCE_CODES.ENFORCEMENT_PLANE_MEASURED_ELSEWHERE, source: 'x', reason: 'x' },\n    'cancel-and-timeout': {"],
  // M4：只留引擎可选那一句（产品面那句根本不发）
  ['M4 产品面那句根本不发', ADAPTER,
    '  const missingProductPlane = missingOptional.filter((c) => PRODUCT_PLANE_CAPABILITIES.includes(c))',
    '  const missingProductPlane = []'],
  // M5：★ 反向控制——把**引擎可选**也说成产品面（反向那条用例的对照物）
  ['M5 ★ 反向：引擎可选说成产品面', ADAPTER,
    '  const missingProductPlane = missingOptional.filter((c) => PRODUCT_PLANE_CAPABILITIES.includes(c))',
    '  const missingProductPlane = missingOptional'],
]

let bad = 0
try {
  for (const [name, file, from, to] of MUTANTS) {
    assertClean(`变异前 ${name}`)
    const text = readFileSync(`${file}.mutbak`, 'utf8')
    const mutated = applyMutant(text, from, to)
    if (mutated === null) { console.log(`✖ ${name}：变异点找不到`); bad++; continue }
    writeFileSync(file, mutated)
    const g = green(SUITES)
    console.log(`${g ? '✖' : '✔'} ${name} → ${g ? '**没咬住**' : '咬住（红）'}`)
    if (g) bad++
    restore(file)
  }

  // M6：安全方向。把自检①（强制面判定）废掉，看判据是否报。
  assertClean('变异前 M6')
  const sc = readFileSync(`${SELFCHECK}.mutbak`, 'utf8')
  const mutated6 = applyMutant(sc, '    ok: reconciled.effective,', '    ok: true,')
  if (mutated6 === null) { console.log('✖ M6：变异点找不到'); bad++ } else {
    writeFileSync(SELFCHECK, mutated6)
    const g = green([SELFCHECK_SUITE, ...SUITES])
    console.log(`${g ? '✖' : '✔'} M6 ★★ 安全方向：废掉强制面判定 → ${g ? '**没咬住（说明我可能放松了 fail-closed）**' : '咬住（红）'}`)
    if (g) bad++
    restore(SELFCHECK)
  }
} finally {
  restoreAll()
  let same = true
  for (const f of FILES) { unlinkSync(`${f}.mutbak`); if (Buffer.compare(snaps.get(f), readFileSync(f)) !== 0) same = false }
  console.log(`还原逐字节相同：${same ? '✔' : '✖'}`)
  if (!same) process.exit(1)
}
if (bad > 0) process.exit(1)
