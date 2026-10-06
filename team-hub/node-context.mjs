// team-hub/node-context.mjs
// ============================================================================
// 远程派发前的**上下文冻结**（远程 Agent 通道 S-D 之二）
//
// ## 为什么远程路径必须冻结上下文
//
// `orchestrator/state-machine/transitions.mjs` 给 `BuildingContext → Running`
// 声明了 `requiresPersist: ['attempt','contextSnapshot']`，而
// `team-hub/run-store.mjs` 的 `EVIDENCE_CHECKS` **真的核验**它
// （`run_context_snapshots` 里该 attempt 至少一行）。也就是说：
//
//   > 没有快照，这次尝试**不可能**合法地进入 `Running`。
//
// 实测确认过这一点：远端尝试走到 `BuildingContext` 后被
// `EVIDENCE_MISSING: contextSnapshot` 拒掉，任务卡在那里，而执行器白跑一趟。
//
// ## 为什么装配在 Hub 侧，而不是让电脑装配
//
// 装配要的数据（任务、目标、评论、用户反馈、产物）都在 **Hub 的库里**。
// 让电脑读，意味着它要么直连 Hub 的 SQLite（两进程抢一个库，且把数据面细节
// 泄漏进调度层），要么把同一套读取逻辑再写一遍。
//
// Hub 侧已经有**装配 + 持久化在同一个请求里**完成的入口
// （`POST /api/context-snapshots/assemble`，见 `routes/context-snapshots.mjs`），
// 而 `orchestrator/worker/context-stage.mjs` 的 `createHubContextStage`
// 就是**为远程 worker 写的**那一版。本模块做的是同一件事，只是**不走 HTTP**：
//
//   它直接调用同一个装配器与同一个仓储。走 HTTP 自调用也能用，但那会让
//   "Hub 与它自己之间的一次往返"成为一个真实故障点（端口、令牌、以及在
//   单线程事件循环里 await 自己），而收益只是少写十几行。
//
// ## 一道必须说清楚的边界：来源只有五类
//
// 本模块目前只收集 Hub **确实有**的五类来源：任务、目标、评论、用户反馈、产物。
// `teamPlan` / `employeeManifest` / 技能与文档没有接——它们各自属于别的模块。
//
// 缺席的来源**不静默消失**：`collectCandidates` 对缺席项产出"缺失候选"，
// 于是快照里能读到"这次运行本该看团队计划，但系统里没有"，而不是看起来完整。
//
// ## 权限口径（第一版）
//
// 装配器要求一个 `canRead` 判定，而**路由不替调用方决定权限**。这里回答
// 「可读」——理由是**来源集合由本模块自己按 scope 收窄过**：
// 它只读这条任务所属空间里的那几行，一个字都不来自调用方。
//
// 这个理由成立的前提是"调用方不能影响来源集合"，而本模块的入参只有 attempt/task/scope。
// 一旦将来有人给这里加一个来自远端的"额外来源"参数，这个前提就破了——
// 那时 `canRead` 必须改成按员工清单/权限引擎判定，不能继续回答"全可读"。
// 所以这句话写在这里，而不是只说"第一版先这样"。
// ============================================================================
import { assembleContext } from '../runtime/context/assembler.mjs'
import { collectCandidates, SourceError } from '../runtime/context/sources.mjs'
import { TOKEN_ESTIMATOR_KINDS } from '../runtime/contracts/context.mjs'

/** 本模块自己的失败码。**不复用装配器的码**——排查时要知道是谁失败的。 */
export const NODE_CONTEXT_CODES = Object.freeze({
  TASK_UNAVAILABLE: 'NODE_CONTEXT_TASK_UNAVAILABLE',
  SOURCES_UNAVAILABLE: 'NODE_CONTEXT_SOURCES_UNAVAILABLE',
  ASSEMBLY_FAILED: 'NODE_CONTEXT_ASSEMBLY_FAILED',
  PERSIST_FAILED: 'NODE_CONTEXT_PERSIST_FAILED',
  BAD_WIRING: 'NODE_CONTEXT_BAD_WIRING',
})

export class NodeContextError extends Error {
  constructor(code, message, { cause = null, ...extra } = {}) {
    super(message)
    this.name = 'NodeContextError'
    this.code = code
    if (cause !== null) this.cause = cause
    Object.assign(this, extra)
  }
}

/**
 * 保守估算器。与 `orchestrator/worker/context-stage.mjs` 的同名实现一致：
 * **可证明的上界**（`tokens ≤ code points ≤ UTF-8 bytes`），宁可高估。
 * `kind` 进快照也进哈希，所以日后换精确 tokenizer 不会与它混淆。
 */
export function conservativeTokenizer() {
  return Object.freeze({
    kind: TOKEN_ESTIMATOR_KINDS.CONSERVATIVE_ESTIMATE,
    note: '无精确 tokenizer：保守估算（按码点计，只会高估）',
    count: (text) => [...String(text)].length,
  })
}

const parseJson = (value, fallback) => {
  if (value === null || value === undefined || value === '') return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

/** ISO 字符串 → 毫秒。读不出来时返回 `undefined`（由装配器用 nowMs 兜底），**不返回 0**。 */
const msOf = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length > 0) {
    const t = Date.parse(value)
    if (Number.isFinite(t)) return t
  }
  return undefined
}

/**
 * 任务行里的 `comments` JSON（`{by, at, text}`）→ 装配器要的形状。
 *
 * `collectCandidates` 对评论**要求 `id`**（`SOURCE_BAD_INPUT`），而
 * `tasks.comments` 里的条目没有 id——它是追加式数组，位置就是它的身份。
 * 用下标当 id 是稳定的：数组只增不改，所以同一条评论每次算出来的 id 相同，
 * 快照哈希因此可复现。
 *
 * 正文原样带上（`text`），**不截断也不改写**：评论是不可信来源，
 * 它进快照要能被看见原文，而不是一个被本模块加工过的版本。
 */
function normalizeComments(raw) {
  if (!Array.isArray(raw)) return []
  return raw.map((c, i) => {
    const item = (c === null || typeof c !== 'object') ? { text: String(c ?? '') } : c
    return {
      id: typeof item.id === 'string' && item.id.length > 0 ? item.id : `legacy-${i}`,
      text: typeof item.text === 'string' ? item.text : String(item.text ?? ''),
      by: item.by ?? null,
      createdAtMs: msOf(item.at ?? item.createdAtMs ?? item.createdAt),
    }
  })
}

/**
 * 造"派发前冻结上下文"的函数。
 *
 * @param {object} deps
 * @param {import('node:sqlite').DatabaseSync} deps.db
 * @param {object} deps.contextStore `team-hub/context-store.mjs` 的 store（要求 `record`）
 * @param {() => number} [deps.clock]
 * @param {object} [deps.tokenizer]
 * @returns {(claimed: object) => Promise<object>} 成功返回 `{ snapshotHash, summary }`；失败**抛** `NodeContextError`
 */
export function createNodeContextPreparer({ db, contextStore, clock = Date.now, tokenizer = null } = {}) {
  if (db === undefined || db === null) throw new NodeContextError(NODE_CONTEXT_CODES.BAD_WIRING, 'createNodeContextPreparer 需要 db')
  if (contextStore === null || typeof contextStore?.record !== 'function') {
    throw new NodeContextError(NODE_CONTEXT_CODES.BAD_WIRING,
      'createNodeContextPreparer 需要 contextStore（且必须有 record）——没有它就没有"模型当时看到了什么"')
  }
  const tok = tokenizer ?? conservativeTokenizer()

  /** 读这条尝试所属任务的全部可用来源。范围由 scope + taskId 决定，调用方影响不了。 */
  function loadSources({ taskId, scope }) {
    const task = db.prepare('SELECT * FROM tasks WHERE id=? AND scope=?').get(taskId, scope)
    if (!task) {
      throw new NodeContextError(NODE_CONTEXT_CODES.TASK_UNAVAILABLE,
        `装配输入不可用：任务 ${taskId} 不在空间 ${scope} 里`, { taskId, scope })
    }
    let goal = null
    if (typeof task.goalId === 'string' && task.goalId.length > 0) {
      // 目标表可能不存在（老库）：拿不到就是"系统里没有"，不是失败。
      try { goal = db.prepare('SELECT * FROM goals WHERE id=?').get(task.goalId) ?? null } catch { goal = null }
    }
    const comments = normalizeComments(parseJson(task.comments, []))
    const artifacts = parseJson(task.artifacts, [])
    let userFeedback = []
    try {
      userFeedback = db.prepare(
        'SELECT id, body, created_at FROM agent_feedback WHERE scope=? AND task_id=? AND superseded=0 ORDER BY created_at',
      ).all(scope, taskId).map((r) => ({ id: r.id, text: r.body, createdAtMs: msOf(r.created_at) }))
    } catch { userFeedback = [] }

    return {
      scope,
      nowMs: clock(),
      task,
      goal,
      // 评论与反馈都可能为空数组——那是"没有"，不是"没查"。
      comments,
      userFeedback,
      artifacts: Array.isArray(artifacts) ? artifacts : [],
    }
  }

  return async function prepareContext(claimed) {
    if (claimed === null || typeof claimed !== 'object') {
      throw new NodeContextError(NODE_CONTEXT_CODES.BAD_WIRING, 'prepareContext 需要认领结果')
    }
    const { attemptId, taskId, scope, runId = null } = claimed
    for (const [k, v] of Object.entries({ attemptId, taskId, scope })) {
      if (typeof v !== 'string' || v.length === 0) {
        throw new NodeContextError(NODE_CONTEXT_CODES.BAD_WIRING, `认领结果缺少 ${k}`)
      }
    }

    let sources
    try {
      sources = loadSources({ taskId, scope })
    } catch (e) {
      if (e instanceof NodeContextError) throw e
      throw new NodeContextError(NODE_CONTEXT_CODES.SOURCES_UNAVAILABLE,
        `装配输入不可用：${e?.message ?? e}`, { cause: e, attemptId })
    }

    // ★ **已经冻结过就直接复用，不重新装配。**
    //
    // 重连、重派、以及"派发失败后回到队列再被领走"都会让同一条 attempt
    // 再次走到这里。而 `contextStore.record` 对同一 attempt 的第二份**不同**快照
    // 是**拒绝**的（`CONTEXT_SNAPSHOT_CONFLICT`），理由正当：
    // 「同一次运行的上下文不可能有两个版本」。
    //
    // 重新装配之所以会得到"不同"的哈希，是因为 `frozenAtMs` 取了当前时间。
    // 所以正确做法不是放宽仓储，而是**这一层不要重算**——冻结的语义就是"不再改"。
    // 实测踩过：不查这一下时，第二次冻结必抛 PERSIST_FAILED，
    // 表现为"节点重连之后任务再也派不出去"，而根因是幂等，不是装配。
    try {
      const existing = db.prepare('SELECT snapshot_hash FROM run_context_snapshots WHERE attempt_id=?').get(attemptId)
      if (existing !== undefined && typeof existing.snapshot_hash === 'string') {
        return { snapshotHash: existing.snapshot_hash, reused: true, recorded: null, candidateCount: null }
      }
    } catch { /* 表不存在等情形：当作"还没冻结过"，下面的装配会给出更准的错误 */ }

    let snapshot
    try {
      const candidates = collectCandidates(sources)
      snapshot = assembleContext({
        attemptId,
        runId: typeof runId === 'string' && runId.length > 0 ? runId : attemptId,
        frozenAtMs: clock(),
        // 关联只记本模块确实知道的两个：目标来自任务行，团队计划没有接。
        associations: { taskId, goalId: sources.goal?.id ?? null },
        candidates,
        policy: {
          scope,
          // 见文件头那段"权限口径"：来源集合由本模块按 scope 收窄，
          // 调用方无法影响它。**若将来加了来自远端的额外来源，这里必须改成
          // 按员工清单/权限引擎判定。**
          canRead: () => true,
        },
        tokenizer: tok,
      })
    } catch (e) {
      if (e instanceof SourceError) {
        throw new NodeContextError(NODE_CONTEXT_CODES.SOURCES_UNAVAILABLE,
          `来源被拒绝：${e.message}`, { cause: e, attemptId })
      }
      throw new NodeContextError(NODE_CONTEXT_CODES.ASSEMBLY_FAILED,
        `装配失败：${e?.message ?? e}`, { cause: e, attemptId })
    }

    try {
      const rec = contextStore.record(snapshot, { scope, actor: `node:${taskId}` })
      return { snapshotHash: snapshot.snapshotHash, recorded: rec, candidateCount: snapshot.candidateCount ?? null }
    } catch (e) {
      // **落库失败绝不能继续。** 闸门要求它存在，而更重要的是：
      // 没有它就没有"模型当时看到了什么"。
      throw new NodeContextError(NODE_CONTEXT_CODES.PERSIST_FAILED,
        `快照落库失败：${e?.message ?? e}`, { cause: e, attemptId })
    }
  }
}
