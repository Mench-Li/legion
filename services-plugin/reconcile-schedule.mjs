// services-plugin/reconcile-schedule.mjs
// ============================================================================
// P4（docs/DECISION-legion-owns-model-config.md）：**周期收敛**的调度器。
//
// ## 为什么是"递归 setTimeout"而不是 `setInterval`
//
// `setInterval` 在"上一轮比间隔还慢"时会把轮次**叠起来**：两轮同时读同一份现状、
// 同时算出"需要新增这条"，然后一起写。P2/P3 的判据建立在"读—算—写—回读"是**一段不可分的动作**
// 这个前提上，叠起来的轮次会让那个前提失效 —— 而失败的样子是"偶尔有一条被写两遍"或
// "回读时看到的是另一轮改到一半的状态"，两者都很难从日志上看出来。
//
//   > 一个"上一轮没跑完就再开一轮"的调度，
//   > 与一个"等这一轮跑完再排下一拍"的调度，在每一轮都很快的日子里是同一个东西。
//
// 递归 setTimeout 让"不重叠"成为**构造上的性质**，而不是靠人去调大间隔。
//
// ## 连续 N 轮这条读数为什么由调度器记
//
// P3 的放行条件是"diff 连续多轮为空"。这个"连续"是**跨轮次**的事实，
// 单轮的报告里没有它。所以调度器维护一个 `streak`：
//
//   本轮开始时**没有差异** ⇒ streak += 1
//   有差异（无论是否被写掉）⇒ streak = 0
//
// 并把它写进每一行的读数里。这样"连续 N 轮无差异"是一句**可以直接引用的话**，
// 而不是"我印象里这几天都没动过"。
//
// ## 停不下来的定时器与停得下来的
//
// `stop()` 必须让**已经在跑的那一轮**也能被识别（`stopped` 标志），
// 且不再排下一拍。宿主卸载时调用它 —— 否则插件卸载后还有一轮在写 DSH 的配置，
// 而那时它已经不归任何人管了。
// ============================================================================

/**
 * @param run              `() => Promise<{ clean: boolean }>`：跑一轮（对账 + 必要时物化）
 * @param intervalMs       间隔（毫秒）。`<= 0` ⇒ 只跑调度器自己不做周期（调用方仍可 `runNow`）
 * @param setTimeoutImpl   注入点（用例用假定时器，不必真的等）
 * @param clearTimeoutImpl 注入点
 * @param log              记一行
 */
export function createReconcileSchedule({
  run,
  intervalMs,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  log = () => {},
} = {}) {
  if (typeof run !== 'function') throw new TypeError('createReconcileSchedule 需要 run')
  let timer = null
  let stopped = false
  let running = false
  let rounds = 0
  let streak = 0
  let lastError = null

  const period = Number.isFinite(Number(intervalMs)) ? Number(intervalMs) : 0

  /** 跑一轮。**并发调用会被挡住**（返回值里 `skipped: 'busy'`），而不是叠起来。 */
  async function runNow() {
    if (stopped) return { skipped: 'stopped' }
    if (running) {
      // 这一条只在"有人显式并发调用"时才会命中（递归 setTimeout 本身不会产生重叠）。
      // 留着它是因为"被挡住"必须是一个**看得见**的读数，而不是一次静默的跳过。
      log('模型配置收敛：上一轮还在跑 → 本次调用被跳过（不叠轮）')
      return { skipped: 'busy' }
    }
    running = true
    rounds += 1
    try {
      const result = await run()
      const clean = result?.clean === true
      streak = clean ? streak + 1 : 0
      lastError = null
      log(`模型配置收敛：第 ${rounds} 轮结束；本轮开始时${clean ? '**无差异**' : '有差异'}`
        + `（连续无差异 ${streak} 轮）`)
      return { ...(result ?? {}), round: rounds, streak, clean }
    } catch (e) {
      // 一轮失败**不许**把调度器打死：下一拍还要照常跑（否则一次网络抖动会永久停掉收敛）。
      // 但 streak 必须归零 —— "这一轮读都没读成"不能被算进"连续无差异"。
      streak = 0
      lastError = e instanceof Error ? e.message : String(e)
      log(`模型配置收敛：第 ${rounds} 轮**出错**（${lastError}）→ streak 归零，下一拍照常跑`)
      return { error: lastError, round: rounds, streak, clean: false }
    } finally {
      running = false
    }
  }

  function schedule() {
    if (stopped || period <= 0) return
    timer = setTimeoutImpl(() => {
      timer = null
      void runNow().finally(schedule)
    }, period)
    // Node 的定时器会把进程钉住；这一轮是后台维护，不该阻止退出。
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  return {
    /** 排下第一拍。`period <= 0` 时什么都不做（调用方仍可用 `runNow`）。 */
    start() {
      if (stopped) return
      if (period <= 0) { log('模型配置收敛：未启用周期（间隔 <= 0）→ 只在启动时收敛一次'); return }
      log(`模型配置收敛：周期已启用，每 ${Math.round(period / 1000)} 秒一轮`)
      schedule()
    },
    runNow,
    stop() {
      stopped = true
      if (timer !== null) { clearTimeoutImpl(timer); timer = null }
    },
    stats() { return { rounds, streak, running, stopped, lastError, periodMs: period } },
  }
}
