// scripts/probes/_probe-generated-status-vocab.mjs —— 第 45 轮：生成物判据的**词表**有几份，差多少
//
// ★ 起因：`boundary-facts.mjs` 里**两条**判据都在管"生成物里不许出现状态词"，
//   而它们**各用一份**不同的词表；而给它们背书的那次普查用的是**第三份**。
//
//     判据 A（文件级，只钉 `legion-host.patch.yml`）:
//       `/(未完成|已完成|✅|🟡|⏸|⬜)/`                    → 2 词 + 4 标记 = 6
//     判据 B（类级，全部自称生成物的文件）:
//       `STATUS_VOCAB = ['未完成','已完成','待完成','未开始','部分完成']` → 5 词
//     普查（`scripts/probes/census-generated-status.mjs`，"只有 1 个实例"那句话的来源）:
//       `['✅','🟡','⏸','⬜','未完成','已完成','待完成','未开始','部分完成']` → 9
//
//   ⇒ 普查用的是**并集**，两条判据各用**一个子集**。
//
//   > 一次用**更大的网**做的普查，与一条用**更小的网**执行的判据，
//   > 在"结论是 0 违规"的时候是同一个读数——
//   > 只不过前者证明的是一件**更强**的事，而后者才是每天在跑的那一条。
//
// ★ 本探针量两件事：
//   ① 三份词表各含哪些、差多少；
//   ② **用并集去跑**仓库，会多出哪些违规（若有，就是判据今天漏掉的）。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const REPO = 'D:/project/DSH/legion'
const BF = `${REPO}/scripts/prt/boundary-facts.mjs`
const CENSUS = `${REPO}/scripts/probes/census-generated-status.mjs`

const bf = readFileSync(BF, 'utf8')
const census = readFileSync(CENSUS, 'utf8')

// ── ① 从三个文件里各自把词表**读出来** ──
const judgeA = /const m = \/([^/]+)\/\.exec\(ctx\.doc\(PATCH_YML\)\)/.exec(bf)
const A = judgeA === null ? [] : judgeA[1].replace(/[()]/g, '').split('|')
const judgeB = /const STATUS_VOCAB = Object.freeze\(\[([^\]]+)\]\)/.exec(bf)
const B = judgeB === null ? [] : judgeB[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''))
const cen = /const STATUS_WORDS = \[([^\]]+)\]/.exec(census)
const C = cen === null ? [] : cen[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''))

const setOf = (a) => new Set(a)
const union = [...new Set([...A, ...B, ...C])]

console.log('第 45 轮探针：生成物判据的词表有几份\n')
const show = (name, arr) => {
  console.log(`  ${name.padEnd(34)} ${String(arr.length).padStart(2)} 项  ${arr.join(' ')}`)
}
show('判据 A（文件级，patch.yml）', A)
show('判据 B（类级，词表常量）', B)
show('普查（"只有 1 个"的来源）', C)
show('★ 并集', union)

console.log('\n  ⇒ 判据 A 漏（普查有、它没有）：'
  + `${union.filter((w) => !setOf(A).has(w)).join(' ') || '（无）'}`)
console.log('  ⇒ 判据 B 漏（普查有、它没有）：'
  + `${union.filter((w) => !setOf(B).has(w)).join(' ') || '（无）'}`)

// ── ② 用**并集**去扫仓库，看比判据 B 多出什么 ──
const GENERATED_SELF = [
  /本文件由[^\n]{0,40}生成/, /\bGENERATED\b/, /不要手改|请勿手改|不要手工编辑|请勿手工编辑/,
  /\bDO NOT EDIT\b/i, /此文件(?:由|是)[^\n]{0,30}生成/,
]
const SCAN_SKIP = new Set([
  '.git', 'node_modules', '.ci', 'scratch', 'dist', 'build', '.dsh', 'coverage',
  '.worktrees', '.legion-worktrees',
])
const SCAN_EXT = /\.(mjs|js|cjs|ts|json|md|yml|yaml|txt|patch|sql)$/i

const files = []
const walk = (dir) => {
  let names
  try { names = readdirSync(dir) } catch { return }
  for (const name of names) {
    if (SCAN_SKIP.has(name)) continue
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) { walk(p); continue }
    if (!SCAN_EXT.test(name) || st.size > 2_000_000) continue
    let text
    try { text = readFileSync(p, 'utf8') } catch { continue }
    if (!GENERATED_SELF.some((re) => re.test(text.slice(0, 3000)))) continue
    files.push({ rel: relative(REPO, p).replace(/\\/g, '/'), text })
  }
}
walk(REPO)

/** 与判据 B 同形：任务号附近 60 字符内有状态词。 */
const scanWith = (vocab) => {
  const hits = []
  for (const f of files) {
    for (const w of vocab) {
      let idx = f.text.indexOf(w)
      while (idx !== -1) {
        const around = f.text.slice(Math.max(0, idx - 60), idx + w.length + 60)
        if (/PRT-\d+/.test(around)) hits.push(`${f.rel} [${w}]`)
        idx = f.text.indexOf(w, idx + 1)
      }
    }
  }
  return hits
}

const withB = scanWith(B)
const withUnion = scanWith(union)
console.log(`\n  自称生成物的文件：**${files.length}** 个`)
console.log(`  · 用**判据 B 的词表**扫：**${withB.length}** 处`)
if (withB.length > 0) for (const h of [...new Set(withB)].slice(0, 8)) console.log(`      ${h}`)
console.log(`  · 用**并集**扫：      **${withUnion.length}** 处`)
const extra = [...new Set(withUnion)].filter((h) => !new Set(withB).has(h))
console.log(`  ⇒ 判据 B **漏掉**的：**${extra.length}** 处`)
for (const h of extra.slice(0, 12)) console.log(`      ★ ${h}`)

console.log('\n  ⇒ 判定：')
if (extra.length === 0) {
  console.log('    今天没有漏（并集与判据 B 同读数）⇒ 差异**只存在于理论上**，')
  console.log('    但判据 B 的保护面**比它引用的那次普查窄**，这一点仍然要记档。')
} else {
  console.log(`    判据 B **今天就在漏** ${extra.length} 处 ⇒ 这是真缺陷，不是理论差异。`)
}
