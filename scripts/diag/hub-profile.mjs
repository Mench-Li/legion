#!/usr/bin/env node
// 抓 hub 的 CPU 火焰图（不重启、不停服务）。
//
// 用法：
//   node scripts/diag/hub-profile.mjs                 # 自身耗时 Top 10
//   node scripts/diag/hub-profile.mjs --chains        # 调用栈 Top（追"谁在调它"）
//   node scripts/diag/hub-profile.mjs --pid 1234 --ms 4000
//
// 前置：Node 支持给运行中的进程动态挂 inspector——
//   node -e "process._debugProcess(<pid>)"
// 本脚本会自己尝试这一步（失败则提示手动执行）。
//
// 为什么要有这个脚本：hub 卡死时"重启看日志"几乎永远是错的诊断方向
// （日志停在崩溃前最后一行业务动作上，而 CPU 自旋根本不写日志）。
// 真实案例见 docs/RUNBOOK-HUB-TROUBLESHOOTING.md。
import { execFileSync } from 'node:child_process'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const chains = process.argv.includes('--chains')
const durationMs = Number(arg('ms', 3000))
const port = 9229

function hubPid() {
  const explicit = arg('pid', null)
  if (explicit) return Number(explicit)
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      "(Get-NetTCPConnection -LocalPort 8787 -State Listen | Select-Object -First 1).OwningProcess"], { encoding: 'utf8' })
    return Number(out.trim())
  } catch {
    return null
  }
}

async function inspectorUrl() {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    return list?.[0]?.webSocketDebuggerUrl ?? null
  } catch {
    return null
  }
}

const pid = hubPid()
if (!pid) {
  console.error('找不到 hub 进程（8787 未监听？）。用 --pid 显式指定。')
  process.exit(2)
}

let url = await inspectorUrl()
if (!url) {
  try {
    execFileSync(process.execPath, ['-e', `process._debugProcess(${pid})`], { stdio: 'inherit' })
  } catch {
    console.error(`挂 inspector 失败。请手动执行：node -e "process._debugProcess(${pid})"`)
    process.exit(3)
  }
  for (let i = 0; i < 20 && !url; i++) {
    await new Promise((r) => setTimeout(r, 250))
    url = await inspectorUrl()
  }
}
if (!url) {
  console.error('inspector 已挂上但 CDP 端点不可达（9229）。')
  process.exit(4)
}

const ws = new WebSocket(url)
let seq = 0
const pending = new Map()
const send = (method, params) => new Promise((resolve, reject) => {
  const id = ++seq
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
})
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(msg.error.message))
    else p.resolve(msg.result)
  }
}
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })

await send('Profiler.enable')
await send('Profiler.setSamplingInterval', { interval: 250 })
await send('Profiler.start')
await new Promise((r) => setTimeout(r, durationMs))
const { profile } = await send('Profiler.stop')
ws.close()

const byId = new Map(profile.nodes.map((n) => [n.id, n]))
const parentOf = new Map()
for (const n of profile.nodes) for (const c of n.children ?? []) parentOf.set(c, n.id)
const nameOf = (n) => {
  const cf = n.callFrame
  const file = String(cf.url).split(/[\\/]/).pop()
  return `${cf.functionName || '(anon)'}@${file}:${cf.lineNumber + 1}`
}

const totals = new Map()
for (let i = 0; i < profile.samples.length; i++) {
  const delta = profile.timeDeltas[i] ?? 1
  if (chains) {
    const stack = []
    let cur = profile.samples[i]
    for (let guard = 0; cur !== undefined && guard < 8; guard++) {
      stack.push(nameOf(byId.get(cur)))
      cur = parentOf.get(cur)
    }
    const key = stack.join('  <-  ')
    totals.set(key, (totals.get(key) ?? 0) + delta)
  } else {
    const key = nameOf(byId.get(profile.samples[i]))
    totals.set(key, (totals.get(key) ?? 0) + delta)
  }
}
const total = [...totals.values()].reduce((a, b) => a + b, 0)
const rows = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)

console.log(`pid=${pid} 采样 ${profile.samples.length} 个 / ${(total / 1000).toFixed(0)}ms  ${chains ? '（调用栈）' : '（自身耗时）'}`)
for (const [key, us] of rows) {
  console.log(`${(100 * us / total).toFixed(1).padStart(5)}%  ${key}`)
}
console.log('\n判读：exec/prepare/get/run = SQLite；GC 高 = 大结果集读成对象；')
console.log('      --chains 才能看出"谁触发了它"（业务请求 vs 定时任务）。')
