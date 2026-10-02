// product/launcher/runtime-resolve.mjs
// ============================================================================
// PRT-257：**装完之后的下一跳** —— 让 Launcher 真的用上它自己装的那个运行时。
//
// ## 这一截为什么必须单独存在
//
// `runtime-install.mjs` 已经把 DSH 装进 `<DataDir>/runtime/dsh/versions/<版本>/`，
// 并且把"现役是哪一版"写进了 `current.json`。而在此之前，**没有任何生产代码
// 读过那个指针来拼启动命令**：`product/launcher/cli.mjs` 的 `runtime.command`
// 只认命令行参数与产品配置，`materializeProcessPlan` 拿不到值就报
// `ENTRY_UNRESOLVED`。
//
//   > 一个"装得上、并且会把现役版本记在指针里"的产品，
//   > 与一个"装完还是得让人手工把路径抄进配置"的产品，
//   > 在用户手上是同一个东西——只不过前者的磁盘上真的躺着那 191 个包。
//
// 这正是本任务书点名的那一类缺陷：**两个各自都绿了的半边，从来没有接上过。**
// 安装器那一半有 44 条用例，Launcher 那一半有 100+ 条，而"装完谁去用它"
// 这一句在两个文件里**一次都没有出现过**。
//
// ## 命令的形状：`entry` 一个参数是**不够**的
//
// 实测（真的从 npm 装了一份 DSH 之后跑的）：
//
// ```
//   node <runtime>/node_modules/@deepseek-ai/dsh/lib/bin.js
//     → exit 1，stderr: error: --profile <name> is required
//   node <…>/lib/bin.js --profile web --dump-config
//     → exit 0，组合树打出来了
// ```
//
// 所以"从指针里解析出入口"这件事，**最危险的失败形态不是报错，而是成功**：
// 拼出一条 `node <entry>` 看起来完全正常（那确实是刚装好的 DSH 入口，
// 路径也是对的），它会在 DSH 自己的参数解析里退出 1，而 stderr 上那句
// "profile is required"读起来像"DSH 坏了"或"装错了版本"。
//
//   > 一条"少了必需的参数、但每个字都对"的命令行，
//   > 与一条"版本装错了"的命令行，在 `entryExists===true` 这个读数上
//   > 是同一个东西——只不过前者的修法在调用方，后者的修法在安装器。
//
// 于是本模块**没有**一个"profile 缺省就省掉那一段"的分支：`profile` 为空串 /
// 非字符串时是**具名拒绝** `PROFILE_REQUIRED`，不是一条看起来能跑的短命令。
//
// ## 只读，且零副作用
//
// 它不写任何东西、不起任何进程、不创建目录。它做的是**一次读数**：
// `readActiveRuntime()`（`runtime-install.mjs`）给出 pointers/标记/入口的
// 四态，本模块只负责把那四态翻成"能不能拼出一条命令、拼成什么、拼不成时说清为什么"。
//
// ## 与 `runtime.command` 的优先级：显式配置赢
//
// `product/config.mjs` 把 `runtime.command` 的文档写成「PRT-011 路线 C：
// Launcher 把 npm 包装进 DataDir 后**由这里指定**」。那句文档现在仍然成立，
// 但它的位置变了：**由这里指定**是"用户显式指定"，而**没有指定时**，
// 现役指针就是权威来源（它是产品自己写的那一份）。
//
//   · 命令行 `--runtime-command` / 配置 `runtime.command` → **赢**，并且
//     当磁盘上确实装着一个现役运行时时留一条 warn（不然"装好的那个"
//     会安静地变成死重量，而没有任何读数说它没被用上）；
//   · 都没有 → 用现役指针；
//   · 指针不在 → 与今天一样（计划里报 `ENTRY_UNRESOLVED`）；
//   · 指针在但读不懂 / 不完整 / 与入口对不上 → **阻塞**（spec §9.1
//     「不带病运行」）。
// ============================================================================

import { readFileSync } from 'node:fs'

import { samePath } from '../paths.mjs'
import {
  DEFAULT_DSH_PACKAGE,
  DEFAULT_ENTRY_RELPATH,
  readActiveRuntime,
} from './runtime-install.mjs'

/** 本模块的版本。落进诊断，便于把一次启动与一份实现对上。 */
export const RUNTIME_RESOLVE_VERSION = 1

/**
 * 产品启动 DSH 时用的 profile 名。
 *
 * **不是本模块发明的**：`dsh-overlay.mjs:224` 写着生产路径的
 * `runtime.command` 里的模式就是 `web`（"`web` 是 `runtime.command` 里的模式"），
 * 而 `web` 是 DSH 自己随发行版带的 profile（`apps/cli/src/args.ts` 里
 * `dsh web` 是 `--profile web` 的硬编码别名）。实测一个真的装好的 DSH：
 *
 * ```
 *   node <entry> --profile web --dump-config   → exit 0
 * ```
 *
 * 它是**默认值，不是硬编码**：`createLauncher({ dshProfile })` 可以覆盖它
 * （一个跑 `--profile rescue` 或在无头机器上用别的 profile 的部署必须能改）。
 */
export const DEFAULT_DSH_PROFILE = 'web'

export const RUNTIME_RESOLVE_CODES = Object.freeze({
  /** 没有数据目录：没有安装位置，也就没有指针可读。 */
  NO_DATA_DIR: 'RUNTIME_RESOLVE_NO_DATA_DIR',
  /** 还没装过（干净机器上的正常读数，**不是**错误）。 */
  NOT_INSTALLED: 'RUNTIME_RESOLVE_NOT_INSTALLED',
  /** 指针在，但读不懂。 */
  POINTER_UNREADABLE: 'RUNTIME_RESOLVE_POINTER_UNREADABLE',
  /** 指针指着一次没装完的安装（缺完成标记或入口文件）。 */
  POINTER_BROKEN: 'RUNTIME_RESOLVE_POINTER_BROKEN',
  /** 指针自带的 `entry` 与按目录重算出来的入口**不是同一个文件**。 */
  ENTRY_MISMATCH: 'RUNTIME_RESOLVE_ENTRY_MISMATCH',
  /** 有现役运行时，但没给出 profile —— DSH 会以 `--profile <name> is required` 退出 1。 */
  PROFILE_REQUIRED: 'RUNTIME_RESOLVE_PROFILE_REQUIRED',
})

/** 拒绝里那一句"下一步怎么做"。与 `runtime-install.mjs` 的 `runtimeInstallNextStepOf` 同一用途。 */
const NEXT_STEP = Object.freeze({
  [RUNTIME_RESOLVE_CODES.NO_DATA_DIR]: '给出数据目录：--data-dir=<path> 或设置 LEGION_DATA_DIR',
  [RUNTIME_RESOLVE_CODES.NOT_INSTALLED]:
    '这一版还没装过运行时：先跑 --runtime-install-plan --runtime-manifest=<产品版本清单>，'
    + '或者用 runtime.command 显式指向一个已存在的 DSH',
  [RUNTIME_RESOLVE_CODES.POINTER_UNREADABLE]:
    '指针文件读不懂：删掉它（下一次安装会重建）或从 backups 里恢复，别让它带着一个读不懂的指针启动',
  [RUNTIME_RESOLVE_CODES.POINTER_BROKEN]:
    '指针指着一次没装完的安装：重装那个版本，或用 rollback 切回上一个版本（指针没动的时候旧版本仍然现役）',
  [RUNTIME_RESOLVE_CODES.ENTRY_MISMATCH]:
    '指针里的 entry 与按目录重算的入口不是同一个文件：说明指针被改过或目录被挪过，重装那个版本',
  [RUNTIME_RESOLVE_CODES.PROFILE_REQUIRED]:
    '给出 DSH profile（--profile=<name>，或让 Launcher 用 dshProfile）。'
    + '实测：一个不带 --profile 的 DSH 入口会以 "error: --profile <name> is required" 退出 1',
})

/** 拒绝码 → 下一步。查不到时返回 `null`（不编一句通用话）。 */
export function runtimeResolveNextStepOf(code) {
  return NEXT_STEP[code] ?? null
}

/** `runtimeCommand` 是不是**被显式给出来了**（与 `expandConfigured` 同一个判据）。 */
export function runtimeCommandIsGiven(value) {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (typeof value === 'object' && typeof value.file === 'string') return value.file.trim() !== ''
  return false
}

function reject(code, message, extra = {}) {
  return Object.freeze({
    version: RUNTIME_RESOLVE_VERSION,
    ok: false,
    code,
    // `blocking` 三态之外的第四种输入不存在：它就是布尔。
    // `true` = 这一次启动**不该继续**（另有更准确的诊断在计划里）；
    // `false` = 只是"没有可用的现役运行时"，今天的 `ENTRY_UNRESOLVED` 已经说清了。
    blocking: extra.blocking === true,
    source: null,
    command: null,
    profile: extra.profile ?? null,
    active: extra.active ?? null,
    nextStep: runtimeResolveNextStepOf(code),
    message,
  })
}

/**
 * 现役运行时 → **能直接交给 `materializeProcessPlan` 的那条命令**。
 *
 * @param {object} o
 * @param {string|null} o.dataDir   数据目录（`layout.dataDir`）
 * @param {string|null} [o.profile] DSH profile 名（缺省 = 不拼这条命令，直接拒绝）
 * @param {string[]} [o.extraArgs]  追加在 `--profile <name>` 之后的参数
 * @param {object|null} [o.fs]      `readActiveRuntime` 的 fs（可注入：判据要能离线验证）
 * @param {string} [o.nodePath]     起入口用的 node（默认 `process.execPath`）
 * @param {string} [o.platform]
 * @returns {{version:number, ok:boolean, code:string|null, blocking:boolean,
 *            source:string|null, command:{file:string,args:string[]}|null,
 *            profile:string|null, active:object|null, nextStep:string|null, message:string}}
 */
export function resolveRuntimeCommand({
  dataDir = null,
  profile = null,
  extraArgs = [],
  fs = null,
  nodePath = process.execPath,
  platform = process.platform,
  packageName = DEFAULT_DSH_PACKAGE,
  entryRelpath = DEFAULT_ENTRY_RELPATH,
} = {}) {
  if (typeof dataDir !== 'string' || dataDir.trim() === '') {
    return reject(
      RUNTIME_RESOLVE_CODES.NO_DATA_DIR,
      '拿不到数据目录：不知道运行时装在哪，也就读不到现役指针。'
        + '这一档**不阻塞**——计划里那条 ENTRY_UNRESOLVED 已经用更准确的话说了同一件事，'
        + '再报一条只会让"同一问题出现两次"看起来像两个问题。',
    )
  }

  const active = readActiveRuntime({ dataDir, fs, packageName, entryRelpath })
  const base = { active, profile: typeof profile === 'string' && profile.trim() !== '' ? profile.trim() : null }

  if (active.state === 'absent') {
    return reject(
      RUNTIME_RESOLVE_CODES.NOT_INSTALLED,
      `数据目录 ${dataDir} 下还没有现役运行时（指针不存在）。这是干净机器上的正常读数，不是错误`,
      base,
    )
  }
  if (active.state === 'unreadable') {
    return reject(
      RUNTIME_RESOLVE_CODES.POINTER_UNREADABLE,
      `现役指针读不懂（${active.pointerPath}）：${active.message}`,
      { ...base, blocking: true },
    )
  }
  if (active.state !== 'active') {
    return reject(
      RUNTIME_RESOLVE_CODES.POINTER_BROKEN,
      `现役指针指着一次没装完的安装（${active.dir}）：${active.message}`,
      { ...base, blocking: true },
    )
  }

  // ── 入口：**重算**，并要求指针自带的那一个与它一致 ────────────────────
  //
  // 为什么以重算为准：`dir` + 包名 + 相对入口是**目录事实**，而 `entry` 是
  // 安装当时抄下来的一行字。两者不一致时，"哪一个是坏的"没有第二个来源可判，
  // 所以这里既不挑一个用、也不"优先用指针里的那个"——直接拒绝。
  const entryPath = active.entryPath
  const declared = readDeclaredEntry(active, fs)
  if (declared !== null && !samePath(declared, entryPath, platform)) {
    return reject(
      RUNTIME_RESOLVE_CODES.ENTRY_MISMATCH,
      `指针里的 entry（${declared}）与按目录重算出来的入口（${entryPath}）不是同一个文件。`
        + '两边都"看起来像"那个入口，而挑错一个的后果是启动一个**别的**文件',
      { ...base, blocking: true },
    )
  }
  if (active.entryExists !== true) {
    // `active` 已经是 `broken` 的情况在上面被拦下了；走到这里说明重算出来的
    // 入口在、而 `readActiveRuntime` 说它不在 —— 两次读数不一致时不猜。
    return reject(
      RUNTIME_RESOLVE_CODES.POINTER_BROKEN,
      `现役指针说 ${active.version} 是现役，但入口文件不在（${entryPath}）`,
      { ...base, blocking: true },
    )
  }

  if (base.profile === null) {
    return reject(
      RUNTIME_RESOLVE_CODES.PROFILE_REQUIRED,
      `现役运行时的入口解析出来了（${entryPath}），但没有给出 DSH profile。`
        + '**不能省掉这一段**：实测一个真的装好的 DSH 入口不带 --profile 时会以 '
        + '`error: --profile <name> is required` 退出 1 —— '
        + '而"命令跑起来了、参数少一段"与"版本装错了"在读数上长得不一样，修法却是两件事',
      { ...base, blocking: true },
    )
  }

  return Object.freeze({
    version: RUNTIME_RESOLVE_VERSION,
    ok: true,
    code: null,
    blocking: false,
    // 说清这条命令是**从哪来的**：一次启动用的到底是配置里那条、还是产品自己装的那条。
    source: 'installed-pointer',
    command: Object.freeze({
      file: nodePath,
      args: Object.freeze([entryPath, '--profile', base.profile, ...extraArgs.map(String)]),
    }),
    profile: base.profile,
    active,
    nextStep: null,
    message: `现役 DSH ${active.version}（补丁层 ${active.patchVersion ?? '未记录'}）：`
      + `${nodePath} ${entryPath} --profile ${base.profile}`,
  })
}

/**
 * 指针里**自带**的那个 `entry`（可能没有）。
 *
 * 刻意不复用 `readActiveRuntime` 已经读过的 JSON，而是再读一次指针文件：
 * 一次读数里同时给出"解析出来的入口"与"文件里写着的入口"，会让下面那条
 * 不一致检查变成**拿同一个值和自己比**——那正是本模块要消灭的那类假验证。
 * 读不到（文件没了 / 不是 JSON）时返回 `null`：那不是不一致，是另一个读数
 * （`readActiveRuntime` 已经把它报成 `unreadable` 了）。
 */
/**
 * 指针里**自带**的那个 `entry`（可能没有）。
 *
 * 刻意再读一次指针文件、而不是复用 `readActiveRuntime` 的产物：`entryPath`
 * 是**按目录重算**出来的，而这个函数要的是**文件里写着的那一行**。
 * 用同一个值和自己比会让上面那条不一致检查变成一次假验证——而假验证
 * 与"没有这条检查"在红的时候才分得开。
 *
 * 读不到（文件没了 / 不是 JSON / 没有 `entry` 字段）时返回 `null`：
 * 那**不是**不一致，只是没有第二个来源可对（旧指针没有这个字段）。
 */
function readDeclaredEntry(active, fs) {
  const io = fs ?? null
  try {
    const raw = io === null
      ? readFileSync(active.pointerPath, 'utf8')
      : io.readFileSync(active.pointerPath, 'utf8')
    const parsed = JSON.parse(raw)
    return typeof parsed?.entry === 'string' && parsed.entry.trim() !== '' ? parsed.entry : null
  } catch {
    return null
  }
}

/**
 * 启动期诊断的具名码。它们说的是**另一件事**：不是"命令拼不出来"，
 * 而是"磁盘上的那一份与这一次要跑的那一份不是同一个"。
 */
export const RUNTIME_RESOLVE_DIAG_CODES = Object.freeze({
  /** 磁盘上有现役运行时，而这次启动用的是显式配置的那条命令。 */
  INSTALLED_UNUSED: 'RUNTIME_RESOLVE_INSTALLED_UNUSED',
  /** 磁盘上有指针，但它坏了——而这次启动没打算用它。 */
  INSTALLED_BROKEN_UNUSED: 'RUNTIME_RESOLVE_INSTALLED_BROKEN_UNUSED',
})

/** 诊断上挂的进程键。见 `diag()` 里的理由。 */
const DIAG_PROCESS_KEY = 'runtime'

function diag(severity, code, message, extra = {}) {
  // `process: 'runtime'` 不是装饰：`launcher.mjs` 会用这个字段把
  // "本次 `--include` 不含 runtime"的诊断降级为 warn。一次本来就不拉
  // runtime 的启动，不该因为"运行时没装好"而起不来。
  return Object.freeze({ severity, code, process: DIAG_PROCESS_KEY, message, ...extra })
}
/**
 * 给 Launcher 用的一步：**决定这一次启动用哪条 runtime 命令**，并给出该说的诊断。
 *
 * 它是本模块唯一的"策略"函数，而 `resolveRuntimeCommand` 是它的纯读数半边。
 * 分开的理由与 `runtime-install.mjs` 把计划与执行分开是同一条：**策略要能
 * 被逐条断言，而读数要能被注入构造**。
 *
 * @returns {{version:number, given:boolean, used:'configured'|'installed-runtime'|null,
 *            command:object|null, resolution:object, diagnostics:object[]}}
 */
export function resolveRuntimeForLaunch({
  runtimeCommand = null,
  dataDir = null,
  profile = DEFAULT_DSH_PROFILE,
  fs = null,
  nodePath = process.execPath,
  platform = process.platform,
  packageName = DEFAULT_DSH_PACKAGE,
  entryRelpath = DEFAULT_ENTRY_RELPATH,
} = {}) {
  const given = runtimeCommandIsGiven(runtimeCommand)
  // ★ 即使这一次用的是配置里那条命令，也**读一次**指针。
  //
  //   为什么值得多读两个文件：一个"装好了、但从来没人用过"的运行时，
  //   在产品里没有任何读数会提到它。它占着磁盘、留着版本目录，
  //   而所有界面都是绿的——那正是本任务要消灭的那一类"两个绿了的半边"。
  const resolution = resolveRuntimeCommand({
    dataDir, profile, fs, nodePath, platform, packageName, entryRelpath,
  })
  const diagnostics = []
  const base = { version: RUNTIME_RESOLVE_VERSION, given, resolution }

  if (given) {
    const active = resolution.active
    if (resolution.ok === true) {
      diagnostics.push(diag('warn', RUNTIME_RESOLVE_DIAG_CODES.INSTALLED_UNUSED,
        `数据目录里有一个现役的 DSH 运行时（${active.version}，补丁层 `
        + `${active.patchVersion ?? '未记录'}），但这次启动用的是显式给出的 runtime 命令。`
        + '两者不是同一个版本时，"我装好了"与"我跑的是它"就是两件事——'
        + '要改用装好的那一个，就把配置里的 runtime.command 删掉（缺省即用现役指针）。'))
    } else if (resolution.blocking === true) {
      diagnostics.push(diag('warn', RUNTIME_RESOLVE_DIAG_CODES.INSTALLED_BROKEN_UNUSED,
        `数据目录里有一个**坏掉的**运行时指针（${resolution.code}）：${resolution.message}。`
        + '这次启动用的是显式给出的 runtime 命令，因此不受影响；'
        + `但要修好它，下一步是：${resolution.nextStep ?? '（没有给出下一步）'}`))
    }
    return Object.freeze({
      ...base,
      used: 'configured',
      command: runtimeCommand,
      diagnostics: Object.freeze(diagnostics),
    })
  }

  if (resolution.ok === true) {
    return Object.freeze({
      ...base, used: 'installed-runtime', command: resolution.command, diagnostics: Object.freeze([]),
    })
  }

  // 阻塞：`active` 在、但这一份读数说"不该带着它启动"（spec §9.1「不带病运行」）。
  if (resolution.blocking === true) {
    diagnostics.push(diag('error', resolution.code,
      `${resolution.message}。下一步：${resolution.nextStep ?? '（没有给出下一步）'}`))
    return Object.freeze({
      ...base, used: null, command: null, diagnostics: Object.freeze(diagnostics),
    })
  }

  // `absent` / 拿不到数据目录：与今天完全一样（由计划的 ENTRY_UNRESOLVED 说话）。
  return Object.freeze({
    ...base, used: null, command: null, diagnostics: Object.freeze([]),
  })
}
