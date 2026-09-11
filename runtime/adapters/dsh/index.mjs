// runtime/adapters/dsh/index.mjs
// ============================================================================
// DshRuntimeAdapter（PRT-201～PRT-209）
//
// 把 DSH 的**窄端口**（见 port.mjs）包成 Runtime Contract 的 RuntimeAdapter。
// 本文件不 import 任何引擎包；与 DSH 的全部耦合在 port.mjs 的注入面。
//
// ## 核心难点：`run.result` 可能永不结算
//
// plugins/src/index.ts:2241 的现场注释：「subagent 可能挂死且 run.result 永不结算
// （abort 不保证杀死子代理）」。因此 `execute()` 不能简单地 `await run.result`。
//
// 采用**看门狗强制结算**：
//   · `abortedBy = 'timeout'`：看门狗到点 → abort → 立刻以 TIMEOUT 结算，
//     **不再等 result**（等它就是等一个可能永不来的东西）。
//   · 超时后**迟到**的 result 被丢弃并记入 `lateResults`——但不能静默丢弃：
//     一个在超时之后才成功的运行，意味着外部副作用可能已经发生，
//     这正是 `OUTCOME_UNKNOWN` 的判据（见下方 late-result 处理）。
//
// 这里有一个必须说清的安全取舍：**超时结算为 TIMEOUT，而不是 OUTCOME_UNKNOWN**。
// 理由是 TIMEOUT 的 retryability 是 `auto`，而 OUTCOME_UNKNOWN 是 `never`。
// 若一律判 OUTCOME_UNKNOWN，所有超时都会永久锁死、永不重试；
// 若一律判 TIMEOUT，则「其实已经写成功」的那次会被重试 → 重复写入。
// 所以按**是否可能已有外部副作用**分岔：请求声明了写类工具时才升为
// OUTCOME_UNKNOWN。这个判断需要请求侧信息，因此由 `RunPermissions.tools`
// 推断（见 WRITE_TOOL_RE）。判错方向选「更保守」：宁可少重试，不可重复写。
//
// ## 能力协商：探不到就是不可用
//
// `getCapabilities()` 只上报**探测确认**的能力。未探测过时返回空集，
// 而不是乐观地宣称支持——`checkCompatibility` 会因此判不兼容并禁止自动执行，
// 这正是想要的 fail-closed 行为。
// ============================================================================
import {
  RUNTIME_CONTRACT_VERSION,
  checkCompatibility,
  runtimeHealth,
  canClaimTasks,
  assertAdapter,
} from '../../contracts/adapter.mjs'
import {
  cancelResult,
  recoveryResult,
  validateRunRequest,
} from '../../contracts/run.mjs'
import { toModelDescriptor, validateProfile as validateProfileAgainstContract, validationResult, findPlaintextSecrets } from '../../contracts/model.mjs'
import { RuntimeContractError, describeError } from '../../contracts/errors.mjs'

import { assertHostPort, normalizeRunHandle, safeDispose, DshPortError } from './port.mjs'
import { classifyDshError, classifyStopReason, toContractError } from './errors.mjs'
import { validateStructured, validateExpectedOutput } from './schema.mjs'
import { collectUsage, createDurationTracker, checkBudget, PRICING } from './usage.mjs'
import { createEventEmitter, mapDshEvent, terminalTypeFor } from './events.mjs'
import { redactValue } from './redact.mjs'
import { probeRuntime } from './probe.mjs'

/**
 * Legion 的**只读**工具名白名单（前缀匹配）。
 *
 * 方向很关键：我们枚举「确定安全」的，而不是枚举「危险」的。
 * 理由是我们能够列全只读工具（读文件、列目录、查库、搜索），
 * 但**无法列全写类工具**——插件随时可能加一个 `sync_x`、
 * `reconcile_y` 这类从名字看不出会写盘的工具。
 * 按「白名单外一律视为可能写」处理，失效方向是保守的：
 * 误判代价是任务需人工处理（可恢复），
 * 而反过来的误判代价是**重复写入用户数据**（不可恢复）。
 *
 * 调用方如果比我们更清楚，可以用 `permissions.mayHaveExternalEffect`
 * 显式声明，覆盖这个推断——信息最全的一方应该说了算。
 */
export const READ_ONLY_TOOL_PREFIXES = Object.freeze([
  'read', 'list', 'get', 'view', 'show', 'cat', 'stat', 'exists', 'head', 'tail',
  'search', 'glob', 'grep', 'find', 'query', 'diff', 'describe', 'inspect', 'fetch',
])

/**
 * 已知**只读**工具的精确名（前缀规则覆盖不到的）。
 *
 * `web_fetch` 是典型：它做网络 GET，可以安全重试，但名字以 `web_` 开头，
 * 不匹配任何读前缀。对这类「确实知道安全、但不符合命名族」的工具，
 * 用精确名登记，而不是放松前缀匹配（放松会让 `fetch_and_write` 也变成只读）。
 */
export const READ_ONLY_TOOL_EXACT = Object.freeze([
  'web_fetch',
  'web_search',
  'read_image',
])

/** 判定一个工具名看起来是否只读。 */
export function isReadOnlyToolName(name) {
  if (typeof name !== 'string' || name.trim() === '') return false
  const n = name.toLowerCase().trim()
  if (READ_ONLY_TOOL_EXACT.includes(n)) return true
  const stripped = n.replace(/^mcp[._-]/, '')
  return READ_ONLY_TOOL_PREFIXES.some(
    (p) => stripped === p || stripped.startsWith(`${p}_`) || stripped.startsWith(`${p}-`) || stripped.startsWith(`${p}.`),
  )
}

/**
 * 判定一次运行是否可能已产生外部副作用。
 *
 * 这个判断只用于一件事：超时/崩溃后，在 TIMEOUT（可自动重试）与
 * OUTCOME_UNKNOWN（禁止自动重试）之间分岔。所以它必须**宁可保守**。
 *
 * 优先级：
 *   ① `permissions.mayHaveExternalEffect` 显式布尔 → 直接采用（调用方最知情）
 *   ② 工具白名单为空数组 → 没有任何工具能跑 → 不可能有副作用
 *   ③ 全部工具都在只读白名单内 → 视为只读
 *   ④ 其余（含工具列表缺失）→ 视为可能有副作用
 */
export function mayHaveExternalEffect(request) {
  const perms = request?.permissions
  if (perms !== null && typeof perms === 'object') {
    const explicit = perms.mayHaveExternalEffect
    if (typeof explicit === 'boolean') return explicit
  }
  const tools = perms?.tools
  if (!Array.isArray(tools)) return true // 未声明：无法排除
  if (tools.length === 0) return false
  return tools.some((t) => !isReadOnlyToolName(t))
}

/** 默认看门狗宽限：在 timeoutMs 之外额外给引擎的结算时间。 */
export const WATCHDOG_GRACE_MS = 2000
/** 默认取消宽限：abort 后等待 result 自我结算的时间（等不到就强制终态）。 */
export const CANCEL_GRACE_MS = 3000

export const DEFAULT_ADAPTER_OPTIONS = Object.freeze({
  now: () => Date.now(),
  watchdogGraceMs: WATCHDOG_GRACE_MS,
  cancelGraceMs: CANCEL_GRACE_MS,
  pricing: PRICING,
  runtimePolicy: undefined,
  maxTrackedRuns: 500,
})

/**
 * 创建 DSH Runtime Adapter。
 *
 * @param host 宿主端口（引擎的 subagents 与默认模型服务的窄封装）
 * @param options.now 注入时钟（测试可给定时间；超时用例因此不需要真实等待）
 */
export function createDshRuntimeAdapter(host, options = {}) {
  const opts = { ...DEFAULT_ADAPTER_OPTIONS, ...options }
  const now = opts.now

  const portCheck = assertHostPort(host)
  if (!portCheck.ok) {
    // 接线错误必须在**构造时**失败：等到 execute 才炸会把「配置错了」
    // 表现成「运行时崩了」，误导排障方向
    throw new DshPortError(`DSH 宿主端口不合法：\n  - ${portCheck.errors.join('\n  - ')}`)
  }

  /** runId → 活跃运行。用于 cancel/recover 与迟到结果处理。 */
  const active = new Map()
  /** runId → 终态记录（含已结算的取消）。有界，避免长跑进程无上限增长。 */
  const settled = new Map()
  /** 运行期间探测到的能力（只有确认过的才进这里）。 */
  let lastProbe = null
  let lastProbeAt = null
  /** 旁路事件队列：宿主提供事件流时，已映射事件先落这里，由主循环排空。 */
  const streamQueue = []
  /** 看门狗结算之后才到达的结果（诊断用；正常应为空）。 */
  const lateResults = []

  const durations = createDurationTracker(now)

  function remember(runId, entry) {
    settled.set(runId, entry)
    while (settled.size > opts.maxTrackedRuns) {
      const oldest = settled.keys().next().value
      settled.delete(oldest)
    }
  }

  function bumpProbeCache() {
    if (lastProbe !== null && lastProbeAt !== null) {
      return { probe: lastProbe, ageMs: now() - lastProbeAt }
    }
    return { probe: null, ageMs: null }
  }

  // ------------------------------------------------------------ health/caps

  function healthFromProbe(probe, detailOverride) {
    if (probe === null) {
      return runtimeHealth({ state: 'starting', runtimeVersion: null, detail: detailOverride ?? '尚未探测运行时（探测前不宣称可用）' })
    }
    if (probe.ok) {
      return runtimeHealth({
        state: 'ready',
        runtimeVersion: probe.version,
        detail: detailOverride ?? probe.reason,
      })
    }
    // 能力/版本不满足 → incompatible：禁止自动领取任务（PRT-215 语义）
    return runtimeHealth({
      state: 'incompatible',
      runtimeVersion: probe.version,
      detail: detailOverride ?? probe.reason,
    })
  }

  const adapter = {
    runtimeContractVersion: RUNTIME_CONTRACT_VERSION,

    async getHealth() {
      return healthFromProbe(lastProbe)
    },

    async getCapabilities() {
      // 未探测过 → 空集（而非乐观全集）。空集会让 checkCompatibility 判不兼容，
      // 这正是「没确认就不许跑」的表达。
      if (lastProbe === null) return Object.freeze({})
      return Object.freeze({ ...lastProbe.capabilities })
    },

    /**
     * 列出可用模型。
     *
     * `toModelDescriptor` 只暴露 `hasCredential`，**不暴露 `secretRef`**——
     * 模型列表是要显示给用户看的，而引用名本身泄漏密钥库结构
     * （与 §6.7 / `findPlaintextSecrets` 的意图一致）。
     */
    async listModels() {
      const se = []
      if (typeof host.listModels === 'function') {
        const raw = await host.listModels()
        if (!Array.isArray(raw)) throw new DshPortError('host.listModels() 未返回数组')
        for (const p of raw) {
          const leak = findPlaintextSecrets(p)
          if (leak.length > 0) {
            // 宁可拒绝也不把疑似密钥渲染给用户
            throw new RuntimeContractError('SECRET_UNAVAILABLE', '模型配置中检测到疑似明文密钥，已拒绝列表输出', {
              details: { paths: leak.map((l) => l.path ?? String(l)) },
            })
          }
          se.push(toModelDescriptor(p))
        }
        return se
      }
      const sel = await adapter._selection()
      if (sel === null) return []
      return [toModelDescriptor(sel)]
    },

    /** 读当前默认模型选择并归一化为 ModelProfile。 */
    async _selection() {
      if (typeof host.currentModelSelection !== 'function') return null
      let raw
      try {
        raw = host.currentModelSelection()
      } catch (err) {
        throw new RuntimeContractError('MODEL_UNAVAILABLE', `读取默认模型失败：${err?.message ?? String(err)}`, {
          details: { source: redactValue(String(err?.message ?? err)).value },
        })
      }
      if (raw === null || typeof raw !== 'object') return null
      if (raw.provider === undefined || raw.provider === null || raw.provider === '') return null
      return {
        id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : String(raw.provider),
        displayName: typeof raw.displayName === 'string' ? raw.displayName : String(raw.provider),
        runtimeType: 'dsh',
        provider: String(raw.provider),
        model: typeof raw.model === 'string' ? raw.model : '',
        endpoint: typeof raw.endpoint === 'string' ? raw.endpoint : null,
        secretRef: typeof raw.secretRef === 'string' ? raw.secretRef : null,
        reasoningEffort: raw.reasoningEffort,
        limits: raw.limits && typeof raw.limits === 'object' ? raw.limits : {},
      }
    },

    async validateProfile(profile) {
      const started = durations.start('validate')
      // 先过契约（含明文密钥检测与未知字段拒绝），再过运行时可用性
      const contractVerdict = validateProfileAgainstContract(profile)
      if (!contractVerdict.ok) {
        durations.stop('validate')
        // 契约校验器返回的是 `errors: string[]` 而**没有** code/message 字段。
        // 直接读 `contractVerdict.code` 会得到 undefined → 用户看到一个
        // 「配置无效」但没有任何原因的空错误。必须把 errors 带出来。
        const errors = Array.isArray(contractVerdict.errors) ? contractVerdict.errors : []
        const code = errors.some((e) => /明文密钥|secretRef|密钥/.test(e)) ? 'SECRET_UNAVAILABLE' : 'INVALID_RESULT'
        return validationResult({ ok: false, code, message: errors.join('；') || '模型档案不合法' })
      }
      if (lastProbe !== null && !lastProbe.ok) {
        durations.stop('validate')
        return validationResult({ ok: false, code: 'RUNTIME_NOT_READY', message: lastProbe.reason })
      }
      // 不真的调用模型：验证只回答「配置是否可用」，
      // 真实调用属于 execute 且要花钱。耗时字段如实反映「未做网络探测」。
      const ms = durations.stop('validate')
      return validationResult({ ok: true, message: `配置就绪（provider=${profile.provider}）`, latencyMs: ms, capabilities: lastProbe?.capabilities ?? {} })
    },

    async cancel(runId) {
      const arbiter = active.get(runId)
      if (arbiter === undefined) {
        const s = settled.get(runId)
        return cancelResult({ runId, alreadyTerminal: true, terminalType: s?.terminalType ?? null })
      }
      // 标记由调用方发起：让分类器把 AbortError 判为 CANCELLED 而不是 TIMEOUT
      arbiter.cancelledBy = 'caller'
      arbiter.abort('caller')
      // 等一小段看它能否自我结算；等不到就强制终态（abort 不保证杀死子代理）
      const raced = await arbiter.settleWithin(opts.cancelGraceMs)
      return cancelResult({
        runId,
        alreadyTerminal: raced !== 'forced' ? false : false,
        terminalType: arbiter.terminalType ?? (raced === 'forced' ? 'run.cancelled' : null),
      })
    },

    async recover(runId) {
      const entry = settled.get(runId)
      if (entry !== undefined) {
        return recoveryResult({ runId, decision: 'already-terminal', reason: `已结算（${entry.terminalType}），不得重复执行`, resumable: false })
      }
      const live = active.get(runId)
      if (live !== undefined) {
        return recoveryResult({ runId, decision: 'resume-same-run', reason: '运行仍在进行，可继续等待其终态', resumable: true })
      }
      // 未知：本进程没见过这个 runId。可能是进程崩溃前的运行。
      // **不猜**它是否产生了副作用 → outcome-unknown（禁止自动重试写入）。
      return recoveryResult({
        runId,
        decision: 'outcome-unknown',
        reason: '本进程无该运行的记录（进程可能已重启）；无法确认是否已产生外部副作用，禁止自动重试写入',
        resumable: false,
      })
    },

    execute,
  }

  // ------------------------------------------------------------------ execute

  /**
   * 执行一次 Run，产出 RunEvent 流。
   *
   * 是 async generator：消费方可以提前 break，此时 `finally` 会 abort 并 dispose，
   * 不会留下悬挂的子代理。
   */
  async function* execute(request) {
    const reqCheck = validateRunRequest(request)
    if (!reqCheck.ok) {
      throw new RuntimeContractError('INVALID_RESULT', `RunRequest 不合法：${reqCheck.errors.join('；')}`, {
        details: { errors: reqCheck.errors },
      })
    }
    const outCheck = validateExpectedOutput(request.expectedOutput)
    if (!outCheck.ok) {
      throw new RuntimeContractError('INVALID_RESULT', `期望输出未声明清楚：${outCheck.errors.join('；')}`, {
        details: { errors: outCheck.errors },
      })
    }

    const runId = request.runId
    if (active.has(runId)) {
      throw new RuntimeContractError('INVALID_RESULT', `runId ${runId} 已在运行中（同一 Run 不得并发执行）`, { details: { runId } })
    }
    const prior = settled.get(runId)
    if (prior !== undefined) {
      throw new RuntimeContractError('INVALID_RESULT', `runId ${runId} 已结算（${prior.terminalType}）；重试必须创建新 Attempt/Run`, {
        details: { runId, terminalType: prior.terminalType },
      })
    }

    // 每次运行一个独立的取消通道。传进 startRun，是唯一能让引擎真正停下的手段。
    const controller = new AbortController()

    const emitter = createEventEmitter({ runId, now })
    const writeRisk = mayHaveExternalEffect(request)

    // ---- 单次终态与「结算或超时」的竞速 -------------------------------------
    let handle = null
    let abortedBy = null
    let resultValue = undefined
    let resultError = undefined
    let resultSettled = false
    let lateResultSeen = null
    let forced = false
    let resolveSettle
    const settlePromise = new Promise((r) => { resolveSettle = r })

    const onResultOk = (r) => {
      resultValue = r
      resultSettled = true
      if (forced) {
        // 迟到结果必须在**它到达时**记录。放在 finally 里记录是错的：
        // 看门狗强制结算时 finally 早已跑过，等结果真的迟到时
        // 已经没有任何人在监听了——那个结果会彻底消失。
        lateResultSeen = r
        lateResults.push({ runId, at: now(), lateResult: redactValue(r).value })
        return
      }
      resolveSettle('settled')
    }
    const onResultErr = (e) => {
      resultError = e
      resultSettled = true
      if (forced) {
        lateResultSeen = { error: e }
        lateResults.push({ runId, at: now(), lateResult: redactValue({ error: String(e?.message ?? e) }).value })
        return
      }
      resolveSettle('settled')
    }

    const abort = (by) => {
      if (abortedBy === null) abortedBy = by
      // 真正的取消手段是中断传给 startRun 的 signal。
      // `run.dispose()` 只回收资源，不保证停止推理——生产注释明确写了
      // 「abort 不保证杀死子代理」，所以这里两件事都做。
      try {
        controller.abort()
      } catch { /* 忽略：abort 失败由看门狗兜底 */ }
    }

    const arbiter = {
      abort,
      get cancelledBy() { return abortedBy },
      set cancelledBy(v) { abortedBy = abortedBy ?? v },
      get terminalType() { return emitter.terminalType() },
      /** 在 ms 内等自我结算；超时返回 'forced'。 */
      async settleWithin(ms) {
        const raced = await Promise.race([
          settlePromise,
          new Promise((r) => setTimeout(() => r('forced'), ms)),
        ])
        if (raced === 'forced') forced = true
        return raced
      },
    }
    // 从这里起的一切都必须可撤销：消费方可以在**任意** yield 处提前 return，
    // 生成器的 finally 必须完成 abort / dispose / 清账。
    //
    // 首个 yield 也必须在 try 内。若把 active.set 放在 try 之外再 yield，
    // 「消费方提前 break」就会漏掉那条 active 登记，留下一个幽灵运行——
    // 它既不会结算，也永远挡住同 runId 的后续执行。
    // 而 active.set 又不能晚于首个 yield，否则两个并发 execute 会同时通过
    // 上面的 `active.has` 检查（登记前就让出，竞态窗口）。
    // 两个约束夹出的唯一解：登记与全部 yield 同在一个 try 里。
    try {
      active.set(runId, arbiter)
      durations.start(runId)

      // ---- 事件 1：run.started ----------------------------------------------
      yield emitter.emit('run.started', { attemptId: request.attemptId, employeeId: request.employeeId, taskId: request.taskId })

    // ---- 事件 2：model.selected --------------------------------------------
    let selection = null
    try {
      selection = await adapter._selection()
      if (selection === null) {
        throw new RuntimeContractError('MODEL_UNAVAILABLE', '未配置默认模型，无法执行', { details: { runId } })
      }
      // 必须 **yield** 而不是只 emit：emit 只负责分配 seq 并做终态仲裁，
      // 事件要进入流才会被消费方看到。（此前的写法 emit 了但没 yield，
      // 于是 model.selected 在流里凭空消失——正好是「审计看起来对、
      // 实际缺一条」这类最难发现的缺陷。）
      yield emitter.emit('model.selected', {
        // 只报 provider/model，**不报 secretRef**（引用名不进事件流）
        provider: selection.provider,
        model: selection.model,
        reasoningEffort: selection.reasoningEffort ?? null,
      })
    } catch (err) {
      // 模型问题不该把整个 adapter 拖垮：作为本次运行的终态失败结算
      const classification = err instanceof RuntimeContractError
        ? { code: err.code, unknown: false, detail: err.message, why: '模型选择阶段失败' }
        : classifyDshError(err, {})
      const terminal = terminalTypeFor(null, classification)
      active.delete(runId)
      const result = buildResult({ runId, request, outcome: outcomeFor(classification.code), code: classification.code, output: null, usage: null, outcomeUnknown: false })
      remember(runId, { terminalType: terminal, at: now() })
      yield emitter.emit(terminal, { code: classification.code, result })
      return
    }

    // ---- 启动运行 -----------------------------------------------------------
    const timeoutMs = request.timeoutMs
    const watchdogMs = timeoutMs + opts.watchdogGraceMs
    let watchdogFired = false
    const watchdog = setTimeout(() => {
      watchdogFired = true
      forced = true
      // 看门狗到点：先 abort，再立刻结算——**不等 result**（它可能永不来）
      abort('timeout')
      if (!resultSettled) resolveSettle('timeout')
    }, watchdogMs)

    try {
      let rawHandle
      try {
        rawHandle = await host.startRun(selection.provider, {
          label: `run:${request.taskId}:${request.attemptId}`,
          prompt: [{ type: 'text', text: requestPrompt(request) }],
          signal: controller.signal,
          outputSchema: request.expectedOutput.schema,
        })
      } catch (err) {
        clearTimeout(watchdog)
        const classification = classifyDshError(err, { abortedBy })
        const terminal = terminalTypeFor(null, classification)
        active.delete(runId)
        const code = classification.code
        const result = buildResult({
          runId, request,
          outcome: outcomeFor(code),
          code,
          output: null,
          usage: null,
          // 启动阶段就失败 → 不可能有外部副作用（还没跑起来）
          outcomeUnknown: false,
        })
        remember(runId, { terminalType: terminal, at: now() })
        yield emitter.emit(terminal, { code, result })
        return
      }

      handle = normalizeRunHandle(rawHandle)
      for (const w of handle.warnings) emitter.emit('run.progress', { warning: w })

      // 可选：宿主提供事件流 → 逐条映射（不合成）
      if (handle.events !== null && typeof handle.events?.[Symbol.asyncIterator] === 'function') {
        // 事件流是**旁路**：它可能先于 result 结束，也可能永不结束。
        // 因此不 await 它，只在后台消费并把结果放进队列，由主循环按需取出。
        // 直接 await 会让我们重新陷入「等一个可能永不到来的东西」。
        consumeStream(handle.events, emitter, streamQueue).catch(() => undefined)
      }

      handle.result.then(onResultOk, onResultErr)

      const outcome = await settlePromise
      clearTimeout(watchdog)

      // 排空已到达的旁路事件（不阻塞：队列里有多少取多少）
      while (streamQueue.length > 0) {
        yield streamQueue.shift()
      }

      // ---- 超时未结算：强制终态 -------------------------------------------
      if (outcome === 'timeout' || (forced && !resultSettled)) {
        const code = writeRisk ? 'OUTCOME_UNKNOWN' : 'TIMEOUT'
        const classification = {
          code,
          unknown: code === 'OUTCOME_UNKNOWN',
          detail: `运行未在 ${watchdogMs}ms 内结算（看门狗强制结算）`,
          why: writeRisk
            ? '超时且请求可能含写类工具：无法确认外部副作用是否已发生 → 禁止自动重试'
            : '超时且请求未声明写类工具：判为可自动重试的超时',
        }
        const terminal = terminalTypeFor(null, classification)
        const result = buildResult({
          runId, request,
          outcome: outcomeFor(code),
          code,
          output: null,
          usage: null,
          outcomeUnknown: code === 'OUTCOME_UNKNOWN',
        })
        remember(runId, { terminalType: terminal, at: now(), lateResult: null })
        yield emitter.emit(terminal, { code, result })
        // abort + dispose 在 finally 里做
        return
      }

      // ---- 已结算：分类 + 校验 --------------------------------------------
      if (resultError !== undefined) {
        const classification = classifyDshError(resultError, { abortedBy })
        const terminal = terminalTypeFor(null, classification)
        const code = classification.code
        const result = buildResult({
          runId, request,
          outcome: outcomeFor(code),
          code,
          output: null,
          usage: null,
          // 抛异常时是否可能有副作用：看写风险
          outcomeUnknown: writeRisk && !isDefinitelyPreEffect(code),
        })
        remember(runId, { terminalType: terminal, at: now() })
        yield emitter.emit(terminal, { code, result })
        return
      }

      const stopClassification = classifyStopReason(resultValue?.stopReason)
      let code = stopClassification.code
      let output = null
      let unknown = stopClassification.unknown

      if (code === null) {
        // completed → 结构化输出必须存在且通过校验（PRT-204）
        if (resultValue?.structured === undefined) {
          code = 'INVALID_RESULT'
          output = null
        } else {
          const check = validateStructured(request.expectedOutput.schema, resultValue.structured)
          if (check.ok) {
            output = resultValue.structured
          } else {
            code = 'INVALID_RESULT'
            output = null
          }
          if (!check.ok) {
            const terminal = terminalTypeFor(null, { code })
            const result = buildResult({
              runId, request, outcome: outcomeFor(code), code, output: null, usage: collectUsage(resultValue, { pricing: opts.pricing, model: selection.model }),
              outcomeUnknown: false,
              extraUserMessage: `结构化输出未通过校验：${check.errors.slice(0, 3).join('；')}`,
            })
            remember(runId, { terminalType: terminal, at: now() })
            yield emitter.emit(terminal, { code, result, validationErrors: check.errors })
            return
          }
        }
      }

      const usage = collectUsage(resultValue, { pricing: opts.pricing, model: selection.model })

      // 预算闸门（PRT-207 的采集 + 判定；超预算判 BUDGET_EXCEEDED）
      const budgetHit = checkBudget({ budget: request.budget, usage })
      if (budgetHit !== null && code === null) {
        code = budgetHit.kind === 'cost-unknown' ? 'BUDGET_EXCEEDED' : 'BUDGET_EXCEEDED'
        output = null
      }

      const terminal = terminalTypeFor(resultValue?.stopReason, { code })
      const result = buildResult({
        runId, request,
        outcome: outcomeFor(code),
        code,
        output,
        usage,
        outcomeUnknown: false,
        extraUserMessage: budgetHit !== null ? budgetHit.message : undefined,
        budgetHit,
      })
      remember(runId, {
        terminalType: terminal,
        at: now(),
        usage,
        validationErrors: code === 'INVALID_RESULT' ? (stopClassification.unknown ? ['未识别的 stopReason'] : []) : undefined,
      })
      yield emitter.emit(terminal, { code, result, ...(usage !== null ? { usage } : {}) })
    } finally {
      // 只负责计时器；其余清理统一在外层 finally（它覆盖提前 break 的路径）
      clearTimeout(watchdog)
    }
    } finally {
      active.delete(runId)
      durations.stop(runId)
      // 未结算就离开（看门狗判定 / 消费方提前 break）→ 必须 abort，
      // 否则子代理还在跑而我们以为结束了
      if (!resultSettled) abort('caller')
      void safeDispose(handle, () => undefined)
    }
  }

  async function consumeStream(events, emitter, queue) {
    try {
      for await (const raw of events) {
        const mapped = mapDshEvent(raw)
        queue.push(emitter.emit(mapped.type, { ...mapped.payload, ...(mapped.unmapped ? { unmapped: true } : {}) }))
        // 旁路事件不得无限堆积：超出上限丢最旧的并记一条
        if (queue.length > 200) {
          queue.splice(0, queue.length - 200)
        }
      }
    } catch {
      // 事件流断了不是运行失败：终态由 result 决定
    }
  }

  function buildResult({ runId, request, outcome, code, output, usage, outcomeUnknown, extraUserMessage, budgetHit }) {
    const entry = code === null ? null : describeError(code)
    return {
      runId,
      attemptId: request.attemptId,
      outcome,
      code,
      output,
      usage,
      outcomeUnknown,
      userMessage: extraUserMessage ?? entry?.userMessage ?? '运行完成',
      ...(budgetHit !== null && budgetHit !== undefined ? { budgetViolation: budgetHit } : {}),
    }
  }

  /** 该错误码是否**确定**发生在任何外部副作用之前。 */
  function isDefinitelyPreEffect(code) {
    return code === 'AUTH_FAILED' || code === 'SECRET_UNAVAILABLE' || code === 'MODEL_UNAVAILABLE' ||
      code === 'RATE_LIMITED' || code === 'CONTEXT_TOO_LARGE' || code === 'RUNTIME_UNAVAILABLE' ||
      code === 'RUNTIME_NOT_READY' || code === 'UNSUPPORTED_CAPABILITY'
  }

  function outcomeFor(code) {
    if (code === null) return 'succeeded'
    if (code === 'CANCELLED') return 'cancelled'
    if (code === 'TIMEOUT') return 'timed-out'
    if (code === 'OUTCOME_UNKNOWN') return 'outcome-unknown'
    return 'failed'
  }

  /**
   * 组装 prompt 文本。
   *
   * 阶段 2 只做**最小**包装：真正的上下文装配属于 §6.5 Context Assembler（阶段 4）。
   * 这里刻意不塞任何「聪明」的格式，避免阶段 4 的实现者以为
   * 现有措辞有语义而保留它。
   */
  function requestPrompt(request) {
    return [
      `任务：${request.taskId}`,
      `目标：${request.goalId}`,
      `员工：${request.employeeId}`,
      `验收：${request.expectedOutput.acceptance}`,
    ].join('\n')
  }

  adapter._internals = {
    lateResults,
    activeRuns: () => [...active.keys()],
    settledCount: () => settled.size,
    probe: () => lastProbe,
    lateResultsList: () => lateResults.slice(),
  }

  /** 主动探测一次运行时并缓存结果（PRT-209 / PRT-215 的入口）。 */
  adapter.probe = async function probeAndCache() {
    const probe = await probeRuntime(host, opts.runtimePolicy)
    lastProbe = probe
    lastProbeAt = now()
    return probe
  }

  adapter.checkCompatibilityNow = async function checkCompatibilityNow() {
    // 先看版本/能力探测的**总体**结论，再看逐项能力。
    //
    // 只查能力是不够的：版本不兼容的运行时会照样把 4 项必需能力全报 true，
    // 于是协商说「兼容」，而实际上补丁层按主版本固定、我们已经认不出它了。
    // 一个漏掉版本门禁的协商函数，比没有协商更危险——它会给出一个
    // 有依据样子的「可以跑」。
    if (lastProbe !== null && !lastProbe.ok) {
      return {
        compatible: false,
        code: 'UNSUPPORTED_CAPABILITY',
        userMessage: '执行引擎与当前产品版本不兼容，已停止自动执行。',
        reason: lastProbe.reason,
        missingRequired: [...lastProbe.requiredMissing],
      }
    }
    const caps = await adapter.getCapabilities()
    return checkCompatibility({ adapterContractVersion: RUNTIME_CONTRACT_VERSION, capabilities: caps })
  }

  const selfCheck = assertAdapter(adapter)
  if (!selfCheck.ok) {
    throw new DshPortError(`DshRuntimeAdapter 自身不符合契约：\n  - ${selfCheck.errors.join('\n  - ')}`)
  }

  return adapter
}
