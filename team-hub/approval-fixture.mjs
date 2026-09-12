// team-hub/approval-fixture.mjs
// ============================================================================
// 测试夹具：真的写下一行审批（PRT-615）
//
// ## 为什么需要它
//
// `AwaitingApproval` 的**三条出边**（`→ Running` / `→ Validating` / `→ RetryableFailure`）
// 都声明了 `requiresPersist: ['attempt','approval']`。PRT-615 把这条声明变成了
// **真的闸门**（此前它只是事件流里的一段 JSON），于是所有"进出 AwaitingApproval"
// 的测试夹具都必须真的有一条审批记录——否则它们走的是**一条走不通的路**，
// 而红的是夹具、不是闸门。
//
// 这与 PRT-411 的 `context-fixture.mjs` 是同一个处境、同一个处置。
//
// ## 为什么调真实写入路径而不是手写 INSERT
//
// 手写 INSERT 要把 `permission_requests` 的 17 个列名抄一遍，那些列一旦增删，
// 夹具会**静默地**与真实表结构脱节（插入报错还算好的；列名恰好还兼容时才真正难查）。
// 所以这里调 `ensureApprovalSchema` + `createBindingRecord` + `computeBindingHash`
// ——**建表、算哈希、定状态**三件事都走生产的那份实现。
//
//   > 一个"夹具自己手写一份表结构"的夹具，
//   > 与一个"迟早会与真实结构不同步的夹具"，在「它挡住的到底是什么」上是同一个东西。
// ============================================================================

import { createBindingRecord } from './approval-binding.mjs'
import {
  APPROVAL_ATTEMPT_COLUMN,
  BINDING_HASH_COLUMN,
  APPROVAL_TABLE,
  computeBindingHash,
  ensureApprovalSchema,
} from './approval-binding.mjs'
import { APPROVAL_TTL_DEFAULT_MS } from './approval-ttl.mjs'

/**
 * 写下一行**真实的**审批记录，绑定到给定的 attempt。
 *
 * @param {object} args
 * @param {object} args.db
 * @param {string} args.attemptId  「哪一个 Attempt 在等这份审批」（不是 taskId）
 * @param {object} args.operation  被批准的规范化操作
 * @param {'pending'|'approved'} [args.status]  默认 `approved`——夹具多半是为了让
 *   "回到 returnTo"这条出边能过，而那条边只有在批准之后才成立。
 * @param {string} [args.scope]
 * @param {string} [args.taskId]
 * @param {number} [args.ttlMs]
 * @param {number} [args.nowMs]
 * @returns {{requestId: string, bindingHash: string, status: string, attemptId: string}}
 */
export function writeFixtureApproval({
  db, attemptId, operation = {}, status = 'approved', scope = null, taskId = null,
  ttlMs = APPROVAL_TTL_DEFAULT_MS, nowMs = Date.now(), requestId = null,
} = {}) {
  if (db === null || typeof db !== 'object') throw new TypeError('writeFixtureApproval 需要 db')
  if (typeof attemptId !== 'string' || attemptId === '') {
    throw new TypeError('writeFixtureApproval 需要 attemptId——审批挂在** Attempt** 上，不是 taskId')
  }
  if (operation === null || typeof operation !== 'object' || Array.isArray(operation)) {
    throw new TypeError('writeFixtureApproval 的 operation 必须是一个对象')
  }
  if (!['pending', 'approved', 'denied'].includes(status)) {
    throw new TypeError(`writeFixtureApproval 不接受状态 ${JSON.stringify(status)}`)
  }
  ensureApprovalSchema(db)
  const id = requestId ?? `perm-fixture-${attemptId}-${Math.round(nowMs)}`
  const op = {
    scope: operation.scope ?? scope ?? 'legacy',
    actor: operation.actor ?? 'worker:fixture',
    action: operation.action ?? 'fixture:act',
    target: operation.target ?? String(attemptId),
    taskId: operation.taskId ?? taskId,
    unattended: operation.unattended ?? false,
    metadata: operation.metadata ?? {},
  }
  const rec = createBindingRecord({
    requestId: id, operation: op, mode: 'allow-once', ttlMs, nowMs,
    scope: op.scope, actor: op.actor, action: op.action, target: op.target, taskId: op.taskId,
  })
  db.prepare(`INSERT INTO ${APPROVAL_TABLE} (requestId,scope,actor,action,target,taskId,operation,mode,status,createdAt,expiresAt,${BINDING_HASH_COLUMN},${APPROVAL_ATTEMPT_COLUMN})
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      rec.requestId, rec.scope, rec.actor, rec.action, rec.target, rec.taskId,
      JSON.stringify(op), rec.mode, status, new Date(rec.createdAtMs).toISOString(),
      rec.expiresAtMs, rec.bindingHash, attemptId,
    )
  return Object.freeze({
    requestId: rec.requestId, bindingHash: rec.bindingHash, status, attemptId,
    expiresAtMs: rec.expiresAtMs,
  })
}

/** 这一行的绑定哈希（用例要断言它确实被写进去了）。 */
export function fixtureApprovalHash(db, requestId) {
  const row = db.prepare(`SELECT * FROM ${APPROVAL_TABLE} WHERE requestId=?`).get(requestId)
  return row === undefined || row === null ? null : row[BINDING_HASH_COLUMN]
}

/** 让一个夹具审批立刻过期（把 expiresAt 推到过去）。 */
export function expireFixtureApproval(db, requestId, atMs = Date.now() - 1000) {
  db.prepare(`UPDATE ${APPROVAL_TABLE} SET expiresAt=? WHERE requestId=?`).run(Number(atMs), requestId)
  return Number(atMs)
}

export { computeBindingHash }
