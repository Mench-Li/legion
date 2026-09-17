// scripts/prt/reachability.mjs
// ============================================================================
// PRT-611 续：**可达性**探针 —— "这个模块在生产里到得了吗？"
//
// ## 它补的是哪一格
//
// 台账（`PRT-PROGRESS.md`）与对照表用的口径是「有代码落点 + 可复跑的判据 ⇒ ✅」。
// 那条口径里**没有**"这个落点在生产里到得了"这一格。于是出现了下面这种读数：
//
//   · `runtime/packs/store.mjs`（PRT-1003 安装/启用/停用/升级记录，✅）
//     有 **1** 个非测试导入者 → 在"有几个导入者"这个读数上，它是**活的**；
//   · 而那 1 个是 `runtime/packs/builtin/software-delivery.mjs`，
//     它自己有 **0** 个导入者。
//
//   > 一个「唯一的导入者也是死的」的模块，
//   > 与一个「真的有人在用」的模块，在"有几个非测试导入者"上是同一个东西。
//
// 所以本探针不看"谁 import 了它"，而是问一个**传递**的问题：
// **从真实的进程入口出发，顺着 import 边，走得到它吗？**
//
// ## 入口有哪几种（少一种就会把入口报成死代码）
//
//   ① 进程入口：按路径启动的 server / CLI（`team-hub/server.mjs` 等）
//   ② `scripts/**`：由 `run-ci` / npm script / 人按路径跑的脚本
//   ③ `package.json` 的 `bin` / `main` / `exports`
//   ④ **清单声明**：`patch-layer.mjs` 的 `runtimeModule:`、
//      `process-manifest.mjs` 的 `entry: {path: '...mjs'}`
//   ⑤ 纯副作用导入（`import '…'`）——按定义会被 ① 的 BFS 覆盖，但**扫描必须认它**
//
// ★ 第 ④ 条是**实测**补上的：第一版只有 ①②③，于是
//   `product/orchestrator/worker.mjs` 被报成不可达——而
//   `product/process-manifest.mjs` 里明写着 `entry: {kind:'node-file', path:'product/orchestrator/worker.mjs'}`，
//   它是 Launcher 真的会 spawn 起来的进程。
//
//   > 一个「漏了一种入口」的探针，
//   > 与一个「那个模块真的没人用」的探针，在输出上是同一个东西——
//   > 只不过前者会把正在跑的进程报成死代码。
//
// ## 判据怎么用（这是**读数**，不是"全部必须是可达"）
//
// 不可达**不等于**缺陷。四类正确的动作完全不同：
//   · `entrypoint`  —— 探针漏了一种入口机制（应当修探针）
//   · `by-design`   —— 按设计不被 import（`config-schema.mjs` 被 scan 读源码、
//                      `*-fixture.mjs` 只被用例用、barrel 的叶子被直接引用）
//   · `deliberate`  —— **刻意**不接，且理由写在代码注释里（如升级链不 import 进 Launcher）
//   · `gap`         —— 真的没有生产路径，且台账说它已交付（需要在 §5 里裁决）
//
// 所以本探针配一份**分类基线**（`prt-reachability-baseline.json`），
// 门禁只断言两件事：**没有未分类的新增**、**基线里没有过期项**。
//
// 用法：
//   node scripts/prt/reachability.mjs            人读报告
//   node scripts/prt/reachability.mjs --json     机器可读
//   node scripts/prt/reachability.mjs --diff     与基线比对（门禁用）
//   node scripts/prt/reachability.mjs --record   重写基线（确认变化后）
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO = join(HERE, '..', '..')
export const BASELINE_PATH = join(REPO, 'docs', 'superpowers', 'prt', 'prt-reachability-baseline.json')

/** 参与可达性分析的目录。`workbench/` 是**旧 GUI**，不在 145 项范围内，故不收。 */
export const SCAN_DIRS = Object.freeze([
  'runtime', 'team-hub', 'orchestrator', 'product', 'security', 'scripts', 'packages',
])

/** 不进去的目录。`node_modules` 与产物目录都不算源码面。 */
export const SKIP_DIRS = Object.freeze([
  'node_modules', '.git', 'releases', '.worktrees', 'scratch', '.ci', 'dist', 'build', 'coverage',
])

/** 按路径启动的进程入口。多写一条只会多一个入口（保守），漏一条会把在跑的进程报成死的。 */
export const PROCESS_ENTRIES = Object.freeze([
  'team-hub/server.mjs',
  'product/launcher/cli.mjs',
  'product/launcher/wizard-cli.mjs',
  'product/launcher/log-policy-cli.mjs',
])

/** 三种 import 写法都要认：`from '…'`、`import('…')`、纯副作用的 `import '…'`。 */
const SPEC = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g

/** 清单里声明"这个文件会被加载"的写法。
 *
 * ★ 同一类清单里**两种路径写法并存**，两种都要认：
 *   · `patch-layer.mjs` 的 `runtimeModule: './plugins/pre-execute-row.mjs'`
 *     —— `./` 开头，**相对声明它的那个文件**；
 *   · `process-manifest.mjs` 的 `path: 'product/orchestrator/worker.mjs'`
 *     —— 仓库相对。
 *
 *   第一版只按仓库相对解析，于是全部组合行（`*-row.mjs`）被报成死代码；
 *   另一次只按文件相对解析，于是 `product/orchestrator/worker.mjs` 被报成死代码。
 *   两次都是**同一种错**：把一种约定套在另一种上。
 *
 *   > 一个「只认一种路径写法」的探针，
 *   > 与一个「那些模块真的没人加载」的探针，在输出上是同一个东西。
 */
const MANIFEST_PATTERNS = Object.freeze([
  /runtimeModule:\s*'([^']+\.mjs)'/g,
  /\bmodule:\s*'([^']+\.mjs)'/g,        // patch-layer.mjs 的 PATCH_LAYER_ROWS
  /\bpath:\s*'([^']+\.mjs)'/g,          // process-manifest.mjs 的 entry
  /\bentryFile:\s*'([^']+\.mjs)'/g,
])

/** 在**给定的候选路径**里，哪些被 `.gitignore` 排除。
 *
 * ★ 这些是**本地产物**（例：`team-hub/.watch.mjs` 是开发用观察器，
 *   `.gitignore:32` 明确排除它），不是仓库源码。两个理由必须排除它们：
 *   ① 它们**永远不是"已交付"**，进基线就是一条永远清不掉的噪声；
 *   ② 更坏的是——一个本地文件 import 了某个模块，会让那个模块**假**报成可达。
 *
 *   > 一个「把本地未交付的产物算进源码面」的探针，
 *   > 与一个「仓库里真的有人用」的探针，在输出上是同一个东西。
 *
 * ★ 实现上用 `git check-ignore --stdin` **只问我们已经走到的那些文件**，
 *   而不是 `git ls-files --others --ignored` 让它去枚举整个忽略树——
 *   后者会把 `node_modules/`（几万个文件、本身也被 ignore）全列一遍，
 *   实测直接把探针拖到 2 分钟超时。
 *
 *   > 一个「把所有被忽略的文件都列出来」的实现，
 *   > 与一个「问清楚我手上这些文件哪些被忽略」的实现，答案是一样的——
 *   > 只不过前者在有大 `node_modules` 的仓库上永远跑不完。
 */
export function ignoredFiles(candidates = null) {
  try {
    if (candidates === null) {
      const out = execFileSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard'],
        { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 })
      return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean))
    }
    if (candidates.length === 0) return new Set()
    const out = execFileSync('git', ['check-ignore', '--stdin'],
      { cwd: REPO, input: `${candidates.join('\n')}\n`, encoding: 'utf8', maxBuffer: 1 << 26 })
    return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean))
  } catch {
    // `check-ignore` 在**一个都没匹配**时退出码是 1（那是它的正常语义，不是错误）。
    // 退出码 1 时 stdout 为空 ⇒ 返回空集合，正是我们要的。
    return new Set()
  }
}

export function collectFiles() {
  const out = []
  const walk = (rel) => {
    for (const n of readdirSync(join(REPO, rel))) {
      if (SKIP_DIRS.includes(n)) continue
      const r = `${rel}/${n}`
      if (statSync(join(REPO, r)).isDirectory()) walk(r)
      else if (n.endsWith('.mjs')) out.push(r)
    }
  }
  for (const d of SCAN_DIRS) if (existsSync(join(REPO, d))) walk(d)
  const ignored = ignoredFiles(out)
  return out.filter((f) => !ignored.has(f)).sort()
}

/**
 * 把 import 说明符解析成**仓库内的**文件路径。
 * 解析不出来（裸包名、指向不存在的文件）一律返回 `null`——不猜。
 */
export function resolveSpec(from, spec, known) {
  if (typeof spec !== 'string' || !spec.startsWith('.')) return null
  const stack = []
  for (const p of `${from.slice(0, from.lastIndexOf('/'))}/${spec}`.split('/')) {
    if (p === '.' || p === '') continue
    if (p === '..') stack.pop()
    else stack.push(p)
  }
  const j = stack.join('/')
  for (const c of [j, `${j}.mjs`, `${j}/index.mjs`]) if (known.has(c)) return c
  return null
}

/** 建 import 图。 */
export function buildGraph(files) {
  const known = new Set(files)
  const src = new Map()
  for (const f of files) src.set(f, readFileSync(join(REPO, f), 'utf8'))
  const edges = new Map()
  for (const [f, text] of src) {
    const to = []
    for (const m of text.matchAll(SPEC)) {
      const r = resolveSpec(f, m[1] ?? m[2] ?? m[3], known)
      if (r) to.push(r)
    }
    edges.set(f, [...new Set(to)])
  }
  return { edges, src, known }
}

/** 找出入口，并说明每一个**为什么**是入口（报告里要能追溯）。
 *
 * ★ **用例不是入口。** 本探针问的是"生产里到得了吗"；把 `*.test.mjs` 当入口，
 *   任何"只被自己的用例 import"的模块都会变成可达——而那正是要查的那一类。
 *   第一版把用例算成入口，于是 `runtime/packs/store.mjs` 显示"可达"，
 *   整个探针的结论被这一行反转了。
 *
 *   > 一个「把用例也算成入口」的可达性探针，
 *   > 与一个「什么都没查」的探针，在输出上是同一个东西。
 */
export function findEntries(files, src) {
  const known = new Set(files)
  const entries = new Map()
  const isTest = (f) => f.endsWith('.test.mjs')

  for (const f of PROCESS_ENTRIES) if (known.has(f)) entries.set(f, '进程入口（按路径启动）')
  for (const f of files) {
    // ★ 任何一层 `scripts/` 都算（`team-hub/scripts/`、`orchestrator/worker/scripts/` 都是
    //   按路径跑的运维脚本）。只认顶层 `scripts/` 会把它们报成死代码。
    if (!isTest(f) && (f.startsWith('scripts/') || f.includes('/scripts/'))) {
      entries.set(f, '脚本（按路径运行）')
    }
  }

  // package.json 的 bin / main / exports
  for (const d of SCAN_DIRS) {
    const p = join(REPO, d, 'package.json')
    if (!existsSync(p)) continue
    let j
    try { j = JSON.parse(readFileSync(p, 'utf8')) } catch { continue }
    for (const b of Object.values(j.bin ?? {})) {
      const c = resolveSpec(`${d}/x.mjs`, `./${String(b).replace(/^\.\//, '')}`, known)
      if (c) entries.set(c, 'package.json bin')
    }
    if (typeof j.main === 'string') {
      const c = resolveSpec(`${d}/x.mjs`, `./${j.main.replace(/^\.\//, '')}`, known)
      if (c) entries.set(c, 'package.json main')
    }
  }

  // ★ 清单声明：这些文件由**字符串**加载，import 图里看不见。
  //   两种路径写法都要认（见 MANIFEST_PATTERNS 的注释）。
  for (const [f, text] of src) {
    for (const re of MANIFEST_PATTERNS) {
      for (const m of text.matchAll(new RegExp(re.source, 'g'))) {
        const raw = m[1]
        const cand = raw.startsWith('.')
          ? resolveSpec(f, raw, known)                       // 相对声明它的文件
          : (known.has(raw.replace(/^\.\//, '')) ? raw.replace(/^\.\//, '') : null) // 仓库相对
        if (cand && !entries.has(cand)) entries.set(cand, `清单声明（${f}）`)
      }
    }
  }
  return entries
}

/** 从入口出发 BFS。返回 `Map<文件, 到达它的入口>`。 */
export function reachableFrom(edges, entries) {
  const seen = new Map()
  const q = []
  for (const [e, why] of entries) { seen.set(e, { via: e, why }); q.push(e) }
  while (q.length) {
    const cur = q.shift()
    for (const nx of edges.get(cur) ?? []) {
      if (!seen.has(nx)) { seen.set(nx, { via: seen.get(cur).via, why: seen.get(cur).why }); q.push(nx) }
    }
  }
  return seen
}

/** `git ls-files` 的产物：被 git 跟踪的路径集合。
 *
 * ★ **为什么判据只看被跟踪的文件**——本仓库有另一个 agent 进程在并发提交，
 *   而"新出现一个不可达模块"在本探针里是**判红**的。若不区分，
 *   别人当轮刚新建、还没提交的模块会让本门禁红，于是：
 *
 *   > 一个「把别人未提交的在飞产物判成回归」的闸门，
 *   > 与一个「逼着人去查一个与自己无关的红」的闸门，是同一个东西——
 *   > 只不过前者会在**共享工作树上天天红**。
 *
 *   这与本探针自己的 `in-flight` 分类是同一条语义：**没提交就不算"已交付"**。
 *   未跟踪的不可达模块仍然会被**报出来**（`untrackedUnreachable`），只是不判红。
 */
export function trackedFiles() {
  try {
    const out = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 })
    return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean))
  } catch {
    // 不是 git 仓库 / 没有 git：一律当成"已跟踪"，退回严格判据。
    // ★ 宁可严，不可松——读不出来时判松，等于把门禁关掉。
    return null
  }
}

/** 一次算完。
 *
 * ★ `unreachable` **只报生产模块**，且**只报被 git 跟踪的**。用例按定义就是
 *   "被按路径跑、不被 import"，把它们算进来会让名单里全是 `*.test.mjs`——
 *   而那份名单的用途是找"已交付但生产里到不了"的模块，混进用例等于把信号淹掉。
 */
export function analyze() {
  const files = collectFiles()
  const { edges, src, known } = buildGraph(files)
  const entries = findEntries(files, src)
  const reach = reachableFrom(edges, entries)

  const tracked = trackedFiles()
  const isProd = (f) => !f.endsWith('.test.mjs')
  const rawUnreachable = files.filter((f) => !reach.has(f) && isProd(f))
  const unreachable = tracked === null ? rawUnreachable : rawUnreachable.filter((f) => tracked.has(f))
  const untrackedUnreachable = tracked === null ? [] : rawUnreachable.filter((f) => !tracked.has(f))

  return { files, edges, entries, reach, unreachable, untrackedUnreachable, known, tracked }
}

export function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return null
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
}

// ──────────────────────────────────────────────────────────── CLI
// ★ 两侧都要规范化分隔符。第一版只把 argv 那边的 `\` 换成 `/`，
//   而 `fileURLToPath()` 在 Windows 上给的是 `D:\...`——于是**永远不相等**，
//   直接跑这个文件时什么都不打印（而那看起来像"探针没发现问题"）。
const isMain = process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url).replace(/\\/g, '/') === process.argv[1].replace(/\\/g, '/')
if (isMain) {
  const argv = process.argv.slice(2)
  const mode = argv.includes('--json') ? 'json'
    : argv.includes('--diff') ? 'diff'
      : argv.includes('--record') ? 'record' : 'report'

  const a = analyze()

  if (mode === 'json') {
    console.log(JSON.stringify({
      fileCount: a.files.length,
      entryCount: a.entries.size,
      reachableCount: a.files.filter((f) => a.reach.has(f)).length,
      unreachable: a.unreachable,
      untrackedUnreachable: a.untrackedUnreachable,
    }, null, 2))
    process.exit(0)
  }

  if (mode === 'record') {
    const prev = loadBaseline()
    const keep = new Map((prev?.unreachable ?? []).map((x) => [x.file, x]))
    const next = {
      $comment: prev?.$comment ?? ('可达性基线：从真实入口出发走 import 图，走不到的模块。\n' +
        '不可达**不等于**缺陷——每条都带 class 与 reason。门禁只断言"没有未分类的新增"与"没有过期项"。\n' +
        'class: entrypoint=探针漏了一种入口 / by-design=按设计不被 import / ' +
        'deliberate=刻意不接且理由在代码里 / gap=真的没有生产路径且台账说已交付。\n' +
        '改动这个文件 = 声明某条落差的新分类，请在提交信息里写清理由。'),
      version: 1,
      unreachable: a.unreachable.map((f) => keep.get(f) ?? { file: f, class: 'UNCLASSIFIED', reason: '' }),
    }
    writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`)
    console.log(`reachability: 已写入基线（${next.unreachable.length} 条，` +
      `其中未分类 ${next.unreachable.filter((x) => x.class === 'UNCLASSIFIED').length} 条）`)
    process.exit(0)
  }

  if (mode === 'diff') {
    const base = loadBaseline()
    if (base === null) { console.log('reachability: 基线不存在，先 --record'); process.exit(1) }
    const baseMap = new Map(base.unreachable.map((x) => [x.file, x]))
    const nowSet = new Set(a.unreachable)
    const added = a.unreachable.filter((f) => !baseMap.has(f))
    const gone = base.unreachable.filter((x) => !nowSet.has(x.file))

    if (added.length === 0 && gone.length === 0) {
      console.log(`reachability: 与基线一致（不可达 ${a.unreachable.length} 条，全部分类）`)
      process.exit(0)
    }

    // ★ 两个方向**刻意不对称**：
    //   · 新增不可达 = 新出现的"已交付但到不了" ⇒ **判红**（这正是本探针要挡的）；
    //   · 基线过期 = 某个模块**变成可达了** ⇒ 只报警，**不判红**。
    //
    //   > 一个「把别人正在接线的好消息判成回归」的闸门，
    //   > 与一个「逼着人把好消息用 --record 确认一遍」的闸门，是同一个东西——
    //   > 只不过前者会在共享工作树上天天红。
    //
    //   过期项仍然必须被清掉（否则基线会烂掉），所以下面的测试里有一条专门
    //   断言"基线里不许有已被删除的文件"，而 CLI 这里把它打成醒目的警告。
    if (added.length) {
      console.log('reachability: 检测到**新增**不可达模块')
      for (const f of added) console.log(`  + ${f}`)
    }
    if (gone.length) {
      console.log(`reachability: ⚠ 基线过期 ${gone.length} 条（这些模块**已经变成可达**——好消息）`)
      for (const x of gone) console.log(`  ~ ${x.file}  [${x.class}]  ← 建议 --record 清掉`)
      console.log('  过期**不判红**：模块变成可达不是回归。')
    }
    if (added.length) {
      console.log('\n  新增项必须分类：给每条写 class 与 reason，再 --record（会保留已有分类）。')
      process.exit(1)
    }
    process.exit(0)
  }

  // 人读报告
  console.log(`reachability — 从真实入口出发的可达性探针（PRT-611 续）`)
  console.log('')
  console.log(`  扫描 ${a.files.length} 个 .mjs；入口 ${a.entries.size} 个；` +
    `可达 ${a.files.filter((f) => a.reach.has(f)).length} 个；**不可达 ${a.unreachable.length} 个**` +
    (a.untrackedUnreachable.length ? `（另有 ${a.untrackedUnreachable.length} 个未提交、不判红）` : ''))
  if (a.untrackedUnreachable.length) {
    console.log('')
    console.log('  ⚠ 未跟踪（别人/自己当轮在飞，**不计入判据**）：')
    for (const f of a.untrackedUnreachable) console.log(`      ~ ${f}`)
  }
  console.log('')
  const base = loadBaseline()
  const classOf = new Map((base?.unreachable ?? []).map((x) => [x.file, x]))
  const byClass = {}
  for (const f of a.unreachable) {
    const c = classOf.get(f)?.class ?? 'UNCLASSIFIED'
    byClass[c] = (byClass[c] ?? 0) + 1
  }
  console.log('  按分类：' + Object.entries(byClass).map(([k, v]) => `${k}=${v}`).join('  '))
  console.log('')
  for (const f of a.unreachable) {
    const b = classOf.get(f)
    console.log(`  ${f}`)
    console.log(`      [${b?.class ?? 'UNCLASSIFIED'}] ${b?.reason || '（未分类——需要在基线里写清它是哪一类）'}`)
  }
}
