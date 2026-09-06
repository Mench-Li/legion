// docs/T098-evidence/machcheck.mjs — T-098 批 TEST_CASES.md 自检（计数/唯一性/类别/优先级/追溯引用完整性）
// 类别按码点判定（脚本零非 ASCII 字符，避免编码差异）；运行：
//   node docs/T098-evidence/machcheck.mjs > docs/T098-evidence/01-doc-machcheck.txt
import { readFileSync } from 'node:fs'
const text = readFileSync(new URL('../TEST_CASES.md', import.meta.url), 'utf8')
const lines = text.split('\n')
// 码点：绿圈=0x1F7E2 黄圈=0x1F7E1 红圈=0x1F534
const declared = new Map() // id -> {slice, no, cat, pri, line}
for (let i = 0; i < lines.length; i++) {
  const line = lines[i]
  if (!line.startsWith('| TC-S')) continue
  const cells = line.split('|').map((x) => x.trim())
  const id = cells[1] ?? ''
  const idm = /^TC-S([0-9]+)-([0-9]+)$/.exec(id)
  if (!idm) continue
  const cp = [...(cells[2] ?? '')]
  let cat = 'unknown'
  if (cp.length > 0) {
    const c = cp[0].codePointAt(0)
    if (c === 0x1F7E2) cat = 'normal-green'
    else if (c === 0x1F7E1) cat = 'boundary-yellow'
    else if (c === 0x1F534) cat = 'exception-red'
  }
  const pri = ((cells[2] ?? '').match(/P([012])/) || [])[1] ?? '?'
  const key = id
  if (declared.has(key)) console.log('DUP:', key, 'previous line', declared.get(key).line, 'again line', i + 1)
  declared.set(key, { slice: Number(idm[1]), no: Number(idm[2]), cat, pri, line: i + 1 })
}
const refs = new Map()
for (const mm of text.matchAll(/TC-S([0-9]+)-([0-9]+)/g)) {
  const id = 'TC-S' + mm[1] + '-' + mm[2]
  refs.set(id, (refs.get(id) ?? 0) + 1)
}
const declaredIds = new Set(declared.keys())
const dangling = [...refs.keys()].filter((x) => !declaredIds.has(x))
const slices = [...new Set([...declared.values()].map((v) => v.slice))].sort((a, b) => a - b)
console.log('=== per-slice declared cases ===')
let tCat = {}, tPri = {}
for (const s of slices) {
  const rows = [...declared.values()].filter((v) => v.slice === s)
  const nums = rows.map((v) => v.no).sort((a, b) => a - b)
  const contig = nums.every((n, idx) => n === idx + 1) && rows.length === nums.length
  const cat = {}, pri = {}
  for (const v of rows) { cat[v.cat] = (cat[v.cat] ?? 0) + 1; pri[v.pri] = (pri[v.pri] ?? 0) + 1 }
  console.log('S' + s + ': count=' + rows.length + ' numberingContiguous01..=' + contig + ' cat=' + JSON.stringify(cat) + ' pri=' + JSON.stringify(pri))
  for (const v of rows) { tCat[v.cat] = (tCat[v.cat] ?? 0) + 1; tPri[v.pri] = (tPri[v.pri] ?? 0) + 1 }
}
console.log('=== totals ===')
console.log('declaredTotal=' + declared.size + ' uniqueIds=' + declaredIds.size + ' dup=' + (declared.size - declaredIds.size))
console.log('categoryTotal=' + JSON.stringify(tCat))
console.log('priorityTotal=' + JSON.stringify(tPri))
console.log('referencedDistinctIds=' + refs.size)
console.log('danglingRefs=' + dangling.length)
if (dangling.length) console.log('danglingList=' + dangling.join(' '))
console.log('=== verdict ===')
const ok = dangling.length === 0 && declared.size === declaredIds.size && ![...declared.values()].some((v) => v.cat === 'unknown')
console.log(ok ? 'PASS' : 'FAIL')
