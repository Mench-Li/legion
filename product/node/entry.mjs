#!/usr/bin/env node
// product/node/entry.mjs
// ============================================================================
// Legion Node 命令行入口（远程 Agent 通道 S-E 之五）
//
// 用法：
//   node product/node/entry.mjs pair  --hub https://HOST --code <配对码> --out node-config.json
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
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createNodeAgent } from './agent.mjs'
import { createCommandExecutor } from './executor.mjs'
import { createRunLedger } from './ledger.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

function parseArgv(argv) {
  const [command, ...rest] = argv
  const opts = {}
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]
    if (!a.startsWith('--')) throw new Error(`未知参数：${a}`)
    const key = a.slice(2)
    const value = rest[i + 1]
    if (value === undefined || value.startsWith('--')) opts[key] = true
    else { opts[key] = value; i += 1 }
  }
  return { command, opts }
}

const USAGE = `Legion Node

  node product/node/entry.mjs pair  --hub <https://hub> --code <配对码> [--out <路径>]
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
  }
  return { ok: problems.length === 0, config, problems }
}

/** 不带主机口径的 hub origin → `wss://host/node`。 */
export function nodeUrlFromHub(hub) {
  const url = new URL(hub)
  const secure = url.protocol === 'https:'
  return `${secure ? 'wss' : 'ws'}://${url.host}/node`
}

export function configFromPairing({ hub, pairing }) {
  return {
    hubUrl: nodeUrlFromHub(hub),
    deviceToken: pairing.deviceToken,
    nodeId: pairing.nodeId,
    workspaces: {},
    agent: { command: process.execPath, args: [], timeoutMs: 30 * 60 * 1000 },
    ledgerFile: resolve(dirname(HERE), 'node-ledger.json'),
  }
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
  const config = configFromPairing({ hub: opts.hub, pairing: payload })
  writeFileSync(out, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 })
  try { chmodSync(out, 0o600) } catch { /* Windows 上 chmod 语义有限 */ }
  process.stdout.write([
    `已配对。设备 ${payload.nodeId}（${payload.name}），能力：${payload.capabilities.join(', ')}`,
    `配置写到 ${out}（权限 0600）`,
    '',
    '还需要手工补两件事，然后 `check`：',
    '  1. workspaces：把允许这台机器访问的空间 → 工作区路径填进去；',
    '  2. agent.command/args：这台机器上真正执行任务的命令。',
  ].join('\n') + '\n')
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
    process.stdout.write(`配置有问题：\n  - ${problems.join('\n  - ')}\n`)
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
