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
  'environment', 'initialize', 'start', 'configure-model', 'verify',
  // PRT-707 收尾：可选步骤排在 `verify` **之后**。
  //
  //   理由：`verify` 的结论是"产品可用了"，而这一步与"产品能不能用"
  //   毫无关系（心跳默认关闭，与模型、目录、端口都无关）。
  //   排在它前面的话，用户会以为"要回答完这个才算配好"。
  'heartbeat-consent',
  'done',
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
  /**
   * 可选步骤没拿到回答，按默认继续（PRT-707 收尾）。
   *
   * **这是 `info` 级，不是错误**：对可选功能来说，"没回答"是完全正常的。
   * 把正常的事报成错误，用户会以为自己做错了什么——
   * 这正是 `configure-model` 的 `needsInputReason` 注释里已经写过的那条道理，
   * 可选步骤只是它更容易被忘记的位置。
   */
  OPT_IN_UNANSWERED: 'WIZARD_OPT_IN_UNANSWERED',
})

/** 步骤类型。`input` 类必须停下来等用户。 */
export const STEP_KINDS = Object.freeze({
  AUTOMATIC: 'automatic',
  INPUT: 'input',
  VERIFY: 'verify',
  /**
   * 可选项（PRT-707 收尾）。
   *
   * 与 `INPUT` 的**唯一**区别是：没拿到回答时它**不阻塞**，而是按默认值继续。
   *
   * 为什么必须区分这两种：一个"可选"的能力如果用 `INPUT` 表达，
   * 用户没回答时向导就会停在那里——于是**默认关闭的东西变成了必须先回答
   * 才能继续的东西**。而"不回答"恰恰是绝大多数用户对可选功能的回答。
   *
   *   > 一个把"可选项"实现成"必答题"的向导，
   *   > 与一个把可选项默认打开的向导，在用户被推着走这件事上是同一个东西——
   *   > 只不过前者的用户会以为自己在选择。
   *
   * 另一半同样重要：不阻塞**不等于**"当作用户选了不要"。
   * 没回答与答了"不要"是两件不同的事，见 `heartbeat-consent` 那一步的说明。
   */
  OPT_IN: 'opt-in',
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
    // ★ 逐步的输入判据（PRT-707 收尾）。
    //
    // 原来这条判据**写死在 `submit()` 里**（`value.apiKey` 那一句）。
    // 于是"当前步骤要什么"这件事有两个住处：步骤定义（标题、等待说明）
    // 与 `submit()` 里的一个分叉。第二个输入步骤出现时，
    // `submit()` 会拿**第一个步骤**的判据去校验它。
    //
    //   > 一条写死在"提交"函数里的输入判据，
    //   > 与一条写在步骤定义里的输入判据，在一个输入步骤的时候是同一个东西——
    //   > 只不过前者会在第二个步骤接进来的那天，拿错的判据去拒绝正确的输入。
    validate: (v) => (typeof v?.apiKey === 'string' && v.apiKey !== '' ? null : '缺少模型密钥'),
  }),
  verify: Object.freeze({
    id: 'verify', kind: STEP_KINDS.VERIFY, title: '确认产品真的可用',
    blockingReason: '产品没有通过实测：现在说"完成"是不诚实的',
  }),
  // ── PRT-707 收尾：可选步骤 ────────────────────────────────────────────
  'heartbeat-consent': Object.freeze({
    id: 'heartbeat-consent', kind: STEP_KINDS.OPT_IN, title: '健康心跳（可选）',
    needsInputReason:
      '如果愿意发送脱敏的运行状态（队列深度、错误率、可用率），请给出你的署名；'
      + '**不回答也不影响使用**——心跳默认关闭',
    // 不问时说清"默认是什么"，否则用户会以为自己在等一个答案。
    unansweredNote:
      '这一项**没有被问到**：心跳保持**关闭**，不会有任何数据发出去，'
      + '也不会留下任何同意记录（"没问过"与"用户拒绝了"是两件事）',
    // 可选步骤**永远不阻塞**，所以这里说的不是"为什么卡着"，而是它的性质。
    blockingReason: '健康心跳是可选项，不影响产品是否可用',
    // ★ 判据只在**要开通**时要求署名。
    //
    //   拒绝**不需要**署名。要求了的话，"不接受"就比"接受"多一道门槛——
    //   而那道门槛推着用户往同意那边走。
    //
    //     > 一个"拒绝也要先填表"的可选项，
    //     > 与一个默认打开的可选项，在"用户最后同意了没有"上是同一个结果——
    //     > 只不过前者的同意看起来像是他自己选的。
    validate: (v) => (v?.enabled === true
      ? (typeof v?.who === 'string' && v.who.trim() !== '' ? null : '开通心跳需要署名')
      : null),
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
  // ── 可选步骤的动作（PRT-707 收尾）────────────────────────────────────────
  //
  // `{ [stepId]: async (value) => ({ok, message}) }`。
  //
  // 与 `submitModelConfig` 分开而不是塞进它：那一个的参数形状是"模型密钥"，
  // 而这一个可能是"同意记录"。把它们合成一个回调，回调里就要按当前步骤
  // 分叉——而那正是 `submit()` 曾经犯过的错（见那里的说明）。
  stepActions = {},
  /**
   * 要不要**问**那个可选项（PRT-707 收尾）。默认 `false` = 不问。
   *
   * ★ 为什么需要这个开关，而不是"可选项永远不阻塞"：
   *   一个永不阻塞的步骤**永远收不到回答**——`run()` 会一路推进到完成，
   *   没有地方能 `submit`。
   *
   *     > 一个"不阻塞的可选步骤"，与一个"根本不存在这一步"，
   *     > 在"用户有没有被问过"上是同一个答案——
   *     > 只不过前者看起来是把选择权交出去了。
   *
   *   默认 `false` 是因为：一个**默认去问**的向导会把每次运行都变成
   *   一次需要人坐在旁边的操作，而大多数运行是重跑、脚本化或无人值守的。
   *   要问的界面（图形向导、带 `--wizard-consent` 的 CLI）显式打开它。
   */
  askOptIn = false,
  /**
   * 对可选项的**预先回答**（PRT-707 收尾）。
   *
   * `{ [stepId]: value }`。有这一条时，那一步按"问过了、答过了"处理——
   * 与当场 `submit` 走**完全同一条**路（同样的判据、同样的动作）。
   *
   * 存在的理由：CLI 的 `--wizard-consent=<who>` 与图形界面都要能回答它，
   * 而它们一个在跑之前就知道答案、一个要在界面上停下来。
   * 两种都归到"一次回答"，只是**谁来答**不同。
   */
  presetOptIn = {},
  // "模型是不是**已经**配好了"的核对。**只在返回恰好 `true` 时**才允许跳过输入。
  isModelConfigured = null,
  // **独立观测**：返回 {runtimeState, modelResolved, detail?}
  observe = null,
  // ── 前提（PRT-707 接线批新增）────────────────────────────────────────────
  //
  // 在**第一步之前**必须成立的事。`null` = 没有前提。
  //
  // 可以是静态数组 `[{key, message}]`，也可以是一个函数
  // （同步或异步）返回 `{ok, unmet:[{key,message}]}`。
  //
  // ## 为什么是"第一步之前"，而不是"某一步的一部分"
  //
  // 前提不成立时的症状，通常会在**第三步**才以另一个面孔出现：
  // 没有 hub 凭证 → `configure-model` 写不进模型档案 → 到 `verify` 报
  // "模型没有通过解析"。用户顺着这句话去查自己的 API key，
  // 而 key 本来是对的。
  //
  //   > 一个"先跑第一步、再在第三步发现前提不成立"的向导，
  //   > 与一个"在第一步之前就说清前提不成立"的向导，
  //   > 在最终都报"没配好"这件事上是同一个东西——
  //   > 只不过前者会让人去改一个本来没错的东西。
  //
  // ## 三条判定纪律
  //
  // ① **每次 `run()` 都重查**，不缓存结论。用户就是去把 hub 打开、把 token 配上
  //    然后再点一次的——缓存住第一次的结论等于让他重启向导。
  // ② 前提函数**抛错一律算不成立**（同 `isModelConfigured` 的纪律）：
  //    一个"判断前提时出错就放行"的实现，等于没有前提。
  // ③ 前提不成立时**一步都不跑**，所以 `initialize` 不会去建目录、
  //    `start` 不会去拉进程——"还没开始"与"开始到一半失败"要能被区分。
  preconditions = null,
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
  /**
   * 可选步骤的**回答记录**（PRT-707 收尾）。
   *
   * 只记"回答过没有、以及选了什么"，不记"默认当成了什么"——
   * 因为"没回答"本身就是一个必须能被读到的状态，见 `stepOnce` 里那一段。
   */
  const optInResults = {}

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

  /** 上一次算出来的前提结论；`status()` 同步地报它。 */
  let lastPrecondition = null

  /**
   * 算前提。**任何异常都算不成立**——理由同 `isModelConfigured`：
   * 一个"判断前提时出错就放行"的实现，等于没有前提。
   *
   * 没配 `preconditions` 时返回成立（`unmet: []`），于是这一批新增的机制
   * 对既有调用方是**零影响**的。
   */
  async function checkPreconditions() {
    if (preconditions === null || preconditions === undefined) {
      return Object.freeze({ ok: true, unmet: Object.freeze([]) })
    }
    let raw = null
    try {
      raw = typeof preconditions === 'function' ? await preconditions() : preconditions
    } catch (e) {
      return Object.freeze({
        ok: false,
        unmet: Object.freeze([Object.freeze({
          key: 'precondition-error',
          message: `判断前提时出错，按不成立处理：${String(e?.message ?? e)}`,
        })]),
      })
    }
    // 静态数组形态：`[{key, message}]`，空数组 = 成立。
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.unmet) ? raw.unmet : null)
    if (list === null) {
      return Object.freeze({
        ok: false,
        unmet: Object.freeze([Object.freeze({
          key: 'precondition-shape',
          message: '前提判断没有返回可判读的结果（要 `{ok, unmet}` 或 `[{key,message}]`），按不成立处理',
        })]),
      })
    }
    const unmet = list
      .filter((u) => u !== null && u !== undefined)
      .map((u) => Object.freeze({
        key: typeof u?.key === 'string' && u.key !== '' ? u.key : 'unnamed',
        message: typeof u?.message === 'string' && u.message !== '' ? u.message : '前提不成立（没有说明）',
      }))
    // 显式 `ok:true` 与"空 unmet 列表"都算成立；`ok:false` 但 unmet 为空时
    // 也要报出来——"说不成立却不说为什么"不能静默变成成立。
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && raw.ok === false && unmet.length === 0) {
      unmet.push(Object.freeze({ key: 'unnamed', message: '前提判断说不成立，但没有说明原因' }))
    }
    return Object.freeze({ ok: unmet.length === 0, unmet: Object.freeze(unmet) })
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

    // ── 可选步骤（PRT-707 收尾）─────────────────────────────────────────
    //
    // ★ **默认不问，也不阻塞。**
    //
    //   这不是偷懒，是一条被量出来的结论：`run()` 会一路推进到完成，
    //   所以一个**永不阻塞**的步骤**永远收不到回答**——
    //   没有地方能 `submit`，因为向导从来不停在它上面。
    //
    //     > 一个"不阻塞的可选步骤"，与一个"根本不存在这一步"，
    //     > 在"用户有没有被问过"上是同一个答案——
    //     > 只不过前者看起来是把选择权交出去了。
    //
    //   所以这一步有两种模式，由调用方选：
    //     · `askOptIn !== true`（默认）⇒ **不问**，直接过去，记 `{asked:false}`
    //     · `askOptIn === true`      ⇒ 像 INPUT 一样**停下等回答**，
    //                                  答完记 `{asked:true, answered:true, enabled}`
    //
    //   而无论哪一种，**"没问过"都必须是一个能读到的状态**——
    //   它与"问过了、用户选了不要"是两件不同的事，要修的地方也不同。
    //
    //     > 一个把"没问"记成"用户拒绝"的界面，
    //     > 会让一次界面缺陷看起来像一次用户选择。
    //
    //   回答分两种，且**拒绝也是一种回答**（`enabled: false`）：
    //   拒绝不写任何记录；只有 `enabled: true` 才写同意。
    if (def.kind === STEP_KINDS.OPT_IN) {
      // 预先回答（`presetOptIn[stepId]`）与当场回答走**同一条**路：
      // 它同样是一次"问过了、答过了"。区别只在"谁替用户答的"，
      // 而那个区别由**调用方**（CLI 的 `--wizard-consent`）在它自己的说明里交代。
      const preset = Object.prototype.hasOwnProperty.call(presetOptIn, current)
        ? presetOptIn[current]
        : null
      const v = pendingInput.value ?? preset
      if (v === null || v === undefined) {
        if (askOptIn !== true) {
          optInResults[current] = Object.freeze({ asked: false })
          note('info', WIZARD_CODES.OPT_IN_UNANSWERED, def.unansweredNote)
          return Object.freeze({
            step: current, ok: true, skipped: true, asked: false,
            message: def.unansweredNote,
          })
        }
        // 被要求问了，那就**停下等回答**——此时它等价于 INPUT。
        note('info', WIZARD_CODES.NEEDS_INPUT, def.needsInputReason)
        return Object.freeze({
          step: current, ok: false, needsInput: true,
          message: def.needsInputReason,
        })
      }
      // 预先回答也要过**同一道**判据：一条没署名的"预先同意"与
      // 一条没署名的当场同意，在"事后能不能查证"上是同一个东西。
      const problem = typeof def.validate === 'function' ? def.validate(v) : null
      if (problem !== null) {
        const m = `${def.title}：${problem}`
        note('error', WIZARD_CODES.BAD_INPUT, m)
        return Object.freeze({ step: current, ok: false, message: m })
      }
      const action = stepActions?.[current]
      if (typeof action !== 'function') {
        // 拿到回答却没有动作：说成功就等于**谎称问过了**。
        const m = `${def.title}：这一步没有配置动作`
        note('error', WIZARD_CODES.STEP_FAILED, m)
        return Object.freeze({ step: current, ok: false, message: m })
      }
      let r = null
      try {
        r = await action(v)
      } catch (e) {
        const m = `${def.title}没有写成：${String(e?.message ?? e)}`
        note('error', WIZARD_CODES.STEP_FAILED, m)
        return Object.freeze({ step: current, ok: false, message: m })
      }
      if (r === null || r?.ok !== true) {
        const m = `${def.title}没有成功：${r?.message ?? '提交动作没有给出正面结论'}`
        note('error', WIZARD_CODES.STEP_FAILED, m)
        return Object.freeze({ step: current, ok: false, message: m })
      }
      pendingInput.value = null
      optInResults[current] = Object.freeze({
        asked: true, answered: true, enabled: v?.enabled === true,
      })
      return Object.freeze({ step: current, ok: true, asked: true, answered: true, message: r.message ?? def.title })
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
      // ★ **必须 await。** 第一版这里没有 await，于是任何一个 async 的自动动作
      // 都会让 `r` 是一个 Promise：`r?.ok !== true` 对它成立，每一步都被报成
      // "没有成功"，而真正的失败原因（`r.message`）永远读不到——报出来的是
      // `blockingReason` 那句写死的文案。
      //
      //   > 一个"支持异步动作"的向导，与一个"只在动作恰好同步时才对"的向导，
      //   > 在动作都很小的时候是同一个东西——只不过后者会在接入真实模块
      //   > （`initializeProductDir`、`launcher.start()` 几乎都是异步的）那一天，
      //   > 把每一步都报成失败，还说不出为什么。
      r = await runAutomatic(current, fn)
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
      // ★ 前提在**第一步之前**判，且每次都重判（理由见 createWizard 的 `preconditions`）。
      const pre = await checkPreconditions()
      lastPrecondition = pre
      if (pre.ok !== true) {
        const m = `前提不成立，向导一步都没有跑：${pre.unmet.map((u) => u.message).join('；')}`
        note('error', WIZARD_CODES.PRECONDITION_UNMET, m)
        const r = Object.freeze({
          step: current, ok: false, precondition: true, unmet: pre.unmet, message: m,
        })
        results.push(Object.freeze({ ...r, at: now() }))
        return Object.freeze({
          done: false, blocked: true, blockedStep: current, precondition: true,
          unmet: pre.unmet,
          message: m,
          results: Object.freeze([...results]),
          diagnostics: Object.freeze([...diagnostics]),
        })
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
     *
     * ★ 判据来自**步骤定义**的 `validate`（PRT-707 收尾），不再写死在这里。
     *
     *   原来这里硬编码着 `value.apiKey` 那一句。一个步骤的时候看不出问题；
     *   接进第二个输入步骤（`heartbeat-consent`）的那一天，它会拿
     *   "缺少模型密钥"去拒绝一个完全正确的同意署名——
     *   而且被拒绝的人正在做一件**可选**的事，所以他多半会直接放弃。
     *
     *     > 一条写死在"提交"函数里的输入判据，
     *     > 会在第二个输入步骤接进来的那天，拿错的判据去拒绝正确的输入。
     */
    submit(value) {
      const def = WIZARD_STEP_DEFS[current]
      if (def === undefined || (def.kind !== STEP_KINDS.INPUT && def.kind !== STEP_KINDS.OPT_IN)) {
        const m = `当前步骤「${def?.title ?? current}」不需要输入`
        note('error', WIZARD_CODES.BAD_INPUT, m)
        return Object.freeze({ accepted: false, message: m })
      }
      if (value === null || value === undefined) {
        return Object.freeze({ accepted: false, message: '输入为空' })
      }
      const problem = typeof def.validate === 'function' ? def.validate(value) : null
      if (problem !== null) {
        // 判据说不行就**不收下**。收下的话，下一步会以一个看起来配好了、
        // 其实缺东西的状态往下走，而错误会在更远的地方以另一个面孔出现。
        note('error', WIZARD_CODES.BAD_INPUT, problem)
        return Object.freeze({ accepted: false, message: problem, code: WIZARD_CODES.BAD_INPUT })
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
        //
        // ★ 可选步骤**不进这一支**：它不会挡住任何东西，
        //   所以它的 `awaiting` 永远是 `null`。一个把可选步骤也报成
        //   "在等待"的界面，会让用户以为不回答就走不下去。
        awaiting: def?.kind === STEP_KINDS.INPUT && pendingInput.value === null
          ? def.needsInputReason
          : null,
        blockingReason: finished ? null : (def?.blockingReason ?? null),
        // 前提不成立是**第一步之前**的状态，与"卡在第三步"不是一回事，
        // 所以单独报，不混进 `blockingReason`。
        preconditions: lastPrecondition,
        // ★ 可选步骤的回答情况（PRT-707 收尾）。
        //   界面要能说"问过了、用户选了不要"与"根本没问过"的区别，
        //   否则一次界面缺陷会看起来像一次用户选择。
        optIn: Object.freeze({ ...optInResults }),
        results: Object.freeze([...results]),
      })
    },

    /** 主动算一次前提（界面在进入向导前想问"现在能不能开始"时用）。 */
    checkPreconditions,

    /**
     * 从头再来一次。**不删除任何产品数据**——那是 `initialize` 的事。
     *
     * 前提结论一并清掉：它是"上一次看到的"，重来之后不该继续显示旧的。
     */
    reset() {
      current = WIZARD_STEP_IDS[0]
      finished = false
      pendingInput.value = null
      results.length = 0
      diagnostics.length = 0
      lastPrecondition = null
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
