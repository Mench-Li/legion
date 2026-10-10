#!/usr/bin/env node
// docs/G-mv1s6y49-1/T198-evidence/machcheck-test-cases.mjs
// T-198 用例文档机器自检（零第三方依赖，仅 node:fs/path/os/child_process；与 G-mujfc9vi-1/T169 同型）
// 校验：用例行 7 列 / 非空列 / ID 唯一 / 类别与优先级枚举 / 34 条 AC 全覆盖 /
//       BR 正反向配对（正向=🟢、反向=🔴）/ §0 计数与实测一致 / 附录 B 骨架 node --check。
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const DOC = resolve(HERE, '..', 'TEST_CASES.md')
const OUT1 = join(HERE, '01-doc-machcheck.txt')
const OUT2 = join(HERE, '02-skeleton-syntax.txt')

const text = readFileSync(DOC, 'utf8').replace(/\r\n?/g, '\n')
const lines = text.split('\n')

const out = []
const say = (s) => { out.push(s); console.log(s) }
let fails = 0
const fail = (msg) => { fails += 1; say('FAIL: ' + msg) }

const idMap = new Map()

// ---- 1. 用例行格式与非空列 ----
for (let i = 0; i < lines.length; i++) {
  const line = lines[i]
  if (!/^\|\s*(TC-S\d+-\d+|E2E-\d+)\s*\|/.test(line)) continue
  const body = line.split('|').map((s) => s.trim()).slice(1, -1)
  if (body.length !== 7) { fail('行 ' + (i + 1) + ' 列数=' + body.length + '（需 7）: ' + body[0]); continue }
  const id = body[0]
  const m = /^(🟢|🟡|🔴)\s+(P[012])$/.exec(body[1])
  if (!m) { fail('行 ' + (i + 1) + ' 类/优列非法: ' + body[1]); continue }
  const cat = m[1]
  const prio = m[2]
  const cols = [['前置条件', body[2]], ['操作步骤', body[3]], ['期望判据', body[4]], ['自动化', body[5]], ['追溯', body[6]]]
  for (const c of cols) { if (!c[1] || c[1].length === 0) fail(id + ' 列 ' + c[0] + ' 为空') }
  if (idMap.has(id)) fail('ID 重复: ' + id)
  const slice = id.startsWith('E2E') ? 'E2E' : 'S' + id.split('-')[1].slice(1)
  idMap.set(id, { cat, prio, slice, line: i + 1 })
}

// ---- 2. 计数 ----
const slices = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'E2E']
const bySlice = {}
for (const s of slices) bySlice[s] = 0
const byCat = { '🟢': 0, '🟡': 0, '🔴': 0 }
const byPrio = { P0: 0, P1: 0, P2: 0 }
for (const row of idMap.values()) {
  bySlice[row.slice] += 1
  byCat[row.cat] += 1
  byPrio[row.prio] += 1
}
const total = idMap.size
say('用例总数: ' + total)
say('各切片: ' + slices.map((s) => s + '=' + bySlice[s]).join(' '))
say('各类别: 🟢=' + byCat['🟢'] + ' 🟡=' + byCat['🟡'] + ' 🔴=' + byCat['🔴'])
say('各优先级: P0=' + byPrio.P0 + ' P1=' + byPrio.P1 + ' P2=' + byPrio.P2)

// ---- 3. §0 声明的计数必须与实测一致 ----
const declared = (re) => { const mm = re.exec(text); return mm ? Number(mm[1]) : null }
const dTotal = declared(/共 \*\*(\d+) 条用例\*\*/)
if (dTotal !== total) fail('§0 总数声明=' + dTotal + '，实测=' + total)
const sliceRe = /（S1 (\d+) \/ S2 (\d+) \/ S3 (\d+) \/ S4 (\d+) \/ S5 (\d+) \/ S6 (\d+) \/ S7 (\d+) \/ E2E (\d+)）/
const sm = sliceRe.exec(text)
if (!sm) fail('§0 各切片计数声明缺失')
else slices.forEach((s, k) => { const d = Number(sm[k + 1]); if (d !== bySlice[s]) fail('§0 ' + s + ' 声明=' + d + '，实测=' + bySlice[s]) })
const cm = /🟢正常 (\d+) \/ 🟡边界 (\d+) \/ 🔴异常·反向 (\d+)/.exec(text)
if (!cm) fail('§0 类别计数声明缺失')
else {
  if (Number(cm[1]) !== byCat['🟢']) fail('§0 🟢 声明=' + cm[1] + '，实测=' + byCat['🟢'])
  if (Number(cm[2]) !== byCat['🟡']) fail('§0 🟡 声明=' + cm[2] + '，实测=' + byCat['🟡'])
  if (Number(cm[3]) !== byCat['🔴']) fail('§0 🔴 声明=' + cm[3] + '，实测=' + byCat['🔴'])
}
const pm = /P0 (\d+) \/ P1 (\d+) \/ P2 (\d+)/.exec(text)
if (!pm) fail('§0 优先级计数声明缺失')
else {
  if (Number(pm[1]) !== byPrio.P0) fail('§0 P0 声明=' + pm[1] + '，实测=' + byPrio.P0)
  if (Number(pm[2]) !== byPrio.P1) fail('§0 P1 声明=' + pm[2] + '，实测=' + byPrio.P1)
  if (Number(pm[3]) !== byPrio.P2) fail('§0 P2 声明=' + pm[3] + '，实测=' + byPrio.P2)
}

// ---- 4. AC 全覆盖（§7 追溯矩阵） ----
const AC_N = { 1: 4, 2: 3, 3: 4, 4: 4, 5: 2, 6: 4, 7: 3, 8: 2, 9: 3, 10: 3, 11: 2 }
const acExpected = []
for (let r = 1; r <= 11; r++) for (let k = 1; k <= AC_N[r]; k++) acExpected.push('AC-R' + r + '-' + k)
const acSeen = new Map()
let inMatrix = false
for (let i = 0; i < lines.length; i++) {
  if (/^## 7\./.test(lines[i])) inMatrix = true
  else if (/^## 8\./.test(lines[i])) inMatrix = false
  if (!inMatrix) continue
  if (!lines[i].startsWith('| AC-R')) continue
  const am = /^(AC-R\d+-\d+)/.exec(lines[i].replace(/^\|\s*/, ''))
  if (!am) { fail('§7 行无法解析 AC 编号: 行 ' + (i + 1)); continue }
  const acId = am[1]
  acSeen.set(acId, (acSeen.get(acId) || 0) + 1)
  const refs = lines[i].match(/TC-S\d+-\d+|E2E-\d+/g) || []
  if (refs.length === 0) fail(acId + ' 无用例引用')
  for (const ref of refs) if (!idMap.has(ref)) fail(acId + ' 引用不存在用例: ' + ref)
}
for (const ac of acExpected) {
  const n = acSeen.get(ac) || 0
  if (n === 0) fail('悬空 AC（§7 无行）: ' + ac)
  else if (n > 1) fail('AC 重复出现 ' + n + ' 次: ' + ac)
}
for (const ac of acSeen.keys()) if (!acExpected.includes(ac)) fail('§7 出现未知 AC: ' + ac)
say('AC 覆盖: ' + acSeen.size + '/' + acExpected.length)

// ---- 5. BR 正反向配对（§5） ----
let inBR = false
let brCount = 0
for (let i = 0; i < lines.length; i++) {
  if (/^## 5\./.test(lines[i])) inBR = true
  else if (/^## 6\./.test(lines[i])) inBR = false
  if (!inBR) continue
  if (!lines[i].startsWith('| BR-')) continue
  const body = lines[i].split('|').map((s) => s.trim()).slice(1, -1)
  if (body.length < 4) { fail('§5 行 ' + (i + 1) + ' 列数不足: ' + body[0]); continue }
  brCount += 1
  const br = body[0]
  const fids = (body[2].match(/TC-S\d+-\d+|E2E-\d+/g) || [])
  const rids = (body[3].match(/TC-S\d+-\d+|E2E-\d+/g) || [])
  if (fids.length === 0) fail(br + ' 缺正向用例')
  if (rids.length === 0) fail(br + ' 缺反向用例')
  for (const id of fids) {
    const row = idMap.get(id)
    if (!row) fail(br + ' 正向引用不存在: ' + id)
    else if (row.cat !== '🟢') fail(br + ' 正向用例非🟢: ' + id + '（' + row.cat + '）')
  }
  for (const id of rids) {
    const row = idMap.get(id)
    if (!row) fail(br + ' 反向引用不存在: ' + id)
    else if (row.cat !== '🔴') fail(br + ' 反向用例非🔴: ' + id + '（' + row.cat + '）')
  }
}
say('业务规则 BR: ' + brCount + ' 条（正反向配对校验）')

// ---- 6. 附录 B 骨架语法（node --check） ----
const fences = []
for (let i = 0; i < lines.length; i++) {
  if (!/^~~~js\s*$/.test(lines[i])) continue
  const buf = []
  let j = i + 1
  for (; j < lines.length; j++) {
    if (/^~~~\s*$/.test(lines[j])) break
    buf.push(lines[j])
  }
  fences.push({ start: i + 1, code: buf.join('\n') })
  i = j
}
const skelOut = []
const tmp = mkdtempSync(join(tmpdir(), 'legion-t198-skel-'))
fences.forEach((f, idx) => {
  const file = join(tmp, 'skeleton-' + (idx + 1) + '.mjs')
  writeFileSync(file, f.code)
  const r = spawnSync(process.execPath, ['--check', file], { stdio: 'ignore' })
  const ok = r.status === 0
  skelOut.push('skeleton-' + (idx + 1) + '.mjs (doc 行 ' + f.start + '): ' + (ok ? 'node --check OK' : 'node --check FAIL status=' + r.status + (r.error ? ' error=' + r.error.code : '')))
  if (!ok) fail('骨架语法失败: doc 行 ' + f.start)
})
rmSync(tmp, { recursive: true, force: true })
say('骨架代码块: ' + fences.length + ' 个，node --check 通过 ' + skelOut.filter((s) => s.indexOf('OK') >= 0).length)

writeFileSync(OUT2, skelOut.join('\n') + '\n')

// ---- 结算 ----
if (fails === 0) say('machcheck: PASS（' + total + ' 条用例；' + acExpected.length + ' 条 AC 全覆盖；' + brCount + ' 条 BR 正反向配对；' + fences.length + ' 骨架语法 OK）')
else say('machcheck: FAIL（' + fails + ' 处问题）')
writeFileSync(OUT1, out.join('\n') + '\n')
process.exit(fails === 0 ? 0 : 1)
