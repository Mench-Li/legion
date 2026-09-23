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
import {
  RUN_IDENTITY_WIRE_FIELD, RUN_IDENTITY_WIRE_VERSION, readRunIdentity,
} from '../../runtime/contracts/run-identity.mjs'
import { deriveRunFloor } from '../../team-hub/run-floor.mjs'
import { resolveTool as resolveLegionTool } from '../../runtime/dsh-composition/tool-capability.mjs'
// ★ 名字空间那一半：Legion 工具名 → 执行面名字（含连带代价）。
//   与 `resolveLegionTool` 同一个注入模式：`run-floor.mjs` 是叶子，它只**接收**结论。
//   默认值是**生产实现**，不是替身——`resolveLegionTool` 那一行也是这个写法，
//   理由是"接线要落在被用例覆盖的函数里面"，而不是落在一个没人能跑到的组装点。
import { executionDenialFor } from '../../runtime/dsh-composition/employee-preset.mjs'
// ★ PRT-214 第二步：`approvalPolicy`（自由文本）→ Legion preset（闭集）的**反查**。
//   反查走 `LEGION_PERMISSION_PRESETS` 本身，于是"正着写的表"与"反着查的表"
//   不可能分叉——这与本仓库其它地方"两份表只在有人只改一边的第二天分叉"是同一条纪律。
import { LEGION_PERMISSION_PRESETS, legionPresetForApproval } from '../../runtime/dsh-composition/patch-layer.mjs'
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
  /**
   * ★ PRT-214 第二步：员工清单里的 `approvalPolicy` 在执行面上**没有对应的权限档位**。
   *
   * 这不是"清单写错了"那种笼统的话，而是一条**可裁决**的读数：控制面那一侧
   * `approvalPolicy` 是自由文本，执行面认的 preset 是闭集，两者之间必须有一次
   * 显式翻译，而翻译不出来的那个值只有人能裁决。
   *
   * 与 `RUN_FLOOR_NOT_DERIVED` 分开：那一条说的是"下限派生不出来"（去查权限档位），
   * 这一条说的是"**档位本身翻译不出来**"（去查那个员工的 `approvalPolicy` 取值）。
   * 合并成一个码会让排障停在下限那一层，而真正要改的是另一张表里的一个字符串。
   */
  APPROVAL_POLICY_UNKNOWN: 'EXECUTOR_APPROVAL_POLICY_UNKNOWN',
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
    // PRT-214 续：静态下限**派生成功**时那些"必须被记录"的告诫（连带禁止、
    // 政策禁令落不了地）的出口。默认 `null`。
    //
    // ## 为什么默认是 `null`（"没有出口"）而不是 `() => {}`
    //
    // `null` 在调用点是可以被读出来的一个事实（"这个部署没有接记录出口"），
    // 而 `() => {}` 让"没接"与"接了但什么都不做"变成同一个读数——
    // 那正是本批要消灭的形状：告诫产生了、单测锁了、生产里没人读。
    // 但**两者都不许**让这次 Run 失败，见下面调用点的理由。
    onFloorNotice = null,
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

  // 下限告诫出口坏掉的痕迹（见 `execute()` 里那个 try/catch）。
  // 只留第一条：出口通常对每一条都坏，逐条重记会把真正的问题淹没。
  const noticeSinkFailures = []

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
     *
     * `runInputs`（可选）是 worker 用 `resolveRunInputs()` 装出来的运行输入
     * （`{ok, inputs, missing, sources}`）。**第二个参数而不是并进 lease**：
     * 租约是控制面给的凭据，而这几个值是**本进程**推导出来的，
     * 混成一个对象之后，"控制面这次没给"这件事就再也查不出来了。
     */
    async execute(lease, runInputs = null) {
      if (lease === null || typeof lease !== 'object') {
        throw new ExecutorError(EXECUTOR_CODES.BAD_WIRING, 'execute 必须拿到 lease')
      }
      const snapshot = await frozenPrompt(lease)

      const buildRequest = typeof requestFor === 'function'
        ? requestFor
        : defaultRequestFor
      let request
      try {
        // 第三个参数对调用方自己的 `requestFor` 是**可选**的：
        // 只接两个参数的实现照旧工作（JS 忽略多余实参），
        // 而真要用它的实现（默认那条）能拿到。
        request = buildRequest(lease, snapshot, runInputs)
      } catch (e) {
        // ★ 具名错误**不许**被压成笼统的接线码。
        //
        //   > 一个"下游所有的失败都变成 `BAD_WIRING`"的包装，
        //   > 与一个"排障永远指向接线、而真正的修法在另一张表里"的包装，
        //   > 是同一个东西——只不过前者看起来更整齐。
        //
        // `defaultRequestFor` 现在会为"认不出来的 approvalPolicy"抛一个**具名**的
        // `ExecutorError`；那正是调用方要按码分流的东西，压掉它等于把本批
        // 刚接上的那条归因链断在第一跳。
        if (e instanceof ExecutorError) throw e
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

      // ── 告诫（notices）：这里是它们在**worker 进程**里的出口 ────────────────
      //
      // 位置在拒绝判定**之前**：派生失败时那些"停之前已经翻出来的连带代价"
      // 对排障同样有用，而且"这条告诫存不存在"不该取决于派生成不成功。
      //
      // ## 为什么出口的异常**必须吞掉**（而且这与"不静默"不矛盾）
      //
      // 一个会抛的出口（日志盘满了、stdout 关了）如果能把异常传上去，
      // 一次**纯诊断**失败就变成了一次 Run 失败——而这次 Run 的下限本身
      // 是好的、工具调用本来会被正确地拦。让诊断能停生产，比丢掉一条诊断更坏。
      //
      //   > 一个"记录不下来就别跑了"的实现，与一个"把注意力和保护一起丢掉"的实现，
      //   > 是同一个东西——只不过前者看起来更负责任。
      //
      // 但吞掉的那个异常**不能连自己也一起吞**：它必须留下痕迹，否则
      // "出口坏了"与"没有告诫"又变成同一个读数。所以坏掉的出口会写进
      // `notices.carryFailed`，随下次成功派生一起被人看到。
      if (typeof onFloorNotice === 'function') {
        for (const notice of carried.notices) {
          try {
            onFloorNotice(notice)
          } catch (e) {
            // 只记第一次：出口通常会对每一条都坏，逐条重记会把真正的问题淹没。
            if (noticeSinkFailures.length === 0) {
              noticeSinkFailures.push(`${notice?.code ?? '(无码)'}: ${e?.message ?? String(e)}`)
            }
          }
        }
      }

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

      // ── PRT-214 缺口②：这次 Run 的**授权身份** ─────────────────────────────
      //
      // 与下限**同一处、同一个理由**：装配失败必须在任何花钱或探测的动作之前发生。
      //
      // ## 三个值直接来自 RunRequest 自己（没有任何新的权威）
      //
      //   `scope` ← `workspaceId`（空间 = 效果命名空间；`①` 已证明它是租约 `scope` 的推导）
      //   `cwd`   ← `workdir`（这次 Run 在哪个目录里干活）
      //   `taskId`← `taskId`
      //
      // ★ 这不是"又抄了一份"：`workspaceId` / `workdir` 的权威就是 PRT-253 续批接上的
      //   那一条链（租约 → 空间 / worktree 槽位）。于是**同一个字段只有一个来源**，
      //   而"空间"这件事不会在 worker 里出现第二种算法。
      //
      // ## 为什么**不**在这里判"装不上就拒绝"
      //
      // 拒绝对象是"载荷解释不了"，而那由安装点（`runtime/dsh-composition/run-identity.mjs`）
      // 判——判据只有一处。这里只负责**造**：一个字段拼错了的载荷会带着它的
      // `state: 'refused'` 过线，然后在 Runtime 进程里**具名拒绝这次 Run**。
      // 在这里也判一次，等于让"谁说了算"取决于哪一边先跑。
      const identity = deriveRunIdentityCarrier(request)
      request = identity.request

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
      // ── F-05 前半：把这次 Run 的**事件明细**带出去 ──
      //
      // 改动前这个循环只留两样东西：终态事件（→ `run_results`）与
      // 用量/产物（→ 预算账本）。其余 11 种事件**读完即弃**，于是
      // "这次用了哪个模型、调了哪些工具、说了什么"在事后没有任何地方能回答。
      //
      // 这里改成**收集**（不在这里落库）：落库由 hub 侧在事件流结束后
      // 一次性完成，这样明细的原子性跟着 Attempt 的生命周期走，而不是跟着
      // 一堆各写各的 HTTP 请求走。
      //
      // 三条边界：
      //   · **有上界**（`MAX_COLLECTED_RUN_EVENTS`）。一个长会话可以产生极多的
      //     `message.delta`；无界收集会把 worker 的内存交给上游的流长度决定。
      //     超出时**停止收集并如实标记**（`runEventsTruncated`），不静默丢。
      //   · **序号缺失不补**。契约给每条事件分配 `seq`；没有 `seq` 的事件仍要收
      //     （它可能来自一个更老的适配器），但按到达顺序给一个**负序号**，
      //     与真实序号天然不冲突，读的人一眼能看出这一条不是契约给的号。
      //   · **这里不判断已知/未知**。`known` 由 hub 侧用契约判定——
      //     在这里再判一次就是把同一件事写两遍（`isKnownEventType` 的第二个副本）。
      const collectedEvents = []
      let eventsTruncated = false
      let synthesizedSeq = -1
      try {
        for await (const ev of adapter.execute(request)) {
          if (ev !== null && typeof ev === 'object') {
            if (collectedEvents.length < MAX_COLLECTED_RUN_EVENTS) {
              const hasSeq = Number.isSafeInteger(ev.seq) && ev.seq >= 0
              collectedEvents.push(Object.freeze({
                seq: hasSeq ? ev.seq : synthesizedSeq--,
                type: typeof ev.type === 'string' ? ev.type : 'unknown',
                // 原样带上事件本身；落库方决定怎么存（含体积上界）。
                event: ev,
              }))
            } else {
              eventsTruncated = true
            }
          }
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
        // ★ 抛错路径上**也要把已经收到的事件带出去**：那正是最需要复盘的一次
        //   （"它在炸之前做了什么"）。丢掉它们会让每一次失败都变成一段空白。
        //   带在错误对象上而不是返回值里——这条路径没有返回值。
        throw new ExecutorError(EXECUTOR_CODES.RUN_NOT_COMPLETED,
          `执行引擎抛错：${e?.message ?? e}`,
          {
            attemptId: lease.attemptId, cause: e, budgetState, settlement,
            runEvents: Object.freeze([...collectedEvents]),
            runEventsTruncated: eventsTruncated,
          })
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
        // F-05 前半：这次 Run 的事件明细（只读、按到达顺序）。
        // 由 worker 随终态一起上报给 hub，hub 一次性落库（见 `run_events`）。
        runEvents: Object.freeze([...collectedEvents]),
        // 「收集被上界截断了」必须是一个**能被读出来的**事实，不能靠
        // "事件数刚好等于上界"去猜（那正好也是真产生那么多事件时的读数）。
        runEventsTruncated: eventsTruncated,
      }
      if (cancelRequested !== null) base.cancelRequested = cancelRequested
      // 下限告诫出口坏掉的痕迹：**成功**的 Run 也要能说出"有一条告诫没能被记录"。
      // 只在真的有失败时才加这个键——无差别地加一个空数组，会让"出口坏了"
      // 与"这次没有告诫"在结果的键集合上看起来一样（`[]` 与缺键是两件事）。
      if (noticeSinkFailures.length > 0) base.floorNoticeSinkFailed = Object.freeze([...noticeSinkFailures])
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
 * `RunRequest.permissions` 是契约必填，而 `lease` 上**可以没有**权限档位，
 * 于是 `defaultRequestFor` 一度一直在**编**一份 `{preset:'legion-attended', tools: []}`。
 *
 * ★ 2026-09-18 订正：这里原先写的是"`lease` 上今天**根本没有** `permissions`：
 *   真 `claim()` 回来的对象只有 8 个键"。**那句话已经过期**，而且过期的方式值得记——
 *   它是**偏保守**方向的错，于是比一个乐观的错更难被发现：*它读起来像有人在谨慎*。
 *
 *   今天它是**按接线与否分叉**的，不是一句全局事实：
 *
 *   · **接了线**的 `createRunStore`（生产：`team-hub/server.mjs` 给了
 *     `resolveRunPermissions`）在有岗位清单时，会往租约上加
 *     `allowedTools` / `deniedTools` / `approvalPolicy` **三个键** ⇒ 共 11 个键，
 *     档位**在**这一侧，走 `permissionsFromLease()`。
 *   · **没接线**的 store（`can-read-authorization-source.test.mjs` ①②③④
 *     刻意跑的那一半）仍然恰好 8 个键——它证明的是"档位**不会自己长出来**"。
 *
 *   ⇒ "8 个键"是这个分叉的一边，不是全局状态。把它当全局状态读，
 *     会让这条 JSDoc 在功能接上之后**继续报平安**。
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
 * F-05 前半：一次 Run 最多收集多少条事件明细。
 *
 * 为什么必须有上界：一个长会话可以产生极多的 `message.delta`（逐 token 一条）。
 * 无界收集等于把 worker 的内存交给**上游流的长度**决定——而那个长度由模型的
 * 输出决定，不由我们决定。
 *
 * 取 5000：足够覆盖一次正常 Run 的全部 `tool.*` / `model.selected` / 终态，
 * 又远小于"会把进程撑坏"的量级。超出时**停止收集并如实标记**
 * （`runEventsTruncated: true`），而不是静默丢——一个"明细刚好 5000 条"的读数
 * 与一个"被截断在 5000 条"的读数必须分得开，否则复盘的人会以为那就是全部。
 */
export const MAX_COLLECTED_RUN_EVENTS = 5000

/**
 * ★ PRT-214 第二步：**租约上的权限档位 → `RunRequest.permissions`**。
 *
 * 这是「静态 hard floor 在生产里真的有来源」的最后一段接线。上游是
 * `claim()`：控制面在**认领那一刻**把员工清单里的 `allowedTools` /
 * `deniedTools` / `approvalPolicy` 三个字段原样放进租约（见
 * `team-hub/run-store.mjs` 的 `resolveRunPermissions`）。
 *
 * ## 三个读数，三种处置
 *
 *   · **租约上没有 `allowedTools`** ⇒ 返回 `null`，调用方填 `UNSUPPLIED_PERMISSIONS`，
 *     派生点判成 `run-floor-permissions-missing` 并具名拒绝。
 *     这说的是"控制面没有给出这次能干什么"——**不是**"什么都不能干"。
 *   · **有 `allowedTools`** ⇒ 翻成 `{preset, tools}`。
 *   · **`approvalPolicy` 认不出来** ⇒ **抛** `ExecutorError`
 *     （`EXECUTOR_CODES.APPROVAL_POLICY_UNKNOWN`），由调用方按具名拒绝处置。
 *
 *     为什么是"抛"而不是"返回一个失败读数"：这个函数的返回值**只有两种**
 *     合法形状（一份档位，或 `null` ＝ 控制面没给）。加第三种"失败读数"会让
 *     每一个调用点都必须记得判它，而**漏判的那一个会把失败读数当成一份档位
 *     用下去**——那正好是这个函数要防的事。抛出去则由 JS 自己保证不会漏判。
 *     （`deriveRunFloorCarrier` 走的是另一条路：它的返回值天然要携带拒绝清单，
 *     所以那里用"读数"。两者不是不一致，是返回形状不同——一个没有地方放
 *     拒绝码的函数，只能用抛。）
 *
 * `allowedTools` 形状不对同理（`BAD_WIRING`）：它只由控制面写下，走到那里
 * 说明有人手搓了一份租约。
 *
 * ## 为什么反查失败必须**拒绝**，而不是挑一个默认
 *
 * 控制面那一侧的 `approvalPolicy` 是**自由文本**（`team-hub` 只做
 * `optionalString`；`orchestrator/worker/sources-loader.test.mjs` 里的取值就是
 * `'ask-on-write'`），而执行面认的 preset 是一个**闭集**（今天只有
 * `ask` / `never` 两个）。
 *
 *   > 一张"`never` 之外一律当有人值守"的表是安全的（更严），
 *   > 而一张"`ask` 之外一律当无人值守"的表会把一个拼错的 `'never '`
 *   > 变成一个**更宽**的档位——而那个拼写错误在清单里看不出来。
 *
 * 两张表都"能跑"，所以这里**不给默认**：查不到就拒绝，让那个人来裁决
 * "`ask-on-write` 到底该是哪个 preset"。
 *
 * ## 为什么 `approvalPolicy` 缺省是**有人值守**
 *
 * 与上面不矛盾：`null`/缺省不是"一个认不出来的值"，是"控制面没有表达偏好"。
 * 那时取 `ask` 是**fail closed** 的方向——比无人值守**更严**，
 * 不可能放宽任何东西。反过来的默认（缺省取 `never`）才是会静默放宽的那一种。
 *
 * @param {object} lease
 * @returns {{preset: string, tools: readonly string[]}|null} `null` = 控制面没给档位
 * @throws {ExecutorError} `APPROVAL_POLICY_UNKNOWN`（策略值翻译不出来）
 *   或 `BAD_WIRING`（`allowedTools` 形状不对——那是有人手搓了一份租约）
 */
export function permissionsFromLease(lease) {
  // 已有一份 `permissions` 时以它为准：那是显式的、调用方自己造的请求
  // （`executor.test.mjs` 的 `requestFor` 那条路），租约上的档位不该覆盖它。
  if (lease?.permissions !== undefined && lease?.permissions !== null) return null

  const allowed = lease?.allowedTools
  if (allowed === undefined || allowed === null) return null
  if (!Array.isArray(allowed) || allowed.some((t) => typeof t !== 'string' || t.trim() === '')) {
    throw new ExecutorError(
      EXECUTOR_CODES.BAD_WIRING,
      `租约上的 allowedTools 不是"非空字符串数组"（收到 ${JSON.stringify(allowed)}）。`
      + '`allowedTools` 只由控制面在认领时写下（`team-hub/run-store.mjs` 会先校验形状），'
      + '所以走到这里说明有人手搓了一份租约',
      { attemptId: lease?.attemptId ?? null },
    )
  }

  const approvalPolicy = lease.approvalPolicy ?? null
  // 缺省 → 有人值守（更严的那个）。见上面那段"为什么不矛盾"。
  const preset = approvalPolicy === null ? 'legion-attended' : legionPresetForApproval(approvalPolicy)
  if (preset === null) {
    throw new ExecutorError(
      EXECUTOR_CODES.APPROVAL_POLICY_UNKNOWN,
      `员工清单里的 approvalPolicy=${JSON.stringify(approvalPolicy)} 在执行面上没有对应的权限档位。`
      + `今天认得的是 ${JSON.stringify(Object.values(LEGION_PERMISSION_PRESETS).map((p) => p.approval))}。`
      + '不猜：一个"认不出来就当有人值守"的实现是安全的，'
      + '而一个"认不出来就当无人值守"的实现会把一个拼写错误变成**更宽**的档位——'
      + '两者在清单上看不出区别，所以这里拒绝，由人来裁决这个值该是哪一个',
      { attemptId: lease?.attemptId ?? null, approvalPolicy },
    )
  }
  // `tools` 是**允许**名单（契约 §4.4）：清单里的 `allowedTools` 就是它。
  // `deniedTools` 是**政策禁令**，走静态下限那条路
  // （`deriveRunFloorCarrier` 的 `declaredDenyTools`）——但它挂在**同一个
  // `permissions` 对象**上，理由见 `deriveRunFloorCarrier` 里那段注释：
  // 拆成两个 RunRequest 字段会让"有允许名单、却没有对应禁止名单"变成一个
  // 合法形状，而那个形状读起来与"这个员工没有任何禁令"完全一样。
  const denied = lease?.deniedTools
  if (denied !== undefined && denied !== null &&
      (!Array.isArray(denied) || denied.some((t) => typeof t !== 'string' || t.trim() === ''))) {
    throw new ExecutorError(
      EXECUTOR_CODES.BAD_WIRING,
      `租约上的 deniedTools 不是"非空字符串数组"（收到 ${JSON.stringify(denied)}）。`
      + '`deniedTools` 只由控制面在认领时写下（`team-hub/run-store.mjs` 会先校验形状），'
      + '所以走到这里说明有人手搓了一份租约',
      { attemptId: lease?.attemptId ?? null },
    )
  }
  return {
    preset,
    tools: Object.freeze([...allowed]),
    // 缺席（`undefined`/`null`）**如实缺席**，不补一个空数组：`deniedTools: []`
    // 是"控制面说了这次没有禁令"这句**陈述**，而"控制面没有表达"是另一件事。
    // 两者的下限一样（都不禁任何东西），但 `permissions` 是审计要读的对象，
    // 把一句没做过的陈述写进去，就是让审计读到一个不存在的决定。
    ...(denied === undefined || denied === null ? {} : { deniedTools: Object.freeze([...denied]) }),
  }
}

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
 * ## 生产上的读数（不夸大）—— ★ 2026-09-18 订正：这一节**曾经**夸大过
 *
 * 这一节此前写的是"真 `lease` 上没有 `permissions`（`claim()` 只回 8 个键），
 * 于是**每一个** Run 都走 ③"。**那句话现在是错的**，且错在**偏保守**方向——
 * 所以它比一个乐观的错更难被发现：*它读起来像有人在谨慎*。
 *
 * 今天真实的分叉（两边都有用例钉着）：
 *
 *   · **有岗位清单**（生产主路径）⇒ 租约带 `allowedTools` / `deniedTools` /
 *     `approvalPolicy` ⇒ `permissionsFromLease()` 产出档位 ⇒ `permissions` 不是哨兵
 *     ⇒ 下限 `installed`、guard **真的拦**。证据：`team-hub/run-plane-e2e.test.mjs` ⑧
 *     （清单里的 `git-push` 一路变成 guard 真拒掉的 `bash` / `pwsh`）。
 *   · **没有岗位清单**（或 store 没接线）⇒ 那三个键缺席 ⇒ 走 ③
 *     `run-floor-permissions-missing`。这是**按设计**的 fail closed，
 *     不是"接线还没做"。
 *
 * ⇒ ③ 从"每一个 Run 都走这里"收窄成"**没拿到档位的那一类**走这里"。
 *   "没拿到"与"给了一份空名单"仍然按**引用**分得开——那正是
 *   `UNSUPPLIED_PERMISSIONS` 存在的理由，也是本次接线**第一次**让这个缺口可读的地方：
 *   在此之前，同一件事的表现是"Run 照跑、请求上没有下限"，而缺席那一档在传输层落到
 *   「拒绝一切」的发布前姿态上：*看起来像有保护，实际上一个真工具也没有被这份下限拦过*。
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
    // ★ 政策禁令（`deniedTools`）从 `permissions` 上取，不另开一个 RunRequest 字段。
    //
    //   理由是契约 §4.4 已经把权限档位定成**一个**对象（`{preset, tools}`），
    //   而"允许哪些"与"禁止哪些"是同一次决定的两个方面——分成两个字段之后，
    //   "有一份允许名单、却没有对应的禁止名单"会变成一个合法的请求形状，
    //   而那个形状读起来与"这个员工没有任何禁令"完全一样。
    //
    //   `?? []`：缺席是"没有政策禁令"（一个**合法**的读数，不是失败）。
    //   而"有一份但读不出来"（不是数组）由 `deriveRunFloor` 自己具名拒绝
    //   （`DECLARED_DENY_TOOLS_INVALID`），不在这里吞掉。
    declaredDenyTools: permissions?.deniedTools ?? [],
    resolveTool: resolver,
    resolveExecutionNames: namesResolver,
    cwd: request.workdir,
    platform,
    runId: request.runId ?? null,
  })
  // ★ 告诫（notices）**两条分支都挂**，而且必须挂在载荷上。
  //
  //   派生**成功**时没有失败可以搭车：Run 会照跑，`execute()` 不会抛，
  //   于是"这次下限连带禁了 run-command"这件事在本进程里**没有第二个出口**。
  //   载荷是它唯一的载体，安装点靠它才读得到（见 `RUN_FLOOR_PAYLOAD_KEYS` 那段）。
  //
  //   派生失败时也挂：那时虽然已经有 `refusals` 在说为什么停，
  //   但"停之前已经翻出来的连带代价"对排障仍然有用——而且如果只在成功分支挂，
  //   这条告诫的**存在与否就取决于派生成不成功**，那是两个无关的读数被绑在一起。
  //
  //   形状在这里**规范化**（缺的 `dshTools`/`collateral` 补空数组）：
  //   契约那一层要求键齐全，而派生点内部产出的两条 notice 形状本来就不完全一样
  //   （`unknown-tool-denied` 没有 `dshTools`）。让契约容忍"有的有有的没有"，
  //   等于把"缺失"和"空"在读端混成一件事。
  const wireNotices = Object.freeze(result.notices.map((n) => Object.freeze({
    code: n.code,
    tool: n.tool,
    message: n.message,
    dshTools: Object.freeze([...(n.dshTools ?? [])]),
    collateral: Object.freeze([...(n.collateral ?? [])]),
  })))
  const payload = result.derived === true
    ? Object.freeze({
      version: RUN_FLOOR_WIRE_VERSION, derived: true, floor: result.floor, runId: result.runId,
      notices: wireNotices,
    })
    : Object.freeze({
      version: RUN_FLOOR_WIRE_VERSION,
      derived: false,
      floor: null,
      runId: result.runId,
      // 拒绝码**上载荷**：载荷本身是这份失败唯一会被人读到的地方
      // （`readRunFloor` 不看这个键，但审计/排障会看）。
      refusals: Object.freeze(result.refusals.map((r) => r.code)),
      notices: wireNotices,
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
    // 与 `refusals` 对称地直接暴露：调用方不必下钻 `result` 才能读到告诫。
    // 它们同时也在 `payload` 上——那一份是给**跨进程**的安装点读的。
    notices: result.notices,
    result,
  })
}

/**
 * PRT-214 缺口②：把这次 Run 的**授权身份**装上跑线（生产者）。
 *
 * ## 为什么生产者在这里
 *
 * 与 `deriveRunFloorCarrier()` 逐字同一个理由：spec §6.8 `:437-440` 要求控制面
 * **生成**那两样东西，而"控制面"在 worker 这一侧就是本模块——它是唯一同时看得见
 * `RunRequest` 全部字段与 `permissions` 的地方。
 *
 * ## ★ 三个值全部来自 `RunRequest` 自己，不引入第二份权威
 *
 * | 线上字段 | 来源 | 为什么是它 |
 * | --- | --- | --- |
 * | `scope` | `request.workspaceId` | 空间 = 效果命名空间。`①` 已经证明 `workspaceId` 就是租约的 `scope` 推导出来的，于是"哪个空间"只有一个算法 |
 * | `cwd` | `request.workdir` | 这次 Run 在哪个目录里干活（有隔离时是 worktree 槽位） |
 * | `taskId` | `request.taskId` | 哪条任务 |
 *
 * **`actor` / `action` 不在这里**——它们属于**这次安装**，不是某一次 Run
 * （`runtime/contracts/run-identity.mjs` 的文件头写了完整理由：`RunRequest` 里
 * 没有任何字段能权威地assert"这次由别人负责"，接受它等于让审计归属由请求方自填）。
 *
 * ## 缺席与写坏在这里**分不开**，所以这里不做那个判断
 *
 * `workspaceId` 是契约必填，走到这里必然是**非空字符串**——除非调用方绕过了契约
 * （`deriveRunFloorCarrier` 那条注释描述过同一类绕过）。所以本函数只做一件事：
 * **把值搬到线上形状**。判"这份载荷能不能装"是安装点的职责，判据只有一处
 * （同 `deriveRunFloorCarrier` 结尾那句"判定借用传输层那一份"）。
 *
 * @param {object} request
 * @returns {{request: object, payload: object, state: string, code: string|null, message: string|null}}
 */
export function deriveRunIdentityCarrier(request) {
  if (request === null || typeof request !== 'object') {
    throw new ExecutorError(EXECUTOR_CODES.BAD_WIRING,
      'deriveRunIdentityCarrier 需要一个 RunRequest 对象')
  }
  if (request[RUN_IDENTITY_WIRE_FIELD] !== undefined) {
    throw new ExecutorError(EXECUTOR_CODES.RUN_FLOOR_NOT_DERIVED,
      `这次 Run 的 ${RUN_IDENTITY_WIRE_FIELD} 已经有人填过了——本模块是唯一的那个生产者。` +
      '两个生产者写同一个字段时，真正生效的那一份取决于谁后写，' +
      '而"谁后写"不是一条能被审计的规则',
      { attemptId: request.attemptId })
  }

  const asString = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
  const scope = asString(request.workspaceId)
  const payload = scope === null
    // ★ 造不出一份**可解释**的载荷时，仍然造一份**会被拒绝**的载荷——不是"不挂这个字段"。
    //
    //   两者的读数完全不同：不挂 = `absent` = 安装点按进程级身份继续（**安静地错标**）；
    //   挂一份坏载荷 = `refused` = 安装点**具名拒绝这次 Run**。
    //   而"这次没有空间"恰恰是必须拒绝的那一种——把一次执行记在进程级那个空间名下，
    //   正是本缺口要消灭的形状。
    //
    //   > 一个"造不出来就干脆不挂"的生产者，
    //   > 与一个"把读不出空间的 Run 记在别的空间名下"的运行时，是同一个东西——
    //   > 只不过前者在代码里看起来像是一次体面的省略。
    ? Object.freeze({ version: RUN_IDENTITY_WIRE_VERSION, scope: request.workspaceId ?? null, taskId: null, cwd: null, runId: request.runId ?? null })
    : Object.freeze({
      version: RUN_IDENTITY_WIRE_VERSION,
      scope,
      // `taskId` / `cwd` 用 `?? null` 而不是省略：省略是"这次没提这件事"
      // （沿用进程级那个值），而 `null` 是"这次明确没有"。
      // `workspaceId` 之外的两项在 `RunRequest` 上是必填的，所以这里通常都有值；
      // 传 `null` 只发生在绕过契约的调用方那里，而那正是要被读出来的一种处境。
      taskId: request.taskId ?? null,
      cwd: request.workdir ?? null,
      // ★ 第 118 轮第八轮：`runId` 与前三项**同源**（都随 Run 变、都由本生产者从
      //   `RunRequest` 搬过来），但它是**归属 metadata**、不是授权身份 ——
      //   它不进 `CANONICAL_OP_KEYS`（理由见 `runtime/contracts/run-identity.mjs`
      //   的 `RUN_IDENTITY_OVERLAY_FIELDS`）。车道按它把执行面写下的账**分 Run**。
      runId: request.runId ?? null,
    })

  // 判定**借用传输层那一份**：这里不另写"怎样才算能装"的规则。
  const reading = readRunIdentity(payload)
  return Object.freeze({
    request: Object.freeze({ ...request, [RUN_IDENTITY_WIRE_FIELD]: payload }),
    payload,
    state: reading.state,
    code: reading.code ?? null,
    message: reading.message ?? null,
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
export function defaultRequestFor(lease, snapshot, runInputs = null) {
  const assoc = snapshot?.associations ?? {}
  // ── 运行输入（PRT-253 续批）──────────────────────────────────────────────
  //
  // `workspaceId` / `modelProfileRef` / `workdir` 是"在哪个工作集里、用哪个模型、
  // 在哪个目录里跑"，猜不出来。此前它们**只能**来自租约，而认领响应不带这三项，
  // 于是生产链路上它们恒缺（实测：`missing=["workspaceId","modelProfileRef","workdir"]`）。
  //
  // 现在多了一条**显式**的来源：worker 用 `resolveRunInputs()` 从权威来源
  // （工作区阶段的结果、员工模型绑定、空间 id）装出来的那一份。
  //
  // ★ 只在 `ok === true` 时采纳。一个被**拒绝**的联合里 `inputs` 是 `null`——
  //   而如果这里写成"有 inputs 就用"，那么某天有人改成"拒绝时也带回部分值"，
  //   这条接线就会安静地把一份**不完整的**输入当成完整的用。
  //   判据取联合自己的结论，不取"字段看起来有没有值"。
  const supplied = runInputs !== null && typeof runInputs === 'object' && runInputs.ok === true
    && runInputs.inputs !== null && typeof runInputs.inputs === 'object'
    ? runInputs.inputs
    : null
  const request = {
    runId: lease.runId ?? `run:${lease.attemptId}`,
    attemptId: lease.attemptId,
    idempotencyKey: lease.idempotencyKey ?? `idem:${lease.taskId ?? lease.attemptId}`,
    workspaceId: lease.workspaceId ?? supplied?.workspaceId,
    goalId: lease.goalId ?? assoc.goalId,
    taskId: lease.taskId ?? assoc.taskId,
    employeeId: lease.employeeId ?? assoc.employeeId,
    teamPlanRef: lease.teamPlanRef ?? assoc.teamPlanId,
    // **这一行是本模块的全部要点**：执行引用的就是那份被冻结、被哈希、
    // 被审计的快照，而不是"执行时再拼一遍"。
    contextSnapshotRef: lease.attemptId,
    modelProfileRef: lease.modelProfileRef ?? supplied?.modelProfileRef,
    budget: lease.budget ?? {},
    timeoutMs: lease.timeoutMs ?? 600_000,
    workdir: lease.workdir ?? supplied?.workdir,
    // ★ 三条来源，优先级从高到低（`??` 短路，所以只会算到需要的那一条）：
    //    ① 租约上**已经有一份**显式的 `permissions`——调用方自己造的请求
    //       （`requestFor` 那条路），它比清单更具体，以它为准；
    //    ② 控制面在**认领时**写下的 `allowedTools` / `approvalPolicy`
    //       （本批新接上的那条，`permissionsFromLease`）；
    //    ③ 都没有 → 那个**按引用可辨认**的哨兵，派生点据此判成
    //       "控制面没给档位"并具名拒绝，而不是当成"这个员工不能用任何工具"。
    permissions: lease.permissions ?? permissionsFromLease(lease) ?? UNSUPPLIED_PERMISSIONS,
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
    // ★ 两种"缺"必须分得开（PRT-253 续批）：
    //
    //   · `runInputs` **从来没被给**（或给了但被拒绝）——"没人给"；
    //   · 给了、也 `ok` 了，可这三项里仍然缺——"给了但不全"。
    //
    // 第一版的文案对两种处境说的是同一句"它们既不在 lease 里，也不在
    // 快照的 associations 里"。接上 `resolveRunInputs` 之后，那句话在
    // "装配明明拒绝了、只是没人看它的结论"这种情况下是**错的**——
    // 而排障的人会照着它去查租约，真因却在装配那一步的 `missing` 里。
    //
    //   > 一条指向错误位置的报错，与一条什么都不说的报错，
    //   > 在"下一次要改哪里"这件事上是同一个东西。
    const why = runInputs !== null && typeof runInputs === 'object' && runInputs.ok !== true
      ? `运行输入装配**拒绝了**它们（${runInputs.code ?? '无码'}）：${runInputs.message ?? ''}`
        + `（装配自己列出的缺项：${(runInputs.missing ?? []).join('、') || '（无）'}）`
      : '它们既不在 lease 里，也不在快照的 associations 里，也没有一份可用的运行输入装配'
    throw new ExecutorError(EXECUTOR_CODES.BAD_WIRING,
      `这次 Attempt 的 RunRequest 缺 ${missing.length} 个必填字段：${missing.join('、')}。${why}。` +
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
