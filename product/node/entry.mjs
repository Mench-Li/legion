#!/usr/bin/env node
// product/node/entry.mjs
// ============================================================================
// Legion Node 命令行入口（远程 Agent 通道 S-E 之五）
//
// 用法：
//   node product/node/entry.mjs pair  --hub https://HOST --code <配对码> --out node-config.json
//           [--workspace <空间>=<目录>]… [--agent <程序>] [--agent-arg <参数>]…
//   node product/node/entry.mjs check --config node-config.json
//   node product/node/entry.mjs run   --config node-config.json
//
// ## 为什么配置里存的是**设备令牌**而不是账号口令
//
// 这台机器需要的凭据只回答"我是哪台机器"，它不该回答"我是谁"。用账号凭据跑一个
// 常驻进程，意味着那台机器上一份可读的文件里躺着一个能登录全部空间的秘密；
// 而设备令牌的作用域只有"这个用户把这个空间交给这台机器跑任务"，且可以单独撤销
// （设计文档 §10）。
//
// ## 配对码只出现一次
//
// `pair` 把配对码换成设备令牌，令牌落进配置文件（权限 0600），配对码本身不保存。
// 配对码一次性 + 短时 + 限速，所以它被记进 shell 历史的风险远小于长期令牌。
// ============================================================================
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createNodeAgent } from './agent.mjs'
import { createCommandExecutor } from './executor.mjs'
import { createRunLedger } from './ledger.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 本入口脚本的路径，**尽量相对当前目录**。
 *
 * 提示里要给出"照着再跑一次"的命令，而绝对路径在分享/换机器时是错的、
 * 也长得让人不想看。`relative` 算不出来（跨盘符）时回落到绝对路径——
 * 那种情况下给一个错的相对路径比给一个长的绝对路径更坏。
 */
function relEntry() {
  const abs = fileURLToPath(import.meta.url)
  const rel = relative(process.cwd(), abs)
  return rel.length > 0 && !rel.startsWith('..') ? rel.replace(/\\/g, '/') : abs.replace(/\\/g, '/')
}

function parseArgv(argv) {
  const [command, ...rest] = argv
  const opts = {}
  // 这两个可以给多次（多个工作区、多个执行器参数），所以收成数组。
  // 其余保持"后写覆盖前写"——命令行上重复给同一个单值参数，最后一次生效
  // 是所有人的预期。
  const REPEATABLE = new Set(['workspace', 'agent-arg'])
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]
    if (!a.startsWith('--')) throw new Error(`未知参数：${a}`)
    const key = a.slice(2)
    const value = rest[i + 1]
    if (value === undefined || value.startsWith('--')) opts[key] = true
    else {
      if (REPEATABLE.has(key)) (opts[key] ??= []).push(value)
      else opts[key] = value
      i += 1
    }
  }
  return { command, opts }
}

const USAGE = `Legion Node

  node product/node/entry.mjs pair  --hub <https://hub> --code <配对码> [--out <路径>]
        [--workspace <空间>=<目录>]…  允许这台机器访问的目录（可多次）
        [--agent <程序>] [--agent-arg <参数>]…  真正执行任务的命令
  node product/node/entry.mjs check --config <路径>
  node product/node/entry.mjs run   --config <路径>

配对：把一个一次性的配对码换成这台机器的设备令牌，写进配置文件。
check：只校验配置与工作区，不连 Hub。
run：连上 Hub 并开始接任务。`

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}

/** 校验并归一化配置。返回 `{ ok, config, problems }`。 */
export function validateConfig(raw) {
  const problems = []
  const config = {
    hubUrl: String(raw?.hubUrl ?? ''),
    deviceToken: String(raw?.deviceToken ?? ''),
    nodeId: String(raw?.nodeId ?? ''),
    workspaces: {},
    agent: raw?.agent ?? null,
    ledgerFile: raw?.ledgerFile ?? null,
    heartbeatIntervalMs: Number.isSafeInteger(raw?.heartbeatIntervalMs) ? raw.heartbeatIntervalMs : undefined,
  }
  if (!/^wss?:\/\//.test(config.hubUrl)) {
    problems.push('hubUrl 必须以 ws:// 或 wss:// 开头（生产环境用 wss://），例如 wss://example/node')
  }
  if (config.deviceToken.length === 0) problems.push('缺少 deviceToken：先用 `pair` 子命令配对')
  if (config.nodeId.length === 0) problems.push('缺少 nodeId：先用 `pair` 子命令配对')
  for (const [scope, ws] of Object.entries(raw?.workspaces ?? {})) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(scope)) { problems.push(`空间名非法：${scope}`); continue }
    if (typeof ws?.path !== 'string' || ws.path.length === 0) { problems.push(`空间 ${scope} 缺少 path`); continue }
    if (!existsSync(ws.path)) { problems.push(`空间 ${scope} 的工作区不存在：${ws.path}`); continue }
    config.workspaces[scope] = { path: resolve(ws.path), label: ws.label ?? scope }
  }
  if (Object.keys(config.workspaces).length === 0) {
    problems.push('未配置任何工作区：Node 会拒收所有任务（这是刻意的，见 agent.mjs 的 NO_WORKSPACE）')
  }
  if (config.agent === null || typeof config.agent?.command !== 'string' || config.agent.command.length === 0) {
    problems.push('缺少 agent.command：Node 不知道要用什么执行任务')
  } else if (isBareInterpreter(config.agent)) {
    // ★ `pair` 生成的默认值就是"裸 node、没有参数"——而它**跑不了任何任务**。
    //
    //   原来的判据只看"command 是不是非空字符串"，于是这个默认值**一路过关**：
    //   `check` 打印「配置看起来可用」，还把它当执行器显示出来。而 `run` 起来之后
    //   裸 node 会去把 stdin 当脚本读——表现为"连上了但任务永远不动"。
    //
    //   > 一个"校验通过、却跑不了"的配置，与一个"校验不通过"的配置，
    //   > 在用户那边是两种不同的坏法：后者他当场就知道要改，
    //   > 前者要等到他看见任务卡住、再去猜是哪儿的问题。
    //
    //   只拦这一种确切形状（解释器本身 + 零参数），不拦"node + 脚本路径"——
    //   那是完全合法的用法。
    problems.push('agent.command 是**裸解释器**（没有任何参数）：它不会执行任务，只会把 stdin 当脚本读'
      + '。请给出真正干活的命令，例如 `--agent <程序路径> --agent-arg <参数>`')
  }
  return { ok: problems.length === 0, config, problems }
}

/** `agent.command` 是不是"就是那个解释器自己、且没有参数"——那种配置执行不了任务。 */
function isBareInterpreter(agent) {
  const args = Array.isArray(agent?.args) ? agent.args : []
  if (args.length > 0) return false
  const cmd = String(agent?.command ?? '')
  // 比 basename：`D:\software\nodejs\node.exe` 与 `node` 都要认出来。
  const base = cmd.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  return base === 'node' || base === 'node.exe' || cmd === process.execPath
}

/** 不带主机口径的 hub origin → `wss://host/node`。 */
export function nodeUrlFromHub(hub) {
  const url = new URL(hub)
  const secure = url.protocol === 'https:'
  return `${secure ? 'wss' : 'ws'}://${url.host}/node`
}

export function configFromPairing({ hub, pairing, workspaces = null, agent = null }) {
  return {
    hubUrl: nodeUrlFromHub(hub),
    deviceToken: pairing.deviceToken,
    nodeId: pairing.nodeId,
    // ★ 空 workspaces + 指向"一个不带脚本的 node"的 agent.command，
    //   是**注定被 `check` 拒掉**的默认值（"未配置任何工作区" / 缺 agent.command）。
    //   保留它们是因为"没有默认值"会让配置文件缺字段，而缺字段与"配了个空"在
    //   校验里长得一样。真正的解法是让 `pair` 能**一次配好**——见 doPair。
    workspaces: workspaces ?? {},
    agent: agent ?? { command: process.execPath, args: [], timeoutMs: 30 * 60 * 1000 },
    ledgerFile: resolve(dirname(HERE), 'node-ledger.json'),
  }
}

/** `--workspace <scope>=<path>` → `{ scope: { path } }`。给错格式就具名拒绝。 */
function parseWorkspaces(list) {
  if (list === undefined) return null
  const out = {}
  for (const item of list) {
    const eq = String(item).indexOf('=')
    if (eq <= 0) throw new Error(`--workspace 要写成 <空间>=<路径>，收到：${item}`)
    const scope = String(item).slice(0, eq).trim()
    const path = String(item).slice(eq + 1).trim()
    if (scope.length === 0 || path.length === 0) throw new Error(`--workspace 的空间名与路径都不能为空：${item}`)
    out[scope] = { path }
  }
  return out
}

async function doPair(opts) {
  if (typeof opts.hub !== 'string') { fail('pair 需要 --hub <https://…>'); return }
  if (typeof opts.code !== 'string') { fail('pair 需要 --code <配对码>（在手机的设备页生成）'); return }
  const endpoint = new URL('/api/devices/pair', opts.hub)
  let payload
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: opts.code, platform: `${process.platform}-${process.arch}`, protocolVersion: 1 }),
    })
    payload = await res.json()
    if (!res.ok || payload.ok !== true) { fail(`配对失败：${res.status} ${payload.error ?? ''}（${payload.code ?? ''}）`); return }
  } catch (e) {
    fail(`无法连接 Hub：${e.message}`)
    return
  }
  const out = typeof opts.out === 'string' ? resolve(opts.out) : resolve(process.cwd(), 'node-config.json')
  let workspaces = null
  let agent = null
  try {
    workspaces = parseWorkspaces(opts.workspace)
    if (typeof opts.agent === 'string') {
      agent = { command: opts.agent, args: opts['agent-arg'] ?? [], timeoutMs: 30 * 60 * 1000 }
    }
  } catch (e) { fail(e.message); return }
  const config = configFromPairing({ hub: opts.hub, pairing: payload, workspaces, agent })
  writeFileSync(out, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 })
  try { chmodSync(out, 0o600) } catch { /* Windows 上 chmod 语义有限 */ }

  const lines = [
    `已配对。设备 ${payload.nodeId}（${payload.name}），能力：${payload.capabilities.join(', ')}`,
    `配置写到 ${out}（权限 0600）`,
  ]
  // ★ 配对成功 ≠ 配置可用。默认值注定被 `check` 拒，所以这里**如实分开说**：
  //   还需要什么、缺了会怎样、以及补它的**确切命令**。
  //   一条"配置写到 X"的成功消息，与一条"但其实它跑不起来"的成功消息，
  //   在只看最后一行的人眼里是同一个东西。
  if (workspaces === null || agent === null) {
    lines.push('', '⚠ 这份配置**还不能跑**——check 会拒它。还缺：')
    if (workspaces === null) {
      lines.push('  · workspaces：允许这台机器访问哪个目录')
      lines.push(`      node ${relEntry()} pair … --workspace default=${process.cwd().replace(/\\/g, '/')}`)
    }
    if (agent === null) {
      lines.push('  · agent.command：这台机器上真正执行任务的程序')
      lines.push(`      node ${relEntry()} pair … --agent <程序路径> --agent-arg <参数> --agent-arg <参数>`)
    }
    lines.push('', '补完再跑：node ' + relEntry() + ' check --config ' + out)
  } else {
    lines.push('', '直接跑：node ' + relEntry() + ' check --config ' + out)
  }
  process.stdout.write(lines.join('\n') + '\n')
}

function loadConfig(path) {
  const file = resolve(path)
  if (!existsSync(file)) throw new Error(`配置文件不存在：${file}`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

function doCheck(opts) {
  if (typeof opts.config !== 'string') { fail('check 需要 --config <路径>'); return }
  let raw
  try { raw = loadConfig(opts.config) } catch (e) { fail(e.message); return }
  const { ok, config, problems } = validateConfig(raw)
  if (!ok) {
    const lines = [`配置有问题：`, ...problems.map((p) => `  - ${p}`)]
    // ★ 缺什么就**给出可直接粘的片段**，而不是只报"缺"。
    //
    //   `pair` 的默认配置注定被这里拒（空 workspaces + 没脚本的 node），
    //   所以这条路径是**必走**的。只报问题的话，用户手上是一份要照着自己编
    //   JSON 的活——而字段名与嵌套形状都不是能猜出来的。
    //
    //   > 一个只说"缺 workspaces"的检查，与一个给出确切 JSON 的检查，
    //   > 在"用户能不能自己修好"这件事上差别很大——而前者看起来也完成了工作。
    const missing = problems.join('\n')
    const patch = {}
    if (/未配置任何工作区|缺少 path|工作区不存在/.test(missing)) {
      patch.workspaces = { default: { path: '<改成这台机器上允许被访问的目录，绝对路径>' } }
    }
    if (/缺少 agent\.command|裸解释器/.test(missing)) {
      patch.agent = { command: '<真正执行任务的程序，如 DSH / Claude Code>', args: [], timeoutMs: 1800000 }
    }
    if (Object.keys(patch).length > 0) {
      lines.push('', '把这部分并进配置文件（合并，不是整份替换）：', JSON.stringify(patch, null, 2))
      lines.push('', '或者重新配一次、这次带上参数：')
      if (patch.workspaces !== undefined) {
        lines.push(`  node ${relEntry()} pair --hub <hub> --code <新码> --workspace default=${process.cwd().replace(/\\/g, '/')} …`)
      }
      if (patch.agent !== undefined) {
        lines.push(`  node ${relEntry()} pair --hub <hub> --code <新码> --agent <程序路径> --agent-arg <参数> …`)
      }
      lines.push('', '★ 配对码是一次性的：走第二条路要先在设备页**重新生成一个**。')
    }
    process.stdout.write(lines.join('\n') + '\n')
    process.exitCode = 1
    return
  }
  process.stdout.write([
    '配置看起来可用：',
    `  Hub：${config.hubUrl}`,
    `  设备：${config.nodeId}`,
    `  工作区：${Object.entries(config.workspaces).map(([s, w]) => `${s} → ${w.path}`).join('；')}`,
    `  执行器：${config.agent.command} ${(config.agent.args ?? []).join(' ')}`,
    '',
    '注意：check 不连 Hub，也不验证设备令牌是否仍然有效。用 `run` 才知道。',
  ].join('\n') + '\n')
}

function doRun(opts) {
  if (typeof opts.config !== 'string') { fail('run 需要 --config <路径>'); return }
  let raw
  try { raw = loadConfig(opts.config) } catch (e) { fail(e.message); return }
  const { ok, config, problems } = validateConfig(raw)
  if (!ok) { fail(`配置有问题，拒绝启动：\n  - ${problems.join('\n  - ')}`); return }

  const ledger = createRunLedger({ file: config.ledgerFile })
  const executor = createCommandExecutor({
    command: config.agent.command,
    args: Array.isArray(config.agent.args) ? config.agent.args : [],
    timeoutMs: config.agent.timeoutMs,
    onLocalLog: (line) => process.stderr.write(`[exec] ${line}\n`),
  })
  const agent = createNodeAgent({
    hubUrl: config.hubUrl,
    deviceToken: config.deviceToken,
    nodeId: config.nodeId,
    workspaces: config.workspaces,
    executor,
    ledger,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
  })
  agent.start()
  process.stdout.write(`Node 已启动：${config.nodeId} → ${config.hubUrl}\n`)

  const shutdown = (signal) => {
    process.stdout.write(`收到 ${signal}，停止中（正在跑的任务会被中断，结果会记进账本）\n`)
    agent.stop({ reason: signal })
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

async function main() {
  const { command, opts } = parseArgv(process.argv.slice(2))
  if (command === undefined || command === '--help' || command === '-h' || opts.help === true) {
    process.stdout.write(USAGE + '\n')
    return
  }
  if (command === 'pair') return doPair(opts)
  if (command === 'check') return doCheck(opts)
  if (command === 'run') return doRun(opts)
  fail(`未知子命令：${command}\n\n${USAGE}`)
}

// 被 import 时（测试）不执行主流程。
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
