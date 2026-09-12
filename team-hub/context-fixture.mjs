// team-hub/context-fixture.mjs
// ============================================================================
// 测试夹具：把一份上下文快照冻结进库里（PRT-411）
//
// ## 为什么需要它
//
// `BuildingContext → Running` 声明了 `requiresPersist: ['attempt','contextSnapshot']`。
// PRT-411 把这条声明变成了**真的闸门**（此前它只是事件流里的一段 JSON），
// 于是所有"走到 Running"的测试夹具都必须真的冻结一份快照——
// 否则它们走的是**一条走不通的路**，而红的是夹具、不是闸门。
//
// 这个助手不是"为了让用例变绿"的逃生口。它调的是**真实的写入路径**：
//
//     assembleContext → contextStore.record
//
// 而不是手写一条 INSERT。后者要把 `run_context_snapshots` 的 20 个 `NOT NULL`
// 列名抄一遍，那些列一旦增删，夹具会**静默地**与真实表结构脱节
// （插入报错还算好的；列名恰好还兼容时才真正难查）。
//
// ## 为什么放在 team-hub 而不是某个 test 文件里
//
// 8 个套件需要它（acceptance / handoff / run-plane / run-policy / run-routes /
// run-kill-drill / run-store / …）。放在某一个 .test.mjs 里会让其余 7 个
// 各自"顺手抄一份"，而抄出来的副本不会有人记得同步。
// ============================================================================

import { assembleContext } from '../runtime/context/assembler.mjs'
import { TOKEN_ESTIMATOR_KINDS } from '../runtime/contracts/context.mjs'

/** 一个零依赖的 tokenizer：数码点。夹具不在乎预算，只在乎"有一份快照"。 */
const FIXTURE_TOKENIZER = Object.freeze({
  kind: TOKEN_ESTIMATOR_KINDS.EXACT,
  count: (text) => [...String(text)].length,
})

/**
 * 冻结一份**最小但合法**的上下文快照，让 `→ Running` 这道闸门能过。
 *
 * 刻意用空候选：这些套件考的是验收/交接/租约，不是装配。
 * 夹具要的是"用最少、且不会漂移的机制让证据存在"——
 * 装配本身由 `context-stage` / `context-assembler` / `context-sources` 各套件覆盖。
 *
 * @param {object} args
 * @param {object} args.store  `createContextStore` 的产物（必须有 `record`）
 * @param {string} args.attemptId
 * @param {number} args.frozenAtMs
 * @param {string} [args.runId] 默认 `run:${attemptId}`
 * @param {string|null} [args.scope]
 * @returns {{attemptId: string, snapshotHash: string, kind: 'frozen'}}
 */
export function freezeFixtureContext({ store, attemptId, frozenAtMs, runId = null, scope = null }) {
  if (store === null || typeof store !== 'object' || typeof store.record !== 'function') {
    throw new TypeError('freezeFixtureContext 需要 contextStore（且必须有 record）')
  }
  if (typeof attemptId !== 'string' || attemptId === '') {
    throw new TypeError('freezeFixtureContext 需要 attemptId')
  }
  if (!Number.isInteger(frozenAtMs)) {
    throw new TypeError('freezeFixtureContext 需要 frozenAtMs（冻结时点不能由这里猜"现在"）')
  }
  const snap = assembleContext({
    attemptId,
    runId: runId ?? `run:${attemptId}`,
    frozenAtMs,
    candidates: [],
    policy: { scope, canRead: () => true, maxTokens: null },
    tokenizer: FIXTURE_TOKENIZER,
  })
  store.record(snap, { scope, actor: 'fixture' })
  return Object.freeze({ attemptId, snapshotHash: snap.snapshotHash, kind: 'frozen' })
}

/**
 * 给一个"按状态序列推进"的夹具用：当它走到 `Running` 时先冻结上下文。
 *
 * 用法与原来的循环完全一样，只多传两个东西：
 *
 *     const advance = makeAdvance({ store, frozenAtMs: () => clock() })
 *     for (const to of ['PreparingWorkspace', 'BuildingContext', 'Running']) {
 *       advance({ attemptId, leaseEpoch, workerId, to })
 *     }
 *
 * @param {object} args
 * @param {object} args.store
 * @param {() => number} args.frozenAtMs
 * @param {(args: object) => object} args.transition 真正的迁移函数（如 `store.transition`）
 * @param {string|null} [args.scope]
 */
export function makeContextAwareTransition({ store, frozenAtMs, transition, scope = null }) {
  if (typeof transition !== 'function') throw new TypeError('需要 transition 函数')
  if (typeof frozenAtMs !== 'function') throw new TypeError('需要 frozenAtMs 取值函数')
  return function advance(args) {
    if (args !== null && typeof args === 'object' && args.to === 'Running') {
      freezeFixtureContext({
        store,
        attemptId: args.attemptId,
        frozenAtMs: frozenAtMs(),
        scope: args.scope ?? scope,
      })
    }
    return transition(args)
  }
}
