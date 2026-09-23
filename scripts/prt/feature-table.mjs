// scripts/prt/feature-table.mjs
// ============================================================================
// F-01～F-25 对照表（`docs/MULTI-AGENT-FEATURE-STATUS.md`）× 仓库产物
//
// ## 为什么需要它
//
// 那张表是 `docs/MULTI-AGENT-FEATURE-OPTIMIZATION.md` 的**可追溯面**，
// 而它的状态列**是手写的**。2026-09-18 在它里面量出**三处过期**：
//
//   · F-11 写着"三道范围检查在生产里从未被注入"，而第一道（`pathScope`）
//     早已接进生产组合根（`40d2d60`）；同一格还写着 `whitelist`"连端口都没有"，
//     而桥的入参表里**就有它**（`tool-request.mjs:517`）——**有位无值**，不是无位。
//   · F-15 写着 `peak-resource`"阻塞于 PRT-011 平台裁决"，而 PRT-011 在
//     2026-09-11 就裁决完了（路线 C），且它裁的是**分发形态**、与目标平台无关。
//   · 三格的状态写成箭头（`🟡→✅`）——读者得自己挑一个，机器一个都读不出。
//
//   > 一个手写的状态与一个被核过的状态，在表格里长得一模一样；
//   > 区别是前者会在代码变了之后**继续那么写**。
//
// 而**没有任何门禁会去核对它**：`check-docs` 只管 `README.md` 与 `docs/FEATURES.md`。
//
// ## 它断言什么、不断言什么（这是本模块最要紧的一段）
//
// **断言**两件事，都是"错了就一定是错"的：
//   ① F-01～F-25 **每一条**都被表里的某一行指到（拆分行如 `F-05 前半` 也算）；
//   ② 每行的「代码落点」里**至少有一条**能解析到仓库里的真文件。
//
// **不**断言"功能做完了没有"——那不是读数能回答的问题，是产物与裁决的问题。
//
// ★★★ **状态词表刻意不在这里判**：它已经有一个所有者
//   （`progress-check.test.mjs` 用例 ⑥，见 `analyze()` 里的长注释）。
//   本模块的第一版**自己**抄了一份词表并据此"订正"了三格箭头写法——
//   而那条既有判据**明确许可箭头**，于是我的订正**把它弄红了**。
//   ⇒ 一个形状的判定只能有一个所有者；两份词表并存必然漂移。
//
// 也**不**断言"每一条落点都解析得到"：单元格里大量使用**同目录裸名**
// （`runtime/contracts/adapter.mjs`、`run.mjs`、`errors.mjs`）、大括号展开
// （`orchestrator/{acceptance,pipeline,workspace}`）、目录通配（`product/launcher/*`）
// 与**路由**（`/api/event-delivery`）。把这些一律判红，会让这条判据
// **红在正确的地方**——而一条红在正确地方的判据会教人删掉它。
//
//   ⚠️ 这不是假想的风险：本模块的探针第一版报了 **22 条"落点不存在"**，
//   逐条查下来**一条真的都没有**，全是我自己的解析器只认一种写法。
//
// ## 解析口径（与 `scripts/probes/scan-dead-references.mjs` 同一套）
//
// 按顺序试：仓库相对精确 → 单元格上下文目录 → 四个已知根 → 后缀唯一匹配。
// 多候选记 `ambiguous`、查不到记 `missing`，**两者都不算"不存在"**——
// 只有"整行的落点一条都解析不到"才是真的指了空。
// ============================================================================

import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

export const STATUS_DOC = 'docs/MULTI-AGENT-FEATURE-STATUS.md'
export const OPTIMIZATION_DOC = 'docs/MULTI-AGENT-FEATURE-OPTIMIZATION.md'
export const DSH_CHECKOUT = 'D:/project/DSH/dsh/deepseek-harness'

// ★★★ 这里**刻意没有** `FEATURE_STATUS_VOCAB` 这样的常量。
//   状态词表（`✅/🟡/⬜/⏸` 加一种被许可的箭头写法）**已经有一个所有者**：
//   `scripts/prt/progress-check.test.mjs` 用例 ⑥。本模块的第一版在这里
//   **又抄了一份**，并据此"订正"了真文档里三格箭头写法——而那条既有判据
//   **明确许可箭头**，于是我的"订正"**把它弄红了**（全量 CI 抓到的）。
//
//     > 一道看不见某类改动的闸门，比没有闸门更危险；
//     > 而**一道看得见的闸门，比我以为"没有闸门"更常见**。
//
//   ⇒ 一个形状只能有一个所有者。把一个**不会被使用的**词表留在这里，
//   等于给下一个人留一份"看起来可以拿去判"的并行权威——那正是本批的错因。
//   所以**一个常量都不留**，改为在 `feature-table.test.mjs` 里
//   **钉住那个所有者还在**（它的判据文本 + 它在 `run-ci` 里）。
//
//   状态列本身仍然被**读**进 `analyze()` 的 `rows`（供报告与人工核对），
//   只是**不评价**。

/** 编号范围：优化文档开头明写 **F-01～F-25**。 */
export const FEATURE_IDS = Object.freeze(
  Array.from({ length: 25 }, (_, i) => `F-${String(i + 1).padStart(2, '0')}`),
)

/** 裸名太常见、解析必然多候选的目录前缀（按序试）。 */
const KNOWN_ROOTS = Object.freeze([
  'runtime', 'product', 'team-hub', 'orchestrator', 'security', 'scripts', 'workbench',
])

/**
 * 两个仓的已跟踪文件清单（Legion + DSH 检出）。
 *
 * ★ 只列**已跟踪**的：一个只在本机存在的文件与一个真的被提交的文件，
 *   在"它存不存在"这个问题上是两件事（本仓为此栽过六次）。
 * ★ DSH 检出不在（CI 干净检出）⇒ 那一半为空，**不因此判红**，只是少认一些后缀。
 */
export function trackedFiles({ repoRoot = process.cwd(), dshRoot = DSH_CHECKOUT } = {}) {
  const out = new Set()
  const add = (cwd) => {
    try {
      const raw = execFileSync('git', ['ls-files'], { cwd, encoding: 'utf8', maxBuffer: 1 << 28 })
      for (const f of raw.split('\n')) if (f.trim()) out.add(f.trim().replace(/\\/g, '/'))
    } catch { /* 仓不在就跳过这一半，不抛 */ }
  }
  add(repoRoot)
  if (existsSync(dshRoot)) add(dshRoot)
  return out
}

/**
 * 解析一个落点字符串。
 *
 * @returns {{kind: 'exact'|'suffix'|'dir'|'ambiguous'|'missing'|'route'|'placeholder'|'empty', hits: string[]}}
 */
export function resolveRef(raw, { files, currentDir = null } = {}) {
  const p = String(raw ?? '').trim()
  if (p === '') return { kind: 'empty', hits: [] }
  // 路由不是文件；占位符（`<…>`）是作者故意不写死
  if (/^\/api\//.test(p) || p.startsWith('/')) return { kind: 'route', hits: [] }
  if (p.includes('<')) return { kind: 'placeholder', hits: [] }

  const hasFiles = files instanceof Set && files.size > 0
  const under = (base) => (hasFiles ? [...files].filter((f) => f.startsWith(`${base}/`)) : [])

  // ★ `dir/*` 与 `dir/` 都是**指向目录**的合法写法（这份表大量使用）。
  //   第一版我把 `*` 一律当占位跳过，于是"这一格只有一条落点、而它是 `dir/*`"
  //   被报成"一条都解析不到"——4 条里有 4 条都是这一类。
  //   > 一个"这一格只写了通配"与一个"这一格指着不存在的东西"，在只看
  //   > "解析到几条"时是同一个读数；区别是前者是**省略**，后者是**错**。
  const isDirRef = p.endsWith('/*') || (p.endsWith('/') && !/\.[a-z]+$/i.test(p))
  if (isDirRef) {
    const base = p.replace(/\/\*$/, '').replace(/\/$/, '').replace(/\{[^}]*\}$/, '').replace(/\/$/, '')
    if (base === '') return { kind: 'missing', hits: [] }
    const hits = under(base)
    return hits.length ? { kind: 'dir', hits: hits.slice(0, 2) } : { kind: 'missing', hits: [] }
  }

  if (p.includes('*')) return { kind: 'placeholder', hits: [] }

  // 大括号展开：`a/{b,c}.mjs`
  if (p.includes('{')) {
    const m = /^(.*)\{([^}]*)\}(.*)$/.exec(p)
    if (m) {
      const hits = []
      for (const part of m[2].split(',')) {
        const r = resolveRef(`${m[1]}${part}${m[3]}`, { files, currentDir })
        if (r.hits.length) hits.push(...r.hits)
      }
      return hits.length ? { kind: 'suffix', hits } : { kind: 'missing', hits: [] }
    }
  }

  const norm = p.replace(/^\.\//, '').replace(/\/$/, '')
  if (!hasFiles) return { kind: 'missing', hits: [] }

  // ① 仓库相对精确
  if (files.has(norm)) return { kind: 'exact', hits: [norm] }
  // ② 单元格上下文目录（`runtime/contracts/adapter.mjs`、`run.mjs`、…）
  if (currentDir !== null && currentDir !== '') {
    const j = `${currentDir}/${norm}`.replace(/\/{2,}/g, '/')
    if (files.has(j)) return { kind: 'exact', hits: [j] }
  }
  // ③ 四个已知根
  for (const root of KNOWN_ROOTS) {
    const j = `${root}/${norm}`
    if (files.has(j)) return { kind: 'exact', hits: [j] }
  }
  // ④ 后缀唯一匹配
  if (norm.includes('/')) {
    const suf = [...files].filter((f) => f.endsWith(`/${norm}`))
    if (suf.length === 1) return { kind: 'suffix', hits: suf }
    if (suf.length > 1) return { kind: 'ambiguous', hits: suf.slice(0, 3) }
    return { kind: 'missing', hits: [] }
  }
  const cands = [...files].filter((f) => f.slice(f.lastIndexOf('/') + 1) === norm)
  if (cands.length === 1) return { kind: 'suffix', hits: cands }
  if (cands.length > 1) return { kind: 'ambiguous', hits: cands.slice(0, 3) }
  return { kind: 'missing', hits: [] }
}

/** 从单元格里取出所有反引号包裹的落点。 */
export function refsIn(cell) {
  return [...String(cell ?? '').matchAll(/`([^`]+)`/g)]
    .map((m) => m[1])
    .filter((x) => x.includes('.') || x.includes('/'))
}

/**
 * 抽出文档里所有 `| 编号 | …` 表。
 *
 * ★ 按**表头**认表，而不是按"这一行长得像不像"：三张表的列数不同
 *   （P0 六列 / P1 五列 / P2 四列），按列数硬编码会在换列时静默丢行。
 */
export function parseFeatureTables(docText) {
  const lines = String(docText).split('\n').map((x) => (x.endsWith('\r') ? x.slice(0, -1) : x))
  const tables = []
  for (let i = 0; i < lines.length; i++) {
    if (!/^\|\s*编号\s*\|/.test(lines[i])) continue
    const header = lines[i].split('|').map((s) => s.trim()).filter((s) => s !== '')
    const rows = []
    for (let k = i + 2; k < lines.length && /^\|/.test(lines[k]); k++) {
      rows.push({ line: k + 1, cells: lines[k].split('|').map((s) => s.trim()) })
    }
    tables.push({ headerLine: i + 1, header, rows })
  }
  return tables
}

/**
 * 主分析。
 *
 * @param {object} p
 * @param {string} [p.docText]  `MULTI-AGENT-FEATURE-STATUS.md` 的正文；缺省读磁盘
 * @param {Set<string>} [p.files] 已跟踪文件集合；缺省现算
 * @returns {{covered: string[], missing: string[], rows: object[], problems: string[], soft: string[], parsedRows: number}}
 */
export function analyze({ docText = null, files = null, repoRoot = process.cwd() } = {}) {
  const text = docText === null ? readFileSync(STATUS_DOC, 'utf8') : docText
  const tracked = files === null ? trackedFiles({ repoRoot }) : files
  const tables = parseFeatureTables(text)

  const hard = []
  const soft = []
  const rows = []
  const covered = new Set()
  let parsedRows = 0

  // ★★ 没有文件清单时**必须跳过**落点判定，而不是让每一行都红。
  //   干净检出 / 无 git / git 不可用 ⇒ `trackedFiles()` 返回空集 ⇒
  //   每一行的落点都解析不到 ⇒ **29 行全红**，而那不是"文档错了"，是"没东西可比"。
  //
  //   > 一个"这份文档指着一堆不存在的东西"与一个"我没拿到仓库清单"，
  //   > 在只报"解析不到"的判据里是同一个输出——而前者会让人去改文档，
  //   > 后者什么都不用改。
  //
  //   ⚠️ 与 `boundary-facts` 里"因 DSH 检出不在而无法判定"是同一档处理：
  //   把"无法判定"**显式记成一个桶**，不让它伪装成"通过"，也不让它伪装成"失败"。
  const pathCheckAvailable = tracked instanceof Set && tracked.size > 0
  if (!pathCheckAvailable) {
    soft.push('★ 拿不到已跟踪文件清单（无 git / 干净检出）⇒ **本轮的落点判定整段跳过**；'
      + '「25 条覆盖」与「状态是闭集里的词」两条**仍然生效**')
  }

  for (const t of tables) {
    for (const r of t.rows) {
      const rawId = (r.cells[1] ?? '').trim()
      const m = /^(F-\d\d)(.*)$/.exec(rawId)
      if (!m) continue
      parsedRows++
      const id = m[1]
      const isSub = m[2].trim() !== ''
      const status = (r.cells[3] ?? '').trim()
      const loc = r.cells[4] ?? ''

      // ★ 拆分行（`F-05 前半`）让它指的那一条**也算被覆盖到**。
      //   第一版只认 `F-05` 这个精确写法，报了"缺 F-05"——而表里有两行在讲它。
      //   > 一个"这一条被拆成两行写"与一个"这一条没人写"，在只认精确写法的
      //   > 检查里是同一个输出。
      covered.add(id)

      // 子行（`F-05 前半` / `F-18 缺口①`）**整行跳过**，两个理由：
      //   ① 它的「状态」格写的是**证据描述**（`friction.test.mjs` 23 例…），不是状态；
      //   ② 它的「代码落点」位指的是"哪条证据守住了这个缺口"，
      //      **不是**"这个缺口落在哪个文件"——把路径解析器架在散文上只会得到噪声。
      //   ⚠️ 这条 `continue` 一度**没有任何可观测效果**（真文档里子行的第 4 格是空的），
      //   于是变异测试报了"没咬住"。处置不是删掉它，而是**让它可观测**：
      //   `feature-table.test.mjs` 的 ③c 现在故意给子行一个不存在的路径 ——
      //   跳过了 ⇒ 不报；没跳过 ⇒ 必红。
      //   *一个"从来不会触发的守卫"与一个"不存在的守卫"，在只看用例绿没绿时
      //   是同一个东西——除非有一条用例专门踩它。*
      if (isSub) continue

      // ★★★ 状态词表**刻意不在这里判**——它已经有一个所有者：
      //   `scripts/prt/progress-check.test.mjs` 的用例 ⑥
      //   （`对照表里每个 F-行都必须用图例里的状态标记`），
      //   而它的词表是 `legend.includes(s) || /^[✅🟡⬜⏸]+→[✅🟡⬜⏸]+$/`
      //   ——**箭头写法是被那条判据明确许可的**。
      //
      //   本判据的**第一版**自作主张把三格箭头（`🟡→✅` 等）改成了
      //   `✅（原 🟡，本轮落地）`，理由是"机器读不出箭头两头的哪一个"。
      //   全量 CI 立刻红在**那条既有判据**上：
      //
      //     > 一道看不见某类改动的闸门，比没有闸门更危险；
      //     > 而**一道看得见的闸门，比我以为"没有闸门"更常见**。
      //
      //   教训是双向的：① 我加新判据之前**没有先查"这件事有没有人管"**
      //   （`grep` 一次 `状态标记` 就能看到）；② 更糟的是，我**改内容**去迎合
      //   一个我以为不存在的问题，而那个改动**破坏了一条别人写好的判据**。
      //   ⇒ 处置：**回退**那三格（原文是对的），本模块**不再判状态词表**——
      //   两份词表并存必然漂移（一份说合法、另一份说非法），而漂移的那一天
      //   没人知道该信哪一份。由 `feature-table.test.mjs` 的 ② 系列**钉住
      //   那个所有者还在**，而不是自己再抄一份。
      //
      //   ⚠️ 因此本判据对"状态列"**只做一件事**：把它原样读进 `rows`
      //   （供报告与人工核对），**不评价**。

      const paths = refsIn(loc)
      let currentDir = null
      let resolved = 0
      let ambiguous = 0
      let ignored = 0
      const unresolved = []
      if (pathCheckAvailable) {
        for (const p of paths) {
          const rr = resolveRef(p, { files: tracked, currentDir })
          // ★ 解析到之后要把"当前目录"推进去：单元格 `runtime/contracts/adapter.mjs`、
          //   `run.mjs` 里的第二个是**同目录的裸名**。只在"看起来像目录"时推，
          //   会让 `run.mjs` 落到后缀索引里变成 ambiguous —— 它其实指得很清楚。
          if ((rr.kind === 'exact' || rr.kind === 'suffix' || rr.kind === 'dir') && rr.hits.length) {
            const d = rr.hits[0].slice(0, rr.hits[0].lastIndexOf('/'))
            if (d) currentDir = d
            resolved++
          } else if (rr.kind === 'ambiguous') {
            ambiguous++
            unresolved.push(`${p}（多候选：${rr.hits.join(' / ')}）`)
          } else if (rr.kind === 'missing') {
            unresolved.push(`${p}（解析不到）`)
          } else {
            // route / placeholder / empty：作者**故意**没写死文件，不算错
            ignored++
          }
        }
        // ★★ 判红的条件比"`resolved === 0`"窄，这是刻意的：
        //   只有"**每一条落点都查不到**"才说明这行指着空。
        //   · 有任一条 ambiguous ⇒ 我**无法判定**（可能指对了，只是裸名太常见）
        //   · 有任一条是路由/占位符 ⇒ 作者没打算写文件
        //   这两种情况都**不能**说"它指着不存在的东西"——
        //
        //   > 一个"我认不出这个写法"与一个"这个写法指着空"，
        //   > 在只报"一条都解析不到"的判据里是同一个输出；
        //   > 而前者会让人去改一份**其实是对的**文档。
        const allMissing = paths.length > 0 && resolved === 0 && ambiguous === 0 && ignored === 0
        if (allMissing) {
          hard.push(`L${r.line} ${id} 的「代码落点」里**一条都解析不到** ⇒ 这一行指着不存在的东西`)
        } else if (unresolved.length > 0) {
          // ⚠️ 只报告：裸名/大括号/路由都可能落到这里，而它们多数是**省略**不是错。
          soft.push(`L${r.line} ${id}：${unresolved.join('；')}`)
        }
      }
      rows.push({
        line: r.line,
        id,
        status,
        paths,
        resolved: pathCheckAvailable ? resolved : null,
        ambiguous: pathCheckAvailable ? ambiguous : null,
        unresolved: pathCheckAvailable ? unresolved : null,
      })
    }
  }

  const missing = FEATURE_IDS.filter((id) => !covered.has(id))
  return {
    covered: [...covered].sort(),
    missing,
    rows,
    problems: [...hard, ...missing.map((id) => `优化文档里点名了 ${id}，而对照表里没有它`)],
    soft,
    parsedRows,
    pathCheckAvailable,
  }
}
