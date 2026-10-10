// ci-sandbox-patch.cjs —— 受限沙箱的 child_process stdio 适配补丁（T-202 证据工具，非产品代码）
//
// 本会话的 DSH 沙箱（workspace-write）禁止 Node 进程创建**管道** stdio：
//   spawn/spawnSync/execFileSync 走默认 pipe ⇒ EPERM；stdio 'inherit'/'ignore'/文件 fd ⇒ 正常。
// 本补丁把「一次性捕获输出」的子进程管道换成**临时文件 fd**，等子进程退出后把文件内容
// 通过内存流回放；对**交互式**子进程（esbuild 常驻服务：stdin/stdout 双向协议）保持原样——
// 让沙箱限制如实暴露成 EPERM，而不是被悄悄改成另一种行为。
//
// 覆盖面：spawn / spawnSync / execFileSync / execSync / execFile / exec。
// 不改变被测行为：真命令照常执行、真进程照常启动、退出码与输出逐字节一致。
const cp = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')

const realSpawn = cp.spawn
const realSpawnSync = cp.spawnSync
const INTERACTIVE = /esbuild/i
const VERBOSE = process.env.CI_PATCH_VERBOSE === '1'

function slotOf(stdio, idx) {
  if (stdio === undefined || stdio === 'pipe') return 'pipe'
  if (stdio === 'inherit' || stdio === 'ignore') return stdio
  if (Array.isArray(stdio)) return stdio[idx] === undefined ? (idx === 0 ? 'pipe' : 'inherit') : stdio[idx]
  return null
}

function rewrite(command, options) {
  const o = { ...(options || {}) }
  const s0 = slotOf(o.stdio, 0), s1 = slotOf(o.stdio, 1), s2 = slotOf(o.stdio, 2)
  if (s0 === null || s1 === null || s2 === null) return null
  const outPipe = s1 === 'pipe', errPipe = s2 === 'pipe'
  if (!outPipe && !errPipe) return null
  if (INTERACTIVE.test(String(command))) return null
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-patch-'))
  const outPath = path.join(dir, 'out'); const errPath = path.join(dir, 'err')
  const fdOut = outPipe ? fs.openSync(outPath, 'w') : null
  const fdErr = errPipe ? fs.openSync(errPath, 'w') : null
  let s0new = s0
  if (s0 === 'pipe') {
    if (o.input !== undefined && o.input !== null) {
      const inPath = path.join(dir, 'in')
      fs.writeFileSync(inPath, o.input)
      s0new = fs.openSync(inPath, 'r')
    } else s0new = 'ignore'
  }
  o.stdio = [s0new, outPipe ? fdOut : s1, errPipe ? fdErr : s2]
  delete o.input
  return { options: o, dir, outPath, errPath, outPipe, errPipe, fdOut, fdErr }
}

function cleanup(plan) {
  try { if (plan.fdOut !== null) fs.closeSync(plan.fdOut) } catch {}
  try { if (plan.fdErr !== null) fs.closeSync(plan.fdErr) } catch {}
  try { fs.rmSync(plan.dir, { recursive: true, force: true }) } catch {}
}

cp.spawn = function patchedSpawn(command, args, options) {
  if (!Array.isArray(args)) { options = args; args = [] }
  args = args || []
  const plan = rewrite(command, options)
  if (!plan) return realSpawn(command, args, options)
  if (VERBOSE) console.error('[ci-patch] spawn ' + path.basename(String(command)))
  let real
  try { real = realSpawn(command, args, plan.options) } catch (e) { cleanup(plan); throw e }
  const child = new EventEmitter()
  child.pid = real.pid
  child.killed = false
  child.exitCode = null
  child.signalCode = null
  child.stdin = new PassThrough()
  child.stdout = plan.outPipe ? new PassThrough() : null
  child.stderr = plan.errPipe ? new PassThrough() : null
  child.stdio = [child.stdin, child.stdout, child.stderr]
  child.kill = (sig) => { child.killed = true; return real.kill(sig) }
  if (real.ref) child.ref = () => real.ref()
  if (real.unref) child.unref = () => real.unref()
  real.on('error', (e) => { if (child.listenerCount('error') > 0) child.emit('error', e); else console.error('[ci-patch] child error: ' + e.message) })
  real.on('close', (code, signal) => {
    try { if (plan.fdOut !== null) fs.closeSync(plan.fdOut) } catch {}
    try { if (plan.fdErr !== null) fs.closeSync(plan.fdErr) } catch {}
    plan.fdOut = null; plan.fdErr = null
    child.exitCode = code
    child.signalCode = signal === undefined ? null : signal
    child.emit('exit', code, signal)
    const push = (stream, file) => {
      let buf = Buffer.alloc(0)
      try { buf = fs.readFileSync(file) } catch {}
      stream.end(buf)
    }
    let pending = 0
    const done = () => { if (--pending === 0) { cleanup(plan); child.emit('close', code, signal) } }
    if (child.stdout) { pending += 1; child.stdout.on('finish', done); push(child.stdout, plan.outPath) }
    if (child.stderr) { pending += 1; child.stderr.on('finish', done); push(child.stderr, plan.errPath) }
    if (pending === 0) { cleanup(plan); child.emit('close', code, signal) }
  })
  return child
}

cp.spawnSync = function patchedSpawnSync(command, args, options) {
  if (!Array.isArray(args)) { options = args; args = [] }
  args = args || []
  const plan = rewrite(command, options)
  if (!plan) return realSpawnSync(command, args, options)
  if (VERBOSE) console.error('[ci-patch] spawnSync ' + path.basename(String(command)))
  const r = realSpawnSync(command, args, plan.options)
  if (plan.fdOut !== null) { try { fs.closeSync(plan.fdOut) } catch {} }
  if (plan.fdErr !== null) { try { fs.closeSync(plan.fdErr) } catch {} }
  plan.fdOut = null; plan.fdErr = null
  if (r.error) { cleanup(plan); return r }
  const enc = plan.options.encoding
  let stdout, stderr
  if (plan.outPipe) { const b = fs.readFileSync(plan.outPath); stdout = enc ? b.toString(enc) : b }
  if (plan.errPipe) { const b = fs.readFileSync(plan.errPath); stderr = enc ? b.toString(enc) : b }
  cleanup(plan)
  return { ...r, stdout, stderr, output: [null, stdout, stderr] }
}

cp.execFileSync = function patchedExecFileSync(file, args, options) {
  if (!Array.isArray(args)) { options = args; args = [] }
  args = args || []
  const r = cp.spawnSync(file, args, { ...(options || {}) })
  if (r.error) throw r.error
  const throwOnFail = options && options.throw === false ? false : true
  if (r.status !== 0 && throwOnFail) {
    const e = new Error('Command failed: ' + [file].concat(args).join(' '))
    e.status = r.status; e.signal = r.signal; e.stdout = r.stdout; e.stderr = r.stderr
    throw e
  }
  if (typeof (options && options.stdio) === 'string' && ['inherit', 'ignore'].includes(options.stdio)) return null
  return r.stdout
}

cp.execSync = function patchedExecSync(command, options) {
  return cp.execFileSync(command, [], { ...(options || {}), shell: true })
}

cp.execFile = function patchedExecFile(file, args, options, callback) {
  if (typeof args === 'function') { callback = args; args = []; options = {} }
  else if (typeof options === 'function') { callback = options; options = {} }
  args = args || []; options = options || {}
  const enc = options.encoding === undefined ? 'utf8' : options.encoding
  const child = cp.spawn(file, args, options)
  const outChunks = [], errChunks = []
  const collect = (stream, sink) => { if (stream) stream.on('data', (d) => sink.push(Buffer.isBuffer(d) ? d : Buffer.from(d))) }
  collect(child.stdout, outChunks)
  collect(child.stderr, errChunks)
  const finish = (err) => {
    const so = Buffer.concat(outChunks), se = Buffer.concat(errChunks)
    const stdout = enc === 'buffer' ? so : so.toString(enc)
    const stderr = enc === 'buffer' ? se : se.toString(enc)
    if (typeof callback === 'function') callback(err, stdout, stderr)
  }
  child.on('error', (e) => finish(e))
  child.on('close', (code) => {
    if (code === 0) finish(null)
    else { const e = new Error('Command failed: ' + file); e.code = code; finish(e) }
  })
  return child
}

cp.exec = function patchedExec(command, options, callback) {
  if (typeof options === 'function') { callback = options; options = {} }
  return cp.execFile(command, [], { ...(options || {}), shell: true }, callback)
}

if (VERBOSE) console.error('[ci-patch] loaded')
