/** 先把候选事实的**真实值**量与**文档里声称的值**都抓出来，再决定哪些进校验表。 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8')

const STATUS = read('docs/MULTI-AGENT-FEATURE-STATUS.md')
const LEDGER = read('docs/superpowers/prt/PRT-PROGRESS.md')
const baseline = JSON.parse(read('docs/superpowers/prt/prt-reachability-baseline.json'))

// ── 真实值 ────────────────────────────────────────────────────────────────
const { PATCH_LAYER_ROWS } = await import(
  pathToFileURL(resolve(ROOT, 'runtime/dsh-composition/patch-layer.mjs')).href
)
const yml = read('runtime/dsh-composition/legion-host.patch.yml')
const ymlRows = (() => {
  const lines = yml.split('\n')
  let ins = 0, po = 0, inIns = false
  for (const l of lines) {
    if (/^- /.test(l)) { inIns = /^- insert:/.test(l); if (!inIns) po++; continue }
    if (inIns && /^\s{4}- id:/.test(l)) ins++
  }
  return ins + po
})()

const ledgerRows = LEDGER.split('\n').filter((l) => /^\|\s*PRT-\d+\s/.test(l))
const statuses = ledgerRows.map((l) => l.split('|')[2].trim())
const count = (s) => statuses.filter((x) => x === s).length

const entries = baseline.entries ?? baseline.items ?? []
const un = entries.filter((e) => e.class !== undefined)
const byClass = {}
for (const e of un) byClass[e.class] = (byClass[e.class] ?? 0) + 1

const s5 = (() => {
  const lines = STATUS.split('\n')
  const i = lines.findIndex((l) => /^##\s*5\.\s/.test(l))
  let n = 0
  for (let k = i + 1; k < lines.length; k++) {
    if (/^##\s/.test(lines[k])) break
    if (/^\|\s*\d+\s*\|/.test(lines[k].trim())) n++
  }
  return n
})()

console.log('=== 真实值（从产物里推出来的）===')
console.log(`PATCH_LAYER_ROWS.length        = ${PATCH_LAYER_ROWS.length}`)
console.log(`legion-host.patch.yml 代表行数 = ${ymlRows}`)
console.log(`台账总行数                     = ${ledgerRows.length}`)
console.log(`  ✅=${count('✅')} 🟡=${count('🟡')} ⏸=${count('⏸')} ⬜=${count('⬜')}`)
console.log(`baseline entries 总数          = ${entries.length}`)
console.log(`  不可达分类：${JSON.stringify(byClass)}`)
console.log(`§5 条目数                      = ${s5}`)

// ── 文档里声称的值（把候选句子原样抓出来）────────────────────────────────
console.log('\n=== 文档里声称的句子 ===')
const probes = [
  ['PATCH_LAYER_ROWS', /只声明\s*\*\*(\d+)\*\*\s*行/],
  ['yml 行', /有\s*\*\*(\d+)\s*行\*\*的落点/],
  ['台账总数', /全\s*(\d+)\s*项/],
  ['§5 条目', /§5[^\n]{0,40}?(\d+)\s*条/],
]
for (const [label, re] of probes) {
  for (const [name, text] of [['STATUS', STATUS], ['LEDGER', LEDGER]]) {
    const m = re.exec(text)
    if (m) console.log(`  ${label.padEnd(16)} ← ${name}: ${m[1]}   「${m[0].replace(/\s+/g, ' ').slice(0, 60)}」`)
  }
}

// 可达性那组数字在哪儿说的
console.log('\n=== 可达性数字的出处 ===')
for (const n of ['527', '57', '220', '46', '13', '25', '8']) {
  const re = new RegExp(`[^。\\n]{0,55}\\b${n}\\b[^。\\n]{0,55}`, 'g')
  const hits = [...STATUS.matchAll(re)].slice(0, 1).map((m) => m[0].replace(/\s+/g, ' ').trim())
  for (const h of hits) console.log(`  ${n}: ${h.slice(0, 130)}`)
}
