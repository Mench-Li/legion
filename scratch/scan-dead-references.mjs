/**
 * 台账引用的文件，**在别人的克隆里**还在吗？—— 判"死引用"
 *
 * ## 这一问比"文件在不在"更要紧
 *
 * 本仓的工作树与**仓库**不是一回事：`scratch/` 里的复现脚本
 * **本机存在、git 不跟踪**。于是：
 *
 *   > 一条引用了未跟踪文件的 ✅，在我这里是"可复现的"，
 *   > 在任何人克隆出来的那份里是**一句无法执行的话**——
 *   > 而两者在台账里长得一模一样。
 *
 * 这正是另一会话在 `ba554a8` 修过的那一类（"此前 20 处引用全是**死引用**"）。
 * 本版把它**量化**，并区分三种坏法：
 *
 *   · **不存在**：两个仓、本机磁盘都没有 ⇒ 引用坏了；
 *   · **只有本机有**：本机有、两个仓都没有 ⇒ **死引用**（别人的克隆里跑不了）；
 *   · 唯一命中不了（多个同名后缀）⇒ **不判定**。
 *
 * ## ★★★ 前六版都栽在同一个地方，把规则写死在这里
 *
 * 本会话我已经**六次**把"我的解析器只认得某种写法"报成"别人的引用坏了"。
 * 第六次的两次具体错法（都是这一版要修的）：
 *
 *   ① **后缀片段**：`plugins/root-row.mjs` 实为
 *      `runtime/dsh-composition/plugins/root-row.mjs`；
 *   ② ★ **两个仓**：`packages/bundle/acp-app/package.json` 是 **DSH 检出**里的文件，
 *      它在 **DSH 那个 git 仓**里是被跟踪的，而我只查了 Legion 的 `git ls-files`
 *      ⇒ 于是"另一个仓的**正常**引用"被渲染成了"只有我这儿有"。
 *
 *   > 一个"引用了另一个仓的文件"与一个"引用了只有本机存在的文件"，
 *   > 在只查一个仓的输出里长得一模一样——
 *   > **而修法相反**：前者什么都不用做，后者要提交或改引用。
 *
 * ⇒ 规则：
 *   ① 判定前先按 **`仓内精确 → 仓内后缀 → 另一个仓精确 → 另一个仓后缀`** 解析；
 *   ② 只认**唯一**命中，多个候选如实报 `AMBIGUOUS`（**不挑一个算数**）；
 *   ③ **裸文件名一律不判定**——它本来就指不到唯一一个文件；
 *      宁可少判，不要用噪声换覆盖率；
 *   ④ 每条判定必须能回答"**凭什么**"，所以下面把"在哪找到的"单列一栏。
 *
 * ## ⚠️ 它判不了什么
 *
 * 不判"那个文件现在还通过"、不判"它仍覆盖这条 ✅ 声称的事"。
 * 只判"这个坐标在**别人的克隆**里能不能落地"。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LEDGER = join(ROOT, 'docs/superpowers/prt/PRT-PROGRESS.md')
const text = readFileSync(LEDGER, 'utf8')
const DSH = process.env.DSH_CHECKOUT ?? 'D:/project/DSH/dsh/deepseek-harness'
const DSH_EXISTS = existsSync(DSH)

function gitFiles(cwd) {
  try {
    return execFileSync('git', ['ls-files'], { cwd, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
      .split('\n').filter(Boolean).map((s) => s.trim())
  } catch { return [] }
}

/** 一个"坐标空间"：跟踪集 + 后缀表。`kind` 只用于把"凭什么"印出来。 */
function spaceFrom(files, kind) {
  const byPath = new Map()
  const bySuffix = new Map()
  for (const f of files) {
    const key = f.toLowerCase()
    if (!byPath.has(key)) byPath.set(key, f)
    const parts = key.split('/')
    for (let i = parts.length - 1, n = 0; i >= 0 && n < 6; i--, n++) {
      const suf = parts.slice(i).join('/')
      if (!bySuffix.has(suf)) bySuffix.set(suf, [])
      bySuffix.get(suf).push(f)
    }
  }
  return { kind, byPath, bySuffix }
}

/** 磁盘索引（含 scratch/）——只用来区分"只有本机有"与"哪儿都没有"。 */
function diskIndex(root, depthCap) {
  const SKIP = new Set(['.git', 'node_modules', '.worktrees', '.legion-worktrees'])
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
      const parts = key.split('/')
      for (let i = parts.length - 1, n = 0; i >= 0 && n < 6; i--, n++) {
        const suf = parts.slice(i).join('/')
        if (!bySuffix.has(suf)) bySuffix.set(suf, [])
        bySuffix.get(suf).push(join(dir, e.name))
      }
    }
  }
  walk(root, '', 0)
  return { bySuffix }
}

const legionRepo = spaceFrom(gitFiles(ROOT), 'Legion 仓（跟踪）')
const dshRepo = DSH_EXISTS ? spaceFrom(gitFiles(DSH), 'DSH 仓（跟踪）') : null
const spaces = [legionRepo, dshRepo].filter(Boolean)
process.stderr.write('索引磁盘（用于区分"只有本机有"/"哪儿都没有"）…\n')
const diskLegion = diskIndex(ROOT, 8)
const diskDsh = DSH_EXISTS ? diskIndex(DSH, 12) : null

const isRow = (l) => /^\|\s*PRT-\d+\s/.test(l)
const rows = text.split('\n').filter(isRow)
const byStatus = {}
for (const r of rows) {
  const s = r.split('|')[2].trim()
  byStatus[s] = (byStatus[s] ?? 0) + 1
}
const done = rows.filter((r) => r.split('|')[2].trim() === '✅')

/**
 * 抓引用。
 *
 * ★★ 第七版修的是**"匹配到了更长路径的一段"**这个错：
 *   PRT-710 里那句是「默认 `<产品家目录>/secrets/credentials.json`」——
 *   那是一个**运行时默认路径模板**，不是仓库里的文件。
 *   而正则从 `secrets` 开始匹配，于是它被当成了**引用**并报"哪儿都没有"。
 *
 *   > 一个"引用了仓库里的某文件"与一个"描述运行时的默认路径"，
 *   > 在只截取路径尾巴的输出里长得一模一样——
 *   > 而**前者的坏法是改引用，后者的坏法是改判据**。
 *
 *   ⇒ 判据加一条**结构性的**约束：匹配串**左边紧邻**的字符若还是
 *   `/` 或路径字符，说明这只是更长路径的**尾巴**，**不当作独立引用**。
 *   （不是给 `secrets/credentials.json` 开白名单——那只会治一个例子。）
 */
const RE = /`([\w./@-]+\.(?:mjs|cjs|js|ts|tsx|json|yml|yaml|md))`/g
const cited = new Map()
const bareNames = new Set()
let tailFragments = new Set()

for (const r of done) {
  const id = r.split('|')[1].trim()
  for (const m of r.matchAll(RE)) {
    const p = m[1]
    // 匹配串左边的字符：反引号说明它是完整的 token；`/` 说明只是尾巴
    const before = r[m.index - 1]
    if (before === '/' || (before !== undefined && /[\w.@-]/.test(before))) {
      tailFragments.add(p); continue
    }
    if (!p.includes('/')) { bareNames.add(p); continue }
    if (!cited.has(p)) cited.set(p, new Set())
    cited.get(p).add(id)
  }
}

/**
 * 解析一条引用。
 * 顺序：Legion 精确 → Legion 后缀 → DSH 精确 → DSH 后缀；只认唯一命中。
 */
function locate(p) {
  const key = p.toLowerCase()
  const exact = []
  for (const s of spaces) if (s.byPath.has(key)) exact.push({ real: s.byPath.get(key), where: s.kind })
  if (exact.length === 1) return { kind: 'IN-REPO', ...exact[0] }
  if (exact.length > 1) return { kind: 'AMBIGUOUS', n: exact.length }

  const cands = []
  for (const s of spaces) {
    const hit = s.bySuffix.get(key)
    if (hit) for (const h of hit) cands.push({ real: h, where: s.kind })
  }
  const uniq = [...new Map(cands.map((c) => [c.real, c])).values()]
  if (uniq.length === 1) return { kind: 'IN-REPO', ...uniq[0] }
  if (uniq.length > 1) return { kind: 'AMBIGUOUS', n: uniq.length }

  // 仓库里没有 ⇒ 看磁盘（区分"只有本机"与"哪儿都没有"）
  const onDisk = []
  for (const d of [diskLegion, diskDsh].filter(Boolean)) {
    const hit = d.bySuffix.get(key)
    if (hit) onDisk.push(...hit)
  }
  if (onDisk.length > 0) return { kind: 'ON-DISK-ONLY', where: onDisk[0] }
  return { kind: 'NOT-ANYWHERE' }
}

/**
 * ★★ 对"磁盘上有、仓里没有"的那批，逐个问仓自己"是不是被有意忽略的"。
 *
 *   **构建产物不算死引用。** 实测：`plugins/lib/stateMachine.js` 与
 *   `board-plugin/lib/index.js` 都是 `src/*.ts` 的编译产物，
 *   而 `plugins/.gitignore:2: lib/` 明确忽略它们 ⇒ 引用它们是**正常**的。
 *
 *   而上一版把这种情形与"引用了只有我这儿有的证据脚本"**报成同一类**。
 *
 *   > 一个"引用了一个**生成**的东西"与一个"引用了一个**只存在于我磁盘上**的东西"，
 *   > 在只问"git 跟踪吗"的输出里长得一模一样——
 *   > 而前者什么都不用做，后者要么提交、要么改引用。
 *
 *   ★ 用 `git check-ignore` 问**仓自己**，不自己解析 `.gitignore`：
 *   忽略规则有几十种写法，自己实现一定与 git 不一致——
 *   而"我的规则与 git 的规则不一致"正是这一整节反复出现的那个错。
 *   ★ 只对**候选**逐个问（不做 `git status --ignored -uall`）：
 *   后者在 DSH 那种 19000 文件的仓上**实测跑不完**（10 分钟超时）。
 */
function classifyOnDisk(paths) {
  if (paths.length === 0) return new Map()
  const out = new Map()
  // 一次把候选喂给两个仓的 `git check-ignore --stdin`
  for (const [cwd, label] of [[ROOT, 'Legion'], [DSH, 'DSH']]) {
    if (label === 'DSH' && !DSH_EXISTS) continue
    let ignored = new Set()
    try {
      const res = execFileSync('git', ['check-ignore', '--stdin'],
        { cwd, encoding: 'utf8', input: paths.join('\n'), maxBuffer: 16 * 1024 * 1024 })
      ignored = new Set(res.split('\n').filter(Boolean).map((s) => s.trim().toLowerCase()))
    } catch (e) {
      // check-ignore 在"一个都没命中"时退出码为 1 —— 那是正常结果，不是失败
      const stdout = String(e.stdout ?? '')
      ignored = new Set(stdout.split('\n').filter(Boolean).map((s) => s.trim().toLowerCase()))
    }
    for (const p of ignored) if (!out.has(p)) out.set(p, label)
  }
  return out
}

const rowsOut = []
for (const [p, ids] of cited) {
  const r = locate(p)
  rowsOut.push({ path: p, ids: [...ids], ...r })
}

// ★ 第二步：对"磁盘上有、仓里没有"的候选问仓自己"是不是被有意忽略的"
const onDiskOnly = rowsOut.filter((r) => r.kind === 'ON-DISK-ONLY')
process.stderr.write(`对 ${onDiskOnly.length} 条候选问 git check-ignore…\n`)
const ignoredMap = classifyOnDisk(onDiskOnly.map((r) => r.path))
for (const r of onDiskOnly) {
  const who = ignoredMap.get(r.path.toLowerCase())
  r.kind = who !== undefined ? 'GITIGNORED-BUILD' : 'UNTRACKED-ONLY'
  if (who !== undefined) r.where = `${who} 的 .gitignore`
}

const by = {}
for (const r of rowsOut) by[r.kind] = (by[r.kind] ?? 0) + 1

console.log(`\n=== 台账 ${rows.length} 行（${JSON.stringify(byStatus)}）===\n`)
console.log(`✅ 行 ${done.length} 条；**带目录**的去重引用 ${rowsOut.length} 个。`)
console.log(`（另排除：**裸文件名** ${bareNames.size} 个——指不到唯一文件；`
  + `**更长路径的尾巴** ${tailFragments.size} 个——那是运行时模板不是引用）\n`)
console.log('按"在别人的克隆里能否落地"分：')
const NOTES = {
  'IN-REPO': '仓库里有 ✔（Legion 或 DSH）',
  'GITIGNORED-BUILD': '被 .gitignore 有意排除 ⇒ **正常**（构建产物）',
  'UNTRACKED-ONLY': '★★ 只有本机有 ⇒ 死引用',
  'NOT-ANYWHERE': '★ 两个仓、本机磁盘都没有 ⇒ 引用坏了',
  'AMBIGUOUS': '? 多个同名候选 ⇒ **不判定**',
}
for (const [k, v] of Object.entries(by).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(18)} ${String(v).padStart(3)}   ${NOTES[k] ?? ''}`)
}

const broken = rowsOut.filter((r) => r.kind === 'NOT-ANYWHERE')
const dead = rowsOut.filter((r) => r.kind === 'UNTRACKED-ONLY')
const amb = rowsOut.filter((r) => r.kind === 'AMBIGUOUS')
const ign = rowsOut.filter((r) => r.kind === 'GITIGNORED-BUILD')

if (broken.length) {
  console.log(`\n★ ${broken.length} 条**引用坏了**：`)
  for (const r of broken) console.log(`  ✖ ${r.path}\n      被引用于：${r.ids.join(', ')}`)
}
if (dead.length) {
  console.log(`\n★★ ${dead.length} 条**死引用**（本机有、两个仓都没有、也不被忽略 ⇒ 别人的克隆里执行不了）：`)
  for (const r of dead) console.log(`  ⚠️ ${r.path}\n      本机：${r.where}\n      被引用于：${r.ids.join(', ')}`)
}
if (ign.length) {
  console.log(`\n（${ign.length} 条引用指向**被忽略的构建产物**——正常，列出来只为让你能核这一判断：）`)
  for (const r of ign) console.log(`  · ${r.path}   ← ${r.where}   ${r.ids.join(', ')}`)
}
if (amb.length) {
  console.log(`\n? ${amb.length} 条**后缀多候选**（不判定）：`)
  for (const r of amb) console.log(`  ? ${r.path}（${r.n} 个候选）  ${r.ids.join(', ')}`)
}
if (!broken.length && !dead.length) console.log('\n★ 没有坏引用、也没有死引用。')

// ★★ 正面自检：**必须有样本落在两个不同的桶里**，否则说明这套判据分不开两种情形。
const probeTracked = 'scripts/prt/boundary-facts.mjs'
const probeDead = 'scratch/scan-evidence-files.mjs'
console.log(`\n★ 正面自检（两个探针必须**落到不同的桶**）：`)
for (const p of [probeTracked, probeDead]) {
  const r = locate(p)
  console.log(`  ${String(r.kind).padEnd(16)} ${p}${r.where ? `   ← ${r.where}` : ''}`)
}
const kinds = new Set([locate(probeTracked).kind, locate(probeDead).kind])
console.log(kinds.size >= 2
  ? '  ✔ 两个桶都走通了 ⇒ 这套判据分得开"仓里有"与"只有本机有"'
  : '  ✖ 两个探针落进同一个桶 ⇒ 这个脚本其实什么也没分开，结论不可用')
console.log(`\n⚠️ 只判"坐标在别人的克隆里能否落地"。`)
console.log(`   **不判**那个文件现在还通过、也不判它仍覆盖这条 ✅ 声称的事。`)
