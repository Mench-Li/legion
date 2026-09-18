// scratch/prt509-handle-dump.cjs
// ============================================================================
// 时间线探针：回答"挂死那一轮与正常那一轮，**过程上**差在哪一步"。
//
// ## 已经量出来的（上一版）
//
//   · 挂死时宿主挂着 **5 个 FSWatcher**，全部由 **chokidar** 创建，
//     监视 `…/dsh-home/profiles/prt509pro…`（profile 目录）；
//   · 对照：`node --test` worker 那一侧是 `Socket×5 + ChildProcess×1`，**零 FSWatcher**。
//
// ## 但"有 5 个 watcher"**还不能**解释双峰——除非它在正常那一轮**也会出现**
//
// 如果正常轮在 3.3s 退出时同样挂着 5 个 watcher，那 watcher 就**不是**原因
// （一定是别的东西把它带走了，最可能是**显式 `process.exit()`**）。
//
//   > 一个"挂死时存在"的东西，与一个"只在挂死时存在"的东西，
//   > 在只有挂死那一侧的读数时长得一模一样。
//
// ⇒ 所以本探针要做的是**同时**记下三件事，好让两侧可以直接对比：
//   ① 每秒的句柄归类（时间线）；
//   ② `process.exit()` **被调用**的时刻与调用栈；
//   ③ `process.on('exit')` 真的触发的时刻。
//
// ② 是这一版的关键：正常轮若调用了 `process.exit()`，而挂死轮没有，
// 那"谁调用了它、为什么有时没调"就是根因所在。
//
// ## 纪律
//
// · 定时器**必须 `unref()`**，否则探针自己就成了钉住进程的东西。
// · 打补丁必须**原样调用**原函数；只加记录，不改行为。
//   *一个为了让探针方便而改变被测对象的探针，测的不是产品。*
// ============================================================================
const fs = require('node:fs')
const path = require('node:path')

const dir = process.env.PRT509_HANDLE_DUMP_DIR || ''
const periodMs = Number(process.env.PRT509_HANDLE_DUMP_MS || 0)
const isHost = String(process.argv[1] ?? '').includes('bin.js')

if (dir !== '' && isHost) {
  const outFile = path.join(dir, `host-${process.pid}.log`)
  const say = (line) => {
    try { fs.appendFileSync(outFile, line + '\n', 'utf8') } catch { /* 诊断不能把被测对象搞崩 */ }
  }

  const stamp = () => `t=${(process.uptime() * 1000).toFixed(0)}ms`

  say(`[PROBE] argv1=${String(process.argv[1] ?? '')} pid=${process.pid}`)

  // ── ① 句柄归类（周期性，unref 的定时器）──────────────────────────────
  const classify = () => {
    const hs = (typeof process._getActiveHandles === 'function') ? process._getActiveHandles() : []
    const m = new Map()
    for (const h of hs) {
      const n = h && h.constructor ? h.constructor.name : typeof h
      m.set(n, (m.get(n) ?? 0) + 1)
    }
    return `handles=${hs.length} [${[...m].map(([k, v]) => `${k}x${v}`).join(' ')}]`
  }

  if (Number.isFinite(periodMs) && periodMs > 0) {
    const iv = setInterval(() => say(`[TICK] ${stamp()} ${classify()}`), periodMs)
    if (typeof iv.unref === 'function') iv.unref()
  }

  // ── ② process.exit() 被调用 ③ exit 事件真的触发 ─────────────────────
  const origExit = process.exit
  process.exit = function patchedExit(code) {
    const stack = String(new Error().stack ?? '')
      .split('\n').filter((l) => !/node:internal|prt509-handle-dump/.test(l)).slice(0, 8)
      .join('\n            ')
    say(`[EXIT-CALLED] ${stamp()} code=${code}`)
    say(`[EXIT-CALLED] 调用栈：\n            ${stack}`)
    return origExit.call(this, code)
  }
  process.on('exit', (code) => say(`[EXIT-EVENT] ${stamp()} code=${code} ${classify()}`))

  // ── fs.watch 的创建记录（保留原函数）────────────────────────────────
  const origWatch = fs.watch
  fs.watch = function patchedWatch(...args) {
    const w = origWatch.apply(this, args)
    const stack = String(new Error().stack ?? '')
      .split('\n').filter((l) => !/node:internal|node:fs|prt509-handle-dump/.test(l)).slice(0, 4)
      .join(' | ')
    say(`[WATCH] ${stamp()} ${String(args[0]).slice(-70)}  ← ${stack.slice(0, 160)}`)
    return w
  }
}
