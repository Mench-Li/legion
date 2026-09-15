// product/launcher/tray-wiring.mjs
// ============================================================================
// PRT-708 收尾：把托盘**接进 Launcher**
//
// `tray.mjs` 交付的是一份菜单模型与一次动作派发；`launcher.mjs` 交付的是产品的
// 启停与状态读数。本模块只是它们之间那一根线：**只做适配，不新增判据**——
// 可用性怎么算、退出怎么确认，判据都在 `tray.mjs` 里，这里不许复制第二份。
//
// ── ★ 打开 Workbench 的地址：`status().processes[].url` 是**计划**，不是**读数** ──
//
// `launcher.status()` 里 workbench 那一行的 `url` 来自 `process-manifest.mjs`：
// `materializeProcessPlan()` 在**任何进程被 spawn 之前**就把它算好了——
// `port = ports[portKey] ?? spec.defaultPort`，再拼成 `http://host:port`
// （`process-manifest.mjs:282` 与 `:318`）。也就是说它天然携带"配置里那个端口，
// 没配就是清单里的默认端口"。它是**启动计划**的一部分，不是一次观测的结果。
//
// 两种写法都"能跑"，而且在**产品从未换过端口**的那台机器上给出同一个字符串、
// 跑出同一片绿：
//
//   · 写法 A：`workbenchUrl = proc?.url ?? null`
//     —— 只要那一行还在，就把计划地址交出去；
//   · 写法 B（本模块）：只有**就绪判据真的量过并且过了**才交出地址——
//     `state === 'ready'` 且 `readiness.code === 'READINESS_VERIFIED'`。
//
// 差别出现在那一行**没就绪**的时候：进程还没起完、起来又退了、判据超时、
// 端口上其实是别的实例（`readiness.mjs` 的 `identity-mismatch`）……这时 A 会把
// 一个"计划里应该有"的地址交给浏览器，用户看到的是"浏览器打不开这个页面"，
// 而真正的原因在产品这边（workbench 根本没起来）。
//
//   > 一个"从启动计划里取地址"的实现，
//   > 与一个"用观测到的地址"的实现，
//   > 在产品从未换过端口的那台机器上是同一个东西——
//   > 只不过前者的绿是"端口恰好没被占"换来的。
//
// **为什么 `READINESS_VERIFIED` 算观测。** 那条诊断不是"我打算把 workbench 放在
// 这里"，而是"刚刚**真的有一次探测**连上了这个地址、拿到期望的状态码、把响应解析
// 成了 JSON，并且身份断言通过"（`readiness.mjs` 的三层判据）。它只在探测**真的
// 发生过并成功**之后才被写下（`launcher.mjs:1231`）。所以本模块取的是那个地址，
// 但取它的**前提**是一次观测：没有那次观测，`workbenchUrl` 一律是 `null`，
// 「打开 Workbench」因此在菜单里灰掉并给出理由（`tray.mjs` 会说明"地址还没探测到"），
// 而不是让浏览器替我们说那句"打不开"。
//
// 本模块里**没有**任何"回落成配置里的默认端口"的分支，也不可能有一个：
// `status()` 根本不暴露 `ports.*`，唯一可能把默认端口带进来的路径就是上面那条
// 被闸住的 `url` 字段。换句话说，"用没用观测"这件事，在不需要读配置的前提下就成立。
//
// ── ★ 另一半边界：图标是**另一层**，而那一层现在已经有了 ──
//
// `createTray()` 从一开始就只做菜单模型 + 动作派发。画图标、接点击是另一个模块：
// `tray-icon.mjs`——它在 Windows 上生成一个 PowerShell 宿主脚本、起一个真的
// 子进程、把它画出来的 `NotifyIcon` 看住。本模块**只负责把它们接起来**：
//
//   · `nativeIconSupport()` 转发那一层的探测（三态：支持 / 不支持 / 还不知道）；
//   · `attachLauncherTray()` 是 `createLauncherTray()` 的**生产调用点**——
//     接托盘、造宿主、起宿主，三步各自失败各自报，不假装下一步成功了。
//
//   > 一个"看起来接进了托盘、却什么图标也没出"的实现，
//   > 与一个明说"这一层需要宿主进程"的实现，在用户找那个不存在的图标之前
//   > 是同一个东西——只不过前者会让他一直找下去。
//
// ── ★ 退出不许在这里重新实现 ──
//
// `tray.mjs` 的 `quit` 是"停 → **重新观测** → 观测到确实停了才允许退出"。
// 本模块只把 `launcher.stop()` 转发过去，**不**自己写一个"点一下就藏图标"的退出：
// 那正是 PRT-708 存在的理由（见 `tray.mjs` 文件头那段）。
// ============================================================================

import { spawn } from 'node:child_process'

import { createTray } from './tray.mjs'
import { READINESS_VERIFIED_CODE } from './readiness.mjs'
import {
  TRAY_ICON_CODES,
  createTrayIconHost,
  probeTrayIconSupport,
} from './tray-icon.mjs'

/** 要观测的是进程清单里 workbench 那一行的 key。 */
export const TRAY_WIRING_WORKBENCH_KEY = 'workbench'

/**
 * 就绪判据"真的量过了、并且过了"的那一个码。
 *
 * ★ 它**从生产方取**（`readiness.mjs` 的 `READINESS_VERIFIED_CODE`），不在这里
 * 抄一份字面量。抄一份的失败形态很难看：生产方改名时这里不会报错，那道闸
 * `proc?.readiness?.code !== <抄来的字面量>` 只会**永远为真**——
 * 于是「打开 Workbench」恒灰，而没有任何东西亮红。
 *
 *   > 一个"由生产方写死、消费方再抄一遍"的码，
 *   > 与一个"从生产方引用过来"的码，在生产方不改它的那些天里是同一个东西——
 *   > 只不过前者会在改名那天安静地把功能关掉。
 */
export const TRAY_WIRING_READINESS_VERIFIED = READINESS_VERIFIED_CODE

/** 接线层的具名码。 */
export const TRAY_WIRING_CODES = Object.freeze({
  /** 没有 launcher，或它缺少 `status` / `start` / `stop`：这根线接不上。 */
  MISSING_LAUNCHER: 'TRAY_WIRING_MISSING_LAUNCHER',
  /** 平台没有既定的"打开外部浏览器"做法。 */
  OPEN_UNSUPPORTED: 'TRAY_WIRING_OPEN_UNSUPPORTED',
  /** 要打开的地址不是合法的 http(s) URL。**不把它交给系统打开器**。 */
  OPEN_BAD_URL: 'TRAY_WIRING_OPEN_BAD_URL',
  /** 装配本身抛错（一律兜住并报出来，而不是让调用方拿到一个半成品）。 */
  FAILED: 'TRAY_WIRING_FAILED',
})

/**
 * ★ 图标到底支不支持？——**一个读数，不是一个常量**。
 *
 * 这里曾经写着 `export const NATIVE_ICON_SUPPORTED = false`，理由是"零依赖的 Node
 * 画不出图标"。**那半句是错的**：Windows 上不需要原生模块，一个 PowerShell 宿主
 * 就能画出真的 `NotifyIcon`（见 `tray-icon.mjs`）。于是一个恒为 `false` 的常量
 * 从"诚实的边界"变成了"一句关于这台机器的谎话"——而反过来，一个恒为 `true` 的常量
 * 在一台没有桌面会话、或者没有 shell 的机器上同样是谎话。
 *
 *   > 一个"托盘需要原生外壳"的结论，
 *   > 与一个"我没有试过平台上现成的那套 UI 组件"的读数，
 *   > 在 `NATIVE_ICON_SUPPORTED = false` 那一行上是同一个东西。
 *
 * 所以判据整个搬到 `tray-icon.mjs` 的 `probeTrayIconSupport()` 里，这里只**转发**：
 * 支持与否是 `(平台, shell 解析, 宿主有没有真的报过 ready)` 的函数，**三态**
 * （`true` / `false` / `null`＝还没起过宿主，不知道）。转发而不是重写：两份判据
 * 迟早在"某台机器上到底行不行"这件事上给出两个答案。
 *
 * @param {object} o
 * @param {object|null} [o.iconHost] 起过的图标宿主（`createTrayIconHost(...)` 的返回值）
 */
export function nativeIconSupport({
  platform = process.platform,
  env = {},
  configuredShell = null,
  exists = undefined,
  iconHost = null,
} = {}) {
  const probe = probeTrayIconSupport({
    platform,
    env,
    configured: configuredShell,
    ...(exists === undefined ? {} : { exists }),
    host: iconHost,
  })
  return Object.freeze({ ...probe, notice: iconNoticeOf(probe) })
}

/**
 * 说清"这次为什么没有图标"，以及**什么证据会翻转它**。
 *
 * 它取代了旧的那句"本模块不产生原生托盘图标"：那句话现在是假的（这个产品**会**
 * 产生图标），留着它会让用户以为"还没有这一层"。真相是"这一层在，但这台机器
 * 上这一层的三件前提缺了一件"。
 *
 * 每一支仍然要说清**那谁该来补**：一个只说"不支持"的读数，用户只能猜。
 */
export const NO_NATIVE_ICON_REASON = '这次没有托盘图标。三种原因，`nativeIconSupport().code` 说清是哪一种：'
  + '① 平台不是 win32（图标宿主要加载的 WinForms 只存在于 Windows）；'
  + '② 这台机器上解析不到任何一档候选 shell（%ProgramFiles%\\PowerShell\\7\\pwsh.exe、'
  + 'PATH 上的 pwsh.exe、随 Windows 发货的 %SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe）；'
  + '③ 解析到了，但宿主**没有报 ready**（被执行策略/AppLocker 拦下、WinForms 加载失败、'
  + '或者这是一个没有交互桌面的会话）。'
  + '翻转它需要的证据：在 win32 上、某一档候选真的存在、并且那个宿主在 stdout 上报出 ready——'
  + '三件里少一件都不算"支持"。'

/** 把一次探测变成一句能给用户看的话。**每一种读数都有自己的话**，不共用一句。 */
export function iconNoticeOf(probe) {
  if (probe?.supported === true) {
    return `托盘图标宿主已就绪（${probe.shell}）：这次真的有图标，点击会走托盘的动作派发。`
  }
  const head = NO_NATIVE_ICON_REASON
  const why = probe?.reason ?? '（这次探测没有给出原因）'
  const flips = probe?.flips ?? '（这次探测没有说清怎么翻转）'
  if (probe?.supported === null) {
    return `${head} 当前读数：**还不知道**（${probe?.code ?? 'UNKNOWN'}）——${why}。翻转它：${flips}。`
  }
  return `${head} 当前读数：**不支持**（${probe?.code ?? 'UNKNOWN'}）——${why}。翻转它：${flips}。`
}

/** 观测 workbench 地址时缺一不可的那三道闸，都写在这里，而不是散在调用点。 */
function checkWorkbenchRow(proc) {
  if (proc === null || proc === undefined) {
    return { code: 'missing', reason: '状态里没有 workbench 这一行（这次启动可能没包含它）' }
  }
  if (proc.state !== 'ready') {
    return {
      code: 'not-ready',
      reason: `workbench 的状态是 ${proc.state === undefined || proc.state === null ? '未知' : String(proc.state)}`
        + '，不是 ready：现在把地址交出去，只会得到一个打不开的页面',
    }
  }
  if (proc?.readiness?.code !== TRAY_WIRING_READINESS_VERIFIED) {
    // ★ 这一条才是关键：`state: 'ready'` 只是一个标记，而这里要的是
    //   "真的有过一次成功的探测"那条记录。两者在正常启动时总是同时出现，
    //   于是把它们混为一谈的实现在测试里也永远是绿的。
    const got = proc?.readiness?.code
    return {
      code: 'not-verified',
      reason: 'workbench 的状态标着 ready，但**没有**一条"就绪判据真的量过并过了"的记录'
        + `（readiness.code = ${got === undefined || got === null ? 'null' : String(got)}）`,
    }
  }
  const url = proc.url
  if (typeof url !== 'string' || url === '') {
    return { code: 'no-url', reason: '就绪判据过了，但那一行没有可用的地址' }
  }
  let parsed = null
  try {
    parsed = new URL(url)
  } catch {
    parsed = null
  }
  if (parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    return { code: 'bad-url', reason: `观测到的地址不是合法的 http(s) URL：${JSON.stringify(url)}` }
  }
  return { code: null, reason: null }
}

/**
 * 从一次 `launcher.status()` 读数里取**观测到的** workbench 地址。
 *
 * 纯函数，不读配置、不读 plan、不回落到任何默认值。
 *
 * @returns {{url: string|null, reason: string|null}} `url === null` 时 `reason` 非空。
 */
export function observeWorkbenchFromStatus(status) {
  const processes = Array.isArray(status?.processes) ? status.processes : []
  const proc = processes.find((p) => p?.key === TRAY_WIRING_WORKBENCH_KEY) ?? null
  const check = checkWorkbenchRow(proc)
  if (check.code !== null) return Object.freeze({ url: null, reason: check.reason })
  return Object.freeze({ url: proc.url, reason: null })
}

/** 一个带具名码的错误（`tray.mjs` 会把它读成 `TRAY_OPEN_FAILED` 并连话一起报出来）。 */
function namedError(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

/** 要打开的地址必须是 http(s)：别的协议没有"用浏览器打开"这个既定含义。 */
function checkOpenableUrl(url) {
  if (typeof url !== 'string' || url === '') {
    return Object.freeze({ ok: false, code: TRAY_WIRING_CODES.OPEN_BAD_URL, message: '没有可打开的地址' })
  }
  let parsed = null
  try {
    parsed = new URL(url)
  } catch {
    parsed = null
  }
  if (parsed === null) {
    return Object.freeze({ ok: false, code: TRAY_WIRING_CODES.OPEN_BAD_URL, message: `不是合法的 URL：${JSON.stringify(url)}` })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return Object.freeze({
      ok: false, code: TRAY_WIRING_CODES.OPEN_BAD_URL,
      message: `只打开 http(s) 地址（收到 ${parsed.protocol}）——别的协议没有"用浏览器打开"这个既定含义`,
    })
  }
  return Object.freeze({ ok: true, code: null, message: null })
}

/**
 * 各平台的"打开外部浏览器"命令行。
 *
 * `win32` 那一条刻意是 `cmd /c start "" "<url>"`：
 * `start` 是 cmd 的内建命令，而且它会把**没被引号包住的** `&` 当成命令分隔符，
 * 于是 `http://x/?a=1&b=2` 里的后半截会被当成另一条命令去执行。引号是必须的。
 */
function openerSpec(platform, url) {
  if (platform === 'win32') return { file: 'cmd', args: Object.freeze(['/c', 'start', '', `"${url}"`]), windowsHide: true }
  if (platform === 'darwin') return { file: 'open', args: Object.freeze([url]), windowsHide: false }
  if (platform === 'linux') return { file: 'xdg-open', args: Object.freeze([url]), windowsHide: false }
  return null
}

/** 起一个 detach 的子进程去开浏览器；**不继承 stdio**，也**不等它退出**。 */
function spawnOpener({ file, args, windowsHide, spawnImpl }) {
  return new Promise((resolve, reject) => {
    let child = null
    try {
      child = spawnImpl(file, [...args], { detached: true, stdio: 'ignore', windowsHide })
    } catch (e) {
      reject(e)
      return
    }
    if (child === null || child === undefined || typeof child.once !== 'function') {
      // 拿不到子进程句柄时**不能假装"打开了"**：菜单会报成功，而浏览器没有动。
      reject(new Error(`${file} 没有返回可判读的子进程句柄`))
      return
    }
    child.once('error', (e) => reject(e))
    child.once('spawn', () => {
      // detached 的子进程必须 unref：否则它会把托盘进程一起拖住不退出
      // ——"关不掉的托盘"与"没停掉的产品"是同一类缺陷。
      if (typeof child.unref === 'function') child.unref()
      resolve()
    })
  })
}

/**
 * 默认的 `openExternal`：用各平台的既定做法拉起外部浏览器。
 *
 * 单独导出是为了让用例**注入 `spawnImpl`** 就能验证命令行，而永远不必真的
 * 打开一个浏览器（一个会在 CI 上弹窗的用例，等于一个没人愿意跑的用例）。
 */
export function createPlatformOpener({ platform = process.platform, spawnImpl = spawn, logger = null } = {}) {
  return async function openExternal(url) {
    const check = checkOpenableUrl(url)
    if (check.ok !== true) throw namedError(check.code, check.message)
    const spec = openerSpec(platform, url)
    if (spec === null) {
      throw namedError(
        TRAY_WIRING_CODES.OPEN_UNSUPPORTED,
        `平台 ${platform} 上没有既定的"打开外部浏览器"做法：` +
        '这里不猜一个命令（猜错的表现是"点了没反应"，而用户会以为是菜单坏了）',
      )
    }
    if (typeof logger === 'function') logger(`[tray-wiring] 用 ${spec.file} 打开 ${url}`)
    await spawnOpener({ ...spec, spawnImpl })
  }
}

/** 接不上的时候**不抛**，而是给一个具名拒绝 + 一个不会假装能用的替身。 */
function notWired(code, message, { platform = process.platform, env = {}, iconHost = null } = {}) {
  const refusal = Object.freeze({ ok: false, code, message })
  const reject = async () => refusal
  const probe = nativeIconSupport({ platform, env, iconHost })
  return Object.freeze({
    ok: false, code, message,
    tray: null,
    observe: async () => null,
    /** ★ 接不上也一样要给**真实**的图标读数：`false` 在这里是"这根线没接上"，
     *  不是"这台机器画不出来"。两者混在一起会让一台完全能画图标的机器
     *  因为 launcher 缺一个方法而被报成"不支持原生图标"。 */
    nativeIcon: probe.supported,
    nativeIconProbe: probe,
    iconNotice: probe.notice,
    menu: reject,
    invoke: reject,
    dispose: () => refusal,
    status: () => Object.freeze({ wired: false, code, message, nativeIcon: probe.supported }),
    diagnostics: () => Object.freeze([]),
  })
}

/**
 * 把一份 launcher 接到 `createTray()` 上。
 *
 * @param {object} deps
 * @param {object} deps.launcher   需要 `status()` / `start()` / `stop()` 三个方法
 * @param {Function|null} [deps.openExternal] 注入点；默认用 `createPlatformOpener()`
 * @param {string} [deps.platform]
 * @param {Function|null} [deps.logger]
 * @param {Function} [deps.now]
 * @param {Function} [deps.spawnImpl] 默认 `node:child_process` 的 `spawn`（用例注入替身）
 * @param {Function} [deps.trayFactory] 默认 `createTray`（用例可验装配失败路径）
 * @param {object} [deps.env] shell 解析要读的环境（默认 `process.env`）
 * @param {object|null} [deps.iconHost] 已经起好的图标宿主；给了它，`nativeIcon` 才会是 `true`
 *
 * @returns {{ok: boolean, code: string|null, message: string, tray: object|null,
 *            observe: Function, nativeIcon: boolean|null, nativeIconProbe: object,
 *            iconNotice: string, menu: Function, invoke: Function, dispose: Function,
 *            status: Function, diagnostics: Function}}
 */
export function createLauncherTray({
  launcher = null,
  openExternal = null,
  platform = process.platform,
  logger = null,
  now = () => Date.now(),
  spawnImpl = spawn,
  trayFactory = createTray,
  env = process.env,
  iconHost = null,
} = {}) {
  if (launcher === null || typeof launcher !== 'object'
    || typeof launcher.status !== 'function'
    || typeof launcher.start !== 'function'
    || typeof launcher.stop !== 'function') {
    return notWired(
      TRAY_WIRING_CODES.MISSING_LAUNCHER,
      '接线需要一个同时提供 status() / start() / stop() 的 launcher'
        + `（收到 ${launcher === null ? 'null' : typeof launcher}）`,
      { platform, env, iconHost },
    )
  }

  /** 默认打开器**总是**在这里造好：注入只换掉"谁来开"，不换掉"要校验地址"。 */
  const open = typeof openExternal === 'function'
    ? openExternal
    : createPlatformOpener({ platform, spawnImpl, logger })

  /**
   * 一次观测。**形状就是 `tray.mjs` 要的那一个**：
   * `{ runtimeState, workbenchUrl|null, detail }`。
   *
   * `launcher.status()` 抛错时**不吞**：让 `tray.mjs` 把原始理由报成
   * `TRAY_OBSERVE_FAILED`——一句"读不到状态"比一句"观测返回了 null"离真因更近。
   */
  const observe = async () => {
    const status = launcher.status()
    if (status === null || status === undefined || typeof status !== 'object') return null
    const wb = observeWorkbenchFromStatus(status)
    return Object.freeze({
      runtimeState: typeof status.state === 'string' && status.state !== '' ? status.state : null,
      workbenchUrl: wb.url,
      // `detail` 不进菜单的可用性判据（那是 `buildTrayMenu` 的事），
      // 但它让"为什么那一项是灰的"有一个可读的答案。
      detail: wb.url !== null
        ? `Workbench 地址来自一次真的就绪探测：${wb.url}`
        : `Workbench 地址未发布（${wb.reason}）：「打开 Workbench」因此不可点`,
    })
  }

  let tray = null
  try {
    tray = trayFactory({
      observe,
      // ★ 直接转发，**不加判据**：`tray.mjs` 的 start/stop/quit 自己会重新观测。
      //   在这里加一次"先看看状态"的检查，等于把同一件事判断两遍，
      //   而两份判据迟早会漂移成两个答案。
      start: () => launcher.start(),
      stop: () => launcher.stop(),
      openExternal: open,
      platform,
      logger,
      now,
    })
  } catch (e) {
    return notWired(TRAY_WIRING_CODES.FAILED, `装配托盘时抛错：${e?.message ?? String(e)}`,
      { platform, env, iconHost })
  }

  const probe = nativeIconSupport({ platform, env, iconHost })

  return Object.freeze({
    ok: true,
    code: null,
    message: '托盘已接进 Launcher（菜单与动作都来自观测）',
    /** ★ 底层控制器：图标宿主就靠它渲染 `menu()` / 派发 `invoke(id)`。 */
    tray,
    /** 观测本身也暴露出去：图标宿主与用例都能直接看这份读数。 */
    observe,
    /**
     * ★ 三态中的那一个"还不知道"：解析到了 shell、但还没起过宿主时它是 `null`。
     * 用一个 `false` 去覆盖它是这一层最容易犯的谎（见 `nativeIconSupport` 的注释）。
     */
    nativeIcon: probe.supported,
    nativeIconProbe: probe,
    iconNotice: probe.notice,
    menu: () => tray.menu(),
    invoke: (id) => tray.invoke(id),
    dispose: () => tray.dispose(),
    status: () => Object.freeze({ wired: true, nativeIcon: probe.supported, ...tray.status() }),
    diagnostics: () => tray.diagnostics(),
  })
}

/**
 * ★ `createLauncherTray()` 的**生产调用点**：把 launcher、托盘菜单、以及那个真的
 * 会画出图标的宿主装配成一件东西。
 *
 * 在这之前 `createLauncherTray` 一个生产调用者都没有——一个"写好了、测过了、
 * 没有任何东西在启动路径上碰它"的接线，与一个没写的接线在用户那里是同一个东西。
 * 本函数是那根线的落点：它按顺序做三件事，**每一步失败都不假装下一步成功了**：
 *
 *   1. 接托盘（`createLauncherTray`）：菜单与动作都来自观测；
 *   2. 造图标宿主（`createTrayIconHost`）：生成物落 `<DataDir>/tray/`，边界不过就拒绝；
 *   3. `start()` 宿主：**只有宿主报了 ready 才算有图标**。
 *
 * 第 3 步失败时返回 `ok:false`，但**把托盘接线一起交出去**（`wiring` 非空）：
 * 菜单模型与动作派发仍然可用，缺的只是"画到系统托盘上"那一层。
 * 把两者一起丢掉，会让一个"图标起不来"的机器连 `menu()` 都失去。
 *
 * @returns {Promise<{ok: boolean, code: string|null, message: string,
 *            wiring: object|null, icon: object|null, nativeIcon: boolean|null,
 *            nativeIconProbe: object|null, iconNotice: string,
 *            invoke: Function, menu: Function, stop: Function, disconnect: Function,
 *            status: Function, diagnostics: Function}>}
 */
export async function attachLauncherTray({
  launcher = null,
  dataDir = null,
  allowedRoot = null,
  installDir = null,
  dshHome = null,
  operatorHome = null,
  platform = process.platform,
  env = process.env,
  exists = undefined,
  configuredShell = null,
  spawnImpl = spawn,
  openExternal = null,
  logger = null,
  now = () => Date.now(),
  tickMs = undefined,
  heartbeatMs = undefined,
  /** `false` 时只装配不启动（"准备好了但先别画"是合法的，例如向导还没走完）。 */
  autoStart = true,
  /** 用例注入：直接给一个宿主替身，跳过生成与 spawn。 */
  iconHostFactory = createTrayIconHost,
  iconHostDeps = {},
} = {}) {
  const wiring = createLauncherTray({ launcher, openExternal, platform, logger, now, spawnImpl, env })
  if (wiring.ok !== true) {
    return Object.freeze({
      ok: false, code: wiring.code, message: wiring.message,
      wiring: null, icon: null,
      nativeIcon: wiring.nativeIcon, nativeIconProbe: wiring.nativeIconProbe, iconNotice: wiring.iconNotice,
      invoke: wiring.invoke, menu: wiring.menu,
      stop: async () => Object.freeze({ ok: true, code: TRAY_ICON_CODES.NOT_STARTED, message: '没有宿主' }),
      disconnect: async () => Object.freeze({ ok: false, code: wiring.code, message: wiring.message }),
      status: wiring.status, diagnostics: wiring.diagnostics,
    })
  }

  const icon = iconHostFactory({
    tray: wiring.tray,
    dataDir,
    allowedRoot,
    installDir,
    dshHome,
    operatorHome,
    platform,
    env,
    ...(exists === undefined ? {} : { exists }),
    configuredShell,
    spawnImpl,
    now,
    logger,
    ...(tickMs === undefined ? {} : { tickMs }),
    ...(heartbeatMs === undefined ? {} : { heartbeatMs }),
    ...iconHostDeps,
  })

  const started = autoStart === true ? await icon.start() : null
  const probe = nativeIconSupport({ platform, env, configuredShell, iconHost: started?.ok === true ? icon : null })

  return Object.freeze({
    ok: started === null ? true : started.ok === true,
    code: started === null ? null : started.code,
    message: started === null
      ? `托盘与图标宿主已装配（没有启动：autoStart=false）。${probe.notice}`
      : started.ok === true
        ? `托盘已接进 Launcher，并且图标宿主报了 ready（pid ${started.pid ?? '未知'}）`
        : `托盘已接进 Launcher，但**图标没起来**：${started.message}`,
    wiring,
    icon,
    nativeIcon: probe.supported,
    nativeIconProbe: probe,
    iconNotice: probe.notice,
    invoke: (id) => wiring.invoke(id),
    menu: () => wiring.menu(),
    /** 收掉图标宿主（幂等）。**不动**产品本身。 */
    stop: (reason) => icon.stop(reason),
    /**
     * 收工：先收图标宿主，再释放托盘。
     *
     * ★ 顺序不能反：先 `wiring.dispose()` 会让还在跑的宿主往一个已释放的托盘上
     * 送点击，而那时每一个点击都会被拒——用户看到的是"点了没反应"。
     */
    async disconnect(reason = 'launcher-shutdown') {
      const stopped = await icon.stop(reason)
      wiring.dispose()
      return stopped
    },
    status: () => Object.freeze({
      wired: true,
      icon: icon.status(),
      nativeIcon: probe.supported,
      ...wiring.status(),
    }),
    diagnostics: () => Object.freeze([...wiring.diagnostics(), ...icon.diagnostics()]),
  })
}
