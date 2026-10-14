// docs/G-mv7kzgnu-1/T206-evidence/machcheck-test-cases.mjs
// T-206 用例文档自检（machcheck）—— 零第三方依赖，仅 node 内建模块。
//
//   node docs/G-mv7kzgnu-1/T206-evidence/machcheck-test-cases.mjs
//
// 校验项（只校验**文档结构**与**骨架语法**，不执行任何业务用例）：
//   ① 用例行 7 列（split 后 9 段）完整且无空列；② ID 唯一；
//   ③ 类别（🟢/🟡/🔴）与优先级（P0/P1/P2）枚举合法；
//   ④ 文首 §0 声明的总数 / 各切片 / 各类别 / 各优先级与实测一致；
//   ⑤ 35 条 AC 在 §7 恰好各出现一次，且引用的用例存在（无悬空 AC）；
//   ⑥ §5 的 15 条 BR 正反向配对（正向引用必 🟢、反向必 🔴）；
//   ⑦ §9 附录 B 的 ~~~js 骨架逐个 node --check；
//   ⑧ M-1~M-7 在 §7 有追溯行。
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const DOC = join(HERE, '..', 'TEST_CASES.md')
const out = []
const say = (s) => { out.push(s); console.log(s) }
let failed = 0
const fail = (s) => { failed += 1; say('FAIL ' + s) }

const text = readFileSync(DOC, 'utf8')
const lines = text.split('\n')

// ---- ① 用例行 7 列完整且无空列；② ID 唯一；③ 类别/优先级枚举 ----
const CASE_RE = /^\|\s*(TC-S\d+-\d+|E2E-\d+)\s*\|/
const cases = new Map()
const bySlice = new Map()
const byCat = { "\u{1F7E2}": 0, "\u{1F7E1}": 0, "\u{1F534}": 0 }
const byPri = { P0: 0, P1: 0, P2: 0 }
for (const [i, raw] of lines.entries()) {
  const m = CASE_RE.exec(raw)
  if (!m) continue
  const id = m[1]
  const parts = raw.split('|')
  if (parts.length !== 9) { fail('用例行列数不是 7 列（split=' + parts.length + '）：' + id + ' @L' + (i + 1)); continue }
  for (let c = 1; c <= 7; c += 1) {
    if (String(parts[c]).trim() === '') fail('用例列空：' + id + ' 第 ' + c + ' 列 @L' + (i + 1))
  }
  if (cases.has(id)) fail('用例 ID 重复：' + id)
  cases.set(id, { cat: String(parts[2]).trim(), pri: String(parts[3]).trim() })
  const cat = Object.keys(byCat).find((k) => String(parts[2]).includes(k))
  if (cat === undefined) fail('用例类别非法（应含 🟢/🟡/🔴）：' + id + ' -> ' + parts[2])
  else byCat[cat] += 1
  const pri = (String(parts[2]).match(/P[0-2]/) || [])[0]
  if (pri === undefined) fail('用例优先级非法（应含 P0/P1/P2）：' + id + ' -> ' + parts[2])
  else byPri[pri] += 1
  const slice = id.startsWith('E2E') ? 'E2E' : id.split('-')[1]
  bySlice.set(slice, (bySlice.get(slice) || 0) + 1)
}

// ---- ④ §0 声明值 vs 实测 ----
const head = lines.find((l) => /共 \*\*\d+ 条用例\*\*/.test(l)) || ''
const hm = /共 \*\*(\d+) 条用例\*\*（S1 (\d+) \/ S2 (\d+) \/ S3 (\d+) \/ S4 (\d+) \/ S5 (\d+) \/ E2E (\d+)）；🟢 主路径 (\d+) \/ 🟡 边界 (\d+) \/ 🔴 异常·反向 (\d+)；P0 (\d+) \/ P1 (\d+) \/ P2 (\d+)/.exec(head)
if (!hm) fail('§0 未找到可解析的用例统计句')
else {
  const declared = { total: +hm[1], S1: +hm[2], S2: +hm[3], S3: +hm[4], S4: +hm[5], S5: +hm[6], E2E: +hm[7], green: +hm[8], yellow: +hm[9], red: +hm[10], P0: +hm[11], P1: +hm[12], P2: +hm[13] }
  const actual = {
    total: cases.size,
    S1: bySlice.get('S1') || 0, S2: bySlice.get('S2') || 0, S3: bySlice.get('S3') || 0,
    S4: bySlice.get('S4') || 0, S5: bySlice.get('S5') || 0, E2E: bySlice.get('E2E') || 0,
    green: byCat['\u{1F7E2}'], yellow: byCat['\u{1F7E1}'], red: byCat['\u{1F534}'],
    P0: byPri.P0, P1: byPri.P1, P2: byPri.P2,
  }
  for (const k of Object.keys(declared)) {
    if (declared[k] !== actual[k]) fail('§0 声明 ' + k + '=' + declared[k] + ' 与实测 ' + actual[k] + ' 不一致')
  }
}

// ---- ⑤ 35 条 AC 恰好各一次 + 引用用例存在 ----
const EXPECTED_ACS = []
for (const [r, n] of [['1', 3], ['2', 4], ['3', 3], ['4', 3], ['5', 4], ['6', 4], ['7', 3], ['8', 3], ['9', 4], ['10', 3], ['11', 1]]) {
  for (let i = 1; i <= n; i += 1) EXPECTED_ACS.push('AC-R' + r + '-' + i)
}
const AC_RE = /^\|\s*(AC-R\d+-\d+)\s*\|/
const acSeen = new Map()
for (const [i, raw] of lines.entries()) {
  const m = AC_RE.exec(raw)
  if (!m) continue
  const ac = m[1]
  acSeen.set(ac, (acSeen.get(ac) || 0) + 1)
  const refs = raw.match(/(TC-S\d+-\d+|E2E-\d+)/g) || []
  for (const r of refs) if (!cases.has(r)) fail('AC ' + ac + ' 引用了不存在的用例：' + r + ' @L' + (i + 1))
}
for (const ac of EXPECTED_ACS) if (!acSeen.has(ac)) fail('AC 未在 §7 出现：' + ac)
for (const [ac, n] of acSeen) {
  if (n !== 1) fail('AC 出现 ' + n + ' 次（应恰好 1 次）：' + ac)
  if (!EXPECTED_ACS.includes(ac)) fail('§7 出现未知 AC：' + ac)
}

// ---- ⑥ BR 正反向配对 ----
const BR_RE = /^\|\s*(BR-\d+)\s*\|/
let brCount = 0
for (const [i, raw] of lines.entries()) {
  const m = BR_RE.exec(raw)
  if (!m) continue
  brCount += 1
  const parts = raw.split('|')
  if (parts.length !== 6) { fail('BR 行列数异常：' + m[1]); continue }
  const pos = parts[3].trim()
  const neg = parts[4].trim()
  if (!cases.has(pos)) fail('BR ' + m[1] + ' 正向用例不存在：' + pos)
  else if (!cases.get(pos).cat.includes('\u{1F7E2}')) fail('BR ' + m[1] + ' 正向用例不是 🟢：' + pos)
  if (!cases.has(neg)) fail('BR ' + m[1] + ' 反向用例不存在：' + neg)
  else if (!cases.get(neg).cat.includes('\u{1F534}')) fail('BR ' + m[1] + ' 反向用例不是 🔴：' + neg)
}

// ---- ⑧ M-1~M-7 追溯 ----
for (let i = 1; i <= 7; i += 1) {
  if (!text.includes('M-' + i + ' \u2192 ')) fail('§7 缺 M-' + i + ' 追溯行')
}

// ---- ⑦ 骨架语法 ----
let skeleton = 0
for (const m of text.matchAll(/~~~js\n([\s\S]*?)\n~~~/g)) {
  skeleton += 1
  const file = join(tmpdir(), 't206-skeleton-' + skeleton + '.mjs')
  writeFileSync(file, m[1], 'utf8')
  // 管道 stdio 在 DSH Windows 沙箱下会 EPERM（既定边界）——先试带捕获的管道，
  // 命中 EPERM 时退化为 stdio:'ignore' 重试（只判退出码）。见系统提示的 EPERM 说明。
  let r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (r.error && String(r.error).includes('EPERM')) {
    r = spawnSync(process.execPath, ['--check', file], { stdio: 'ignore' })
  }
  if (r.status !== 0) {
    fail('骨架 #' + skeleton + ' node --check 失败' + (r.stderr ? '：' + String(r.stderr).split('\n')[0] : '（片段留于 ' + file + '，可直接 node --check 查看）'))
  } else {
    rmSync(file, { force: true })
  }
}

say('用例总数=' + cases.size + '（S1=' + (bySlice.get('S1') || 0) + ' S2=' + (bySlice.get('S2') || 0) + ' S3=' + (bySlice.get('S3') || 0) + ' S4=' + (bySlice.get('S4') || 0) + ' S5=' + (bySlice.get('S5') || 0) + ' E2E=' + (bySlice.get('E2E') || 0) + '）')
say('类别：🟢=' + byCat['\u{1F7E2}'] + ' 🟡=' + byCat['\u{1F7E1}'] + ' 🔴=' + byCat['\u{1F534}'] + '；优先级：P0=' + byPri.P0 + ' P1=' + byPri.P1 + ' P2=' + byPri.P2)
say('AC=' + acSeen.size + '/' + EXPECTED_ACS.length + '；BR=' + brCount + '；骨架 node --check=' + skeleton + ' 段')
say(failed === 0 ? 'PASS T-206 用例文档机器自检（结构 + 骨架语法）全绿' : 'FAIL 共 ' + failed + ' 项')
process.exit(failed === 0 ? 0 : 1)
