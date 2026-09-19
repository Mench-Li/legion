// scripts/prt/suite-counts.mjs
// ============================================================================
// 主表声明的**用例数**（"套件 X（N 例）"）↔ **实测**的用例数。
//
// ---------------------------------------------------------------------------
// ★ 起因：本会话第三次撞到同一族 —— **一句没有任何东西核对的断言**
//
//   ① `usage-rollup.mjs` 的文件头声称"降级已实现"（而它是零）；
//   ② `baseline-snapshot.mjs` 的设计说明声称"没接进 CI"（而它在跑）；
//   ③ `NOT_FORWARDED_YET` 的两条理由指错了行号，而门禁只查"理由够不够 40 字"。
//
//   第 24 轮把第③种（**坐标**）做成了机器判据。这一轮做第二种更基础的：
//   **计数**。CI 的每一行套件都带 `tests=N`（实测），文档里到处写着"N 例"——
//   两者本可以自动对上，而**今天没有人对**。
//
//   实测（2026-09-18）：主表 `docs/MULTI-AGENT-FEATURE-STATUS.md` 里
//   **33 处**计数声明，**31 处对、3 处错**（`runtime-contract` 13、`dsh-adapter` 25、
//   `registry.test.mjs` 32）。三个数**都不是**"写的时候算错了"，而是
//   **写完之后用例还在长**——而那三格是**今天的状态**格。
//
//   > 一个"写的时候数对了"的数字，与一个"昨天数对了"的数字，
//   > 在文档里长得一模一样——而后者是**借来的**权威。
//
// ---------------------------------------------------------------------------
// ★★ 这个模块**刻意只查主表**，不查全仓的"N 例"
//
//   全仓扫下来有 **106 处**对不上，而其中绝大多数是**历史读数**
//   （"本轮…5 例"、evidence 日志里当时的数）——那些**必须**留着旧值：
//   改它们就是**篡改历史**。而主表（`F-01..F-25` 那 15 行）与 §2 描述的是
//   **今天的状态**，那里的计数过期就是**真的错**。
//
//   > 一条"当时的读数"与一条"现在的读数"，在文本里长得一样——
//   > 而前者**必须**冻结、后者**必须**跟着代码走。
//   > 所以一条"全仓 N 例都不许过期"的判据会**红在正确的地方**。
//
//   ⇒ 夹具见 `scripts/prt/suite-counts.test.mjs` ⑦：拿一条历史读数去喂，
//     它必须**不**报——否则这条判据会在真实仓库上立刻红，然后被人关掉。
//
// ---------------------------------------------------------------------------
// ★ 为什么不复用 CI 的套件行计数
//
//   CI 的一个套件行**聚合多个文件**（`path-scope` 那一行 = 4 个文件 ⇒ 67），
//   而主表声明的是**一个数**。拿聚合总数去比单个数会得到 **135 处假发现**
//   （我第一版就是这么写的）——两个数都真，只是**分母不同**。
//   这与第 23 轮"拿窗口聚合去比单次上限"是同一类错。
//
//   ⇒ 所以这里**真跑文件**。实测成本：主表点名的 27 个文件串行 ≈ 18s
//     （一次批量调用 3.5s，但批量拿不到**逐文件**计数）。
//     相对 `test` 阶段的 ~800s，这个代价可以接受。
// ============================================================================
import { execFileSync, execFile } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const STATUS_DOC = 'docs/MULTI-AGENT-FEATURE-STATUS.md'

/**
 * 主表的行前缀。★ 不能写成 `/^\|\s*(F-\d+)\s*\|/`：
 * 主表里有 `| F-05 前半 |`、`| F-05 后半 |`、`| F-19 缺口① |` 这样的行，
 * 第一格**不是**光秃秃的 `F-NN`。
 *
 * 第一版就是那样写的，于是 `parseCountClaims` 只认到 **20** 条，
 * 而实际有 **33** 条 —— 漏掉的那 13 条里包含 `run-events.test.mjs`（18 例）、
 * `event-delivery.test.mjs`（31 例）、`friction.test.mjs`（23 例）等。
 *
 *   > 一个"只认 20 条、而这 20 条全对"的门禁，
 *   > 与一个"33 条全对"的门禁，在只有 `ok: true` 的输出里是同一个东西。
 *   > 而前者**看起来更可信**：它还报了一个具体的条数。
 */
export const MAIN_ROW_RE = /^\|\s*(F-\d+[^|]*?)\s*\|/

/**
 * 从主表提取计数声明。返回 `[{ row, line, name, claim }]`。
 *
 * 两种写法都要认（主表里两种都有）：
 *   · 套件级：``套件 `dsh-adapter`（25 例）``
 *   · 文件级：``` `registry.test.mjs` 32 例 ```
 */
export function parseCountClaims(docText) {
  const out = []
  const lines = docText.split('\n')
  // ★ 名字与数字之间**只能**是空白、或一个开括号。
  //
  //   原来写的是 `[^。\n]{0,20}?`，于是这一句被匹配成一条计数声明：
  //     「（`run-record.mjs` 现在带 `peakResource`，判据 47 例、变异 6/6）」
  //   ——`peakResource` 是**字段名**，"47 例"说的是**另一套**判据。
  //   它落进 `unresolved` 被跳过（无害），但**一条假声明会稀释"跳过"这个读数**：
  //   30 条跳过与 1 条跳过，在只报 `ok` 的输出里一样。
  //
  //   > 一个"匹配得太宽"的提取器，与一个"文档里真有一条说不清的声明"，
  //   > 在报告里长得一样——而前者要求改判据、后者要求改文档。
  const CLAIM = /`([A-Za-z][\w./-]*)`\s*(?:（|\()?\s*(\d+)\s*(?:例|个用例)/g
  lines.forEach((line, i) => {
    const row = MAIN_ROW_RE.exec(line)
    if (row === null) return
    for (const m of line.matchAll(CLAIM)) {
      // ★★★ 第 36 轮订正：这里此前是 `m[1].split('/').pop()`——**把目录丢掉了**。
      //
      //   正则本来**认**路径（`[\w./-]*`），而这一行又把路径砍回文件名。后果：
      //   一条**写得很准**的全路径引用（`runtime/contracts/contract.test.mjs 45 例`）
      //   被当成裸名 `contract.test.mjs` 去解析 ⇒ 撞上另一个同名文件
      //   （`whiteboard/packages/shared/test/contract.test.mjs`）⇒ 记 `ambiguous` ⇒
      //   **静默跳过**，而跳过是"没能核对"，不是"文档写错了"。
      //
      //   实测（2026-09-19）：主表 F-01 那一格写全路径之后，本判据**仍然**报
      //   `F-01 \`contract.test.mjs\`（ambiguous）`——**它看不见刚补上的目录**。
      //
      //   > 一个把路径砍成文件名的判据，
      //   > 会把「这条引用很准，只是我读不出目录」报成「这条引用有歧义」——
      //   > 于是**修文档永远消不掉这个告警**，而下一个读的人会以为文档还有问题。
      //
      //   保留完整名字。`resolveTargets()` 先按**全路径**找，再按裸名找。
      out.push({ row: row[1], line: i + 1, name: m[1], claim: Number(m[2]) })
    }
  })
  return out
}

/**
 * 把声明里的名字解析到**唯一**一个测试文件。
 *
 * 解析不到、或解析到多个 ⇒ 记 `ambiguous`（**不猜**）。
 * 例：`runtime-contract` 是**套件名**（CI 里聚合 2 个文件），
 * 而主表把它与 `contract.test.mjs` 并列写出来 ⇒ 它落到 `suite` 这一档。
 */
export function resolveTargets(claims, trackedTests, suiteFiles = new Map()) {
  const byBase = new Map()
  const byPath = new Set()
  for (const f of trackedTests) {
    const norm = f.replace(/\\/g, '/')
    byPath.add(norm)
    const b = norm.split('/').pop()
    if (!byBase.has(b)) byBase.set(b, [])
    byBase.get(b).push(norm)
  }
  return claims.map((c) => {
    // ★ 第 36 轮：**带目录的引用先按全路径解**（原样存在就是它，无需再猜）。
    //   这一步必须在裸名解析**之前**——否则一条准确的全路径会被同名文件撞成
    //   `ambiguous`，而那个告警**改文档消不掉**（判据自己把目录丢了）。
    if (c.name.includes('/')) {
      if (byPath.has(c.name)) return { ...c, kind: 'file', files: [c.name] }
      // ★★ 带目录的**模块名**（`team-hub/budget-alert.mjs（20 例）`）：同目录下的
      //    `budget-alert.test.mjs` 才是那 20 例的所在。这一步与下面裸名分支的
      //    归一化**同一规则**，只是多了目录。
      //    ⚠️ 少了它，`team-hub/budget-alert.mjs` 会落进 `unresolved`——
      //    而修之前它靠 `split('/').pop()` 侥幸解对了（`budget-alert.mjs` → 裸名归一化）。
      //    **修一处"看不见目录"，顺手把另一处"靠丢目录才解对"的地方打断了**，
      //    所以两条路都要在。
      const sib = c.name.endsWith('.test.mjs')
        ? null
        : `${c.name.replace(/\.(mjs|cjs|js|ts)$/, '')}.test.mjs`
      if (sib !== null && byPath.has(sib)) return { ...c, kind: 'file', files: [sib] }
      const sf0 = suiteFiles.get(c.name)
      if (sf0 !== undefined) return { ...c, kind: 'suite', files: sf0 }
      return { ...c, kind: 'unresolved', files: [] }
    }
    // 归一化声明里的名字 → 候选文件名。三种写法都要认：
    //   `run-events.test.mjs`（**已经**是文件名）
    //   `budget-alert.mjs`   （带扩展名的模块名）
    //   `dsh-adapter`        （套件名 / 裸名）
    //
    // ★ 第一版把三者混成"去掉扩展名再拼 `.test.mjs`"，于是
    //   `run-events.test.mjs` → `run-events.test.test.mjs` ⇒ **30 条全部落进
    //   `unresolved` 被静默跳过**，而输出仍然报 `ok: true`。
    //   那条路**比漏掉 13 条更坏**：它让 33 条声明里只剩 3 条被真的查过，
    //   而 `ok` 看起来和"33 条全对"一样。
    const base = c.name.endsWith('.test.mjs')
      ? c.name
      : `${c.name.replace(/\.(mjs|cjs|js|ts)$/, '')}.test.mjs`
    const asFile = byBase.get(base) ?? byBase.get(c.name) ?? []
    if (asFile.length === 1) return { ...c, kind: 'file', files: asFile }
    if (asFile.length > 1) return { ...c, kind: 'ambiguous', files: asFile }
    const sf = suiteFiles.get(c.name)
    if (sf !== undefined) return { ...c, kind: 'suite', files: sf }
    return { ...c, kind: 'unresolved', files: [] }
  })
}

/**
 * 同步跑一个测试文件，返回用例数（读 `ℹ tests N`）。
 *
 * ★★★ 必须在**干净的环境**里起子进程（2026-09-18 实测）。
 *
 * 这道判据自己是**一个测试套件**（`suite-counts.test.mjs`），而它要 spawn
 * `node --test <别的文件>`。父进程带着 `NODE_TEST_CONTEXT` / `NODE_TEST_WORKER_ID`
 * 时，子 node **认为自己是测试 worker**，于是：
 *
 *     len=0     ℹ tests 读不到     ← 子进程一个字都不输出
 *
 * ⇒ 32 条声明**全部**落进 `skipped`、"读不出用例数"，而返回体是
 *   `{ ok: true, checked: 0, skipped: 32 }`。
 *
 *   > 一个**完全瞎掉**的门禁，与一个"32 条全对"的门禁，
 *   > 在只看 `ok` 的输出里是同一个东西。
 *
 * 抓住它的是 `suite-counts.test.mjs` ① —— 那一条断言的不是 `ok`，
 * 而是 **`skipped` 必须为 0**。这一条断言就是为这种形状写的。
 *
 * 实测三种环境（`scratch/_probe-nested.mjs`）：
 *   父进程在 test runner 里 + 不清 env ⇒ len=0（哑）
 *   父进程在 test runner 里 + 清 NODE_TEST_CONTEXT ⇒ len=1169，读得到
 *   父进程不在 test runner 里 ⇒ len=1166，读得到（所以直接跑 CLI 时看不出问题）
 */
export function countTests(relPath, { cwd = REPO } = {}) {
  const abs = resolve(cwd, relPath)
  if (!existsSync(abs)) return null
  const env = { ...process.env }
  for (const k of ['NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID']) delete env[k]
  let out = ''
  try {
    out = execFileSync('node', ['--test', relPath], {
      cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env,
    })
  } catch (e) {
    out = String(e.stdout ?? '') + String(e.stderr ?? '')
  }
  const m = /ℹ tests (\d+)/.exec(out)
  return m === null ? null : Number(m[1])
}

/**
 * 从 `scripts/ci/run-ci.mjs` 读出 **套件名 → 文件清单**。
 *
 * 为什么需要它：主表把**套件名**（`runtime-contract` / `dsh-adapter`）当名字用，
 * 而那两个名字在仓库里**没有同名文件**——它们是 CI 套件行。
 * 不解析这一层，那两条声明就会落进 `unresolved` 被**静默跳过**
 * ——而"跳过 2 条"与"2 条都对"，在只报 `ok` 的输出里长得一样。
 */
export function suiteFilesFromCi(ciText) {
  const map = new Map()
  for (const m of ciText.matchAll(/label:\s*'([^']*)'/g)) {
    const start = m.index
    const next = ciText.indexOf("label: '", start + 8)
    const seg = ciText.slice(start, next === -1 ? start + 2000 : next)
    const files = [...new Set([...seg.matchAll(/'([^']*\.test\.mjs)'/g)].map((x) => x[1]))]
    const name = (m[1].split('（')[0] || m[1]).trim()
    if (files.length > 0 && !map.has(name)) map.set(name, files)
  }
  return map
}

/** 仓库里全部已跟踪的 `*.test.mjs`。 */
export function trackedTests({ cwd = REPO } = {}) {
  return execFileSync('git', ['ls-files', '-z', '*.test.mjs'], { cwd, encoding: 'utf8' })
    .split('\0').filter(Boolean).map((f) => f.replace(/\\/g, '/'))
}

/** 从磁盘上按真实仓库核对主表。 */
export function checkRepo({ cwd = REPO } = {}) {
  const docText = readFileSync(resolve(cwd, STATUS_DOC), 'utf8')
  const ciText = readFileSync(resolve(cwd, 'scripts/ci/run-ci.mjs'), 'utf8')
  return checkSuiteCounts({
    docText,
    trackedTests: trackedTests({ cwd }),
    suiteFiles: suiteFilesFromCi(ciText),
  })
}

// ── CLI：`node scripts/prt/suite-counts.mjs`（只读，不写盘）─────────────────
//
// ★ 它**不**提供 `--record`：不像 `baseline-snapshot.mjs`，这里的"真值"是
//   **跑出来的**，不是记下来的。能 `--record` 的门禁等价于"把当前输出当真理"，
//   而这一条的全部价值就是**真值从代码来、不从账来**。
const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) {
  const r = checkRepo()
  console.log(`suite-counts: 主表计数声明 ${r.total} 处 —— 已核 ${r.checked}、跳过 ${r.skipped.length}`)
  // ★ 先报"跳过"，再报"不符"：一个"跳过 32 条"的门禁与一个"全对"的门禁，
  //   在只报最后一行结论时长得一样。
  if (r.skipped.length > 0) {
    console.log(`  ⚠️ 有 ${r.skipped.length} 条**没能核对**（读不出用例数 / 名字解析不到）：`)
    for (const s of r.skipped.slice(0, 8)) console.log(`     · ${s}`)
    if (r.skipped.length > 8) console.log(`     … 还有 ${r.skipped.length - 8} 条`)
  }
  for (const v of r.violations) console.log(`  ✖ ${v.message}`)
  if (r.ok && r.skipped.length === 0) console.log('  ✅ 全部与实测一致')
  process.exit(r.ok && r.checked === r.total ? 0 : 1)
}


/**
 * 核对主表的计数声明。
 *
 * ★ 返回体里 `checked` / `skipped` 必须一起报：**"跳过多少条"与"它们都对"
 *   在只有 `ok` 一个字段时是同一个读数**（第 23 轮 F-15 那一课）。
 */
export function checkSuiteCounts({ docText, trackedTests, suiteFiles = new Map(), counts = null } = {}) {
  const claims = parseCountClaims(docText)
  const resolved = resolveTargets(claims, trackedTests, suiteFiles)
  const violations = []
  const skipped = []
  let checked = 0
  for (const c of resolved) {
    if (c.kind === 'ambiguous' || c.kind === 'unresolved' || c.files.length === 0) {
      skipped.push(`${c.row} \`${c.name}\`（${c.kind}）`)
      continue
    }
    // 套件级：把该套件的所有文件加起来
    let real = 0
    let got = true
    for (const f of c.files) {
      const n = counts === null ? countTests(f) : counts.get(f)
      if (n === null || n === undefined) { got = false; break }
      real += n
    }
    if (!got) { skipped.push(`${c.row} \`${c.name}\`（读不出用例数）`); continue }
    checked += 1
    if (real !== c.claim) {
      violations.push({
        row: c.row, line: c.line, name: c.name, kind: c.kind,
        claim: c.claim, real, files: c.files,
        message: `${c.row}（文档第 ${c.line} 行）\`${c.name}\` 文档说 ${c.claim} 例，实测 ${real} 例`
          + `（${c.files.join('、')}）`,
      })
    }
  }
  return { ok: violations.length === 0, checked, skipped, violations, total: claims.length }
}
