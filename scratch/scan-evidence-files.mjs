/**
 * 台账里每个 ✅ 行**引用的文件**还存在吗？—— 从"坐标"再往前一步
 *
 * ## 为什么这是下一层
 *
 * 上一批我钉住的是**行号**（`path:line` 落在实处）。但一条 ✅ 行的证据通常是
 * **一整个文件**（"见 `product/launcher/foo.test.mjs`"）。
 * 那个文件被改名/删除/挪走之后，**行还在、✅ 还在、句子一个字都没变**，
 * 而它指向的东西已经没了。
 *
 *   > 一个"证据存在且通过"的 ✅，与一个"证据文件早就不在了"的 ✅，
 *   > 在台账里长得一模一样——**而后者更常见，因为它只需要一次重命名。**
 *
 * ## ★★ 第一版报出 20+ 个"不存在"——而它们几乎全是我的解析器造的
 *
 * 这是本会话**第五次**同一个形状。第一版的两个错：
 *
 *   ① **裸文件名**（`audit.mjs` / `package.mjs` / `manifest.mjs`）没有做后缀匹配，
 *      于是 `runtime/…/audit.mjs` 这类真实文件被判成"不存在"
 *      ——与上一批 `plugins/root-row.mjs`、上上批 `index.ts:2219` 是同一个错；
 *   ② **把散文里的示例当成了引用**：`secrets/credentials.json`、
 *      `x.credentials.yaml`、`notcredentials.yaml` —— 那三个是**说明脱敏规则时举的例**。
 *
 *   > 一个"证据文件不见了"与一个"我把举例当成了引用"，
 *   > 在第一版的输出里长得一模一样——**而且后者还会点名到具体任务行**。
 *
 * ⇒ 第二版：后缀索引（唯一命中才算）+ **示例词表**（举例外形的名字一律排除，
 *   并**如实计数**排除了多少条，不静默丢掉）。
 *
 * ## ⚠️ 这个脚本只查**一半**，另一半要人
 *
 * 它只回答"被引用的文件还在不在"。**不**回答：
 *   · 那个文件现在还**通过**吗（要跑起来才知道）；
 *   · 那个文件里的用例**仍然覆盖**这条 ✅ 声称的事吗。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LEDGER = join(ROOT, 'docs/superpowers/prt/PRT-PROGRESS.md')
const text = readFileSync(LEDGER, 'utf8')
const DSH = process.env.DSH_CHECKOUT ?? 'D:/project/DSH/dsh/deepseek-harness'

const SKIP = new Set(['.git', 'node_modules', '.ci', 'scratch', 'dist', 'build', '.dsh',
  'coverage', '.worktrees', '.legion-worktrees', 'releases', '.skills-cache', '.turbo'])

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
      if (e.isDirectory()) { walk(join(dir, e.name), r, depth + 1); continue }
      const key = r.toLowerCase()
      byPath.set(key, join(dir, e.name))
      const parts = key.split('/')
      for (let i = parts.length - 1, n = 0; i >= 0 && n < 6; i--, n++) {
        const suf = parts.slice(i).join('/')
        if (!bySuffix.has(suf)) bySuffix.set(suf, [])
        bySuffix.get(suf).push(join(dir, e.name))
      }
    }
  }
  walk(root, '', 0)
  return { byPath, bySuffix }
}

process.stderr.write('索引…\n')
const legion = indexTree(ROOT, 8)
const dsh = existsSync(DSH) ? indexTree(DSH, 12) : null
process.stderr.write(`  legion ${legion.byPath.size} / dsh ${dsh ? dsh.byPath.size : '（不在）'}\n`)

/** ① 只收**看起来像仓库内路径**的：至少一层目录，或以已知目录名开头。 */
function looksLikeRepoPath(p) {
  return p.includes('/')
}

/**
 * ② **示例词表**：这些名字在台账里是"举例外形"，不是"指向某个文件"。
 * ★ 用**精确名**而不是"含 credentials 就排除"——后者会把真的
 *   `security/secrets/dsh-credentials.mjs` 一起误伤（那种过宽的键正是前几次的错）。
 */
const EXAMPLE_NAMES = new Set([
  'secrets/credentials.json', 'x.credentials.yaml', 'notcredentials.yaml',
])

const isRow = (l) => /^\|\s*PRT-\d+\s/.test(l)
const lines = text.split('\n')
const rows = lines.filter(isRow)
const byStatus = {}
for (const r of rows) {
  const s = r.split('|')[2].trim()
  byStatus[s] = (byStatus[s] ?? 0) + 1
}
const done = rows.filter((r) => r.split('|')[2].trim() === '✅')

const RE = /`([\w./@-]+\.(?:mjs|cjs|js|ts|tsx|json|yml|yaml))`/g
const allCited = new Map()
let skippedBare = new Set()
let skippedExample = new Set()

for (const r of done) {
  const id = r.split('|')[1].trim()
  for (const m of r.matchAll(RE)) {
    const p = m[1]
    if (EXAMPLE_NAMES.has(p)) { skippedExample.add(p); continue }
    if (!looksLikeRepoPath(p)) { skippedBare.add(p); continue }
    if (!allCited.has(p)) allCited.set(p, [])
    allCited.get(p).push(id)
  }
}

function locate(p) {
  const key = p.toLowerCase()
  const direct = []
  for (const t of [legion, dsh]) if (t && t.byPath.has(key)) direct.push(t.byPath.get(key))
  if (direct.length === 1) return { kind: 'ok', real: direct[0] }
  if (direct.length > 1) return { kind: 'ambiguous' }
  const cands = []
  for (const t of [legion, dsh]) {
    if (!t) continue
    const hit = t.bySuffix.get(key)
    if (hit) cands.push(...hit)
  }
  const u = [...new Set(cands)]
  if (u.length === 1) return { kind: 'ok', real: u[0] }
  if (u.length > 1) return { kind: 'ambiguous' }
  return { kind: 'missing' }
}

const missing = []
const ambiguous = []
for (const [p, ids] of allCited) {
  const r = locate(p)
  if (r.kind === 'missing') missing.push({ path: p, ids })
  else if (r.kind === 'ambiguous') ambiguous.push({ path: p, ids })
}

console.log(`\n=== 台账 ${rows.length} 行（${JSON.stringify(byStatus)}）===\n`)
console.log(`✅ 行 ${done.length} 条；带目录的引用 ${allCited.size} 个去重文件。`)
console.log(`（另有 **裸文件名** ${skippedBare.size} 个、**示例名** ${skippedExample.size} 个被排除——`
  + `下面照实印出来，不静默丢）\n`)
console.log(`  裸文件名（无目录 ⇒ 解析不到具体是哪一个，**不判定**）：`)
console.log(`    ${[...skippedBare].slice(0, 18).join('  ')}${skippedBare.size > 18 ? ' …' : ''}`)
console.log(`  示例名（散文中举的例，不是引用）：`)
console.log(`    ${[...skippedExample].join('  ')}\n`)

if (missing.length === 0 && ambiguous.length === 0) {
  console.log('★ 没有一条引用指向不存在的文件。')
} else {
  if (missing.length) {
    console.log(`★ ${missing.length} 条引用指向**不存在的文件**：\n`)
    for (const m of missing) console.log(`  ✖ ${m.path}\n      被引用于：${m.ids.join(', ')}`)
  }
  if (ambiguous.length) {
    console.log(`\n⚠️ ${ambiguous.length} 条后缀有多个候选（**不判定**）：`)
    for (const m of ambiguous) console.log(`  ? ${m.path}  → ${m.ids.join(', ')}`)
  }
}

const sampled = [...allCited.keys()].slice(0, 5)
console.log(`\n★ 正面自检（5 个应显示 ok，证明脚本真的在解析）：`)
for (const p of sampled) console.log(`  ${locate(p).kind.padEnd(10)} ${p}`)
if (allCited.size === 0) console.log('\n⚠️ 一个引用都没解析到 ⇒ 脚本没在干活')
console.log(`\n⚠️ 只判"文件在不在"。**不判**它现在还通过、也不判它仍覆盖这条 ✅ 声称的事。`)
