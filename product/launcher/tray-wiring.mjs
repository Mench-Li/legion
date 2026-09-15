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
// ── ★ 另一半边界：本模块**不产生原生托盘图标** ──
//
// 零依赖的 Node 拿不到托盘图标：那需要原生绑定（或 Electron 之类的壳）。
// `createTray()` 从一开始就只做菜单模型 + 动作派发，本模块也不会假装补上这一截——
// 它交出去的仍然只有 `menu()` 与 `invoke(id)`，由将来的原生外壳去画图标、接点击。
//
//   > 一个"看起来接进了托盘、却什么图标也没出"的实现，
//   > 与一个明说"这里只有菜单模型"的实现，在用户找那个不存在的图标之前
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
 * ★ 本模块**不**产生原生托盘图标。
 *
 * 这个常量存在的意义是让"没有图标"这件事成为**读数**而不是读者的推断：
 * 一个导出里写着 `NATIVE_ICON_SUPPORTED = false` 的托盘接线，与一个
 * 什么都不说、只是恰好没画图标的托盘接线，在用户去找那个图标时是两回事。
 */
export const NATIVE_ICON_SUPPORTED = false

/** 说清"没有图标"以及"那谁该来画"，免得读者以为这是漏做。 */
export const NO_NATIVE_ICON_REASON = '本模块不产生原生托盘图标：零依赖的 Node 没有画图标的能力。'
  + '它交付的是菜单模型与动作派发（menu() / invoke(id)），'
  + '图标与点击要由原生外壳（或 Electron / DSH Desktop 那一层）来画。'
  + '在那之前，"托盘"只以菜单的形式存在。'

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
function notWired(code, message) {
  const refusal = Object.freeze({ ok: false, code, message })
  const reject = async () => refusal
  return Object.freeze({
    ok: false, code, message,
    tray: null,
    observe: async () => null,
    nativeIcon: NATIVE_ICON_SUPPORTED,
    iconNotice: NO_NATIVE_ICON_REASON,
    menu: reject,
    invoke: reject,
    dispose: () => refusal,
    status: () => Object.freeze({ wired: false, code, message }),
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
 *
 * @returns {{ok: boolean, code: string|null, message: string, tray: object|null,
 *            observe: Function, nativeIcon: boolean, iconNotice: string,
 *            menu: Function, invoke: Function, dispose: Function,
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
} = {}) {
  if (launcher === null || typeof launcher !== 'object'
    || typeof launcher.status !== 'function'
    || typeof launcher.start !== 'function'
    || typeof launcher.stop !== 'function') {
    return notWired(
      TRAY_WIRING_CODES.MISSING_LAUNCHER,
      '接线需要一个同时提供 status() / start() / stop() 的 launcher'
        + `（收到 ${launcher === null ? 'null' : typeof launcher}）`,
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
    return notWired(TRAY_WIRING_CODES.FAILED, `装配托盘时抛错：${e?.message ?? String(e)}`)
  }

  return Object.freeze({
    ok: true,
    code: null,
    message: '托盘已接进 Launcher（菜单与动作都来自观测）',
    /** ★ 底层控制器：未来的原生外壳就靠它渲染 `menu()` / 派发 `invoke(id)`。 */
    tray,
    /** 观测本身也暴露出去：原生外壳与用例都能直接看这份读数。 */
    observe,
    nativeIcon: NATIVE_ICON_SUPPORTED,
    iconNotice: NO_NATIVE_ICON_REASON,
    menu: () => tray.menu(),
    invoke: (id) => tray.invoke(id),
    dispose: () => tray.dispose(),
    status: () => Object.freeze({ wired: true, nativeIcon: NATIVE_ICON_SUPPORTED, ...tray.status() }),
    diagnostics: () => tray.diagnostics(),
  })
}
