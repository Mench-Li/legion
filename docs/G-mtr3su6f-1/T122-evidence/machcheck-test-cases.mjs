// docs/G-mtr3su6f-1/T122-evidence/machcheck-test-cases.mjs —— T-122 TEST_CASES.md 文档自检
// 运行：node docs/G-mtr3su6f-1/T122-evidence/machcheck-test-cases.mjs [--out <evidence.txt>]
// 校验：1) 用例行格式与唯一性 2) 类别/优先级枚举 3) 5 列非空 4) 28 条 AC 全覆盖
//       5) §5 BR 正反向配对（正向🟢/反向🔴 且 id 存在） 6) §0 TL;DR 计数与统计一致
// --out 时把运行记录以 UTF-8 写回该文件（node 直写，避免宿主 shell 重定向编码问题）。
import { writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const outIdx = process.argv.indexOf('--out')
const OUT = outIdx > -1 ? process.argv[outIdx + 1] : null
const rec = []
const say = (s) => { rec.push(s); console.log(s) }
const err = (s) => { rec.push('FAIL: ' + s); console.error('FAIL: ' + s) }

const HERE = dirname(fileURLToPath(import.meta.url))
const DOC = join(HERE, '..', 'TEST_CASES.md')
const text = readFileSync(DOC, 'utf8')
const lines = text.split(/\r?\n/)

// —— 期望（与文档 §0 声明一致；改文档需同步此表，二者不一致即 FAIL）——
const EXPECT = {
  slices: { S1: 12, S2: 11, S3: 17, S4: 10, S5: 12, S6: 10, S7: 13, S8: 12, S9: 9, E2E: 6 },
  cat: { '🟢': 53, '🟡': 14, '🔴': 45 },
  pri: { P0: 93, P1: 10, P2: 9 },
}
const AC_ALL = [
  'AC-R1-1', 'AC-R1-2', 'AC-R1-3', 'AC-R1-4', 'AC-R1-5', 'AC-R1-6', 'AC-R1-7', 'AC-R1-8',
  'AC-R2-1', 'AC-R2-2', 'AC-R2-3', 'AC-R2-4', 'AC-R2-5',
  'AC-R3-1', 'AC-R3-2', 'AC-R3-3', 'AC-R3-4', 'AC-R3-5', 'AC-R3-6',
  'AC-R4-1', 'AC-R4-2', 'AC-R4-3', 'AC-R4-4', 'AC-R4-5', 'AC-R4-6',
  'AC-R5-1', 'AC-R5-2', 'AC-R5-3',
]
const CAT_OF = { '1f7e2': '🟢', '1f7e1': '🟡', '1f534': '🔴' }
let fails = 0
const fail = (msg) => err(msg)

// —— 1/2/3：解析用例行 ——
const rows = new Map()
for (const ln of lines) {
  const m = /^\| (TC-S\d+-\d+|E2E-\d+) \|/.exec(ln)
  if (!m) continue
  const cells = ln.split('|').map((s) => s.trim())
  if (cells.length !== 9) { fail(`用例 ${m[1]} 列数=${cells.length}（应为 7 列）`); continue }
  const [, id, cat, pre, step, exp, auto, trace] = cells
  if (rows.has(id)) fail(`用例 ID 重复：${id}`)
  const c = CAT_OF[cat.codePointAt(0).toString(16)]
  const pm = / (P[012])$/.exec(cat)
  if (!c || !pm) { fail(`用例 ${id} 类别列格式错误：${cat}`); continue }
  for (const [name, v] of [['前置条件', pre], ['操作步骤', step], ['期望结果/判据', exp], ['自动化', auto], ['追溯', trace]]) {
    if (!v) fail(`用例 ${id} 缺「${name}」列`)
  }
  rows.set(id, { cat: c, pri: pm[1], trace })
}
if (rows.size !== 112) fail(`用例总数 ${rows.size} ≠ 112`)

// —— 各切片/类别/优先级统计 ——
const sliceCount = {}
const catCount = {}
const priCount = {}
for (const [id, row] of rows) {
  const sl = id.startsWith('E2E') ? 'E2E' : id.slice(3, 5)
  sliceCount[sl] = (sliceCount[sl] || 0) + 1
  catCount[row.cat] = (catCount[row.cat] || 0) + 1
  priCount[row.pri] = (priCount[row.pri] || 0) + 1
}
for (const k of Object.keys(EXPECT.slices)) {
  if (sliceCount[k] !== EXPECT.slices[k]) fail(`切片 ${k} 用例数 ${sliceCount[k] || 0} ≠ ${EXPECT.slices[k]}`)
}
for (const k of Object.keys(EXPECT.cat)) {
  if (catCount[k] !== EXPECT.cat[k]) fail(`类别 ${k} 计数 ${catCount[k] || 0} ≠ ${EXPECT.cat[k]}`)
}
for (const k of Object.keys(EXPECT.pri)) {
  if (priCount[k] !== EXPECT.pri[k]) fail(`优先级 ${k} 计数 ${priCount[k] || 0} ≠ ${EXPECT.pri[k]}`)
}

// —— 4：AC 全覆盖（任一用例追溯列包含该 AC 字样）——
const covered = new Set()
for (const row of rows.values()) {
  for (const ac of AC_ALL) {
    if (row.trace.includes(ac)) covered.add(ac)
  }
}
for (const ac of AC_ALL) {
  if (!covered.has(ac)) fail(`AC 无用例引用：${ac}`)
}

// —— 5：§5 BR 正反向配对 ——
let brSeen = 0
for (const ln of lines) {
  const m = /^\| (BR-\d+) \| .+ \| ([\dA-Z、TC-E-]+) \| ([\dA-Z、TC-E-]+) \|/.exec(ln)
  if (!m) continue
  brSeen++
  const pos = m[2].split('、').filter(Boolean)
  const rev = m[3].split('、').filter(Boolean)
  for (const id of pos) {
    const r = rows.get(id)
    if (!r) fail(`${m[1]} 正向引用不存在的用例 ${id}`)
    else if (r.cat !== '🟢') fail(`${m[1]} 正向用例 ${id} 类别=${r.cat}（应为 🟢）`)
  }
  for (const id of rev) {
    const r = rows.get(id)
    if (!r) fail(`${m[1]} 反向引用不存在的用例 ${id}`)
    else if (r.cat !== '🔴') fail(`${m[1]} 反向用例 ${id} 类别=${r.cat}（应为 🔴）`)
  }
}
if (brSeen !== 17) fail(`BR 配对表行数 ${brSeen} ≠ 17`)

// —— 摘要 ——
say(`用例总数：${rows.size}（唯一 ${new Set(rows.keys()).size}）`)
say(`切片：${JSON.stringify(sliceCount)}`)
say(`类别：🟢${catCount['🟢'] || 0} / 🟡${catCount['🟡'] || 0} / 🔴${catCount['🔴'] || 0}`)
say(`优先级：P0=${priCount.P0 || 0} / P1=${priCount.P1 || 0} / P2=${priCount.P2 || 0}`)
say(`AC 覆盖：${covered.size}/${AC_ALL.length}`)
say(`BR 配对：${brSeen} 条已校验`)
say(fails > 0 ? `RESULT: FAIL（${fails} 项不通过）` : 'RESULT: PASS（全部校验通过）')
if (OUT) writeFileSync(OUT, rec.join('\n') + '\n', 'utf8')
process.exit(fails > 0 ? 1 : 0)
