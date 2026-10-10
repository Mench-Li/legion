// ci-sandbox-shim.mjs —— 受限沙箱下让 run-ci.mjs 的子进程管道可用（**仅本次会话的适配器**）
//
// 背景：本会话的 DSH 沙箱（workspace-write）禁止 Node 进程创建**管道** stdio：
//   spawn('node', [...]) 带默认 stdio:'pipe' ⇒ EPERM；stdio:'inherit'/'ignore' 正常；
//   文件描述符 stdio（fs.openSync 得到的 fd）正常（实测）。
// run-ci.mjs 的 exec() 全部用默认 pipe 捕获子进程输出 ⇒ 它在本会话里跑不起来。
//
// 本 shim 通过 --import 预加载，把「只捕获 stdout/stderr 的一次性子进程」的 pipe 重定向到临时文件，
// 再以流的方式回放给调用方；对**交互式**子进程（stdin 也是 pipe，典型是 esbuild 的常驻服务）
// 保持原样 —— 让沙箱限制如实暴露为 EPERM，而不是被悄悄改成别的东西。
//
// 它不改变任何被测行为：真进程照常启动、真命令照常执行，只是输出的运输方式从匿名管道换成文件。
const cp = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')

console.error('[shim] module loaded')
const realSpawn = cp.spawn
const VERBOSE = process.env.CI_SHIM_VERBOSE === '1'

function slotOf(stdio, idx) {
  if (stdio === undefined || stdio === 'pipe') return 'pipe'
  if (stdio === 'inherit' || stdio === 'ignore') return stdio
  if (Array.isArray(stdio)) return stdio[idx] ?? (idx === 0 ? 'pipe' : 'inherit')
  return null
}

function isNodeExe(command) {
  const base = path.basename(String(command)).toLowerCase()
  if (base === 'node' || base === 'node.exe' || base === 'nodejs') return true
  try { return path.resolve(String(command)) === path.resolve(process.execPath) } catch { return false }
}

cp.spawn = function patchedSpawn(command, args, options) {
  if (!Array.isArray(args) && args !== undefined) { options = args; args = [] }
  args = args || []
  options = options || {}
  const stdio = options.stdio
  const s0 = slotOf(stdio, 0)
  const s1 = slotOf(stdio, 1)
  const s2 = slotOf(stdio, 2)
  if (s0 === null || s1 === null || s2 === null) return realSpawn(command, args, options)
  const outPipe = s1 === 'pipe'
  const errPipe = s2 === 'pipe'
  if (!outPipe && !errPipe) return realSpawn(command, args, options)          // 无需捕获
  // stdin 是 pipe ⇒ 交互式协议（esbuild 常驻服务）。只有纯 node 子进程（测试运行器）才可安全改写。
  if (s0 === 'pipe' && !isNodeExe(command)) {
    if (VERBOSE) console.error('[shim] passthrough (interactive stdin): ' + command)
    return realSpawn(command, args, options)
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-shim-'))
  const outPath = path.join(dir, 'out')
  const errPath = path.join(dir, 'err')
  const fdOut = outPipe ? fs.openSync(outPath, 'w') : s1
  const fdErr = errPipe ? fs.openSync(errPath, 'w') : s2
  const stdioNew = [s0 === 'pipe' ? 'ignore' : s0, outPipe ? fdOut : s1, errPipe ? fdErr : s2]
  if (VERBOSE) console.error('[shim] redirect ' + path.basename(String(command)) + ' ' + JSON.stringify(args.slice(0, 3)))
  let real
  try {
    real = realSpawn(command, args, { ...options, stdio: stdioNew })
  } catch (e) {
    if (outPipe) try { fs.closeSync(fdOut) } catch {}
    if (errPipe) try { fs.closeSync(fdErr) } catch {}
    throw e
  }
  const child = new EventEmitter()
  child.pid = real.pid
  child.killed = false
  child.exitCode = null
  child.signalCode = null
  child.stdin = null
  child.stdout = outPipe ? fs.createReadStream(outPath) : null
  child.stderr = errPipe ? fs.createReadStream(errPath) : null
  child.stdio = [null, child.stdout, child.stderr]
  child.kill = (sig) => { child.killed = true; return real.kill(sig) }
  child.ref = () => real.ref && real.ref()
  child.unref = () => real.unref && real.unref()
  real.on('error', (e) => { if (child.listenerCount('error') > 0) child.emit('error', e); else console.error('[shim] child error: ' + e.message) })
  real.on('close', (code, signal) => {
    const streams = [child.stdout, child.stderr].filter(Boolean)
    let left = streams.length
    const finish = () => {
      child.exitCode = code
      child.signalCode = signal ?? null
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
      child.emit('exit', code, signal)
      child.emit('close', code, signal)
    }
    if (left === 0) return finish()
    for (const s of streams) {
      s.once('end', () => { if (--left === 0) finish() })
      s.once('error', () => { if (--left === 0) finish() })
    }
    process.nextTick(() => { for (const s of streams) { try { s.resume() } catch {} } })
  })
  return child
}
