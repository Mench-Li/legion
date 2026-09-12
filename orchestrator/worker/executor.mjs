// orchestrator/worker/executor.mjs
// ============================================================================
// 生产执行引擎的**接线**（PRT-253：单员工、无自动交接的黄金任务）
//
// ## 这个文件要解决的问题
//
// PRT-401~413 交付了一整套上下文装配（来源归一、权限、预算、脱敏、冻结、
// 哈希、回放）并且**全部有套件、全部全绿**。而 `orchestrator/worker/run.mjs`
// 的 `executor` 默认是 `null`——也就是说**没有任何真实部署走过那条路**。
//
//   > 一个功能没有入口，与一个功能不存在，在用户看来完全一样。
//
// 本文件给出那个入口的**形状**：一个真实的 `executor`，它的
// `buildContext` 会把上下文**冻结在 hub 的库里**，它的 `execute` 会把
// **那份冻结下来的正文原样当作模型的输入**。
//
// ## 为什么 "冻结的正文 == 模型的输入" 是这里唯一真正重要的不变量
//
// 快照存在的全部理由是回答"模型当时看到了什么"。如果 `execute` 自己
// 重新拼一遍提示词，那个问题的答案就**又消失了**——而库里那份快照
// 看起来完全正常，tests 也全绿（它们验的是装配器，不是这一次执行）。
//
//   > 一份被冻结、被哈希、被审计、然后**没有被用上**的上下文，
//   > 与一份从未被冻结的上下文，在"模型看到了什么"这个问题上是同一个答案。
//
// 所以 `execute` **只从快照取正文**，一个字节都不自己拼。
//
// ## 三道拒绝（都不是降级）
//
// ① **启动自检未过 → 不构造执行引擎。** PRT-213/215 要求"不满足要求时禁止执行"。
//    注意这里返回的是**拒绝**而不是"一个能力弱一点的引擎"：一个能跑但强制面
//    没生效的引擎，会去执行真实的写操作，而它的表现与一个正常的引擎完全一样。
// ② **没有宿主端口 → 拒绝。** 端口（`startRun`/`probeRuntime`）是把引擎接上来的
//    唯一通道。缺了它，"能执行"只能靠编。
// ③ **没有冻结快照 → 这次执行失败。** 不是"用空上下文继续"：
//    空上下文会让模型在一个我们无法回答的世界里动手。
//    篡改过的快照（`verify.ok === false`）同样拒绝——把一份验不过的记录
//    喂给模型，等于让"快照可验证"这个保证在最后一米失效。
//
// ## 与 `no-executor` 的关系
//
// 这些拒绝**不改变** worker 既有的行为：拿不到 executor 时 worker 仍报
// `no-executor` 且**不认领**。区别只在**理由**——以前只有一句"没配"，
// 现在能说出是自检没过、缺端口，还是别的什么，而且每一条都带自己的码。
// ============================================================================

import { createHubContextStage } from './context-stage.mjs'
import { createDshRuntimeAdapter } from '../../runtime/adapters/dsh/index.mjs'
import { TERMINAL_TO_OUTCOME, isTerminalEventType, RUN_REQUEST_REQUIRED } from '../../runtime/contracts/run.mjs'
import { createBudgetGate } from './budget-gate.mjs'

/** 本模块的具名拒绝码。跨进程读取（worker 上报 → hub 记录 → 人排查），属契约。 */
export const EXECUTOR_CODES = Object.freeze({
  /** 启动自检未过：补丁层 / 运行时探测 / 沙箱管制三者有其一没生效。 */
  SELF_CHECK_INCOMPATIBLE: 'EXECUTOR_SELF_CHECK_INCOMPATIBLE',
  /** 没有 DSH 宿主端口。 */
  HOST_PORT_REQUIRED: 'EXECUTOR_HOST_PORT_REQUIRED',
  /** 该次 Attempt 没有冻结上下文快照。 */
  CONTEXT_NOT_FROZEN: 'EXECUTOR_CONTEXT_NOT_FROZEN',
  /** 有快照但读回时验不过（被改过 / 载荷坏了）。 */
  CONTEXT_UNVERIFIED: 'EXECUTOR_CONTEXT_UNVERIFIED',
  /** 接线错误（参数缺失或形状不对）。 */
  BAD_WIRING: 'EXECUTOR_BAD_WIRING',
  /** 引擎返回的终态不是成功。 */
  RUN_NOT_COMPLETED: 'EXECUTOR_RUN_NOT_COMPLETED',
})

export class ExecutorError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'ExecutorError'
    this.code = code
    Object.assign(this, extra)
  }
}

/**
 * 构造生产执行引擎。
 *
 * 返回**判别式联合**，与 `runWorkerProcess` 同一约定：
 *   · `{ ok: false, code, message, reasons }` —— 拒绝，且说得清为什么
 *   · `{ ok: true, executor: { buildContext, execute } }`
 *
 * 「拒绝」与「成功但能力弱」在类型上就是两件事，调用方没法把后者当前者用。
 *
 * @param {object} deps
 * @param {(path: string, body: object) => Promise<{status:number, body:object}>} deps.post
 *   POST 适配器（由调用方注入：worker 侧的 hub 客户端形状不一）。
 * @param {(path: string) => Promise<{status:number, body:object}>} deps.get
 *   GET 适配器。`execute` 用它读回冻结的正文。
 * @param {object} [deps.host] DSH 宿主端口（`startRun` / `probeRuntime`）。
 * @param {() => Promise<object>} [deps.selfCheck]
 *   返回 `startupSelfCheck` 的结果。**缺省视为未过**——见下面注释。
 * @param {(meta: object) => any} [deps.canRead] 装配阶段的权限判定（必给）。
 * @param {(lease: object) => Promise<object>} [deps.loadSources] 装配输入来源。
 * @param {(lease: object, snapshot: object) => object} [deps.requestFor]
 *   把 lease 与冻结快照翻成 `RunRequest`。给了它就能接自己的模型档案与预算；
 *   不给则用**最小合法**的一份（见 `defaultRequestFor`）。
 * @param {() => number} [deps.clock]
 * @param {(host: object, options?: object) => object} [deps.adapterFactory]
 *   适配器工厂，默认 `createDshRuntimeAdapter`。注入是为了在不启动 DSH 的
 *   前提下测这条接线。
 */
export async function createProductionExecutor(deps = {}) {
  const {
    post, get, host = null, selfCheck = null, canRead,
    loadSources, requestFor = null, clock = () => Date.now(),
    adapterFactory = createDshRuntimeAdapter,
    // PRT-510 运行侧：给了 actor 才接预算闸门（见下面为什么没有默认值）。
    budgetActor = null, currency, onBudgetNote, scope = 'default',
  } = deps

  if (typeof post !== 'function' || typeof get !== 'function') {
    return refuse(EXECUTOR_CODES.BAD_WIRING,
      'createProductionExecutor 需要 post(path, body) 与 get(path)：前者冻结上下文，后者读回冻结的正文。' +
      '少任何一个，这条接线就只能靠编')
  }
  if (typeof canRead !== 'function') {
    // 与路由、与 context-stage 同一条口径：不替调用方决定权限。
    return refuse(EXECUTOR_CODES.BAD_WIRING,
      'createProductionExecutor 需要 canRead：权限判定必须由调用方显式给出，' +
      '一个"默认都能读"的默认值会让一次接线遗漏变成一次静默越权')
  }
  if (typeof selfCheck !== 'function') {
    // **缺省视为未过，而不是"没检查就放行"。**
    // 「没做自检」与「自检通过」在后续行为上完全一样（都会去执行），
    // 而那正是 PRT-213/215 要禁止的。
    return refuse(EXECUTOR_CODES.SELF_CHECK_INCOMPATIBLE,
      '没有提供启动自检结果。**「没检查」不等于「没问题」**：' +
      'PRT-213/215 要求强制面（补丁层 / 运行时能力 / 沙箱管制）未生效时禁止自动执行，' +
      '而一个没做过自检的引擎无法声称它生效了')
  }

  let check
  try {
    check = await selfCheck()
  } catch (e) {
    return refuse(EXECUTOR_CODES.SELF_CHECK_INCOMPATIBLE,
      `启动自检自身抛错：${e?.message ?? e}——自检跑不起来时无法声称强制面生效`)
  }
  if (check === null || typeof check !== 'object' || typeof check.autoExecutionForbidden !== 'boolean') {
    // 形状不对同样 fail closed：`autoExecutionForbidden` 缺失时，
    // `check.autoExecutionForbidden === true` 是 false，于是会**放行**。
    return refuse(EXECUTOR_CODES.SELF_CHECK_INCOMPATIBLE,
      '启动自检结果缺少布尔字段 autoExecutionForbidden。' +
      '缺了它，「禁止执行」这个判定读出来是 false——形状错误会被当成通过')
  }
  if (check.autoExecutionForbidden === true) {
    return refuse(EXECUTOR_CODES.SELF_CHECK_INCOMPATIBLE,
      '启动自检判定强制面未生效，禁止自动执行',
      { reasons: Array.isArray(check.reasons) ? check.reasons : [] })
  }

  if (host === null || typeof host !== 'object') {
    return refuse(EXECUTOR_CODES.HOST_PORT_REQUIRED,
      '没有 DSH 宿主端口（startRun / probeRuntime）。' +
      '端口是把这个引擎接上来的唯一通道——缺了它，能执行只能靠编。' +
      '端口由运行时组合层（PRT-214）在 DSH 进程内提供')
  }

  let adapter
  try {
    adapter = adapterFactory(host)
  } catch (e) {
    // 适配器构造失败是**接线错误**，与"运行时挂了"是两件事：
    // 前者该去看端口，后者该去看引擎。混在一起会把排障指向错的方向。
    return refuse(EXECUTOR_CODES.HOST_PORT_REQUIRED,
      `DSH 宿主端口不合法，适配器无法构造：${e?.message ?? e}`)
  }

  const contextStage = createHubContextStage({
    post, canRead, clock,
    ...(loadSources === undefined ? {} : { loadSources }),
  })

  // 探测是**一次**的事：能力协商决定了能不能要求结构化输出，
  // 而它是引擎级的结论，不随 Attempt 变。第一次执行前探一次。
  let probed = false

  // ── PRT-510 运行侧：预算闸门 ──
  //
  // `budgetActor` 给了才建闸门。**不给默认值**：账本要求"谁结算的必须留痕"，
  // 一个默认 actor 会让"没人签名"与"某人签了名"在账本里长得一样。
  // 而"没接闸门"这件事在结果里是可见的（`budgetState: 'not-gated'`），
  // 不会与"预算充足"同形。
  const budgetGate = typeof budgetActor === 'string' && budgetActor.trim() !== ''
    ? createBudgetGate({
        post,
        actor: budgetActor,
        scope,
        ...(currency === undefined ? {} : { currency }),
        ...(onBudgetNote === undefined ? {} : { onNote: onBudgetNote }),
      })
    : null

  // 运行中账本要求取消时记下**理由**。本层只记录，不自己取消——
  // 它不知道 Run 的生命周期，而"以为取消已经发出去了"是最坏的一种错觉。
  let cancelRequested = null

  /**
   * 读回**冻结下来的**正文。
   *
   * `?verify=1` 不是可选的礼貌：一次执行要用一份记录当输入，
   * 而"这份记录没被改过"必须在那之前确认。验不过就拒绝——
   * 把一份验不过的快照喂给模型，等于让"快照可验证"这个保证在最后一米失效。
   */
  async function frozenPrompt(lease) {
    const { attemptId } = lease
    const res = await get(`/api/context-snapshots/${encodeURIComponent(attemptId)}?verify=1`)
    if (res === null || typeof res !== 'object') {
      throw new ExecutorError(EXECUTOR_CODES.CONTEXT_NOT_FROZEN,
        `读回上下文快照失败（无响应）：attempt ${attemptId}`, { attemptId })
    }
    if (res.status === 404) {
      throw new ExecutorError(EXECUTOR_CODES.CONTEXT_NOT_FROZEN,
        `attempt ${attemptId} 没有冻结的上下文快照。` +
        '不能"用空上下文继续"：那会让模型在一个我们无法回答的世界里动手', { attemptId })
    }
    if (res.status !== 200 || res.body?.ok !== true) {
      throw new ExecutorError(EXECUTOR_CODES.CONTEXT_NOT_FROZEN,
        `读回上下文快照失败（HTTP ${res.status}）：${res.body?.error ?? '无说明'}`, { attemptId })
    }
    const verification = res.body.verification
    if (verification === null || typeof verification !== 'object' || verification.ok !== true) {
      throw new ExecutorError(EXECUTOR_CODES.CONTEXT_UNVERIFIED,
        `attempt ${attemptId} 的上下文快照读回时验不过哈希：` +
        '它可能被改过或载荷坏了。拿它当模型输入等于让"这份记录可信"这件事无从谈起',
        { attemptId, verification: verification ?? null })
    }
    const snapshot = res.body.snapshot
    if (snapshot === null || typeof snapshot !== 'object' || typeof snapshot.finalText !== 'string') {
      throw new ExecutorError(EXECUTOR_CODES.CONTEXT_UNVERIFIED,
        `attempt ${attemptId} 的快照没有可用的正文`, { attemptId })
    }
    return snapshot
  }

  const executor = Object.freeze({
    /** 冻结上下文（装配 + 持久化都在 hub 那一侧）。 */
    buildContext: contextStage,

    /**
     * 执行一次 Attempt。
     *
     * **提示词就是快照里的正文**，不重新拼装——这是本模块存在的理由。
     */
    async execute(lease) {
      if (lease === null || typeof lease !== 'object') {
        throw new ExecutorError(EXECUTOR_CODES.BAD_WIRING, 'execute 必须拿到 lease')
      }
      const snapshot = await frozenPrompt(lease)

      const buildRequest = typeof requestFor === 'function'
        ? requestFor
        : defaultRequestFor
      let request
      try {
        request = buildRequest(lease, snapshot)
      } catch (e) {
        throw new ExecutorError(EXECUTOR_CODES.BAD_WIRING,
          `无法把 lease 与快照翻成 RunRequest：${e?.message ?? e}`, { attemptId: lease.attemptId })
      }
      if (request === null || typeof request !== 'object') {
        throw new ExecutorError(EXECUTOR_CODES.BAD_WIRING,
          'requestFor 必须返回一个 RunRequest 对象', { attemptId: lease.attemptId })
      }

      // 第一次执行前探测一次。适配器的 `execute` 依赖探测结论
      // （能力协商决定了能不能要求结构化输出），所以这不是可选步骤。
      if (probed === false) {
        const p = await adapter.probe()
        probed = true
        void p
      }

      // ── PRT-510 运行侧：**花钱之前**把钱占住 ──
      //
      // 顺序是刻意的：预留必须发生在第一次真调用之前。
      // 反过来（先跑再结算）的话，两个 Attempt 可以同时跑完、
      // 都"没超自己的上限"，而账户里一共只有一份钱。
      //
      //   > 「花了多少」可以在事后回答；「还能不能花」只能在事前回答。
      //
      // 预算闸门是可选的（`budgetGate === null` 时整段跳过），但跳过这件事
      // **在返回里是可见的**：`budgetState` 会是 `'not-gated'`。
      // 一个"没接预算"的执行与一个"预算充足"的执行在结果上不该长得一样。
      let reservation = null
      let budgetState = 'not-gated'
      if (budgetGate !== null) {
        const reserved = await budgetGate.reserve(lease)
        reservation = reserved.reservation
        budgetState = reserved.budgetState ?? null
      }

      let terminal = null
      try {
        for await (const ev of adapter.execute(request)) {
          // 适配器发的是**真实事件类型**（`run.completed` 等），不是抽象的 'terminal'。
          // 用契约里的判定函数而不是在这里再写一遍那四个字符串：
          // 抄一遍就是给"新增终态时忘了一处"留门。
          if (ev !== null && typeof ev === 'object' && isTerminalEventType(ev.type)) terminal = ev
          // 运行中的用量采集：账本可能要求取消（到了硬上限）。
          else if (budgetGate !== null && ev !== null && typeof ev === 'object' &&
            (ev.type === 'usage.updated' || ev.type === 'artifact.produced')) {
            const o = await budgetGate.observe(lease, ev.usage ?? ev)
            // 本层**不自己取消**：它不知道 Run 的生命周期，而
            // "以为取消已经发出去了"是最坏的一种错觉。让适配器/调用方去取消。
            if (o.cancel === true) cancelRequested = o.kind ?? 'budget-exceeded'
          }
        }
      } catch (e) {
        // 引擎抛错 → 这次执行失败。**不吞**：吞掉会让 Attempt 停在一个
        // 没有结论的状态，而租期到期后它会被重试——一次真实的失败变成一次静默重试。
        //
        // 但**结算必须先走**：半途抛出时用量未知，按"结果未知"锁住余额，
        // 而不是把预留悄悄放掉（放掉就等于宣称"这次没花钱"）。
        const settlement = budgetGate === null
          ? null
          : await budgetGate.settle(lease, 'outcome_unknown', terminal)
        throw new ExecutorError(EXECUTOR_CODES.RUN_NOT_COMPLETED,
          `执行引擎抛错：${e?.message ?? e}`,
          { attemptId: lease.attemptId, cause: e, budgetState, settlement })
      }

      const outcome = terminal === null
        ? 'outcome_unknown'
        : (TERMINAL_TO_OUTCOME[terminal.type] ?? 'outcome_unknown')

      // 结算：按**终态**而不是"execute 返回了"来映射。
      // 没有终态时 outcome 是 `outcome_unknown` → 账本转 `locked`，
      // **不写任何金额**（写入任何数字都等于宣称"算清了"）。
      const settlement = budgetGate === null
        ? null
        : await budgetGate.settle(lease, outcome, terminal)

      const base = {
        outcome,
        detail: terminal === null
          ? '执行引擎的事件流结束了，但没有给出终态事件。' +
            '此时唯一安全的结论是结果未知——外部写是否已经发生无法判断，禁止自动重试写入'
          : summarize(terminal),
        contextSnapshotRef: lease.attemptId,
        budgetState,
        reservation,
        settlement,
      }
      if (cancelRequested !== null) base.cancelRequested = cancelRequested
      return Object.freeze(base)
    },
  })

  return Object.freeze({ ok: true, executor, selfCheck: Object.freeze(check) })
}

/**
 * 最小合法的一份 `RunRequest`。
 *
 * ## 为什么缺失字段是**抛错**而不是填空字符串
 *
 * 第一版把拿不到的字段一律填 `''`。结果是：适配器在
 * `validateRunRequest` 里报「workspaceId 必填；modelProfileRef 必填」，
 * 而那已经是**离真因很远的地方**——真因是"这次 lease 里没有工作区"。
 * 两跳之外的报错会把排障指向适配器，而不是指向那个没传值的调用方。
 *
 *   > 一个中间层把错误糊过去，下游那次拒绝就永远看不到真正的输入。
 *
 * 所以这里**先自己检查**，缺什么就一次说清缺什么，用 `BAD_WIRING`。
 *
 * 能从快照的 `associations` 里取的（goalId / taskId / employeeId / teamPlanId）
 * 才允许回落；`workspaceId` 与 `modelProfileRef` 取不到就必须由调用方给——
 * 它们是"在哪个目录里、用哪个模型跑"，猜不出来。
 *
 * `expectedOutput.schema` 是必给的：缺 schema 时适配器的结构化校验是
 * **fail closed** 的，一次"没声明输出形状"的执行会在**跑完之后**才发现，
 * 而那时 token 已经花掉了。
 */
export function defaultRequestFor(lease, snapshot) {
  const assoc = snapshot?.associations ?? {}
  const request = {
    runId: lease.runId ?? `run:${lease.attemptId}`,
    attemptId: lease.attemptId,
    idempotencyKey: lease.idempotencyKey ?? `idem:${lease.taskId ?? lease.attemptId}`,
    workspaceId: lease.workspaceId,
    goalId: lease.goalId ?? assoc.goalId,
    taskId: lease.taskId ?? assoc.taskId,
    employeeId: lease.employeeId ?? assoc.employeeId,
    teamPlanRef: lease.teamPlanRef ?? assoc.teamPlanId,
    // **这一行是本模块的全部要点**：执行引用的就是那份被冻结、被哈希、
    // 被审计的快照，而不是"执行时再拼一遍"。
    contextSnapshotRef: lease.attemptId,
    modelProfileRef: lease.modelProfileRef,
    budget: lease.budget ?? {},
    timeoutMs: lease.timeoutMs ?? 600_000,
    workdir: lease.workdir,
    permissions: lease.permissions ?? { preset: 'legion-attended', tools: [] },
    expectedOutput: {
      schema: lease.outputSchema ?? { type: 'object', additionalProperties: true },
      acceptance: lease.acceptance ?? '引擎正常结算',
    },
    // 提示词**只**来自冻结的正文。
    prompt: snapshot.finalText,
  }

  const missing = []
  for (const field of RUN_REQUEST_REQUIRED) {
    const v = request[field]
    if (v === undefined || v === null || v === '') missing.push(field)
  }
  if (missing.length > 0) {
    throw new ExecutorError(EXECUTOR_CODES.BAD_WIRING,
      `这次 Attempt 的 RunRequest 缺 ${missing.length} 个必填字段：${missing.join('、')}。` +
      '它们既不在 lease 里，也不在快照的 associations 里。' +
      '在这里说清，好过让适配器在两跳之外报一句"必填"——那时排障会指向适配器而不是输入',
      { attemptId: lease.attemptId, missing })
  }
  return request
}

/** 终态事件 → 给运维看的一句话。不把整个结果对象塞进 detail。 */
function summarize(terminal) {
  const code = terminal.code ?? null
  const stop = terminal.result?.stopReason ?? null
  const parts = []
  if (code !== null) parts.push(`码 ${code}`)
  if (stop !== null) parts.push(`停止原因 ${stop}`)
  if (Array.isArray(terminal.validationErrors) && terminal.validationErrors.length > 0) {
    parts.push(`结构化校验失败：${terminal.validationErrors.slice(0, 5).join('；')}`)
  }
  return parts.length > 0 ? parts.join('，') : `终态 ${terminal.type}`
}

function refuse(code, message, extra = {}) {
  return Object.freeze({ ok: false, code, message, ...extra })
}
