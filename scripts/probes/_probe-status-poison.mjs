// scripts/probes/_probe-status-poison.mjs —— 第 45 轮：给每个**台账解析器**喂一个第 5 个状态标记
//
// ★ 起因（第 44 轮）：`boundary-facts` 的 `tallyLedger` 只认 `✅|⏸|⬜`，
//   认不出 **🟡** 就 `continue` ⇒ 它报 **144**，而台账有 **145** 条。
//   最坏的地方不是少算一条，而是**少算出来的那个数正好能过门禁**
//   （`derive` 给 144，报告里写「144 行」就判绿）。
//
//   修法是"认不出来就**抛**"。⇒ 本轮问的是**同一个问题的其余实例**：
//
//     还有几个台账解析器，认不出一个状态标记时会**静默丢掉那一行**？
//
// ★ 为什么这个问题是可证伪的：不需要等真的出现第 5 个状态。
//   往一份**合成台账**里放一个今天不存在的标记（🔵），
//   然后看每个解析器的**行数**有没有少——少了就是静默跳过。
//
//   > 一个"认不出的标记就跳过"的解析器，在今天**不会**被任何真实输入触发，
//   > 所以它在今天与一个正确的解析器读数**完全一样**；
//   > 而"要不要在台账里加第 5 个状态"这件事一旦发生，
//   > 那些解析器会**同时**安静地少算——而不是报错。
//
//   这与第 42 轮 `WRITABLE_ROLES`、第 43 轮 `BPE_ARTIFACT_FIELDS` 是**同一个形状**：
//   一张"看起来可扩展"的清单，扩展时**静默失效**。
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'poison-'))
// ★ `progress-check.parseProgress` **只收 `## 阶段 N：…` 之下的行**——
//   所以合成台账必须带那行标题，否则它数出 0 行，
//   而"0 行 vs 0 行"是一个**假对照**（两边都没在看东西）。
//   ⚠️ 本探针第一版就是那样：它把 `progress-check` 报成"读数不变"，
//      而真相是它**一行都没解析**。探针自己也会假绿。
const HEADER = [
  '# PRT 任务进度表',
  '',
  '## 阶段 0：冻结基线（0/4）',
  '',
  '| 任务 | 状态 | 证据 |',
  '| --- | --- | --- |',
]
// ★ 四行：三行用今天**认得**的标记、一行用**第 5 个**（🔵）。
//   两个版本只差第四行的那个字符。
const KNOWN_TAIL = [
  '| PRT-001 甲 | ✅ | `a.md` |',
  '| PRT-002 乙 | ⏸ | `b.md` |',
  '| PRT-003 丙 | ⬜ | `c.md` |',
]
const poisonPath = join(dir, 'poison.md')
const controlPath = join(dir, 'control.md')
writeFileSync(poisonPath, [...HEADER, ...KNOWN_TAIL, '| PRT-004 丁 | 🔵 | `d.md` |'].join('\n'))
writeFileSync(controlPath, [...HEADER, ...KNOWN_TAIL, '| PRT-004 丁 | ✅ | `d.md` |'].join('\n'))

const R = (m) => `file:///D:/project/DSH/legion/${m}`
const { tallyLedger } = await import(R('scripts/prt/boundary-facts.mjs'))
const { ledgerEvidenceRows } = await import(R('scripts/prt/ledger-evidence.mjs'))
const { ledgerRows } = await import(R('scripts/prt/intervention-coverage.mjs'))
const { parseProgress } = await import(R('scripts/prt/progress-check.mjs'))

/** 跑一个解析器，返回 `{rows, threw}`。★ 抛也是**好**结果——那是"不许静默"。 */
function run(fn, path) {
  try {
    const out = fn(path)
    // ★ `parseProgress` 返回的是 `{phases, lines, rowProblems}`，不是行数组。
    //   直接 `Array.isArray` 判会把它读成"1 行"，于是"保住了那一行"与
    //   "丢了一行"都是 1——**这个探针第一版就是这么错的**。
    //   ⇒ 按名字认形状：有 `phases` 就数 `tasks`。
    if (out !== null && typeof out === 'object' && Array.isArray(out.phases)) {
      return { rows: out.phases.reduce((n, p) => n + p.tasks.length, 0), threw: null }
    }
    return { rows: Array.isArray(out) ? out.length : 1, threw: null }
  } catch (e) {
    return { rows: null, threw: String(e.message).slice(0, 70) }
  }
}

const CASES = [
  ['boundary-facts.tallyLedger（看 total）', (p) => {
    const r = tallyLedger(readFileSync(p, 'utf8'))
    return [r] // 返回一行"读数"，行数固定 1；真正的读数在下面的 total 那一节
  }],
  ['ledger-evidence.ledgerEvidenceRows', ledgerEvidenceRows],
  ['intervention-coverage.ledgerRows', ledgerRows],
  ['progress-check.parseProgress（数 tasks）', (p) => parseProgress(readFileSync(p, 'utf8'))],
]

console.log('第 45 轮探针：往合成台账里放一个**第 5 个**状态标记（🔵），看谁静默丢行\n')
console.log('  合成台账：4 个 `| PRT-` 行；两版只差第 4 行的标记（✅ vs 🔵）\n')
console.log('  解析器                                    对照(✅)   毒药(🔵)   判定')
console.log('  ' + '─'.repeat(74))

let silent = []
for (const [name, fn] of CASES) {
  const ctl = run(fn, controlPath)
  const poi = run(fn, poisonPath)
  let verdict
  if (poi.threw !== null) verdict = '✔ 抛（不许静默）'
  else if (poi.rows === ctl.rows) verdict = '✔ 读数不变'
  else { verdict = `✖ **静默丢行**（少了 ${ctl.rows - poi.rows}）`; silent.push(name) }
  const fmt = (r) => (r.threw !== null ? 'threw' : String(r.rows))
  console.log(`  ${name.padEnd(40)} ${fmt(ctl).padStart(8)} ${fmt(poi).padStart(10)}   ${verdict}`)
  if (poi.threw !== null) console.log(`  ${''.padEnd(40)} ⇒ ${poi.threw}`)
}

// `tallyLedger` 单独看：它的"行数"恒为 1，真正要看的是 `total`。
console.log('\n  `tallyLedger` 的 `total`（这才是它的读数）：')
for (const [tag, p] of [['对照(✅)', controlPath], ['毒药(🔵)', poisonPath]]) {
  try {
    const t = tallyLedger(readFileSync(p, 'utf8'))
    console.log(`    ${tag}: ${JSON.stringify(t)}`)
  } catch (e) {
    console.log(`    ${tag}: threw —— ${String(e.message).slice(0, 80)}`)
  }
}

console.log(`\n  汇总：**${silent.length}** 个解析器会静默丢行`)
for (const s of silent) console.log(`    ✖ ${s}`)
if (silent.length === 0) console.log('    （没有——认不出的状态一律**抛**，不再安静跳过）')
