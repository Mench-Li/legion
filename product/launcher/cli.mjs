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

import { pathToFileURL } from 'node:url'

import { LEGION_ENV, resolveLayout } from '../paths.mjs'
import { createLauncher, PRODUCT_STATE_TEXT } from './launcher.mjs'
import { DEFAULT_BACKOFF } from './supervisor.mjs'

/** 支持的 CLI 参数（也是 `--help` 的唯一来源）。 */
export const CLI_FLAGS = Object.freeze([
  { name: '--check', kind: 'boolean', doc: '只做启动前体检（端口/入口/依赖/目录边界），不启动任何进程' },
  { name: '--json', kind: 'boolean', doc: '以 JSON 输出结果（供脚本与验收使用）' },
  { name: '--install-dir=<path>', kind: 'value', doc: `安装目录；等价于 ${LEGION_ENV.INSTALL_DIR}` },
  { name: '--data-dir=<path>', kind: 'value', doc: `数据目录；等价于 ${LEGION_ENV.DATA_DIR}` },
  { name: '--workspace=<path>', kind: 'value', doc: `工作区目录；等价于 ${LEGION_ENV.WORKSPACE_DIR}` },
  { name: '--port.<进程>=<n>', kind: 'value', doc: '覆盖某进程端口，如 --port.team-hub=9000' },
  { name: '--include=<a,b>', kind: 'value', doc: '只启动列出的进程（受限范围；产品状态不会被报成「已就绪」）' },
  { name: '--runtime-command=<cmd>', kind: 'value', doc: 'DSH Runtime 的启动命令行（PRT-011 路线 C：Launcher 把 npm 包装进 DataDir）' },
  { name: '--allow-port-in-use=<a,b>', kind: 'value', doc: '允许复用已在监听的端口的进程（显式决定，不是默认行为）' },
  { name: '--help', kind: 'boolean', doc: '打印本说明' },
])

/**
 * 解析 argv。**只接受 `--k=v` 与布尔开关**，不接受位置参数：
 * 位置参数的含义随「第几个」变化，是脚本化调用最容易出错的地方。
 */
export function parseArgs(argv) {
  const out = { ports: {}, flags: {}, errors: [] }
  for (const raw of argv) {
    if (raw === '--check' || raw === '--json' || raw === '--help') {
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
    const known = ['install-dir', 'data-dir', 'workspace', 'include', 'runtime-command', 'allow-port-in-use']
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

/** 组装 Launcher 选项（把 CLI 与环境合成一份显式输入）。 */
export function launcherOptionsFrom({ argv = [], env = {}, nodePath = process.execPath } = {}) {
  const parsed = parseArgs(argv)
  const declared = readEnv(env)
  const { layout, diagnostics } = resolveLayout({
    installDir: parsed.flags['install-dir'] ?? null,
    dataDir: parsed.flags['data-dir'] ?? null,
    workspaceDir: parsed.flags.workspace ?? null,
    env: declared,
  })
  const include = parsed.flags.include === undefined
    ? null
    : String(parsed.flags.include).split(',').map((s) => s.trim()).filter(Boolean)
  const allowPortInUse = parsed.flags['allow-port-in-use'] === undefined
    ? []
    : String(parsed.flags['allow-port-in-use']).split(',').map((s) => s.trim()).filter(Boolean)
  const readinessTimeout = readReadinessTimeoutMs(env)
  return {
    parsed,
    layout,
    layoutDiagnostics: diagnostics,
    options: {
      layout,
      ports: parsed.ports,
      include,
      allowPortInUse,
      runtimeCommand: parsed.flags['runtime-command'] ?? null,
      nodePath,
      // Launcher 自己的环境只作为**白名单的读取来源**传入，不会被整份复制给子进程
      baseEnv: env,
      readiness: readinessTimeout === null ? {} : { timeoutMs: readinessTimeout },
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

  const { parsed, options, layoutDiagnostics } = launcherOptionsFrom({ argv, env })
  if (parsed.errors.length > 0) {
    for (const e of parsed.errors) write(`✖ ${e}`)
    return 2
  }

  const json = parsed.flags.json === true
  const launcher = createLauncher(options)

  // 目录布局诊断在**创建 Launcher 之前**就已经拿到（resolveLayout 的返回），
  // 而它在 createLauncher 内部还会再算一次。这里用它的原因是：
  // 「工作区未配置」这类问题必须在**任何进程启动之前**以用户能懂的话说出来。
  if (layoutDiagnostics.some((d) => d.severity === 'error')) {
    if (json) write(JSON.stringify({ ok: false, phase: 'layout', diagnostics: layoutDiagnostics }, null, 2))
    else {
      write('✖ Legion 无法启动：目录布局未确定')
      printDiagnostics(layoutDiagnostics, write)
    }
    return 3
  }

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

export { DEFAULT_BACKOFF }
