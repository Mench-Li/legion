// workbench/mobile/refresh-loop.mjs
// ============================================================================
// 把"一串事件 → 一串刷新"合并成"一串事件 → 少数几次刷新"。
//
// ## 它解决的问题是具体的
//
// SSE 每收到一帧就调一次 `refreshTimeline()` + `refreshTasks()`，而那两件事
// 加起来是 **4 个 HTTP 请求**（时间线 1、看板 3）。一条任务在跑的时候，
// 进展事件是**连着来**的——于是手机在按事件频率重复拉全量，一秒钟可能十几次。
//
//   > 一个"每来一帧就重拉全部"的界面，与一个"看得见实时进展"的界面，
//   > 在功能上一模一样——只不过前者在手机流量和电池上贵得离谱，
//   > 而这两样恰恰是它在手机上最不该贵的地方。
//
// ## 两条不许违反的纪律
//
// ① **结尾那一次必须跑。** 合并掉中间的可以，合并掉最后一次会让界面停在
//    一个旧状态上，而那看起来就是"事件丢了"——这正是 `refresh` 那套
//    "事件只当通知、内容回 Hub 读"的设计要避免的东西。
// ② **同时在跑的只允许一次。** 上一个还没回来又发一个，会让两个响应竞态写同一份
//    状态，而先发后到的那个会把界面写回旧数据。
//
// 所以：尾沿去抖 + 单飞 + 在飞时记账，跑完再补一次。
// ============================================================================

export const REFRESH_CODES = Object.freeze({
  COALESCED: 'REFRESH_COALESCED',
})

/**
 * @param {object} deps
 * @param {() => Promise<void>} deps.run 真正要跑的那件事（拉数据 + 重绘）
 * @param {number} [deps.debounceMs] 静默多久之后跑。太小等于没合并，太大显得迟钝。
 * @param {(fn: Function, ms: number) => unknown} [deps.setTimer]
 * @param {(h: unknown) => void} [deps.clearTimer]
 */
export function createRefresher({
  run,
  debounceMs = 400,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof run !== 'function') throw new TypeError('createRefresher 需要 run')

  let timer = null
  let running = false
  /** 在飞期间又有人要求刷新 → 跑完再补一次（纪律 ①）。 */
  let pending = false
  const stats = { requested: 0, coalesced: 0, runs: 0, trailing: 0, failures: 0 }

  function fire() {
    timer = null
    if (running) {
      // 纪律 ②：不并发。记一笔，等当前这次跑完再补。
      pending = true
      stats.coalesced += 1
      return
    }
    running = true
    stats.runs += 1
    Promise.resolve()
      .then(run)
      .catch(() => { stats.failures += 1 })
      .then(() => {
        running = false
        if (pending) {
          pending = false
          stats.trailing += 1
          fire()
        }
      })
  }

  return {
    /** 有人要求刷新（收到一帧、用户点了刷新……）。返回是否真的立刻跑了。 */
    request() {
      stats.requested += 1
      if (timer !== null) {
        // 已经在等一次去抖：这一次被合并进去，**不动**那个计时器
        // （重置计时器会把"持续来事件"变成"永远不刷新"）。
        stats.coalesced += 1
        return false
      }
      timer = setTimer(fire, debounceMs)
      return true
    },
    /** 测试与诊断用。 */
    stats: () => Object.freeze({ ...stats, running, pending: pending || timer !== null }),
    /** 立刻跑一次（用户显式点「刷新」时用；不走去抖）。 */
    now: fire,
  }
}
