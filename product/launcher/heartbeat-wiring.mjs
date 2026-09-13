// product/launcher/heartbeat-wiring.mjs
// ============================================================================
// PRT-713 收尾：把心跳**接进 Launcher**
//
// ## 接线要守住的那一件事
//
// `createHeartbeat` 自己已经有了三道闸（策略、代际、已停掉），
// 而这一层的危险完全不同：**它决定那个实例到底存不存在、以及谁来提供 consent。**
//
// 两种写法都"能跑"：
//
//   · 写法 A：`policy.consent = { who: 'config', at: <config 里的时间> }`
//     —— 配置里写了 `heartbeat.enabled: true` 就直接给一个 consent；
//   · 写法 B：consent 只能来自用户在某台机器上做过的那个动作（同意记录文件）。
//
// 两者在用例里都能让心跳发出去。差别在**第二台机器上**：
// A 的配置文件被复制过去之后，那台机器也会开始发心跳，而
// **没有人在那台机器上同意过任何事**。
//
//   > 一个"跟着配置文件走的同意"，
//   > 与一个"真的有人点过同意"的同意，在记录上长得一样——
//   > 只不过前者会把用户的同意，顺手复制到他所有的机器上。
//
// 所以这里是写法 B，并且**配置里根本没有 consent 这个键**
// （见 `config.mjs` 的 `heartbeat.*`：只读 enabled/endpoint/intervalMs/timeoutMs）。
//
// ## 另一件：这一层的失败一律不许影响启动
//
// 心跳是**附加**能力。它坏了（端点非法、transport 起不来、同意记录损坏）
// 都不该让产品起不来——但也不该**静默**：
// 所以每种失败都有一条诊断，`enabled && 没发出去` 这件事必须能被看见。
//
// ============================================================================

import { HEARTBEAT_CODES, createHeartbeat, validateHeartbeatPolicy } from '../heartbeat.mjs'
import { CONSENT_CODES, readConsent } from '../heartbeat-consent.mjs'
import { createHttpTransport } from '../heartbeat-transport.mjs'

/** 接线层的具名码。 */
export const HEARTBEAT_WIRING_CODES = Object.freeze({
  /** 策略里 enabled 不是 true：**默认路径**，不是错误。 */
  DISABLED: 'HEARTBEAT_WIRING_DISABLED',
  /** 配置说开着，但这台机器上没有人同意过。 */
  NO_CONSENT: 'HEARTBEAT_WIRING_NO_CONSENT',
  /** 同意被撤回了。与"从未同意"分开。 */
  CONSENT_REVOKED: 'HEARTBEAT_WIRING_CONSENT_REVOKED',
  /** 同意记录读不出来/不合法。与"没有同意"分开——用户可能明明同意过。 */
  CONSENT_UNREADABLE: 'HEARTBEAT_WIRING_CONSENT_UNREADABLE',
  /** 策略本身不合法。 */
  BAD_POLICY: 'HEARTBEAT_WIRING_BAD_POLICY',
  /** 端点不合法：提前报，不要等到 6 小时后第一次发送才失败。 */
  BAD_ENDPOINT: 'HEARTBEAT_WIRING_BAD_ENDPOINT',
  /** 接线内部抛错（一律兜住，不许影响启动）。 */
  FAILED: 'HEARTBEAT_WIRING_FAILED',
})

/** 同意状态 → 接线码的映射。 */
const CONSENT_CODE_MAP = Object.freeze({
  [CONSENT_CODES.NEVER_CONSENTED]: HEARTBEAT_WIRING_CODES.NO_CONSENT,
  [CONSENT_CODES.REVOKED]: HEARTBEAT_WIRING_CODES.CONSENT_REVOKED,
  [CONSENT_CODES.UNREADABLE]: HEARTBEAT_WIRING_CODES.CONSENT_UNREADABLE,
  [CONSENT_CODES.INVALID]: HEARTBEAT_WIRING_CODES.CONSENT_UNREADABLE,
})

/**
 * 组装心跳。**不启动**（`start()` 由调用方在合适的时候调）。
 *
 * @param {object} deps
 * @param {object} deps.layout          产品布局（同意记录在它下面）
 * @param {object} [deps.policy]        配置里的 `heartbeatPolicy`（不含 consent）
 * @param {Function} [deps.transportFactory] 注入点；默认造真实的 https 通道
 * @param {object} [deps.consentReader] 可注入的 `readConsent`
 * @param {Function} [deps.now]
 *
 * @returns {{ok: true, heartbeat: object, policy: object, diagnostics: Array}
 *          | {ok: false, code: string, message: string, diagnostics: Array}}
 *   **不抛。** 失败一律变成 `ok:false` + 一条可读的理由。
 */
export function wireHeartbeat(deps = {}) {
  const {
    layout = null,
    policy = {},
    transportFactory = null,
    consentReader = readConsent,
    now = () => Date.now(),
    setTimer = undefined,
    clearTimer = undefined,
    logger = null,
  } = deps

  const diagnostics = []
  const fail = (code, message) => {
    diagnostics.push(Object.freeze({ severity: 'warn', code, message }))
    return Object.freeze({ ok: false, code, message, diagnostics: Object.freeze(diagnostics) })
  }

  try {
    // ── ① 默认路径：没开就是没开。**不是错误**，也不该有诊断噪音 ──
    if (policy.enabled !== true) {
      return Object.freeze({
        ok: false, code: HEARTBEAT_WIRING_CODES.DISABLED,
        message: '心跳默认关闭（配置里没有 heartbeat.enabled=true）',
        diagnostics: Object.freeze(diagnostics),
      })
    }

    // ── ② 同意：**只认这台机器上的记录** ──
    const consent = consentReader(layout)
    if (consent.consented !== true) {
      const code = CONSENT_CODE_MAP[consent.code] ?? HEARTBEAT_WIRING_CODES.NO_CONSENT
      // 「读不出来」这条要给一条**更重**的话：用户可能明明同意过，
      // 而产品正在因为他看不见的原因不发心跳。
      const extra = code === HEARTBEAT_WIRING_CODES.CONSENT_UNREADABLE
        ? '（注意：这不等于「没同意过」——同意记录本身可能坏了，请检查/重新同意）'
        : ''
      return fail(code, `配置要求发送心跳，但这台机器上没有有效的同意：${consent.message}${extra}`)
    }

    // ── ③ 端点在**启动时**就判一次，且用**它自己的码** ──
    //
    //   不靠"第一次发送时会失败"：`intervalMs` 默认 6 小时，
    //   而一个配错了端点的产品会在那 6 小时里看起来一切正常。
    //
    //     > 一个"6 小时后才会告诉你端点配错了"的配置校验，
    //     > 与一个不校验的配置，在用户那天关掉电脑之前是同一个东西。
    //
    //   ⚠️ 这一段**必须排在 `validateHeartbeatPolicy` 之前**。
    //
    //   第一版把它排在后面，于是它**永远不会执行**：策略校验自己就会
    //   以 `BAD_POLICY` 拒掉同一个端点。断验证 ⑤⑩ 量到了这一点——
    //   把 `if (!endpointOk)` 改成 `if (false)`，**套件全绿**。
    //
    //     > 一个"永远排在另一道更宽的闸后面"的检查，
    //     > 与一个不存在的检查，在"它到底拦不拦得住"上是同一个答案——
    //     > 只不过前者的代码看起来是有的，所以没有人会去补。
    //
    //   排到前面之后，用户拿到的是**精确**的那一个码：
    //   `BAD_ENDPOINT` 说"你的端点配错了"，而不是笼统的 `BAD_POLICY`。
    if (policy.endpoint === null || policy.endpoint === undefined || policy.endpoint === '') {
      return fail(HEARTBEAT_WIRING_CODES.BAD_ENDPOINT, '开启了心跳却没有配置端点')
    }
    let endpointOk = false
    try {
      endpointOk = new URL(String(policy.endpoint)).protocol === 'https:'
    } catch { endpointOk = false }
    if (!endpointOk) {
      return fail(HEARTBEAT_WIRING_CODES.BAD_ENDPOINT,
        `心跳端点必须是合法的 https URL（收到 ${JSON.stringify(policy.endpoint)}）：`
        + '心跳链路上有队列深度/错误率/可用率，明文出去等于没有保护')
    }

    // ── ④ 策略：把同意填进去，然后走**同一个** `validateHeartbeatPolicy` ──
    //
    //   不在这里另写一套校验：两套校验就意味着两套判据，
    //   而"哪一套生效"会成为下一个必须回答的排查问题。
    const full = { ...policy, consent: { who: consent.record.who, at: consent.record.at } }
    const checked = validateHeartbeatPolicy(full)
    if (checked.ok !== true) {
      return fail(HEARTBEAT_WIRING_CODES.BAD_POLICY,
        `心跳策略不合法：${checked.problems.join('；')}`)
    }

    // ── ⑤ 真实的发送通道 ──
    const makeTransport = transportFactory ?? ((p) => createHttpTransport({ policy: p, logger }))
    const transport = makeTransport(checked.policy)
    if (typeof transport !== 'function') {
      return fail(HEARTBEAT_WIRING_CODES.FAILED, 'transportFactory 没有返回一个函数')
    }

    const heartbeat = createHeartbeat({
      policy: checked.policy,
      transport,
      now,
      logger,
      ...(setTimer === undefined ? {} : { setTimer }),
      ...(clearTimer === undefined ? {} : { clearTimer }),
    })

    diagnostics.push(Object.freeze({
      severity: 'info', code: 'HEARTBEAT_WIRING_READY',
      message: `心跳已装配（同意：${consent.message}；端点：${checked.policy.endpoint}；`
        + `周期：${checked.policy.intervalMs}ms）`,
    }))
    return Object.freeze({
      ok: true, heartbeat, policy: checked.policy,
      diagnostics: Object.freeze(diagnostics),
      message: `心跳已装配（${consent.message}）`,
    })
  } catch (e) {
    // ★ 兜底：心跳是附加能力，任何意外都不许让产品起不来。
    return fail(HEARTBEAT_WIRING_CODES.FAILED,
      `装配心跳时抛错：${e instanceof Error ? e.message : e}`)
  }
}

/**
 * 把 `wireHeartbeat` 的结果接到 Launcher 的 start/stop 上。
 *
 * 返回的 `{ start, stop, diagnostics }` 是 Launcher 唯一需要碰的三个东西。
 * `start`/`stop` 都**不抛**：`stop` 抛出去会把"进程已经停了"这件事
 * 变成一次看起来像停止失败的返回。
 *
 * @returns {{started: boolean, code: string|null, message: string,
 *            diagnostics: Array, start: Function, stop: Function,
 *            status: Function, heartbeat: object|null}}
 */
export function attachHeartbeat(wired, { logger = null } = {}) {
  const diagnostics = [...(wired?.diagnostics ?? [])]
  const heartbeat = wired?.ok === true ? wired.heartbeat : null

  const note = (severity, code, message) => {
    diagnostics.push(Object.freeze({ severity, code, message }))
    if (typeof logger === 'function') logger(`[heartbeat] ${message}`)
    return message
  }

  return Object.freeze({
    heartbeat,
    code: wired?.ok === true ? null : (wired?.code ?? HEARTBEAT_WIRING_CODES.DISABLED),
    message: wired?.message ?? '',
    // ★ 这里**必须**是 `[...diagnostics]` 的快照，不能是 `Object.freeze(diagnostics)`。
    //
    //   第一版写的是 `Object.freeze(diagnostics)`——而那会把**累加器本身**冻住。
    //   于是返回对象一造好，后面每一次 `start()`/`stop()` 里的 `note()` 都会
    //   在 `push` 上抛 `TypeError: Cannot add property N, object is not extensible`。
    //
    //   这个 bug 的坏形态特别隐蔽：`attachHeartbeat()` 本身**不抛**（冻结成功），
    //   装出来的对象看起来完全正常；它只在**第一次 start 或 stop** 时炸——
    //   也就是在产品真正启动/停止的那一刻。
    //
    //     > 一个"在装配时一切正常、在用户按下启动时才炸"的字段所有权问题，
    //     > 与一个正确的实现，在代码审查里长得一样——
    //     > 只不过前者把一次冻结，变成了一个只在运行时出现的异常。
    diagnostics: Object.freeze([...diagnostics]),
    diagnosticsList: () => Object.freeze([...diagnostics]),

    /** 排上定时器。**装配失败时什么也不做**（不是"启动了但内部跳过"）。 */
    start() {
      if (heartbeat === null) return Object.freeze({ started: false, code: wired?.code ?? null, message: wired?.message ?? '' })
      try {
        const r = heartbeat.start()
        if (r.started === true) note('info', 'HEARTBEAT_WIRING_STARTED', `心跳已开始（每 ${r.intervalMs}ms）`)
        else note('warn', r.reason, `心跳没有开始：${r.reason}`)
        return Object.freeze({ ...r, code: r.reason ?? null })
      } catch (e) {
        return Object.freeze({ started: false, code: HEARTBEAT_WIRING_CODES.FAILED, message: note('warn', HEARTBEAT_WIRING_CODES.FAILED, `心跳启动抛错：${e?.message ?? e}`) })
      }
    },

    /**
     * 停掉。**产品停止必须连带停掉心跳**——
     *
     *   一个"产品已经关掉了、心跳还在发"的实现，
     *   与一个关不掉的心跳，在用户点了关闭之后数据还会不会出去上是同一个东西。
     */
    stop() {
      if (heartbeat === null) return Object.freeze({ stopped: false })
      try {
        const r = heartbeat.stop()
        if (r.stopped === true) note('info', 'HEARTBEAT_WIRING_STOPPED', '心跳已停止（产品停止）')
        return Object.freeze(r)
      } catch (e) {
        note('warn', HEARTBEAT_WIRING_CODES.FAILED, `停止心跳时抛错：${e?.message ?? e}`)
        return Object.freeze({ stopped: false })
      }
    },

    status() {
      if (heartbeat === null) {
        return Object.freeze({ wired: false, code: wired?.code ?? null, message: wired?.message ?? '' })
      }
      return Object.freeze({ wired: true, ...heartbeat.status() })
    },
  })
}

/**
 * 便捷入口：装配 + 接上。Launcher 只调这一个。
 *
 * @returns {ReturnType<typeof attachHeartbeat>}
 */
export function createLauncherHeartbeat(deps = {}) {
  return attachHeartbeat(wireHeartbeat(deps), { logger: deps.logger ?? null })
}

export { HEARTBEAT_CODES }
