// product/diagnostics/auto-export.mjs
// ============================================================================
// PRT-710（收尾）：**启动失败时自动出诊断包**
//
// ## 为什么这一条必须自动
//
// `--diagnostics=<dir>` 已经能用，但它要求用户在**产品已经坏掉之后**，
// 还想起来、并且能够，手工敲一条命令。而 PRT-710 自己的定位就是：
//
//   > 诊断包最需要在什么时候拿到？**产品坏掉的时候。**
//
// 一个"坏掉之后可以手工导出"的诊断包，与一个"坏掉时会自动留下证据"的
// 诊断包，在用户**记得去敲那条命令**的时候是同一个东西——
//
//   > 只不过前者会在用户不记得、或者产品坏到连命令行都进不去的时候，
//   > 恰好什么都不留下，而"这次没有证据"与"这次没什么可记的"长得一样。
//
// ## 这一条同时带来的危险（本模块一半的代码在防它）
//
// 自动写盘 = 在**失败循环**里自动写盘。一个每次启动都失败的产品，
// 如果每次失败都留一个包，就会**把磁盘写满**——而磁盘写满会让本来能修好的
// 问题变得更难修（PRT-709 整条任务就是在守这件事）。
//
// 所以：
//   ① **保留份数有上限**（默认 3），且**先清理再写**——
//      顺序反过来的话，崩溃循环里最坏的那一刻是"刚写完第 N+1 个，
//      然后进程死了"，于是清理永远没机会跑。
//   ② **只清理自己认得的东西**：目录名必须匹配本模块自己的命名形状。
//      一个认不出的条目，"最旧"对它没有定义——删掉别人的东西不是"清理"。
//   ③ **失败不改写原因**：诊断包出不来**不能**把启动失败的原因换掉。
//      用户看到的必须仍然是"端口被占用"，后面才附一句"顺带，证据没留下"。
//
//       > 一个"出不了诊断包于是报了个诊断包错误"的启动，
//       > 与一个"真的就是诊断包坏了"的启动，在用户读到的第一行上是同一个东西——
//       > 只不过前者会把一个**已经查明的**故障，换成一句**关于工具的**抱怨。
//
// ## 为什么"判定"要离开 IO
//
// 与 `redact-package.mjs` 拆出 `planPackage` 完全同一条理由：
// **落盘那一步无法在用例里逐条验证，判定那一步可以。**
// `planAutoExport()` 是纯函数（给现有条目 + 现在时刻 + 保留份数，算出
// 该写哪个名字、该删哪些），`runAutoExport()` 才碰文件系统。
// ============================================================================

/** 自动导出的失败码。**每一个都要能被单独观测"为什么没出包"**。 */
export const AUTO_EXPORT_CODES = Object.freeze({
  /** 布局里没有产品家目录：**不猜**位置。 */
  NO_BASE_DIR: 'AUTO_NO_BASE_DIR',
  /** 自动导出被显式关掉了。 */
  DISABLED: 'AUTO_DISABLED',
  /** 清理或读取基础目录失败（权限/磁盘）。 */
  BASE_DIR_FAILED: 'AUTO_BASE_DIR_FAILED',
  /** 导出本身失败（沿用 `DIAG_CODES` 的那一套）。 */
  EXPORT_FAILED: 'AUTO_EXPORT_FAILED',
})

/** 自动导出的默认值。`keep` 是**磁盘上界**的唯一出处。 */
export const AUTO_EXPORT_DEFAULTS = Object.freeze({
  /** 保留几份。3 份 × `DEFAULT_LIMITS.maxTotalBytes`(64MB) = 最坏约 192MB。 */
  keep: 3,
  /** 目录名前缀。**清理只认带这个前缀、且时间戳形状合法的条目**。 */
  prefix: 'diag-',
  /** 基础目录相对产品家目录的位置。 */
  dirName: 'diagnostics',
  /**
   * 扫描基础目录时最多看多少条。
   *
   * 不设这个上限的话，一个被塞了几十万个条目的 `diagnostics/` 目录会让
   * "留下证据"这件事本身变成卡住启动的原因——而它本来是为了让故障更好查。
   */
  maxScan: 2000,
})

/**
 * 目录名的时间戳形状：`diag-YYYYMMDD-HHMMSS`（可带 `-N` 去重后缀）。
 *
 * 这个正则就是"什么是我们认得的东西"的唯一定义。
 * 收紧它是安全的（认不出的只是不会被清理），放宽它是危险的（会删到别人的东西）。
 */
const PACKAGE_DIR_RE = /^diag-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-(\d+))?$/

/** 把一个 Date 渲染成 `YYYYMMDD-HHMMSS`（**本地时间**：用户对"刚才"的直觉是本地时间）。 */
export function stampOf(date) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(date.getFullYear(), 4)}${p(date.getMonth() + 1)}${p(date.getDate())}`
    + `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

/** 认出一个条目是不是本模块自己写的包（**清理的前提**）。 */
export function isOwnPackageName(name, prefix = AUTO_EXPORT_DEFAULTS.prefix) {
  if (typeof name !== 'string') return false
  if (!name.startsWith(prefix)) return false
  return PACKAGE_DIR_RE.test(name)
}

/**
 * ★ 纯判定：该写哪个目录名、该删哪些。
 *
 * @param {object} deps
 * @param {string}   deps.baseDir       基础目录（只用于报错文案，不碰 IO）
 * @param {string[]} deps.entries       基础目录里**现有**的条目名
 * @param {Date}     deps.now
 * @param {number}   [deps.keep]
 * @param {string}   [deps.prefix]
 * @returns {{dirName: string, prune: string[], foreign: string[], keep: number}}
 *   `dirName` 是**保证不与 entries 冲突**的新目录名；
 *   `prune` 是**按旧到新**要删掉的自己的包；
 *   `foreign` 是认不出、因此**一个都不动**的条目。
 */
export function planAutoExport(deps = {}) {
  const {
    entries = [], now = new Date(), keep = AUTO_EXPORT_DEFAULTS.keep,
    prefix = AUTO_EXPORT_DEFAULTS.prefix,
  } = deps
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`keep 必须是 >= 1 的整数（收到 ${keep}）：`
      + '0 会让"保留几份"变成"每次失败都删掉上次的"——那样崩溃循环里留下的永远只有最后一个')
  }

  const foreign = []
  const mine = []
  for (const name of entries) {
    if (isOwnPackageName(name, prefix)) mine.push(name)
    else foreign.push(name)
  }

  // ── 新目录名：同一秒内已有同名时**加去重后缀**，从 2 开始 ──
  //
  // 崩溃循环里一秒内失败两次是常态，而 `exportDiagnosticPackage` **不覆盖**
  // 已有目录（那是对的）。不加后缀的话，第二次失败只会得到一句
  // `DIAG_PACKAGE_EXISTS`，于是"第 2 到第 N 次崩溃没有证据"。
  //
  //   > 一个"同一秒内第二次失败就不留证据"的自动导出，
  //   > 与一个"只在第一次失败时留证据"的自动导出，在崩溃循环里是同一个东西——
  //   > 只不过前者会让人以为导出**一直在跑**。
  const stamp = stampOf(now)
  const taken = new Set(mine)
  let dirName = `${prefix}${stamp}`
  let n = 2
  while (taken.has(dirName)) {
    dirName = `${prefix}${stamp}-${n}`
    n += 1
    // 上界与 keep 同源：留不下那么多份就说明该清理了，而不是无限加后缀。
    if (n > keep + 2) break
  }

  // ── 该删哪些：按名字排序（时间戳字典序 == 时间序），留下**最新**的 keep-1 个 ──
  //
  // `keep` 指的是"这次写完之后总共留几份"，所以要在写入前腾到 keep-1。
  // 先清理再写，是为了让崩溃循环里的磁盘占用**收敛**而不是先涨后清。
  const sorted = [...taken].sort()
  const allowedExisting = Math.max(0, keep - 1)
  const prune = sorted.length <= allowedExisting ? [] : sorted.slice(0, sorted.length - allowedExisting)

  return Object.freeze({
    dirName,
    prune: Object.freeze(prune),
    foreign: Object.freeze(foreign),
    keep,
  })
}

/**
 * 执行自动导出。**永远不抛**：它的调用方正在处理一个已经发生的失败，
 * 这里再抛一个只会把那个原因盖掉。
 *
 * @returns {{ok: boolean, code?: string, path?: string, message: string,
 *            reason: string, pruned: string[], foreign: string[]}}
 */
export async function runAutoExport(deps = {}) {
  const {
    layout = null,
    reason = '启动失败',
    fs = null,
    now = () => new Date(),
    keep = AUTO_EXPORT_DEFAULTS.keep,
    enabled = true,
    prefix = AUTO_EXPORT_DEFAULTS.prefix,
    dirName = AUTO_EXPORT_DEFAULTS.dirName,
    maxScan = AUTO_EXPORT_DEFAULTS.maxScan,
    exportFn = null,
  } = deps

  const base = { ok: false, reason, pruned: [], foreign: [] }

  if (enabled !== true) {
    return Object.freeze({ ...base, code: AUTO_EXPORT_CODES.DISABLED, message: '自动导出已关闭，这次失败没有留下诊断包' })
  }
  // ★ 家目录定不下来时**不猜**：猜出来的位置可能落在用户的别的东西上，
  //   而"把证据写到错的地方"比"这次没有证据"更坏——后者只是没有，前者会污染。
  const home = layout?.productHome
  if (typeof home !== 'string' || home === '') {
    return Object.freeze({
      ...base, code: AUTO_EXPORT_CODES.NO_BASE_DIR,
      message: '布局里没有产品家目录，无法决定诊断包写到哪里（**不猜默认位置**）',
    })
  }

  const io = fs ?? (await import('node:fs'))
  const path_ = await import('node:path')
  const baseDir = path_.join(home, dirName)

  // ── ① 读现有的（读不到就是"读不到"，不是"目录是空的"）──
  let entries = []
  try {
    entries = io.existsSync(baseDir) ? io.readdirSync(baseDir).map(String).slice(0, maxScan) : []
  } catch (e) {
    return Object.freeze({
      ...base, code: AUTO_EXPORT_CODES.BASE_DIR_FAILED, path: baseDir,
      message: `读不到诊断包目录 ${baseDir}：${e instanceof Error ? e.message : e}`,
    })
  }

  const plan = planAutoExport({ entries, now: now(), keep, prefix })

  // ── ② 先清理（在写之前）：让崩溃循环的占用收敛 ──
  const pruned = []
  for (const name of plan.prune) {
    try {
      io.rmSync(path_.join(baseDir, name), { recursive: true, force: true })
      pruned.push(name)
    } catch {
      // 删不掉就留着：**清理失败不是启动失败的原因**，不该把它报成故障。
      // （PRT-709 同一条纪律：删不掉时不要转而做更激进的事。）
    }
  }

  // ── ③ 导出 ──
  const outDir = path_.join(baseDir, plan.dirName)
  try {
    const doExport = exportFn ?? (await import('./redact-package.mjs')).exportDiagnosticPackage
    const r = await doExport({ layout, outDir, fs: io })
    if (r?.ok !== true) {
      return Object.freeze({
        ...base, pruned, foreign: plan.foreign,
        code: AUTO_EXPORT_CODES.EXPORT_FAILED, path: outDir,
        message: `诊断包没有导出成功（${r?.code ?? '未知'}）：${r?.message ?? '无详情'}`,
      })
    }
    return Object.freeze({
      ok: true, reason, pruned, foreign: plan.foreign, path: outDir,
      message: `已自动留下诊断包：${outDir}`,
    })
  } catch (e) {
    return Object.freeze({
      ...base, pruned, foreign: plan.foreign,
      code: AUTO_EXPORT_CODES.EXPORT_FAILED, path: outDir,
      message: `导出诊断包时抛错：${e instanceof Error ? e.message : e}`,
    })
  }
}
