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
 *   实测（`scratch/_probe-landing-owner.mjs`）：真文档上四个解析器**一致**
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

/** 从磁盘按真实仓库核对。 */
export function checkRepo({ cwd = REPO } = {}) {
  const tracked = execFileSync('git', ['ls-files'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').map((s) => s.trim()).filter((s) => s !== '')
  return checkLandingPaths({
    statusText: readFileSync(resolve(cwd, STATUS_DOC), 'utf8'),
    tracked,
  })
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) {
  const r = checkRepo()
  console.log(`feature-landing-paths: 功能行 ${r.rows} 行；落点引用 ${r.scanned} 个 —— `
    + `原样解得开 ${r.exact}、沿本格目录继承 ${r.inherited}、`
    + `全仓唯一同名 ${r.viaUniqueName}；跳过通配 ${r.globbed}`)
  for (const v of r.violations) console.log(`  ✖ ${v.message}`)
  if (r.ok) console.log('  ✅ 每个落点都让读者找得到（带目录的存在；裸名全仓唯一）')
  process.exit(r.ok ? 0 : 1)
}
