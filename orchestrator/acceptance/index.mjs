// orchestrator/acceptance/index.mjs
// ============================================================================
// 机器验收（PRT-307）
//
// spec §6.10 的流水线里，「机器验收」是**执行成功之后、人工审批与角色交接之前**
// 的一道独立关卡：
//
//   持久化 RunEvent / ToolCall / Usage / Artifact
//     → 机器验收                     ← 本模块
//     → 人工审批或角色交接
//     → 完成交付
//
// 为什么它必须是一道独立的关卡，而不是"执行成功就等于做完"：
// 「执行成功了」与「做出来的东西满足验收判据」是两件事。前者由运行面知道
// （outcome: completed），后者只能拿**任务自己声明的判据**去核。
// 把两者合并的后果很具体：一个执行得很干净、但产物不对的任务会被标成已完成，
// 而验收判据从头到尾没有被任何人读过——这就是"伪装成功"。
//
// 本模块是**纯函数**：不碰数据库、不碰网络、不看时钟。理由与状态机相同——
// 「判据过没过」必须能在不启动任何进程的情况下被穷举测试，因为它是唯一
// 决定"这条任务算不算做完"的地方。
// ============================================================================

/** 验收结论。三值而不是布尔——见下方 `needs-human` 的说明。 */
export const ACCEPTANCE_DECISIONS = Object.freeze(['accepted', 'rejected', 'needs-human'])

/**
 * 机器可核验的判据种类。
 *
 * 这个清单是**封闭**的：不在其中的 `kind` 一律算「无法机器核验」，
 * 而不是「未知即通过」。新增一种判据必须显式加到这里并实现它的核验——
 * 那正是我们希望的摩擦。
 *
 * 注意判据有**两种来源形态**，本模块都接受：
 *   - 字符串：人类书写的验收标准（`tasks.acceptance` 由 stage-standards 生成的那种散文）
 *     → 机器核不了，永远计入「无法核验」→ 整条验收交人工；
 *   - 对象 `{ kind, ... }`：机器判据，必须落在下面这个清单里。
 * 详见 `checkOne` 里对字符串判据的说明。
 */
export const CRITERION_KINDS = Object.freeze([
  /** 运行结果必须是 completed（不是 failed / outcome_unknown / cancelled）。 */
  'run-completed',
  /** 结构化结果必须包含这些字段。 */
  'structured-result',
  /** 产物清单里必须有这个路径的产物。 */
  'artifact',
  /**
   * 声明「这条判据只能由人核验」。
   *
   * 它的存在不是多此一举：没有它时，一个"机器判不了"的判据会被写成
   * 某种机器判据的近似，于是它看起来被核验过了。有了它，
   * 「这里需要人」是一个可以写进任务契约的**事实**。
   */
  'manual',
])

/** 验收错误码。 */
export const ACCEPTANCE_ERRORS = Object.freeze({
  CRITERIA_NOT_ARRAY: 'CRITERIA_NOT_ARRAY',
  RUN_RESULT_INVALID: 'RUN_RESULT_INVALID',
})

/** 契约错误：调用方给的东西形状不对（4xx 语义）。 */
export class AcceptanceError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'AcceptanceError'
    this.code = code
    Object.assign(this, extra)
  }
}

/**
 * 只挑出这次验收真正用到的叶子字段。
 *
 * 不把 `runResult` 直接展开成 JSON 塞进证据里：它可能包含产物内容、日志片段，
 * 甚至被上游脱敏漏掉的东西。验收记录要长期保存，因此**只存判定所需的字段**。
 */
function leafOf(runResult) {
  const outcome = runResult?.outcome
  const detail = runResult?.detail
  return Object.freeze({
    outcome: typeof outcome === 'string' ? outcome : null,
    detail: typeof detail === 'string' ? detail : (detail === null || detail === undefined ? null : String(detail)),
    result: runResult?.result !== null && typeof runResult?.result === 'object' ? runResult.result : null,
    artifacts: Array.isArray(runResult?.artifacts) ? runResult.artifacts : Object.freeze([]),
  })
}

/** 核验单条判据，返回 `{ ok, unverifiable, reason }`。 */
function checkOne(criterion, run) {
  // ── 人类书写的验收标准（字符串）──
  //
  // 这不是"判据形状不对"，而是一类**真实存在**的判据：team-hub 的
  // `tasks.acceptance` 由 `stage-standards.mjs` 按岗位/阶段生成，内容是这样的散文：
  //
  //   '每条关键结论可验证：有真实依据（引用 / 命令输出 / 样例），不得虚构'
  //
  // 机器**无法**核验它，而它又必须被核验过才能算完成。把它当成"形状不对的判据"
  // 也能得到 needs-human（结论一样），但错误信息会指向"调用方传错了"，
  // 而真实情况是"这条判据天生需要人"。区别在于排查方向完全相反。
  //
  // 因此：字符串判据 = 人工判据。任务只带散文判据时结论必然是 needs-human——
  // 这是对的：`stage-standards.mjs` 生成的任务没有任何机器可核的闸门，
  // 谁也没说过"什么叫做完了"。
  // 反过来，散文判据与机器判据**并存**时（真实任务的常见形态）：
  // 机器判据被逐条核过，散文判据把结论抬到人工审批。两者都不被跳过。
  if (typeof criterion === 'string') {
    const text = criterion.trim()
    if (text === '') {
      return { ok: false, unverifiable: true, reason: '判据是一条空字符串：空判据不是"没有要求"，而是这一行没写完' }
    }
    return { ok: false, unverifiable: true, reason: `由人核验的验收标准：${text}` }
  }
  if (criterion === null || typeof criterion !== 'object' || Array.isArray(criterion)) {
    return { ok: false, unverifiable: true, reason: `判据既不是人类验收标准（字符串）也不是机器判据（对象）：${JSON.stringify(criterion)}` }
  }
  const kind = criterion.kind
  if (typeof kind !== 'string' || kind === '') {
    // 没有 kind 的判据不能被当作"没有要求"跳过——那是最容易被忽略的一种：
    // 一个写错的判据会让整条验收看起来是"全过"
    return { ok: false, unverifiable: true, reason: `判据缺少 kind：${JSON.stringify(criterion)}` }
  }
  if (!CRITERION_KINDS.includes(kind)) {
    return {
      ok: false,
      unverifiable: true,
      reason: `判据种类「${kind}」不是机器可核验的（已知：${CRITERION_KINDS.join(' / ')}）。` +
        '未知判据不得当成通过——那会让一条写错的判据静默放行',
    }
  }

  switch (kind) {
    case 'run-completed': {
      if (run.outcome === 'completed') return { ok: true, unverifiable: false, reason: null }
      return { ok: false, unverifiable: false, reason: `运行结果是「${run.outcome ?? '未给出'}」，不是 completed` }
    }
    case 'structured-result': {
      const required = criterion.required
      if (!Array.isArray(required) || required.length === 0) {
        return { ok: false, unverifiable: true, reason: 'structured-result 判据缺少 required 字段名数组' }
      }
      if (run.result === null) {
        return { ok: false, unverifiable: false, reason: '运行没有产出结构化结果，但判据要求核验其字段' }
      }
      const missing = required.filter((f) => typeof f === 'string' && !(f in run.result))
      // 判据里出现非字符串的字段名同样是契约问题，不能跳过
      const malformed = required.filter((f) => typeof f !== 'string')
      if (malformed.length > 0) {
        return { ok: false, unverifiable: true, reason: `required 里出现非字符串字段名：${JSON.stringify(malformed)}` }
      }
      if (missing.length > 0) {
        return { ok: false, unverifiable: false, reason: `结构化结果缺少字段：${missing.join('、')}` }
      }
      return { ok: true, unverifiable: false, reason: null }
    }
    case 'artifact': {
      const path = criterion.path
      if (typeof path !== 'string' || path === '') {
        return { ok: false, unverifiable: true, reason: 'artifact 判据缺少 path（字符串）' }
      }
      const hit = run.artifacts.some((a) => a !== null && typeof a === 'object' && a.path === path)
      if (hit) return { ok: true, unverifiable: false, reason: null }
      return {
        ok: false,
        unverifiable: false,
        reason: `产物清单里没有 ${path}（清单里是：${run.artifacts.map((a) => a?.path ?? '?').join('、') || '空'}）`,
      }
    }
    case 'manual':
      // 明确声明"只能由人核验"：这**不是**失败，而是"机器这里判不了"，
      // 于是整条验收交给人工审批而不是打回重试。
      return { ok: false, unverifiable: true, reason: criterion.note ?? '判据声明只能由人核验' }
    default:
      // CRITERION_KINDS 里有的种类必须在这里被处理；走到这里说明两处不同步
      return { ok: false, unverifiable: true, reason: `判据种类「${kind}」已登记但没有实现核验` }
  }
}

/**
 * 对一次运行结果做机器验收。
 *
 * 返回：
 * ```
 * {
 *   decision: 'accepted' | 'rejected' | 'needs-human',
 *   reason: string,
 *   gate: { total, passed, failed, unverifiable },
 *   results: [{ criterion, ok, unverifiable, reason }],
 *   run: { outcome, detail, artifactPaths },   // 判定所需的叶子字段，可长期保存
 * }
 * ```
 *
 * **三分支而不是布尔**，因为"没通过"有两种完全不同的成因：
 *   - `rejected`：机器**确认**它不满足判据（例如产物不存在）→ 该打回重试；
 *   - `needs-human`：机器**判不了**（判据声明要人核验、判据种类不认识、
 *     或者任务压根没声明判据）→ 该进人工审批。
 * 合成一个 `false` 时，上面两类只能走同一条路，而两条路选哪条都是错的：
 * 把"判不了"当失败会让一个本来正确的交付被反复重做；
 * 把"判不了"当通过就是伪装成功。
 */
export function evaluateAcceptance({ runResult, criteria } = {}) {
  if (runResult === null || typeof runResult !== 'object' || Array.isArray(runResult)) {
    throw new AcceptanceError(ACCEPTANCE_ERRORS.RUN_RESULT_INVALID,
      `runResult 必须是对象（收到 ${runResult === null ? 'null' : typeof runResult}）：` +
      '凭空验收一个不存在的运行结果，等价于把"没有交付"标成"验收通过"')
  }
  if (!Array.isArray(criteria)) {
    throw new AcceptanceError(ACCEPTANCE_ERRORS.CRITERIA_NOT_ARRAY,
      `criteria 必须是数组（收到 ${criteria === null ? 'null' : typeof criteria}）：` +
      '把"读不出判据"当成"没有判据"会让整条验收静默通过')
  }

  const run = leafOf(runResult)
  const results = criteria.map((c) => {
    const r = checkOne(c, run)
    return Object.freeze({ criterion: c, ok: r.ok, unverifiable: r.unverifiable, reason: r.reason })
  })

  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok && !r.unverifiable)
  const unverifiable = results.filter((r) => r.unverifiable)
  const gate = Object.freeze({ total: results.length, passed, failed: failed.length, unverifiable: unverifiable.length })

  const base = {
    gate,
    results: Object.freeze(results),
    run: Object.freeze({
      outcome: run.outcome,
      detail: run.detail,
      artifactPaths: Object.freeze(run.artifacts.map((a) => (a !== null && typeof a === 'object' ? a.path ?? null : null))),
    }),
  }

  // ① 运行本身没成功：不必再看判据。机器确认的失败 → 打回重试。
  if (run.outcome !== 'completed') {
    return Object.freeze({
      ...base,
      decision: 'rejected',
      reason: `运行结果是「${run.outcome ?? '未给出'}」而不是 completed：` +
        (run.detail === null ? '未给出原因' : run.detail),
    })
  }

  // ② 任务没有声明任何验收判据。
  //    「没人说过什么叫做完」**不等于**「做完了」。默认通过会把这批任务
  //    整体标成已完成，而验收判据从头到尾没有被读过。
  if (criteria.length === 0) {
    return Object.freeze({
      ...base,
      decision: 'needs-human',
      reason: '任务没有声明任何验收判据：无人能说「做到什么程度算完成」，因此不能由机器判定通过',
    })
  }

  // ③ 有机器确认不满足的判据 → 打回。
  //    先于"判不了"判定：确认不满足时，"还有几条判不了"不影响结论。
  if (failed.length > 0) {
    return Object.freeze({
      ...base,
      decision: 'rejected',
      reason: `有 ${failed.length}/${criteria.length} 条判据机器确认不满足：` +
        failed.map((f) => f.reason).join('；'),
    })
  }

  // ④ 有过不了机器这一关的判据 → 人工审批。
  if (unverifiable.length > 0) {
    return Object.freeze({
      ...base,
      decision: 'needs-human',
      reason: `有 ${unverifiable.length}/${criteria.length} 条判据无法由机器核验：` +
        unverifiable.map((u) => u.reason).join('；'),
    })
  }

  return Object.freeze({
    ...base,
    decision: 'accepted',
    reason: `全部 ${criteria.length} 条判据均已由机器核验通过`,
  })
}

/**
 * 验收结论 → 状态机的目标状态。
 *
 * `hasNextPost` 由**调用方明确给出**（它知道这条任务在流水线里还有没有下一岗位），
 * 缺它时本函数**拒绝**给出目标，而不是默认"链尾直接完成"：
 * 默认完成会静默掐断任务链，直到整个目标停住才被发现；
 * 默认交接会创建一个没有承接方的任务。两种都不报错。
 *
 * 返回 `{ ok: true, to, context }` 或 `{ ok: false, code, message }`。
 */
export function acceptanceTarget(decision, { hasNextPost } = {}) {
  switch (decision) {
    case 'accepted': {
      if (typeof hasNextPost !== 'boolean') {
        return Object.freeze({
          ok: false,
          code: 'MISSING_GUARD_INPUT',
          message: '验收通过后要往哪走取决于「还有没有下一岗位」（hasNextPost），' +
            '这一条不能默认：默认完成会静默掐断任务链，默认交接会创建没有承接方的任务',
        })
      }
      return hasNextPost
        ? Object.freeze({ ok: true, to: 'HandingOff', context: Object.freeze({ hasNextPost: true }) })
        : Object.freeze({ ok: true, to: 'Completed', context: Object.freeze({ hasNextPost: false }) })
    }
    case 'rejected':
      // 打回 = 可重试失败，之后的去向（重试 / DeadLetter）由重试额度的唯一决策点决定
      return Object.freeze({ ok: true, to: 'RetryableFailure', context: Object.freeze({}) })
    case 'needs-human':
      // 交付级审批：回到验收（returnTo: Validating），人工批准后不必重跑执行
      return Object.freeze({
        ok: true,
        to: 'AwaitingApproval',
        context: Object.freeze({ returnTo: 'Validating' }),
      })
    default:
      return Object.freeze({
        ok: false,
        code: 'UNKNOWN_DECISION',
        message: `未知的验收结论「${decision}」：不得默认任何去向`,
      })
  }
}
