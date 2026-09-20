// scratch/_probe-peak-on-stop.mjs —— 主动停止时，那一行 peak-resource 日志**不会印**
//
// ★ 缺陷位置：`product/launcher/supervisor.mjs:304-307`
//
//     function handleExit(code, signal) {
//       stopPeakSampling()
//       child = null
//       ...
//       if (stopping || disposed) {
//         setState('stopped', `主动停止（…）`)
//         return                      // ← 在这里返回
//       }
//       ...
//       reportPeakResource()          // ← 于是这一句**只在非主动退出时**才走到
//
//   而"主动停止"正是**一次成功的 Run 的正常结束方式**——Launcher 关停 Runtime 走的就是它。
//
//   > 只在崩溃时印出峰值、在正常结束时把它丢掉，
//   > 与"只测量出问题的那一次运行"是同一个东西——
//   > 而资源基线要的恰恰是**正常那次**。
//
// 同一条路上还有第二件事：`launcher.mjs` 的 `forgetRunRecord()` 在**正常停止**后
// 会删掉运行记录（L1488/1519/1570/1707/1738 五处调用）。于是：
//   · 日志那一行 —— 被这个 early return 跳掉；
//   · 落盘记录   —— 被 forgetRunRecord() 删掉。
// ⇒ **一次成功 Run 的峰值读数，两处都不留。**
//
// 本探针把两条退出路径并排跑一次（同一个替身、同一个 io），只差"是不是主动停止"。
import { buildChildEnv } from '../product/launcher/allowlist.mjs'
import { createSupervisedProcess } from '../product/launcher/supervisor.mjs'

const SPEC = Object.freeze({
  key: 'probe', label: 'probe',
  command: Object.freeze({ file: 'node', args: Object.freeze(['x.mjs']) }),
  cwd: 'C:\\Legion', envNames: Object.freeze([]),
})
const ENV = Object.freeze({ env: Object.freeze({}) })

/** 一个注定采得到的替身 io（不碰真进程）。 */
function makePeakIo() {
  return {
    platform: 'win32',
    now: () => 1_000,
    readFile: () => { throw new Error('win32 不该读文件') },
    exec: () => ({
      ok: true, error: null,
      stdout: JSON.stringify({ WorkingSet64: 8 * 1024 * 1024, PeakWorkingSet64: 64 * 1024 * 1024, CPU: 2.5 }),
    }),
  }
}

/** 可控假子进程（沿用套件里那个的形状）。 */
function makeFakeChild(pid) {
  const handlers = {}
  return {
    pid, exitCode: null, signalCode: null, killed: false,
    once(ev, fn) { (handlers[ev] ??= []).push(fn) },
    kill() { this.killed = true; return true },
    exitNow(code = 0) {
      this.exitCode = code
      for (const fn of handlers.exit ?? []) fn(code, null)
    },
  }
}

function run({ deliberate }) {
  const logs = []
  const child = makeFakeChild(deliberate ? 6001 : 6002)
  const h = createSupervisedProcess(SPEC, {
    spawnImpl: () => child,
    envFor: () => ENV,
    logger: (e) => logs.push(e),
    peakIo: makePeakIo(),
    peakSampleMs: 1000,
    setTimeoutImpl: (fn) => { const t = setTimeout(fn, 0); t.unref?.(); return t },
    clearTimeoutImpl: clearTimeout,
    backoff: { baseMs: 10, factor: 2, maxMs: 100, healthyAfterMs: 1, circuitThreshold: 3 },
  })
  h.start()

  let stopPromise = null
  if (deliberate) stopPromise = h.stop({ graceMs: 50 }) // ← `stopping = true`
  child.exitNow(0)                                      // 触发 exit
  if (stopPromise !== null) {
    // `stop()` 等的是子进程的 `exit` 事件；替身立刻发过了，这里只需让它跑完。
    stopPromise.catch(() => {})
  }

  const lines = logs.map((e) => e.message).filter((m) => typeof m === 'string' && m.includes('peak-resource'))
  return {
    lines,
    state: h.status().state,
    // ★ status() 上的读数**两条路都还在**——丢的只是那条日志（与磁盘记录）
    statusPeak: h.status().peakResource?.peakWorkingSetBytes ?? null,
  }
}

const stopped = run({ deliberate: true })
const crashed = run({ deliberate: false })

console.log('=== A. 主动停止（一次成功 Run 的正常结束方式）===')
console.log(`  监督状态            = ${stopped.state}`)
console.log(`  status() 上的峰值   = ${stopped.statusPeak === null ? 'null' : `${stopped.statusPeak / 1048576} MiB`}`)
console.log(`  peak-resource 日志  = ${stopped.lines.length} 条 ${JSON.stringify(stopped.lines)}`)

console.log('\n=== B. 非主动退出（崩溃 / 需要重启）===')
console.log(`  监督状态            = ${crashed.state}`)
console.log(`  status() 上的峰值   = ${crashed.statusPeak === null ? 'null' : `${crashed.statusPeak / 1048576} MiB`}`)
console.log(`  peak-resource 日志  = ${crashed.lines.length} 条 ${JSON.stringify(crashed.lines)}`)

console.log('\n=== 判定 ===')
console.log(`  A 主动停止：状态是 stopped、读数**在** status() 上，日志 ${stopped.lines.length} 条`)
console.log(`  B 非主动退出：日志 ${crashed.lines.length} 条`)
const wasDefect = stopped.lines.length === 0 && crashed.lines.length === 1
const fixed = stopped.lines.length === 1 && crashed.lines.length === 1 && stopped.statusPeak !== null
console.log('\n  ★ 修之前本探针的读数：A 0 条 / B 1 条 ⇒ 复现了那个缺陷。')
console.log(`  ★ 修之后的读数：      A ${stopped.lines.length} 条 / B ${crashed.lines.length} 条`)
console.log(fixed
  ? '  ✔ 两条退出路径现在**都**印出那一条，且都是**真读数**。'
  : '  ★ 仍不对，见上。')
if (wasDefect) console.log('  （注意：A 0 条正是缺陷的形状，若又回到这里说明修复被回退了。）')
process.exit(fixed ? 0 : 1)
