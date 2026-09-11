// runtime/contracts/fake-adapter.mjs
// ============================================================================
// 内存 FakeRuntimeAdapter（PRT-107）
//
// 目标（spec §6.1 完成标准）：**不启动 DSH 即可测试正常、失败、取消、超时和恢复编排。**
//
// 设计约束：
//   - 零 I/O、零真实计时器、零随机数。时间由 `now()` 注入，事件序列由脚本决定。
//     否则编排测试会变成 flaky 测试，而编排恰恰是最需要确定性断言的地方。
//   - 故障注入覆盖**全部**标准错误码，而不只是「失败」一种：重试分类是编排的核心，
//     只测失败路径无法验证 TIMEOUT / OUTCOME_UNKNOWN 这类需要前置条件的码。
//   - 提供调用记录（`calls`），用于断言"recover 不修改 Task 状态"这类**否定性**要求。
//
// 与测试替身的分工：本文件是**契约级**替身，随契约一起维护，供所有下游测试复用；
// 单个测试自己的局部 stub 不应复制这里的故障矩阵。
// ============================================================================

import { RUNTIME_CONTRACT_VERSION } from './adapter.mjs'
import { ERROR_CODES, RuntimeContractError, describeError } from './errors.mjs'
import { TERMINAL_TO_OUTCOME, validateRunRequest } from './run.mjs'

/** 支持的场景类型 → 终态事件类型与错误码。 */
export const FAKE_SCENARIOS = Object.freeze({
  success: Object.freeze({ terminal: 'run.completed', code: null }),
  failure: Object.freeze({ terminal: 'run.failed', code: 'MODEL_UNAVAILABLE' }),
  'auth-failed': Object.freeze({ terminal: 'run.failed', code: 'AUTH_FAILED' }),
  'rate-limited': Object.freeze({ terminal: 'run.failed', code: 'RATE_LIMITED' }),
  'secret-unavailable': Object.freeze({ terminal: 'run.failed', code: 'SECRET_UNAVAILABLE' }),
  'budget-exceeded': Object.freeze({ terminal: 'run.failed', code: 'BUDGET_EXCEEDED' }),
  'context-too-large': Object.freeze({ terminal: 'run.failed', code: 'CONTEXT_TOO_LARGE' }),
  'invalid-result': Object.freeze({ terminal: 'run.failed', code: 'INVALID_RESULT' }),
  timeout: Object.freeze({ terminal: 'run.failed', code: 'TIMEOUT' }),
  crash: Object.freeze({ terminal: 'run.failed', code: 'RUNTIME_CRASHED' }),
  'outcome-unknown': Object.freeze({ terminal: 'run.outcome_unknown', code: 'OUTCOME_UNKNOWN' }),
  cancelled: Object.freeze({ terminal: 'run.cancelled', code: 'CANCELLED' }),
  // 协议违规注入：事件流**不**以终态结束。用于验证编排侧真的会检出契约违反，
  // 而不是默默把半个流当成成功。
  'no-terminal': Object.freeze({ terminal: null, code: null }),
})

/** 默认能力表：满足全部必需能力，可选能力默认开启，便于多数测试直接用。 */
const DEFAULT_CAPABILITIES = Object.freeze({
  'tool-permission-enforcement': true,
  'cancel-and-timeout': true,
  'structured-result': true,
  'usage-reporting': true,
  'streaming-deltas': true,
  'artifact-emission': true,
  'session-resume': false,
  'sandbox-enforcement': true,
  'mcp-tools': false,
})

/**
 * 创建一个内存 FakeRuntimeAdapter。
 *
 * @param {object} [options]
 * @param {() => number} [options.now] 时间源（确定性测试用）
 * @param {object} [options.capabilities] 覆盖默认能力表
 * @param {string} [options.health] 初始健康状态
 * @param {object} [options.models] 可用模型描述列表
 * @param {string} [options.defaultScenario] 默认场景（默认 success）
 * @param {(req: object) => object} [options.planFor] 按 RunRequest 决定场景的高级钩子
 */
export function createFakeRuntimeAdapter(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const capabilities = { ...DEFAULT_CAPABILITIES, ...(options.capabilities ?? {}) }
  let health = options.health ?? 'ready'
  const defaultScenario = options.defaultScenario ?? 'success'

  /** runId → 场景；未指定者用 defaultScenario / planFor。 */
  const scenarios = new Map()
  /** runId → 显式事件脚本（最高优先级）。 */
  const explicitScripts = new Map()
  /** runId → 是否已收到取消请求。 */
  const cancelRequested = new Set()
  /** runId → 已提交终态类型（取消幂等与迟到事件判定用）。 */
  const settled = new Map()
  /** 调用记录：用于否定性断言（如 recover 未产生 Task 写入）。 */
  const calls = []

  const models = options.models ?? [
    { id: 'fake-model', displayName: 'Fake Model', provider: 'fake', model: 'fake-1' },
  ]

  const record = (name, payload) => {
    calls.push({ name, at: now(), payload })
  }

  /** 取该 run 的场景名。 */
  function scenarioFor(request) {
    if (scenarios.has(request.runId)) return scenarios.get(request.runId)
    if (typeof options.planFor === 'function') {
      const planned = options.planFor(request)
      if (typeof planned === 'string') return planned
      if (planned && typeof planned === 'object' && typeof planned.kind === 'string') return planned.kind
    }
    return defaultScenario
  }

  /**
   * 依据场景构造事件序列（不含终态；终态由调用方决定是否追加）。
   */
  function buildBody(request, scenario) {
    const events = []
    let seq = 1
    const push = (type, extra = {}) => {
      events.push({ type, runId: request.runId, seq: seq++, at: now(), ...extra })
    }

    push('run.started', { attemptId: request.attemptId })
    push('model.selected', { provider: request.modelProfileRef, model: 'fake-1' })

    // success / invalid-result 才产出内容，其余场景在中途失败更贴近真实
    if (scenario === 'success' || scenario === 'invalid-result') {
      push('message.delta', { text: 'working' })
      push('tool.requested', { toolName: 'fs.read', callId: 'call-1' })
      push('tool.started', { toolName: 'fs.read', callId: 'call-1' })
      push('tool.completed', { toolName: 'fs.read', callId: 'call-1', ok: true })
      push('artifact.produced', { path: 'out/result.json' })
    } else if (scenario === 'outcome-unknown' || scenario === 'crash' || scenario === 'timeout') {
      // 这三类必须体现「可能已产生外部副作用」：先发起一次写工具，再中断。
      // 少了这一步，测试就验证不了「未确认外部副作用时不得自动重试」。
      push('tool.requested', { toolName: 'http.post', callId: 'call-write', mutating: true })
      push('tool.started', { toolName: 'http.post', callId: 'call-write' })
    }

    push('usage.updated', { tokensIn: 120, tokensOut: 40, estimatedCostUsd: 0.0012 })
    return events
  }

  /** 构造终态事件与 RunResult。 */
  function buildTerminal(request, scenario) {
    const spec = FAKE_SCENARIOS[scenario]
    if (!spec || !spec.terminal) return null
    const outcome = TERMINAL_TO_OUTCOME[spec.terminal]
    const result = {
      runId: request.runId,
      attemptId: request.attemptId,
      outcome,
      code: spec.code,
      // 只有 completed 才有结构化结果；其余场景 output 为空
      output: outcome === 'completed' ? { status: 'ok', summary: 'fake run completed' } : null,
      usage: { tokensIn: 120, tokensOut: 40, estimatedCostUsd: 0.0012 },
      // 这三类场景的外部副作用未被确认（spec §6.1：不得伪装成功、不得自动重复写入）
      outcomeUnknown: outcome === 'outcome_unknown' || scenario === 'crash' || scenario === 'timeout',
      userMessage: spec.code === null ? '运行已完成。' : describeError(spec.code).userMessage,
    }
    return { type: spec.terminal, runId: request.runId, at: now(), result, code: spec.code }
  }

  const adapter = {
    runtimeContractVersion: RUNTIME_CONTRACT_VERSION,

    async getHealth() {
      record('getHealth')
      return { state: health, contractVersion: RUNTIME_CONTRACT_VERSION, runtimeVersion: 'fake-0.0.0', detail: '内存替身' }
    },

    async getCapabilities() {
      record('getCapabilities')
      return { ...capabilities }
    },

    async listModels() {
      record('listModels')
      return models.map((m) => ({ ...m }))
    },

    async validateProfile(profile) {
      record('validateProfile', { id: profile?.id })
      const known = models.some((m) => m.model === profile?.model || m.id === profile?.id)
      return {
        ok: known,
        code: known ? null : 'MODEL_UNAVAILABLE',
        message: known ? '模型可用' : '模型不在可用列表中',
        latencyMs: 1,
        capabilities: { streaming: true },
      }
    },

    /**
     * 执行。返回 AsyncIterable<RunEvent>，**必须**以终态事件结束。
     * 取消在事件边界生效：发出取消请求后，下一个边界产出 run.cancelled 终态。
     */
    async *execute(request) {
      record('execute', { runId: request.runId })
      const check = validateRunRequest(request)
      if (!check.ok) {
        throw new RuntimeContractError('INVALID_RESULT', `RunRequest 非法：${check.errors.join('; ')}`)
      }

      const scenario = scenarioFor(request)
      if (!FAKE_SCENARIOS[scenario]) {
        throw new RuntimeContractError('UNSUPPORTED_CAPABILITY', `未知 Fake 场景：${String(scenario)}`)
      }

      const explicit = explicitScripts.get(request.runId)
      const body = explicit ? explicit.map((e) => ({ ...e })) : buildBody(request, scenario)

      let seq = body.length > 0 ? Math.max(...body.map((e) => e.seq ?? 0)) + 1 : 1
      for (const event of body) {
        // 每个事件边界检查取消：真实执行也只能在边界处停下
        if (cancelRequested.has(request.runId)) {
          const terminal = {
            type: 'run.cancelled',
            runId: request.runId,
            seq,
            at: now(),
            result: {
              runId: request.runId,
              attemptId: request.attemptId,
              outcome: 'cancelled',
              code: 'CANCELLED',
              output: null,
              usage: null,
              outcomeUnknown: false,
              userMessage: describeError('CANCELLED').userMessage,
            },
            code: 'CANCELLED',
          }
          settled.set(request.runId, 'run.cancelled')
          yield terminal
          return
        }
        yield event
      }

      // 显式脚本模式下由脚本自带终态；否则按场景生成
      const terminal = explicit ? null : buildTerminal(request, scenario)
      if (terminal === null) {
        if (explicit) {
          // 脚本模式：找到脚本里的终态；没有就按 no-terminal 违规输出
          const t = body.find((e) => TERMINAL_TO_OUTCOME[e.type] !== undefined)
          if (t) {
            settled.set(request.runId, t.type)
            yield { ...t, seq, at: now() }
            return
          }
        }
        // 协议违规注入：流结束但没有终态
        return
      }

      terminal.seq = seq
      settled.set(request.runId, terminal.type)
      yield terminal
    },

    /** 取消：幂等。重复取消返回同一结论，不产生第二次副作用。 */
    async cancel(runId) {
      record('cancel', { runId })
      const existing = settled.get(runId)
      if (existing) {
        return { runId, accepted: true, alreadyTerminal: true, terminalType: existing }
      }
      cancelRequested.add(runId)
      return { runId, accepted: true, alreadyTerminal: false, terminalType: null }
    },

    /**
     * 恢复判断。**不修改任何 Task 状态**（spec §6.1）——返回对象显式声明
     * `mutatesTaskState: false`，且本替身不持有 Task 状态可供修改。
     *
     * 判定顺序有讲究：先看「外部结果是否仍未确认」，再看「是否已有终态」。
     * 一个已提交的 RUNTIME_CRASHED / TIMEOUT 终态**并不能回答**「那次外部写到底
     * 生效了没有」——它只说明运行结束了。因此这类 run 的恢复结论必须是
     * `outcome-unknown`，而不是 `already-terminal`；后者会诱导编排直接收口，
     * 把一次可能已生效的写操作当成没发生。
     */
    async recover(runId) {
      record('recover', { runId })
      const scenario = scenarios.get(runId)
      if (scenario === 'timeout' || scenario === 'crash' || scenario === 'outcome-unknown') {
        return {
          runId,
          decision: 'outcome-unknown',
          reason: '崩溃/超时发生在外部写之后，无法确认结果',
          resumable: false,
          mutatesTaskState: false,
        }
      }
      const existing = settled.get(runId)
      if (existing) {
        return { runId, decision: 'already-terminal', reason: `已提交 ${existing}`, resumable: false, mutatesTaskState: false }
      }
      return { runId, decision: 'retry-new-attempt', reason: '未观察到外部副作用', resumable: false, mutatesTaskState: false }
    },
  }

  // ---------------------------------------------------------------- 测试控制面
  // 这些方法不属于 RuntimeAdapter 契约，仅测试使用；因此不以契约方法命名。

  Object.assign(adapter, {
    /** 为某个 runId 指定场景。 */
    setScenario(runId, scenario) {
      if (!FAKE_SCENARIOS[scenario]) throw new Error(`未知场景：${scenario}`)
      scenarios.set(runId, scenario)
    },
    /** 为某个 runId 指定显式事件脚本（完全控制事件序列）。 */
    setEventScript(runId, events) {
      explicitScripts.set(runId, events)
    },
    /** 切换健康状态。 */
    setHealth(state) {
      health = state
    },
    /** 全部调用记录。 */
    get calls() {
      return [...calls]
    },
    /** 某方法被调用的次数（否定性断言用）。 */
    callCount(name) {
      return calls.filter((c) => c.name === name).length
    },
    /** 已提交终态类型。 */
    settledType(runId) {
      return settled.get(runId) ?? null
    },
    reset() {
      scenarios.clear()
      explicitScripts.clear()
      cancelRequested.clear()
      settled.clear()
      calls.length = 0
      health = options.health ?? 'ready'
    },
  })

  return adapter
}

/** 供测试断言用：全部标准错误码在 Fake 中都可注入。 */
export const INJECTABLE_ERROR_CODES = Object.freeze(
  ERROR_CODES.filter((c) => Object.values(FAKE_SCENARIOS).some((s) => s.code === c)),
)
