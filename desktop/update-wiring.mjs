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

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { loadUpdateConfig } from '../product/update/config.mjs'
import { createUpdateClient } from '../product/update/client.mjs'
import { runInstallTransaction } from '../product/update/install.mjs'
import { writeTransactionFile, clearTransactionFile } from '../product/update/helper.mjs'
import { healthSpecFromProcesses } from '../product/update/health.mjs'
import { DEFAULT_PORTS, PROCESS_SPECS } from '../product/process-manifest.mjs'
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
   * ★ 必须由调用方给出 Launcher 真正用的那一组，而不是让这里猜默认值：
   *   健康检查里有一条 `expectJson: { port }` 的身份断言，它的用途正是
   *   区分「我们自己的实例」与「上一次升级前留下的旧实例 / 别的程序占了
   *   同一个端口」。用默认值去问一个跑在别的端口上的实例，得到的是
   *   **更差**的结果——一次看似通过的健康检查（旧实例应答了 200，
   *   而它的 port 字段恰好也等于默认值）。
   */
  ports = DEFAULT_PORTS,
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
        // `tasks: null` 会被预检拦成"未知"——那是刻意的：真实部署里调用方
        // 必须给出任务读数（`update.install` 的 `pendingTasks`）。
        tasks: Array.isArray(pendingTasks) ? pendingTasks.map((item) => (typeof item === 'string' ? { id: item, state: 'running' } : item)) : null,
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
          const health = healthSpecFromProcesses({ processes: PROCESS_SPECS, ports })
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
  return Object.freeze({ ok: problems.length === 0, problems: Object.freeze(problems) })
}

export const WIRING_CHECKED = selfCheckWiring()