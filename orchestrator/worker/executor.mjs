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
// PRT-214 缺口①：那次 Run 的**静态 hard floor** 的**生产生产者**就长在本文件上。
//
// 三样东西各来自一处，而且都是**读**、不是抄：
//   · `deriveRunFloor()` —— 控制面的纯函数（`team-hub/run-floor.mjs`），
//     全仓库唯一一处把"权限档位"翻成下限的地方；
//   · `resolveTool` —— 能力目录的解析口。`run-floor.mjs` **刻意不 import 它**
//     （那会造出 `tool-capability → run-floor → tool-capability` 这个真实的模块环，
//     它的表现是"强制面整段加载不上"），所以这里**注入**，把那条控制反转原样留着；
//   · 线上形状的判定 —— 与传输层**同一份** `readRunFloor()`，不在这里另立一条。
import {
  RUN_FLOOR_STATES, RUN_FLOOR_WIRE_FIELD, RUN_FLOOR_WIRE_VERSION, readRunFloor,
} from '../../runtime/contracts/run-floor.mjs'
import { deriveRunFloor } from '../../team-hub/run-floor.mjs'
import { resolveTool as resolveLegionTool } from '../../runtime/dsh-composition/tool-capability.mjs'
// ★ 名字空间那一半：Legion 工具名 → 执行面名字（含连带代价）。
//   与 `resolveLegionTool` 同一个注入模式：`run-floor.mjs` 是叶子，它只**接收**结论。
//   默认值是**生产实现**，不是替身——`resolveLegionTool` 那一行也是这个写法，
//   理由是"接线要落在被用例覆盖的函数里面"，而不是落在一个没人能跑到的组装点。
import { executionDenialFor } from '../../runtime/dsh-composition/employee-preset.mjs'
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
  /**
   * PRT-253 跨进程：**配了** Runtime 端点，但连不上（进程没起 / 端口没人听）。
   *
   * 与 `HOST_PORT_REQUIRED` 必须分开：那一条是"没配"，这一条是"配了但够不着"。
   * 修法完全不同——一个去补配置，一个去看那台进程为什么没起来。
   */
  RUNTIME_UNREACHABLE: 'EXECUTOR_RUNTIME_UNREACHABLE',
  /**
   * PRT-253 跨进程：**端点在，但凭证不成立**（本进程没配 token / 对端说 token 不对）。
   *
   * 与 `RUNTIME_UNREACHABLE` 分开：一个去配凭证，一个去查网络与进程。
   * 具体的对端码在 `innerCode` 上（例如 `RUNTIME_CONTRACT_NO_TOKEN`
   * 与 `RUNTIME_CONTRACT_UNAUTHORIZED` 是两件事：前者是那台机器没配，后者是你给错了）。
   */
  RUNTIME_UNAUTHORIZED: 'EXECUTOR_RUNTIME_UNAUTHORIZED',
  /**
   * PRT-253 跨进程：对端**具名拒绝**了一件不属于上面两类的请求
   * （协议版本对不上、强制面结论没有来源、请求形状不对……）。
   * 对端的码在 `innerCode` 上。
   */
  RUNTIME_REFUSED: 'EXECUTOR_RUNTIME_REFUSED',
  /**
   * PRT-253 跨进程：`canRead` 没有来源。
   *
   * 跨进程之后，权限判定的权威只在 worker 一侧（它手上有 lease），
   * 而**没有**任何东西能替它决定。这一条**不回落**到"默认都能读"：
   * 那会让一次接线遗漏变成一次静默越权。
   */
  CAN_READ_REQUIRED: 'EXECUTOR_CAN_READ_REQUIRED',
  /**
   * PRT-214 缺口①：这次 Run 的**静态 hard floor 派生不出来**
   * （或请求上已经有一份别人放进来的下限）。
   *
   * 处置是**不派发这次 Run**。不是空下限，也不是缺席：
   * 一个"派生出来的空下限"与一个"这次没有任何东西该被禁止"在空数组上是同一个读数，
   * 只不过前者意味着强制面整段不在，而且**没有任何人会收到告警**。
   */
  RUN_FLOOR_NOT_DERIVED: 'EXECUTOR_RUN_FLOOR_NOT_DERIVED',
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

      // ── PRT-214 缺口①：这次 Run 的**静态 hard floor** ─────────────────────────
      //
      // 位置是刻意的：**在任何花钱或探测的动作之前**。反过来（先探测、先预留预算、
      // 甚至先派发）会让一次纯装配失败表现成一次真实的执行失败——
      // 而"改哪里"这件事正是靠这个顺序保住的。
      //
      // 它对**每一个**请求都跑，包括调用方自己传进来的 `requestFor`：
      // 一个"只有默认那条路带下限"的实现，与一个"任何一条路都不带下限"的实现，
      // 在生产里（只走默认那条路时）是同一个东西——只不过前者会在有人传了
      // `requestFor` 的那一天安静地少掉下限。
      const carried = deriveRunFloorCarrier(request)
      if (carried.state === RUN_FLOOR_STATES.REFUSED) {
        // 归因要落到**派生失败的原因码**上，而不是停在传输层那个笼统的
        // `RUN_FLOOR_NOT_DERIVED` 上：后者说的是"没能读出来"，
        // 前者（`run-floor-permissions-missing` 之类）说的是**去改哪里**。
        const reasonCodes = carried.refusals.map((r) => r.code)
        throw new ExecutorError(EXECUTOR_CODES.RUN_FLOOR_NOT_DERIVED,
          `这次 Run 的静态 hard floor 派生失败（${reasonCodes.join('、') || carried.code}）：` +
          `${carried.refusals[0]?.message ?? carried.message}。` +
          '不派发：缺席（没给下限）与拒绝（给了但解释不了）是两件事，' +
          '而"这次没有东西该被禁止"这句话只能由一次**成功**的派生说出来',
          {
            attemptId: lease.attemptId,
            // ★ 这个键**不能**叫 `code`：`ExecutorError` 先写 `this.code` 再把 extra
            //   `Object.assign` 上去，于是 extra 里一个同名的 `code` 会把具名拒绝码
            //   悄悄换成下面这一层的码——一个测试里看得见、生产里看不见的覆盖。
            wireCode: carried.code,
            refusalCode: reasonCodes[0] ?? null,
            refusals: Object.freeze(reasonCodes),
          })
      }
      request = carried.request

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
        // ── PRT-312：把引擎的 RunResult **原样**带出去 ──
        //
        // 状态机为 `Running → Validating / RetryableFailure / UnknownOutcome`
        // 三条边声明了 `requiresPersist: ['attempt','runResult']`，而 hub 侧要
        // 落库的那份结果**只能从这里出去**：`terminal.result` 就是适配器
        // `buildResult()` 造的那个 RunResult（`runId` / `outcome` / `code` /
        // `output` / `usage` / `userMessage` …）。
        //
        // 在补这一行之前，这个值在这里被 `summarize(terminal)` 压成一段摘要字符串
        // 就丢掉了：执行侧**有**结果、hub 侧**收不到**——中间断的正是这一根线。
        //
        // 没有终态事件时（`terminal === null`）如实给 `null`：此时引擎**确实**
        // 没产出结果，而 `outcome` 已经是 `outcome_unknown`。编一个空对象顶上去，
        // 会让 hub 侧那条记录看起来像"引擎给了结果，只是内容是空的"。
        runResult: terminal === null ? null : (terminal.result ?? null),
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
 * 「控制面**没有**给出这次 Run 的权限档位」时，`defaultRequestFor` 填进去的那一份。
 *
 * ## 为什么它是一个**有身份的常量**，而不是一段字面量
 *
 * `RunRequest.permissions` 是契约必填，而 `lease` 上今天**根本没有** `permissions`：
 * 真 `claim()` 回来的对象只有 8 个键（见 `can-read-authorization-source.test.mjs`），
 * 于是 `defaultRequestFor` 一直在**编**一份 `{preset:'legion-attended', tools: []}`。
 *
 * 编出来的这一份与"这个员工不能用任何工具"在**形状上**完全一样，而
 * `deriveRunFloor()` 的输入契约里写着「空数组是合法的，意思是这个员工不能用任何工具」。
 * 把编出来的那一份喂给它，得到的是 `derived: true` + **空名单**——一份
 * "派生完成、没有任何东西该被禁止"的下限。
 *
 *   > 一份"因为没有权限档位而派生出来的空下限"，
 *   > 与一份"这次确实没有东西该被禁止"的空下限，
 *   > 在返回值的每一个字段上都是同一个东西——
 *   > 只不过前者从一次**接线遗漏**里长出来，而它看起来像一句政策。
 *
 * 所以派生前必须把两者分开，而分开的依据是**引用**、不是形状：
 * 这一份是唯一的那个对象，只在"lease 上什么都没有"时被填进去。
 * 于是"控制面没给"这件事在派生点上是**可判定的**，不靠下一个人记得去比对。
 */
export const UNSUPPLIED_PERMISSIONS = Object.freeze({
  preset: 'legion-attended',
  tools: Object.freeze([]),
})

/**
 * **生产生产者**：从这次 Run 的权限档位派生静态 hard floor，并挂到 `RunRequest` 上。
 *
 * ## 为什么生产者长在**执行侧**，而不是装配侧或适配器侧
 *
 *   · 装配侧（`bootstrapDshRuntime({floor})` / `assembleEnforcement`）是**进程级**的：
 *     Runtime 进程长命、一个进程服务很多次 Run，装配级的下限必然等于第一个 Run 的、
 *     并被后面每一个继承（见 `runtime/dsh-composition/run-floor.mjs` 文件头）。
 *   · 适配器侧（`runtime/adapters/dsh/`）拿不到控制面的权限档位；而且
 *     `runtime/ → team-hub/` 是本仓库**零处**的反向依赖（`enforcement-mapping.mjs:101`）。
 *
 * 剩下的唯一落点就是**构造 RunRequest 的那一处**——也就是本文件。
 *
 * ## 派生不出来时：**派发前具名拒绝**（不是缺席、不是空名单）
 *
 * `deriveRunFloor()` 说 `derived === false` 时 `floor` 是 `null`。三种处置：
 *
 *   ① **不挂这个字段** → 传输层读成 `absent`，即"没有人给我下限"。
 *      一次"解释不了的输入"就此被洗成一次"没给"，而两者的修法完全不同
 *      （改输入 / 补生产者）。**这是本模块最不能选的一条。**
 *   ② **挂一份空下限顶上去** → 把 `refused` 洗成 `installed`，是同一个错的更坏版本：
 *      空名单是"派生了、这次没有东西该被禁止"这句**陈述**，而我们并没有做出这句陈述。
 *   ③ **把失败如实挂上去，然后在派发前停下来**（本模块的选择）。
 *      挂上去的那一份在 `runtime/contracts/run-floor.mjs` 里读成 `refused`
 *      （`derived !== true` ⇒ `NOT_DERIVED`）——也就是**传输层对它的判定本来就是拒收**。
 *      既然无论如何都会被拒收，让它跑一趟只会把一次装配点的失败表现成下游一句
 *      "引擎抛错"（`RUN_NOT_COMPLETED`），排障方向正好指错。
 *      所以这里就地用 `RUN_FLOOR_NOT_DERIVED` 停下，把**每个拒绝码**原样带在
 *      `refusals` 上——`run-floor-permissions-missing` 这类码就是修法的名字。
 *
 * ## 今天生产上的读数（不夸大）
 *
 * 真 `lease` 上没有 `permissions`（`claim()` 只回 8 个键），于是**每一个** Run 都走 ③：
 * `run-floor-permissions-missing`。这是本次接线**第一次**让这个缺口变得可读——
 * 在此之前，同一件事的表现是"Run 照跑、请求上没有下限"，而缺席那一档在传输层落到
 * 「拒绝一切」的发布前姿态上：*看起来像有保护，实际上一个真工具也没有被这份下限拦过*。
 *
 * @param {object} request 已构造好的 `RunRequest`
 * @param {object} [options]
 * @param {(name: string) => object} [options.resolveTool] 能力目录解析口（默认用真的目录）
 * @param {(name: string) => object} [options.resolveExecutionNames]
 *   **名字空间那一半的解析口**：Legion 工具名 → 要在执行面上禁掉哪些名字
 *   （默认用真的路由表 `executionDenialFor()`）。没有它，`denyTools` 里放的就是
 *   执行面认不出的 Legion 能力名，guard 一个真工具都拦不住。
 * @param {string} [options.platform] 路径语义；默认 `process.platform`
 * @returns {{request: object, payload: object, state: string, code: string|null,
 *   message: string|null, refusals: readonly object[], result: object}}
 */
export function deriveRunFloorCarrier(request, {
  resolveTool: resolver = resolveLegionTool,
  resolveExecutionNames: namesResolver = executionDenialFor,
  platform = process.platform,
} = {}) {
  if (request === null || typeof request !== 'object') {
    throw new ExecutorError(EXECUTOR_CODES.BAD_WIRING,
      'deriveRunFloorCarrier 需要一个 RunRequest 对象')
  }
  if (request[RUN_FLOOR_WIRE_FIELD] !== undefined) {
    throw new ExecutorError(EXECUTOR_CODES.RUN_FLOOR_NOT_DERIVED,
      `这次 Run 的 ${RUN_FLOOR_WIRE_FIELD} 已经有人填过了——本模块是唯一的那个生产者。` +
      '两个生产者写同一个字段时，真正生效的那一份取决于谁后写，' +
      '而"谁后写"不是一条能被审计的规则',
      { attemptId: request.attemptId })
  }
  // ★「控制面没给」按**引用**判定（见 `UNSUPPLIED_PERMISSIONS`）：
  //   它在形状上与一份合法的空允许名单完全一样，而两者的派生结论相反。
  const permissions = request.permissions === UNSUPPLIED_PERMISSIONS ? undefined : request.permissions
  const result = deriveRunFloor({
    permissions,
    resolveTool: resolver,
    resolveExecutionNames: namesResolver,
    cwd: request.workdir,
    platform,
    runId: request.runId ?? null,
  })
  const payload = result.derived === true
    ? Object.freeze({
      version: RUN_FLOOR_WIRE_VERSION, derived: true, floor: result.floor, runId: result.runId,
    })
    : Object.freeze({
      version: RUN_FLOOR_WIRE_VERSION,
      derived: false,
      floor: null,
      runId: result.runId,
      // 拒绝码**上载荷**：载荷本身是这份失败唯一会被人读到的地方
      // （`readRunFloor` 不看这个键，但审计/排障会看）。
      refusals: Object.freeze(result.refusals.map((r) => r.code)),
    })
  // 判定**借用传输层那一份**：这里不另写"怎样才算能装"的规则。
  // 两份规则会漂，而漂的那一天表现为"生产者说能装、适配器说解释不了"。
  const reading = readRunFloor(payload)
  return Object.freeze({
    request: Object.freeze({ ...request, [RUN_FLOOR_WIRE_FIELD]: payload }),
    payload,
    state: reading.state,
    code: reading.code ?? null,
    message: reading.message ?? null,
    refusals: result.refusals,
    result,
  })
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
    // ★ **不要**把这一份读成"这个员工的权限"：`lease` 上没有 `permissions` 时它
    //    只是把契约必填项填满。它**按引用**可辨认（`UNSUPPLIED_PERMISSIONS`），
    //    于是下限的派生点能把"没给"与"给了空名单"分开——见那个常量的注释。
    permissions: lease.permissions ?? UNSUPPLIED_PERMISSIONS,
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
