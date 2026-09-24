/**
 * 台账里那些 `文件:行号` 引用，**现在还指在它说的东西上吗**？
 *
 * ## 为什么这一类值得单独查
 *
 * `boundary-facts.mjs` 已钉住"文档声称的**数字** ↔ 产物真实的值"，但只管**计数**，
 * 不管**位置**。而本仓的论证大量依赖 `path:line`。行号是**最脆的引用形式**：
 * 在它上面插一行注释，它就指到别处去了，而**句子本身一个字都没变**。
 *
 *   > 一个"引用了某文件第 639 行"的论断，与一个"引用了那个文件里某处"的论断，
 *   > 在读者眼里强度完全不同——而两者在文件被改动一行之后，**看起来仍然一样**。
 *
 * ## ★★ 第一版是错的，这一版修的是**解析器**（教训写在下面）
 *
 * 第一版把路径按三种方式解析（仓内相对 / DSH 相对 / **裸文件名**）。它报出
 * 7 条 `PATH-MISSING` + 2 条 `LINE-OUT-OF-RANGE`。逐条看过之后：
 * **9 条全是解析器的错，没有一条是引用的错。**
 *
 *   · 那 7 条其实是**后缀片段**（`plugins/root-row.mjs` = `runtime/dsh-composition/plugins/root-row.mjs`），
 *     第一版没做后缀匹配；
 *   · 那 2 条按**裸文件名**撞上了同名文件（`index.ts:2219` 落在
 *     `.skills-cache/…/teamai-cli-main/src/index.ts`，那个文件才 1052 行），
 *     于是"行号超范围"报的是**另一个文件**的行号。
 *
 *   > 一个"引用坏了"与一个"我的解析器只认得三种写法"，
 *   > 在第一版的输出里长得一模一样——**而且后者还带着一个看起来很具体的数字。**
 *
 * ⇒ 这一版：先把两棵树索引成 `后缀 → 真实路径`（只收唯一命中的后缀），
 *   再做后缀匹配；**多个候选命中时如实标 `AMBIGUOUS`，不许挑一个算数**。
 *
 * ## 仍然**不做**的那一半
 *
 * 我**不**自动判断"那一行的内容是否支撑那句话"。那要逐条读上下文，机械判不了。
 * 所以本脚本的结论只能是"引用指向一个存在且在范围内的位置"，
 * **不能**升级成"引用是对的"。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DSH = 'D:/project/DSH/dsh/deepseek-harness'
const LEDGER = join(ROOT, 'docs/superpowers/prt/PRT-PROGRESS.md')
const text = readFileSync(LEDGER, 'utf8')

const SKIP = new Set(['.git', 'node_modules', '.ci', '.worktrees', '.legion-worktrees',
  'releases', '.skills-cache', 'dist', 'lib', 'coverage', '.turbo'])

/** 索引一棵树：`相对路径(小写, / 分隔)` → 绝对路径。同时记后缀表。 */
function indexTree(root, depthCap) {
  const byPath = new Map()
  const bySuffix = new Map()
  const walk = (dir, rel, depth) => {
    if (depth > depthCap) return
    let ents = []
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (SKIP.has(e.name)) continue
      const r = rel === '' ? e.name : `${rel}/${e.name}`
      const full = join(dir, e.name)
      if (e.isDirectory()) { walk(full, r, depth + 1); continue }
      const key = r.toLowerCase()
      byPath.set(key, full)
      // 后缀表：从最后一段往上逐级拼
      const parts = key.split('/')
      for (let i = parts.length - 1, n = 0; i >= 0 && n < 6; i--, n++) {
        const suf = parts.slice(i).join('/')
        if (!bySuffix.has(suf)) bySuffix.set(suf, [])
        bySuffix.get(suf).push(full)
      }
    }
  }
  walk(root, '', 0)
  return { byPath, bySuffix }
}

process.stderr.write('索引 Legion 仓…\n')
const legion = indexTree(ROOT, 8)
process.stderr.write(`  ${legion.byPath.size} 个文件\n索引 DSH 检出…\n`)
const dsh = indexTree(DSH, 12)
process.stderr.write(`  ${dsh.byPath.size} 个文件\n`)

/**
 * 解析一条引用。返回 { kind, real } 或 { kind, candidates }。
 * ★ 唯一命中的后缀才算数；多个候选如实报 AMBIGUOUS。
 */
function locate(p) {
  const key = p.replace(/\\/g, '/').toLowerCase()
  const direct = []
  for (const tree of [legion, dsh]) {
    if (tree.byPath.has(key)) direct.push(tree.byPath.get(key))
  }
  if (direct.length === 1) return { kind: 'DIRECT', real: direct[0] }
  if (direct.length > 1) return { kind: 'AMBIGUOUS', candidates: direct }

  const cands = []
  for (const tree of [legion, dsh]) {
    const hit = tree.bySuffix.get(key)
    if (hit) cands.push(...hit)
  }
  const uniqCands = [...new Set(cands)]
  if (uniqCands.length === 1) return { kind: 'SUFFIX', real: uniqCands[0] }
  if (uniqCands.length > 1) return { kind: 'AMBIGUOUS', candidates: uniqCands.slice(0, 6) }
  return { kind: 'NOT-FOUND' }
}

const RE = /(?:^|[\s`（(【\[])((?:[\w.@-]+[\\/])*[\w.@-]+\.(?:mjs|cjs|js|ts|tsx|json|yml|yaml|md)):(\d+)(?:-(\d+))?/g
const uniq = new Map()
for (const m of text.matchAll(RE)) {
  const key = `${m[1].replace(/\\/g, '/')}:${m[2]}${m[4] ? `-${m[4]}` : ''}`
  uniq.set(key, { path: m[1].replace(/\\/g, '/'), from: Number(m[2]), to: m[4] ? Number(m[4]) : Number(m[2]) })
}

const rows = []
for (const h of uniq.values()) {
  const loc = locate(h.path)
  if (loc.kind === 'NOT-FOUND') { rows.push({ ...h, status: 'NOT-FOUND' }); continue }
  if (loc.kind === 'AMBIGUOUS') { rows.push({ ...h, status: 'AMBIGUOUS', count: loc.candidates.length }); continue }
  let lines = 0
  try { lines = readFileSync(loc.real, 'utf8').split('\n').length } catch { rows.push({ ...h, status: 'READ-FAIL', real: loc.real }); continue }
  if (h.from > lines || h.to > lines) { rows.push({ ...h, status: 'LINE-OUT-OF-RANGE', real: loc.real, lines }); continue }
  rows.push({ ...h, status: 'OK', real: loc.real, lines, how: loc.kind })
}

const byStatus = {}
for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
const sorted = Object.entries(byStatus).sort((a, b) => b[1] - a[1])

console.log(`\n=== 台账里的 ${uniq.size} 条唯一 \`文件:行\` 引用 ===\n`)
console.log('按状态：')
for (const [k, v] of sorted) console.log(`  ${k.padEnd(20)} ${v}`)

const bad = rows.filter((r) => r.status !== 'OK' && r.status !== 'AMBIGUOUS')
const amb = rows.filter((r) => r.status === 'AMBIGUOUS')
if (bad.length) {
  console.log('\n★ 真的找不到的引用（需要人看）：')
  for (const r of bad) console.log(`  [${r.status}] ${r.path}:${r.from}${r.to !== r.from ? `-${r.to}` : ''}`
    + (r.lines !== undefined ? `（文件共 ${r.lines} 行）` : ''))
} else {
  console.log('\n★ 没有一条引用指向"不存在的文件"或"超范围的行号"。')
}
if (amb.length) {
  console.log(`\n⚠️ ${amb.length} 条**后缀有多个候选**，无法机械定夺（如实列出，不挑一个算数）：`)
  for (const r of amb) console.log(`  ${r.path}:${r.from}  → ${r.count} 个同名后缀`)
}
console.log('\n⚠️ 本脚本**只**判"存在且在范围内"，**不**判"那一行的内容支撑那句话"。')
console.log('   引用正确与否需要逐条读上下文——机械判不了。')
