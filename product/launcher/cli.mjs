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
  { name: '--help', kind: 'boolean', doc: '打印本说明' },
])

/** 布尔开关（无值）。列在这里而不是散在 if 里：新开关漏加会让它被当成未知参数。 */
const BOOLEAN_FLAGS = Object.freeze(['check', 'init', 'dry-run', 'no-config', 'json', 'help'])

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
      out.errors.push(`无法识别的参数「${raw}」：本 CLI 只接受 --key=value 形式与 --check/--json/--help`)
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
    const known = ['install-dir', 'data-dir', 'workspace', 'include', 'runtime-command', 'allow-port-in-use', 'diagnostics']
    if (!known.includes(key)) {
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
  const { layout, diagnostics } = resolveLayout({
    installDir: parsed.flags['install-dir'] ?? declared[LEGION_ENV.INSTALL_DIR] ?? installDirDefault(),
    dataDir: parsed.flags['data-dir'] ?? null,
    workspaceDir: parsed.flags.workspace ?? null,
    env: declared,
  })

  const config = parsed.flags['no-config'] === true
    ? { ok: true, merged: null, diagnostics: [], paths: {}, layers: [] }
    : configLoader(layout, { envValues: {} })
  const fromConfig = launcherInputFromConfig(config.merged ?? null)

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
export async function run({ argv = process.argv.slice(2), env = process.env, write = console.log, waitForSignal = true } = {}) {
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

  const launcher = createLauncher(options)

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
