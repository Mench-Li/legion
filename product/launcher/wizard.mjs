// ============================================================================
// PRT-707 首次运行向导
//
// spec §6.10 完成标准：「干净 Windows 机器**不打开终端**即可完成
// 安装后启动、模型配置、运行和停止。」
//
// ── 本模块唯一真正要紧的那条纪律 ──
//
// **向导说「完成」，与产品真的能跑，不是同一件事。**
//
// 一个向导最容易犯的错，是把"每一步都返回了 ok"当成"产品可用了"：
//
//   · `start()` 说它启动了 —— 那说的是"我发出了 spawn"，
//     不是"进程起来了、端口在听、健康检查过了"；
//   · 模型配置写进去了 —— 那说的是"我写了一条记录"，
//     不是"这条记录能被解析成一个可用的模型"；
//   · 所有步骤都没报错 —— 那说的是"没有异常冒到这一层"。
//
// 于是用户看到「✅ 安装完成，一切就绪」，然后第一次点"运行"就失败。
// 而这时他已经关掉了向导，不知道从哪儿查起。
//
//   > 一个"每一步都返回成功就报完成"的向导，
//   > 与一个"不管做没做成都说完成了"的向导，
//   > 在"用户第一次点运行的时候会不会成功"上是同一个东西。
//
// 所以最后一步不是"汇总前面几步的返回值"，而是**重新去看一眼产品**：
// `verify` 独立观测（就绪探针 + 模型能否解析），**只有观测到正面结论才算过**。
// 观测失败、观测抛错、观测返回了说不清的东西——一律**不算过**。
//
// ── 第二条纪律：要用户输入的那一步必须**真的挡住** ──
//
// 首次运行向导里「模型配置」需要用户提供一个密钥。一个"跳过它继续跑"的
// 向导会在最后报"完成"，而产品其实没有模型可用——
// 于是用户第一次运行任务时失败，且不知道是模型没配。
//
// 所以需要输入的那一步在没拿到输入时**停在原地**，并且
// `status()` 要明确说出"我在等什么"。
//
// ── 第三条纪律：向导会被打断 ──
//
// 首次运行向导天然会被打断（用户去拿密钥、去装东西、去重启）。
// 状态要能存下来，重跑时**从断点继续**，而不是从头再来一遍——
// 一个每次都从头开始的向导，会在"删掉上次建了一半的东西"这件事上
// 制造出比它解决的问题更多的问题。
// ============================================================================

/** 六个步骤。**顺序即依赖顺序**：后一步的前提是前一步真的过了。 */
export const WIZARD_STEP_IDS = Object.freeze([
  'environment', 'initialize', 'start', 'configure-model', 'verify', 'done',
])

/** 向导的诊断码。 */
export const WIZARD_CODES = Object.freeze({
  STEP_FAILED: 'WIZARD_STEP_FAILED',
  NEEDS_INPUT: 'WIZARD_NEEDS_INPUT',
  PRECONDITION_UNMET: 'WIZARD_PRECONDITION_UNMET',
  ALREADY_DONE: 'WIZARD_ALREADY_DONE',
  BAD_INPUT: 'WIZARD_BAD_INPUT',
  /** 观测没能给出正面结论 —— 这是本模块存在的理由。 */
  NOT_OBSERVED: 'WIZARD_NOT_OBSERVED',
  STATE_UNREADABLE: 'WIZARD_STATE_UNREADABLE',
  STATE_WRITE_FAILED: 'WIZARD_STATE_WRITE_FAILED',
  UNKNOWN_STEP: 'WIZARD_UNKNOWN_STEP',
})

/** 步骤类型。`input` 类必须停下来等用户。 */
export const STEP_KINDS = Object.freeze({
  AUTOMATIC: 'automatic',
  INPUT: 'input',
  VERIFY: 'verify',
})

/**
 * 步骤定义。`blockingReason` 是给用户看的那句话——
 * 一个只说"未完成"的向导，会让用户不知道下一步该干什么。
 */
export const WIZARD_STEP_DEFS = Object.freeze({
  environment: Object.freeze({
    id: 'environment', kind: STEP_KINDS.AUTOMATIC, title: '检查运行环境',
    blockingReason: '运行环境不满足要求（目录不可写、端口被占或 Node 版本过低）',
  }),
  initialize: Object.freeze({
    id: 'initialize', kind: STEP_KINDS.AUTOMATIC, title: '初始化产品目录',
    blockingReason: '产品目录还没有建立',
  }),
  start: Object.freeze({
    id: 'start', kind: STEP_KINDS.AUTOMATIC, title: '启动组件',
    blockingReason: '组件没有启动成功',
  }),
  'configure-model': Object.freeze({
    id: 'configure-model', kind: STEP_KINDS.INPUT, title: '配置模型',
    // 「需要用户提供密钥」是这一步**正常**的状态，不是错误。
    // 把它说成错误，用户会以为自己做错了什么。
    needsInputReason: '需要你提供一个模型密钥（它会被存进密钥库，不会写进配置文件）',
    blockingReason: '还没有配置模型：没有模型就无法运行任务',
  }),
  verify: Object.freeze({
    id: 'verify', kind: STEP_KINDS.VERIFY, title: '确认产品真的可用',
    blockingReason: '产品没有通过实测：现在说"完成"是不诚实的',
  }),
  done: Object.freeze({
    id: 'done', kind: STEP_KINDS.AUTOMATIC, title: '完成',
    blockingReason: null,
  }),
})

/**
 * `verify` 认可的就绪状态。
 *
 * `degraded` **不算通过**：它说的是"部分能力不可用"，
 * 而首次运行向导的承诺是"产品可用了"。把 degraded 放过去，
 * 用户会在一个缺了能力的产品上开始干活。
 */
export const VERIFY_ACCEPTED_STATES = Object.freeze(['ready'])

/** 状态文件名。放在 DataDir 下，与其它产品状态在一起。 */
export const WIZARD_STATE_FILENAME = 'first-run-wizard.json'

/**
 * 创建向导。
 *
 * 所有外部动作都以依赖注入的形式给出。这不是为了灵活性——
 * 是为了让「向导报完成时到底看没看过产品」这件事**可以被观测**。
 */
export function createWizard({
  // 自动步骤
  checkEnvironment = null,
  initialize = null,
  start = null,
  // 需要输入的那一步：拿到 {apiKey, model, baseUrl?} 之后写进密钥库/模型库
  submitModelConfig = null,
  // "模型是不是**已经**配好了"的核对。**只在返回恰好 `true` 时**才允许跳过输入。
  isModelConfigured = null,
  // **独立观测**：返回 {runtimeState, modelResolved, detail?}
  observe = null,
  // 状态持久化
  stateFile = null,
  fs = null,
  now = () => Date.now(),
  logger = null,
} = {}) {
  const diagnostics = []
  const results = []           // 每一步的结论，供最终报告使用
  let current = WIZARD_STEP_IDS[0]
  let finished = false
  const pendingInput = { value: null }

  function note(severity, code, message) {
    const d = Object.freeze({ severity, code, message, at: now() })
    diagnostics.push(d)
    if (typeof logger === 'function') logger(`[wizard] ${message}`)
    return d
  }

  // ── 状态持久化 ────────────────────────────────────────────────────────────
  //
  // 向导会被打断：用户要去拿密钥、要去装东西、要重启机器。
  // 存下来的目的是"从断点继续"，**不是**"把上一次的结论当成本次的结论"。
  // 所以恢复时只恢复**步骤位置**，绝不恢复"某一步已经过了"——
  // 上一次的 `verify` 结论对这一次的产品状态没有任何说服力。
  function saveState() {
    if (stateFile === null || fs === null) return Object.freeze({ saved: false, reason: 'no-state-file' })
    const body = {
      version: 'legion/first-run-wizard@1',
      step: current,
      finished,
      updatedAt: now(),
    }
    try {
      fs.writeFileSync(stateFile, JSON.stringify(body, null, 2), 'utf8')
      return Object.freeze({ saved: true })
    } catch (e) {
      note('warn', WIZARD_CODES.STATE_WRITE_FAILED,
        `向导进度没存下来（下次会从头开始）：${String(e?.message ?? e)}`)
      return Object.freeze({ saved: false, reason: WIZARD_CODES.STATE_WRITE_FAILED })
    }
  }

  function loadState() {
    if (stateFile === null || fs === null) return Object.freeze({ step: null, finished: false })
    let raw = null
    try {
      if (typeof fs.existsSync === 'function' && fs.existsSync(stateFile) !== true) {
        return Object.freeze({ step: null, finished: false })
      }
      raw = fs.readFileSync(stateFile, 'utf8')
    } catch (e) {
      note('warn', WIZARD_CODES.STATE_UNREADABLE,
        `向导进度读不出来，将从第一步开始：${String(e?.message ?? e)}`)
      return Object.freeze({ step: null, finished: false })
    }
    let parsed = null
    try { parsed = JSON.parse(raw) } catch {
      // 坏掉的进度文件**不猜**：从第一步开始是安全的（各步都是幂等的），
      // 猜一个步骤出来才危险。
      note('warn', WIZARD_CODES.STATE_UNREADABLE, '向导进度不是合法 JSON，将从第一步开始')
      return Object.freeze({ step: null, finished: false })
    }
    if (parsed?.version !== 'legion/first-run-wizard@1') {
      note('warn', WIZARD_CODES.STATE_UNREADABLE, '向导进度的版本不认识，将从第一步开始')
      return Object.freeze({ step: null, finished: false })
    }
    const step = WIZARD_STEP_IDS.includes(parsed.step) ? parsed.step : null
    if (step !== null) {
      note('info', WIZARD_CODES.ALREADY_DONE,
        `从上次中断的地方继续：${WIZARD_STEP_DEFS[step].title}`)
    }
    return Object.freeze({ step, finished: parsed.finished === true })
  }

  // ── 各步的执行 ────────────────────────────────────────────────────────────

  function runAutomatic(id, fn) {
    if (typeof fn !== 'function') {
      return { ok: false, message: `这一步没有配置动作（${id}）` }
    }
    return fn()
  }

  /** `verify`：**独立观测**，不是汇总前面的返回值。 */
  async function runVerify() {
    if (typeof observe !== 'function') {
      return {
        ok: false,
        code: WIZARD_CODES.NOT_OBSERVED,
        message: '没有配置观测方式：无法确认产品可用，因此不能说"完成"',
      }
    }
    let seen = null
    try {
      seen = await observe()
    } catch (e) {
      // 观测抛错 **不算过**。一个在观测失败时"放行"的向导，
      // 与一个不做观测的向导，在"用户第一次运行会不会成功"上是同一个东西。
      return {
        ok: false,
        code: WIZARD_CODES.NOT_OBSERVED,
        message: `观测产品时出错，无法确认可用：${String(e?.message ?? e)}`,
      }
    }
    if (seen === null || seen === undefined || typeof seen !== 'object') {
      return {
        ok: false, code: WIZARD_CODES.NOT_OBSERVED,
        message: `观测没有返回可判读的结果（收到 ${JSON.stringify(seen)}）：无法确认可用`,
      }
    }
    // ① 运行时状态必须是**正面认可**的那一个。
    if (!VERIFY_ACCEPTED_STATES.includes(seen.runtimeState)) {
      return {
        ok: false, code: WIZARD_CODES.NOT_OBSERVED,
        message: `实测到的运行时状态是「${seen.runtimeState ?? '未知'}」，不是可用的状态：`
          + '现在说"完成"是不诚实的。'
          + (seen.detail ? `（${seen.detail}）` : ''),
      }
    }
    // ② 模型必须**确实能解析**。只看"配置写进去了"是不够的。
    if (seen.modelResolved !== true) {
      return {
        ok: false, code: WIZARD_CODES.NOT_OBSERVED,
        message: '模型没有通过解析：写进去的配置还不足以跑一个任务。'
          + '（"我写了一条记录"与"这条记录能用"是两件事）',
      }
    }
    return { ok: true, message: '实测通过：运行时可用，模型可解析' }
  }

  /**
   * 尝试推进当前步骤一次。
   *
   * 返回 `{ step, ok, needsInput?, message }`。**不自动跨过需要输入的步骤。**
   */
  async function stepOnce() {
    if (finished === true) return Object.freeze({ step: current, ok: true, done: true })

    const def = WIZARD_STEP_DEFS[current]
    if (def === undefined) {
      note('error', WIZARD_CODES.UNKNOWN_STEP, `未知的向导步骤：${current}`)
      return Object.freeze({ step: current, ok: false, message: '未知步骤' })
    }

    if (def.kind === STEP_KINDS.INPUT) {
      const v = pendingInput.value
      if (v === null || v === undefined) {
        // ★ 先问一句"是不是**已经**配好了"——但只在能拿到**正面证据**时才跳过。
        //
        // 为什么需要它：向导天然会被重跑（用户中断过、重启过、点错了）。
        // 每次都要求重新输入密钥，会让人以为"上次配的没了"，于是反复重配。
        //
        // 为什么只在返回**恰好 `true`** 时才跳过：一个"大概配过了"的判断
        // 会让向导跳过唯一的配置入口，然后走到 `verify` 去发现模型不可用——
        // 而用户此时已经没有任何地方可以填密钥了。
        //
        // 抛错、返回 `undefined`、返回任何非 `true` 的东西 —— 一律**要输入**。
        //
        //   > 一个"看起来配过了"的判断，与一个"确实配好了"的判断，
        //   > 在"用户能不能把产品配起来"上是同一个东西——只是前者让人无路可走。
        if (typeof isModelConfigured === 'function') {
          let already = false
          try { already = (await isModelConfigured()) === true } catch { already = false }
          if (already === true) {
            return Object.freeze({
              step: current, ok: true,
              message: '模型此前已配置（已核对），跳过输入',
            })
          }
        }
        // ★ 停在原地，且**说清在等什么**。
        note('info', WIZARD_CODES.NEEDS_INPUT, def.needsInputReason)
        return Object.freeze({
          step: current, ok: false, needsInput: true,
          message: def.needsInputReason,
        })
      }
      if (typeof submitModelConfig !== 'function') {
        return Object.freeze({ step: current, ok: false, message: '这一步没有配置动作' })
      }
      let r = null
      try {
        r = await submitModelConfig(v)
      } catch (e) {
        const m = `模型配置没有写成：${String(e?.message ?? e)}`
        note('error', WIZARD_CODES.STEP_FAILED, m)
        return Object.freeze({ step: current, ok: false, message: m })
      }
      if (r === null || r?.ok !== true) {
        // `ok !== true` 一律算没成——包括返回了 undefined 的实现。
        // 「没返回错误」与「成功了」不是同一件事。
        const m = `模型配置没有成功：${r?.message ?? '提交动作没有给出正面结论'}`
        note('error', WIZARD_CODES.STEP_FAILED, m)
        return Object.freeze({ step: current, ok: false, message: m })
      }
      pendingInput.value = null
      return Object.freeze({ step: current, ok: true, message: r.message ?? '模型已配置' })
    }

    if (def.kind === STEP_KINDS.VERIFY) {
      const r = await runVerify()
      if (r.ok !== true) {
        note('error', r.code ?? WIZARD_CODES.NOT_OBSERVED, r.message)
        return Object.freeze({ step: current, ok: false, message: r.message, notObserved: true })
      }
      return Object.freeze({ step: current, ok: true, message: r.message })
    }

    // 自动步骤
    const fn = current === 'environment' ? checkEnvironment
      : current === 'initialize' ? initialize
        : current === 'start' ? start
          : null
    let r = null
    try {
      r = runAutomatic(current, fn)
    } catch (e) {
      const m = `${def.title}失败：${String(e?.message ?? e)}`
      note('error', WIZARD_CODES.STEP_FAILED, m)
      return Object.freeze({ step: current, ok: false, message: m })
    }
    if (r === null || r?.ok !== true) {
      const m = `${def.title}没有成功：${r?.message ?? def.blockingReason}`
      note('error', WIZARD_CODES.STEP_FAILED, m)
      return Object.freeze({ step: current, ok: false, message: m })
    }
    return Object.freeze({ step: current, ok: true, message: r.message ?? def.title })
  }

  function advance() {
    const i = WIZARD_STEP_IDS.indexOf(current)
    if (i < 0 || i === WIZARD_STEP_IDS.length - 1) { finished = true; return }
    current = WIZARD_STEP_IDS[i + 1]
    if (current === 'done') finished = true
    saveState()
  }

  const wizard = {
    /**
     * 尽力往前推进，直到：需要用户输入 / 某一步失败 / 完成。
     *
     * **不跳过失败**：走到失败就停下，把"卡在哪一步、为什么"报出来。
     * 一个继续往前走的向导，最后会带着一个假装的"完成"回来。
     */
    async run({ maxSteps = WIZARD_STEP_IDS.length + 2 } = {}) {
      if (finished === true) {
        return Object.freeze({ done: true, step: current, results: Object.freeze([...results]), diagnostics: Object.freeze([...diagnostics]) })
      }
      for (let i = 0; i < maxSteps; i += 1) {
        const r = await stepOnce()
        results.push(Object.freeze({ ...r, at: now() }))
        if (r.done === true) break
        if (r.needsInput === true) {
          // 需要输入：**交给调用方**，不自动往下走。
          return Object.freeze({
            done: false, blocked: true, blockedStep: r.step, needsInput: true,
            message: r.message,
            results: Object.freeze([...results]),
            diagnostics: Object.freeze([...diagnostics]),
          })
        }
        if (r.ok !== true) {
          return Object.freeze({
            done: false, blocked: true, blockedStep: r.step,
            message: r.message,
            results: Object.freeze([...results]),
            diagnostics: Object.freeze([...diagnostics]),
          })
        }
        advance()
        if (finished === true) {
          return Object.freeze({
            done: true, step: 'done', message: '实测通过：产品已就绪',
            results: Object.freeze([...results]),
            diagnostics: Object.freeze([...diagnostics]),
          })
        }
      }
      return Object.freeze({
        done: false, blocked: true, blockedStep: current,
        message: '推进次数超出上限（可能有步骤在原地打转）',
        results: Object.freeze([...results]),
        diagnostics: Object.freeze([...diagnostics]),
      })
    },

    /**
     * 给当前需要输入的步骤喂一个值。
     *
     * 只在当前步骤**确实**需要输入时接受——否则会在错误的步骤上静默吞掉
     * 用户的输入，而用户以为自己已经配好了。
     */
    submit(value) {
      const def = WIZARD_STEP_DEFS[current]
      if (def === undefined || def.kind !== STEP_KINDS.INPUT) {
        const m = `当前步骤「${def?.title ?? current}」不需要输入`
        note('error', WIZARD_CODES.BAD_INPUT, m)
        return Object.freeze({ accepted: false, message: m })
      }
      if (value === null || value === undefined) {
        return Object.freeze({ accepted: false, message: '输入为空' })
      }
      if (typeof value === 'object' && (value.apiKey === null || value.apiKey === undefined || value.apiKey === '')) {
        return Object.freeze({ accepted: false, message: '缺少模型密钥' })
      }
      pendingInput.value = value
      return Object.freeze({ accepted: true, step: current })
    },

    /** 当前状态。**必须说清"在等什么"**，否则用户不知道下一步干什么。 */
    status() {
      const def = WIZARD_STEP_DEFS[current]
      return Object.freeze({
        step: current,
        title: def?.title ?? current,
        kind: def?.kind ?? null,
        finished,
        completedSteps: Object.freeze(
          WIZARD_STEP_IDS.slice(0, Math.max(0, WIZARD_STEP_IDS.indexOf(current))),
        ),
        // 等待输入时给的是"需要什么"，其余情况给的是"为什么还卡着"。
        awaiting: def?.kind === STEP_KINDS.INPUT && pendingInput.value === null
          ? def.needsInputReason
          : null,
        blockingReason: finished ? null : (def?.blockingReason ?? null),
        results: Object.freeze([...results]),
      })
    },

    /** 从头再来一次。**不删除任何产品数据**——那是 `initialize` 的事。 */
    reset() {
      current = WIZARD_STEP_IDS[0]
      finished = false
      pendingInput.value = null
      results.length = 0
      diagnostics.length = 0
      saveState()
      return Object.freeze({ reset: true, step: current })
    },

    loadState,
    saveState,
    stateFile,
    diagnostics() { return Object.freeze([...diagnostics]) },
  }

  // 恢复断点：只恢复**位置**，不恢复任何"某一步已经过了"的结论。
  const restored = loadState()
  if (restored.step !== null && restored.finished !== true) current = restored.step

  return Object.freeze(wizard)
}
