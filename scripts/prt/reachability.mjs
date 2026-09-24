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
//   `product/process-manifest.mjs` 里明写着 worker 的 `entry`（`kind:'node-file'`
//   ＋ 一个**仓库相对**的 `path`；那种形状见下面的 `MANIFEST_PATTERNS`），
//   它是 Launcher 真的会 spawn 起来的进程。
//
//   ★★ 这一行原来把那种形状**照抄**在注释里。而 `MANIFEST_PATTERNS` 读的是
//   **源码文本**、分不清代码与注释 ⇒ **注释里的例子也被当成了真声明**
//   （`product/orchestrator/worker.mjs` 因此多了一个假入口）。
//   今天它恰好还有一个**真**声明（`process-manifest.mjs:278`），所以读数没变；
//   可一旦那条真声明被删，**这行注释会继续把它撑着看起来"有人加载"**。
//   ⇒ 所以这里只描述形状、不照抄带真路径的例子。
//   *一条只在"真声明也被删掉"时才显形的假信号，是这类 bug 里最贵的一种。*
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
/** 人工介入清单（§5）所在的那份文档。`gap` 的裁决处指针要能在这里解析。 */
export const MATRIX_PATH = join(REPO, 'docs', 'MULTI-AGENT-FEATURE-STATUS.md')

/** 参与可达性分析的目录。`workbench/` 是**旧 GUI**，不在 145 项范围内，故不收。
 *
 * ★★ `scrum/` 曾经**不在这张表里**，而它是**产品面**、而且**随发布物发出去**：
 *    `scripts/ci/run-ci.mjs:4781` 的 `tracked` 清单（stage 阶段算 SHA256SUMS 的那一份）
 *    逐字列着 `scrum/serve.mjs`。
 *
 *    不在表里的后果不是"少扫几个文件"，而是**一处假阳性**：
 *    `scrum/serve.mjs:38` import 的 `packages/shared/src/artifact-policy.mjs`
 *    因此被报成 `[gap] 只被自己的用例 import`——而它有两个真实消费者
 *    （另一个是 `board-plugin/src/index.ts:18`，编成未跟踪的 `lib/`）。
 *    这正是本探针最容易被信以为真的那一种结论：**把在跑的东西报成死的**。
 *
 *   > 一个"漏扫了一整个产品目录"的探针，
 *   > 与一个"那个目录里的模块真的没人加载"的探针，在输出上是同一个东西。
 *
 *    `workbench/` 与它**不是**同一个情况：那是被 145 项明确排除的旧 GUI，
 *    而 `scrum/` 是 v1 看板服务本体（`tests/contract/v1v2-contract.test.mjs`
 *    把它当契约面在测）。"没收"与"不该收"是两件事，不能共用一条理由。
 */
export const SCAN_DIRS = Object.freeze([
  'runtime', 'team-hub', 'orchestrator', 'product', 'security', 'scripts', 'packages', 'scrum',
])

/** 不进去的目录。`node_modules` 与产物目录都不算源码面。 */
export const SKIP_DIRS = Object.freeze([
  'node_modules', '.git', 'releases', '.worktrees', 'scratch', '.ci', 'dist', 'build', 'coverage',
])

/** 按路径启动的进程入口。多写一条只会多一个入口（保守），漏一条会把在跑的进程报成死的。
 *
 * ★★ `scrum/serve.mjs` 曾经**不在这张表里**，而它一直都在跑。后果不是"少一个入口"
 *    这么轻——它是一处**假阳性**，而且是本探针最忌讳的那一类：
 *
 *      `scrum/serve.mjs` 这个名字既不 `scripts/` 开头、也不含 `/scripts/`，
 *      所以上面那条"任何一层 `scripts/` 都算"的规则**够不着它**；
 *      而它 import 的 `packages/shared/src/artifact-policy.mjs`
 *      因此被报成 `[gap] 只被自己的用例 import`。
 *
 *    而那个文件**有两个真实消费者**：`scrum/serve.mjs:38` 与
 *    `board-plugin/src/index.ts:18`（后者编成 `board-plugin/lib/index.js`，
 *    未跟踪产物，import 图扫不到）。于是"谁在用它"这个问题，
 *    探针答错了一次——**而它答错的方向是"报成死代码"**，
 *    正好是这张表最容易被信以为真的那一种结论。
 *
 *    权威来源不是猜的：`scripts/ci/run-ci.mjs:4781` 的 `tracked` 清单
 *    （stage 阶段算 SHA256SUMS 的那一份）逐字列着 `scrum/serve.mjs`——
 *    也就是说，**打包发布的人一直知道它是要按路径跑的那个文件**。
 *
 *    > 一个"漏了一个进程入口"的探针，
 *    > 与一个"那些模块真的没人加载"的探针，在输出上是同一个东西——
 *    > 只不过前者会把一个正在跑的服务报成死代码，而读的人会去查那个服务。
 *
 *    钉住它的是 `reachability.test.mjs` ①-5 那条正对照（同 ①-3 的理由：
 *    两次实测都是"漏了一种入口写法"，所以每一种都要有一条对照）。
 */
export const PROCESS_ENTRIES = Object.freeze([
  'team-hub/server.mjs',
  'product/launcher/cli.mjs',
  'product/launcher/wizard-cli.mjs',
  'product/launcher/log-policy-cli.mjs',
  'scrum/serve.mjs',
  // 后两个由 `scrum/serve.mjs` **按路径 spawn** 起来
  //（`:153` `spawn(process.execPath, [TASKCTL, ...argv])`、
  //  `:176` 同一个写法跑 RENDER）——与"人工按路径启动"是同一个判据：
  //  它们**不可能**出现在任何 import 图里，而它们确实在跑。
  'scrum/taskctl.mjs',
  'scrum/render.mjs',
])

/** 三种 import 写法都要认：`from '…'`、`import('…')`、纯副作用的 `import '…'`。 */
const SPEC = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g

/** 清单里声明"这个文件会被加载"的写法。
 *
 * ★ 同一类清单里**两种路径写法并存**，两种都要认：
 *   · `patch-layer.mjs` 的 `runtimeModule` —— `./` 开头，**相对声明它的那个文件**；
 *   · `process-manifest.mjs` 的 `entry.path` —— **仓库相对**（那条真的声明在
 *     `product/process-manifest.mjs:278`，写的是 `product/orchestrator/worker.mjs`）。
 *
 * ★★ 这一行原来把两种形状**连真路径一起照抄**在注释里。而这份正则读的是
 *   **源码文本**、分不清代码与注释 ⇒ **注释里的例子变成了真声明**。
 *   ⇒ 描述形状时**不要照抄带真路径的例子**；真要给例子，就用占位路径。
 *   （判据 `criteria-files-do-not-impersonate-manifests` 现在就盯着这件事。）
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

/**
 * ★★★ 导出这份形状清单，让**别的判据能借用同一份**（2026-09-18 实测事故）。
 *
 * 起因：`scripts/prt/boundary-facts.mjs` 里加了一张「手钉坐标表」，而那张表里
 * 每一条都有个**键名**，当时取的键名正好是**下面第 3 条正则认的那个**；
 * 于是 `path: '<某个 .mjs 仓库路径>'` 被读成「**清单声明：这个模块会被加载**」
 * ⇒ **一张记账用的表，把 4 个模块假装成了生产入口。**
 * 后果有两个方向，都实测到了：
 *   · `external-api-scope.mjs`（**零个**生产 importer）被报成"已接线"⇒
 *     探针的红还**指导人去清基线、更新裁决**，等于把一个没接的模块记成接上了；
 *   · `runtime-contract-server.mjs`（§5 第 20 条说的正是"没有生产挂点"）
 *     被同一张表**遮掩**——它看起来可达，于是这个缺口不会再有人被提醒。
 *
 *   > 一个"某处声明了这个模块会被加载"与一个"某处**提到了**这个模块的坐标"，
 *   > 在只看那种键名 + `.mjs` 字面量的判据里是同一个东西——
 *   > 而前者是**接线**，后者是**记账**。
 *
 * ⇒ 修法两条：① 那张表改键名（不用清单里那几种）；
 *   ② 把这份形状清单**导出**，让"我方判据文件不得冒充清单"这条判据
 *   借用**同一份**正则——否则两份键表迟早不同步，而"两份会漂的名单"正是本仓的旧账。
 *
 * ★★ 记一笔**修这个 bug 时又踩了一次**（同一形状第五次）：
 *   我在上面这段说明里**照样写出了**那个键名 + 一个真 `.mjs` 路径做例子，
 *   于是 `findEntries` 把 **`scripts/prt/reachability.mjs` 自己**记成了
 *   `external-api-scope.mjs` 的入口——**解释这个 bug 的注释，原样复现了这个 bug**。
 *   所以上面这段文字里那个例子用的是**占位路径**，不是真路径。
 *
 *   > 与 §10.35 那条同形：*修复者解释这次位移的那句注释，
 *   > 正好把锚词种在了旧坐标上。*
 */
export { MANIFEST_PATTERNS }

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

/**
 * §5「需人工介入清单」那一段的**正文**。
 *
 * 取法是**按位置**：从 `## 5.` 那个标题往后，到下一个 `## ` 标题为止。
 *
 * ## 为什么不按"全文档所有 `| N |`"来取（试过，会错）
 *
 * 文档里至少还有三张带编号的表：
 *   · `| 1 |…| 5 |` —— 是**优先级**那一张（在 §5 之前）；
 *   · `| 13 |…| 18 |` —— 是 §5.5 的"同一决定的四个下游"那张。
 * 按全文档取，`§5 第 3 条` 会解析**成功**，而它指向的是优先级表——
 * 一个会"解析成功但指错地方"的判据，比一个解析失败的判据更坏。
 *
 * ★ 本函数是 §5 正文的**唯一**取法：`matrixItems()` 与
 *   `scripts/prt/intervention-coverage.mjs` 的 `sectionFive()` 都走它，
 *   免得两处各写一遍区间规则、然后慢慢漂移。
 */
export function sectionFiveText(path = MATRIX_PATH) {
  const lines = readFileSync(path, 'utf8').split('\n')
  const start = lines.findIndex((l) => /^##\s*5\.\s/.test(l))
  if (start < 0) return ''
  let out = ''
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break
    out += lines[i] + '\n'
  }
  return out
}

/**
 * §5「需人工介入清单」里**真实的条号**集合。
 *
 * @returns {Set<number>} 条号
 */
export function matrixItems(path = MATRIX_PATH) {
  const items = new Set()
  for (const line of sectionFiveText(path).split('\n')) {
    const m = /^\|\s*(\d+)\s*\|/.exec(line.trim())
    if (m) items.add(Number(m[1]))
  }
  return items
}

// ── §5 决策表的**状态索引**（第 55 轮）─────────────────────────────────────
//
// 起因：§5 决策表是**写给人照做的那张清单**，而它有 **29 行、5 列、没有状态列**
// ⇒ 某一行**还开不开着**，此前只能靠通读散文判出来。
//
//   > 一张"状态写在散文里"的清单，与一张"状态写在列里"的清单，
//   > 在**读者从头读到尾**的时候是同一个东西 ——
//   > 而清单存在的理由，正是**没有人会从头读到尾**。
//
// ★★ 而"扫哪一格"这个选择**真的会改答案**（实测三次）：
//
//     只扫 事项+需要谁+具体决定   ⇒ 已裁决 3 · 未标注 **26**
//     扫前 4 格（不含后果那格）   ⇒ 已裁决 3 · 未标注 **26**
//     扫整行 5 格                ⇒ 已裁决 5 · 待裁决 4 · 未标注 **20**
//
//   > 一个"状态"读数会**随扫描面**在 20 与 26 之间变动，
//   > 说明它当时还不是一个读数，只是一个印象。
//
//   ⇒ 定为**整行 5 格**：标记的位置本身不一致（`已裁决` 有时在 `需要谁` 格，
//     而 `不决定则…` 那种开口径**只**出现在 `不决定的后果` 格）。
//     掐掉后果格 ⇒ 4 条"待裁决"全部消失 ——**那是把读数改小，不是把表变准**。
//   ⇒ 规则写在这里**一处**；索引表由它派生，下面的判据核对"索引 = 今天派生出来的值"。
export const DECISION_STATE_VOCAB = Object.freeze(['已裁决', '待施工', '待裁决', '未标注'])

const DECISION_STATE_MARKS = Object.freeze({
  // ★★ 第 55 轮·订正：第一版是 `/已裁决|已执行|…/`，于是 **#28 被误判成「已裁决」**。
  //
  //   #28 那一行里写的是「各自与**已裁决事项**的关系都写清了」——
  //   `已裁决` 在这里是**名词短语的一部分**（"已裁决的事项"，指的是**别的行**），
  //   不是对**这一行**的裁决。而判据把它读成了本行的状态。
  //
  //   > 一个认不出"这一行**提到**了已裁决"与"这一行**是**已裁决"的模式，
  //   > 报出来的是"这一行已裁决" —— 而它读起来跟真的一样。
  //
  //   ★ 这与 `suite-counts` 那个坑同形（他们代码里记着：`peakResource` 是**字段名**，
  //     "判据 47 例"说的是**另一套**判据，却被提取成一条计数声明）。
  //   ⇒ 加一条否定前瞻：`已裁决` **后面不许紧跟 `事项` 或 `的`**
  //     （那两种写法都是在**指别人**）。其余形态照收：`已裁决（2026-09-18）`、`**已裁决**` 等。
  已裁决: /已裁决(?!事项|的)|已执行|已定|业主\s*20\d\d-\d\d-\d\d\s*(裁定|给)|裁定：/,
  待施工: /待施工/,
  待裁决: /待裁决|待裁|仍未接|尚未|不决定则/,
})

/** 决策表的行区间（表头 `| # | 事项 |` 起，连续消费 `|` 行）。 */
function decisionTableSpan(lines) {
  const h = lines.findIndex((l) => /^\|\s*#\s*\|\s*事项\s*\|/.test(l))
  if (h < 0) return null
  let e = h + 1
  while (e < lines.length && /^\|/.test(lines[e])) e += 1
  return { h, e }
}

/**
 * 从决策表**派生**每一行的状态（只认该行自己写下的显式标记）。
 *
 * ★ 返回体里连 `name` / `who` 一起给：索引表是**由它渲染**的，
 *   而"渲染"与"判定"必须是**同一份实现** —— 否则一个"自己再抄一遍"的生成器
 *   与这条判据会在**某一次**口径不一致时开始互相打架，而那时两边都自称是读数。
 * @returns {{ no: number, state: string, name: string, who: string }[]}
 */
export function decisionStateRows(docText) {
  const lines = docText.split('\n').map((l) => l.replace(/\r$/, ''))
  const span = decisionTableSpan(lines)
  if (span === null) return []
  const out = []
  for (let i = span.h + 2; i < span.e; i += 1) {
    const cells = lines[i].split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length < 5 || /^-+$/.test(cells[0])) continue
    // ★★★ 第 56 轮：先把**行内标记**去掉再匹配。
    //
    //   缘由是**真文档里**那两个词被 markdown 加粗从中间隔开了：
    //
    //     #28 逐字：「**不决定**则第 15 条继续停在原处…」   ← `不决定则` 被 `**` 劈开
    //     #28 逐字：「各自与**已裁决事项**的关系都写清了」  ← 同
    //
    //   于是 `/不决定则/` **匹配不到**、`/已裁决(?!事项)/` 也判不出来 ——
    //   而两种失效的方向**相反**：前者让一行**留在**队列里（保守），
    //   后者让一行**离开**队列（危险）。
    //
    //   > 一个被 markdown 加粗从中间劈开的短语，与一个**不存在**的短语，
    //   > 在任何一条正则眼里都是同一件事。
    //
    //   ⇒ 不在每个词表里堆 `\*{0,2}`（那要写 N 处、且漏一处就静默失效），
    //     而是在**匹配之前**统一把 `**` 与反引号去掉 —— **一处**归一化，两处词表都受益。
    const all = cells.join(' ').replace(/\*\*/g, '').replace(/`/g, '')
    let state = '未标注'
    for (const k of DECISION_STATE_VOCAB) {
      if (k !== '未标注' && DECISION_STATE_MARKS[k].test(all)) { state = k; break }
    }
    // 短名：去加粗与行内标记，切在第一个全角括号/冒号前
    const name = (cells[1] ?? '')
      .replace(/\*\*/g, '')
      .replace(/^[★\s]+/, '')
      .split(/（|：|;|；/)[0]
      .replace(/[`]/g, '')
      .trim()
      .slice(0, 46)
    const who = (cells[2] ?? '').replace(/\*\*/g, '').split(/（|★/)[0].trim()
    out.push({ no: Number(cells[0]), state, name, who })
  }
  return out
}

/**
 * §5 那 29 行的**状态合计**（唯一一处实现）。
 *
 * ★ 为什么单独立成一个函数：这张表有**两个**会写状态的地方 ——
 *   ① §5.0.1 索引表的**逐行**，② 索引表末尾那一句「⇒ **合计**：已裁决 N · …」。
 *   第三十八轮实测：① 是对的（已裁决 8 / 待施工 0 / 待裁决 3 / 未标注 18），
 *   而 ② 当时写着 7 / 0 / 4 / 18 —— **同一块里两句话互相矛盾**，
 *   而 `decisionStateViolations()` 此前只盯 ①，于是它报 **0 条**。
 *
 * > 一处"写下来但没人核对的数字"，与一处"会漂移的计数"，是同一个东西 ——
 * > 只不过前者的读者会以为它被核对过。
 */
export function decisionStateTally(docText) {
  const t = { 已裁决: 0, 待施工: 0, 待裁决: 0, 未标注: 0 }
  for (const r of decisionStateRows(docText)) t[r.state] += 1
  return t
}

/** 索引表末尾那句合计行（判据与量具共用同一个定位）。 */
export function decisionTallyLine(docText) {
  return docText.split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .find((l) => /^⇒ \*\*合计\*\*：已裁决/.test(l))
}

/** 从合计行里解析出四个数（解析不到就是 `null`，**不许**当成 0）。 */
export function parseDecisionTallyLine(line) {
  const g = (label) => {
    const m = new RegExp(`${label}\\s*\\*{0,2}(\\d+)\\*{0,2}`).exec(line)
    return m === null ? null : Number(m[1])
  }
  return { 已裁决: g('已裁决'), 待施工: g('待施工'), 待裁决: g('待裁决'), 未标注: g('未标注') }
}

/** 把状态索引渲成 markdown 行（生成器与判据共用同一份派生）。 */
export function renderDecisionStateIndex(docText) {
  const rows = decisionStateRows(docText)
  const t = decisionStateTally(docText)
  return [
    ...rows.map((r) => `| ${r.no} | ${r.name} | ${r.state === '未标注' ? '**未标注**' : r.state} | ${r.who} |`),
    '',
    `⇒ **合计**：已裁决 **${t.已裁决}** · 待施工 **${t.待施工}** · 待裁决 **${t.待裁决}** · **未标注 ${t.未标注}**（共 ${rows.length} 行）。`,
  ].join('\n')
}

/** 解析**索引表**里逐行写下的状态。 */
export function decisionStateIndex(docText) {
  const lines = docText.split('\n').map((l) => l.replace(/\r$/, ''))
  const h = lines.findIndex((l) => /决策表状态索引/.test(l))
  if (h < 0) return []
  const out = []
  for (let i = h; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) break
    const m = /^\|\s*(\d{1,2})\s*\|[^|]*\|\s*\*{0,2}(已裁决|待施工|待裁决|未标注)\*{0,2}\s*\|/.exec(lines[i])
    if (m !== null) out.push({ no: Number(m[1]), state: m[2] })
  }
  return out
}

/**
 * 索引表必须**等于**今天派生出来的值，且覆盖**每一条**。
 *
 * ★ 索引表是**派生视图**，所以它唯一的真实失效是"陈旧"：
 *   有人给某行补了 `已裁决`，索引还写着 `未标注`。判据就是盯这个。
 * ★ 而它**不**要求任何一行变成"已裁决" —— 那 20 条 `未标注` 是**如实读数**，
 *   不是待修的缺陷（替业主判定状态是裁决，不是抄写）。
 * @returns {{ code: string, detail: string }[]}
 */
export function decisionStateViolations(docText) {
  const derived = decisionStateRows(docText)
  const index = decisionStateIndex(docText)
  if (derived.length === 0) return [{ code: 'TABLE_MISSING', detail: '§5 决策表没找到' }]
  if (index.length === 0) return [{ code: 'INDEX_MISSING', detail: '§5 决策表状态索引没找到' }]
  const bad = []
  const byNo = new Map(index.map((x) => [x.no, x.state]))
  for (const d of derived) {
    if (!byNo.has(d.no)) { bad.push({ code: 'INDEX_GAP', detail: `#${d.no} 在索引表里没有条目` }); continue }
    const got = byNo.get(d.no)
    if (got !== d.state) {
      bad.push({
        code: 'INDEX_STALE',
        detail: `#${d.no}：索引写「${got}」，而按今天该行的显式标记派生出来是「${d.state}」`
          + ' ⇒ 有人补了标记却没重生成索引（或反过来）',
      })
    }
  }
  const derivedNos = new Set(derived.map((d) => d.no))
  for (const no of byNo.keys()) {
    if (!derivedNos.has(no)) bad.push({ code: 'INDEX_EXTRA', detail: `#${no} 在索引表里，但决策表里没有这一行` })
  }
  // ★★ 第二处状态：索引表末尾那句「⇒ **合计**：已裁决 N · …」。
  //   它与上面那 29 行处在**同一个代码块**里，却是**另一个数字**。
  //   本仓第三十八轮实测：29 行全对、合计那句错（7/0/4/18 vs 8/0/3/18），
  //   而只盯逐行的判据**报 0 条** —— 于是同一块里的两句话互相矛盾，
  //   且读者手里的那一句（末尾汇总）才是他真正会去记的那一句。
  const t = decisionStateTally(docText)
  const tallyLine = decisionTallyLine(docText)
  if (tallyLine === undefined) {
    bad.push({ code: 'TALLY_MISSING', detail: '索引表末尾那句「⇒ **合计**：已裁决 …」没找到' })
  } else {
    const got = parseDecisionTallyLine(tallyLine)
    const diff = DECISION_STATE_VOCAB.filter((k) => got[k] !== t[k])
    if (diff.length > 0) {
      bad.push({
        code: 'TALLY_STALE',
        detail: '合计那一句与派生值不符：'
          + diff.map((k) => `${k} 写 ${got[k] === null ? '（没解析到）' : got[k]}、派生 ${t[k]}`).join('；')
          + ' ⇒ 逐行索引可能是对的同时合计是错的，重生成索引即修'
          + '（量具：`node scripts/probes/probe-decision-tally.mjs`）',
      })
    }
  }
  return bad
}

/**
 * 每一条 `gap` 都必须写出**能解析的裁决处指针**。
 *
 * ## 为什么这是 `gap` 的定义本身要求的
 *
 * `gap` 的 class 定义逐字是「真的没有生产路径，且台账/对照表说它已交付
 * ⇒ **需要在 §5 里裁决**」。所以一条 `gap` 的 reason 必须回答一个反问：
 *
 *   > 那么，**谁**在**哪一条**上裁决它？
 *
 * 回答不了 ⇒ 它和"永远不会被裁决"是同一种东西。
 *
 * ## 这治的是哪一种真实失效（本仓实测过）
 *
 * 2026-09-18 发现：`runtime-contract-server-row.mjs` 那一族被标着 `in-flight`
 * ——正确动作那一格写的是一个字「**等**」——而真实内容是"接不上、要人裁决"，
 * 且**不在** §5 的清单上。于是它没有任何一处会被人读到，藏了三天。
 *
 * ⑦ 号用例治的是"标签过期"；本函数治的是另一半：
 * **标签正确、而这条缺口没有任何人在看**。
 *
 * ## 两种违反，分开报
 *
 *   · `missing`  —— reason 里没有具体指针（只说"§5 裁决"不算，那没告诉人去哪一条）
 *   · `dangling` —— 指针写了，但那个条号在 §5 里**不存在**（表改了、指针没跟着改）
 *
 * 后者是**指针腐烂**：一个指向不存在的条号的引用，与没有引用，
 * 对读的人是同一个结果——只不过前者看起来像已经归档过了。
 */
/**
 * ★★★ 第 118 轮第四十轮：**"待裁决"这张索引表会滞后于施工**。
 *
 * 2026-09-24 现场：第 28 条在 `d955dac`（2026-09-23）**已经裁定并施工完**
 * （台账 §2 逐字写着"第 28 条已裁定"，提交说明里四处落点 + 端到端读数），
 * 而 §5 索引表**到 2026-09-24 还写着"待裁决"**。
 * 后果不是"文档难看"：**我据此向业主提了一次多余的裁决提问** ——
 * 让他重新裁了一条一天前就裁过、而且**已经落地**的条目。
 *
 * ★ 为什么这条判据能抓、而 `decisionStateViolations()` 抓不到：
 *   后者只核 ① §5 正文 ↔ ② 索引表 ↔ ③ 合计行 **三者彼此**一致 ——
 *   三处**齐口同声**地说"待裁决"时，它报 0 条。
 *
 *   > 一个只能自证的清单，与一个恒真的清单，在"它能不能发现过期"上是同一个东西。
 *
 * ★ 判据的形状（**故意取窄：宁少判，不误判**）：
 *   队列/交接文档里出现「第 N 条**已裁**(定|决)…`<提交哈希>`」——
 *   也就是**带提交依据的裁决声明** —— 而 §5 索引表里第 N 条仍是「待裁决」
 *   （或者根本没有第 N 条）⇒ 报 `RULED_ELSEWHERE`。
 *   ★ 只认"同一行里既有条号、又有反引号哈希"的写法：历史留档里那些
 *   "已撤回、未裁决"的叙述**不带哈希**，因此不会被误判成裁决。
 *
 * @param {{statusDoc?: string, queueTexts?: {path: string, text: string}[]}} [input]
 * @returns {{ code: string, detail: string }[]}
 */
export function ruledElsewhereViolations({ statusDoc, queueTexts = [] } = {}) {
  const RULED = /第\s*(\d{1,2})\s*条\s*已裁(?:定|决)[^\n]*?`[0-9a-f]{7,40}`/g
  const byNo = new Map(decisionStateIndex(String(statusDoc ?? '')).map((r) => [r.no, r.state]))
  const bad = []
  for (const { path: docPath, text } of queueTexts) {
    for (const m of String(text).matchAll(RULED)) {
      const no = Number(m[1])
      const state = byNo.get(no)
      if (state === undefined) {
        bad.push({
          code: 'RULED_ELSEWHERE',
          detail: `${docPath} 说第 ${no} 条已裁定（带提交依据），而 §5 索引表里没有第 ${no} 条`,
        })
      } else if (state === '待裁决') {
        bad.push({
          code: 'RULED_ELSEWHERE',
          detail: `${docPath} 说第 ${no} 条已裁定（带提交依据），而 §5 索引表里第 ${no} 条仍写着`
            + '「待裁决」 ⇒ 索引表滞后于施工（2026-09-24 第 28 条就是这样，导致一次多余的裁决提问）',
        })
      }
    }
  }
  return bad
}

export function gapPointerViolations(entries, items) {
  const SPECIFIC = /§5\s*第\s*(\d+)\s*条/
  const missing = []
  const dangling = []
  for (const e of entries) {
    if (e.class !== 'gap') continue
    const m = SPECIFIC.exec(e.reason ?? '')
    if (!m) { missing.push(e.file); continue }
    const n = Number(m[1])
    if (!items.has(n)) dangling.push({ file: e.file, item: n })
  }
  return { missing, dangling }
}

/**
 * `reason` 必须**自足**：不许用"同上 / 上面那条 / 上一条"这类**位置指称**。
 *
 * ## 为什么有这条规则（第 49 轮量出来，第 50 轮量到它**已经错了一次**）
 *
 * 44 条 baseline 里 **21 条**的 `reason` 用位置指称 —— 它是**相对指针**
 * （"和上面那条一样"），含义**由数组次序决定**，而数组次序不承担语义、
 * 也没有任何判据看着它。
 *
 * ★ 第 49 轮实测到的那一处：`runtime/toolcall/spool.mjs` 写着
 *   「它的消费者就是**上面那条**收账侧」，而"上面那条"今天是
 *   `runtime/packs/store.mjs`（`gap`，裁决处 **§5 第 19 条**）——
 *   真正的收账侧 `orchestrator/worker/toolcall-drain.mjs` 在下标 **2**。
 *
 *   > 一条相对指称在表里插进一行无关条目之后，
 *   > 会**改变另一行说的话**，而不改变那一行的任何一个字。
 *
 * ## ★★ 第 49 轮的第一版规则**太松**，它自己写下的残留当场就兑现了
 *
 * 第一版允许"同类、且裁决处相同的相邻条目"用"同上"（想保住 7 条
 * `product/upgrade/*` 那种**真的同组**的写法）。它报出 5 条违规，
 * 并留下一句诚实的残留：
 *
 *     两条相邻、同类、都不声明裁决处的条目，若"同上"其实不是同一组，看不出来。
 *
 * **那句话在同一天就变成了一个真的错**：`product/release/checklist.mjs`
 * 的"同上"紧挨着 `product/metrics-spec7.mjs` —— 一个**指标口径**模块，
 * 两者仅因为"都是 gap、都写 §5 第 16 条"而被放行；
 * 而它真正该继承的是 `product/lifecycle/*` 那一组。
 *
 *   > 一条判据的"已知残留"如果**当天就能兑现**，
 *   > 那它不是残留，是它**允许**的一种错。
 *
 * ⇒ 这一版是**严格**的：**一条位置指称都不许**，没有残留 ——
 *   因为它不再需要回答"这两条是不是同一组"（那正是只能靠次序回答的问题）。
 *
 * ★ 放行的那一种写法：**把所指文件的路径写出来**
 *   （如"同 `product/upgrade/index.mjs`：升级链的一环"）。点名与次序无关；
 *   它与"同上"在**今天的输出里长得一样**（都是一句话）——
 *   差别只在**插入一行之后**还成不成立。
 *
 * @param {Array<{file: string, class: string, reason?: string}>} entries 基线条目
 * @returns {Array<{file: string, why: string}>}
 */
export function positionalReasonViolations(entries) {
  const POSITIONAL = /同上|上面那条|上一条/
  return entries
    .filter((e) => POSITIONAL.test(e.reason ?? ''))
    .map((e) => ({
      file: e.file,
      why: 'reason 里有"同上 / 上面那条"这类位置指称 —— 它的含义由数组次序决定。'
        + '请把所指文件的路径写出来（例如：同 `product/upgrade/index.mjs`：…），'
        + '或直接把那句理由写全。',
    }))
}

/** `in-flight` 是一个**带到期日的断言**，不是一种永久分类。
 *
 * 它的判据是「另一个 agent 当轮正在接线（**工作树未提交**）」——所以它
 * **只在该文件确实还有未提交改动时成立**。文件一旦提交、而模块仍然不可达，
 * 前提就过期了，此时正确的分类是 `gap`。
 *
 * ## 为什么这条规则必须存在（本仓实测过一次）
 *
 * 2026-09-18：4 条 `in-flight` 条目（contract-server-row / host-registrar-row /
 * run-floor / runtime-contract-server）的文件在 `e0b83af` / `69da8fd` / `5c1d698`
 * 里**已经提交**，而模块**仍然不可达**。于是基线在说"另一个 agent 正在接线"，
 * 而事实是"那条线接不上、并且正等人裁决"。
 *
 *   > 一个把"已经停工"写成"正在进行"的标签，比一个写错的标签更坏：
 *   > 它会让人**不去催**——而这一条本来正等人裁决。
 *
 * ★ 反过来也一样坏：如果规则太松（比如只要求"文件被跟踪"），它会在真的
 *   有人接线时判红，那就是惩罚正在接线的人——本探针文件头明令禁止那一类。
 *   所以判据取的是 `git status --porcelain` 里的**改动**，不是"是否存在"。
 *
 * @param {Array<{file: string, class: string}>} entries 基线条目
 * @param {Set<string>} dirty `git status --porcelain` 里有改动的文件
 * @returns {string[]} 违反该规则的条目（文件干净却仍标 in-flight）
 */
export function inFlightViolations(entries, dirty) {
  return entries
    .filter((x) => x.class === 'in-flight')
    .filter((x) => !dirty.has(x.file))
    .map((x) => x.file)
}

/** 工作树里有未提交改动（含已暂存）的文件。读不出来时返回 `null`（调用方须从严）。 */
export function dirtyFiles() {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 })
    const set = new Set()
    for (const line of out.split('\n')) {
      if (line.trim() === '') continue
      // 形状：`XY <path>`（XY 两列状态码）。重命名是 `R  old -> new`，取新名。
      const rest = line.slice(3).trim()
      const arrow = rest.indexOf(' -> ')
      const p = arrow >= 0 ? rest.slice(arrow + 4) : rest
      set.add(p.replace(/^"|"$/g, ''))
    }
    return set
  } catch {
    return null
  }
}

/** 一次算完。 *
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
