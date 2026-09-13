#!/usr/bin/env node
// product/launcher/cli.mjs
// ============================================================================
// Legion Launcher 命令行入口（PRT-251）
//
//   node product/launcher/cli.mjs --check          # 只体检，不启动任何进程
//   node product/launcher/cli.mjs                  # 按波次启动，Ctrl+C 优雅停止
//   node product/launcher/cli.mjs --include=team-hub,workbench --json
//
// ## 为什么 `--check` 是一个**独立且优先**的用法
//
// Launcher 的失败模式大多是「起了一半」：team-hub 好了、workbench 没起来，
// 界面能开、数据是空的。这种状态产生副作用（占了端口、建了库、留下半启动进程），
// 而排查它比排查「完全起不来」贵得多。`--check` 把「确定性的错误」提前到
// 不产生任何副作用的阶段回答：端口、入口、依赖环、目录边界。
//
// ## 环境变量的可见性
//
// 本文件**逐字读取**每一个它支持的 LEGION_* 变量（`process.env.LEGION_HOME` 这种写法），
// 而不是 `env[LEGION_ENV.HOME]` 这样的计算访问——因为 `scripts/config/scan.mjs` 只能
// 看见字面访问，计算访问会让这些读取点**完全不出现在配置面扫描结果里**。
// `product/paths.mjs` 内部用的正是计算访问（那样才不会有拼写漂移），
// 所以「让读取点可见」这件事必须在调用方做到。
// 读取点与注入点一并声明在 `product/config-schema.mjs`。
// ============================================================================

import { fileURLToPath, pathToFileURL } from 'node:url'

import { LEGION_ENV, resolveLayout } from '../paths.mjs'
import { launcherInputFromConfig, loadProductConfig } from '../config.mjs'
import { AUTO_EXPORT_DEFAULTS, runAutoExport } from '../diagnostics/auto-export.mjs'
import { initializeProductDir, isInitialized } from '../init.mjs'
import { createLauncher, PRODUCT_STATE_TEXT } from './launcher.mjs'
import { DEFAULT_BACKOFF } from './supervisor.mjs'

/**
 * 安装目录的默认值：**Launcher 自己所在的那棵树**。
 *
 * 这是 Launcher 唯一比别人多知道的一件事——它就在安装目录里。
 * 若要求用户必须显式设置 `LEGION_INSTALL_DIR`，则「双击启动」这个最基本的用法
 * 会在第一步就报 `INSTALL_DIR_UNRESOLVED`（本条注释的上一版就是这样，实测出来的）。
 * 优先级仍是 显式 CLI > 环境变量 > 本默认值。
 */
export function defaultInstallDir(moduleUrl = import.meta.url) {
  // product/launcher/cli.mjs → product/launcher → product → 安装根
  return fileURLToPath(new URL('../../', moduleUrl)).replace(/[\\/]+$/, '')
}

/** 支持的 CLI 参数（也是 `--help` 的唯一来源）。 */
export const CLI_FLAGS = Object.freeze([
  { name: '--check', kind: 'boolean', doc: '只做启动前体检（端口/入口/依赖/目录边界），不启动任何进程' },
  { name: '--init', kind: 'boolean', doc: '首次运行初始化：建目录、写默认产品配置与产品元数据，然后退出（不启动进程）' },
  { name: '--dry-run', kind: 'boolean', doc: '与 --init 同用：只报告将会创建什么，不落盘' },
  { name: '--no-config', kind: 'boolean', doc: '忽略产品配置文件（只用内置默认值 + env + CLI）' },
  { name: '--json', kind: 'boolean', doc: '以 JSON 输出结果（供脚本与验收使用）' },
  { name: '--install-dir=<path>', kind: 'value', doc: `安装目录；等价于 ${LEGION_ENV.INSTALL_DIR}` },
  { name: '--data-dir=<path>', kind: 'value', doc: `数据目录；等价于 ${LEGION_ENV.DATA_DIR}` },
  { name: '--workspace=<path>', kind: 'value', doc: `工作区目录；等价于 ${LEGION_ENV.WORKSPACE_DIR}` },
  { name: '--port.<进程>=<n>', kind: 'value', doc: '覆盖某进程端口，如 --port.team-hub=9000' },
  { name: '--include=<a,b>', kind: 'value', doc: '只启动列出的进程（受限范围；产品状态不会被报成「已就绪」）' },
  { name: '--runtime-command=<cmd>', kind: 'value', doc: 'DSH Runtime 的启动命令行（PRT-011 路线 C：Launcher 把 npm 包装进 DataDir）' },
  { name: '--allow-port-in-use=<a,b>', kind: 'value', doc: '允许复用已在监听的端口的进程（显式决定，不是默认行为）' },
  { name: '--diagnostics=<dir>', kind: 'value', doc: '导出脱敏诊断包到指定目录（PRT-710）。' +
    '**这是唯一在体检/配置/布局出问题时仍然可用的入口**：诊断包最需要在产品坏掉的时候拿到' },
  { name: '--no-auto-diagnostics', kind: 'boolean', doc: '关掉「启动失败时自动留诊断包」（PRT-710）。' +
    '**默认是开的**：诊断包只写在本机 `<产品家目录>/diagnostics/`，不外发，' +
    '而它的全部价值就在于"用户没想起来的时候它也在"。给这一条留一个显式退出' },
  { name: '--auto-diagnostics-keep=<n>', kind: 'value', doc: '自动导出的保留份数（默认 3，最小 1）。' +
    '自动写盘意味着**失败循环里自动写盘**，这个数字就是磁盘上界' },
  { name: '--sweep-orphans', kind: 'boolean', doc: '启动前清理上一次运行留下的进程（PRT-705）。' +
    '**默认只报告不清理**：杀进程不可撤销。清理前会核对映像名，对不上的一律不动' },
  { name: '--allow-unverified-sweep', kind: 'boolean', doc: '与 --sweep-orphans 同用：' +
    '连映像名读不出来的那些也清理。**不建议**——那正是「按号码杀」的那条路' },
  { name: '--help', kind: 'boolean', doc: '打印本说明' },
])

// 两份名单**从 `CLI_FLAGS` 派生**，不再手工维护。
//
// 原来这里是 `const BOOLEAN_FLAGS = [...]` 加 `parseArgs` 里一个独立的
// `known` 数组。那份注释甚至写着：
//
//   「列在这里而不是散在 if 里：新开关漏加会让它被当成未知参数。」
//
// 而 PRT-705 加 `--sweep-orphans` 时**照样漏了**——注释警告的正是这件事，
// 写注释的人自己也踩了。这不是记性问题，是结构问题：
// 一份要写两处的名单，第二处总有一天会忘。
//
//   > 一个必须靠人记得去同步的名单，与一个迟早会不同步的名单，
//   > 在"新加的开关能不能用"上是同一个东西。
//
// 现在加一个开关只需要动 `CLI_FLAGS` 一处；它还同时是 `--help` 的正文，
// 所以"能用的"与"文档里写的"不会再分成两件事。
const BOOLEAN_FLAGS = Object.freeze(CLI_FLAGS
  .filter((f) => f.kind === 'boolean' && !f.name.includes('='))
  .map((f) => f.name.replace(/^--/, '')))

/** 取值开关的键名（`--install-dir=<path>` → `install-dir`）。同样派生。 */
const VALUE_FLAG_KEYS = Object.freeze(CLI_FLAGS
  .filter((f) => f.kind === 'value' && f.name.includes('='))
  .map((f) => f.name.replace(/^--/, '').split('=')[0])
  .filter((k) => k !== 'port' && !k.startsWith('port.')))

/**
 * 解析 argv。**只接受 `--k=v` 与布尔开关**，不接受位置参数：
 * 位置参数的含义随「第几个」变化，是脚本化调用最容易出错的地方。
 */
export function parseArgs(argv) {
  const out = { ports: {}, flags: {}, errors: [] }
  for (const raw of argv) {
    if (raw.startsWith('--') && BOOLEAN_FLAGS.includes(raw.slice(2))) {
      out.flags[raw.slice(2)] = true
      continue
    }
    const eq = raw.indexOf('=')
    if (!raw.startsWith('--') || eq < 0) {
      // 报错信息从名单生成：硬编码的"支持 --check/--json/--help"已经有过一次
      // 与真实名单不一致的历史，而那句话是用户唯一能看到的线索。
      out.errors.push(`无法识别的参数「${raw}」：本 CLI 只接受 --key=value 形式与 `
        + BOOLEAN_FLAGS.map((f) => `--${f}`).join('/'))
      continue
    }
    const key = raw.slice(2, eq)
    const value = raw.slice(eq + 1)
    if (key.startsWith('port.')) {
      const proc = key.slice('port.'.length)
      const port = Number(value)
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        out.errors.push(`--port.${proc}=${value} 不是合法端口（0..65535）`)
        continue
      }
      out.ports[proc] = port
      continue
    }
    if (!VALUE_FLAG_KEYS.includes(key)) {
      out.errors.push(`未知参数「--${key}」：用 --help 查看支持的参数`)
      continue
    }
    out.flags[key] = value
  }
  return out
}

/**
 * 从环境变量读取 Launcher 自己的配置。
 *
 * 每个键**逐字**出现一次。这样做有一个副作用是好的：`scan --check` 能列出
 * 这个进程到底读哪些变量，而「Launcher 会读哪些环境变量」正是运维最需要知道的清单。
 */
export function readEnv(env = {}) {
  return {
    [LEGION_ENV.HOME]: env.LEGION_HOME,
    [LEGION_ENV.INSTALL_DIR]: env.LEGION_INSTALL_DIR,
    [LEGION_ENV.DATA_DIR]: env.LEGION_DATA_DIR,
    [LEGION_ENV.WORKSPACE_DIR]: env.LEGION_WORKSPACE_DIR,
    [LEGION_ENV.CACHE_DIR]: env.LEGION_CACHE_DIR,
    [LEGION_ENV.LOG_DIR]: env.LEGION_LOG_DIR,
    [LEGION_ENV.PRODUCT_CONFIG]: env.LEGION_PRODUCT_CONFIG,
  }
}

/** 就绪超时可由环境覆盖（它是配置项，不是硬编码；spec §6.4）。 */
export function readReadinessTimeoutMs(env = {}) {
  const raw = env.LEGION_READINESS_TIMEOUT_MS
  if (raw === undefined || raw === null || String(raw).trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

export const LEGION_READINESS_TIMEOUT_ENV = 'LEGION_READINESS_TIMEOUT_MS'

/**
 * 操作系统级的家目录事实（不是 Legion 的配置，是它必须读的环境）。
 *
 * 这三个变量属于**操作系统/用户会话**，不属于 Legion —— 因此它们是
 * `foreignEnv`（登记在 `product/config-schema.mjs`），不是本进程的配置项。
 */
export const OS_HOME_ENV = Object.freeze({
  LOCAL_APP_DATA: 'LOCALAPPDATA',
  USER_PROFILE: 'USERPROFILE',
  HOME: 'HOME',
})

/**
 * 从**进程环境**推出家目录事实，交给 `resolveLayout`。
 *
 * ## 为什么这件事必须在这里做（PRT-255 实测抓到的缺陷）
 *
 * `resolveLayout` 的签名里一直有 `homeDir` / `appDataDir` 两个入参，
 * 而 `defaultProductHome` 在拿不到它们时会返回 `root: null`。可是**唯一的生产
 * 调用方从来没有传过它们**——于是产品家目录永远是 null，`secretsFile` 永远是
 * null，接着每一次启动都被 `SECRETS_PLACEMENT_INVALID` 拒绝。
 *
 * 实测形态：用文档上的那几个开关（`--install-dir` / `--data-dir` / `--workspace`）
 * 装完之后，`--init` 成功、诊断包能导出，**而产品根本起不来**：
 *
 *   > 一个「装得上、也导得出诊断包」的产品，
 *   > 与一个「装完起不来」的产品，是同一个东西——
 *   > 只不过前者在"安装成功"这个返回值上是完全正确的。
 *
 * ## 优先级
 *
 * `LEGION_HOME`（受控环境变量，显式覆盖）> 操作系统事实 > 未解析。
 * 显式覆盖这一条不受本函数影响：它由 `resolveLayout` 内部的 `defaultProductHome`
 * 先判，所以"部署时设的 LEGION_HOME 不生效"这种倒置不会发生。
 */
export function osHomeFacts(env = {}) {
  const nonEmpty = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null)
  return {
    appDataDir: nonEmpty(env[OS_HOME_ENV.LOCAL_APP_DATA]),
    // POSIX 上是 HOME，Windows 上是 USERPROFILE；两者都给，由
    // `defaultProductHome` 按 platform 决定怎么用。
    homeDir: nonEmpty(env[OS_HOME_ENV.USER_PROFILE]) ?? nonEmpty(env[OS_HOME_ENV.HOME]),
  }
}

/**
 * 组装 Launcher 选项（把 CLI、环境与产品配置文件合成**一份显式输入**）。
 *
 * ## 优先级（spec §6.11 + CLI 的位置）
 *
 * ```
 * 内置默认值 < 产品配置 < 工作空间配置 < 用户设置 < 受控环境变量 < 命令行
 * ```
 *
 * 前三层与 env 的次序就是 spec 定的（`mergeConfigLayers` 只认这一种次序）。
 * **命令行排在最后**是这里的补充：`--port.team-hub=9000` 是「就这一次，用 9000」，
 * 若被配置文件里的值压过去，用户没有任何办法临时改一次——只能去编辑文件再改回来。
 *
 * ## 为什么把配置文件诊断一起返回
 *
 * 配置文件的失败几乎全是静默的（键名写错、JSON 多一个逗号）。它们必须在
 * **创建 Launcher 之前**被看见并阻塞：带着半份配置启动的结果是「用户以为设置生效了」。
 */
export function launcherOptionsFrom({ argv = [], env = {}, nodePath = process.execPath, configLoader = loadProductConfig, installDirDefault = defaultInstallDir } = {}) {
  const parsed = parseArgs(argv)
  const declared = readEnv(env)
  // ★ 把操作系统事实传进去（PRT-255 实测抓到的缺陷：这两个入参一直存在，
  //   而唯一的生产调用方从来没传过，于是产品家目录恒为 null → 起不来）。
  const osHome = osHomeFacts(env)
  const { layout, diagnostics } = resolveLayout({
    installDir: parsed.flags['install-dir'] ?? declared[LEGION_ENV.INSTALL_DIR] ?? installDirDefault(),
    dataDir: parsed.flags['data-dir'] ?? null,
    workspaceDir: parsed.flags.workspace ?? null,
    homeDir: osHome.homeDir,
    appDataDir: osHome.appDataDir,
    env: declared,
  })

  const config = parsed.flags['no-config'] === true
    ? { ok: true, merged: null, diagnostics: [], paths: {}, layers: [] }
    : configLoader(layout, { envValues: {} })
  const fromConfig = launcherInputFromConfig(config.merged ?? null)

  // ★ PRT-710 收尾：自动导出**默认开着**，`--no-auto-diagnostics` 是显式的退出。
  //
  //   为什么默认开：诊断包只写在本机 `<产品家目录>/diagnostics/`、不外发，
  //   而这一整条任务的定位是"最需要在产品坏掉的时候拿到"。默认关的话，
  //   它就退化成"用户可以手工敲 --diagnostics"，而这正是它要补上的那一步。
  //
  //   只留一个**关**的开关（不留"开"的开关）：一个已经是默认值的 `--auto-diagnostics`
  //   是一个**没有任何效果的参数**，而一个没有效果的参数比没有这个参数更坏——
  //   它会让读命令行的人以为"这件事是要显式打开的"。
  //
  //   ⚠️ 它必须定义在 `run()` 里，不是 `launcherOptionsFrom()` 里：
  //   第一版我按 `const fromConfig = ...` 定位、插错了函数，于是启动失败那条路
  //   报 `ReferenceError: autoDiagnostics is not defined`——**只在真的启动失败时才崩**。
  //   一个"只在出错路径上才崩"的变量引用，在跑得通的运行里与一个正确的实现同形。

  const include = parsed.flags.include === undefined
    ? null
    : String(parsed.flags.include).split(',').map((s) => s.trim()).filter(Boolean)
  const allowPortInUse = parsed.flags['allow-port-in-use'] === undefined
    ? []
    : String(parsed.flags['allow-port-in-use']).split(',').map((s) => s.trim()).filter(Boolean)
  const readinessTimeout = readReadinessTimeoutMs(env)

  // 命令行 > 配置文件。CLI 只覆盖它显式给出的键，其余仍由配置文件决定。
  const ports = { ...fromConfig.ports, ...parsed.ports }
  const runtimeCommand = parsed.flags['runtime-command'] ?? fromConfig.runtimeCommand ?? null

  return {
    parsed,
    layout,
    layoutDiagnostics: diagnostics,
    config,
    configDiagnostics: config.diagnostics ?? [],
    options: {
      layout,
      ports,
      include,
      allowPortInUse,
      runtimeCommand,
      nodePath,
      // 日志策略（PRT-709）来自产品配置文件的 `log.*` 键。
      // 缺省时是 `{}`，由 `validateLogPolicy` 落到 `DEFAULT_LOG_POLICY`。
      // **不在这里补默认值**：补一份就多一处会漂移的副本，而"哪一份生效"
      // 在排查时会成为一个必须回答的问题。
      logPolicy: fromConfig.logPolicy ?? {},
      // PRT-257：DSH 强制面覆盖层。`undefined` = 配置里没写 → 由
      // `resolveDshOverlay` 的默认参数落到 `true`（**默认装上**）。
      // 这里刻意写 `?? true` 而不是留 `undefined`：`createLauncher` 的默认值是
      // `true`，但把这份默认值显式写在一个地方，读代码的人不必去翻两层默认值。
      enforcementOverlay: fromConfig.enforcementOverlay ?? true,
      // PRT-705：清理**必须显式要求**，所以这里是 === true 而不是真值判断。
      // 一个"默认会杀进程"的启动路径，与一个会在用户没要求时动手的路径，
      // 在"用户能不能预料到发生了什么"上是同一个东西。
      sweepOrphansOnStart: parsed.flags['sweep-orphans'] === true,
      allowUnverifiedSweep: parsed.flags['allow-unverified-sweep'] === true,
      // Launcher 自己的环境只作为**白名单的读取来源**传入，不会被整份复制给子进程
      baseEnv: env,
      readiness: readinessTimeout === null
        ? (fromConfig.readinessTimeoutMs === undefined ? {} : { timeoutMs: fromConfig.readinessTimeoutMs })
        : { timeoutMs: readinessTimeout },
    },
  }
}

function printDiagnostics(diagnostics, write = console.log) {
  for (const d of diagnostics) {
    const tag = d.severity === 'error' ? '✖' : '⚠'
    const proc = d.process === undefined || d.process === null ? '' : `[${d.process}] `
    write(`  ${tag} ${proc}${d.code}：${d.message}`)
  }
}

/** 主流程。返回进程退出码（0 成功）。 */
export async function run({
  argv = process.argv.slice(2), env = process.env, write = console.log, waitForSignal = true,
  // ★ PRT-710 收尾：这两个是可注入的**接缝**，默认就是真实实现。
  //
  //   为什么需要它们：启动失败这条路要用例去走，而"让一次真实启动失败"
  //   意味着起真实子进程、等它就绪超时——慢、依赖机器状态，而且它的失败
  //   方式与产品是否正常无关。一个"只在机器恰好很慢时才走到"的分支，
  //   等于**没有被测**。
  //
  //     > 一个"靠构造真实故障才走得到"的分支，
  //     > 与一个"没有测试能走到"的分支，在覆盖率上看起来不一样——
  //     > 只不过前者的绿是**机器当时心情好**换来的。
  //
  //   注入的是"启动器工厂"而不是"启动结果"：这样 `start()` 的失败形状
  //   仍然由真实的 `createLauncher` 契约决定，测试只换掉**谁来起进程**。
  createLauncherFn = createLauncher,
  autoExportFn = runAutoExport,
} = {}) {
  if (argv.includes('--help')) {
    write('Legion Launcher（PRT-251）')
    write('')
    for (const f of CLI_FLAGS) write(`  ${f.name.padEnd(30)} ${f.doc}`)
    return 0
  }

  const { parsed, options, layoutDiagnostics, config, configDiagnostics } = launcherOptionsFrom({ argv, env })
  if (parsed.errors.length > 0) {
    for (const e of parsed.errors) write(`✖ ${e}`)
    return 2
  }

  const json = parsed.flags.json === true

  // ★ PRT-710 收尾：自动导出**默认开着**，`--no-auto-diagnostics` 是显式的退出。
  //
  //   为什么默认开：诊断包只写在本机 `<产品家目录>/diagnostics/`、不外发，
  //   而这一整条任务的定位是"最需要在产品坏掉的时候拿到"。默认关的话，
  //   它就退化成"用户可以手工敲 --diagnostics"，而这正是它要补上的那一步。
  //
  //   只留一个**关**的开关（不留"开"的开关）：一个已经是默认值的 `--auto-diagnostics`
  //   是一个**没有任何效果的参数**，而一个没有效果的参数比没有这个参数更坏——
  //   它会让读命令行的人以为"这件事是要显式打开的"。
  const autoDiagnostics = parsed.flags['no-auto-diagnostics'] !== true

  // ── 诊断包导出（PRT-710）─────────────────────────────────────────────
  //
  // **位置是这段代码的全部要点**：它排在布局校验与配置校验**之前**。
  //
  // 诊断包最需要在什么时候拿到？**产品坏掉的时候。** 把它挂在一个"配置能解析、
  // 布局合法才往下走"的流程后面，等于在最需要它的时候恰好用不了：
  //
  //   > 一个只在产品健康时才可用的诊断入口，与一个不存在的诊断入口，
  //   > 在最需要它的那一刻是同一个东西。
  //
  // 所以这里**不**调 preflight、**不**创建 Launcher、**不**要求配置合法——
  // 它只要布局对象（拿得到目录在哪就够）与一个目标目录。
  if (typeof parsed.flags.diagnostics === 'string' && parsed.flags.diagnostics !== '') {
    const { exportDiagnosticPackage, DIAG_CODES } = await import('../diagnostics/redact-package.mjs')
    const r = await exportDiagnosticPackage({ layout: options.layout, outDir: parsed.flags.diagnostics })
    if (json) {
      write(JSON.stringify({ ok: r.ok, code: r.code ?? null, path: r.path ?? null, message: r.message, manifest: r.manifest ?? null, offenders: r.offenders ?? null }, null, 2))
    } else if (r.ok === true) {
      write(`✔ ${r.message}`)
      write(`  ${r.path}`)
      // 排除项**必须打出来**：一份说不清自己排除了什么的诊断包，
      // 与一份漏收了文件的诊断包，对排查者是同一个东西。
      for (const e of r.manifest.excluded) write(`  ⊘ 已排除 ${e.id}（${e.rule}）：${e.why}`)
      for (const x of r.manifest.skipped) write(`  · 未收 ${x.id}：${x.reason}`)
      for (const x of r.manifest.oversized) write(`  · 未收 ${x.id}：${x.why}`)
    } else {
      write(`✖ ${r.message}`)
    }
    // 退出码刻意把**泄漏**与**其它失败**分开：
    //   8 = 复检发现残留、包已作废（安全事件，必须一眼看得出与普通失败不同）；
    //   9 = 其它导出失败（包括"不覆盖已有目录"）。
    if (r.ok === true) return 0
    return r.code === DIAG_CODES.LEAK_DETECTED ? 8 : 9
  }

  // 目录布局诊断在**创建 Launcher 之前**就已经拿到（resolveLayout 的返回），
  // 而它在 createLauncher 内部还会再算一次。这里用它的原因是：
  // 「工作区未配置」这类问题必须在**任何进程启动之前**以用户能懂的话说出来。
  //
  // `--init` 例外：初始化**就是**来修「目录还没建好」的，因此它只要求布局
  // 没有 error（有 error 时 init 自己会拒绝并说明，一个目录都不建）。
  if (layoutDiagnostics.some((d) => d.severity === 'error') && parsed.flags.init !== true) {
    if (json) write(JSON.stringify({ ok: false, phase: 'layout', diagnostics: layoutDiagnostics }, null, 2))
    else {
      write('✖ Legion 无法启动：目录布局未确定')
      printDiagnostics(layoutDiagnostics, write)
    }
    return 3
  }

  // 配置文件的问题不得被静默跳过：坏 JSON 会让整份配置回到默认值，
  // 而用户以为自己的设置生效了。这是「配置没反应」最常见的真实原因。
  if (configDiagnostics.some((d) => d.severity === 'error')) {
    if (json) write(JSON.stringify({ ok: false, phase: 'config', diagnostics: configDiagnostics, paths: config.paths }, null, 2))
    else {
      write('✖ Legion 无法启动：产品配置有问题')
      printDiagnostics(configDiagnostics, write)
      write('  （配置文件必须能被完整读懂；否则所有值都会悄悄退回默认值）')
    }
    return 6
  }

  // 首次运行初始化（PRT-706）：建目录 → 写默认配置与元数据 → 退出。
  // 它**不启动任何进程**：初始化失败时启动会失败得更难懂（缺目录 → 各进程报自己的错）。
  if (parsed.flags.init === true) {
    const dryRun = parsed.flags['dry-run'] === true
    const init = initializeProductDir(options.layout, { dryRun })
    if (json) {
      write(JSON.stringify({ ok: init.ok, phase: init.phase, dryRun, created: init.created, skipped: init.skipped, files: init.files, diagnostics: init.diagnostics }, null, 2))
    } else {
      write(dryRun ? '（dry-run：以下内容不会被真正写入）' : 'Legion 首次运行初始化')
      for (const c of init.created) write(`  ＋ ${c.role.padEnd(12)} ${c.path}`)
      for (const f of init.files) write(`  ✎ ${f.role.padEnd(12)} ${f.path}`)
      for (const s of init.skipped.filter((x) => x.reason !== 'exists')) write(`  · ${s.role.padEnd(12)} ${s.path}（${s.reason}）`)
      printDiagnostics(init.diagnostics, write)
      write(init.ok ? `✔ 初始化完成（新建 ${init.created.length} 个目录、${init.files.length} 个文件）`
        : `✖ 初始化未完成：${init.diagnostics.filter((d) => d.severity === 'error').length} 个阻塞问题待解决`)
      if (init.ok && !dryRun && isInitialized(options.layout) !== true) write('  ⚠ 初始化后仍未达到「已初始化」判据，请查看上面的诊断')
    }
    return init.ok === true ? 0 : 7
  }

  const launcher = createLauncherFn(options)

  if (parsed.flags.check === true) {
    const pre = await launcher.preflight()
    if (json) {
      write(JSON.stringify({ ok: pre.ok, phase: pre.phase, diagnostics: pre.diagnostics }, null, 2))
    } else {
      write(pre.ok ? '✔ 启动前体检通过：端口、入口、依赖与目录边界均无阻塞问题' : `✖ 启动前体检未通过（阶段：${pre.phase}）`)
      printDiagnostics(pre.diagnostics, write)
      const warns = pre.diagnostics.filter((d) => d.severity !== 'error')
      if (warns.length > 0) write(`  （另有 ${warns.length} 条提醒）`)
    }
    return pre.ok === true ? 0 : 4
  }

  const result = await launcher.start()
  const status = launcher.status()

  if (json) {
    write(JSON.stringify({ ok: result.ok, phase: result.phase, failures: result.failures, state: status.state, scope: status.scope, processes: status.processes, diagnostics: launcher.allDiagnostics() }, null, 2))
  } else if (result.ok === true) {
    write(`✔ ${status.stateText}`)
    for (const p of status.processes) {
      write(`  ${p.state === 'ready' ? '●' : '○'} ${p.key.padEnd(13)} ${p.state.padEnd(9)} ${p.url ?? '(worker，无监听端口)'}`)
    }
    write('  （Ctrl+C 停止；进程状态与诊断可反复查询）')
  } else {
    write(`✖ 启动失败（阶段：${result.phase}）`)
    for (const f of result.failures) write(`  ✖ [${f.process}] ${f.code}：${f.detail ?? '无详情'}`)
    printDiagnostics(launcher.allDiagnostics(), write)

    // ── PRT-710 收尾：启动失败时**自动**留下诊断包 ──
    //
    // 为什么必须自动：`--diagnostics=<dir>` 要求用户在**产品已经坏掉之后**
    // 还想起来、并且能够，手工敲一条命令。而这一整条任务的定位就是
    // "诊断包最需要在产品坏掉的时候拿到"。
    //
    //   > 一个"坏掉之后可以手工导出"的诊断包，
    //   > 与一个"坏掉时会自动留下证据"的诊断包，
    //   > 在用户记得去敲那条命令的时候是同一个东西——
    //   > 只不过前者会在用户不记得、或者产品坏到连命令行都进不去的时候，
    //   > 恰好什么都不留下，而"这次没有证据"与"这次没什么可记的"长得一样。
    //
    // ★ 它在**打印完启动失败之后**才跑，且**不改变退出码**（仍是 5）。
    //
    //   自动导出失败时**绝不能**把已经说清的启动失败原因换掉：
    //
    //     > 一个"出不了诊断包于是报了个诊断包错误"的启动，
    //     > 与一个"真的就是诊断包坏了"的启动，
    //     > 在用户读到的第一行上是同一个东西——
    //     > 只不过前者会把一个**已经查明的**故障，换成一句**关于工具的**抱怨。
    if (autoDiagnostics === true) {
      const r = await autoExportFn({
        layout: options.layout,
        reason: `启动失败（阶段：${result.phase}）`,
        keep: parsed.flags['auto-diagnostics-keep'] === undefined
          ? AUTO_EXPORT_DEFAULTS.keep
          : Number(parsed.flags['auto-diagnostics-keep']),
      })
      write(r.ok === true ? `  ⤷ ${r.message}` : `  ⤷ 未留下诊断包：${r.message}`)
      if (json) write(JSON.stringify({ autoDiagnostics: { ok: r.ok, code: r.code ?? null, path: r.path ?? null, pruned: r.pruned } }))
    }
  }

  if (result.ok !== true) return 5

  if (waitForSignal) {
    await new Promise((resolve) => {
      const stop = () => resolve()
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    })
    const stopped = await launcher.stop({ reason: '收到停止信号' })
    if (!json) write(`  ${PRODUCT_STATE_TEXT.unavailable}（已停止 ${stopped.results.length} 个进程）`)
  }
  return 0
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const code = await run()
  // 退出前不调用 process.exit()：让 stdout 自然刷出（管道被提前关闭时会截断输出）
  process.exitCode = code
}

// 退出码（脚本与验收依赖它们，因此是契约的一部分）：
//   0 = 成功；2 = 参数错误；3 = 目录布局未确定；4 = --check 未通过；
//   5 = 启动失败；6 = 产品配置文件有 error；7 = 初始化未完成。
export const EXIT_CODES = Object.freeze({
  ok: 0, args: 2, layout: 3, check: 4, start: 5, config: 6, init: 7,
})

export { DEFAULT_BACKOFF }
