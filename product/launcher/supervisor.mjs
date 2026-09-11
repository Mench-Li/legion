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
} = {}) {
  const cfg = { ...DEFAULT_BACKOFF, ...(backoff ?? {}) }
  let state = 'pending'
  let child = null
  let consecutiveFastFailures = 0
  let restarts = 0
  let startedAt = null
  let lastExit = null
  let lastError = null
  let pendingTimer = null
  let stopping = false
  let disposed = false

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

  function handleExit(code, signal) {
    child = null
    if (stopping || disposed) {
      setState('stopped', `主动停止（code=${code ?? ''} signal=${signal ?? ''}）`)
      return
    }
    const uptime = startedAt === null ? 0 : now() - startedAt
    lastExit = Object.freeze({ code: code ?? null, signal: signal ?? null, at: now(), uptimeMs: uptime })
    log('warn', `退出 code=${code ?? ''} signal=${signal ?? ''}（存活 ${uptime}ms）`)

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
      if (pendingTimer !== null) {
        clearTimeoutImpl(pendingTimer)
        pendingTimer = null
      }
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
      })
    },

    on(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },

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
