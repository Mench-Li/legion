// product/init.mjs
// ============================================================================
// 产品目录与首次运行初始化（PRT-706）
//
// spec §6.10 把「首次运行初始化」列为 Launcher 必须提供的第一项；§6.11 规定了
// 五类目录的职责。本文件负责把「一次都没有过的安装」变成「可以启动的安装」：
//
//   建目录 → 写最小产品配置（若不存在）→ 校验可写性 → 记录产品元数据
//
// ## 三条边界
//
// ① **绝不在安装目录里创建任何东西。** 安装目录在升级时被整体替换，
//    写进去的产物会消失，更糟的是升级可能因此失败（文件被占用）。
//    这里在**建目录之前**先查布局不变量，命中 error 直接拒绝，一个目录都不建。
//
// ② **绝不动工作区里的已有内容。** 工作区是用户授权的项目目录。
//    初始化只做一件与之相关的事：如果它不存在则**报错**（而不是替用户创建）——
//    替用户创建目录会让「工作区选错了」这件事在很晚才暴露，而那时产品已经写过东西了。
//    唯一的例外是 `.legion/` 子目录，见下。
//
// ③ **幂等，且报告做了什么。** 重复运行不得覆盖用户写过的配置（那是用户的东西），
//    只补齐缺失的部分，并把「本次新建了什么、跳过了什么」如实返回。
//    一个「静默成功」的初始化让「为什么我的配置不见了」无从回答。
//
// ## 为什么不覆盖已有配置文件
//
// 首次运行写入的产品配置只是一份**起点**（`runtime.command` 为空等用户填）。
// 若第二次运行把它覆盖掉，用户在向导里填的东西就没了——而这类丢失没有任何提示。
// 因此「存在即跳过」是这里的硬规则，不是优化。
// ============================================================================

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'

import { assertConfigWritable, isPathInside, layoutDiagnostics, samePath } from './paths.mjs'
import { PRODUCT_CONFIG_FILENAME, defaultProductConfig } from './config.mjs'

/** 产品元数据文件名（DataDir 内）。它回答「这个 DataDir 是谁建的、什么时候」。 */
export const PRODUCT_META_FILENAME = 'product.json'
export const PRODUCT_META_VERSION = 1

/** 需要在 DataDir 下预建的子目录（各进程的写入落点）。 */
export const DATA_SUBDIRS = Object.freeze([
  'team-hub',
  'whiteboard',
  'whiteboard/rooms',
  'whiteboard/audit',
  'orchestrator',
])

/** 按平台拼接（与 launcher.mjs 同口径：规范化分隔符，便于路径比较）。 */
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

/** 目录是否可写（真的写一个临时文件再删掉：`access` 在位掩码语义上会骗人）。 */
export function probeWritable(dir, {
  writeFile = writeFileSync,
  unlinkFile = unlinkSync,
  platform = process.platform,
  probeName = '.legion-write-probe',
} = {}) {
  const path = joinPath(platform, dir, probeName)
  try {
    writeFile(path, 'probe')
  } catch (e) {
    return Object.freeze({ writable: false, code: 'DIR_NOT_WRITABLE', message: `${dir} 不可写：${e?.code ?? e?.message ?? e}` })
  }
  try {
    unlinkFile(path)
  } catch { /* 探测文件删不掉不影响结论：可写性已经证明 */ }
  return Object.freeze({ writable: true, code: null, message: null })
}

/**
 * 初始化产品目录。
 *
 * 所有 I/O 可注入（`exists` / `mkdir` / `writeFile` / `readFile`），
 * 于是「拒绝在安装目录内创建」「不覆盖已有配置」「幂等」这三条判据
 * 都能在不碰真实文件系统的前提下验证。
 */
export function initializeProductDir(layout, {
  platform = layout?.platform ?? process.platform,
  exists = existsSync,
  mkdir = (p, opts) => mkdirSync(p, { recursive: true, ...opts }),
  writeFile = writeFileSync,
  readFile = (p) => readFileSync(p, 'utf8'),
  now = () => new Date().toISOString(),
  productVersion = null,
  dryRun = false,
} = {}) {
  const diagnostics = [...layoutDiagnostics(layout).map((d) => (d))]
  const created = []
  const skipped = []
  const files = []

  // ① 布局本身必须先成立。命中 error 时**一个目录都不建**：
  //    部分初始化会让下一次运行看到一个「像是装好了」的目录树，而它缺东西。
  const blocking = diagnostics.filter((d) => d.severity === 'error')
  if (blocking.length > 0) {
    return Object.freeze({
      ok: false,
      phase: 'layout',
      created: Object.freeze([]),
      skipped: Object.freeze([]),
      files: Object.freeze([]),
      diagnostics: Object.freeze(diagnostics),
    })
  }

  const ensureDir = (dir, { role }) => {
    if (dir === null || dir === undefined) return false
    // 安装目录本身不得被当作可写角色目录创建。落在它**内部**的情形由
    // `layoutDiagnostics` 的 WRITABLE_DIR_INSIDE_INSTALL_DIR 拦下（上一步已判），
    // 这里只补「等于安装目录」这一种，因为它不会被前缀判定命中。
    if (layout.installDir !== null && layout.installDir !== undefined && samePath(dir, layout.installDir, platform)) {
      diagnostics.push(Object.freeze({
        severity: 'error', code: 'INIT_REFUSED_INSTALL_DIR', role,
        message: `拒绝在安装目录内初始化「${role}」（${dir}）：安装目录在升级时被整体替换`,
      }))
      return false
    }
    if (exists(dir)) {
      skipped.push(Object.freeze({ path: dir, role, reason: 'exists' }))
      return true
    }
    if (!dryRun) {
      try {
        mkdir(dir)
      } catch (e) {
        diagnostics.push(Object.freeze({
          severity: 'error', code: 'INIT_MKDIR_FAILED', role,
          message: `创建目录失败 ${dir}：${e?.code ?? e?.message ?? e}`,
        }))
        return false
      }
    }
    created.push(Object.freeze({ path: dir, role }))
    return true
  }

  // ② 可写角色：DataDir / CacheDir / LogDir 由产品建；Workspace **必须已存在**。
  //
  //    `dataDirUsable` 而不是「再 exists 一次」：dryRun 下目录并没有真的建出来，
  //    用文件系统当判据会让 dryRun 安静地少报两个文件——而首次运行向导恰恰靠
  //    dryRun 回答「点下去会发生什么」。判据必须是「这一步成没成」，不是「盘上有没有」。
  const dataDirUsable = ensureDir(layout.dataDir, { role: 'data' })
  ensureDir(layout.cacheDir, { role: 'cache' })
  ensureDir(layout.logDir, { role: 'log' })
  for (const sub of DATA_SUBDIRS) {
    if (layout.dataDir !== null && layout.dataDir !== undefined) {
      ensureDir(joinPath(platform, layout.dataDir, sub), { role: 'data' })
    }
  }

  // 工作区「未指定」不在这里判：那是布局不变量（WORKSPACE_NOT_CONFIGURED，error），
  // 上面已经短路返回了。这里只处理**已指定但不存在**这一种——
  // 同一件事有两个判定点就会有两个口径，而口径不一致时两份都不可信。
  if (layout.workspaceDir !== null && layout.workspaceDir !== undefined && !exists(layout.workspaceDir)) {
    diagnostics.push(Object.freeze({
      severity: 'error', code: 'INIT_WORKSPACE_MISSING', role: 'workspace',
      message: `工作区目录不存在：${layout.workspaceDir}。` +
        '请先创建它或选择另一个目录——产品不会替用户创建项目目录：' +
        '替用户建目录会让「工作区选错了」在很晚才暴露，那时产品已经写过东西了。',
    }))
  } else if (layout.workspaceDir !== null && layout.workspaceDir !== undefined) {
    skipped.push(Object.freeze({ path: layout.workspaceDir, role: 'workspace', reason: 'user-owned' }))
  }

  // ③ 可写性探测（建完再探：探测本身要求目录存在）
  for (const [role, dir] of [['data', layout.dataDir], ['cache', layout.cacheDir], ['log', layout.logDir]]) {
    if (dir === null || dir === undefined) continue
    if (!exists(dir)) continue // 创建失败已经报过
    const probe = dryRun ? { writable: true } : probeWritable(dir, { writeFile })
    if (probe.writable !== true) {
      diagnostics.push(Object.freeze({
        severity: 'error', code: probe.code, role, message: `${probe.message}（角色：${role}）`,
      }))
    }
  }

  // ④ 产品配置：**存在即跳过**（那是用户的东西）
  if (layout.productConfigPath !== null && layout.productConfigPath !== undefined && dataDirUsable) {
    if (exists(layout.productConfigPath)) {
      skipped.push(Object.freeze({ path: layout.productConfigPath, role: 'product-config', reason: 'exists（不覆盖用户配置）' }))
    } else {
      const values = defaultProductConfig()
      try {
        assertConfigWritable(values)
        if (!dryRun) writeFile(layout.productConfigPath, `${JSON.stringify(values, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
        files.push(Object.freeze({ path: layout.productConfigPath, role: 'product-config', action: 'created' }))
      } catch (e) {
        diagnostics.push(Object.freeze({
          severity: 'error', code: 'INIT_CONFIG_WRITE_FAILED', role: 'product-config',
          message: `写入默认产品配置失败 ${layout.productConfigPath}：${e?.message ?? e}`,
        }))
      }
    }
  }

  // ⑤ 产品元数据：记录「这个 DataDir 是谁建的」。已存在则读取并保留 createdAt。
  if (layout.dataDir !== null && layout.dataDir !== undefined && dataDirUsable) {
    const metaPath = joinPath(platform, layout.dataDir, PRODUCT_META_FILENAME)
    if (exists(metaPath)) {
      skipped.push(Object.freeze({ path: metaPath, role: 'product-meta', reason: 'exists' }))
    } else {
      const meta = {
        productMetaVersion: PRODUCT_META_VERSION,
        productVersion: productVersion ?? null,
        createdAt: now(),
        // 记录安装目录的**来源**而不是「当前值」：升级后安装目录会变，
        // 而这个字段的用途是回答「第一次是谁建的」。
        installDirAtCreation: layout.installDir ?? null,
        configFilename: PRODUCT_CONFIG_FILENAME,
      }
      try {
        if (!dryRun) writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
        files.push(Object.freeze({ path: metaPath, role: 'product-meta', action: 'created' }))
      } catch (e) {
        diagnostics.push(Object.freeze({
          severity: 'error', code: 'INIT_META_WRITE_FAILED', role: 'product-meta',
          message: `写入产品元数据失败 ${metaPath}：${e?.message ?? e}`,
        }))
      }
    }
  }

  const ok = diagnostics.filter((d) => d.severity === 'error').length === 0
  return Object.freeze({
    ok,
    phase: ok ? null : 'initialize',
    dryRun,
    created: Object.freeze(created),
    skipped: Object.freeze(skipped),
    files: Object.freeze(files),
    diagnostics: Object.freeze(diagnostics),
  })
}

/** 读回产品元数据（不存在返回 null；解析失败也返回 null 并说明）。 */
export function readProductMeta(layout, { platform = layout?.platform ?? process.platform, exists = existsSync, readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  if (layout?.dataDir === null || layout?.dataDir === undefined) return Object.freeze({ ok: false, meta: null, reason: 'DataDir 未确定' })
  const path = joinPath(platform, layout.dataDir, PRODUCT_META_FILENAME)
  if (!exists(path)) return Object.freeze({ ok: false, meta: null, reason: '未初始化（无 product.json）', path })
  try {
    return Object.freeze({ ok: true, meta: Object.freeze(JSON.parse(readFile(path))), path })
  } catch (e) {
    return Object.freeze({ ok: false, meta: null, reason: `元数据不可解析：${e?.message ?? e}`, path })
  }
}

/** 目录是否像一个已初始化的产品目录（供 Launcher 决定要不要先初始化）。 */
export function isInitialized(layout, { exists = existsSync, platform = layout?.platform ?? process.platform } = {}) {
  if (layout?.dataDir === null || layout?.dataDir === undefined) return false
  if (!exists(layout.dataDir)) return false
  const meta = readProductMeta(layout, { platform, exists })
  if (meta.ok !== true) return false
  return layout.productConfigPath !== null && layout.productConfigPath !== undefined && exists(layout.productConfigPath)
}

/** 目录大小（用于「磁盘容量保护」的前置读数，单位字节）。目录不存在返回 0。 */
export function directorySize(dir, {
  exists = existsSync,
  stat = statSync,
  readdir = (p) => readdirSync(p, { withFileTypes: true }),
  platform = process.platform,
  maxEntries = 200000,
} = {}) {
  if (!exists(dir)) return 0
  let total = 0
  let visited = 0
  const walk = (current) => {
    for (const entry of readdir(current)) {
      if (visited++ > maxEntries) return // 有上限：统计本身不得成为磁盘/时间的负担
      const child = joinPath(platform, current, entry.name)
      if (entry.isDirectory()) walk(child)
      else {
        try { total += stat(child).size } catch { /* 读不到大小不影响其余统计 */ }
      }
    }
  }
  walk(dir)
  return total
}
