// orchestrator/worker/main.mjs
// ============================================================================
// Legion Orchestrator worker（PRT-301 起；扫单 / 认领 / 派工的外壳）
//
// 这是 spec §6.10 里由 Launcher 托管、清单声明为 `product/orchestrator/worker.mjs`
// 的那个进程。它长驻运行，职责是：**扫单 → 认领（拿 lease）→ 执行 → 提交终态**。
//
// ## 本模块最重要的一条行为：**不认领自己执行不了的任务**
//
// 没有配置执行引擎时，一个「积极」的 worker 会照常认领任务、然后立刻失败，
// 把每个任务的重试额度烧掉，最后全部落进 Dead Letter。
// 从外部看，这个产品的表现是「任务在跑，但全都失败了」——
// 而真实原因只是「没配执行引擎」，本该在启动时就说清楚。
//
// 因此这里的规则是：
//   - 没有执行引擎 → `state: 'no-executor'`，**不认领任何任务**，状态文件与日志如实说明；
//   - 拿不到 team-hub → `state: 'hub-unreachable'`，同样不认领（认领不到就无事可做）；
//   - 退出前必须释放持有的 lease（否则任务要等租期自然过期才能被别人领走，
//     这段时间里队列看起来是「卡住」的）。
//
// ## 依赖全部可注入
//
// `fetchImpl` / `sleep` / `now` / `spawn` 全部注入，因此「扫单节奏」「心跳间隔」
// 「优雅停止」这三件最容易只在真机上出问题的事可以在进程内确定性验证。
// 唯一的真实进程用例负责证明「真的能被 SIGTERM 停下来、真的会写状态文件」。
// ============================================================================

import { join } from 'node:path'

import { readStatusFile, STATUS_RELPATH, writeStatusFile } from './status-file.mjs'

/** worker 状态机的取值。 */
export const WORKER_STATES = Object.freeze([
  'starting',
  'no-executor',
  'hub-unreachable',
  'idle',
  'claiming',
  'executing',
  'stopping',
  'stopped',
])

/** 默认节奏。全部是配置项，这里是它们的兜底值。 */
export const WORKER_DEFAULTS = Object.freeze({
  pollIntervalMs: 3000,
  heartbeatIntervalMs: 10000,
  failureBackoffMs: 5000,
  maxConsecutiveFailures: 5,
})

function joinPath(platform, ...parts) {
  const sep = platform === 'win32' ? '\\' : '/'
  return parts
    .map((p, i) => {
      const s = String(p).replace(/[\\/]+/g, sep)
      return i === 0 ? s.replace(new RegExp(`${sep}+$`), '') : s.replace(new RegExp(`^${sep}+|${sep}+$`, 'g'), '')
    })
    .filter((p) => p !== '')
    .join(sep)
}

/**
 * 建一个 worker 实例。
 *
 * `executor` 是唯一的能力开关：
 *   - null/undefined → 不认领，状态为 `no-executor`
 *   - `{ execute(task) → Promise<{ outcome, detail }> }` → 正常认领与执行
 *
 * `hub` 是数据面客户端，形状 `{ claim(), heartbeat(), release(), transition() }`。
 * 本模块**不直接拼 HTTP**：数据面的路由与鉴权属 team-hub，混在一起会让
 * 「worker 的循环逻辑」无法脱离真实 hub 测试。
 */
export function createWorker({
  hub = null,
  executor = null,
  dataDir = null,
  platform = process.platform,
  statusPath = null,
  pollIntervalMs = WORKER_DEFAULTS.pollIntervalMs,
  heartbeatIntervalMs = WORKER_DEFAULTS.heartbeatIntervalMs,
  failureBackoffMs = WORKER_DEFAULTS.failureBackoffMs,
  maxConsecutiveFailures = WORKER_DEFAULTS.maxConsecutiveFailures,
  workerId = `worker-${process.pid}`,
  logger = () => {},
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (dataDir === null && statusPath === null) {
    throw new TypeError('createWorker 需要 dataDir 或 statusPath：没有状态出口的 worker 在外部与「卡住」完全同形')
  }
  const resolvedStatusPath = statusPath ?? joinPath(platform, dataDir, STATUS_RELPATH)

  let state = 'starting'
  let running = false
  let stopped = false
  let loopPromise = null
  const counters = { claimed: 0, completed: 0, failed: 0, unknownOutcome: 0, consecutiveFailures: 0, heartbeats: 0, heartbeatFailures: 0 }
  let lastError = null
  let currentLease = null
  let lastStatusWrite = null
  let heartbeatActive = false
  let leaseMayBeLost = false

  /** 状态文件 + 日志是同一份事实的两个出口，必须一起更新。 */
  function publish(nextState, extra = {}) {
    const previous = state
    state = nextState
    // 「为什么不干活」的解释必须发生在**做决定的地方**，而不是主循环里：
    // `tick()` 可以被单独调用（测试、单次扫单），在循环里打日志会让这条路径
    // 只写状态文件、不留任何解释——而状态文件是要被人读的，不是被猜的。
    if (nextState === 'no-executor' && previous !== 'no-executor') {
      logger('[worker] 未配置执行引擎：**不认领任何任务**（认领会立刻失败并把重试额度烧光，' +
        '最终表现为「任务都在跑但全都失败」）。配置执行引擎后重启即可开始工作。')
    }
    if (nextState === 'hub-unreachable' && previous !== 'hub-unreachable') {
      logger('[worker] 无法与 team-hub 通信：暂停认领并退避重试（不退出，等数据面恢复）')
    }
    const status = {
      workerId,
      pid: process.pid,
      state: nextState,
      hubConfigured: hub !== null,
      executorConfigured: executor !== null,
      claimed: counters.claimed,
      completed: counters.completed,
      failed: counters.failed,
      unknownOutcome: counters.unknownOutcome,
      consecutiveFailures: counters.consecutiveFailures,
      heartbeats: counters.heartbeats,
      heartbeatFailures: counters.heartbeatFailures,
      leaseMayBeLost,
      currentLeaseEpoch: currentLease === null ? null : currentLease.leaseEpoch ?? null,
      currentTaskId: currentLease === null ? null : currentLease.taskId ?? null,
      lastError,
      updatedAt: new Date(now()).toISOString(),
      ...extra,
    }
    const written = writeStatusFile(resolvedStatusPath, status)
    lastStatusWrite = written
    if (written.removed.length > 0) {
      // 剔除不等于没事：说明有人往状态里塞了凭证键，必须可见。
      logger(`[worker] 状态文件剔除了凭证键：${written.removed.join(', ')}`)
    }
    if (written.ok !== true) logger(`[worker] ${written.message}`)
    return status
  }

  /**
   * 执行期间维持 lease 的心跳。
   *
   * **为什么必须有**：租期是「另一个 worker 多久之后可以认为我死了并接管这个任务」。
   * 执行期间不发心跳，长任务一定会被第二个 worker 认领并**重跑一遍**——
   * 对一个已经调用过外部写操作的步骤，那就是重复副作用。
   * 心跳不是「保活优化」，它是「不重复执行」的前提。
   *
   * **心跳失败为什么必须可见**：心跳连续失败意味着 lease 可能已经易主。
   * 此时本进程继续执行下去，最后提交的终态会被 team-hub 以 epoch 不符拒绝
   * （PRT-313 的数据库层防线）；如果它没被拒绝，那就是**覆盖了别人的结果**。
   * 本批次还没有「中断正在执行的 executor」的能力（那需要把 AbortSignal 一路穿到
   * RuntimeAdapter，属 PRT-302/311），因此这里能做且必须做的是：
   * 计数、置 `leaseMayBeLost`、写进状态文件、并且**在日志里说清楚后果**——
   * 让「结果可能被拒绝/覆盖了别人的结果」这件事有痕迹，而不是静默地跑完。
   */
  function startHeartbeat(lease) {
    if (heartbeatIntervalMs <= 0) return
    heartbeatActive = true
    leaseMayBeLost = false
    const loop = async () => {
      while (heartbeatActive) {
        await sleep(heartbeatIntervalMs)
        if (!heartbeatActive) return
        try {
          await hub.heartbeat({ taskId: lease.taskId, leaseEpoch: lease.leaseEpoch, workerId })
          counters.heartbeats += 1
          leaseMayBeLost = false
        } catch (e) {
          counters.heartbeatFailures += 1
          leaseMayBeLost = true
          logger(`[worker] 心跳失败（连续 ${counters.heartbeatFailures} 次，任务 ${lease.taskId}）：` +
            `${e?.message ?? e}。lease 可能已过期并被其他 worker 接管——` +
            '此时本次执行的结果可能被拒绝，或者（如果没有 epoch 校验）覆盖别人的结果')
          publish('executing')
        }
      }
    }
    loop()
  }

  function stopHeartbeat() {
    heartbeatActive = false
  }

  /** 一轮：能认领就认领，不能认领就如实说明原因。 */
  async function tick() {
    if (executor === null || executor === undefined) {
      // 见文件头：不认领自己执行不了的任务。
      publish('no-executor')
      return { acted: false, reason: 'no-executor' }
    }
    if (hub === null) {
      publish('hub-unreachable')
      return { acted: false, reason: 'hub-not-configured' }
    }

    publish('claiming')
    let claimed = null
    try {
      claimed = await hub.claim({ workerId })
    } catch (e) {
      counters.consecutiveFailures += 1
      lastError = { stage: 'claim', message: String(e?.message ?? e) }
      publish('hub-unreachable')
      return { acted: false, reason: 'claim-failed', error: lastError }
    }
    if (claimed === null || claimed === undefined || claimed.taskId === undefined) {
      counters.consecutiveFailures = 0
      publish('idle')
      return { acted: false, reason: 'queue-empty' }
    }

    counters.claimed += 1
    currentLease = claimed
    publish('executing')
    startHeartbeat(claimed)
    try {
      const result = await executor.execute(claimed)
      const outcome = result?.outcome ?? 'failed'
      if (outcome === 'completed') counters.completed += 1
      else if (outcome === 'outcome_unknown') counters.unknownOutcome += 1
      else counters.failed += 1
      counters.consecutiveFailures = 0
      lastError = outcome === 'completed' ? null : { stage: 'execute', message: result?.detail ?? outcome }
      // 提交终态由 hub 负责（它才知道 leaseEpoch 与事务边界）；worker 只报告结果。
      if (typeof hub.transition === 'function') {
        await hub.transition({ taskId: claimed.taskId, leaseEpoch: claimed.leaseEpoch, outcome, detail: result?.detail ?? null })
      }
      stopHeartbeat()
      currentLease = null
      publish('idle')
      return { acted: true, outcome }
    } catch (e) {
      counters.failed += 1
      counters.consecutiveFailures += 1
      lastError = { stage: 'execute', message: String(e?.message ?? e) }
      stopHeartbeat()
      currentLease = null
      publish('idle')
      return { acted: true, outcome: 'failed', error: lastError }
    }
  }

  /** 主循环。连续失败到阈值后进入慢速退避，而不是继续高频重试。 */
  async function loop() {
    publish('starting')
    logger(`[worker] 启动：hub=${hub === null ? '未配置' : '已配置'} executor=${executor === null ? '未配置' : '已配置'}`)
    while (running && !stopped) {
      const r = await tick()
      if (!running || stopped) break
      const backoff = counters.consecutiveFailures >= maxConsecutiveFailures ? failureBackoffMs : pollIntervalMs
      if (r.reason === 'claim-failed') {
        logger(`[worker] 认领失败（连续 ${counters.consecutiveFailures} 次）：${lastError?.message ?? ''}`)
        if (counters.consecutiveFailures >= maxConsecutiveFailures) {
          logger(`[worker] 连续失败达阈值 ${maxConsecutiveFailures}：转入 ${failureBackoffMs}ms 退避（不退出，等待 hub 恢复）`)
        }
      }
      await sleep(r.acted ? pollIntervalMs : backoff)
    }
  }

  return {
    get state() { return state },
    get counters() { return Object.freeze({ ...counters }) },
    get statusPath() { return resolvedStatusPath },
    get isRunning() { return running },

    /** 启动主循环（幂等：重复调用返回同一个 promise）。 */
    start() {
      if (loopPromise !== null) return loopPromise
      running = true
      stopped = false
      loopPromise = loop()
      return loopPromise
    },

    /** 跑一轮（供测试与「单次扫单」用法）。 */
    tick,

    /**
     * 优雅停止：停止认领 → 释放持有的 lease → 写终态。
     *
     * 释放 lease 这一步不能省：不释放的话任务要等租期自然过期才能被别的 worker 领走，
     * 而这段时间里队列看起来是「卡住」的——一个没有任何错误信息的故障。
     *
     * ⚠️ **已知边界**：正在执行的 executor 不会被中断（中断需要把 AbortSignal 一路穿到
     * RuntimeAdapter，属 PRT-302/311）。因此停止后它仍可能返回并提交一次终态。
     * 那条提交是否被接受，取决于 team-hub 的 leaseEpoch 校验（PRT-313）——
     * 这也是为什么 epoch 校验不是优化项：没有它，这里的「先释放再提交」会成功。
     */
    async stop({ reason = '收到停止信号', release = true } = {}) {
      if (stopped && !running) return { ok: true, alreadyStopped: true }
      stopped = true
      running = false
      stopHeartbeat()
      publish('stopping', { stopReason: reason })
      let released = null
      if (release && currentLease !== null && hub !== null && typeof hub.release === 'function') {
        try {
          released = await hub.release({ taskId: currentLease.taskId, leaseEpoch: currentLease.leaseEpoch, workerId, reason })
        } catch (e) {
          released = { ok: false, message: String(e?.message ?? e) }
          logger(`[worker] 释放 lease 失败：${released.message}（任务将等待租期自然过期）`)
        }
      }
      currentLease = null
      // 不 await 主循环：它可能正睡在 pollIntervalMs 里，等它会让 Ctrl+C 显得没反应。
      // 循环会在下一轮开头看到 stopped 并退出，入口 await 的是循环本身。
      publish('stopped', { stopReason: reason })
      logger(`[worker] 已停止（原因：${reason}）`)
      return { ok: true, released, statusPath: resolvedStatusPath }
    },

    /** 求值当前状态文件（供 CLI / 诊断使用）。 */
    readStatus() {
      return readStatusFile(resolvedStatusPath)
    },

    /** 读回写给外部看的状态（不落盘，供测试断言）。 */
    snapshot() {
      return Object.freeze({
        workerId,
        state,
        counters: Object.freeze({ ...counters }),
        lastError,
        leaseMayBeLost,
        executorConfigured: executor !== null && executor !== undefined,
        hubConfigured: hub !== null,
        lastStatusWrite: lastStatusWrite === null ? null : { ok: lastStatusWrite.ok, removed: lastStatusWrite.removed },
      })
    },
  }
}
