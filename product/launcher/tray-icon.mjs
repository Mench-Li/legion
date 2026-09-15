// product/launcher/tray-icon.mjs
// ============================================================================
// PRT-708：**真的**画出一个系统托盘图标（生成 + 起 + 看 + 收一个平台脚本宿主）
//
// `tray.mjs` 交付的是菜单模型与动作派发，`tray-wiring.mjs` 把 launcher 接上去。
// 那两件东西加起来**仍然没有图标**——没有任何东西把它画到系统托盘上。本模块补的
// 就是这一截，而且它在 Windows 上**不需要原生模块**：Windows PowerShell 5.1
// 自带 `System.Windows.Forms.NotifyIcon`。所以缺的从来不是"原生绑定"，
// 而是"有没有人真的去起一个宿主进程"。
//
//   > 一个"托盘需要原生外壳"的结论，
//   > 与一个"我没有试过平台上现成的那套 UI 组件"的读数，
//   > 在 `NATIVE_ICON_SUPPORTED = false` 那一行上是同一个东西。
//
// ── 纪律一：菜单**只**来自模型，脚本里一个字都不许写 ──────────────────────
//
// 宿主脚本里**没有菜单文案**，也没有菜单项清单。它读的是
// `<DataDir>/tray/tray-menu.json`，而那份文件由本模块用 `tray.menu()` 的读数写出来，
// **每次动作之后重写**。脚本只负责"把这份 JSON 画成一个右键菜单"。
//
//   > 一份「脚本里也写了一遍菜单」的实现，
//   > 与一份「菜单来自模型」的实现，
//   > 在两边今天恰好一样的那些运行里是同一个东西——
//   > 只不过前者会在有人只改一边的第二天，让用户点到一个模型里不存在的动作。
//
// 用例把这条钉在**生成物**上：`renderTrayScript()` 的输出里不许出现任何一个菜单标签。
//
// ── 纪律二：点击走 stdout 的 JSON 行；停止走哨兵文件 ──────────────────────
//
// 两个方向各取一个**不会阻塞宿主消息循环**的通道：
//
//   · 宿主 → 产品：**stdout 一行一个 JSON**。点击处理器里写一行就完事，
//     没有阻塞、没有文件锁、天然有序。它唯一的失败形态是"读的人不读了"——
//     管道写满会把点击处理器卡住（UI 冻住），所以本模块**从第一条数据起就持续读**，
//     而且每行都很短。
//   · 产品 → 宿主：一个**哨兵文件**，宿主用 WinForms Timer 每 250ms 看一眼。
//     刻意**不用 stdin**：在 UI 线程上读 stdin 会阻塞消息循环，而消息循环一停，
//     图标就在、点了没反应——那正是"没有图标"之外最坏的形状。
//
// ── 纪律三：宿主的寿命是被规定的，不是碰巧的 ──────────────────────────────
//
// 三条路，一条都不许漏：
//
//   · **产品正常收工**：本模块写哨兵 → 宿主 `Visible=$false` + `Dispose()` → 报
//     `exited` 行 → 退出。**先 Dispose 再报 exited**，顺序本身是判据：
//     反过来会让"图标已经拆掉"这句话在没有 Dispose 的实现里也是真的。
//   · **launcher 被杀了**（任务管理器 / 拔电前的最后一个动作）：宿主每拍查一次
//     父进程还在不在，不在就自己走上面那条 Dispose 路径。否则用户会留下一个
//     **孤儿图标**——它指向一个已经不在的产品，点它什么也不会发生。
//   · **宿主自己死了**（脚本被拦、WinForms 加载失败、崩了）：本模块如实报
//     `HOST_UNHEALTHY` + 退出码，并且**允许重新 `start()`**。一个"图标没了但产品
//     还在跑"的处境，必须留下一条回去的路，而不是安静地什么都不说。
//
// 心跳（宿主每 2 秒一行）不是保活，是**读数**：进程还在但心跳停了 = 消息循环卡住了，
// 那时图标还在屏幕上却不会响应。本模块只报出来，**不自动杀**——
// 一个正在弹模态对话框的宿主与一个真卡死的宿主在这一层分不出来，
// 而杀错会让用户手上正在等的那件事消失。
//
// ── 纪律四：写入被挡在 `<DataDir>/tray/` 之内 ─────────────────────────────
//
// 生成物落在数据目录（可写、可备份、升级不替换），**永不落安装目录**
// （升级时整体替换，脚本会跟着消失），也不落真实用户的 `~/.dsh`
// （那是 DSH 的地盘，它的 clean/upgrade 会把整棵树换掉）。
// 与 `runtime-install.mjs` 同一套边界判据，逐条在 `planTrayIcon` 里判**在任何写入之前**。
//
// ── 纪律五：退出的纪律**不在这里重新实现** ────────────────────────────────
//
// 点击 `quit` 一律走 `tray.invoke('quit')`——"停 → 重新观测 → 观测到 `unavailable`
// 才算退出"那条纪律在 `tray.mjs` 里，本模块只是**多了一条后果**：
// 只有 `quit` 真的确认了（`exited === true`）才让图标跟着走。
// 没确认时图标**留着**，用户还能再点一次（"藏图标"与"退不出去"是两回事）。
//
// ── 本模块**不**证明什么（诚实边界，与用例里那一段逐条对应） ───────────────
//
//   · **一次真实的鼠标点击没有被模拟过**，无人值守的用例也模拟不了。被证明的是
//     "宿主会发的那个形状的消息，进了派发就是同一个结果"，不是"鼠标点到它了"。
//   · **图标长什么样没有被断言**：`Dispose` 有没有跑可以读（宿主自报 `disposed`），
//     "它在托盘里好不好看、有没有被折叠进溢出区"读不出来。
//   · 非 Windows 上一行图标都画不出来（宿主脚本要加载的 WinForms 只存在于 Windows），
//     本模块在那里**如实报不支持**，不生成一个"起了就死"的假宿主。
//   · 脚本的语法检查只能靠 PowerShell 自己的解析器（`node --check` 读不了 PowerShell），
//     所以那一条在用例里按"有 shell 才跑、没有就如实 SKIP"处理。
// ============================================================================

import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

import { isPathInside, normalizePath, pathApi, samePath } from '../paths.mjs'

/** 本模块的版本。落进计划与结果，便于把一次运行与一份实现对起来。 */
export const TRAY_ICON_VERSION = 1

/**
 * 宿主与本模块之间的协议版本。
 *
 * ★ 它是**拒绝的依据**，不是装饰：一个上一版留下的脚本（或者别的什么东西）往
 * 我们的 stdout 上写行时，版本对不上就一行都不认。
 */
export const TRAY_ICON_HOST_PROTOCOL_VERSION = 1

/** 本模块的具名码。每一条对应一种**下一步动作不同**的处境。 */
export const TRAY_ICON_CODES = Object.freeze({
  // ── 平台与 shell（纯解析，不碰磁盘之外的东西）────────────────────────
  /** 非 win32：生成物要加载的 WinForms 只存在于 Windows。 */
  UNSUPPORTED_PLATFORM: 'TRAY_ICON_UNSUPPORTED_PLATFORM',
  /** 一个候选 shell 都不存在（连 5.1 那最后一档也没有）。 */
  NO_SHELL: 'TRAY_ICON_NO_SHELL',
  /** 解析到了 shell，但还没有起过宿主 —— "能不能画"此时**还不知道**。 */
  HOST_PENDING: 'TRAY_ICON_HOST_PENDING',
  /** 宿主真的报了 ready：这是"支持"的唯一证据。 */
  HOST_READY: 'TRAY_ICON_HOST_READY',
  /** 宿主没起来 / 起来又死了 / 根本没报 ready。 */
  HOST_FAILED: 'TRAY_ICON_HOST_FAILED',

  // ── 位置（全部在纯计划里判，**任何目录被创建之前**）──────────────────
  NO_DATA_DIR: 'TRAY_ICON_NO_DATA_DIR',
  DATA_DIR_NOT_ABSOLUTE: 'TRAY_ICON_DATA_DIR_NOT_ABSOLUTE',
  /** 生成物会落进真实 operator 的 `$DSH_HOME` / `~/.dsh`。 */
  TARGET_INSIDE_DSH_HOME: 'TRAY_ICON_TARGET_INSIDE_DSH_HOME',
  /** 生成物会落进安装目录（升级时被整体替换）。 */
  TARGET_INSIDE_INSTALL_DIR: 'TRAY_ICON_TARGET_INSIDE_INSTALL_DIR',
  /** 目标越出允许根（含"没给允许根"——那按越界处理）。 */
  TARGET_OUTSIDE_ALLOWED_ROOT: 'TRAY_ICON_TARGET_OUTSIDE_ALLOWED_ROOT',
  /** 某一次具体写入落在允许根之外 / 只读根之内，被挡下。 */
  WRITE_REFUSED: 'TRAY_ICON_WRITE_REFUSED',

  // ── 起宿主 ───────────────────────────────────────────────────────────
  /** 观测不到菜单模型：**不起宿主**（一个没有菜单的图标用户点不了）。 */
  MENU_UNAVAILABLE: 'TRAY_ICON_MENU_UNAVAILABLE',
  /** 菜单模型有形状问题（空 items / id 不是字符串 / 标签为空）。 */
  MENU_MALFORMED: 'TRAY_ICON_MENU_MALFORMED',
  /** 已经在跑了（重复 start）。 */
  ALREADY_STARTED: 'TRAY_ICON_ALREADY_STARTED',
  SPAWN_FAILED: 'TRAY_ICON_SPAWN_FAILED',
  /** 宿主进程没了，但从来没报过 ready。 */
  HOST_EXITED_BEFORE_READY: 'TRAY_ICON_HOST_EXITED_BEFORE_READY',
  /** 既没 ready 也没退出，超时了。 */
  HOST_NOT_READY: 'TRAY_ICON_HOST_NOT_READY',

  // ── 收宿主 ───────────────────────────────────────────────────────────
  /** 还没起过（停止是幂等的，这一条**不是**错误）。 */
  NOT_STARTED: 'TRAY_ICON_NOT_STARTED',
  /** 干净退出：宿主报过 `exited` 且 `disposed === true`。 */
  EXITED: 'TRAY_ICON_EXITED',
  /** 宿主退出了，但**没有**报"图标已 Dispose"——幽灵图标就是这么来的。 */
  SHUTDOWN_UNCLEAN: 'TRAY_ICON_SHUTDOWN_UNCLEAN',
  /** 写了哨兵也不走：杀了，并且**不把它说成干净退出**。 */
  SHUTDOWN_TIMEOUT: 'TRAY_ICON_SHUTDOWN_TIMEOUT',

  // ── 运行期读数 ───────────────────────────────────────────────────────
  /** 宿主进程还在，但心跳停了（消息循环不转了）。 */
  HOST_UNHEALTHY: 'TRAY_ICON_HOST_UNHEALTHY',
  /** 收到一行读不懂 / 版本或 hostId 对不上的东西。**不派发**。 */
  UNKNOWN_MESSAGE: 'TRAY_ICON_UNKNOWN_MESSAGE',
  /** 点击的动作 id 不在**当前模型**里。**不派发**。 */
  UNKNOWN_ACTION: 'TRAY_ICON_UNKNOWN_ACTION',
  /** 上一个动作还没完：不排队（队列会让"停止"在"启动"之后执行）。 */
  BUSY: 'TRAY_ICON_BUSY',
  /** 重新发布菜单失败（读不到模型）：保留上一份菜单，不清空。 */
  MENU_REPUBLISH_FAILED: 'TRAY_ICON_MENU_REPUBLISH_FAILED',
  /** 没有被上面任何一支接住的抛出。收口用，不是某一类失败的同义词。 */
  UNEXPECTED: 'TRAY_ICON_UNEXPECTED',
})

/** 宿主消息的种类。**顺序即协议里的全集**。 */
export const TRAY_ICON_MESSAGE_KINDS = Object.freeze([
  'ready', 'heartbeat', 'click', 'menu-error', 'error', 'exited', 'stopped',
])

/**
 * 生成物在 **DataDir** 里的相对位置。
 *
 * 一层 `tray/` 就够：脚本、菜单、哨兵三个文件都在里面，删掉这一个目录等于
 * "把这次运行留下的所有东西清干净"。它**不在**安装目录里（见文件头纪律四）。
 */
export const TRAY_ICON_DIR_PARTS = Object.freeze(['tray'])

/** 生成出来的宿主脚本文件名。 */
export const TRAY_ICON_SCRIPT_FILENAME = 'legion-tray-icon.ps1'

/**
 * 菜单文件（脚本读它，产品侧写它）。
 *
 * ★ 名字里带 `menu` 不是为了好看：它回答的是"这个文件是**菜单模型**"
 * 这个事实。叫 `data.json` 之类的名字之后，下一个人看不出它必须来自 `tray.menu()`。
 */
export const TRAY_ICON_MENU_FILENAME = 'tray-menu.json'

/** 停止哨兵文件名。它在 = 请宿主 Dispose 图标再退出。 */
export const TRAY_ICON_STOP_FILENAME = 'tray-stop'

/** 宿主的轮询间隔（ms）。写入的判据不是这个数，是"一拍之内能看见"。 */
export const TRAY_ICON_DEFAULT_TICK_MS = 250

/** 心跳间隔（ms）。它比 tick 大一个量级，免得每拍都写一行。 */
export const TRAY_ICON_DEFAULT_HEARTBEAT_MS = 2000

/** 等宿主报 ready 的默认上限（ms）。 */
export const TRAY_ICON_DEFAULT_READY_TIMEOUT_MS = 15000

/** 写哨兵之后等宿主自己走的默认上限（ms）。 */
export const TRAY_ICON_DEFAULT_STOP_TIMEOUT_MS = 8000

/** 杀了之后再等它真的消失的宽限（ms）。 */
export const TRAY_ICON_DEFAULT_KILL_GRACE_MS = 2000

/**
 * 解析 shell 时要读的那几个**操作系统事实**。
 *
 * 与 `product/launcher/cli.mjs` 的 `OS_HOME_ENV` 同一做法：键名从一张具名表里取，
 * 于是"这三个名字属于操作系统、不属于 Legion 配置"这件事只有一个住处。
 * 它们逐个登记在 `product/config-schema.mjs` 的 `dynamicEnvReads` 里
 * （`scan --check` 要求），并在 `OS_ONLY_ENV_NAMES` 里说明归属。
 */
export const SHELL_ENV = Object.freeze({
  PROGRAM_FILES: 'ProgramFiles',
  SYSTEM_ROOT: 'SystemRoot',
  PATH: 'PATH',
})

/** 候选 shell 的种类。`kind` 进读数与诊断，让"用的是哪一档"可查。 */
export const TRAY_SHELL_KINDS = Object.freeze({
  CONFIGURED: 'configured',
  PWSH_7: 'pwsh-7',
  PATH: 'path',
  WINDOWS_POWERSHELL_5_1: 'windows-powershell-5.1',
})

/** 非空字符串或 `null`。**不 trim 成新值**的场合自己 trim（见 `planTrayIcon`）。 */
const nonEmpty = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

/** 默认的"这个路径存在吗"。`lstat` 看的是入口本身（Store 别名是符号链接）。 */
export function defaultFileExists(path) {
  try {
    const st = lstatSync(path)
    return st.isFile() || st.isSymbolicLink()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// ① shell 解析（纯函数：只依赖 (platform, env, exists)）
// ---------------------------------------------------------------------------

/**
 * 候选 shell 路径，**按解析顺序**。
 *
 * ★ 顺序照抄 DSH 自己的解析器（`packages/shell/pwsh-local/src/resolve.ts`）的**理由**，
 * 不是照抄它的代码——本模块不能依赖 DSH，但"为什么是这个顺序"是同一个理由：
 *
 *   ① `%ProgramFiles%\PowerShell\7\pwsh.exe`：PowerShell 7 是当前受支持的那一支，
 *      先试它。但它**不是每台机器都有**。
 *   ② `PATH` 上的 `pwsh.exe`：Microsoft Store 版与用户自加的位置都落在这里，
 *      条目可能带着 `setx` 风格留下的引号。
 *   ③ `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`：
 *      **最后一档**。它随 Windows 发货，所以"前两档都没有"不等于"托盘画不出来"。
 *
 *   > 一个"这台机器上没有 PowerShell 7"的读数，
 *   > 与一个"托盘在这台机器上支持不了"的读数，
 *   > 在只看了候选列表前两项的人那里是同一个东西——
 *   > 只不过那两项后面还有一行写着 5.1。
 *
 * 纯函数：不碰磁盘（`exists` 由调用方注入），可以在 posix 上对着 win32 语义测。
 *
 * @returns {ReadonlyArray<{path: string, kind: string}>}
 */
export function candidateTrayShells({ env = {}, platform = process.platform } = {}) {
  if (platform !== 'win32') return Object.freeze([])
  const win = pathApi('win32')
  // 三处都是**计算出来的键**（键名住在 SHELL_ENV 那张表里），逐个登记在
  // `product/config-schema.mjs` 的 `dynamicEnvReads` 里：写死字面量会让
  // 「这几个名字属于操作系统」这件事两处各说一半。
  const programFiles = nonEmpty(env[SHELL_ENV.PROGRAM_FILES]) ?? 'C:\\Program Files'
  const systemRoot = nonEmpty(env[SHELL_ENV.SYSTEM_ROOT]) ?? 'C:\\Windows'
  const pathValue = typeof env[SHELL_ENV.PATH] === 'string' ? env[SHELL_ENV.PATH] : ''

  const out = [{ path: win.join(programFiles, 'PowerShell', '7', 'pwsh.exe'), kind: TRAY_SHELL_KINDS.PWSH_7 }]
  for (const raw of pathValue.split(';')) {
    // 条目可能带着引号（`setx` 风格的定义会留下它们），也可能两头是空白。
    const entry = raw.trim().replace(/^"|"$/g, '')
    if (entry === '') continue
    out.push({ path: win.join(entry, 'pwsh.exe'), kind: TRAY_SHELL_KINDS.PATH })
  }
  out.push({
    path: win.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    kind: TRAY_SHELL_KINDS.WINDOWS_POWERSHELL_5_1,
  })
  // 同一个路径可能在 PATH 上出现多次：只留第一次出现的那一档（顺序就是判据）。
  const seen = new Set()
  const deduped = []
  for (const c of out) {
    const key = c.path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(Object.freeze(c))
  }
  return Object.freeze(deduped)
}

/**
 * 解析这次要用哪个 shell。
 *
 * `configured` 优先且**原样信任**（与 DSH 的 `resolvePwshPath` 一致）：显式配置是一个
 * 调用方**写出来了**的事实；判它存不存在只会在"路径里有变量/别名"时误拒。
 * 它错了会在 `start()` 里以 `SPAWN_FAILED` 落地，而不是在这里被猜。
 *
 * @returns {{ok: boolean, code: string|null, path: string|null, kind: string|null,
 *            candidates: ReadonlyArray<{path: string, kind: string, exists: boolean}>,
 *            message: string}}
 */
export function resolveTrayShell({
  platform = process.platform,
  env = {},
  configured = null,
  exists = defaultFileExists,
} = {}) {
  if (platform !== 'win32') {
    return Object.freeze({
      ok: false,
      code: TRAY_ICON_CODES.UNSUPPORTED_PLATFORM,
      path: null,
      kind: null,
      candidates: Object.freeze([]),
      message: `平台 ${platform} 上没有图标宿主：生成物要加载的 System.Windows.Forms 只存在于 Windows，`
        + '这里不生成一个"起了就死"的假宿主',
    })
  }
  if (typeof configured === 'string' && configured.trim() !== '') {
    const p = configured.trim()
    return Object.freeze({
      ok: true,
      code: null,
      path: p,
      kind: TRAY_SHELL_KINDS.CONFIGURED,
      candidates: Object.freeze([Object.freeze({ path: p, kind: TRAY_SHELL_KINDS.CONFIGURED, exists: null })]),
      message: `用调用方显式给的 shell：${p}（显式配置原样信任；它起不来会在 start() 里报 SPAWN_FAILED）`,
    })
  }
  const candidates = []
  for (const c of candidateTrayShells({ env, platform })) {
    const present = exists(c.path) === true
    candidates.push(Object.freeze({ path: c.path, kind: c.kind, exists: present }))
    if (present) {
      return Object.freeze({
        ok: true,
        code: null,
        path: c.path,
        kind: c.kind,
        candidates: Object.freeze(candidates),
        message: `用 ${c.kind}：${c.path}`,
      })
    }
  }
  return Object.freeze({
    ok: false,
    code: TRAY_ICON_CODES.NO_SHELL,
    path: null,
    kind: null,
    candidates: Object.freeze(candidates),
    message: '一个候选 shell 都不存在（连随 Windows 发货的 5.1 那一档也没有）：'
      + candidates.map((c) => `${c.kind}=${c.path}`).join('；'),
  })
}

/**
 * 现在到底支不支持托盘图标？——**三态**，与 `single-instance.mjs` 的 `processAlive` 同一形状。
 *
 *   · `true`  —— 有一个宿主**真的报了 ready**。这是唯一的正面证据。
 *   · `false` —— 有一个确定的否定证据（平台不是 win32 / 一个候选 shell 都没有 /
 *                宿主起过并且失败了）。
 *   · `null`  —— **解析到了 shell，但还没起过宿主**。"能不能画"此时真的不知道。
 *
 *   > 一个"解析到了 shell 所以支持"的读数，
 *   > 与一个"宿主真的报过 ready"的读数，
 *   > 在没有桌面会话的机器上是两回事——
 *   > 只不过前者会把一个画不出来的图标说成可用。
 *
 * 每一支都带 `flips`：**什么证据会翻转这个结论**。一个说"不支持"而不说"怎么才能支持"
 * 的读数，用户只能猜。
 *
 * @param {object} o
 * @param {object|null} [o.host] 一个起过的宿主（`createTrayIconHost(...)` 的返回值或 `status()`）
 */
export function probeTrayIconSupport({
  platform = process.platform,
  env = {},
  configured = null,
  exists = defaultFileExists,
  host = null,
} = {}) {
  const shell = resolveTrayShell({ platform, env, configured, exists })
  if (shell.ok !== true) {
    return Object.freeze({
      supported: false,
      code: shell.code,
      reason: shell.message,
      flips: shell.code === TRAY_ICON_CODES.UNSUPPORTED_PLATFORM
        ? '在 win32 上运行；并且解析到一档候选 shell（`SHELL_ENV.ProgramFiles` 下的 PowerShell 7、'
          + 'PATH 上的 pwsh.exe、或随 Windows 发货的 5.1），并且那个宿主在 stdout 上报出 ready'
        : '让其中某一个候选路径真的存在（装 PowerShell 7，或确认 5.1 的 System32 路径在）',
      shell: null,
      candidates: shell.candidates,
      evidence: Object.freeze({ platform, shell: null, hostReady: null, pid: null, lastHeartbeatAt: null }),
    })
  }

  if (host === null || host === undefined) {
    return Object.freeze({
      supported: null,
      code: TRAY_ICON_CODES.HOST_PENDING,
      reason: `解析到了 shell（${shell.kind}：${shell.path}），但**还没有起过宿主**：`
        + '图标到底画不画得出来，只有宿主真的报了 ready 才算数（headless 会话里 WinForms 可能起不来）',
      flips: '起一次宿主；它报 ready → 支持，它报 error / 没报 ready 就退出 → 不支持（看 exitCode 与那行 error）',
      shell: shell.path,
      candidates: shell.candidates,
      evidence: Object.freeze({ platform, shell: shell.path, hostReady: null, pid: null, lastHeartbeatAt: null }),
    })
  }

  // 传进来的可以是宿主对象本身（`createTrayIconHost(...)` 的返回值），也可以是它的
  // `status()` 读数。前者更常见，所以这里统一取一次读数——**不**要求调用方记住这件事。
  const h = (host !== null && typeof host === 'object' && typeof host.status === 'function')
    ? host.status()
    : host
  const ready = h.ready === true
  const alive = h.alive === true
  // ★ "还没有起过"与"起过但失败了"是两件事。一个刚装配好、一次 `start()` 都没调过的宿主
  //   会把 `ready` 报成 false —— 那是 `null`（不知道），不是 `false`（不支持）。
  //   把两者混起来的代价：向导页会在**什么都还没试**的时候告诉用户"这台机器不支持托盘"。
  const attempted = h.ready === true || h.everStarted === true || h.started === true
    || (h.exitCode !== null && h.exitCode !== undefined)
    || (h.lastFailure !== null && h.lastFailure !== undefined)
  if (attempted !== true) {
    return Object.freeze({
      supported: null,
      code: TRAY_ICON_CODES.HOST_PENDING,
      reason: `宿主已经装配好（shell ${h.shell ?? shell.path}）但**还没有 start() 过**：`
        + '图标到底画不画得出来，只有宿主真的报了 ready 才算数',
      flips: '起一次宿主；它报 ready → 支持，它报 error / 没报 ready 就退出 → 不支持（看 exitCode 与那行 error）',
      shell: h.shell ?? shell.path,
      candidates: shell.candidates,
      evidence: Object.freeze({ platform, shell: h.shell ?? shell.path, hostReady: null, pid: null, lastHeartbeatAt: null }),
    })
  }
  if (ready === true) {
    return Object.freeze({
      supported: true,
      code: TRAY_ICON_CODES.HOST_READY,
      reason: null,
      flips: '宿主进程退出、或它不再报心跳（那时图标还在屏幕上但不会响应）',
      shell: h.shell ?? shell.path,
      candidates: shell.candidates,
      evidence: Object.freeze({
        platform,
        shell: h.shell ?? shell.path,
        hostReady: true,
        pid: h.pid ?? null,
        lastHeartbeatAt: h.lastHeartbeatAt ?? null,
        alive,
      }),
    })
  }
  return Object.freeze({
    supported: false,
    code: TRAY_ICON_CODES.HOST_FAILED,
    reason: `宿主没有报 ready：${h.lastFailure?.message ?? h.message ?? '没有给出原因'}`
      + `${h.exitCode === null || h.exitCode === undefined ? '' : `（退出码 ${h.exitCode}）`}`,
    flips: '看宿主那行 error / stderr：菜单文件读不到、WinForms 加载失败、'
      + '或这是一个没有交互桌面的会话；修掉之后重新 start()',
    shell: shell.path,
    candidates: shell.candidates,
    evidence: Object.freeze({
      platform,
      shell: shell.path,
      hostReady: false,
      pid: h.pid ?? null,
      lastHeartbeatAt: h.lastHeartbeatAt ?? null,
      alive,
    }),
  })
}

// ---------------------------------------------------------------------------
// ② 菜单模型 → 宿主脚本（纯函数）
// ---------------------------------------------------------------------------

/**
 * 一份可以交给宿主的菜单文档。
 *
 * ★ 只带四个字段（`id` / `label` / `enabled` / `disabledReason`），**不整份透传模型**：
 * 菜单项上将来会长出别的东西（图标、快捷键、子菜单），而那些东西宿主这一版不认识；
 * 把整个对象发过去等于让脚本开始依赖模型从未承诺过的字段。
 *
 * ★ 形状不对就**拒绝发布**（`ok:false`），不发布一份"少了一半"的菜单：
 * 一个缺了 `quit` 的菜单会把用户困在一个他关不掉的产品里。
 */
export function buildTrayMenuDocument({ items = null, hostId = null, appName = 'Legion' } = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    return Object.freeze({
      ok: false,
      code: TRAY_ICON_CODES.MENU_MALFORMED,
      message: '菜单模型里一个菜单项都没有：不发布（一个空菜单的图标，用户点不了任何东西）',
      document: null,
    })
  }
  const out = []
  for (const [i, it] of items.entries()) {
    if (it === null || typeof it !== 'object') {
      return malformed(i, `不是一个对象（${typeof it}）`)
    }
    if (typeof it.id !== 'string' || it.id === '') return malformed(i, 'id 不是非空字符串')
    if (typeof it.label !== 'string' || it.label === '') return malformed(i, 'label 不是非空字符串')
    out.push(Object.freeze({
      id: it.id,
      label: it.label,
      enabled: it.enabled === true,
      // `null` 与"没有这个字段"在宿主的 ToolTip 上是同一件事，但在这里**不是**：
      // 一个"灰掉了但不说为什么"的菜单项，用户只会以为坏了（`tray.mjs` 的同一条纪律）。
      disabledReason: typeof it.disabledReason === 'string' && it.disabledReason !== '' ? it.disabledReason : null,
    }))
  }
  return Object.freeze({
    ok: true,
    code: null,
    message: `${out.length} 个菜单项来自模型`,
    document: Object.freeze({
      version: TRAY_ICON_VERSION,
      hostId: typeof hostId === 'string' && hostId !== '' ? hostId : null,
      appName,
      items: Object.freeze(out),
    }),
  })
}

function malformed(index, why) {
  return Object.freeze({
    ok: false,
    code: TRAY_ICON_CODES.MENU_MALFORMED,
    message: `菜单模型第 ${index} 项有问题：${why}。不发布——半份菜单比没有菜单更难查`,
    document: null,
  })
}

/** PowerShell 单引号字面量转义：`'` 写两遍。生成物里所有路径/标题都过这一道。 */
export function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * 生成宿主脚本。
 *
 * ★ 这份输出里**没有任何菜单文案**，也没有菜单项清单——菜单在运行期从
 * `menuPath` 读（纪律一）。用例把这条钉在输出文本上。
 *
 * ★ 生成物是 **UTF-8 带 BOM** 写盘的（见 `writeScript`）：Windows PowerShell 5.1
 * 对**没有 BOM** 的 `.ps1` 会按系统 ANSI 代码页解码，于是这个文件里任何非 ASCII
 * 字符（注释里的中文、菜单标签的例子）都会在中文 Windows 上被解成乱码。
 * BOM 让"这个文件是什么编码"成为**文件自己的属性**，而不是所在机器的地区设置。
 *
 * ★ 脚本正文用**单引号字符串数组 join('\n')** 拼出来，刻意**不用模板字面量**：
 * PowerShell 里反引号是转义符（`` `n ``/`` `t ``），模板字面量里出现一个反引号
 * 会**提前终止**它，而外层 JS 文件往往仍然能通过 `node --check`
 * （剩下的正文碰巧还是合法 JS 时）——生成物坏了、语法检查却是绿的。
 * 数组拼接让"脚本正文里出现反引号"变成一件无害的事。
 */
export function renderTrayScript({
  menuPath,
  stopPath,
  hostId = null,
  parentPid = 0,
  tickMs = TRAY_ICON_DEFAULT_TICK_MS,
  heartbeatMs = TRAY_ICON_DEFAULT_HEARTBEAT_MS,
  windowTitle = 'Legion',
  protocol = TRAY_ICON_HOST_PROTOCOL_VERSION,
} = {}) {
  if (typeof menuPath !== 'string' || menuPath === '') throw new TypeError('renderTrayScript 需要 menuPath')
  if (typeof stopPath !== 'string' || stopPath === '') throw new TypeError('renderTrayScript 需要 stopPath')
  const tick = Number.isInteger(tickMs) && tickMs >= 50 ? tickMs : TRAY_ICON_DEFAULT_TICK_MS
  const heartbeatTicks = Math.max(1, Math.round((Number.isInteger(heartbeatMs) ? heartbeatMs : TRAY_ICON_DEFAULT_HEARTBEAT_MS) / tick))
  const parent = Number.isInteger(parentPid) && parentPid > 0 ? parentPid : 0

  const L = []
  const push = (s) => { L.push(s) }

  push('# Legion 托盘图标宿主 —— 由 product/launcher/tray-icon.mjs 生成，每次启动重写，请勿手改。')
  push('# 菜单**不在这里**：它来自产品侧按当前观测写出的菜单文件（$MenuPath）。')
  push('$ErrorActionPreference = "Stop"')
  push('# stdout 一律 UTF-8（不带 BOM）：产品侧按 utf8 解行；不设的话 5.1 会用控制台代码页。')
  push('[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)')
  push('$MenuPath = ' + psQuote(menuPath))
  push('$StopPath = ' + psQuote(stopPath))
  push('$HostId = ' + psQuote(hostId === null || hostId === undefined ? '' : String(hostId)))
  push('$ParentPid = ' + String(parent))
  push('$WindowTitle = ' + psQuote(windowTitle))
  push('$Protocol = ' + String(protocol))
  push('$TickMs = ' + String(tick))
  push('$HeartbeatTicks = ' + String(heartbeatTicks))
  push('')
  push('function Emit([string]$line) {')
  push('  [Console]::Out.WriteLine($line)')
  push('  [Console]::Out.Flush()')
  push('}')
  push('function New-Message([string]$kind, [hashtable]$fields) {')
  push('  # 强制单行：协议是"一行一个 JSON"，-Compress 不是可选的美化选项。')
  push('  $o = @{ v = $Protocol; kind = $kind; hostId = $HostId }')
  push('  if ($fields -ne $null) { foreach ($k in $fields.Keys) { $o[$k] = $fields[$k] } }')
  push('  return ($o | ConvertTo-Json -Compress)')
  push('}')
  push('function Read-Text([string]$path) {')
  push('  if (-not (Test-Path -LiteralPath $path)) { return $null }')
  push('  # 显式 FileShare：产品侧会**原地覆盖**这个文件。默认的 FileShare.Read 会把写入方')
  push('  # 挡在 Windows 的共享检查外面，于是菜单在第一次刷新之后再也更新不了。')
  push('  $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete')
  push('  $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share)')
  push('  try {')
  push('    $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)')
  push('    try { return $sr.ReadToEnd() } finally { $sr.Dispose() }')
  push('  } finally { $fs.Dispose() }')
  push('}')
  push('function Build-Menu([string]$raw) {')
  push('  $model = $raw | ConvertFrom-Json')
  push('  $menu = New-Object System.Windows.Forms.ContextMenuStrip')
  push('  $menu.ShowItemToolTips = $true')
  push('  foreach ($it in $model.items) {')
  push('    $mi = New-Object System.Windows.Forms.ToolStripMenuItem')
  push('    $mi.Text = [string]$it.label')
  push('    $mi.Enabled = [bool]$it.enabled')
  push('    # 灰掉的项必须解释自己：理由挂 ToolTip，否则用户只会以为坏了。')
  push('    if (([string]$it.disabledReason) -ne "") { $mi.ToolTipText = [string]$it.disabledReason }')
  push('    # id 走 Tag，不走闭包：循环变量在 PowerShell 里是同一个变量，')
  push('    # 直接捕进事件处理器的话，所有菜单项最后都会指向最后一个 id。')
  push('    $mi.Tag = [string]$it.id')
  push('    $mi.add_Click($ClickHandler)')
  push('    $menu.Items.Add($mi) | Out-Null')
  push('  }')
  push('  return $menu')
  push('}')
  push('$ClickHandler = {')
  push('  param($sender, $e)')
  push('  # 点一下就写一行就走：没有阻塞、没有锁、天然有序。')
  push('  Emit (New-Message "click" @{ id = [string]$sender.Tag })')
  push('}')
  push('function Test-ParentAlive {')
  push('  if ($ParentPid -le 0) { return $true }')
  push('  try {')
  push('    $p = [System.Diagnostics.Process]::GetProcessById($ParentPid)')
  push('    return (-not $p.HasExited)')
  push('  } catch { return $false }')
  push('}')
  push('function Shutdown([string]$reason) {')
  push('  $disposed = $false')
  push('  try {')
  push('    if ($script:icon -ne $null) {')
  push('      $script:icon.Visible = $false')
  push('      $script:icon.Dispose()')
  push('      $disposed = $true')
  push('    }')
  push('  } catch { }')
  push('  # ★ 顺序是判据的一部分：**先 Dispose 再报 exited**。反过来会让"图标已经拆掉"')
  push('  #   这句话在没有 Dispose 的实现里也是真的（幽灵图标就是这么留下来的）。')
  push('  Emit (New-Message "exited" @{ reason = $reason; disposed = $disposed })')
  push('  $script:context.ExitThread()')
  push('}')
  push('$TickHandler = {')
  push('  param($sender, $e)')
  push('  $script:ticks++')
  push('  # ① launcher 被杀了也要收工：否则留下一个指向"已经不存在的产品"的孤儿图标。')
  push('  if (-not (Test-ParentAlive)) { Shutdown "parent-gone"; return }')
  push('  # ② 菜单按**模型**刷新：产品侧每次动作之后都会重写这个文件。')
  push('  #    解析失败（写到一半）时保留旧菜单，下一拍再试——绝不把菜单清空。')
  push('  $raw = $null')
  push('  try { $raw = Read-Text $MenuPath } catch { $raw = $null }')
  push('  if ($raw -ne $null -and $raw -ne $script:lastMenu) {')
  push('    try {')
  push('      $next = Build-Menu $raw')
  push('      if ($script:icon.ContextMenuStrip -ne $null) { $script:icon.ContextMenuStrip.Dispose() }')
  push('      $script:icon.ContextMenuStrip = $next')
  push('      $script:lastMenu = $raw')
  push('    } catch {')
  push('      Emit (New-Message "menu-error" @{ message = [string]$_.Exception.Message })')
  push('    }')
  push('  }')
  push('  # ③ 心跳是**读数**不是保活：它停了说明消息循环不转了（图标还在、点了没反应）。')
  push('  if (($script:ticks % $HeartbeatTicks) -eq 0) { Emit (New-Message "heartbeat" @{ ticks = $script:ticks }) }')
  push('  # ④ 停止哨兵：产品说"收工"。')
  push('  if (Test-Path -LiteralPath $StopPath) { Shutdown "stop-file" }')
  push('}')
  push('')
  push('Add-Type -AssemblyName System.Windows.Forms')
  push('Add-Type -AssemblyName System.Drawing')
  push('$script:icon = $null')
  push('$script:context = New-Object System.Windows.Forms.ApplicationContext')
  push('$script:lastMenu = $null')
  push('$script:ticks = 0')
  push('$menuText = $null')
  push('try { $menuText = Read-Text $MenuPath } catch { $menuText = $null }')
  push('if ($menuText -eq $null) {')
  push('  # 没有菜单的图标 = 一个点了没反应的图标。**不画它**，如实报错退出。')
  push('  Emit (New-Message "error" @{ phase = "menu"; message = "menu-unreadable" })')
  push('  exit 3')
  push('}')
  push('try {')
  push('  $script:icon = New-Object System.Windows.Forms.NotifyIcon')
  push('  $script:icon.Icon = [System.Drawing.SystemIcons]::Application')
  push('  $script:icon.Text = $WindowTitle')
  push('  $script:icon.ContextMenuStrip = Build-Menu $menuText')
  push('  $script:lastMenu = $menuText')
  push('  $script:icon.Visible = $true')
  push('} catch {')
  push('  Emit (New-Message "error" @{ phase = "icon"; message = [string]$_.Exception.Message })')
  push('  exit 4')
  push('}')
  push('$timer = New-Object System.Windows.Forms.Timer')
  push('$timer.Interval = $TickMs')
  push('$timer.add_Tick($TickHandler)')
  push('$timer.Start()')
  push('Emit (New-Message "ready" @{ pid = $PID })')
  push('[System.Windows.Forms.Application]::Run($script:context)')
  push('$timer.Stop()')
  push('$timer.Dispose()')
  push('Emit (New-Message "stopped" @{})')
  return L.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// ③ 宿主消息的解析（纯函数）
// ---------------------------------------------------------------------------

/**
 * 解析宿主写来的一行。
 *
 * ★ 这是**不可信输入**：它来自另一个进程，可能是上一版留下的脚本。所以这里只做
 * "读得懂吗、形状对吗"，**不派发**任何东西；派发在 `createTrayIconHost` 里，
 * 而且要再对一次 hostId 与"这个 id 在当前模型里吗"。
 *
 * @returns {{ok: true, version: number, kind: string, hostId: string|null, id: string|null, fields: object}
 *          | {ok: false, code: string, message: string, raw: string}}
 */
export function parseTrayHostLine(line) {
  const raw = typeof line === 'string' ? line.replace(/^\uFEFF/, '').replace(/\r$/, '') : ''
  if (raw.trim() === '') {
    return Object.freeze({ ok: false, code: TRAY_ICON_CODES.UNKNOWN_MESSAGE, message: '空行', raw })
  }
  let value = null
  try {
    value = JSON.parse(raw)
  } catch (e) {
    return Object.freeze({
      ok: false,
      code: TRAY_ICON_CODES.UNKNOWN_MESSAGE,
      message: `这一行不是 JSON：${String(e?.message ?? e)}`,
      raw,
    })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return Object.freeze({ ok: false, code: TRAY_ICON_CODES.UNKNOWN_MESSAGE, message: 'JSON 顶层不是对象', raw })
  }
  if (!Number.isInteger(value.v)) {
    return Object.freeze({ ok: false, code: TRAY_ICON_CODES.UNKNOWN_MESSAGE, message: '没有协议版本号 v', raw })
  }
  if (typeof value.kind !== 'string' || !TRAY_ICON_MESSAGE_KINDS.includes(value.kind)) {
    return Object.freeze({
      ok: false,
      code: TRAY_ICON_CODES.UNKNOWN_MESSAGE,
      message: `不认识的 kind：${JSON.stringify(value.kind)}（认得的只有 ${TRAY_ICON_MESSAGE_KINDS.join(' / ')}）`,
      raw,
    })
  }
  if (value.kind === 'click' && (typeof value.id !== 'string' || value.id === '')) {
    return Object.freeze({ ok: false, code: TRAY_ICON_CODES.UNKNOWN_MESSAGE, message: 'click 没有带 id', raw })
  }
  const { v, kind, hostId, id, ...fields } = value
  return Object.freeze({
    ok: true,
    version: v,
    kind,
    hostId: typeof hostId === 'string' && hostId !== '' ? hostId : null,
    id: typeof id === 'string' ? id : null,
    fields: Object.freeze(fields),
  })
}

// ---------------------------------------------------------------------------
// ④ 位置：纯计划 + 逐次写入的守卫
// ---------------------------------------------------------------------------

/**
 * **纯**计划：零 IO。任何一条不过就**不返回 `ok: true`**，于是"被拒绝"这条路径上
 * 一次 `mkdirSync` 都没有发生过（与 `runtime-install.mjs` 同一条纪律）。
 *
 * 判定顺序（顺序本身是判据）：
 *   ① 有 DataDir、且是绝对路径；
 *   ② 不落在 `$DSH_HOME` / `~/.dsh` / InstallDir 里；
 *   ③ 在调用方给的允许根之内（没给允许根 ⇒ 按越界处理）；
 *   ④ 落点就是 `<DataDir>/tray/`。
 *
 * @returns {object} 冻结的计划；`ok === true` 才可交给 `createTrayIconHost`
 */
export function planTrayIcon({
  dataDir = null,
  allowedRoot = null,
  installDir = null,
  dshHome = null,
  operatorHome = null,
  platform = process.platform,
} = {}) {
  const refuse = (code, message, fields = {}) => Object.freeze({
    version: TRAY_ICON_VERSION,
    ok: false,
    stage: 'refused',
    code,
    message,
    diagnostics: Object.freeze([]),
    controlDir: null,
    writableRoot: null,
    readOnlyRoots: Object.freeze([]),
    scriptPath: null,
    menuPath: null,
    stopPath: null,
    ...fields,
  })

  if (nonEmpty(dataDir) === null) {
    return refuse(TRAY_ICON_CODES.NO_DATA_DIR,
      '没有 DataDir：图标宿主的生成物是**可写的运行期状态**，只该落数据目录')
  }
  if (!pathApi(platform).isAbsolute(dataDir)) {
    return refuse(TRAY_ICON_CODES.DATA_DIR_NOT_ABSOLUTE,
      `DataDir 不是绝对路径：${JSON.stringify(dataDir)}。相对路径的落点随 cwd 变，`
      + '于是"脚本写到哪了"在两次启动之间可以不同')
  }

  const roots = {
    dataDir: normalizePath(dataDir, platform),
    installDir: nonEmpty(installDir) === null ? null : normalizePath(installDir, platform),
    dshHome: nonEmpty(dshHome) === null ? null : normalizePath(dshHome, platform),
    operatorHome: nonEmpty(operatorHome) === null ? null : normalizePath(operatorHome, platform),
    allowedRoot: nonEmpty(allowedRoot) === null ? null : normalizePath(allowedRoot, platform),
  }
  const win = pathApi(platform)
  const controlDir = win.join(roots.dataDir, ...TRAY_ICON_DIR_PARTS)
  const scriptPath = win.join(controlDir, TRAY_ICON_SCRIPT_FILENAME)
  const menuPath = win.join(controlDir, TRAY_ICON_MENU_FILENAME)
  const stopPath = win.join(controlDir, TRAY_ICON_STOP_FILENAME)

  const readOnly = []
  if (roots.dshHome !== null) {
    if (isPathInside(roots.dshHome, controlDir, platform)) {
      return refuse(TRAY_ICON_CODES.TARGET_INSIDE_DSH_HOME,
        `生成物会落进真实 operator 的 DSH 家目录里（${roots.dshHome}）：${controlDir}。`
        + '那是**另一个程序**拥有的目录：它的 clean/upgrade 会把整棵树换掉，'
        + '而我们会以为托盘还在那儿', { controlDir })
    }
    readOnly.push(roots.dshHome)
  }
  if (roots.operatorHome !== null) {
    // `~/.dsh` 是 DSH 在没有设 DSH_HOME 时的默认家目录。它不由 DSH_HOME 表达，
    // 所以必须单独判：只判 DSH_HOME 会在"用户没设那个变量"的机器上全绿。
    const defaultDshHome = win.join(roots.operatorHome, '.dsh')
    if (isPathInside(defaultDshHome, controlDir, platform)) {
      return refuse(TRAY_ICON_CODES.TARGET_INSIDE_DSH_HOME,
        `生成物会落进 DSH 的默认家目录里（${defaultDshHome}）：${controlDir}。`
        + '即使这次没有设 DSH_HOME，那也仍然是 DSH 的地盘', { controlDir })
    }
    readOnly.push(defaultDshHome)
  }
  if (roots.installDir !== null) {
    if (isPathInside(roots.installDir, controlDir, platform)) {
      return refuse(TRAY_ICON_CODES.TARGET_INSIDE_INSTALL_DIR,
        `生成物会落进安装目录里（${roots.installDir}）：${controlDir}。`
        + '安装目录是"升级时被整体替换"的只读面，托盘脚本会跟着一起消失', { controlDir })
    }
    readOnly.push(roots.installDir)
  }
  if (roots.allowedRoot === null) {
    return refuse(TRAY_ICON_CODES.TARGET_OUTSIDE_ALLOWED_ROOT,
      '没有给出允许根（allowedRoot），无法判定这次写入的边界。**按越界处理**：'
      + '一个"没有边界所以不检查边界"的写盘与一个没有边界的写盘是同一个东西',
      { controlDir })
  }
  if (!(samePath(roots.allowedRoot, controlDir, platform) || isPathInside(roots.allowedRoot, controlDir, platform))) {
    return refuse(TRAY_ICON_CODES.TARGET_OUTSIDE_ALLOWED_ROOT,
      `生成物会落到允许根之外：${controlDir} 不在 ${roots.allowedRoot} 内`, { controlDir })
  }
  if (!(samePath(roots.dataDir, controlDir, platform) || isPathInside(roots.dataDir, controlDir, platform))) {
    return refuse(TRAY_ICON_CODES.TARGET_OUTSIDE_ALLOWED_ROOT,
      `生成物的落点与 DataDir 不一致：${controlDir} 不在 ${roots.dataDir} 内`, { controlDir })
  }

  return Object.freeze({
    version: TRAY_ICON_VERSION,
    ok: true,
    stage: 'planned',
    code: null,
    message: `托盘宿主的生成物落在 ${controlDir}`,
    diagnostics: Object.freeze([]),
    dataDir: roots.dataDir,
    allowedRoot: roots.allowedRoot,
    /** 允许写入的根：**只有它**。 */
    writableRoot: controlDir,
    controlDir,
    readOnlyRoots: Object.freeze(readOnly),
    scriptPath,
    menuPath,
    stopPath,
  })
}

/**
 * 一次写入可不可以。——**纯**函数，`createTrayIconHost` 每次写盘前都问它一次。
 *
 * 为什么计划里判过了还要逐次再判：计划判的是"这一次运行的落点"，而写入是
 * 三次独立的动作（脚本、菜单、哨兵），路径由拼接得来。只在计划里判一次，
 * 等于把"路径拼接没有出错"变成一个假设——而 `..` 与符号链接都能让这个假设落空。
 *
 * ★ 判据形状与 `runtime-install.mjs` 的 `createRuntimeWriteGuard` **刻意一致**
 * （同三态、同内外都判、同"只读优先"的顺序）。没有 import 它，是因为那个模块
 * 连同 `satisfiesRange` 与 npm 运行器把整条安装依赖拖进托盘进程。代价是两处判断
 * 可能漂移——所以用例里有一条拿**真** `createRuntimeWriteGuard()` 逐格对拍。
 *
 * @returns {{ok: boolean, code: string|null, path: string|null, message: string|null}}
 */
export function planTrayWrite({ plan = null, path = null, platform = process.platform } = {}) {
  const deny = (message) => Object.freeze({
    ok: false, code: TRAY_ICON_CODES.WRITE_REFUSED, path: null, message,
  })
  if (plan === null || typeof plan !== 'object' || plan.ok !== true) {
    return deny('没有一份可通过的写入计划：不知道允许写到哪')
  }
  if (nonEmpty(path) === null) return deny('路径是空的，无法判定边界')
  const p = normalizePath(path, platform)
  // 顺序：先判只读（更具体的禁令），再判允许根。反过来会把"写进安装目录"
  // 报成一句泛泛的"越出允许根"。
  for (const r of plan.readOnlyRoots ?? []) {
    if (samePath(p, r, platform) || isPathInside(r, p, platform)) {
      return deny(`它落在只读根之内（${r}）：安装目录与 DSH 家目录一律只读`)
    }
  }
  const writable = plan.writableRoot
  if (!(samePath(p, writable, platform) || isPathInside(writable, p, platform))) {
    return deny(`它越出了允许写入的根（${writable}）`)
  }
  return Object.freeze({ ok: true, code: null, path: p, message: null })
}

// ---------------------------------------------------------------------------
// ⑤ 效果：起一个真的宿主、喂它菜单、收它的点击、把它收干净
// ---------------------------------------------------------------------------

/** 一个"接不上的宿主"：每次调用都给同一个具名拒绝，而不是一个假装能用的替身。 */
function notAHost({ code, message, plan = null, shell = null }) {
  const refusal = Object.freeze({ ok: false, code, message })
  const reject = async () => refusal
  return Object.freeze({
    ok: false,
    code,
    message,
    plan,
    shell,
    script: null,
    scriptPath: plan?.scriptPath ?? null,
    menuPath: plan?.menuPath ?? null,
    stopPath: plan?.stopPath ?? null,
    hostId: null,
    start: reject,
    stop: reject,
    whenIdle: async () => refusal,
    publishMenu: reject,
    status: () => Object.freeze({ ok: false, code, message, started: false, alive: false, ready: false }),
    diagnostics: () => Object.freeze([]),
  })
}

/**
 * 起一个真的托盘图标宿主，并把它看住。
 *
 * 生命周期（选择与理由见文件头纪律三）：宿主是 launcher 的**子进程**，
 *
 *   · 正常收工：`stop()` 写哨兵 → 宿主 Dispose + 退出 → 本模块核对它**自报了** `disposed`；
 *   · launcher 被杀：宿主自己查父进程 pid，不在就 Dispose + 退出（不留孤儿图标）；
 *   · 宿主先死：本模块报 `HOST_UNHEALTHY`，`start()` 可以再来一次（留下回去的路）。
 *
 * @param {object} deps
 * @param {object} deps.tray 需要 `menu()` 与 `invoke(id)`（就是 `tray.mjs` 的 `createTray()`）
 * @param {string} deps.dataDir 生成物落点（见 `planTrayIcon`）
 * @param {string} deps.allowedRoot 允许写入的根（缺了就是拒绝）
 * @param {string} [deps.platform] 默认 `process.platform`
 * @param {object} [deps.env] 默认 `process.env`（解析 shell 用）
 * @param {Function} [deps.exists] 默认 `defaultFileExists`（用例注入替身）
 * @param {string|null} [deps.configuredShell] 显式指定的 shell
 * @param {Function} [deps.spawnImpl] 默认 `node:child_process` 的 `spawn`
 * @param {Function} [deps.writeFileImpl] 默认 `node:fs` 的 `writeFileSync`
 * @param {Function} [deps.removeImpl] 默认 `node:fs` 的 `rmSync`
 * @param {Function} [deps.mkdirImpl] 默认 `node:fs` 的 `mkdirSync`
 * @param {Function} [deps.now]
 * @param {Function|null} [deps.logger]
 * @param {number} [deps.tickMs]
 * @param {number} [deps.heartbeatMs]
 * @param {number} [deps.readyTimeoutMs]
 * @param {number} [deps.stopTimeoutMs]
 * @param {number} [deps.killGraceMs]
 * @param {number} [deps.parentPid] 宿主该看住的父进程 pid（默认为本进程）
 * @param {Function} [deps.setTimeoutImpl] / [deps.clearTimeoutImpl] 用例注入假时钟
 */
export function createTrayIconHost({
  tray = null,
  dataDir = null,
  allowedRoot = null,
  installDir = null,
  dshHome = null,
  operatorHome = null,
  platform = process.platform,
  env = process.env,
  exists = defaultFileExists,
  /**
   * "这个文件在吗"。与 `exists` **分开**：`exists` 判的是 shell 候选，
   * 用例会注入一个假的存在性表；而哨兵文件是**真实磁盘**上的东西，
   * 两者用同一个口子会让"shell 解析"的替身顺手把哨兵也一起说成存在。
   */
  fileExists = exists,
  configuredShell = null,
  spawnImpl = spawn,
  writeFileImpl = writeFileSync,
  removeImpl = rmSync,
  mkdirImpl = mkdirSync,
  now = () => Date.now(),
  logger = null,
  tickMs = TRAY_ICON_DEFAULT_TICK_MS,
  heartbeatMs = TRAY_ICON_DEFAULT_HEARTBEAT_MS,
  readyTimeoutMs = TRAY_ICON_DEFAULT_READY_TIMEOUT_MS,
  stopTimeoutMs = TRAY_ICON_DEFAULT_STOP_TIMEOUT_MS,
  killGraceMs = TRAY_ICON_DEFAULT_KILL_GRACE_MS,
  parentPid = process.pid,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  randomToken = defaultHostId,
} = {}) {
  // ★ 平台是**最粗**的那一条判据，所以先判它：在一个连 WinForms 都没有的平台上，
  //   先报一句"DataDir 不是绝对路径"会把用户支到错的地方去修——
  //   他会去修一个根本不影响结论的东西。
  if (platform !== 'win32') {
    return notAHost({
      code: TRAY_ICON_CODES.UNSUPPORTED_PLATFORM,
      message: `托盘图标宿主要在 Windows 上加载 WinForms（NotifyIcon），当前平台是 ${platform}：`
        + '这里不生成一个"起了就死"的脚本，也不假装菜单被画到了某个托盘上',
      plan: null,
    })
  }
  const plan = planTrayIcon({ dataDir, allowedRoot, installDir, dshHome, operatorHome, platform })
  if (plan.ok !== true) {
    return notAHost({ code: plan.code, message: plan.message, plan: null })
  }
  const shell = resolveTrayShell({ platform, env, configured: configuredShell, exists })
  if (shell.ok !== true) {
    return notAHost({ code: shell.code, message: shell.message, plan, shell: null })
  }
  if (tray === null || typeof tray !== 'object'
    || typeof tray.menu !== 'function' || typeof tray.invoke !== 'function') {
    return notAHost({
      code: TRAY_ICON_CODES.MENU_UNAVAILABLE,
      message: '图标宿主需要一个同时提供 menu() 与 invoke(id) 的托盘（`tray.mjs` 的 createTray()）',
      plan,
      shell: shell.path,
    })
  }

  const diagnostics = []
  const history = []
  const hostId = String(randomToken())
  const script = renderTrayScript({
    menuPath: plan.menuPath,
    stopPath: plan.stopPath,
    hostId,
    parentPid,
    tickMs,
    heartbeatMs,
  })

  const state = {
    phase: 'idle',      // idle | starting | ready | stopping | stopped | gone
    child: null,
    pid: null,
    exitCode: null,
    ready: false,
    exitedLine: null,
    lastHeartbeatAt: null,
    stderr: '',
    buffer: '',
    menuIds: new Set(),
    menuWrites: 0,
    startedAt: null,
    actionBusy: false,
    stopping: false,
    killed: false,
    everStarted: false,
    lastFailure: null,
  }
  let actionChain = Promise.resolve()

  function note(severity, code, message) {
    const d = Object.freeze({ severity, code, message, at: now() })
    diagnostics.push(d)
    if (typeof logger === 'function') logger(`[tray-icon] ${message}`)
    return d
  }

  const refuse = (code, message, fields = {}) => {
    note(code === TRAY_ICON_CODES.NOT_STARTED ? 'info' : 'error', code, message)
    state.lastFailure = Object.freeze({ code, message, at: now() })
    return Object.freeze({ ok: false, code, message, hostId, ...fields })
  }

  /** 每次写盘都过这一道。**不**用它等于把计划的判据变成一句注释。 */
  function guardedWrite(path, text, { bom = false } = {}) {
    const verdict = planTrayWrite({ plan, path, platform })
    if (verdict.ok !== true) {
      const err = new Error(verdict.message)
      err.code = TRAY_ICON_CODES.WRITE_REFUSED
      err.path = path
      throw err
    }
    writeFileImpl(path, bom ? '\uFEFF' + text : text, 'utf8')
    return verdict.path
  }

  function guardedRemove(path) {
    const verdict = planTrayWrite({ plan, path, platform })
    if (verdict.ok !== true) {
      const err = new Error(verdict.message)
      err.code = TRAY_ICON_CODES.WRITE_REFUSED
      err.path = path
      throw err
    }
    removeImpl(path, { force: true })
  }

  /** 从一次 `tray.menu()` 读数里取菜单文档。**菜单只此一个来源。** */
  async function readModel() {
    let m = null
    try {
      m = await tray.menu()
    } catch (e) {
      return Object.freeze({
        ok: false,
        code: TRAY_ICON_CODES.MENU_UNAVAILABLE,
        message: `读菜单模型时抛错：${String(e?.message ?? e)}`,
        doc: null,
      })
    }
    if (m === null || typeof m !== 'object' || !Array.isArray(m.items)) {
      return Object.freeze({
        ok: false,
        code: TRAY_ICON_CODES.MENU_UNAVAILABLE,
        message: 'tray.menu() 没有给出 items 数组',
        doc: null,
      })
    }
    const built = buildTrayMenuDocument({ items: m.items, hostId, appName: 'Legion' })
    if (built.ok !== true) {
      return Object.freeze({ ok: false, code: built.code, message: built.message, doc: null })
    }
    return Object.freeze({ ok: true, code: null, message: built.message, doc: built.document })
  }

  /** 把一份菜单文档发布给宿主（原地覆盖）。失败**不清空**：旧菜单比空菜单好。 */
  async function publishMenu() {
    const m = await readModel()
    if (m.ok !== true) {
      note('warn', TRAY_ICON_CODES.MENU_REPUBLISH_FAILED, `${m.message}（保留上一份菜单）`)
      return Object.freeze({ ok: false, code: m.code, message: m.message })
    }
    try {
      guardedWrite(plan.menuPath, JSON.stringify(m.doc))
    } catch (e) {
      note('error', e?.code ?? TRAY_ICON_CODES.WRITE_REFUSED, `写菜单失败：${String(e?.message ?? e)}`)
      return Object.freeze({ ok: false, code: e?.code ?? TRAY_ICON_CODES.WRITE_REFUSED, message: String(e?.message ?? e) })
    }
    state.menuIds = new Set(m.doc.items.map((i) => i.id))
    state.menuWrites += 1
    return Object.freeze({ ok: true, code: null, message: m.message, items: m.doc.items })
  }

  // ── 子进程读数 ─────────────────────────────────────────────────────────

  function onLine(line) {
    const parsed = parseTrayHostLine(line)
    if (parsed.ok !== true) {
      note('warn', parsed.code, `丢掉一行读不懂的宿主输出：${parsed.message}`)
      return
    }
    if (parsed.version !== TRAY_ICON_HOST_PROTOCOL_VERSION) {
      note('warn', TRAY_ICON_CODES.UNKNOWN_MESSAGE,
        `丢掉一行协议版本对不上的输出（收到 v${parsed.version}，本模块认 v${TRAY_ICON_HOST_PROTOCOL_VERSION}）：${line}`)
      return
    }
    if (parsed.hostId !== hostId) {
      note('warn', TRAY_ICON_CODES.UNKNOWN_MESSAGE,
        `丢掉一行 hostId 对不上的输出（那次运行不是本次起的宿主）：${line}`)
      return
    }
    switch (parsed.kind) {
      case 'ready':
        state.ready = true
        state.phase = 'ready'
        if (Number.isInteger(parsed.fields.pid) && state.pid !== null && parsed.fields.pid !== state.pid) {
          // hostId 已经是强绑定，pid 不一致只当读数记一笔：它多半意味着 shell 外面还包了一层，
          // 而那种机器上"拒绝 ready"会把一个**真的画出来的**图标说成不支持。
          note('warn', TRAY_ICON_CODES.UNKNOWN_MESSAGE,
            `宿主自报的 pid（${parsed.fields.pid}）与我们起的那个（${state.pid}）不一致；仍按 ready 处理`)
        }
        note('info', TRAY_ICON_CODES.HOST_READY, `图标宿主已就绪（pid ${parsed.fields.pid ?? state.pid ?? '未知'}）`)
        return
      case 'heartbeat':
        state.lastHeartbeatAt = now()
        return
      case 'menu-error':
        note('warn', TRAY_ICON_CODES.MENU_MALFORMED,
          `宿主说它读不懂刚发布的菜单（下一拍会重试；旧菜单还在）：${parsed.fields.message ?? ''}`)
        return
      case 'error':
        note('error', TRAY_ICON_CODES.HOST_FAILED,
          `宿主报错（阶段 ${parsed.fields.phase ?? '未知'}）：${parsed.fields.message ?? ''}`)
        return
      case 'exited':
        state.exitedLine = Object.freeze({
          reason: parsed.fields.reason ?? 'unknown',
          disposed: parsed.fields.disposed === true,
        })
        return
      case 'click':
        queueClick(parsed.id)
        return
      default:
        // `stopped` 之类的信息行：记一笔就够，不改变任何判据。
        note('info', TRAY_ICON_CODES.EXITED, `宿主的 ${parsed.kind} 行`)
        return
    }
  }

  function attachChild(child) {
    state.child = child
    state.pid = Number.isInteger(child?.pid) ? child.pid : null
    if (child?.stdout !== undefined && child.stdout !== null) {
      if (typeof child.stdout.setEncoding === 'function') child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        state.buffer += String(chunk)
        for (;;) {
          const i = state.buffer.indexOf('\n')
          if (i < 0) break
          // 去掉行尾的 CR：PowerShell 的 WriteLine 在 Windows 上写的是 CRLF，
          // 留着的 CR 会一路走进诊断文案与 JSON 解析（`JSON.parse` 容忍它，人读不忍）。
          const line = state.buffer.slice(0, i).replace(/\r$/, '')
          state.buffer = state.buffer.slice(i + 1)
          onLine(line)
        }
      })
    }
    if (child?.stderr !== undefined && child.stderr !== null) {
      if (typeof child.stderr.setEncoding === 'function') child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => { state.stderr += String(chunk) })
    }
    const gone = (code) => {
      if (state.exitCode !== null) return
      state.exitCode = code === undefined ? null : code
      // 排在管道里的最后一行可能晚于 exit 到达；close 之后把残留刷一遍。
      if (state.buffer.trim() !== '') {
        const rest = state.buffer
        state.buffer = ''
        onLine(rest)
      }
      if (state.phase !== 'stopping' && state.phase !== 'stopped') {
        state.phase = 'gone'
        note('error', TRAY_ICON_CODES.HOST_UNHEALTHY,
          `图标宿主自己退出了（退出码 ${state.exitCode === null ? '未知' : state.exitCode}），`
          + '而产品还在跑：图标没了，用户看不到它。start() 可以再来一次')
      }
    }
    if (typeof child?.once === 'function') {
      child.once('close', (code) => gone(code))
      child.once('exit', (code) => {
        // 真 ChildProcess 一定还会发 close；只发 exit 的实现（用例替身）在这里收口。
        gone(code)
      })
      child.once('error', (e) => {
        state.stderr += `\n spawn error: ${String(e?.message ?? e)}`
        note('error', TRAY_ICON_CODES.SPAWN_FAILED, `宿主进程报错：${String(e?.message ?? e)}`)
        gone(null)
      })
    }
  }

  const alive = () => state.child !== null && state.exitCode === null

  function killChild() {
    try {
      if (alive() && typeof state.child.kill === 'function') {
        state.killed = true
        state.child.kill()
      }
    } catch (e) {
      note('warn', TRAY_ICON_CODES.SHUTDOWN_TIMEOUT, `杀宿主时抛错：${String(e?.message ?? e)}`)
    }
  }

  /** 等一个谓词成立；超时返回 `false`（**超时不等于成功**）。 */
  function waitUntil(predicate, timeoutMs) {
    return new Promise((resolve) => {
      const started = now()
      const check = () => {
        if (predicate() === true) { resolve(true); return }
        if (now() - started >= timeoutMs) { resolve(false); return }
        setTimeoutImpl(check, Math.min(50, Math.max(5, Math.floor(timeoutMs / 20))))
      }
      check()
    })
  }

  // ── 点击 → 派发 ────────────────────────────────────────────────────────

  function queueClick(id) {
    // ★ 只认**当前模型里**存在的 id。宿主是不可信输入：一个上一版的脚本、
    //   或者一个被替换过的菜单文件，都能送来一个模型里没有的动作。
    if (!state.menuIds.has(id)) {
      note('warn', TRAY_ICON_CODES.UNKNOWN_ACTION,
        `丢掉一个模型里不存在的点击：${id}（当前菜单只有 ${[...state.menuIds].join(' / ') || '（空）'}）`)
      return
    }
    if (state.actionBusy === true) {
      // 不排队：一个排队的「停止」会在「启动」之后才执行，而用户看到的是
      // 最终状态与他的操作相反（与 `tray.mjs` 同一条纪律）。
      note('warn', TRAY_ICON_CODES.BUSY, `上一个动作还没结束，丢掉这次点击：${id}`)
      return
    }
    // ★ 忙碌标记在**入队时**就置上，不在处理时置：两行点击可能落在同一个 stdout 分片里，
    //   那时第二次点击还没"跑到"，按处理时的标记判会让它排进队列——而队列正是上面
    //   那条纪律要避免的东西。
    state.actionBusy = true
    actionChain = actionChain
      .then(() => handleClick(id))
      .catch((e) => {
        note('error', TRAY_ICON_CODES.UNEXPECTED, `处理点击 ${id} 时抛出：${String(e?.message ?? e)}`)
      })
      .finally(() => { state.actionBusy = false })
  }

  async function handleClick(id) {
    let r = null
    try {
      r = await tray.invoke(id)
    } catch (e) {
      r = { ok: false, code: TRAY_ICON_CODES.UNEXPECTED, message: String(e?.message ?? e) }
    }
    history.push(Object.freeze({ id, ok: r?.ok === true, code: r?.code ?? null, at: now() }))
    note(r?.ok === true ? 'info' : 'warn', r?.code ?? TRAY_ICON_CODES.EXITED,
      `点击「${id}」→ ${r?.message ?? '（没有给出结论）'}`)
    // ★ 动作之后**按模型重写菜单**：可用性来自观测，来自每一次动作之后的新观测。
    await publishMenu()
    // ★★ 只有 quit **确认了**产品真的停下来（`unavailable`）才让图标跟着走。
    //    没确认时图标留着——用户还能再点一次（"藏图标"与"退不出去"是两回事）。
    if (id === 'quit' && r?.ok === true && r?.exited === true) {
      note('info', TRAY_ICON_CODES.EXITED, 'quit 已确认产品停了：收掉图标宿主')
      await stop('quit-confirmed')
    }
    return r
  }

  // ── start / stop ───────────────────────────────────────────────────────

  async function start() {
    if (state.phase === 'starting' || state.phase === 'ready' || state.phase === 'stopping') {
      return refuse(TRAY_ICON_CODES.ALREADY_STARTED, `宿主已经在跑了（阶段 ${state.phase}）`)
    }
    // ① 菜单来自模型。拿不到就**不起宿主**：一个没有菜单的图标用户点不了。
    const m = await readModel()
    if (m.ok !== true) return refuse(m.code, m.message)
    state.menuIds = new Set(m.doc.items.map((i) => i.id))

    // ② 先把上一次留下的哨兵清掉：不清的话，新宿主会在第一拍就自己退出。
    try {
      if (fileExists(plan.stopPath) === true) guardedRemove(plan.stopPath)
    } catch (e) {
      note('warn', TRAY_ICON_CODES.WRITE_REFUSED, `清上一次的停止哨兵失败：${String(e?.message ?? e)}`)
    }

    // ③ 写生成物。**先写脚本再写菜单**：脚本先落地、菜单后落地时，脚本可能
    //    在第一拍读到一个还不存在的菜单文件——那会让宿主直接报错退出。
    try {
      mkdirImpl(plan.controlDir, { recursive: true })
      guardedWrite(plan.scriptPath, script, { bom: true })
      guardedWrite(plan.menuPath, JSON.stringify(m.doc))
      state.menuWrites += 1
    } catch (e) {
      return refuse(e?.code ?? TRAY_ICON_CODES.WRITE_REFUSED, `写生成物失败：${String(e?.message ?? e)}`)
    }

    // ④ 起宿主。`-ExecutionPolicy Bypass` 是**进程级**的：默认客户端策略会拦下任何 .ps1，
    //    而这条命令行不改变这台机器的任何设置（它是我们自己写在 DataDir 里的脚本）。
    state.phase = 'starting'
    state.ready = false
    state.everStarted = true
    state.exitedLine = null
    state.exitCode = null
    state.stderr = ''
    state.buffer = ''
    state.startedAt = now()
    let child = null
    try {
      child = spawnImpl(shell.path, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', plan.scriptPath,
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      state.phase = 'idle'
      return refuse(TRAY_ICON_CODES.SPAWN_FAILED, `起宿主失败：${String(e?.message ?? e)}`)
    }
    if (child === null || child === undefined) {
      state.phase = 'idle'
      return refuse(TRAY_ICON_CODES.SPAWN_FAILED, `${shell.path} 没有返回可判读的子进程句柄`)
    }
    attachChild(child)

    // ⑤ 等 ready。**只有 ready 算数**：进程起来了不等于图标画出来了。
    const ok = await waitUntil(() => state.ready === true || (state.exitCode !== null && state.phase !== 'ready'), readyTimeoutMs)
    if (state.ready === true) {
      return Object.freeze({
        ok: true, code: TRAY_ICON_CODES.HOST_READY, hostId,
        message: `图标宿主已就绪（pid ${state.pid ?? '未知'}，shell ${shell.path}）`,
        pid: state.pid, shell: shell.path, items: m.doc.items,
      })
    }
    if (ok !== true && state.ready !== true && alive()) {
      killChild()
      state.phase = 'stopped'
      return refuse(TRAY_ICON_CODES.HOST_NOT_READY,
        `等了 ${readyTimeoutMs}ms 也没等到 ready（进程还在，说明它卡在启动里；已杀掉）。`
        + `stderr：${state.stderr.trim() || '（空）'}`,
        { pid: state.pid, shell: shell.path })
    }
    state.phase = 'gone'
    return refuse(TRAY_ICON_CODES.HOST_EXITED_BEFORE_READY,
      `宿主在报 ready 之前就没了（退出码 ${state.exitCode === null ? '未知' : state.exitCode}）：`
      + '脚本被执行策略/AppLocker 拦下、WinForms 加载失败、或者这台机器没有交互桌面'
      + `。stderr：${state.stderr.trim() || '（空）'}`,
      { pid: state.pid, exitCode: state.exitCode, shell: shell.path })
  }

  /**
   * 收掉图标宿主。**幂等**，并且是本模块唯一会让图标离开屏幕的路。
   *
   * ★ 它**不**排在那条点击动作队列后面（`whenIdle()` 才是给想等的调用方用的）：
   *   监管者要收工时，一个卡住的点击动作不该把"收掉图标"这件事一起卡住——
   *   "因为有个动作卡着所以图标收不掉"与"没有收工路径"在用户那里是同一个东西。
   *   两者的并发是安全的：哨兵只有这里写、菜单文件写到一半时宿主保留旧菜单，
   *   而那之后再来一次 `stop()` 会因为阶段已是 `stopped` 直接幂等返回。
   *
   * 返回 `ok:false` 时**不要**当成"已经收干净了"：`SHUTDOWN_TIMEOUT` /
   * `SHUTDOWN_UNCLEAN` 说的正是"没有证据说图标被 Dispose 了"。
   */
  async function stop(reason = 'supervisor-stop') {
    if (state.phase === 'idle' || state.phase === 'stopped' || state.phase === 'gone') {
      return Object.freeze({
        ok: true, code: TRAY_ICON_CODES.NOT_STARTED, hostId,
        message: `宿主没有在跑（阶段 ${state.phase}），停止是幂等的`, stopped: false,
      })
    }
    state.stopping = true
    state.phase = 'stopping'
    const startedAt = now()
    try {
      if (alive()) guardedWrite(plan.stopPath, String(reason))
    } catch (e) {
      note('error', e?.code ?? TRAY_ICON_CODES.WRITE_REFUSED, `写停止哨兵失败：${String(e?.message ?? e)}`)
    }
    // 等**宿主自己报 exited**，而不是等"进程没了"：
    // 进程没了只说明它走了，没说明它把图标拆了。
    let sawExitLine = await waitUntil(() => state.exitedLine !== null || !alive(), stopTimeoutMs)
    if (state.exitedLine === null && alive()) {
      killChild()
      await waitUntil(() => !alive(), killGraceMs)
      sawExitLine = false
    }
    // 反过来也成立：它**说**自己退出去了，也要看到它真的走了。
    // 一个自报"已 Dispose"却留在进程表里的宿主，下一次启动会与新的宿主抢同一个托盘。
    if (sawExitLine === true && state.exitedLine !== null && alive()) {
      await waitUntil(() => !alive(), killGraceMs)
      if (alive()) killChild()
    }
    const gone = !alive()
    state.phase = 'stopped'
    const elapsedMs = now() - startedAt
    try { if (fileExists(plan.stopPath) === true) guardedRemove(plan.stopPath) } catch { /* 清不掉不影响结论 */ }

    if (sawExitLine !== true || state.exitedLine === null) {
      note('error', TRAY_ICON_CODES.SHUTDOWN_TIMEOUT,
        `写了停止哨兵但宿主没有自报 exited（${elapsedMs}ms）${state.killed ? '，已强杀' : ''}`)
      return Object.freeze({
        ok: false, code: TRAY_ICON_CODES.SHUTDOWN_TIMEOUT, hostId,
        message: `写了停止哨兵，但宿主**没有自报 exited**（${elapsedMs}ms）`
          + `${state.killed ? '，已强杀' : ''}。**不把它说成干净退出**：`
          + '没有那行 exited 就没有证据说图标已经 Dispose（幽灵图标正是这么来的）',
        disposed: false, killed: state.killed, gone, exitCode: state.exitCode, elapsedMs,
      })
    }
    if (state.exitedLine.disposed !== true) {
      note('error', TRAY_ICON_CODES.SHUTDOWN_UNCLEAN,
        `宿主退出了（reason=${state.exitedLine.reason}）但自报 disposed=false`)
      return Object.freeze({
        ok: false, code: TRAY_ICON_CODES.SHUTDOWN_UNCLEAN, hostId,
        message: `宿主退出了（reason=${state.exitedLine.reason}）但它自报 disposed=false：`
          + '图标可能还留在托盘里（幽灵图标）。**不把它说成干净退出**',
        disposed: false, reason: state.exitedLine.reason, exitCode: state.exitCode, elapsedMs, gone,
      })
    }
    if (gone !== true) {
      note('error', TRAY_ICON_CODES.SHUTDOWN_TIMEOUT,
        `宿主自报 disposed=true，但进程 ${killGraceMs}ms 后仍在（已强杀）`)
      return Object.freeze({
        ok: false, code: TRAY_ICON_CODES.SHUTDOWN_TIMEOUT, hostId,
        message: `宿主自报 disposed=true，但进程过了 ${killGraceMs}ms 还在（已强杀）。`
          + '图标本身拆掉了，但**留下一个活的宿主进程**：它下一次会与新的宿主抢同一个托盘位置。'
          + '**不把它说成干净退出**',
        disposed: true, killed: state.killed, gone: false, exitCode: state.exitCode, elapsedMs,
      })
    }
    return Object.freeze({
      ok: true, code: TRAY_ICON_CODES.EXITED, hostId,
      message: `宿主已 Dispose 图标并退出（reason=${state.exitedLine.reason}，退出码 ${state.exitCode}，${elapsedMs}ms）`,
      disposed: true, reason: state.exitedLine.reason, exitCode: state.exitCode, elapsedMs, gone,
      clicks: Object.freeze([...history]),
    })
  }

  function status() {
    const lastHeartbeatAt = state.lastHeartbeatAt
    const stale = lastHeartbeatAt !== null && alive() && now() - lastHeartbeatAt > heartbeatMs * 3
    return Object.freeze({
      ok: true,
      code: state.ready ? TRAY_ICON_CODES.HOST_READY : TRAY_ICON_CODES.HOST_PENDING,
      hostId,
      phase: state.phase,
      started: state.phase === 'starting' || state.phase === 'ready',
      /** ★ "**曾经**起过"与"现在在跑"是两件事：前者才是"支持与否"那条判据要的读数。 */
      everStarted: state.everStarted,
      ready: state.ready,
      alive: alive(),
      /** 进程还在但心跳停了：图标还在屏幕上，点了不会有反应。**只报，不自动杀**。 */
      unhealthy: stale,
      pid: state.pid,
      exitCode: state.exitCode,
      shell: shell.path,
      shellKind: shell.kind,
      controlDir: plan.controlDir,
      scriptPath: plan.scriptPath,
      menuPath: plan.menuPath,
      stopPath: plan.stopPath,
      menuWrites: state.menuWrites,
      menuIds: Object.freeze([...state.menuIds]),
      lastHeartbeatAt,
      lastExited: state.exitedLine,
      lastFailure: state.lastFailure,
      clicks: Object.freeze([...history]),
      actionBusy: state.actionBusy,
      killed: state.killed,
      stderr: state.stderr.trim(),
    })
  }

  return Object.freeze({
    ok: true,
    code: null,
    message: `图标宿主已装配（shell ${shell.kind}：${shell.path}）；start() 之前没有画任何图标`,
    plan,
    shell: shell.path,
    shellKind: shell.kind,
    script,
    scriptPath: plan.scriptPath,
    menuPath: plan.menuPath,
    stopPath: plan.stopPath,
    hostId,
    start,
    stop,
    /** 等当前那次点击处理完（测试与"退出前排空"的调用方用；`stop()` 自己**不**等它，见注释）。 */
    whenIdle: () => actionChain,
    publishMenu,
    status,
    diagnostics: () => Object.freeze([...diagnostics]),
  })
}

/** 一个够用的 hostId：不需要密码学强度，只要两次运行不会撞上。 */
function defaultHostId() {
  return `h${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffff).toString(36)}`
}
