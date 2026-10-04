// desktop/update-wiring.mjs
// ============================================================================
// 把更新服务接进桌面主进程 —— 设计 §3 的"Electron 主进程 ⇄ 更新服务"
//
// 这一层只做四件事，但每一件都有一个"不这么做会怎样"：
//
//   ① **懒装载**：`loadUpdateConfig()` 读的是打包时写入的文件。它缺失、
//      损坏、或没有公钥时，桌面端必须**照常可用**——一个"更新配置坏了
//      于是应用起不来"的桌面端，把一次部署疏漏变成了一次宕机。
//      所以 `resolveUpdateRuntime()` 返回 `{ok:false, reason}`，而调用方
//      把这个 reason 一路显示到面板上。
//
//   ② **启动清理**：删掉所有 `.part`（设计 §6：中断后重新下载完整包）。
//      放在这里而不是下载时，是因为"上次退出时留下半个包"这件事只有
//      启动这一个时刻能确定地发现。
//
//   ③ **可交互之后才计时**（设计 §6 line 132）：`markInteractive()` 由
//      主进程在窗口 `ready-to-show`（或工作台加载完成）时调用。
//
//   ④ **安装事务的接线点**：Stage C 的 `installer` 从这里注入。它**允许**
//      为 null——那时 `update.install` 会明确回答"安装功能尚未接线"，
//      而不是假装成功（"假装成功"的代价是用户以为升级了）。
// ============================================================================

import { existsSync, readFileSync, readdirSync, statSync, statfsSync } from 'node:fs'
import { dirname as dirnameFn, join } from 'node:path'

import { loadUpdateConfig } from '../product/update/config.mjs'
import { createUpdateClient } from '../product/update/client.mjs'
import { runInstallTransaction } from '../product/update/install.mjs'
import { writeTransactionFile, clearTransactionFile } from '../product/update/helper.mjs'
import { healthSpecFromProcesses } from '../product/update/health.mjs'
import { normalizeTaskReadings } from '../product/upgrade/task-state.mjs'
import { PROCESS_SPECS } from '../product/process-manifest.mjs'
import { createUpdateService, registerUpdateIpc } from './update-service.mjs'

/** 桌面端要读的"当前产品版本"来源（与 launcher 的 shared-backend 同一份文件）。 */
export const RUNTIME_MANIFEST_PATH = Object.freeze(['product', 'release', 'runtime-manifest.json'])

export function runtimeManifestPath(installRoot) {
  return join(installRoot, ...RUNTIME_MANIFEST_PATH)
}

/**
 * 读出当前产品版本。
 *
 * 读不出来时返回 `null`：更新客户端**需要**当前版本才能判断"有没有新版"，
 * 所以调用方必须把 null 当成"检查更新不可用"，而不是拿 `'0.0.0'` 冒充——
 * 一个假版本号会让"1.0.0 可用"这条判断对所有人都成立。
 */
export function readCurrentVersion(installRoot, { readFileImpl, parse = JSON.parse } = {}) {
  try {
    const raw = readFileImpl(runtimeManifestPath(installRoot))
    const parsed = parse(raw)
    const version = parsed?.productVersion
    return typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version) ? version : null
  } catch {
    return null
  }
}

/**
 * 解析更新运行时。
 *
 * @returns {Promise<{ok: true, client: object, service: object, unregister: Function} | {ok: false, reason: string}>}
 */
export async function resolveUpdateRuntime({
  installRoot,
  cacheDir,
  channel = null,
  currentVersion = null,
  /** `undefined` = 用桌面默认实现（`buildDesktopInstaller`）；`null` = 明确不接线。 */
  installer = undefined,
  /** Launcher 的 bridge 客户端（`runtime.mjs` 的 `createBridgeClient`）。 */
  bridge = null,
  dataDir = null,
  nodePath = process.execPath,
  helperEntry = null,
  drainTimeoutMs = null,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  random = Math.random,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
  desktopDir = null,
  registerIpc = true,
  ipc = null,
  createPanel = undefined,
  onNotify = () => {},
  log = () => {},
} = {}) {
  if (typeof installRoot !== 'string' || installRoot === '') {
    return Object.freeze({ ok: false, reason: '缺少 installRoot，无法解析更新配置' })
  }
  const version = currentVersion ?? readCurrentVersion(installRoot, { readFileImpl: readFileSync })
  if (version === null) {
    return Object.freeze({
      ok: false,
      reason: '读不出当前产品版本（product/release/runtime-manifest.json），检查更新不可用',
    })
  }
  const config = loadUpdateConfig({ installRoot, channel })
  // ★ 配置不可用时**仍然**把客户端建起来：面板要能显示"为什么不可用"。
  //   直接返回 `{ok:false}` 会让面板只能显示一句泛泛的失败。
  //
  // 安装事务：把 Stage C 的接线装进去。默认实现见 `buildDesktopInstaller`
  // （不内联在这里，是为了它能被单独读到、单独测到）。
  const resolvedInstaller = installer === undefined
    ? buildDesktopInstaller({
      bridge, installRoot, cacheDir, nodePath, now, log,
      dataDir: dataDir ?? join(cacheDir, '..'),
      helperEntry: helperEntry ?? defaultHelperEntry(installRoot),
      drainTimeoutMs,
    })
    : installer

  const client = createUpdateClient({
    installer: resolvedInstaller,
    config: config.usable === true ? config : {
      ok: false, usable: false, code: config.code, reason: config.reason,
      channel: config.channel ?? channel, host: config.host ?? null,
      trustStore: config.trustStore ?? null, trustEntries: [], trustSequence: 0,
    },
    cacheDir,
    currentVersion: version,
    fetchImpl,
    now, random, setTimer, clearTimer, log,
  })

  // ② 启动清理。失败不影响启动。
  try {
    const swept = client.sweepCache()
    if (swept.removed.length > 0) log(`[update] 清理了 ${swept.removed.length} 个未完成的下载`)
  } catch (error) {
    log(`[update] 启动清理失败：${error?.message ?? error}`)
  }

  const service = createUpdateService({
    client,
    ...(desktopDir === null ? {} : { desktopDir }),
    ...(createPanel === undefined ? {} : { createPanel }),
    onNotify,
    log,
    // ★ 在途任务的**展示**读数（设计 §7 line 150）。主进程提供：
    //   它有 bridge 与 team-hub 的端口，渲染进程两样都没有。
    //   读不到 → `null` → 界面显示"未知"，而不是"没有"。
    readTasks: () => readPendingTasks({ bridge }),
  })

  let unregister = () => {}
  if (registerIpc) {
    try {
      // `ipc` 为 null 时由 `registerUpdateIpc` 自己去拿 Electron 的 `ipcMain`。
      unregister = await (ipc === null ? registerUpdateIpc(service) : registerUpdateIpc(service, { ipc }))
    } catch (error) {
      log(`[update] 注册 IPC 失败：${error?.message ?? error}`)
    }
  }

  return Object.freeze({
    ok: true,
    client,
    service,
    config,
    unregister,
    /** ③ 主进程在窗口第一次可交互时调用。 */
    markInteractive: () => client.markInteractive(),
    close: () => { unregister(); service.close() },
  })
}

/**
 * 构造 Stage C 的安装事务接线。
 *
 * 设计 §8 的九步里，第 1–6 步在 Launcher/主进程侧，第 7–9 步交给独立 helper。
 * 这个函数把两者接起来，并把"当前进程做得到的事"与"必须交给 helper 的事"
 * 分开：
 *
 *   · 停止认领 / 等待在途任务 / 停止服务 —— 通过 bridge 请求 Launcher；
 *   · 启动 helper —— 用随包 Node 起一个**独立进程**（设计 §3 line 57）。
 *
 * 刻意不做的事：**不在这个进程里替换程序目录**。Electron 主进程是要被
 * 停掉的那一批进程之一，让它在停掉自己之后继续负责恢复是不可能的
 * （设计 §3：「不得由已退出的 Electron 进程承担恢复责任」）。
 *
 * @param {object} args
 * @param {object} args.bridge       `runtime.mjs` 的 bridge 客户端（可为 null）
 * @param {string} args.dataDir
 * @param {string} args.installDir
 * @param {string} args.nodePath    随包 Node（打包时在 resources/node/node.exe）
 * @param {string} args.helperEntry helper 的入口脚本
 */
export function createInstallTransactionRunner({
  bridge = null,
  dataDir,
  installDir,
  nodePath = process.execPath,
  helperEntry = null,
  spawnImpl = null,
  now = () => Date.now(),
  drainTimeoutMs = null,
} = {}) {
  if (typeof dataDir !== 'string' || dataDir === '') throw new Error('createInstallTransactionRunner 需要 dataDir')
  if (typeof installDir !== 'string' || installDir === '') throw new Error('createInstallTransactionRunner 需要 installDir')

  const forward = async (type, payload = {}) => {
    if (bridge === null || typeof bridge.request !== 'function') {
      throw Object.assign(new Error(`没有可用的后台通道来执行 ${type}`), { code: 'UPDATE_LAUNCHER_UNAVAILABLE' })
    }
    return bridge.request(type, payload)
  }

  return Object.freeze({
    /**
     * 第 2 步：准备目标 DSH 精确版本与补丁（**不改变当前运行时活动指针**）。
     *
     * 设计 §8：「网络失败在此停止。」所以这一步的失败就是 `not-started`，
     * 而它由 Launcher 的 `prepare-runtime` 承担（那里才知道 DSH 的精确版本
     * 与补丁该从哪儿来）。
     */
    async prepare({ identity }) {
      try {
        const result = await forward('prepare-runtime', { releaseId: identity?.releaseId ?? null })
        return { ok: result?.state === 'prepared', detail: result?.state ?? null }
      } catch (error) {
        return { ok: false, reason: error?.message ?? String(error) }
      }
    },

    /**
     * 启动独立 helper（第 7 步的前半）。
     *
     * 事务文件由 `runInstallTransaction` 之外的代码先写好——这里只负责
     * **起进程**，并立刻把控制权交出去。启动之后 Electron 就地退出。
     */
    async spawnHelper(args) {
      if (helperEntry === null) {
        return { ok: false, reason: '没有配置 helper 入口（打包时应写入 resources/update/helper-entry.mjs）' }
      }
      const spawn = spawnImpl ?? (await import('node:child_process')).spawn
      const child = spawn(nodePath, [helperEntry], {
        cwd: installDir,
        windowsHide: true,
        // ★ `detached: true` + `stdio: 'ignore'`：它必须在父进程退出之后
        //   继续跑。用管道的话，父进程一退出，子进程的 stdout 就没有读者，
        //   某些平台上写日志会直接失败并杀掉它——而那正好是切换程序的那一步。
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          LEGION_UPDATE_TXN: args.txnId,
          LEGION_UPDATE_DATA_DIR: dataDir,
          LEGION_UPDATE_INSTALL_DIR: installDir,
          ...(args.cacheDir === null ? {} : { LEGION_UPDATE_CACHE_DIR: args.cacheDir }),
        },
      })
      if (child === null || child === undefined || typeof child.pid !== 'number') {
        return { ok: false, reason: 'helper 进程没有启动' }
      }
      child.unref?.()
      return { ok: true, pid: child.pid }
    },

    /**
     * 第 6 步的退出核对。
     *
     * 「helper 校验退出身份与进程树，句柄未释放则安全中止。」真实核对要问
     * Launcher（它才知道受管进程树的样子），所以这里转成一次 bridge 请求。
     */
    async verifyExit() {
      try {
        const result = await forward('status')
        const processes = Array.isArray(result?.processes) ? result.processes : []
        const alive = processes.filter((p) => p?.state !== 'stopped' && p?.state !== 'ready')
        // `ready` 也算"还在运行"：调用方必须在请求这一步之前先 stop。
        const stillRunning = processes.filter((p) => p?.state !== 'stopped')
        if (stillRunning.length > 0) {
          return { ok: false, detail: `仍有 ${stillRunning.length} 个受管进程在运行（${stillRunning.map((p) => p.key).join(', ')}）` }
        }
        void alive
        return { ok: true }
      } catch (error) {
        return { ok: false, detail: `无法确认受管进程状态：${error?.message ?? error}` }
      }
    },

    forward,
    drainTimeoutMs,
    now,
  })
}

/**
 * 本次启动的**实际**端口（key → port）。
 *
 * @param {object} args
 * @param {object|null} args.bridge        Launcher 的控制通道
 * @param {Record<string, number>} [args.fallback] 拿不到读数时的兜底
 *
 * ★ 必须优先向 Launcher 要读数。
 *
 *   健康检查里有 `expectJson: { port }` 这条**身份断言**，它的用途正是
 *   区分「我们自己的实例」与「上一次升级前留下的旧实例 / 别的程序占了
 *   同一个端口」。用 `DEFAULT_PORTS` 去问一个跑在别的端口上的实例，
 *   最坏的结果不是"拒绝"而是**看似通过**：旧实例应答 200，而它的 port
 *   字段恰好也等于默认值。
 *
 *   所以：拿不到真实读数时**返回 null**，让调用方走 fail-closed
 *   （不写健康规格 → helper 不提交），而不是拿默认值去凑一次检测。
 */
/**
 * 本次在途任务读数（设计 §7 line 150：安装确认要显示有没有在途任务）。
 *
 * @returns {Promise<ReadonlyArray<object>|null>} `null` = **没读到**（不是"没有任务"）
 *
 * ★ 为什么 `null` 与 `[]` 必须分开。
 *
 *   `runPreflight` 对 `tasks: null` 的处置是 `unknown`（"查不到在途任务不等于
 *   没有在途任务"），对 `[]` 的处置是 `ok`。这两个结论在**升级要不要继续**
 *   上是相反的，而它们最容易在实现里被混成一件事——一个 `catch { return [] }`
 *   就会把"读不到"说成"环境是干净的"。
 *
 *   所以这里在任何失败路径上都返回 `null`，把 fail-closed 交给预检。
 *   返回 `null` 的表现是升级停在"没有拿到任务读数"（安全，可重试），
 *   而返回 `[]` 的表现是升级在**任务正在跑**的时候开始换程序。
 */
export async function readPendingTasks({ bridge = null, timeoutMs = null } = {}) {
  if (bridge === null || typeof bridge.request !== 'function') return null
  let reading
  try {
    reading = await bridge.request('tasks', timeoutMs === null ? {} : { timeoutMs })
  } catch {
    return null
  }
  // ★ 只有 `ok: true` **且**带着数组时才算读到了。
  //   `ok: true` 但没有 `tasks` 字段同样按"没读到"处置——不能把缺失当成空。
  if (reading?.ok !== true || !Array.isArray(reading.tasks)) return null
  return Object.freeze(reading.tasks)
}

/**
 * 读某个路径所在卷的**可用字节数**（预检的磁盘判据需要的读数）。
 *
 * ★ 这是第三个"判据的输入没有生产方"的地方。
 *
 *   预检在 `stage: 'pre-switch'` 跑，而那一档对**没有磁盘读数**的处置是
 *   `unknown` → 拦（`preflight.mjs` 的 `diskNoReadingAtPreSwitch`）。
 *   桌面上此前从不传 `freeBytes`，于是 `freeBytes: null` 的结论是
 *   `preflight-disk-unobserved` —— **每一次真实安装都停在预检上**。
 *   （前两个是 ⑪ 在途任务、⑫ 补丁层成对表。）
 *
 * ★ 读不到时返回 `null`，**不返回一个乐观的估计值**。
 *   `null` → 预检判"没有磁盘读数" → 拦。一个"估一个很大的数让预检过去"
 *   的实现会把一次必然写一半就没空间的升级放行——而**写到一半**正是最坏的
 *   时刻：程序已经换了一半，数据库可能已经迁移。
 *
 * 目录还不存在时向上找到最近的已存在祖先：安装目录刚被删掉/还没建好时，
 * 我们要回答的是"**将要**放这些东西的那个卷还有多少空间"。
 */
export function readFreeBytes(targetPath, {
  statfs = statfsSync, exists = existsSync, dirname = dirnameFn, maxDepth = 32,
} = {}) {
  if (typeof targetPath !== 'string' || targetPath === '') return null
  let current = targetPath
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (exists(current)) {
      try {
        const stats = statfs(current)
        // `bavail` 是"非特权用户可用块数"，`bsize` 是块大小。
        // 用 `bavail` 而不是 `bfree`：后者含保留块，报出来的数字会**大于**
        // 我们真正能写的量，方向是错的。
        const available = Number(stats?.bavail) * Number(stats?.bsize)
        if (!Number.isSafeInteger(available) || available < 0) return null
        return available
      } catch {
        return null
      }
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
  return null
}

/**
 * 目录树的总字节数（预检算磁盘余量用）。
 *
 * ★ 读不到就返回 **0**，不是 `null`：预检的 `backupBytes`/`dataDirBytes`
 *   是"再要多少空间"的**加数**，而没有读数在那里等价于 0（基准是
 *   `freeBytes` 与包大小）。返回 `null` 会让 `requiredBytes` 算出 `NaN`，
 *   而 `NaN` 的比较全部为假 —— 一次"余量检查静默通过"。
 *
 * 不递归跟随符号链接：跟随会让一次统计走到别的卷上，从而算出一个与
 * 本次安装无关的数字。
 */
export function directoryBytes(root, {
  exists = existsSync, readdir = readdirSync, stat = statSync,
  maxEntries = 200_000,
} = {}) {
  if (typeof root !== 'string' || root === '' || !exists(root)) return 0
  let total = 0
  let seen = 0
  const walk = (dir) => {
    if (seen > maxEntries) return
    let entries
    try { entries = readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      seen += 1
      if (seen > maxEntries) return
      const absolute = join(dir, entry.name)
      try {
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) { walk(absolute); continue }
        if (entry.isFile()) total += Number(stat(absolute)?.size) || 0
      } catch { /* 单个条目读不到就跳过：一个统计不该因为一个文件而失败 */ }
    }
  }
  walk(root)
  return Number.isSafeInteger(total) && total >= 0 ? total : 0
}

/**
 * 校验签过名发行清单里的补丁层成对表。
 *
 * ★ 为什么在最严的地方还要再校验一次形状。
 *
 *   签名保证的是"这确实是发布方发的"，**不是**"发的东西形状一定对"。
 *   发布方可能用了另一版的 `publish.mjs`、或者发行清单是手工拼的。
 *   一个形状不对的项（缺 `dshVersion`、补丁版本是字符串）会让
 *   `patchPairOf` 的 `some()` 永远匹配不上——于是结论是 `mismatch`，
 *   而错误文案说的是"目标补丁层与 DSH 版本不成对"，排查方向会落在
 *   补丁层上，而不是"这份清单里有一项是坏的"。
 *
 * 返回 `null`（而不是空数组）当整份表不可用时：`patchPairOf(target, null)`
 * 得到 `unverified`（"没有结论"），与"给了表但里面没有这一对"（"结论是不
 * 成对"）是两件事，而它们的处置不同（前者可重试/需发布方补，后者是硬拒）。
 */
export function normalizePatchBindings(bindings) {
  if (!Array.isArray(bindings)) return null
  const out = []
  for (const binding of bindings) {
    if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) continue
    if (typeof binding.dshVersion !== 'string' || binding.dshVersion === '' || binding.dshVersion.length > 64) continue
    if (!Number.isInteger(binding.compositionPatchVersion) || binding.compositionPatchVersion < 1) continue
    out.push(Object.freeze({
      dshVersion: binding.dshVersion,
      compositionPatchVersion: binding.compositionPatchVersion,
    }))
  }
  // ★ 表里**所有**项都坏掉时返回 `null`，而不是"一张空表"。
  //   空表的含义是"发布方声明它没验证过任何组合"（硬拒），而"表全坏"
  //   的含义是"这份清单不可用"（没有结论）。两者都不放行，但说法不同。
  return out.length === 0 ? (bindings.length === 0 ? Object.freeze([]) : null) : Object.freeze(out)
}

export async function readLauncherPorts({ bridge = null } = {}) {  if (bridge === null || typeof bridge.request !== 'function') return null
  let status
  try {
    status = await bridge.request('status', {})
  } catch {
    return null
  }
  const processes = Array.isArray(status?.processes) ? status.processes : []
  const ports = {}
  for (const process of processes) {
    if (typeof process?.key !== 'string') continue
    if (Number.isSafeInteger(process.port) && process.port > 0 && process.port <= 65535) {
      ports[process.key] = process.port
    }
  }
  return Object.keys(ports).length === 0 ? null : ports
}
/**
 * 打包时 helper 入口的位置。
 *
 * ★ 它**不在** `installRoot` 里。设计 §3 line 57 要求 helper 及其所需 Node
 *   文件「不属于本次待切换的目录」——反过来的话，一次"替换程序目录 → 重启
 *   → 新版本起不来"的过程里，负责恢复的那段代码本身已经被换成了未验证的
 *   新版本代码。所以打包时它落在 `resources/update/`，与 `resources/legion/`
 *   平级。
 */
export function defaultHelperEntry(installRoot) {
  return join(installRoot, '..', 'update', 'helper-entry.mjs')
}

/**
 * 构造桌面端的安装事务实现（设计 §8 第 1–6 步 + 交接）。
 *
 * 它把"当前进程做得到的事"与"必须交给 helper 的事"分开：
 *
 *   · 停止认领 / 等待在途任务 / 停止服务 —— 通过 bridge 请求 Launcher；
 *   · 写事务文件、签发一次性凭证、启动 helper —— 在**主进程**里做，
 *     因为这些输入必须来自主进程，而不是渲染进程（设计 §7 line 162）。
 *
 * 刻意不做的事：**不在这个进程里替换程序目录**。Electron 主进程正是要被
 * 停掉的那一批进程之一，让它在停掉自己之后继续负责恢复是不可能的
 * （设计 §3：「不得由已退出的 Electron 进程承担恢复责任」）。
 */
export function buildDesktopInstaller({
  bridge = null,
  installRoot,
  dataDir,
  cacheDir,
  nodePath = process.execPath,
  helperEntry = null,
  /**
   * 本次启动的**实际**端口（key → port）。
   *
   * ★ 默认 `null`，意味着"向 Launcher 要读数"。
   *
   *   早先这里默认 `DEFAULT_PORTS`，那是一个**在真实部署里会出错**的默认值：
   *   健康检查里那条 `expectJson: { port }` 身份断言的意义正是"确认端口上
   *   是我的实例"，而拿默认值去问一个跑在别的端口上的实例，最坏的结果不是
   *   "拒绝"而是**看似通过**（旧实例应答 200，它的 port 字段恰好也等于
   *   默认值）。
   *
   *   所以：给了就用给的（测试/显式调用方），没给就向 bridge 要；
   *   要不到 → 不写健康规格 → helper fail-closed 不提交。
   */
  ports = null,
  /**
   * 本次升级要执行的迁移计划。
   *
   * ★ 默认**空数组**，而且这是一个**诚实的默认值**：产品里目前没有任何
   *   `defineMigration` 调用（`product/upgrade/migration.mjs` 只有自检用的
   *   `sampleMigrations()`），所以"没有迁移"是事实，不是偷懒。
   *
   *   它仍然是显式参数：`install.mjs` 会拿它算出的摘要与发行清单声明的
   *   `migrationPlanDigest` 比对，不一致就拒绝。于是"产品开始有迁移"的那一天，
   *   如果这里没有跟着接上，**发布出去的包会被挡下**，而不是被静默跳过。
   */
  productMigrations = Object.freeze([]),
  /** breaking 迁移需要调用方显式声明（设计 §8 line 189 的回滚可达性）。 */
  allowBreakingMigrations = false,
  now = () => Date.now(),
  drainTimeoutMs = null,
  log = () => {},
} = {}) {
  if (typeof installRoot !== 'string' || installRoot === '') throw new Error('buildDesktopInstaller 需要 installRoot')
  if (typeof dataDir !== 'string' || dataDir === '') throw new Error('buildDesktopInstaller 需要 dataDir')

  return Object.freeze({
    async install({ identity, release, packagePath, pendingTasks = null, onStage = () => {}, signal = null } = {}) {
      const runner = createInstallTransactionRunner({
        bridge, dataDir, installDir: installRoot, nodePath, helperEntry, now, drainTimeoutMs,
      })
      const current = readRuntimeManifest(installRoot)
      const stage = (name) => { try { onStage(name) } catch (error) { log(`[update] 阶段回调报错：${error?.message ?? error}`) } }

      // ★ 事务 ID 在这里生成，并同时进入：日志、活动描述符、凭证、事务文件。
      //   四处用同一个 ID 是 helper 能判断"这是本次要做的"的前提。
      const txnId = `ut-${now().toString(36)}-${Math.floor(Math.random() * 0xffffffff).toString(16)}`
      stage('waiting-for-tasks')

      // ★ 把"入参不完整"折成一次明确的失败结果，而不是让它抛出去。
      //   `runInstallTransaction` 对不完整输入是**抛**的（那是对的：那是编程
      //   错误），但这条调用链的另一端是 IPC —— 一次抛出去会让渲染进程拿到
      //   一个空的错误对象，而用户看到的是一句没有内容的失败。
      if (release === null || release === undefined) {
        return { ok: false, code: 'update-install-failed', reason: '没有已验证的发行清单，无法开始安装' }
      }
      if (typeof packagePath !== 'string' || packagePath === '') {
        return { ok: false, code: 'update-not-ready', reason: '没有已就绪的更新包' }
      }

      // ★ 在途任务读数在这里**生产**出来（设计 §7 line 150）。
      //
      //   早先 `pendingTasks` 由调用方一路透传，而**没有任何一层**去读它
      //   （`client.mjs` 的快照里恒为 `null`）——于是预检每次都停在
      //   "没有拿到任务读数"，升级一次都进不去。
      //
      //   显式给了 `pendingTasks` 就用给的（测试与显式调用方），
      //   否则向 Launcher 读。读不到 → `null` → 预检判 `unknown` → 拦。
      let effectiveTasks = pendingTasks
      if (!Array.isArray(effectiveTasks)) {
        effectiveTasks = await readPendingTasks({ bridge })
        log(effectiveTasks === null
          ? '[update] 读不到在途任务读数，本次安装会被预检拦下（查不到 ≠ 没有）'
          : `[update] 在途任务读数：${effectiveTasks.length} 条`)
      }

      return runInstallTransaction({
        paths: {
          installDir: installRoot,
          dataDir,
          configPath: join(dataDir, 'config.json'),
          backupDir: join(dataDir, 'backups'),
          cacheDir: cacheDir ?? join(dataDir, 'cache'),
          helperDir: helperEntry === null ? null : join(helperEntry, '..'),
        },
        current,
        release,
        identity,
        packagePath,
        txnId,
        // ★ 补丁层成对表来自**签过名的发行清单**（`release.dshPatchBindings`）。
        //
        //   它是 `checkCompatibility` 回答"目标补丁层与它声明的 DSH 版本是不是
        //   一对验证过的组合"的唯一来源。在此之前桌面上**没有任何一层**传它，
        //   于是 `patchPairOf(target, null)` 恒为 `'unverified'` → 预检判
        //   `unknown` → **每一次真实安装都被拦在兼容性检查上**。
        //
        //   为什么不从本机推断：客户端只能算出"目标与本机是不是同一对"，而
        //   正常的 DSH 升级**本来就会换掉这一对**——所以"与本机不同即拒绝"
        //   会把每一次正常的 DSH 升级都拦下来。
        //
        //   形状在这里再过一遍：它来自一个**签名覆盖**的地方，但仍然要在
        //   使用点校验（签名的意思是"这确实是发布方发的"，不是"发的东西
        //   形状一定对")。形状不对的项会被丢掉——而丢掉之后 `patchPairOf`
        //   得到的是"表里没有这一对"→ `mismatch` → 拦，方向是安全的。
        patchBindings: normalizePatchBindings(release.dshPatchBindings),
        /**
         * ★ 迁移计划：当前产品**还没有任何迁移**，所以是空数组——但它必须
         *   显式给出，而且必须与发行清单声明的摘要一致（`install.mjs` 会核对）。
         *
         *   在加这条判据之前，这里连参数都不传（默认 `[]`），而
         *   `release.migrationPlanDigest` 只校验格式、无人比对。于是
         *   **一份声明了迁移计划的发行，它的迁移会被静默跳过**：
         *   升级"成功"，而数据库结构从未迁移。
         *
         *   现在不一致会被挡在 `install-migration-plan-mismatch` 上。
         *   这也让"接入迁移"这件事有了一个明确的落点：
         *   生产这份列表的那一天，它必须与 `publish.mjs --migration-plan-digest`
         *   用的是同一个算法（`migration.mjs` 的 `migrationPlanDigest`）。
         */
        migrations: productMigrations,
        allowBreakingMigrations,
        // ★ 用 `normalizeTaskReadings` 归一化，而不是就地 `{ id, state: 'running' }`。
        //
        //   原先那一行给一个纯 id 字符串**编造**了状态 `'running'`——而
        //   `'running'` 不是产品里任何一个真实状态（看板用 `in_progress`，
        //   运行尝试用 `Running`）。编造出来的状态在判据里落进"认不出 →
        //   按活跃处理"，结论**恰好**是拦——所以它看起来能用。
        //
        //   归一化之后这个条目是 `{ id, state: null }`，同样落进"认不出 →
        //   活跃"，结论一样，但**理由是真的**：我们确实不知道它的状态。
        //   `normalizeTaskReadings` 还会保留归一化失败的条目（不丢），
        //   因为"丢掉它然后报没有活跃任务"会让升级踩着一条读不懂的记录开始。
        tasks: normalizeTaskReadings(effectiveTasks).tasks,
        // ★ 磁盘读数（第三个"判据的输入没有生产方"的地方）。
        //   不传它 → `preflight-disk-unobserved` → pre-switch 挡下**每一次**安装。
        //   读不到就传 `null`（仍然拦），而不是估一个乐观的数。
        freeBytes: readFreeBytes(installRoot),
        // 备份与数据目录的字节量：预检按"最坏情况"算余量
        // （旧版本 + 新版本 + 备份 + 解压临时文件），所以这两个数是 **0**
        // 时余量估计偏小 —— 方向是危险的（可能放行一次写到一半没空间的升级）。
        // 用实际目录大小，读不到就 0（保持与不传一致，并且 preflight 的
        // 主要判据仍由 `freeBytes` 承担）。
        /**
         * ★ **刻意不传** `package` / `publicKeyPem`。
         *
         *   看起来这两处是缺口（`install.mjs` 的 `if (pkg !== null)` 分支整个
         *   跳过，而 `publicKeyPem === null` 会让 `requireSignature` 算成
         *   `false`，于是"未签名"被判成 `unsigned` 而不是 `rejected`）。
         *   但它们**不是**可以在这里补上的东西，而且补错了比不补更坏：
         *
         *   `install.mjs` 的 `pkg` 参数要的是**包内那份独立签名的清单**
         *   （`legion-package.json`，由 `package.mjs` 的 `verifyPackage` 读），
         *   而**不是**发行清单里的 `release.package`（那个描述符只有
         *   `path`/`sizeBytes`/`sha256`[/闭包字段]，**没有 `signature`**）。
         *
         *   把 `release.package` 当作 `pkg` 传进去的后果是：
         *   `verifyPackage` 会跑起来，然后报 `signature.verdict === 'unsigned'`
         *   →（因为 `requireSignature` 为假）→ 结论 `unsigned`，**不拦**。
         *   也就是说：一个看起来"补上了签名校验"的改动，实际做的是让一个
         *   永远不会通过的校验跑一遍，然后把它不通过的事实忽略掉。
         *   `update-wiring.test.mjs` 有一条断言守着这一点。
         *
         *   而桌面这条路上的**主完整性链是完整的**，只是不在这个参数上：
         *
         *     签名发行清单（`release.package.sha256` 在签名覆盖的字节里）
         *       → 下载时 `transport` 按 `expectedSha256` 校验
         *       → 安装前 `install.mjs` 的 recheck **重新算一遍**包摘要并比对
         *
         *   缺的是纵深那一层（包自己那份清单没有被核对），它需要先把包解开
         *   才能读到 `legion-package.json`——那是解压阶段（第 7 步）的职责，
         *   而解压阶段现在的证据是 `closure.json` 的逐文件摘要（见 ⑩）。
         */

        /**
         * 备份与数据目录的字节量：预检按"最坏情况"算余量
         * （旧版本 + 新版本 + 备份 + 解压临时文件）。这两个数是 **0** 时
         * 余量估计偏小 —— 方向是危险的（可能放行一次写到一半没空间的升级），
         * 所以按实际目录大小算。
         */
        backupBytes: directoryBytes(join(dataDir, 'backups')),
        dataDirBytes: directoryBytes(dataDir),
        stopClaiming: () => runner.forward('stop-claiming'),
        drainInFlight: async () => {
          const status = await runner.forward('status')
          const processes = Array.isArray(status?.processes) ? status.processes : []
          // 受管服务仍在"运行"就说明任务可能还在跑。真正的在途任务读数
          // 由 Launcher 提供，这里只用它做一次保守的复核。
          const active = processes.filter((p) => p?.state === 'running' || p?.state === 'starting')
          return active.length === 0
            ? { ok: true, detail: '受管服务状态已收敛' }
            : { ok: false, reason: `${active.length} 个受管服务仍在运行（${active.map((p) => p.key).join(', ')}）` }
        },
        stopServices: () => runner.forward('stop'),
        spawnHelper: async (spawnArgs) => {
          // ★ 健康检查是**声明式**的（`product/update/health.mjs`）：
          //   事务文件里放的是一组**回环地址**的 HTTP 检查，helper 在
          //   自己的进程里把它变成探针函数。
          //
          //   为什么不放一个函数或一段代码：函数跨不过 JSON 事务文件，而
          //   "允许事务文件带可执行代码"等于把 helper（权限最高的一段代码）
          //   变成一个任意代码执行器。
          //
          //   规格从**同一份** `process-manifest.mjs` 派生：那个文件已经声明了
          //   每个服务的就绪路径、期望状态与身份断言（`expectJson`）。
          //   在别处再写一遍"哪个服务的哪个路径算健康"，两处会漂移——而漂移的
          //   表现是"升级成功之后用户发现某个服务是坏的"。
          //
          //   ★ 端口用**实际读数**：显式给的优先，否则向 Launcher 要。
          //     要不到就不写规格（见下面 health.ok 分支）。
          const resolvedPorts = ports ?? await readLauncherPorts({ bridge })
          const health = resolvedPorts === null
            ? { ok: false, reason: '拿不到 Launcher 的实际端口读数（健康检查的身份断言需要它）' }
            : healthSpecFromProcesses({ processes: PROCESS_SPECS, ports: resolvedPorts })
          if (health.ok !== true) {
            // ★ 派生失败时**不**写入规格。缺规格会让 helper 走
            //   `helper-health-unverified` → 不提交并尝试回退（fail-closed）。
            //   反方向（写一份带字面占位符的规格）会让健康检查"永远不成立"，
            //   于是升级每次都失败在验证那一步，而原因看起来像"服务没起来"。
            log(`[update] 健康检查规格派生失败，本次升级不会提交：${health.reason}`)
          }

          // ★ 事务文件写在这里：路径与内容都来自**主进程**，渲染进程无法影响。
          //   它必须在启动 helper **之前**落盘，且与凭证绑定同一个 txnId
          //   与包摘要（`credential.mjs` 的 MAC 会拒掉任何改动）。
          writeTransactionFile(dataDir, {
            txnId: spawnArgs.txnId,
            fromVersion: spawnArgs.fromVersion,
            toVersion: spawnArgs.toVersion,
            releaseId: spawnArgs.releaseId,
            packagePath: spawnArgs.packagePath,
            packageSha256: spawnArgs.packageSha256,
            backupDir: join(dataDir, 'backups'),
            backupSnapshotRoot: spawnArgs.backupSnapshotRoot,
            migrations: spawnArgs.migrations ?? [],
            // 包内闭包条目：摘要在**签过名的发行清单**里（`package.closureSha256`）。
            // 没有它时 helper 仍然会拒未授权的可执行文件，只是"逐文件闭包"
            // 这一层没有证据（旧的 `--package-zip` 产出属于这种形态）。
            ...(typeof release.package?.closurePath === 'string' && typeof release.package?.closureSha256 === 'string'
              ? { closureEntry: { path: release.package.closurePath, sha256: release.package.closureSha256 } }
              : {}),
            ...(health.ok === true ? { healthProbeSpec: health.spec } : {}),
            healthTimeoutMs: 30_000,
            // ★ 显式写 `false`：规格派生不出来时**不会**提交
            //   （"没验证"与"验证失败"在能不能提交上是同一件事）。
            //   真机验收时应当补上能派生的端口读数，而不是把这个开关改成 `true`。
            allowUnverifiedHealth: false,
          })
          const started = await runner.spawnHelper(spawnArgs)
          if (started.ok === true) stage('installing')
          return started
        },
        verifyExit: () => runner.verifyExit(),
        signal,
        now,
        requireSignature: false,
      }).then((result) => {
        if (result.verdict === 'handed-off') stage('installing')
        else if (result.code === 'install-drain-timeout') stage('tasks-timeout')
        else if (result.verdict === 'maintenance-required') stage('prepare-failed')
        // 失败路径上把事务文件清掉：留着一份"指向一次没开始的升级"的事务
        // 文件会让下一次恢复判定读到一个不存在的事务。
        if (result.verdict !== 'handed-off') clearTransactionFile(dataDir)
        return result
      })
    },
  })
}

/** 读运行时清单（当前产品清单）。读不出来返回 null——预检会因此拦下。 */
export function readRuntimeManifest(installRoot) {
  try {
    return JSON.parse(readFileSync(runtimeManifestPath(installRoot), 'utf8'))
  } catch {
    return null
  }
}

/**
 * 托盘菜单项的标签。
 *
 * 这一小段是纯粹的"状态 → 一句话"，单独拿出来是因为它会被反复刷新
 * （每次状态推送都改一次托盘菜单），而重算菜单的代价比想象中大。
 */
export function trayLabelFor(snapshot) {
  if (snapshot?.usable === false) return '检查更新（不可用）'
  switch (snapshot?.state) {
    case 'available': return `发现新版本 ${snapshot.productVersion ?? ''}`
    case 'downloading': {
      const progress = snapshot.progress
      if (progress === null || progress === undefined || !Number.isSafeInteger(progress.total) || progress.total <= 0) return '正在下载更新…'
      return `正在下载更新 ${Math.round((progress.bytes / progress.total) * 100)}%`
    }
    case 'verifying': return '正在验证更新…'
    case 'ready': return '更新已就绪，可安装'
    case 'recovery-required': return '更新需要人工处理'
    default: return '检查更新'
  }
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------
export function selfCheckWiring() {
  const problems = []
  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    manifestPath: RUNTIME_MANIFEST_PATH.join('/'),
  })
}

/**
 * 自检的**异步**部分：`resolveUpdateRuntime` 是 async（要延迟装载
 * Electron），所以"失败路径"的判据只能在这里跑。
 */
export async function selfCheckWiringAsync() {
  const problems = []
  // 缺 installRoot：明确失败而不是抛。
  const noRoot = await resolveUpdateRuntime({})
  if (noRoot.ok) problems.push('缺 installRoot 时解析成功了')
  // 版本读不出来：必须明确"不可用"，不能用假版本号顶上。
  const missing = await resolveUpdateRuntime({
    installRoot: 'C:\\definitely-missing-legion',
    cacheDir: 'C:\\definitely-missing-legion\\cache',
    registerIpc: false,
  })
  if (missing.ok) problems.push('读不出产品版本时仍然解析成功')
  else if (!/runtime-manifest/.test(missing.reason)) problems.push(`失败原因没有指出缺的是哪个文件：${missing.reason}`)

  // 托盘标签：状态 → 一句话。
  for (const state of ['idle', 'available', 'downloading', 'verifying', 'ready', 'recovery-required']) {
    const label = trayLabelFor({ state, usable: true, productVersion: '1.2.0', progress: { bytes: 5, total: 10 } })
    if (typeof label !== 'string' || label === '') problems.push(`状态 ${state} 没有托盘标签`)
  }
  if (trayLabelFor({ usable: false, state: 'idle' }) !== '检查更新（不可用）') problems.push('不可用时的托盘标签不对')
  if (trayLabelFor({ usable: true, state: 'downloading', progress: { bytes: 5, total: 10 } }) !== '正在下载更新 50%') {
    problems.push(`下载中的托盘标签不对：${trayLabelFor({ usable: true, state: 'downloading', progress: { bytes: 5, total: 10 } })}`)
  }

  // ★ 端口读数：拿不到就返回 null（让调用方 fail-closed），**不**用默认值凑。
  if (await readLauncherPorts({ bridge: null }) !== null) problems.push('没有 bridge 时端口读数不是 null')
  if (await readLauncherPorts({ bridge: { request: async () => { throw new Error('nope') } } }) !== null) {
    problems.push('bridge 报错时端口读数不是 null')
  }
  if (await readLauncherPorts({ bridge: { request: async () => ({ processes: [] }) } }) !== null) {
    problems.push('没有任何端口读数时返回了非 null')
  }
  const withPorts = await readLauncherPorts({
    bridge: {
      request: async () => ({
        processes: [
          { key: 'team-hub', port: 9001, state: 'ready' },
          { key: 'workbench', port: 0, state: 'ready' },      // 非法端口 → 丢掉
          { key: 'whiteboard', port: 9003, state: 'ready' },
          { key: 'broken', port: 'nope', state: 'ready' },     // 非数字 → 丢掉
        ],
      }),
    },
  })
  if (withPorts === null || withPorts['team-hub'] !== 9001 || withPorts.whiteboard !== 9003) {
    problems.push(`端口读数不对：${JSON.stringify(withPorts)}`)
  }
  if (withPorts !== null && ('workbench' in withPorts || 'broken' in withPorts)) {
    problems.push(`非法端口没有被丢掉：${JSON.stringify(withPorts)}`)
  }

  // ★ 在途任务读数：读不到必须是 `null`，**不是**空数组。
  //   预检对 `null` 判 `unknown`（拦），对 `[]` 判 `ok`（放行）——
  //   把"读不到"说成"环境是干净的"是这一层最不能犯的错。
  if (await readPendingTasks({ bridge: null }) !== null) problems.push('没有 bridge 时在途任务读数不是 null')
  if (await readPendingTasks({ bridge: { request: async () => { throw new Error('nope') } } }) !== null) {
    problems.push('bridge 报错时在途任务读数不是 null（读不到被说成了没有任务）')
  }
  if (await readPendingTasks({ bridge: { request: async () => ({ ok: false, code: 'X' }) } }) !== null) {
    problems.push('ok:false 的读数不是 null')
  }
  // `ok: true` 但缺 `tasks` 字段：同样按"没读到"，不能当成空。
  if (await readPendingTasks({ bridge: { request: async () => ({ ok: true }) } }) !== null) {
    problems.push('缺 tasks 字段的读数被当成了空读数')
  }
  // 真正的空数组是**合法**读数（确实没有任务）。
  const emptyTasks = await readPendingTasks({ bridge: { request: async () => ({ ok: true, tasks: [] }) } })
  if (!Array.isArray(emptyTasks) || emptyTasks.length !== 0) problems.push('真正的空读数没有被接受')

  // ★ 补丁层成对表：三种输入必须给出三个**不同**的结论。
  //   `null`（没有结论）与 `[]`（声明了空表）与有内容，在预检那侧对应
  //   `unverified` / `unverified` / `match|mismatch` —— 前两者的差别在于
  //   "这份清单不可用"与"发布方声明没测过"，说法不同、处置相同（都不放行）。
  const goodBindings = normalizePatchBindings([{ dshVersion: '0.8.3', compositionPatchVersion: 2 }])
  if (!Array.isArray(goodBindings) || goodBindings.length !== 1) problems.push('合法的成对表没有通过')
  if (normalizePatchBindings(null) !== null) problems.push('非数组的成对表没有返回 null')
  if (normalizePatchBindings('nope') !== null) problems.push('字符串成对表没有返回 null')
  const declaredEmpty = normalizePatchBindings([])
  if (!Array.isArray(declaredEmpty) || declaredEmpty.length !== 0) {
    problems.push('"发布方声明空表"没有被区分于"表不可用"')
  }
  // ★ 全部坏掉的表 → `null`（"这份清单不可用"），不是空表（"没测过"）。
  if (normalizePatchBindings([{ dshVersion: '' }, 'x', null]) !== null) {
    problems.push('全部坏掉的成对表被当成了"发布方声明空表"')
  }
  // 坏项被丢掉，好项留下。
  const partiallyBad = normalizePatchBindings([
    { dshVersion: '0.8.3', compositionPatchVersion: 2 },
    { dshVersion: '0.8.4', compositionPatchVersion: '3' },   // 字符串 → 丢
    { dshVersion: '0.8.5', compositionPatchVersion: 0 },     // 0 → 丢
    { dshVersion: 'x'.repeat(70), compositionPatchVersion: 1 }, // 太长 → 丢
  ])
  if (!Array.isArray(partiallyBad) || partiallyBad.length !== 1) {
    problems.push(`坏项没有被精确丢掉：${JSON.stringify(partiallyBad)}`)
  }

  // ★ 磁盘读数（第三个"判据的输入没有生产方"的地方）。
  //   本机一定读得到当前目录所在的卷。
  const free = readFreeBytes(process.cwd())
  if (!Number.isSafeInteger(free) || free < 0) problems.push(`读不出本机可用空间：${free}`)
  // 不存在的路径要向上找已存在的祖先（回答"将要放这些东西的卷还有多少"）。
  if (!Number.isSafeInteger(readFreeBytes(join(process.cwd(), 'no-such-dir-xyz', 'deeper')))) {
    problems.push('不存在的路径没有向上找到已存在的祖先')
  }
  // 读不到时必须是 `null`（预检判"没有磁盘读数"→ 拦），不是乐观的估计值。
  if (readFreeBytes('') !== null) problems.push('空路径没有返回 null')
  if (readFreeBytes(null) !== null) problems.push('null 路径没有返回 null')
  const failingStatfs = readFreeBytes(process.cwd(), { statfs: () => { throw new Error('nope') } })
  if (failingStatfs !== null) problems.push('statfs 抛错时没有返回 null（会放行一次没空间的升级）')
  const zeroStatfs = readFreeBytes(process.cwd(), { statfs: () => ({ bavail: 0, bsize: 4096 }) })
  if (zeroStatfs !== 0) problems.push(`零可用空间读成了 ${zeroStatfs}`)
  const oddStatfs = readFreeBytes(process.cwd(), { statfs: () => ({ bavail: 'x', bsize: 4096 }) })
  if (oddStatfs !== null) problems.push('非数值的块数没有返回 null')

  // 目录字节数：读不到返回 0（不是 null —— 它是余量的**加数**，null 会算出 NaN）。
  if (directoryBytes('C:\\definitely-not-here') !== 0) problems.push('不存在的目录没有返回 0')
  if (directoryBytes(null) !== 0) problems.push('null 目录没有返回 0')
  if (directoryBytes(process.cwd()) <= 0) problems.push('当前目录的字节数应当大于 0')

  return Object.freeze({ ok: problems.length === 0, problems: Object.freeze(problems) })
}

export const WIRING_CHECKED = selfCheckWiring()