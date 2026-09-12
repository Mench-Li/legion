// ============================================================================
// PRT-713 默认关闭、显式选择加入的脱敏健康心跳
//
// spec §6.6：本地展示是默认；「远程心跳必须显式选择加入、只发送脱敏聚合状态，
// 并允许用户随时关闭」。
//
// ── 本模块唯一真正要紧的那条纪律 ──
//
// **一个关不掉的心跳，与一个开着的心跳，是同一个东西。**
//
// 这类代码最常见的失败不是"忘了加密"，而是"关掉之后还在发"：
//
//   · 定时器到点了，而 `stop()` 只是把 `enabled` 置了 false
//     —— 已经在路上的那一次照发；
//   · `stop()` 清了定时器，但发送是异步的，清完之后 resolve 的那一次照发；
//   · 用户在界面上点了关闭，产品重启后配置读回来又变成默认开；
//   · 出错的路径上偷偷重试。
//
// 对一个已经点过"关闭"的用户来说，上面每一种都与"根本没关"没有区别。
//
//   > 一个"关了之后还会再发一次"的心跳，与一个根本没关的心跳，
//   > 在"用户点了关闭之后数据还会不会出去"上是同一个东西。
//
// 所以本模块用三道独立的闸，任何一道不通过就不发：
//
//   ① **策略**：`enabled !== true` → 不发。默认是 `false`。
//   ② **代际（generation）**：每次 `stop()` 让代际 +1。一次发送在真正落到
//      transport 之前要**再核对一次**代际；对不上就丢弃。
//      这道闸是唯一能拦住"已经在路上的那一次"的东西。
//   ③ **发送前的最后复核**：`shouldSend()` 在 `transport` 调用前重新算一遍。
//
// ── 第二条纪律：载荷用**允许名单**，不用拒绝名单 ──
//
// 一个"把所有已知敏感的字段删掉"的实现，在有人往上游加了一个新字段时
// 会**静默外流**它。允许名单相反：新字段默认不外流，想外流得**显式加进去**。
//
//   > 一个靠"记得把新的敏感字段排除掉"来保密的载荷，
//   > 与一个会把新字段发出去的载荷，在"下一次谁忘了"上是同一个东西。
//
// 另外，允许名单只认**叶子值**（数、受控枚举），不认自由文本——
// 自由文本是路径、任务名、报错信息最容易钻进来的地方。
// ============================================================================

import { METRIC_KEYS, metricsSummary } from './metrics.mjs'

/** 心跳的诊断码。 */
export const HEARTBEAT_CODES = Object.freeze({
  SEND_FAILED: 'HEARTBEAT_SEND_FAILED',
  DISABLED: 'HEARTBEAT_DISABLED',
  NO_ENDPOINT: 'HEARTBEAT_NO_ENDPOINT',
  BAD_POLICY: 'HEARTBEAT_BAD_POLICY',
  DROPPED_GENERATION: 'HEARTBEAT_DROPPED_GENERATION',
  /** 这个实例已经被停掉：任何后续发送都拒绝。 */
  STOPPED: 'HEARTBEAT_STOPPED',
  NOT_OPTED_IN: 'HEARTBEAT_NOT_OPTED_IN',
  INVALID_ENDPOINT: 'HEARTBEAT_INVALID_ENDPOINT',
  PAYLOAD_REJECTED: 'HEARTBEAT_PAYLOAD_REJECTED',
})

/** 默认策略：**关闭**，且没有端点。 */
export const DEFAULT_HEARTBEAT_POLICY = Object.freeze({
  enabled: false,
  endpoint: null,
  intervalMs: 6 * 60 * 60 * 1000,
  timeoutMs: 10 * 1000,
  // 选择加入的**记录**：谁在什么时候同意了。它让"这是用户要求的"
  // 变成一件可查的事，而不是一句代码注释。
  consent: null,
})

/** 载荷里**允许**出现的键。不在这个名单上的一律不外流。 */
export const ALLOWED_PAYLOAD_KEYS = Object.freeze([
  // 协议与版本：告诉服务端怎么解读这份心跳
  'schema', 'productVersion', 'platform',
  // 状态：受控枚举
  'runtimeState',
  // 指标：只允许 METRIC_KEYS 里的数
  ...METRIC_KEYS,
  'observedMetrics', 'totalMetrics',
])

/** 心跳协议版本。**精确匹配**，不是一个"长度够短就行"的字符串。 */
export const HEARTBEAT_SCHEMA = 'legion/heartbeat@1'

/**
 * 受控值：这些键的合法取值是**枚举出来的一小撮**，不是"任意短字符串"。
 *
 * 为什么不用统一的"短且无空格无斜杠"字符集检查：`schema` 的值里带 `/`
 * （那是版本化标识符的正常写法），于是统一检查会把它当成疑似路径**丢掉**——
 * 失败方向是安全的，但结果是服务端拿不到"该怎么解读这份心跳"。
 * 用一个更窄、更明确的规则替代它：这几个键**只认列出来的那几个值**。
 *
 *   > 一个"看起来像就可以"的检查，与一个"必须正好是它"的检查，
 *   > 在"用户的数据会不会跟着自由文本一起出去"上是两回事。
 */
export const CONTROLLED_VALUES = Object.freeze({
  schema: Object.freeze([HEARTBEAT_SCHEMA]),
  platform: Object.freeze(['win32', 'darwin', 'linux', 'freebsd', 'openbsd', 'sunos', 'aix']),
})

/**
 * 端点的合法性。**只接受 https**。
 *
 * 心跳是产品**主动**把数据送出去的唯一通道。允许 `http://` 意味着
 * 用户的运行状态在链路上是明文——而这条链路上有队列深度、错误率、
 * 可用率，合起来足以推断一台机器在干什么。
 *
 *   > 一个"默认明文、想加密可以自己配"的上报通道，
 *   > 与一个明文的上报通道，在"数据出去的时候有没有被保护"上是同一个东西。
 */
export function validateHeartbeatPolicy(policy = {}) {
  const problems = []
  const p = { ...DEFAULT_HEARTBEAT_POLICY, ...policy }

  if (typeof p.enabled !== 'boolean') problems.push('enabled 必须是布尔值')
  if (p.enabled === true) {
    if (typeof p.endpoint !== 'string' || p.endpoint === '') {
      problems.push('开启了心跳却没有给端点：这会让"开着"变成一个没有结果的尝试')
    } else {
      let u = null
      try { u = new URL(p.endpoint) } catch { problems.push(`端点不是一个合法 URL：${p.endpoint}`) }
      if (u !== null) {
        if (u.protocol !== 'https:') {
          problems.push(`端点必须是 https（收到 ${u.protocol}）：心跳链路上有运行状态，明文出去等于没有保护`)
        }
      }
    }
    // 开启了就必须有同意记录。没有它，"用户同意了"这件事无从查证。
    if (p.consent === null || typeof p.consent !== 'object') {
      problems.push('开启了心跳却没有同意记录（consent）：那让"这是用户要求的"变成一句无法查证的话')
    }
  }
  if (!Number.isInteger(p.intervalMs) || p.intervalMs <= 0) problems.push('intervalMs 必须是正整数')
  if (!Number.isInteger(p.timeoutMs) || p.timeoutMs <= 0) problems.push('timeoutMs 必须是正整数')
  return Object.freeze({ ok: problems.length === 0, problems: Object.freeze(problems), policy: Object.freeze(p) })
}

/**
 * 构造载荷。**允许名单 + 叶子值检查。**
 *
 * 返回 `{ payload, dropped }`：`dropped` 列出被挡下的键。
 * 挡下什么要被看见——一个悄悄丢弃字段的实现，会让人以为"某字段本来就没发"。
 */
export function buildHeartbeatPayload(input = {}) {
  const payload = {}
  const dropped = []

  for (const key of Object.keys(input)) {
    if (!ALLOWED_PAYLOAD_KEYS.includes(key)) { dropped.push(key); continue }
    const v = input[key]
    // 只认叶子值：数、布尔、受控短字符串。**不认对象与数组**——
    // 它们是自由文本最容易藏身的地方。
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) { dropped.push(key); continue }
      payload[key] = v
      continue
    }
    if (typeof v === 'boolean') { payload[key] = v; continue }
    if (typeof v === 'string') {
      // ① 受控值：只认列出来的那几个，**不是**"短就行"。
      const controlled = CONTROLLED_VALUES[key]
      if (Array.isArray(controlled)) {
        if (controlled.includes(v)) { payload[key] = v; continue }
        dropped.push(key)
        continue
      }
      // ② 其余字符串：短、无空白、无路径分隔符。
      //    自由文本是路径、任务名、报错信息最容易钻进来的地方。
      if (v.length > 64 || /[\s/\\]/.test(v)) { dropped.push(key); continue }
      payload[key] = v
      continue
    }
    dropped.push(key)
  }

  return Object.freeze({ payload: Object.freeze(payload), dropped: Object.freeze(dropped) })
}

/**
 * 从一份运行时读数构造载荷。这是**生产路径**上唯一该用的入口。
 *
 * 它自己只取"状态 + 指标摘要 + 版本"，调用方无法往里塞别的东西——
 * 这与 `buildHeartbeatPayload` 的允许名单是两道独立的闸。
 */
export function payloadFromRuntime({
  runtimeState = null, metricsReport = null, productVersion = null, platform = process.platform,
} = {}) {
  const input = {
    schema: HEARTBEAT_SCHEMA,
    platform,
  }
  // `productVersion` 与 `runtimeState` 走 ② 那道字符集检查：
  // 版本号与状态名本来就不含空白与路径分隔符，所以它们不需要受控值名单。
  if (typeof productVersion === 'string' && productVersion.length < 32) input.productVersion = productVersion
  if (typeof runtimeState === 'string' && runtimeState.length < 32) input.runtimeState = runtimeState
  if (metricsReport !== null && typeof metricsReport === 'object') {
    const s = metricsSummary(metricsReport)
    for (const [k, v] of Object.entries(s)) input[k] = v
  }
  return buildHeartbeatPayload(input)
}

/**
 * 心跳。**默认关闭**；`start()` 不是"开始上报"，而是"如果用户明确要求，
 * 才排上定时器"。
 *
 * `transport` 是一个 `async (payload) => any`。注入它是为了让判据不依赖网络，
 * 也为了能断言"到底发了几次"与"关闭之后还发不发"。
 */
export function createHeartbeat({
  policy = {},
  transport = null,
  metricsReport = null,
  runtimeState = null,
  productVersion = null,
  platform = process.platform,
  now = () => Date.now(),
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = (t) => clearInterval(t),
  logger = null,
} = {}) {
  const checked = validateHeartbeatPolicy(policy)
  const effective = checked.policy
  const diagnostics = []

  // ── 内部状态 ──
  //
  // `generation` 是本模块的核心机制。每次 `stop()` 让它 +1，
  // 而每次真正调用 `transport` **之前**都要再核对一次：
  // 若此刻的代际与这次发送开始时的代际不同，**丢弃**。
  //
  // 这道闸是为"已经在路上的那一次"准备的。用户的"关闭"点下去之后，
  // 任何还没真正落到 transport 上的发送都必须作废——
  // 否则"关掉"这个词就是一句不准确的话。
  let generation = 0
  let running = false
  // `stopped` 与 `generation` 是**两道不同的闸**，缺一不可：
  //
  //   · `generation` 拦住的是**已经开始的**那一次发送（在 transport 之前核对）；
  //   · `stopped` 拦住的是**之后才发起的**发送。
  //
  // 只做前者会出现这种情况：用户点了关闭，定时器停了，但任何一条
  // 仍然持有这个实例的代码路径调用 `sendNow()` 就会照发——
  // 而 `sendNow()` 里读到的代际是**已经加过的**那一个，所以那道闸根本不响。
  //
  //   > 一个"关掉之后只要有人再调一次就还会发"的心跳，
  //   > 与一个关不掉的心跳，在"用户点了关闭之后数据还会不会出去"上是同一个东西。
  //
  // `start()` 会清掉它（重新开启是一次新的显式决定），`stop()` 会置上它。
  let stopped = false
  let timer = null
  // 每一次发送的序号：用来让调用方与用例都能看到"发了几次"，
  // 而不是只能从 transport 的调用记录里推断。
  let attempt = 0
  const sent = []
  const droppedLog = []

  function note(severity, code, message) {
    const d = Object.freeze({ severity, code, message })
    diagnostics.push(d)
    if (typeof logger === 'function') logger(`[heartbeat] ${message}`)
    return d
  }

  if (checked.ok !== true) {
    for (const p of checked.problems) note('error', HEARTBEAT_CODES.BAD_POLICY, p)
  }

  /**
   * **唯一**决定"这次能不能发"的地方。
   *
   * 三道闸都在这里，且在 `transport` 之前**最后一次**被调用。
   * 任何一条不通过 → 不发。
   */
  function shouldSend(gen) {
    if (effective.enabled !== true) {
      return { ok: false, reason: HEARTBEAT_CODES.DISABLED, message: '心跳是关闭的（默认就是关闭的）' }
    }
    // 实例已经被停掉：**任何**后续发送都拒绝，包括 `sendNow()`。
    if (stopped === true) {
      return {
        ok: false, reason: HEARTBEAT_CODES.STOPPED,
        message: '心跳已被停掉：关闭之后不再发送任何一份心跳',
      }
    }
    if (effective.consent === null) {
      return { ok: false, reason: HEARTBEAT_CODES.NOT_OPTED_IN, message: '没有同意记录，不发' }
    }
    if (effective.endpoint === null) {
      return { ok: false, reason: HEARTBEAT_CODES.NO_ENDPOINT, message: '没有端点，不发' }
    }
    if (checked.ok !== true) {
      return { ok: false, reason: HEARTBEAT_CODES.BAD_POLICY, message: '策略不合法，不发' }
    }
    if (gen !== generation) {
      return {
        ok: false, reason: HEARTBEAT_CODES.DROPPED_GENERATION,
        message: '这次发送开始之后用户关闭过心跳，已丢弃',
      }
    }
    if (typeof transport !== 'function') {
      return { ok: false, reason: HEARTBEAT_CODES.SEND_FAILED, message: '没有配置发送通道，不发' }
    }
    return { ok: true }
  }

  async function sendOnce({ force = false } = {}) {
    const myGen = generation
    const myAttempt = (attempt += 1)
    // 第一道闸：在**构造载荷之前**先看一次，省掉一次无谓的脱敏计算。
    const pre = shouldSend(myGen)
    if (pre.ok !== true) {
      droppedLog.push(Object.freeze({ attempt: myAttempt, reason: pre.reason }))
      if (force) note('warn', pre.reason, pre.message)
      return Object.freeze({ sent: false, reason: pre.reason, attempt: myAttempt })
    }

    const payload = payloadFromRuntime({
      runtimeState, metricsReport, productVersion, platform,
    })
    const body = Object.freeze({ ...payload.payload, observedAt: now() })

    // 第二道闸：载荷造好之后、**真正调用 transport 之前**再核对一次。
    //
    // 这两次检查之间的那段代码不是空的（脱敏 + 序列化），
    // 而用户的"关闭"完全可能正好落在这个窗口里。
    // 只查一次的实现，漏掉的恰好是"已经走到这一步的那一次"——
    // 也就是用户唯一会注意到的那一次。
    const post = shouldSend(myGen)
    if (post.ok !== true) {
      droppedLog.push(Object.freeze({ attempt: myAttempt, reason: post.reason }))
      if (force) note('warn', post.reason, post.message)
      return Object.freeze({ sent: false, reason: post.reason, attempt: myAttempt })
    }

    try {
      await transport(body)
      sent.push(Object.freeze({ attempt: myAttempt, at: now(), keys: Object.freeze(Object.keys(body)) }))
      return Object.freeze({ sent: true, attempt: myAttempt, payload: body })
    } catch (e) {
      note('warn', HEARTBEAT_CODES.SEND_FAILED,
        `心跳发送失败（不会重试，等下一个周期）：${String(e?.message ?? e)}`)
      return Object.freeze({ sent: false, reason: HEARTBEAT_CODES.SEND_FAILED, attempt: myAttempt })
    }
  }

  const heartbeat = {
    /**
     * 排上定时器。**关闭时它什么也不做**——不是"启动了但内部跳过"。
     * 一个照样跑着的定时器，是一颗迟早会响的雷。
     */
    start() {
      if (effective.enabled !== true) {
        note('info', HEARTBEAT_CODES.DISABLED, '心跳默认关闭：start() 不排定时器')
        return Object.freeze({ started: false, reason: HEARTBEAT_CODES.DISABLED })
      }
      if (checked.ok !== true) {
        note('error', HEARTBEAT_CODES.BAD_POLICY, '策略不合法：start() 不排定时器')
        return Object.freeze({ started: false, reason: HEARTBEAT_CODES.BAD_POLICY })
      }
      if (running) return Object.freeze({ started: false, reason: 'already-running' })
      // 重新开启是一次**新的显式决定**：清掉"已停掉"这道闸。
      stopped = false
      running = true
      timer = setTimer(() => { void sendOnce() }, effective.intervalMs)
      // 定时器必须 `unref`：一个让进程无法退出的心跳，
      // 会让"用户关闭了产品但进程还在"变成一件只有任务管理器能解决的事。
      if (timer !== null && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
      return Object.freeze({ started: true, intervalMs: effective.intervalMs })
    },

    /**
     * 关闭。**让代际 +1**，所以在路上的那一次也会被丢弃。
     */
    stop() {
      generation += 1
      stopped = true
      if (timer !== null) {
        try { clearTimer(timer) } catch { /* 清理失败不影响"不再发"这件事 */ }
        timer = null
      }
      const was = running
      running = false
      return Object.freeze({ stopped: was, generation })
    },

    /** 手动发一次（供"立即发送一次"这类显式动作使用）。 */
    sendNow() { return sendOnce({ force: true }) },

    status() {
      return Object.freeze({
        enabled: effective.enabled === true,
        running,
        stopped,
        generation,
        intervalMs: effective.intervalMs,
        hasEndpoint: effective.endpoint !== null,
        hasConsent: effective.consent !== null,
        // 发出去的次数与**送进去的键**。让"到底发了什么"是一件可查的事。
        sendCount: sent.length,
        lastSentKeys: sent.length > 0 ? sent[sent.length - 1].keys : Object.freeze([]),
        dropped: Object.freeze(droppedLog.map((d) => d.reason)),
      })
    },

    diagnostics() { return Object.freeze([...diagnostics]) },
    policy() { return effective },
  }

  return Object.freeze(heartbeat)
}
