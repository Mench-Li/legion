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
  installer = null,
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
  const client = createUpdateClient({
    config: config.usable === true ? config : {
      ok: false, usable: false, code: config.code, reason: config.reason,
      channel: config.channel ?? channel, host: config.host ?? null,
      trustStore: config.trustStore ?? null, trustEntries: [], trustSequence: 0,
    },
    cacheDir,
    currentVersion: version,
    installer,
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