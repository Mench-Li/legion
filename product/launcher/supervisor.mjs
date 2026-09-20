// product/launcher/supervisor.mjs
// ============================================================================
// 子进程监督：退避重启、熔断、优雅关闭（PRT-704 / PRT-705 的第一实现）
//
// 这是现有 `services-plugin/index.js` 的直接替代。它的重启逻辑只有一行
// `Math.min(backoff * 2, 30000)`，且**没有熔断**：一个在启动期就崩溃的进程
// （配置错、端口被占、依赖缺失）会以 30 秒周期永远重启下去，
// 日志被刷满、CPU 被占着，而用户看到的现象是「产品一直连不上」——
// 最像「什么都没发生」的故障形态。
//
// 三处刻意设计：
//
// ① **退避按「存活时长」重置，而不是按「重启次数」清零。**
//    一个跑了两小时才崩的进程与一个启动 200ms 就崩的进程，含义完全不同：
//    前者是偶发故障，应当立刻恢复；后者是启动期失败，重启再多次也不会好。
//    判据取 `uptime >= healthyAfterMs` 才把退避归零。现有实现也用了
//    `uptime < 8000` 这个想法，但只用来选择延迟，没用来决定是否熔断。
//
// ② **熔断是状态，不是计数。** 连续 N 次「快速失败」后进入 `circuit-open`，
//    不再自动重启，必须显式 `reset()`（产品里对应「重试」按钮）。
//    自动恢复的熔断等于没有熔断：真正的启动期错误会永远循环。
//
// ③ **关闭先礼后兵，且要杀进程树。** Node 的子进程常常自己再拉起孙进程
//    （services-plugin 启动的 team-hub 就是这样）。只 `kill()` 直接子进程
//    会留下孤立的孙进程继续占着端口，于是「重启产品」变成「端口被占用」。
//    Windows 上用 `taskkill /T /F` 杀树——这是 §9.4「处理……Node 子进程树退出」
//    在最小实现里的落点。
//
// 注入 `spawnImpl` / `clock` / `sleep`：判据必须能在毫秒级验证，
// 而不是靠真的等 30 秒退避。
// ============================================================================

import { spawn as nodeSpawn } from 'node:child_process'
import { attachDrain } from '../logging/sink.mjs'
import { createPeakResourceSampler } from './peak-resource.mjs'

/** 监督状态。`circuit-open` 与 `failed` 的区别：前者可以 reset 后重试，后者是已放弃。 */
export const SUPERVISOR_STATES = Object.freeze([
  'pending',        // 尚未启动
  'starting',       // 已 spawn，等待就绪
  'ready',          // 就绪判据通过
  'restarting',     // 已退出，等待退避后重启
  'circuit-open',   // 连续快速失败，停止自动重启
  'stopped',        // 主动停止
  'failed',         // 启动/监督失败且不再重试（不可恢复类）
])

/** 默认退避参数。它们是**配置项**（spec §6.4 要求 TTL/超时进配置 Schema）。 */
export const DEFAULT_BACKOFF = Object.freeze({
  baseMs: 1000,
  factor: 2,
  maxMs: 30000,
  /** 存活超过这个时长即视为「这次启动是成功的」，退避归零。 */
  healthyAfterMs: 8000,
  /** 连续快速失败多少次后熔断。 */
  circuitThreshold: 5,
})

/**
 * PRT-009 `peak-resource` 的默认采样周期。
 *
 * 为什么是 5 秒而不是"每帧"：采样在 win32 上是**起一次 PowerShell**（约 100–300ms），
 * 所以周期太短会让采样器本身变成被测对象的一部分（`Get-Process` 自己的开销
 * 落进被采进程所在机器的 CPU 账单里）。5 秒对"峰值内存"够用——
 * `PeakWorkingSet64` 是**进程生命周期内的单调峰值**，不是瞬时值，
 * 所以采样频率只影响"多久之后能看到它"，不影响那个数准不准。
 */
export const DEFAULT_PEAK_SAMPLE_MS = 5000

/**
 * 把一次 `peak-resource` 窗口渲染成**一行可读、也可解析**的文字。
 *
 * ## 为什么需要它——这个函数补的是一个"**读数没人看**"的洞
 *
 * `peakResource()` 此前在**整个仓库里只出现一次**：它自己的定义。
 * 采样器每 5 秒真采一次（win32 上每次起一台 PowerShell），窗口也维护得好好的，
 * 而**没有任何东西读它**。实测（`scratch/verify-peak-resource-wired.mjs`，
 * 变异 4 条）：
 *
 *   · 让 `peakResource()` 恒返回 `null`        → 全绿
 *   · 把 `peakResource()` **整个删掉**          → 全绿
 *   · 关掉周期采样                            → 全绿
 *   · 让它谎报"采到了，是 0"                   → 全绿
 *
 * 也就是说这根线**拔掉也不会有人发现**——而这正是 `peak-resource.mjs`
 * 自己的文件头警告过的那种接线：
 *
 *   > 按它写采样器，会得到一个永远采不到东西、却看起来接好了的接线。
 *
 * 更要紧的是它挡住了一件事：PRT-009 的 `peak-resource` 一直缺一个读数，
 * 而**就算跑一次真实执行，那个数也会被算出来然后丢掉**——
 * 于是那一项永远关不掉，理由还不是"没跑"，是"跑了也没人接"。
 *
 * ## 一条纪律：采不到时**不打印 0**
 *
 * 与 `peak-resource.mjs` 文件头那条同源：`0` 是一个**测量结论**
 * （"一个字节都没用"），不是"不知道"。
 *
 *   > 一个把"没采到"渲染成 0 的日志行，会让"这台机器很省内存"
 *   > 与"这台机器根本没采到"在事后读日志时同形。
 */
export function describePeakResource(reading) {
  if (reading === null || reading === undefined) return 'peak-resource：从未采样'
  const mib = (b) => (typeof b === 'number' && Number.isFinite(b)
    ? `${Math.round((b / 1024 / 1024) * 10) / 10}MiB` : 'unknown')
  const ms = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v)}ms` : 'unknown')
  const head = `peak-resource pid=${reading.pid ?? '?'} samples=${reading.samples ?? 0}`
  if (reading.ok !== true) {
    return `${head} 采不到（lastCode=${reading.lastCode ?? '未知'}）：`
      + '峰值内存与 CPU 都是 unknown——**不是 0**'
  }
  return `${head} peakWorkingSet=${mib(reading.peakWorkingSetBytes)}`
    + ` peakRss=${mib(reading.peakRssBytes)} cpu=${ms(reading.cpuMs)}`
}

function isAlive(child) {
  if (child === null || child === undefined) return false
  if (child.exitCode !== null && child.exitCode !== undefined) return false
  if (child.signalCode !== null && child.signalCode !== undefined) return false
  return child.killed !== true
}

/**
 * 创建一个受监督的进程句柄。
 *
 * 返回的对象只暴露**观察与指令**（start/stop/reset/status/on），不暴露 child：
 * 让调用方拿到 child 会让「谁负责重启」重新变得模糊。
 */
export function createSupervisedProcess(spec, {
  spawnImpl = nodeSpawn,
  spawnOptions = {},
  envFor = null,
  backoff = DEFAULT_BACKOFF,
  logger = null,
  now = () => Date.now(),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  killTree = defaultKillTree,
  onStateChange = null,
  // 子进程输出的**消费者**。不提供时**仍然排空管道**——见下面那段说明。
  onOutput = null,
  onOutputError = null,
  // ── PRT-009 `peak-resource`：执行期外部采样 ──────────────────────────
  // 采的是**这个被监督的进程**（生产里就是 Launcher 起的那台长驻 DSH Runtime，
  // 也就是真正在干活的那台——见 `peak-resource.mjs` 文件头那段"采的是哪个进程"）。
  // `peakSampleMs <= 0` 时完全不采：连采样器都不建。
  peakSampleMs = DEFAULT_PEAK_SAMPLE_MS,
  peakIo = null,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  const cfg = { ...DEFAULT_BACKOFF, ...(backoff ?? {}) }
  let state = 'pending'
  let child = null
  let consecutiveFastFailures = 0
  let restarts = 0
  let startedAt = null
  let lastExit = null
  let lastError = null
  /** 当前子进程的输出排空句柄。**每次 spawn 重新接**，退出时 detach。 */
  let drain = null
  let pendingTimer = null
  let stopping = false
  let disposed = false
  /** PRT-009：当前子进程的峰值资源采样器（没有真 pid 时为 null）。 */
  let peakSampler = null
  let peakTimer = null
  /**
   * 进程退出后外部采样只会拿到 `PROCESS_GONE`，所以**退出前最后一次**
   * 窗口读数要留下来——否则"峰值是多少"会在进程死掉的那一刻变成"采不到"。
   */
  let lastPeakResource = null
  /**
   * ★ 这次 spawn 的读数**报过了没有**。
   *
   * `dispose()` 与 `exit` 都会走到收采样那一步，而读数只有一份；
   * 不记这个标志的话，同一次运行的峰值会在日志里出现两行，
   * 读的人会以为采了两轮（或者以为有两个进程）。
   */
  let peakReported = false

  const listeners = new Set()

  const log = (level, message) => {
    if (typeof logger === 'function') logger({ process: spec.key, level, message, at: now() })
  }

  const setState = (next, detail = null) => {
    if (state === next) return
    const prev = state
    state = next
    const event = Object.freeze({ process: spec.key, from: prev, to: next, at: now(), detail })
    log('info', `${prev} → ${next}${detail === null ? '' : `（${detail}）`}`)
    for (const fn of listeners) {
      try { fn(event) } catch { /* 监听者抛错不得影响监督 */ }
    }
    if (typeof onStateChange === 'function') {
      try { onStateChange(event) } catch { /* 同上 */ }
    }
  }

  function scheduleRestart(delayMs) {
    if (stopping || disposed) return
    setState('restarting', `退避 ${delayMs}ms 后重启`)
    pendingTimer = setTimeoutImpl(() => {
      pendingTimer = null
      if (stopping || disposed) return
      attemptStart()
    }, delayMs)
    if (typeof pendingTimer?.unref === 'function') pendingTimer.unref()
  }

  /**
   * PRT-009：给这个被监督的进程开一个峰值资源采样窗口。
   *
   * ★ 没有真 pid（测试里的替身 child）时**什么都不做**，不建采样器：
   *   一条对着假 pid 采样的路径，会以"接好了"的样子存在，而它永远采不到东西。
   */
  function startPeakSampling(pid) {
    stopPeakSampling()
    if (!(peakSampleMs > 0)) return
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return
    peakSampler = createPeakResourceSampler(peakIo === null ? { pid } : { pid, io: peakIo })
    peakReported = false
    // 立刻先采一次：只靠定时器的话，一个活不过一个采样周期的进程
    // 会连一个读数都没有——而那恰恰是最需要读数的那一类。
    peakSampler.sample()
    lastPeakResource = peakSampler.window()
    peakTimer = setIntervalImpl(() => {
      if (peakSampler === null) return
      peakSampler.sample()
      lastPeakResource = peakSampler.window()
    }, peakSampleMs)
    // 采样**不该把这个进程钉住不退出**。
    if (peakTimer !== null && typeof peakTimer.unref === 'function') peakTimer.unref()
  }

  function stopPeakSampling() {
    if (peakTimer !== null) {
      try { clearIntervalImpl(peakTimer) } catch { /* 尽力而为 */ }
      peakTimer = null
    }
    if (peakSampler !== null) {
      lastPeakResource = peakSampler.window()
      peakSampler = null
    }
  }

  /**
   * 读当前峰值窗口：活着 → 采样器当前窗口；已退出 → 退出前最后一次窗口。
   *
   * ★ 抽成一个**局部函数**而不是只作为句柄上的方法：句柄里的
   *   `peakResource()` 是对象字面量的方法简写，**不构成局部绑定**——
   *   在 `status()` 或 `reportPeakResource()` 里写 `peakResource()`
   *   会抛 `ReferenceError`。（第一版就是这么写的，被套件当场咬住。）
   */
  function readPeakResource() {
    if (peakSampler !== null) return peakSampler.window()
    return lastPeakResource
  }

  /**
   * PRT-009 `peak-resource`：把这次 spawn 的窗口读数**交出去**。
   *
   * ★ 这是那根线唯一的消费者。此前 `peakResource()` 零调用方，
   *   于是采样器白采（见 `describePeakResource` 的注释里那 4 条变异）。
   *
   * 放在退出路径上、且**只报一次**，理由：
   *   · 此刻窗口才是终值（进程一走，外部采样只剩 `PROCESS_GONE`）；
   *   · 与那条「退出」日志同一个时刻，读日志的人一眼能对上；
   *   · `dispose()` 之后调用方很可能已经关掉 sink（见 `dispose()` 的注释），
   *     所以**不**在 dispose 路径上写日志。
   *
   * 采不到也照报——报的是"采不到 + 具名原因"。**安静地不报**会让
   * "采不到"与"这台进程根本没接过采样"在日志里同形。
   */
  function reportPeakResource() {
    if (peakReported) return
    const reading = readPeakResource()
    peakReported = true
    if (reading === null) {
      // 压根没有采样器（没开采样 / 没有真 pid）：这是**配置**，不是失败，不刷屏。
      return
    }
    log('info', describePeakResource(reading))
  }

  function handleExit(code, signal) {
    // ★ 必须在把 child 置空**之前**收采样器：进程一退出，外部采样就只剩
    //   `PROCESS_GONE`——那是"采不到"，不是"峰值是多少"。
    stopPeakSampling()
    child = null
    // **这里刻意不 detach。**
    //
    // `exit` 早于流的 `close`：此刻 stdio 里可能还有没发完的缓冲数据，
    // 立刻摘掉监听器会把进程**最后那几行输出**丢掉——而退出前的那几行
    // 恰恰是排查最需要的一段。
    //
    //   > 一个"顺手清理一下"的动作，如果会让最后一段证据消失，
    //   > 它就不是清理。
    //
    // 句柄在下一次 spawn 的开头被 detach（见 `attemptStart`），那时旧流
    // 确实已经没人要了。所以这里留着它是**有意的**，不是漏了。
    if (stopping || disposed) {
      setState('stopped', `主动停止（code=${code ?? ''} signal=${signal ?? ''}）`)
      // ★★★ 主动停止**也要报**（第 44 轮补的那一行）。
      //
      // 这里原先直接 `return`，于是 `reportPeakResource()` **只在非主动退出时**才走到。
      // 而"主动停止"正是一次**成功** Run 的正常结束方式（Launcher 关停 Runtime 走的就是它）。
      // 后果是反的：峰值读数是**崩溃那一次**会印，**正常那一次**不印——
      // 而资源基线要的恰恰是正常那次。
      //
      //   > 只在崩溃时印出峰值、在正常结束时把它丢掉，
      //   > 与"只测量出问题的那一次运行"是同一个东西。
      //
      // 而 `reportPeakResource()` 自己那条理由在**这条路上同样成立**：
      // 进程已经走了，外部采样只剩 `PROCESS_GONE`，此刻窗口才是终值。
      //
      // ★ 唯一仍然不报的是 `disposed`：那条路径上调用方很可能已经关掉 sink
      //   （`dispose()` 下面那句注释就是写这件事的），继续送只会往关掉的 sink 里写。
      //   ⇒ 所以判据是 `!disposed`，不是无条件报。
      //
      // ★ 加上这一段之后，"成功 Run 的峰值读数两处都不留"这件事才闭合：
      //   日志这一行现在有了；另一处（`launcher.mjs` 的 `forgetRunRecord()`
      //   在正常停止后删掉运行记录）是紧挨着的第二件事，见那里的说明。
      if (!disposed) reportPeakResource()
      return
    }
    const uptime = startedAt === null ? 0 : now() - startedAt
    lastExit = Object.freeze({ code: code ?? null, signal: signal ?? null, at: now(), uptimeMs: uptime })
    log('warn', `退出 code=${code ?? ''} signal=${signal ?? ''}（存活 ${uptime}ms）`)
    // PRT-009 `peak-resource`：这个时刻窗口才是终值，把它记下来。
    reportPeakResource()

    if (uptime >= cfg.healthyAfterMs) {
      // 跑够久了：这次算「正常运行后偶发退出」，退避归零，立即重启
      consecutiveFastFailures = 0
      restarts += 1
      scheduleRestart(cfg.baseMs)
      return
    }

    consecutiveFastFailures += 1
    if (consecutiveFastFailures >= cfg.circuitThreshold) {
      lastError = `连续 ${consecutiveFastFailures} 次在 ${cfg.healthyAfterMs}ms 内退出，已停止自动重启`
      setState('circuit-open', lastError)
      return
    }
    const delay = Math.min(cfg.baseMs * (cfg.factor ** (consecutiveFastFailures - 1)), cfg.maxMs)
    restarts += 1
    scheduleRestart(delay)
  }

  function attemptStart() {
    if (disposed) throw new Error('监督对象已 dispose，不能再次启动')
    stopping = false
    // env 由调用方按白名单构造后给出（见 allowlist.mjs）。**不默认继承 process.env**：
    // 「子进程拿到了宿主的全部环境变量」是一条静默的越权路径，不该是默认行为。
    const env = typeof envFor === 'function' ? envFor(spec)?.env : spawnOptions.env
    if (env === undefined || env === null) {
      throw new Error(`进程 ${spec.key} 未提供环境变量：Launcher 必须按白名单构造 env（见 product/launcher/allowlist.mjs）`)
    }
    try {
      child = spawnImpl(spec.command.file, [...spec.command.args], {
        cwd: spec.cwd,
        env,
        stdio: spawnOptions.stdio ?? ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...spawnOptions,
        env,
      })
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      consecutiveFastFailures += 1
      if (consecutiveFastFailures >= cfg.circuitThreshold) setState('circuit-open', lastError)
      else scheduleRestart(Math.min(cfg.baseMs * (cfg.factor ** (consecutiveFastFailures - 1)), cfg.maxMs))
      return null
    }
    startedAt = now()
    setState('starting', `pid=${child.pid ?? '?'}`)
    startPeakSampling(child.pid)
    // ── 排空 stdout/stderr。**这一段与"有没有配置日志"无关。** ──
    //
    // 在这之前，整个 `product/launcher/` 没有任何地方读 `child.stdout`，
    // 而子进程是按 `stdio: ['ignore', 'pipe', 'pipe']` 起的。后果最重的一条
    // 不是"看不到日志"，而是：**管道写满之后子进程会永久阻塞在 write 上**
    // ——不退出、不报错、也不再干活，于是熔断器看不到任何失败、永远不会介入。
    //
    //   > 一个把子进程的输出丢掉、并且在它写满缓冲区时让它卡住的启动器，
    //   > 与一个"进程跑着但什么也不干"的启动器，在用户眼里是同一个东西。
    //
    // 所以这里**无条件**接上 data 处理器并 resume。`onOutput` 为空只是
    // "把内容丢掉"（浪费），而不是"不接管道"（卡住）。
    // 这里**不需要**先摘掉旧句柄：每次 attemptStart 都 spawn 一个全新的 child，
    // 监听器挂在那个新 child 的流上；上一个 child 已经死了，句柄随后被重新赋值。
    //
    // 破验证量过：删掉原来那句"先 detach 再 attach"，**没有任何用例变红**——
    // 因为"往死流上累积监听器"这件事根本不会发生。
    //
    //   > 一句写着"防止累积"、而那个累积不会发生的代码，与不写它行为相同；
    //   > 而它会让人以为这里有讲究，从而在真正需要判断的地方少想一层。
    drain = attachDrain(child, {
      onData: typeof onOutput === 'function' ? (stream, chunk) => onOutput(spec.key, stream, chunk) : null,
      onError: typeof onOutputError === 'function' ? (e) => onOutputError(spec.key, e) : null,
    })
    if (typeof child.once === 'function') {
      child.once('exit', (code, signal) => handleExit(code, signal))
      child.once('error', (err) => {
        lastError = err?.message ?? String(err)
        log('error', `启动错误：${lastError}`)
      })
    }
    return child
  }

  const handle = {
    spec,
    /** 启动（幂等：已在运行或已在退避等待时不重复 spawn）。 */
    start() {
      if (disposed) throw new Error('监督对象已 dispose')
      if (state === 'circuit-open') return { started: false, reason: 'circuit-open' }
      if (isAlive(child)) return { started: false, reason: 'already-running' }
      if (pendingTimer !== null) return { started: false, reason: 'waiting-backoff' }
      attemptStart()
      return { started: child !== null, reason: child === null ? 'spawn-failed' : null }
    },

    /** 就绪判据通过时由 Launcher 调用。 */
    markReady() {
      if (state === 'starting') setState('ready')
      return state
    },

    /** 就绪失败（判据不满足）。不可重试的失败直接熔断——等下去不会变好。 */
    markUnready({ fatal = false, detail = null } = {}) {
      lastError = detail
      if (fatal) {
        consecutiveFastFailures = cfg.circuitThreshold
        setState('circuit-open', detail ?? '就绪判据出现不可重试的失败')
      } else if (state === 'starting') {
        setState('failed', detail ?? '就绪判据超时')
      }
      return state
    },

    /** 熔断后的人工重试入口（产品里对应「重试」按钮）。 */
    reset() {
      if (state !== 'circuit-open' && state !== 'failed') return state
      consecutiveFastFailures = 0
      lastError = null
      setState('pending', '人工重置')
      return state
    },

    /**
     * 停止并等待退出。
     * 先发 SIGTERM 并等待 `graceMs`；仍在则强杀（Windows 走 taskkill 杀树）。
     */
    async stop({ graceMs = 5000 } = {}) {
      stopping = true
      if (pendingTimer !== null) {
        clearTimeoutImpl(pendingTimer)
        pendingTimer = null
      }
      if (!isAlive(child)) {
        setState('stopped', '无需停止')
        return Object.freeze({ stopped: true, forced: false })
      }
      const target = child
      const exited = new Promise((resolve) => {
        if (typeof target.once !== 'function') { resolve(); return }
        target.once('exit', () => resolve())
      })
      try { target.kill('SIGTERM') } catch { /* 已退出 */ }
      // race 里的定时器必须显式清掉：不清的话，即使进程秒退，
      // 这个 5s 定时器仍会在事件循环里挂着（unref 只让进程能退出，不释放它）。
      let graceTimer = null
      const timedOut = await Promise.race([
        exited.then(() => false),
        new Promise((resolve) => {
          graceTimer = setTimeoutImpl(() => resolve(true), graceMs)
        }),
      ])
      if (graceTimer !== null) clearTimeoutImpl(graceTimer)
      if (timedOut) {
        await killTree(target, { logger: log })
        setState('stopped', `超过 ${graceMs}ms 未退出，已强制终止进程树`)
        return Object.freeze({ stopped: true, forced: true })
      }
      setState('stopped', '已优雅退出')
      return Object.freeze({ stopped: true, forced: false })
    },

    dispose() {
      disposed = true
      stopPeakSampling()
      if (pendingTimer !== null) {
        clearTimeoutImpl(pendingTimer)
        pendingTimer = null
      }
      // 摘掉排空句柄：dispose 之后**不该再往 sink 里送数据**——
      // 此刻调用方很可能已经 `close()` 了 sink（launcher 的 `stop()` 就是
      // 先 dispose 再收尾日志）。继续送只会往一个已经关掉的 sink 里写。
      if (drain !== null) { try { drain.detach() } catch { /* 尽力而为 */ } drain = null }
    },

    /** 只读快照。**不暴露 child**（见文件头注释）。 */
    status() {
      return Object.freeze({
        key: spec.key,
        label: spec.label,
        state,
        pid: isAlive(child) ? (child.pid ?? null) : null,
        restarts,
        consecutiveFastFailures,
        startedAt,
        lastExit,
        lastError,
        backoffMs: Math.min(cfg.baseMs * (cfg.factor ** Math.max(0, consecutiveFastFailures - 1)), cfg.maxMs),
        /**
         * PRT-009 `peak-resource`：随快照一起给出的峰值读数。
         *
         * ★ 放进 `status()` 是为了让**结构性**的消费者也能拿到它，而不只有
         *   那一条日志。
         *
         * ★★ 这里原先写的是「`launcher.mjs` 的 `persistRunRecord()` 今天只挑了
         *   `key/pid/image` 三个字段，所以这一项**暂时还不会**自动流进运行记录」。
         *   **那句话已经过期**：`launcher.mjs:1270` 现在是
         *   `peakResource: x.peakResource ?? null,`（`buildRunRecord` 是**闭合映射**，
         *   少了那一行落盘的永远是 `null`，而它与"采样器坏了"在磁盘上是同一个东西）。
         *
         *   > 一句"这个字段暂时还没人用"的注释，与一句"已经接上了"，
         *   > 在**只读注释**的时候是同一个东西——
         *   > 只不过前者会让下一个人**不去**找那个已经存在的消费者。
         */
        peakResource: readPeakResource(),
      })
    },

    on(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },

    /**
     * PRT-009 `peak-resource`：这台进程的峰值内存与 CPU。
     *
     * 进程还活着 → 当前窗口（随采样推进）；已退出 → **退出前最后一次**窗口。
     * 返回 `null` 只表示"从来没有采过"（没开采样、或压根没有真 pid）——
     * **不返回一个零填充的对象**：`0` 是"一个字节都没用"这个测量结论，
     * 不是"不知道"。
     */
    peakResource: readPeakResource,

    /** 供测试与 Launcher 判断进程是否存活。 */
    isAlive: () => isAlive(child),
  }

  return Object.freeze(handle)
}

/**
 * 杀进程树。
 *
 * Windows 上用 `taskkill /PID <pid> /T /F`：`child.kill()` 只杀直接子进程，
 * 而 Legion 的进程本身会再拉起孙进程（team-hub 的守护、worker 的子 Node）。
 * 留下孤立的孙进程继续占端口，是「重启产品之后端口仍然被占用」的根因。
 *
 * 失败不抛错：清理阶段的异常会让整个关闭流程中断，留下更多残留。
 */
export async function defaultKillTree(child, { logger = null, spawnImpl = nodeSpawn, platform = process.platform } = {}) {
  const pid = child?.pid
  if (typeof pid !== 'number') return false
  const log = (m) => { if (typeof logger === 'function') logger('warn', m) }
  if (platform === 'win32') {
    return new Promise((resolve) => {
      let done = false
      const finish = (ok) => { if (!done) { done = true; resolve(ok) } }
      try {
        const killer = spawnImpl('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        killer.once('exit', (code) => finish(code === 0))
        killer.once('error', () => {
          log(`taskkill 不可用，回退为直接 kill（pid=${pid}）`)
          try { child.kill('SIGKILL') } catch { /* ignore */ }
          finish(false)
        })
      } catch {
        try { child.kill('SIGKILL') } catch { /* ignore */ }
        finish(false)
      }
    })
  }
  try { child.kill('SIGKILL') } catch { /* ignore */ }
  return true
}

/**
 * 批量监督：按启动波次启动，波内并发、波间等待前一波就绪。
 *
 * 返回的控制器暴露 `start/stopAll/status/reset`。它**不认识 HTTP**——
 * 就绪判据由 Launcher 通过 `markReady` / `markUnready` 回填，
 * 这样监督逻辑的用例不需要起真实服务。
 */
export function createSupervisor(plan, { order = null, envFor = null, ...options } = {}) {
  const byKey = new Map()
  const specs = new Map(plan.processes.map((p) => [p.key, p]))
  const keys = order ?? plan.waves.flat()
  for (const key of keys) {
    const spec = specs.get(key)
    if (spec === undefined) continue
    if (spec.command === null) continue // 入口未解析的进程不参与监督（由校验阶段报错）
    byKey.set(key, createSupervisedProcess(spec, { envFor, ...options }))
  }

  const controller = {
    handles: byKey,

    /** 只按波次顺序「尝试启动」；就绪等待由调用方负责。 */
    async startAll() {
      const started = []
      for (const wave of plan.waves) {
        for (const key of wave) {
          const handle = byKey.get(key)
          if (handle === undefined) continue
          started.push({ key, ...handle.start() })
        }
      }
      return started
    },

    async stopAll({ graceMs = 5000, reverse = true } = {}) {
      const list = [...byKey.entries()]
      if (reverse) list.reverse() // 逆序停止：先停依赖方，再停被依赖方
      const results = []
      for (const [key, handle] of list) {
        results.push({ key, ...(await handle.stop({ graceMs })) })
      }
      return results
    },

    /** 熔断/失败的全部重置（「重试」按钮）。 */
    resetAll() {
      const out = []
      for (const [key, handle] of byKey) out.push({ key, state: handle.reset() })
      return out
    },

    status() {
      return Object.freeze([...byKey.values()].map((h) => h.status()))
    },

    on(fn) {
      const offs = [...byKey.values()].map((h) => h.on(fn))
      return () => { for (const off of offs) off() }
    },

    requiresAttention() {
      return Object.freeze([...byKey.values()]
        .map((h) => h.status())
        .filter((s) => s.state === 'circuit-open' || s.state === 'failed')
        .map((s) => ({ key: s.key, state: s.state, lastError: s.lastError })))
    },

    dispose() {
      for (const handle of byKey.values()) handle.dispose()
    },
  }

  return Object.freeze(controller)
}
