// product/lifecycle/store-scan.mjs
// ============================================================================
// PRT-904 / PRT-905 / PRT-908 的**共同前置**：把产品自己的数据落点从磁盘上读出来。
//
// ## 为什么需要它（第 118 轮第十五轮实测出来的那个缺口）
//
// 那三个模块的主入口**都要一份入参**：
//
//   · `planExport({stores})`            ← 磁盘上**实际存在**的落点（带类别）
//   · `planRetention({entries})`        ← 逐条的 `{path, bytes, atMs}`
//   · `planUninstall({stores, mode})`   ← 同 `planExport`
//
// 而在这之前，**仓里没有任何一处产生这份入参** —— 于是三份"计划"长期停在
// "模块与用例齐备、零生产调用方"：
//
//   · `product/init.mjs:268` 的 `directorySize()` 走同一棵树，但它**只回一个总量**；
//   · `product/compliance/inventory.mjs:79` 的 `walk()` 回的是**路径字符串**，
//     既不带类别也不带大小。
//
// ## 五个会安静出错的坑（每一个在读数上都像"扫完了"）
//
// ### ① 目录不存在
//
// `dataDir` 还没建时，返回空数组 ⇒ 上层读成"扫完了，什么都没有"。
// 而真相是"这里**根本没有东西可扫**"。对上层这是**不同的决定**
// （"没什么好导的"不该被读成"导完了"）。
//
// ### ② 读不了的子目录
//
// 权限不足时静默跳过 ⇒ 报出来的清单看起来**完整**，而少了一整棵子树。
// 照 `inventory.mjs:87` 那句：读不了的目录**不算**"没有清单"。
//
// ### ③ 没有上限
//
// 产品数据目录可能有几十万条 ⇒ 一次 `--uninstall-plan` 变成一台磁盘扫描器，
// 而用户以为自己在"看一眼计划"。有上限就必须**说出来**：`truncated`。
//
//   > 一个「扫到上限就停、并说没扫完」的扫描，
//   > 与一个「扫到上限就停、当作扫完了」的扫描，在计划正文里是同一个东西 ——
//   > 只不过后者会让人**签字删掉一个他没看见的清单**。
//
// ### ④ 认不出的落点被猜一个类别（最危险的一个）
//
// `classifyPath()` 对"在 `dataDir` 下但没标注"的落点**故意**返回 `classId: null`
// （`data-classes.mjs:167` 与 `:202` 逐字写着"不猜一个默认类"）。
// 本模块**原样带出去**，让上层报它们本来就设计好的拒绝：
// `planUninstall` 的 `uninstall-unclassified-store`、`planExport` 的 `export-class-unknown`。
//
//   > 一个「猜一个类别把落点塞进计划」的扫描，
//   > 与一个「把用户的密钥库当成业务数据库、于是按『保留数据』留下它」的卸载，
//   > 是同一个东西 —— 只不过它在绝大多数落点上都是对的。
//
// ### ⑤ 跟着符号链接走出了根
//
// 链接指到根外时，扫出来的是**别人的文件**——而它们会带着本产品的落点名进计划。
// 本模块**不跟随**符号链接（目录与文件都不跟），并把跳过的条数报出来。
// ============================================================================

import { readdirSync, statSync, existsSync } from 'node:fs'

import { classifyPath } from './data-classes.mjs'

/** 扫描结果的格式版本。 */
export const STORE_SCAN_VERSION = 'legion/store-scan@1'

export const STORE_SCAN_CODES = Object.freeze({
  /** 一个根都没给——"没扫"不是"扫过了、是空的"。 */
  NO_ROOTS: 'scan-no-roots',
  /** 根不存在（还没建出来，或已被删）。 */
  ROOT_MISSING: 'scan-root-missing',
  /** 根既不是文件也不是目录。 */
  ROOT_NOT_DIR: 'scan-root-not-dir',
  /** 目录读不了（权限/占用）——少了一棵子树，清单**不完整**。 */
  UNREADABLE_DIR: 'scan-unreadable-dir',
  /** 取不到大小/时间——`planRetention` 会因此少一条判断依据。 */
  STAT_FAILED: 'scan-stat-failed',
  /** 跳过了符号链接（不跟随，见文件头坑⑤）。 */
  SYMLINK_SKIPPED: 'scan-symlink-skipped',
  /** `classifyPath` 认不出这一类——**原样带出**，不猜。 */
  UNCLASSIFIED: 'scan-unclassified',
  /** 到上限了：**没扫完**。 */
  TRUNCATED: 'scan-truncated',
})

/** 默认上限。与 `init.mjs:273` 的 `maxEntries` 同一个量级与同一条理由。 */
export const DEFAULT_MAX_ENTRIES = 20000

/** 按平台拼接（与 `init.mjs` / `launcher.mjs` 同口径：规范化分隔符，便于路径比较）。 */
function joinPath(platform, ...parts) {
  const sep = platform === 'win32' ? '\\' : '/'
  return parts
    .map((p, i) => {
      const s = String(p).replace(/[\\/]+/g, sep)
      return i === 0 ? s.replace(new RegExp(`${sep}+$`), '') : s.replace(new RegExp(`^${sep}+|${sep}+$`, 'g'), '')
    })
    .filter((p) => p !== '')
    .join(sep)
}

/** 根的规范化形态：`{dir, note}` 与裸字符串都收。 */
function normalizeRoot(root) {
  if (typeof root === 'string') return { dir: root, note: null }
  if (root !== null && typeof root === 'object') {
    return { dir: String(root.dir ?? ''), note: root.note ?? null }
  }
  return { dir: '', note: null }
}

/**
 * 扫出产品自己的数据落点。
 *
 * @param {object} [args]
 * @param {ReadonlyArray<string | {dir: string, note?: string}>} [args.roots]
 *   **要扫哪些根**，由调用方给（本模块一个默认值都不加：给哪些根是一个产品决定）。
 *   根可以是**目录**（走进去）或**文件**（就那一个落点，如 `layout.secretsFile`）。
 * @param {object} [args.layout] `resolveLayout` 的 layout，用于 `classifyPath`
 * @param {number} [args.maxEntries] 访问条目数的上限（到上限 ⇒ `truncated: true`）
 * @param {object} [args.io] 注入的文件系统调用（只用于用例）
 * @param {string} [args.platform]
 * @returns {{version: string, roots: ReadonlyArray<object>, stores: ReadonlyArray<object>,
 *            findings: ReadonlyArray<object>, scanned: number, truncated: boolean}}
 */
export function scanStores({
  roots = [],
  layout = {},
  maxEntries = DEFAULT_MAX_ENTRIES,
  io = {},
  platform = process.platform,
} = {}) {
  const exists = io.exists ?? ((p) => existsSync(p))
  const stat = io.stat ?? ((p) => statSync(p))
  const readdir = io.readdir ?? ((p) => readdirSync(p, { withFileTypes: true }))

  const findings = []
  const stores = []
  const rootsSeen = []
  let scanned = 0
  let truncated = false
  let symlinksSkipped = 0

  const normalized = roots.map(normalizeRoot).filter((r) => r.dir !== '')
  if (normalized.length === 0) {
    findings.push(Object.freeze({
      code: STORE_SCAN_CODES.NO_ROOTS,
      detail: '一个根都没有给 —— "没扫"与"扫过了、是空的"必须分开：'
        + '后者可以据此说"没什么好导的"，前者什么都不能说',
    }))
    return Object.freeze({
      version: STORE_SCAN_VERSION, roots: Object.freeze([]), stores: Object.freeze([]),
      findings: Object.freeze(findings), scanned: 0, truncated: false,
    })
  }

  /** 记一个落点（文件）。类别由 `classifyPath` 给，**认不出就原样带出**。 */
  const noteFile = (filePath, root) => {
    const { classId, reason } = classifyPath({ path: filePath }, layout)
    let bytes = null
    let atMs = null
    try {
      const st = stat(filePath)
      bytes = typeof st.size === 'number' ? st.size : null
      atMs = typeof st.mtimeMs === 'number' ? st.mtimeMs : null
    } catch (err) {
      findings.push(Object.freeze({
        code: STORE_SCAN_CODES.STAT_FAILED,
        path: filePath,
        detail: `取不到大小/时间（${String(err?.code ?? err?.message ?? err)}）——`
          + '保留这一条，但它的容量核算与"多久以前"都缺依据',
      }))
    }
    stores.push(Object.freeze({
      path: filePath,
      root,
      classId,
      classReason: reason,
      bytes,
      atMs,
    }))
    if (classId === null) {
      findings.push(Object.freeze({
        code: STORE_SCAN_CODES.UNCLASSIFIED,
        path: filePath,
        detail: `${reason} —— 原样带出，由上层拒绝（不在这里猜一个类别）`,
      }))
    }
  }

  for (const root of normalized) {
    rootsSeen.push(Object.freeze({ dir: root.dir, note: root.note }))

    if (!exists(root.dir)) {
      findings.push(Object.freeze({
        code: STORE_SCAN_CODES.ROOT_MISSING,
        root: root.dir,
        detail: '这个根不存在（还没建出来，或已被删）—— '
          + '它下面的落点数**不是 0**，是**不知道**',
      }))
      continue
    }

    let st = null
    try { st = stat(root.dir) } catch { st = null }
    if (st === null) {
      findings.push(Object.freeze({
        code: STORE_SCAN_CODES.ROOT_NOT_DIR, root: root.dir,
        detail: '取不到这个根的信息 —— 当作"没扫"，不当作"空的"',
      }))
      continue
    }

    // 根本身就是一个文件（如 `layout.secretsFile`）：它就是一个落点。
    if (st.isFile?.() === true || (st.isDirectory?.() !== true && st.isFile === undefined)) {
      scanned += 1
      noteFile(root.dir, root.dir)
      continue
    }

    const walk = (dir) => {
      if (truncated) return
      let entries = null
      try { entries = readdir(dir) } catch (err) {
        findings.push(Object.freeze({
          code: STORE_SCAN_CODES.UNREADABLE_DIR,
          path: dir,
          detail: `读不了这个目录（${String(err?.code ?? err?.message ?? err)}）—— `
            + '这一棵子树不在清单里，而清单看起来是完整的',
        }))
        return
      }
      for (const entry of entries) {
        if (scanned >= maxEntries) {
          truncated = true
          findings.push(Object.freeze({
            code: STORE_SCAN_CODES.TRUNCATED,
            at: dir,
            detail: `访问条目数到上限 ${maxEntries} 就停了 —— **没扫完**。`
              + '清单不完整，别拿它当"全部落点"签字',
          }))
          return
        }
        scanned += 1
        if (entry.isSymbolicLink?.() === true) {
          symlinksSkipped += 1
          continue
        }
        const child = joinPath(platform, dir, entry.name)
        if (entry.isDirectory?.() === true) { walk(child); continue }
        noteFile(child, root.dir)
      }
    }
    walk(root.dir)
  }

  if (symlinksSkipped > 0) {
    findings.push(Object.freeze({
      code: STORE_SCAN_CODES.SYMLINK_SKIPPED,
      count: symlinksSkipped,
      detail: `跳过了 ${symlinksSkipped} 个符号链接 —— 它们可能指到根外，`
        + '扫出来会是**别人的文件**；"没扫"与"扫了但没有"必须分开',
    }))
  }

  return Object.freeze({
    version: STORE_SCAN_VERSION,
    roots: Object.freeze(rootsSeen),
    stores: Object.freeze(stores),
    findings: Object.freeze(findings),
    scanned,
    truncated,
  })
}
