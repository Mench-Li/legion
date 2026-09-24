// scripts/prt/feature-landing-paths.mjs
// ============================================================================
// 功能对照表「代码落点」那一列引的每个路径，**必须让读者找得到**。
//
// ---------------------------------------------------------------------------
// ★ 起因（第 31 轮）：那条从第 25 轮就"路由到别处"的判断，本轮**量完**了
//
// 第 25 轮发现 F-21 那格引的是 `plugins/connector-feedback.mjs`，而文件实际在
// `runtime/dsh-composition/plugins/connector-feedback.mjs`——当时判断"代码落点正确性
// 归第 27 轮那种判据管"，**没有**顺手改。本轮把它量完。
//
// 量出来的第一版读数是「49 个引用里 **23 个解不开**」——**那是假读数**，两次：
//
//   ① 遍历没排 worktree 副本 ⇒ `.legion-worktrees/*/team-hub/server.mjs` 把
//      `server.mjs` 的计数撑成 **38**（看起来像"名字有歧义"，其实是我的遍历没排干净）；
//   ② 我把每个名字**独立**拼路径，而这一列的写法是**有惯例**的：
//
//        一格里的**第一个带目录的路径**确立目录，其后的**裸文件名**继承那个目录。
//        例：`runtime/contracts/adapter.mjs`、`run.mjs`、`errors.mjs`
//            ⇒ 后两个是 `runtime/contracts/run.mjs` / `runtime/contracts/errors.mjs`
//
//  按惯例重扫：**原样解得开 36 + 沿本格继承解得开 12 = 48**，剩下的 1 个也不缺——
//  它在**全仓唯一的同名文件**里找得到。⇒ **0 个真缺陷。**
//
//   > 一个"23 处坏引用"的读数，与一个"我的解析器不懂这列的惯例"的读数，
//   > 在只看那一行输出的屏幕上，是同一个东西。
//
// ---------------------------------------------------------------------------
// ★ 于是这条判据要断言的，不是"路径拼得对"，而是**"读者找不找得到"**
//
// 一条路径对读者有用，当且仅当：
//
//   R1 **带目录的路径**（含 `/`）⇒ 必须**存在**。
//   R2 **裸文件名**（不含 `/`）⇒ 必须在全仓**恰好一个**同名文件。
//      ★ 这一条是这列简写的**合法性条件**：`run.mjs` 能当简写用，是因为全仓只有
//        一个 `run.mjs`。哪天多出第二个，那个简写就变成**读者无法解析**的引用——
//        而它**今天仍然"看起来是对的"**（名字没错、文件也在）。
//   R3 一格里的目录确立沿用上面的惯例：先试原样，再试沿本格已确立的目录。
//
// ★ 扫描面用 `git ls-files`（**只看被跟踪的文件**），理由与套件计数那条一致：
//   确定性、不受未跟踪的 worktree 副本影响。
//
// ★ 扫到 0 个引用 / 0 行功能 ⇒ **失败**，不是通过（"什么都没查"≠"全对"）。
// ============================================================================
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// ★★★ 第 48 轮：功能表**数据行的识别**归 `progress-check.mjs` 所有。
import { featureTableRow } from './progress-check.mjs'

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const STATUS_DOC = 'docs/MULTI-AGENT-FEATURE-STATUS.md'

/**
 * ★★★ 第 48 轮：这里原来有一个 `FEATURE_ROW_RE = /^\|\s*F-\d+/`。
 *   交出**行识别权**之后它**一个使用者都没有了**（`git grep FEATURE_ROW_RE` 只剩定义）
 *   ⇒ 删掉。
 *
 *   ★ 留着它就是本批一直在处理的那个形状："**声明还在，用它的人没了**"。
 *     而它与"这份声明真的在被遵守"在阅读代码时长得一样 ——
 *     一个空的承诺比没有承诺更难发现。
 */

/** 「代码落点」是第 4 格（下标 3）。★ 行的**识别**归 `progress-check.featureTableRow`。 */
export const LANDING_COLUMN = 3

/** 看起来像"一个文件路径"的 token。★ 含通配符的也算——它们要被**数出来**再跳过，
 *  否则"跳过了 0 个通配"与"这一列根本没有通配"在输出上是同一个读数。 */
export const PATH_RE = /^[\w./*?-]+\.(?:mjs|ts|js|json|yml|yaml|md|sql)$/

const hasGlob = (s) => /[*?]/.test(s)

/** `orchestrator/worker/{executor,main}.mjs` → 两个具体路径。 */
export function expandBraces(p) {
  const m = /\{([^}]+)\}/.exec(String(p))
  if (m === null) return [String(p)]
  const out = []
  for (const alt of m[1].split(',')) {
    out.push(...expandBraces(String(p).slice(0, m.index) + alt.trim() + String(p).slice(m.index + m[0].length)))
  }
  return out
}

/**
 * 抽出功能表每一行的「代码落点」格。返回 `[{line, id, cell}]`。
 *
 * ★★★ 第 48 轮：**行识别交给所有者**（`progress-check.featureTableRow`）。
 *
 *   本函数此前自己判行、自己分格、**自己定格子数**（`≠5 且 ≠6 ⇒ continue`）。
 *   实测（`scripts/probes/_probe-landing-owner.mjs`）：真文档上四个解析器**一致**
 *   （都是 29 行），但**4 格与 7 格的行被它静默跳过**，而所有者收下。
 *
 *   ★★ 后果比第 47 轮那次**更重**：本模块的职责是
 *     "功能表声明的代码落点必须指向**存在的文件**"。
 *     一行被跳过 ⇒ **它声明的路径一个都不会被核**，而门禁报"全部通过"。
 *
 *   > 一个"这一行我没看懂所以跳过"的默认动作，
 *   > 与"这一行真的没问题"，在输出里都是"没有报错"。
 *   > 区别只在于：前者会让你**以为**你核过了。
 */
export function parseLandingCells(statusText) {
  const out = []
  const lines = String(statusText).split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const row = featureTableRow(lines[i])
    if (row === null) continue
    out.push({ line: i + 1, id: row.label, cell: row.cells[LANDING_COLUMN] ?? '' })
  }
  return out
}

/** 把一格的落点文本摊成 token 列表。 */
export function tokensOf(cell) {
  const out = []
  for (const m of String(cell).matchAll(/`([^`]+)`/g)) {
    for (const raw of expandBraces(m[1].trim())) {
      const t = raw.trim()
      if (!PATH_RE.test(t)) continue          // 不是文件路径（函数名、字段名…）
      out.push(t)
    }
  }
  return out
}

/**
 * 核对落点。
 *
 * @param {{statusText: string, tracked: string[]}} input
 *   `tracked` 是仓库里**被跟踪**的文件清单（相对路径、`/` 分隔）。
 */
export function checkLandingPaths({ statusText, tracked }) {
  const rows = parseLandingCells(statusText)
  const trackedSet = new Set(tracked)
  /** 同名文件的索引：basename → [路径] */
  const byName = new Map()
  for (const p of tracked) {
    const n = p.slice(p.lastIndexOf('/') + 1)
    if (!byName.has(n)) byName.set(n, [])
    byName.get(n).push(p)
  }

  const violations = []
  let scanned = 0
  let exact = 0
  let inherited = 0
  let viaUniqueName = 0
  let globbed = 0

  for (const row of rows) {
    let dir = null // 本格已确立的目录
    for (const t of tokensOf(row.cell)) {
      if (hasGlob(t)) { globbed += 1; continue }
      scanned += 1
      const bare = !t.includes('/')

      // R1 / 原样
      if (trackedSet.has(t)) {
        exact += 1
        if (!bare) dir = dirname(t)
        else if (byName.get(t).length === 1) dir = dirname(byName.get(t)[0])
        continue
      }
      // R3 / 沿本格已确立的目录
      if (dir !== null) {
        const cand = `${dir}/${t}`
        if (trackedSet.has(cand)) {
          inherited += 1
          continue
        }
      }
      // R2 / 裸名：全仓恰好一个同名文件（这就是这列简写的合法性条件）
      if (bare) {
        const hits = byName.get(t) ?? []
        if (hits.length === 1) { viaUniqueName += 1; continue }
        if (hits.length === 0) {
          violations.push({
            id: 'landing-path-missing', feature: row.id, token: t,
            message: `第 ${row.line} 行（${row.id}）的「代码落点」引了 \`${t}\`，`
              + '而**全仓没有任何这个文件**。',
          })
        } else {
          violations.push({
            id: 'landing-path-ambiguous', feature: row.id, token: t,
            message: `第 ${row.line} 行（${row.id}）的「代码落点」引了裸文件名 \`${t}\`，`
              + `而全仓有 **${hits.length}** 个同名文件（${hits.slice(0, 4).join('、')}${hits.length > 4 ? '…' : ''}）`
              + '⇒ 读者按这个名字**找不出**指的是哪一个。'
              + '修法：在这一格前面写一次带目录的路径，让后面的裸名有目录可继承。',
          })
        }
      } else {
        violations.push({
          id: 'landing-path-missing', feature: row.id, token: t,
          message: `第 ${row.line} 行（${row.id}）的「代码落点」引了带目录的路径 \`${t}\`，`
            + '而它**不在被跟踪的文件里**。',
        })
      }
    }
  }

  // ★ 扫到 0 ⇒ "什么都没查"，不许报绿
  if (rows.length === 0) {
    violations.push({
      id: 'landing-scan-empty-rows',
      message: '功能表里一行 F-NN 都没解析到 ⇒ 这条判据**什么都没查**。',
    })
  }
  if (scanned === 0) {
    violations.push({
      id: 'landing-scan-empty-paths',
      message: '一格的「代码落点」里都没解析出路径 ⇒ 这条判据**什么都没查**'
        + '（解析器跑偏与"全部合规"在只报 ok 的输出里是同一个东西）。',
    })
  }

  return {
    ok: violations.length === 0,
    rows: rows.length, scanned, exact, inherited, viaUniqueName, globbed,
    violations,
  }
}

/**
 * ★★ T6（2026-09-24）：一行里的"**可核的锚**"。
 *
 *   T6 行原来的说法是「引用 0 路径的 4 行（F-02/F-12/F-23/F-25）另找核法」。
 *   实测（STATUS 文档今天的原文）**只有两条没有路径**：F-23（L189）与 F-25（L191），
 *   而它们的状态是 **⏸ 按设计归档** —— 依据格写的是 §2 / §9 的**设计决定**，
 *   并且在决策台账里有一条 **已裁决**。F-02（L53）与 F-12（L64）都引了路径。
 *
 *   > 于是"另找核法"要找的，不是"给这两行也配一条路径"，
 *   > 而是把一个更一般的问题问出来：**这一行，凭什么可以被核？**
 *   > 一条谁也核不了的 ✅/🟡/⏸，与一条核实了的，在表里长得一样。
 *
 *   锚有四类，任一类成立即可：代码落点路径 / 套件名 / §条款。
 *   而 **⏸ 行另加两条**：必须指得到条款（设计决定），**且**该条在决策台账里有裁决。
 */
export const ROW_CLAUSE_RE = /§\s*\d+(?:\.\d+)*/g
export const ROW_SUITE_RE = /套件\s*`([^`]+)`/g

/** 一行里四类锚的现状。 */
export function rowAnchors(row, tracked = undefined) {
  const text = row.cells.join(' ')
  const paths = tokensOf(row.cells[LANDING_COLUMN] ?? '')
  const suites = [...text.matchAll(ROW_SUITE_RE)].map((m) => m[1])
  const clauses = [...text.matchAll(ROW_CLAUSE_RE)].map((m) => m[0])
  const dirGlobs = dirGlobAnchors(row, tracked)
  // ★ 通配锚算不算数，取决于"它指的那个**目录还在不在**"：
  //   `product/launcher/*` 指向一个真实存在的目录 ⇒ 读者能去那里找；
  //   而一个指向不存在目录的通配，与没写是同一件事（却看起来写了）。
  const usableGlobs = dirGlobs.filter((g) => tracked === undefined || g.exists === true)
  return {
    paths, suites, clauses, dirGlobs,
    any: paths.length > 0 || suites.length > 0 || clauses.length > 0 || usableGlobs.length > 0,
  }
}

/**
 * ★★ **目录通配**锚：`` `product/launcher/*` `` 这类。
 *
 *   为什么单列一类：落点门禁**跳过通配**（它核不了"这个目录下每一个文件"），
 *   所以"引了一个通配"比"引了一个具体文件"**弱**。但弱不等于不是锚 ——
 *   只要那个目录**真的存在**，读者就找得到地方。
 *
 *   > 把两种强度混成一个"有锚"，等于用后面那种的诚实去替前面那种背书。
 */
export function dirGlobAnchors(row, tracked = undefined) {
  const out = []
  for (const m of String(row.cells[LANDING_COLUMN] ?? '').matchAll(/`([^`]+)`/g)) {
    const raw = m[1].trim()
    if (!raw.includes('*')) continue
    const star = raw.indexOf('*')
    const dir = raw.slice(0, star).replace(/\/+$/, '')
    if (dir === '' || !dir.includes('/')) continue
    const prefix = dir + '/'
    const exists = tracked === undefined ? null : tracked.some((p) => p.startsWith(prefix))
    out.push({ raw, dir, exists })
  }
  return out
}

/**
 * 决策台账里**已被裁决**的那些条目：第三格恰好是「已裁决」的行，第二格里的 `F-NN`。
 * 返回 `Map<F-NN, 行号>`（行号给人读，报红时能直接去看）。
 */
export function parseRuledFeatures(statusText) {
  const out = new Map()
  const lines = String(statusText).split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim()
    if (!t.startsWith('|')) continue
    const cells = t.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim())
    if (cells.length < 4) continue
    if (cells[2] !== '已裁决') continue
    for (const m of cells[1].matchAll(/F-\d+/g)) {
      if (!out.has(m[0])) out.set(m[0], i + 1)
    }
  }
  return out
}

/**
 * ★★ T6：**每一行都要有可核的锚**；⏸ 行还要"条款 + 裁决"两样。
 *
 * @param {{statusText: string}} input
 */
export function checkRowAnchors({ statusText, tracked }) {
  const violations = []
  const ruled = parseRuledFeatures(statusText)
  const lines = String(statusText).split(/\r?\n/)
  let rows = 0
  let byPath = 0
  let byDirGlob = 0
  let bySuite = 0
  let byClause = 0
  let paused = 0

  for (let i = 0; i < lines.length; i += 1) {
    const row = featureTableRow(lines[i])
    if (row === null) continue
    rows += 1
    const a = rowAnchors(row, tracked)
    if (a.paths.length > 0) byPath += 1
    else if (a.dirGlobs.some((g) => g.exists === true)) byDirGlob += 1
    else if (a.suites.length > 0) bySuite += 1
    else if (a.clauses.length > 0) byClause += 1
    else {
      const danglingGlob = a.dirGlobs.filter((g) => g.exists === false)
      violations.push({
        id: 'feature-row-no-anchor', feature: row.id,
        message: `第 ${i + 1} 行（${row.id}）**没有任何可核的锚**：`
          + '既没有能解析到的「代码落点」文件路径，也没有套件名，也没有 §条款'
          + (danglingGlob.length > 0
            ? `。★ 它引了目录通配 ${danglingGlob.map((g) => `\`${g.raw}\``).join('、')}，`
              + '但那个目录**不在被跟踪的文件里** ⇒ 读者去了也是空的'
            : '')
          + '。⇒ 这一行是 ✅ 还是 🟡 还是 ⏸，**没有任何东西**在核它。'
          + '修法：补一条能让别人机械地核回来的锚（路径 / 目录 / 套件 / §条款 / 裁决）。',
      })
    }

    if (row.status === '⏸') {
      paused += 1
      if (a.clauses.length === 0) {
        violations.push({
          id: 'feature-paused-without-clause', feature: row.id,
          message: `第 ${i + 1} 行（${row.id}）是 **⏸**，却没有指到任何 **§条款**。`
            + '⏸ 的意思是"**按设计**不做"，那就必须指出是哪一条设计决定 —— '
            + '否则它与"没人做"在表里是同一个形状。',
        })
      }
      if (!ruled.has(row.id)) {
        violations.push({
          id: 'feature-paused-without-ruling', feature: row.id,
          message: `第 ${i + 1} 行（${row.id}）是 **⏸**，而**决策台账里找不到它的裁决**`
            + '（台账里第三格为「已裁决」的行，第二格要写到这个 F-NN）。'
            + '⇒ 一条"按设计归档"的状态，如果台账里没有对应裁决，它就不能自称是设计决定。',
        })
      }
    }
  }

  if (rows === 0) {
    violations.push({
      id: 'anchor-scan-empty-rows',
      message: '功能表里一行 F-NN 都没解析到 ⇒ 这条判据**什么都没查**。',
    })
  }

  return {
    ok: violations.length === 0,
    rows, paused, byPath, byDirGlob, bySuite, byClause, ruled: ruled.size, violations,
  }
}

/** 从磁盘按真实仓库核对。 */
export function checkRepo({ cwd = REPO } = {}) {
  const tracked = execFileSync('git', ['ls-files'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').map((s) => s.trim()).filter((s) => s !== '')
  const statusText = readFileSync(resolve(cwd, STATUS_DOC), 'utf8')
  const paths = checkLandingPaths({ statusText, tracked })
  const anchors = checkRowAnchors({ statusText, tracked })
  return {
    ...paths,
    anchors,
    violations: [...paths.violations, ...anchors.violations],
    ok: paths.ok && anchors.ok,
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) {
  const r = checkRepo()
  console.log(`feature-landing-paths: 功能行 ${r.rows} 行；落点引用 ${r.scanned} 个 —— `
    + `原样解得开 ${r.exact}、沿本格目录继承 ${r.inherited}、`
    + `全仓唯一同名 ${r.viaUniqueName}；跳过通配 ${r.globbed}`)
  const a = r.anchors
  // ★ 下面这串数字是"**每行按优先级归一类**"（路径 > 目录通配 > 套件 > §条款），
  //   不是"锚的总数"：F-02 既有目录通配又有套件名，它只出现在"目录通配"那一格。
  //   混读这两种口径，会让"按套件 0"看起来像"没有行靠套件支撑"。
  console.log(`  每行的**可核锚**（T6，每行按优先级归一类）：${a.rows} 行 —— 按路径 ${a.byPath}、`
    + `按**目录通配**（目录存在）${a.byDirGlob}、按套件 ${a.bySuite}、按 §条款 ${a.byClause}；`
    + `⏸ 行 ${a.paused} 行，决策台账「已裁决」条目 ${a.ruled} 条`)
  for (const v of r.violations) console.log(`  ✖ ${v.message}`)
  if (r.ok) {
    console.log('  ✅ 每个落点都让读者找得到（带目录的存在；裸名全仓唯一）')
    console.log('  ✅ 每一行都有可核的锚；⏸ 行都指得到了条款，且台账里都有裁决')
  }
  process.exit(r.ok ? 0 : 1)
}
