// orchestrator/worker/context-stage.mjs
// ============================================================================
// `buildContext` 阶段的真实实现（PRT-411）
//
// ## 这个文件要解决的问题
//
// 在 PRT-411 之前，`buildContext` 是一个**注入的桩**：
//
//     buildContext: async () => ({ kind: 'minimal', note })
//
// 而 `orchestrator/worker/main.mjs` 在 `BuildingContext` 那一步之后，
// 直接迁到 `Running` —— 从不落任何上下文快照。于是：
//
//   · spec §6.5 要的「实际发送给 Runtime 的不可变输入」**不存在**；
//   · 事后无法回答「模型当时看到了什么」；
//   · `requiresPersist: ['attempt','contextSnapshot']` 只是一段 JSON（PRT-411 已把它变成真闸门）。
//
// 同时 `runtime/context/` 下的装配器、来源、脱敏、tokenizer、快照仓储
// **全部已交付且各有套件**，却**没有一个生产调用方**
// ——「一个没有入口的功能与不存在的功能，对用户是一样的」。
//
// 这个文件就是那个入口。
//
// ## 两条判断
//
// ① **装配需要的输入拿不到时，必须失败，不能降级成"空上下文"。**
//    一份空的快照会让 Attempt 走进 `Running` 而模型什么都没有——
//    比失败坏得多：失败会被重试或上报，空快照会被当成"正常运行"。
//
// ② **冻结在 `Running` 之前，且冻结之后不再改。**
//    运行中到达的新评论/目标更新只进**下一次** Attempt（spec §6.5：
//    "首版不向正在运行的模型热注入"）。所以这里产出的快照是终态，
//    没有 update 路径——仓储层同样没有（PRT-409）。
// ============================================================================

import { assembleContext } from '../../runtime/context/assembler.mjs'
import { collectCandidates, SourceError } from '../../runtime/context/sources.mjs'
import { TOKEN_ESTIMATOR_KINDS } from '../../runtime/contracts/context.mjs'

/** 这个阶段自己的失败码。**不复用装配器的码**——排查时要知道是谁失败的。 */
export const CONTEXT_STAGE_ERRORS = Object.freeze({
  /** 拿不到装配所需的输入（目标 / 任务 / 团队计划 / 清单）。 */
  INPUT_UNAVAILABLE: 'CONTEXT_INPUT_UNAVAILABLE',
  /** 装配本身失败（越限、缺 tokenizer…）。 */
  ASSEMBLY_FAILED: 'CONTEXT_ASSEMBLY_FAILED',
  /** 快照落库失败。**此时绝不能继续**——闸门要求它存在，而更重要的是：没有它就没有"模型看到了什么"。 */
  PERSIST_FAILED: 'CONTEXT_PERSIST_FAILED',
  /** 调用方没有提供必需的依赖。这是**编程错误**，不是运行期状况。 */
  BAD_WIRING: 'CONTEXT_BAD_WIRING',
})

export class ContextStageError extends Error {
  constructor(code, message, { cause = null, ...extra } = {}) {
    super(message)
    this.name = 'ContextStageError'
    this.code = code
    this.stage = 'buildContext'
    if (cause !== null) this.cause = cause
    Object.assign(this, extra)
  }
}

/**
 * 保守估算器的兜底实现。
 *
 * 与 PRT-413 的口径一致：**必须是可证明的上界**，宁可高估。
 * `tokens ≤ code points ≤ UTF-8 bytes`，这里取 code points
 * （对绝大多数 tokenizer 已经足够，而且不需要 Buffer，在受限环境里也能跑）。
 *
 * 注意它**明确标记**自己是估算：`kind` 进快照也进哈希，
 * 所以日后拿精确 tokenizer 重算不会与它混淆。
 */
export function conservativeTokenizer() {
  return Object.freeze({
    kind: TOKEN_ESTIMATOR_KINDS.CONSERVATIVE_ESTIMATE,
    note: '无精确 tokenizer：保守估算（按码点计，只会高估）',
    count: (text) => [...String(text)].length,
  })
}

/**
 * 造一个真实的 `buildContext` 阶段。
 *
 * @param {object} deps
 * @param {object} deps.contextStore  `team-hub/context-store.mjs` 的 store（要求 `record`）
 * @param {(lease: object) => Promise<object>} deps.loadInputs
 *   取装配输入：`{goal, task, teamPlan, employeeManifest, comments, upstreamDeliveries, artifacts, workspaceState, published, scope}`
 *   ——形状与 `collectCandidates` 的入参一致。**由调用方提供**，因为
 *   "从哪里读这些"属于产品层的数据面，不属于 worker 的调度逻辑。
 * @param {object} [deps.tokenizer] 不传则用保守估算器
 * @param {object} [deps.policy] `{priority, maxTokens}`；`canRead` 由 manifest 推出
 * @param {(meta: object, ctx: object) => boolean} [deps.canRead]
 *   权限判定。**只用元数据**（spec §6.5：判定先于读正文）。
 *   不传时**拒绝一切**（fail closed）——一个"默认都能读"的默认值
 *   会让一次接线遗漏变成一次静默越权。
 * @param {(event: object) => void} [deps.writeAudit]
 * @param {() => number} [deps.clock]
 * @returns {(lease: object) => Promise<object>}
 */
export function createContextStage(deps) {
  if (deps === null || typeof deps !== 'object') {
    throw new ContextStageError(CONTEXT_STAGE_ERRORS.BAD_WIRING, 'createContextStage 需要依赖对象')
  }
  const { contextStore, loadInputs } = deps
  if (contextStore === null || typeof contextStore !== 'object' || typeof contextStore.record !== 'function') {
    throw new ContextStageError(CONTEXT_STAGE_ERRORS.BAD_WIRING,
      'createContextStage 需要 contextStore（且必须有 record 方法）——没有它就没有"模型当时看到了什么"')
  }
  if (typeof loadInputs !== 'function') {
    throw new ContextStageError(CONTEXT_STAGE_ERRORS.BAD_WIRING,
      'createContextStage 需要 loadInputs——从哪里读装配输入属于产品数据面，不能在这里猜')
  }
  const clock = deps.clock ?? (() => Date.now())
  const tokenizer = deps.tokenizer ?? conservativeTokenizer()
  const writeAudit = typeof deps.writeAudit === 'function' ? deps.writeAudit : () => {}
  // **fail closed**：不传 canRead 就拒绝一切。理由见 JSDoc。
  const canRead = typeof deps.canRead === 'function' ? deps.canRead : () => false
  const canReadIsDefault = typeof deps.canRead !== 'function'

  return async function buildContext(lease) {
    if (lease === null || typeof lease !== 'object') {
      throw new ContextStageError(CONTEXT_STAGE_ERRORS.BAD_WIRING,
        'buildContext 必须拿到 lease——它靠 attemptId/runId 决定冻结给哪一次运行')
    }
    const { attemptId } = lease
    if (typeof attemptId !== 'string' || attemptId === '') {
      throw new ContextStageError(CONTEXT_STAGE_ERRORS.BAD_WIRING,
        'lease 缺少 attemptId（拿不到时的表现会是一条像"参数没传"的错误，而真实原因是调用点漏了参数）')
    }
    const runId = lease.runId ?? lease.attemptId

    // ① 取输入。取不到就**失败**，不降级成空上下文。
    let inputs
    try {
      inputs = await loadInputs(lease)
    } catch (err) {
      throw new ContextStageError(CONTEXT_STAGE_ERRORS.INPUT_UNAVAILABLE,
        `装配输入不可用：${err?.message ?? err}`,
        { cause: err, attemptId })
    }
    if (inputs === null || typeof inputs !== 'object') {
      throw new ContextStageError(CONTEXT_STAGE_ERRORS.INPUT_UNAVAILABLE,
        'loadInputs 返回了非对象——空上下文会让 Attempt 走进 Running 而模型什么都没有',
        { attemptId })
    }

    // ② 收集候选。`scope` 由这里**强制**取自输入，来源里的同名字段盖不掉它。
    let candidates
    let scope
    try {
      scope = requireScope(inputs, lease)
      candidates = collectCandidates({ ...inputs, scope })
    } catch (err) {
      if (err instanceof SourceError) {
        throw new ContextStageError(CONTEXT_STAGE_ERRORS.INPUT_UNAVAILABLE,
          `来源不合格：${err.message}`, { cause: err, attemptId })
      }
      throw err
    }

    // ③ 装配。失败原样上报（`CONTEXT_TOO_LARGE` 等码要能被上层看见），
    //    只加一个 stage 标记——否则 `buildContext` 的异常会被上报成 `execute`。
    const frozenAtMs = clock()
    let snapshot
    try {
      snapshot = assembleContext({
        attemptId,
        runId,
        frozenAtMs,
        associations: {
          goalId: inputs.goal?.id ?? null,
          taskId: inputs.task?.id ?? lease.taskId ?? null,
          employeeId: inputs.employeeManifest?.employeeId ?? null,
          teamPlanId: inputs.teamPlan?.id ?? null,
        },
        candidates,
        policy: {
          scope,
          canRead: (meta) => canRead(meta, { lease, scope, inputs }),
          priority: deps.policy?.priority,
          maxTokens: deps.policy?.maxTokens ?? null,
        },
        tokenizer,
      })
    } catch (err) {
      const e = new ContextStageError(CONTEXT_STAGE_ERRORS.ASSEMBLY_FAILED,
        `上下文装配失败：${err?.message ?? err}`, { cause: err, attemptId })
      // 装配器自己的具名码要保留：上层靠它决定"能不能重试"。
      if (err !== null && typeof err === 'object' && typeof err.code === 'string') e.assemblyCode = err.code
      throw e
    }

    // ④ 落库。**这一步失败必须让整个阶段失败**：状态机的闸门要求快照存在，
    //    而且——比闸门更重要——没有快照就没有"模型看到了什么"。
    //    这里**不** catch 后继续：那会造出一个"跑过了但无据可查"的 Attempt。
    try {
      contextStore.record(snapshot, { scope, actor: lease.workerId ?? null })
    } catch (err) {
      throw new ContextStageError(CONTEXT_STAGE_ERRORS.PERSIST_FAILED,
        `上下文快照落库失败：${err?.message ?? err}`, { cause: err, attemptId })
    }

    writeAudit({
      action: 'context.frozen',
      attemptId,
      runId,
      scope,
      snapshotHash: snapshot.snapshotHash,
      candidateCount: snapshot.candidateCount,
      includedCount: snapshot.sources.length,
      excludedCount: snapshot.excluded.length,
      truncationCount: snapshot.truncations.length,
      redactionCount: snapshot.redactions.length,
      tokensKind: snapshot.tokens.kind,
      tokens: snapshot.tokens.tokens,
      // 接线遗漏是**配置问题**，必须留痕：否则"没人配 canRead"会表现为
      // "所有来源都不可读"，而后者看起来像一次正常的权限结果。
      canReadDefaulted: canReadIsDefault,
    })

    return Object.freeze({
      kind: 'frozen',
      attemptId,
      runId,
      snapshotHash: snapshot.snapshotHash,
      frozenAtMs,
      includedCount: snapshot.sources.length,
      excludedCount: snapshot.excluded.length,
      truncationCount: snapshot.truncations.length,
      redactionCount: snapshot.redactions.length,
      tokensKind: snapshot.tokens.kind,
      tokens: snapshot.tokens.tokens,
      // 默认拒绝时**明说**它发生了。否则"没人接线"会在证据里
      // 长得和"权限判定结果是全都不可读"完全一样。
      canReadDefaulted: canReadIsDefault,
    })
  }
}

/** 取本次运行的空间。缺失直接抛——凭空的 scope 会让权限判定失去参照。 */
function requireScope(inputs, lease) {
  const scope = inputs.scope ?? lease.scope
  if (typeof scope !== 'string' || scope === '') {
    throw new ContextStageError(CONTEXT_STAGE_ERRORS.BAD_WIRING,
      '装配输入里没有 scope——权限判定以空间为参照，缺了它就只能拒绝一切（而现在连"该拒绝"都说不清）')
  }
  return scope
}

/**
 * **远程 worker 用的 `buildContext`**：装配与持久化都在 hub 那一侧完成。
 *
 * ## 为什么远程 worker 不该自己装配
 *
 * 装配需要的数据（目标、任务、团队计划、员工清单、评论、产物）都在 **hub 的库里**。
 * 让 worker 进程自己读，意味着它要么直连那个 SQLite 文件（两进程抢一个库，
 * 而且把数据面细节泄漏进调度层），要么把同样的读取逻辑写第二遍。
 *
 * 而 `POST /api/context-snapshots/assemble` 已经是**装配 + 持久化在同一个请求里**完成的：
 * 于是"冻结在 `Running` 之前"不是一条靠人记住的约定——
 * 这一步没成功，`BuildingContext → Running` 那道闸门就不会放行。
 *
 * ## 权限判定仍然由调用方给出
 *
 * 路由**不替调用方决定权限**（不写就 400 `CONTEXT_PERMISSION_REQUIRED`）。
 * 这里同样不猜：`canRead` 不给就抛 `BAD_WIRING`——
 * 一次漏传不能让越权来源静默进入上下文。
 *
 * @param {object} deps
 * @param {(path: string, body: object) => Promise<{status: number, body: object}>} deps.post
 *   向 hub 发一个 POST。由调用方注入（worker 的 hub 客户端形态不一，
 *   在这里假定其中一种会把两边的接线绑死）。
 * @param {(lease: object) => Promise<object>} [deps.loadSources]
 *   取装配路由要的 `sources` 高层输入。不给则用 `{ scope }`（零来源，
 *   仍然冻结一份合法的空快照——"这次运行看了 0 个来源"是可回答的，
 *   而"没有记录"不是）。
 * @param {(ctx: object) => true|{all:true}|string[]|{ids:string[]}} [deps.canRead] 权限判定，**必给**。
 * @param {() => number} [deps.clock]
 * @returns {(lease: object) => Promise<object>}
 */
export function createHubContextStage(deps) {
  if (deps === null || typeof deps !== 'object') {
    throw new ContextStageError(CONTEXT_STAGE_ERRORS.BAD_WIRING, 'createHubContextStage 需要依赖对象')
  }
  if (typeof deps.post !== 'function') {
    throw new ContextStageError(CONTEXT_STAGE_ERRORS.BAD_WIRING,
      'createHubContextStage 需要 post(path, body)——不假定 hub 客户端的形状，由调用方注入')
  }
  if (typeof deps.canRead !== 'function') {
    // 与路由同一条口径：不替调用方决定权限。
    throw new ContextStageError(CONTEXT_STAGE_ERRORS.BAD_WIRING,
      'createHubContextStage 需要 canRead——路由不替调用方决定权限，这里也不猜。' +
      '缺了它，一次漏传会让越权来源静默进入上下文')
  }
  const clock = deps.clock ?? (() => Date.now())
  const loadSources = typeof deps.loadSources === 'function' ? deps.loadSources : async () => ({})
  const canRead = deps.canRead

  return async function buildContext(lease) {
    if (lease === null || typeof lease !== 'object') {
      throw new ContextStageError(CONTEXT_STAGE_ERRORS.BAD_WIRING, 'buildContext 必须拿到 lease')
    }
    const { attemptId } = lease
    if (typeof attemptId !== 'string' || attemptId === '') {
      throw new ContextStageError(CONTEXT_STAGE_ERRORS.BAD_WIRING,
        'lease 缺少 attemptId——拿不到时的表现会是一条像"参数没传"的错误，而真实原因是调用点漏了参数')
    }
    const runId = lease.runId ?? lease.attemptId
    const scope = requireScope({ scope: lease.scope }, lease)

    let sources
    try {
      sources = await loadSources(lease)
    } catch (err) {
      throw new ContextStageError(CONTEXT_STAGE_ERRORS.INPUT_UNAVAILABLE,
        `装配输入不可用：${err?.message ?? err}`, { cause: err, attemptId })
    }
    if (sources === null || typeof sources !== 'object' || Array.isArray(sources)) {
      throw new ContextStageError(CONTEXT_STAGE_ERRORS.INPUT_UNAVAILABLE,
        'loadSources 必须返回一个对象（高层输入）。空上下文会让 Attempt 走进 Running 而模型什么都没有',
        { attemptId })
    }

    // 权限：能枚举就枚举，否则显式声明"全可读"。
    //
    // 为什么允许 `canReadAll`：真实场景里权限来自 EmployeeManifest 的内容，
    // 而 worker 未必拿得到整份清单。但**这个决定必须是显式的**——
    // 只有调用方明确回答 `{all:true}` 或 `true` 时才这么发，绝不默认。
    const verdict = canRead({ lease, scope, sources })
    let permissionBody
    if (verdict === true || (verdict !== null && typeof verdict === 'object' && verdict.all === true)) {
      permissionBody = { canReadAll: true }
    } else if (Array.isArray(verdict)) {
      permissionBody = { canReadIds: verdict }
    } else if (verdict !== null && typeof verdict === 'object' && Array.isArray(verdict.ids)) {
      permissionBody = { canReadIds: verdict.ids }
    } else {
      throw new ContextStageError(CONTEXT_STAGE_ERRORS.BAD_WIRING,
        'canRead 必须明确回答：`true`（全可读）、`{all:true}`、或可读 id 数组。' +
        '含糊的回答在这里等同"全不可读"，而它看起来会像一次正常的权限结果')
    }

    const frozenAtMs = clock()
    let res
    try {
      res = await deps.post('/api/context-snapshots/assemble', {
        attemptId, runId, frozenAtMs, scope, ...permissionBody, sources,
      })
    } catch (err) {
      throw new ContextStageError(CONTEXT_STAGE_ERRORS.PERSIST_FAILED,
        `装配路由不可达：${err?.message ?? err}`, { cause: err, attemptId })
    }

    // 路由失败就是阶段失败。**不能吞掉**：快照没有落库，
    // 而闸门会拒绝下一步——更本质的是，"模型看到了什么"这个问题的答案不存在。
    if (res === null || typeof res !== 'object' || res.status !== 200 || res.body?.ok !== true) {
      const code = res?.body?.code ?? null
      const e = new ContextStageError(
        code === 'CONTEXT_TOO_LARGE' ? CONTEXT_STAGE_ERRORS.ASSEMBLY_FAILED : CONTEXT_STAGE_ERRORS.PERSIST_FAILED,
        `hub 拒绝了装配（HTTP ${res?.status}，${code ?? '无码'}）：${res?.body?.error ?? '无说明'}`,
        { attemptId },
      )
      if (code !== null) e.assemblyCode = code
      throw e
    }

    const snapshot = res.body.snapshot ?? null
    return Object.freeze({
      kind: 'frozen',
      attemptId,
      runId,
      frozenAtMs,
      snapshotHash: res.body.snapshotHash ?? snapshot?.snapshotHash ?? null,
      includedCount: snapshot?.sources?.length ?? null,
      excludedCount: snapshot?.excluded?.length ?? null,
      truncationCount: snapshot?.truncations?.length ?? null,
      redactionCount: snapshot?.redactions?.length ?? null,
      tokensKind: snapshot?.tokens?.kind ?? null,
      tokens: snapshot?.tokens?.tokens ?? null,
      // 远程路径由路由强制要求显式权限，所以这里**没有**默认放行这回事。
      canReadDefaulted: false,
      assembledBy: 'hub',
    })
  }
}
