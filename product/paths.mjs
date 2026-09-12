// product/paths.mjs
// ============================================================================
// 产品目录布局与配置优先级（PRT-258 契约冻结 / PRT-254 目录部分）
//
// spec §6.11 把运行目录按职责隔离固定为五个角色：
//
//   InstallDir/   只读程序、固定依赖和 DSH Runtime
//   DataDir/      team-hub 数据库、附件、审计和产品元数据
//   Workspace/    用户授权的项目目录
//   CacheDir/     构建、下载和临时缓存
//   LogDir/       可轮转日志
//
// 并给出配置优先级：`内置默认值 < 产品配置 < 工作空间配置 < 用户设置 < 受控环境变量`。
//
// ## 为什么这里不是「一个 join 调用的小工具」
//
// PRT-003 已经实测到一个真实缺陷：仓库里**有 4 个 path 字段的默认值落在安装目录内**
// （`TEAM_HUB_DB=team-hub/team.db`、whiteboard 的 `DB_PATH`/`WB_ROOMS_DIR`/`WB_AUDIT_DIR`）。
// 安装目录是**升级时会被原子替换**的那一个目录，把业务状态写进去等于让升级吞掉数据。
// 这类缺陷的表现是「今天一切正常」，因此不能只写在文档里——本模块把
// 「可写角色不得位于安装目录内」做成**结构化判定**（`layoutDiagnostics`），
// 由用例守住，任何新角色加进来都会先过这道门。
//
// ## 口径：本模块是纯函数，不读 `process.env`
//
// 环境变量由调用方（Launcher）显式传入。理由有两个：
//   ① 纯函数可对 win32/posix 两套路径语义同时做用例（本机是 Windows，
//      但 Linux 上 CI 也必须能验证布局判定，否则「路径越界」这类判据只在一种平台被测过）；
//   ② 配置面读取点必须可被 `scripts/config/scan.mjs` 扫描，而该扫描器要求
//      每个读取点都在进程 schema 中声明。把读取收敛到 Launcher 一处，
//      就只有一个文件需要声明，而不是两个模块各读一半。
// ============================================================================

import { posix, win32 } from 'node:path'

import { findPlaintextSecrets } from '../runtime/contracts/model.mjs'

/** 目录角色（spec §6.11 的五个目录，顺序即文档顺序）。 */
export const DIR_ROLES = Object.freeze(['install', 'data', 'workspace', 'cache', 'log'])

/** 可写角色：这四个**不得**落在安装目录内，也不得相互嵌套。 */
export const WRITABLE_ROLES = Object.freeze(['data', 'workspace', 'cache', 'log'])

/**
 * 本模块认的全部环境变量（spec §6.11「所有环境变量必须在配置 Schema 中声明」）。
 * 只登记键名，任何值都不进版本库。
 */
export const LEGION_ENV = Object.freeze({
  HOME: 'LEGION_HOME',
  INSTALL_DIR: 'LEGION_INSTALL_DIR',
  DATA_DIR: 'LEGION_DATA_DIR',
  WORKSPACE_DIR: 'LEGION_WORKSPACE_DIR',
  CACHE_DIR: 'LEGION_CACHE_DIR',
  LOG_DIR: 'LEGION_LOG_DIR',
  PRODUCT_CONFIG: 'LEGION_PRODUCT_CONFIG',
  SECRETS_FILE: 'LEGION_SECRETS_FILE',
})

/**
 * 受保护密钥库的默认文件名（相对产品家目录）。
 *
 * **它刻意不在 DataDir 内**，见 `layoutDiagnostics` 的 `SECRETS_INSIDE_DATA_DIR`。
 */
export const SECRETS_DIRNAME = 'secrets'
export const SECRETS_FILENAME = 'credentials.json'

/** 配置层，数组顺序即优先级（后者覆盖前者，spec §6.11）。 */
export const CONFIG_LAYERS = Object.freeze([
  'builtin-defaults',
  'product-config',
  'workspace-config',
  'user-settings',
  'env',
])

/** 配置层的中文名（用户可见文案与诊断共用同一份，避免两处漂移）。 */
export const CONFIG_LAYER_LABELS = Object.freeze({
  'builtin-defaults': '内置默认值',
  'product-config': '产品配置',
  'workspace-config': '工作空间配置',
  'user-settings': '用户设置',
  env: '受控环境变量',
})

/** 诊断等级。`error` 表示不得进入自动执行；`warn` 表示可继续但必须在界面上说明。 */
export const DIAGNOSTIC_SEVERITIES = Object.freeze(['error', 'warn'])

// ---------------------------------------------------------------- 路径语义

/** 按平台取 path 实现：本机是 Windows，但布局判定必须能在两种语义下各测一遍。 */
export function pathApi(platform = process.platform) {
  return platform === 'win32' ? win32 : posix
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** 去掉尾分隔符，但保留根（`D:\` / `/`）——`win32.parse('D:\\').root === 'D:\\'`。 */
function stripTrailingSep(p, api) {
  const root = api.parse(p).root
  let out = p
  while (out.length > root.length && (out.endsWith(api.sep) || (api === win32 && out.endsWith('/')))) {
    out = out.slice(0, -1)
  }
  return out
}

/** 归一化：绝对化 + 去尾分隔符。 */
export function normalizePath(p, platform = process.platform) {
  const api = pathApi(platform)
  return stripTrailingSep(api.resolve(p), api)
}

/** 平台相关的比较键：Windows 大小写不敏感（spec §6.8 canonical operation 的同一条规则）。 */
function compareKey(p, platform) {
  return platform === 'win32' ? p.toLowerCase() : p
}

/** 两个路径是否指向同一处。 */
export function samePath(a, b, platform = process.platform) {
  if (nonEmptyString(a) === null || nonEmptyString(b) === null) return false
  return compareKey(normalizePath(a, platform), platform) === compareKey(normalizePath(b, platform), platform)
}

/**
 * `child` 是否位于 `parent` 之内（严格后代；`parent === child` 返回 false）。
 *
 * 用「补上分隔符后再前缀比较」而不是 `startsWith(parent)`：
 * 后者会让 `C:\LegionData` 被判成 `C:\Legion` 的子目录，而这两个是**并列**目录，
 * 混淆它们正好会让「业务数据落在安装目录内」的门禁漏报（假阴性方向）。
 */
export function isPathInside(parent, child, platform = process.platform) {
  if (nonEmptyString(parent) === null || nonEmptyString(child) === null) return false
  const api = pathApi(platform)
  const p = compareKey(normalizePath(parent, platform), platform)
  const c = compareKey(normalizePath(child, platform), platform)
  const base = p.endsWith(api.sep) ? p : p + api.sep
  return c.startsWith(base)
}

/** 两个路径是否重叠（同一处、或任一方是另一方的祖先）。 */
export function pathsOverlap(a, b, platform = process.platform) {
  return samePath(a, b, platform) || isPathInside(a, b, platform) || isPathInside(b, a, platform)
}

// ---------------------------------------------------------------- 默认布局

/**
 * 默认产品家目录（per-user，spec §6.7「商业 Alpha 固定为 per-user 安装」）。
 *
 * Windows 取 `%LOCALAPPDATA%\Legion`：数据库/日志/缓存是**本机状态**，
 * 放进 Roaming 会跟着账号漫游到别的机器上，而 SQLite 文件与机器绑定。
 */
export function defaultProductHome({ platform = process.platform, env = {}, homeDir, appDataDir } = {}) {
  const api = pathApi(platform)
  const fromEnv = nonEmptyString(env[LEGION_ENV.HOME])
  if (fromEnv !== null) return Object.freeze({ root: normalizePath(fromEnv, platform), source: LEGION_ENV.HOME })
  const home = nonEmptyString(homeDir)
  if (home === null) return Object.freeze({ root: null, source: 'unresolved' })
  if (platform === 'win32') {
    const local = nonEmptyString(appDataDir)
    const base = local ?? api.join(home, 'AppData', 'Local')
    return Object.freeze({ root: normalizePath(api.join(base, 'Legion'), platform), source: local === null ? 'homeDir' : 'appDataDir' })
  }
  return Object.freeze({ root: normalizePath(api.join(home, '.legion'), platform), source: 'homeDir' })
}

/**
 * 解析产品目录布局。
 *
 * 入参全部显式：`env` 是调用方读到的环境变量对象（不传就用空对象，于是可以得到纯默认布局）。
 * 返回 `{ layout, diagnostics }`；`layout` 已冻结，`diagnostics` 见 `layoutDiagnostics`。
 */
export function resolveLayout({
  platform = process.platform,
  env = {},
  installDir,
  dataDir,
  cacheDir,
  logDir,
  workspaceDir,
  productConfigPath,
  secretsFile,
  homeDir,
  appDataDir,
} = {}) {
  const api = pathApi(platform)
  const home = defaultProductHome({ platform, env, homeDir, appDataDir })

  // 取值优先级严格按 spec §6.11：内置默认值 < 产品配置 < 工作空间配置 < 用户设置 < 受控环境变量。
  // 显式入参代表「调用方已按前三层合并好的值」，因此**环境变量仍然压过它**——
  // 反过来做（入参压过 env）会让 §6.11 在实现里被悄悄倒置，而表现是
  // 「部署时设的环境变量不生效」，且只在那台机器上不生效。
  const pick = (explicit, envKey) => nonEmptyString(env[envKey]) ?? nonEmptyString(explicit) ?? null
  const under = (base, sub) => (base === null ? null : normalizePath(api.join(base, sub), platform))

  const install = pick(installDir, LEGION_ENV.INSTALL_DIR)
  const data = pick(dataDir, LEGION_ENV.DATA_DIR) ?? under(home.root, 'data')
  const cache = pick(cacheDir, LEGION_ENV.CACHE_DIR) ?? under(home.root, 'cache')
  const log = pick(logDir, LEGION_ENV.LOG_DIR) ?? under(home.root, 'log')
  // Workspace 是**用户授权的项目目录**，刻意不给默认值：
  // 默认出一个目录再往里写，等于替用户决定「哪些目录可以被数字员工读写」。
  const workspace = pick(workspaceDir, LEGION_ENV.WORKSPACE_DIR)
  const productConfig =
    pick(productConfigPath, LEGION_ENV.PRODUCT_CONFIG) ?? under(data, 'product.config.json')
  // 受保护密钥库：**产品家目录下的兄弟目录，不在 DataDir 内**。
  // 理由见 `layoutDiagnostics` 的 SECRETS_INSIDE_DATA_DIR 注释。
  const secrets =
    pick(secretsFile, LEGION_ENV.SECRETS_FILE) ?? under(home.root, `${SECRETS_DIRNAME}/${SECRETS_FILENAME}`)

  const layout = Object.freeze({
    platform,
    productHome: home.root,
    productHomeSource: home.source,
    installDir: install === null ? null : normalizePath(install, platform),
    dataDir: data,
    cacheDir: cache,
    logDir: log,
    workspaceDir: workspace,
    productConfigPath: productConfig,
    secretsFile: secrets,
  })

  return { layout, diagnostics: layoutDiagnostics(layout) }
}

/**
 * 布局不变量判定（spec §6.11 / §9.4）。
 *
 * 每条诊断都带 `code`（机器可判）与 `message`（用户可读），`role` 指出是哪个角色出的问题。
 */
export function layoutDiagnostics(layout) {
  const platform = layout?.platform ?? process.platform
  const out = []
  const add = (severity, code, role, message) => out.push(Object.freeze({ severity, code, role, message }))

  const install = layout?.installDir ?? null
  if (install === null) {
    add('error', 'INSTALL_DIR_UNRESOLVED', 'install',
      `无法确定安装目录：请设置 ${LEGION_ENV.INSTALL_DIR} 或由 Launcher 传入。安装目录未确定时无法校验任何写入边界。`)
  }

  for (const role of DIR_ROLES) {
    const value = role === 'install' ? install
      : role === 'data' ? layout?.dataDir
        : role === 'workspace' ? layout?.workspaceDir
          : role === 'cache' ? layout?.cacheDir : layout?.logDir
    if (value === null || value === undefined) continue
    const api = pathApi(platform)
    if (!api.isAbsolute(value)) {
      add('error', 'PATH_NOT_ABSOLUTE', role, `${role} 必须是绝对路径，当前为「${value}」。相对路径的基准随启动方式变化，会让数据落到预料之外的位置。`)
    }
  }

  if (layout?.workspaceDir === null || layout?.workspaceDir === undefined) {
    add('error', 'WORKSPACE_NOT_CONFIGURED', 'workspace',
      `尚未指定工作区目录：请设置 ${LEGION_ENV.WORKSPACE_DIR} 或由首次运行向导选择。工作区是用户授权的项目目录，不提供默认值。`)
  }

  // ① 安装目录内不得有任何可写角色（PRT-003 实测的 4 处越界写入就是这条的反面）。
  if (install !== null) {
    const writable = { data: layout.dataDir, workspace: layout.workspaceDir, cache: layout.cacheDir, log: layout.logDir }
    for (const [role, value] of Object.entries(writable)) {
      if (value === null || value === undefined) continue
      if (isPathInside(install, value, platform) || samePath(install, value, platform)) {
        add('error', 'WRITABLE_DIR_INSIDE_INSTALL_DIR', role,
          `${role}（${value}）位于安装目录（${install}）内。安装目录会被升级原子替换，业务状态写进去会在升级时丢失或被覆盖。`)
      }
    }
    if (layout.productConfigPath !== null && layout.productConfigPath !== undefined &&
        (isPathInside(install, layout.productConfigPath, platform) || samePath(install, layout.productConfigPath, platform))) {
      add('error', 'CONFIG_FILE_INSIDE_INSTALL_DIR', 'data',
        `产品配置文件（${layout.productConfigPath}）位于安装目录内：用户配置会在升级时被替换掉。`)
    }
    if (layout.productHome !== null && (isPathInside(install, layout.productHome, platform) || samePath(install, layout.productHome, platform))) {
      add('error', 'PRODUCT_HOME_INSIDE_INSTALL_DIR', 'data',
        `产品家目录（${layout.productHome}）位于安装目录内：数据库、日志与缓存都会随之落在会被替换的目录里。`)
    }
    if (layout.secretsFile !== null && layout.secretsFile !== undefined &&
        (isPathInside(install, layout.secretsFile, platform) || samePath(install, layout.secretsFile, platform))) {
      add('error', 'SECRETS_INSIDE_INSTALL_DIR', 'data',
        `受保护密钥库（${layout.secretsFile}）位于安装目录内：升级会替换这个目录，` +
        '而密钥库是**机器与账户绑定**的（DPAPI），换一台机器或换一个账户都解不开，' +
        '所以它既不该被升级覆盖、也不该被随程序一起分发。')
    }
  }

  // ①-b 密钥库**不得位于 DataDir 内**。
  //
  // 这条是结构性的，不是洁癖：DataDir 是「备份、恢复、诊断包导出、整目录拷贝」
  // 处理的那一个目录。密钥库一旦落在里面，任何将来「把 DataDir 打个包」的功能
  // 都会**顺手**把它带出去，而 spec §3.1 明确要求密钥不得进入导出证据与能力包。
  //
  // 把它放在 DataDir 之外，这类泄漏就从「需要每个人每次都记得」变成
  // 「结构上做不到」——**一道看不见某类变化的大门，比没有大门更坏**，
  // 反过来也成立：一道不需要人记住的大门才真的守得住。
  if (layout?.secretsFile !== null && layout?.secretsFile !== undefined &&
      layout?.dataDir !== null && layout?.dataDir !== undefined) {
    if (isPathInside(layout.dataDir, layout.secretsFile, platform) || samePath(layout.dataDir, layout.secretsFile, platform)) {
      add('error', 'SECRETS_INSIDE_DATA_DIR', 'data',
        `受保护密钥库（${layout.secretsFile}）位于数据目录（${layout.dataDir}）内：` +
        '数据目录是备份、恢复与诊断包导出的对象，密钥库落在里面会被任何「打包 DataDir」的操作顺手带走，' +
        '而 spec §3.1 要求密钥不得进入导出证据与能力包。请把密钥库放到数据目录之外（默认 <产品家目录>/secrets/）。')
    }
  }

  // ①-c 密钥库不得与缓存目录重叠：缓存是「可安全删除」的，
  //     而删掉密钥库会让所有档案变成 SECRET_UNAVAILABLE 且无法恢复。
  if (layout?.secretsFile !== null && layout?.secretsFile !== undefined &&
      layout?.cacheDir !== null && layout?.cacheDir !== undefined) {
    if (isPathInside(layout.cacheDir, layout.secretsFile, platform) || samePath(layout.cacheDir, layout.secretsFile, platform)) {
      add('error', 'SECRETS_INSIDE_CACHE_DIR', 'data',
        `受保护密钥库（${layout.secretsFile}）位于缓存目录（${layout.cacheDir}）内：` +
        '缓存被定义为「可安全删除」，而删掉密钥库之后已录入的密钥**无法找回**。')
    }
  }

  // ② 可写角色两两不得嵌套：数据、工作区、缓存、日志混在一起会让
  //    「保留/清理/备份/升级」四件事无法各自独立地做对。
  const writableOnly = [['data', layout?.dataDir], ['workspace', layout?.workspaceDir], ['cache', layout?.cacheDir], ['log', layout?.logDir]]
  for (let i = 0; i < writableOnly.length; i += 1) {
    for (let j = i + 1; j < writableOnly.length; j += 1) {
      const [roleA, a] = writableOnly[i]
      const [roleB, b] = writableOnly[j]
      if (a === null || a === undefined || b === null || b === undefined) continue
      if (pathsOverlap(a, b, platform)) {
        add('error', 'ROLE_DIRS_OVERLAP', `${roleA}+${roleB}`,
          `${roleA}（${a}）与 ${roleB}（${b}）相互重叠。四类可写目录必须彼此独立，否则备份、清理与升级会互相破坏。`)
      }
    }
  }

  return Object.freeze(out)
}

/** 是否有 `error` 级诊断（`warn` 不阻塞自动执行）。 */
export function hasBlockingDiagnostic(diagnostics) {
  return diagnostics.some((d) => d.severity === 'error')
}

/** 断言布局可进入自动执行；失败时抛错并带上全部诊断文本。 */
export function assertLayoutUsable(layout, { diagnostics = null } = {}) {
  const list = diagnostics ?? layoutDiagnostics(layout)
  if (hasBlockingDiagnostic(list)) {
    const text = list.filter((d) => d.severity === 'error').map((d) => `${d.code}: ${d.message}`).join('\n  ')
    throw new Error(`产品目录布局不满足不变量：\n  ${text}`)
  }
  return layout
}

// ---------------------------------------------------------------- 配置优先级

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const v of Object.values(value)) deepFreeze(v)
  return Object.freeze(value)
}

/**
 * 按 spec §6.11 的固定优先级合并配置层。
 *
 * 合并语义（刻意写死，避免「各层各理解一套」）：
 *   - 普通对象**递归合并**；
 *   - 数组与标量**整体替换**。按下标合并数组会静默产出「没人写过」的配置，
 *     而这类配置无法归因到任何一层，排障时最费时间；
 *   - `undefined` 视为「该层未表态」，跳过；`null` 视为显式清空，参与覆盖。
 *
 * 返回 `{ value, provenance, sources }`：`provenance` 是「点号路径 → 生效层」的映射，
 * 供诊断页回答「这个值到底是谁给的」——没有它，「配置没生效」只能靠猜。
 */
export function mergeConfigLayers(layers) {
  if (!Array.isArray(layers)) throw new TypeError('mergeConfigLayers 需要层数组：[{source, values}]')
  const seen = new Set()
  for (const layer of layers) {
    if (!isPlainObject(layer)) throw new TypeError('每一层必须是 {source, values} 对象')
    if (!CONFIG_LAYERS.includes(layer.source)) {
      throw new TypeError(`未知配置层「${layer.source}」：只允许 ${CONFIG_LAYERS.join(' < ')}。未登记的层会让优先级失去确定性。`)
    }
    if (seen.has(layer.source)) throw new TypeError(`配置层「${layer.source}」重复出现：同一层给两份值无法确定谁生效`)
    seen.add(layer.source)
  }

  const ordered = [...layers].sort((a, b) => CONFIG_LAYERS.indexOf(a.source) - CONFIG_LAYERS.indexOf(b.source))
  const value = {}
  const provenance = {}

  const mergeInto = (target, source, layerName, prefix) => {
    for (const [key, raw] of Object.entries(source)) {
      if (raw === undefined) continue
      const path = prefix === '' ? key : `${prefix}.${key}`
      if (isPlainObject(raw)) {
        const existing = target[key]
        if (isPlainObject(existing)) {
          provenance[path] = layerName // 对象节点的归属 = 最后写入该子树的层
          mergeInto(existing, raw, layerName, path)
        } else {
          target[key] = {}
          provenance[path] = layerName
          mergeInto(target[key], raw, layerName, path)
        }
      } else {
        target[key] = Array.isArray(raw) ? [...raw] : raw
        provenance[path] = layerName
      }
    }
  }

  for (const layer of ordered) {
    if (!isPlainObject(layer.values)) throw new TypeError(`配置层「${layer.source}」的 values 必须是对象`)
    mergeInto(value, layer.values, layer.source, '')
  }

  return Object.freeze({
    value: deepFreeze(value),
    provenance: Object.freeze({ ...provenance }),
    sources: Object.freeze(ordered.map((l) => l.source)),
  })
}

/** 查询某个点号路径由哪一层给的值（未设置返回 null）。 */
export function provenanceOf(merged, dottedPath) {
  if (merged === null || typeof merged !== 'object') return null
  return merged.provenance?.[dottedPath] ?? null
}

/**
 * 普通配置文件（产品配置 / 工作空间配置 / 用户设置）的写入门禁。
 *
 * spec §6.11 要求「不得把密钥写入上述普通配置文件」，§6.7 要求密钥只经 `secretRef`。
 * 复用 `runtime/contracts/model.mjs` 的 `findPlaintextSecrets` 而不是再写一份判据：
 * 两份判据漂移的表现是「一处说没有密钥、另一处说有」，两边都不可信。
 */
export function findPlaintextSecretsInConfig(values) {
  return findPlaintextSecrets(values)
}

/** 写入前断言配置不含明文密钥；命中时抛错并点名路径。 */
export function assertConfigWritable(values) {
  const hits = findPlaintextSecretsInConfig(values)
  if (hits.length > 0) {
    throw new Error(
      `拒绝写入普通配置文件：检测到疑似明文密钥 ${hits.join(', ')}。密钥只能以 secretRef 引用保存（spec §6.7 / §6.11）。`,
    )
  }
  return values
}
