// ============================================================================
// PRT-304 任务扫描与认领策略（从 run-store 里提取出来的资格规则）
//
// 认领有**两条**查询路径，它们的差别只在「从哪一侧去找这条任务」：
//
//   A. **从等着的尝试里挑**（`buildQueuedCandidateSql`）——已经有第 N 次尝试
//      排在队列里，直接把它租出去；
//   B. **从可入队的看板任务里挑**（`buildClaimableTaskSql`）——还没有任何尝试，
//      把这条看板任务变成第 1 次尝试。
//
// ── 本模块唯一真正要紧的那条纪律 ──
//
// **两条路径必须共用同一组「任务级资格」。**
//
// 这件事看起来是显然的，但它有一个很坏的失效模式：两条 SQL 各写一遍资格条件，
// 有人给其中一条加了个条件（或改了个状态名），另一条没跟着改。于是**同一个任务
// 从一条路径领不到、从另一条领得到**。
//
// 而"领得到"这件事的后果是具体的：一条被将军拦下的任务（`hold = 1`）
// 会在操作员以为它停着的时候被执行——连带它的外部写操作。
//
//   > 一个「从等着的尝试里挑」与一个「从可入队的任务里挑」各写一遍资格条件的
//   > 认领逻辑，与一个「被将军拦下的任务照样会被领走」的认领逻辑，
//   > 是同一个东西——只是前者只在某一条路径上发生，平时看不出来。
//
// 所以本模块把任务级资格定义成**一份** `TASK_GATES`，两条 SQL 都由它生成。
// 想改资格条件，只有一处可改——**这是本模块存在的全部理由**。
//
// 另有一段防御：`assertTaskGatesShared()` 直接检查生成出来的两条 SQL 里
// 逐条包含每一个任务级片段。它拦的是"有人绕过生成器、手写了一条新 SQL"
// 这种绕过路径。
// ============================================================================

/** 策略版本。它一变，缓存过的计划与在途的认领判定都该被重新审视。 */
export const CLAIM_POLICY_VERSION = 'legion/claim-policy@1'

/**
 * **终态尝试**：处在这几个状态里的尝试不再算"活跃"。
 *
 * 这个列表被两处用到（`NOT EXISTS` 的活跃判定、以及纯函数版本），
 * 因此同样只能定义一次——一个"少列了一个终态"的错误会让任务永远领不到，
 * 而一个"多列了一个"的错误会让同一条任务被两个 worker 同时执行。
 */
export const TERMINAL_ATTEMPT_STATES = Object.freeze(['Completed', 'Cancelled', 'DeadLetter'])

/** SQL 里的字符串字面量列表，由 `TERMINAL_ATTEMPT_STATES` 生成。 */
function sqlStateList(states) {
  return states.map((s) => `'${s}'`).join(', ')
}

/**
 * **任务级资格**。两条查询路径**必须**共用这一组。
 *
 * 每一项同时给出：
 *   - `sql`   —— 直接拼进 SQL 的片段（用 `t.` 前缀，两条查询都有这个别名）；
 *   - `holds` —— 等价的纯函数判定，供 dry-run / 诊断 / 用例使用。
 *
 * 两者必须一致。有一条用例专门逐个 gate 比对 `sql` 与 `holds` 的语义，
 * 因为一个与 SQL 不一致的"参考实现"比没有参考实现更糟——
 * *一个说法与做法不一样的说明书，与一本印错的说明书，在"照它做会不会出事"上
 * 是同一个东西。*
 */
export const TASK_GATES = Object.freeze([
  Object.freeze({
    id: 'status-todo',
    sql: "t.status = 'todo'",
    holds: (task) => task?.status === 'todo',
    userText: '任务不在待办（todo）状态',
  }),
  Object.freeze({
    // 「将军拦截」：`hold` 为真时这条任务被显式拦下，任何人都不得认领。
    // 这个条件**曾经**只在一条路径上——那正是本模块要消灭的缺陷。
    id: 'not-held',
    sql: 'COALESCE(t.hold, 0) = 0',
    holds: (task) => {
      const h = task?.hold
      // `NULL` / `0` / `false` 都算"没被拦"；`1` / `true` / 任何其它真值算"被拦"。
      return !(h === 1 || h === true || (typeof h === 'number' && h !== 0))
    },
    userText: '任务被将军拦下了（hold）',
  }),
])

/** 尝试级资格：只有 `Queued` 的尝试才谈得上被租出去。 */
export const QUEUED_ATTEMPT_GATES = Object.freeze([
  Object.freeze({
    id: 'attempt-queued',
    sql: "a.state = 'Queued'",
    holds: (attempt) => attempt?.state === 'Queued',
    userText: '这一次尝试不在排队（Queued）状态',
  }),
])

/** 优先级排序：high → medium → 其它（与看板一致）。 */
export const PRIORITY_ORDER_SQL =
  "CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END"

/**
 * 把任务级资格拼成 WHERE 片段。**这是唯一的拼法**——两条查询都走它。
 */
export function taskGatesSql() {
  return TASK_GATES.map((g) => g.sql).join('\n    AND ')
}

/**
 * 路径 A：可入队的看板任务。
 *
 * 条件 = 任务级资格 + 「当前没有任何活跃尝试」+ scope。
 */
export function buildClaimableTaskSql() {
  return `
  SELECT t.id, t.scope FROM tasks t
  WHERE ${taskGatesSql()}
    AND NOT EXISTS (
      SELECT 1 FROM run_attempts a
      WHERE a.task_id = t.id AND a.state NOT IN (${sqlStateList(TERMINAL_ATTEMPT_STATES)})
    )
    {scope}
  ORDER BY ${PRIORITY_ORDER_SQL}, t.createdAt ASC
  LIMIT 1
`
}

/**
 * 路径 B：已经排队等着被领走的尝试。
 *
 * 条件 = 任务级资格 + 尝试是 `Queued` + **退避闸门到点了** +
 * 「这是该任务的最新一次尝试」+ scope。
 *
 * 后两条各自防一类缺陷：
 *   - 退避闸门（`next_attempt_at_ms`）：漏掉它，PRT-309 的退避就只是一段
 *     没人调用的纯函数——一个持续失败的引擎会被立刻反复重试，把配额和日志
 *     一起打满，而所有代码看起来都是对的；
 *   - 最新尝试（`attempt_no = MAX(...)`）：漏掉它，一条有多次历史的尝试
 *     会让**旧的**那一次也被租出去，等于同一条任务被执行两遍。
 */
export function buildQueuedCandidateSql() {
  return `
  SELECT a.* FROM run_attempts a
  JOIN tasks t ON t.id = a.task_id
  WHERE ${taskGatesSql()}
    AND ${QUEUED_ATTEMPT_GATES.map((g) => g.sql).join('\n    AND ')}
    AND (a.next_attempt_at_ms IS NULL OR a.next_attempt_at_ms <= ?)
    AND a.attempt_no = (SELECT MAX(b.attempt_no) FROM run_attempts b WHERE b.task_id = a.task_id)
    {scope}
  ORDER BY a.created_at_ms ASC, a.attempt_no ASC
  LIMIT 1
`
}

/**
 * 两条查询是否**真的**共用同一组任务级资格。
 *
 * 为什么需要它：生成器保证了"由它生成的两条 SQL"一致，但拦不住
 * "有人绕过生成器手写了一条新 SQL"。一个只靠"大家记得用生成器"的约束，
 * 与一个不存在这个约束，在"下一个人会不会绕过它"上是同一个东西。
 *
 * 返回 `{ ok, missing }`——`missing` 列出缺失的片段，供报错直接说清缺了哪一条。
 */
export function assertTaskGatesShared(sqlA = buildClaimableTaskSql(), sqlB = buildQueuedCandidateSql()) {
  const missing = []
  for (const g of TASK_GATES) {
    if (!String(sqlA).includes(g.sql)) missing.push({ query: 'claimable-task', gate: g.id, sql: g.sql })
    if (!String(sqlB).includes(g.sql)) missing.push({ query: 'queued-candidate', gate: g.id, sql: g.sql })
  }
  return Object.freeze({ ok: missing.length === 0, missing: Object.freeze(missing) })
}

/**
 * 两条查询必须都保留 `{scope}` 占位符。
 *
 * `scopedSql` 已经会在替换时断言占位符存在，这里再查一遍是因为**这条断言
 * 值得在策略层就被看见**：分空间领取静默退化成跨空间领取是最难在生产里
 * 认出来的一类越权，而它的成因恰恰是"某次编辑顺手把 `{scope}` 删了"。
 */
export function assertScopePlaceholder(sqlA = buildClaimableTaskSql(), sqlB = buildQueuedCandidateSql()) {
  const missing = []
  if (!String(sqlA).includes('{scope}')) missing.push('claimable-task')
  if (!String(sqlB).includes('{scope}')) missing.push('queued-candidate')
  return Object.freeze({ ok: missing.length === 0, missing: Object.freeze(missing) })
}

/** 认领被拒绝的原因码。 */
export const CLAIM_REJECTIONS = Object.freeze({
  TASK_NOT_FOUND: 'claim-task-not-found',
  TASK_HELD: 'claim-task-held',
  TASK_NOT_TODO: 'claim-task-not-todo',
  ATTEMPT_ACTIVE: 'claim-attempt-active',
  ATTEMPT_NOT_QUEUED: 'claim-attempt-not-queued',
  ATTEMPT_BACKOFF: 'claim-attempt-backoff',
  ATTEMPT_SUPERSEDED: 'claim-attempt-superseded',
  SCOPE_MISMATCH: 'claim-scope-mismatch',
  NO_ELIGIBLE_ATTEMPT: 'claim-no-eligible-attempt',
})

/**
 * 纯函数参考实现：这条**任务**够不够资格被认领（只看任务级资格）。
 *
 * 返回 `{ ok, code, userText }`。`ok: true` 不代表"现在就能领到"——
 * 尝试级条件还要另外满足；它只回答"任务这一层拦不拦"。
 */
export function isTaskEligible(task, { scope = null } = {}) {
  if (task === null || task === undefined) {
    return Object.freeze({ ok: false, code: CLAIM_REJECTIONS.TASK_NOT_FOUND, userText: '找不到这条任务' })
  }
  // scope 不匹配单独报：把它混进"资格不够"里，会让一个跨空间访问看起来
  // 像一次正常的"这任务还不该领"。
  if (scope !== null && scope !== undefined && task.scope !== scope) {
    return Object.freeze({
      ok: false, code: CLAIM_REJECTIONS.SCOPE_MISMATCH,
      userText: `任务在空间「${task.scope}」，而本次认领限定在「${scope}」`,
    })
  }
  for (const g of TASK_GATES) {
    if (g.holds(task) !== true) {
      return Object.freeze({
        ok: false,
        code: g.id === 'not-held' ? CLAIM_REJECTIONS.TASK_HELD
          : g.id === 'status-todo' ? CLAIM_REJECTIONS.TASK_NOT_TODO
            : `claim-${g.id}`,
        userText: g.userText,
        gate: g.id,
      })
    }
  }
  return Object.freeze({ ok: true, code: null, userText: null, gate: null })
}

/** 终态尝试判定（与 SQL 里那个 `NOT IN` 列表同源）。 */
export function isTerminalAttemptState(state) {
  return TERMINAL_ATTEMPT_STATES.includes(state)
}

/** 有活跃尝试吗（＝路径 A 会因此拒绝入队）。 */
export function hasActiveAttempt(attempts = []) {
  return attempts.some((a) => !isTerminalAttemptState(a?.state))
}

/**
 * 纯函数参考实现：这条**尝试**够不够资格被领走（路径 B 的尝试级条件）。
 *
 * `attempts` 是这条任务的**全部**尝试；用来判"是不是最新那一次"。
 */
export function isAttemptClaimable(attempt, attempts = [], { nowMs = Date.now(), latestAttemptNo = null } = {}) {
  if (attempt === null || attempt === undefined) {
    return Object.freeze({ ok: false, code: CLAIM_REJECTIONS.NO_ELIGIBLE_ATTEMPT, userText: '没有可领的尝试' })
  }
  for (const g of QUEUED_ATTEMPT_GATES) {
    if (g.holds(attempt) !== true) {
      return Object.freeze({ ok: false, code: CLAIM_REJECTIONS.ATTEMPT_NOT_QUEUED, userText: g.userText, gate: g.id })
    }
  }
  // 退避闸门：`NULL` 表示不设闸（第一次尝试就是这样）。
  const gate = attempt.next_attempt_at_ms ?? attempt.nextAttemptAtMs ?? null
  if (gate !== null && gate !== undefined && Number(gate) > nowMs) {
    return Object.freeze({
      ok: false, code: CLAIM_REJECTIONS.ATTEMPT_BACKOFF,
      userText: `退避还没到点：还要等 ${Math.ceil((Number(gate) - nowMs) / 1000)} 秒`,
      gate: 'next-attempt-at',
    })
  }
  // 最新尝试：旧的那一次不该被租出去，否则同一条任务会被执行两遍。
  const maxNo = latestAttemptNo !== null && latestAttemptNo !== undefined
    ? Number(latestAttemptNo)
    : attempts.reduce((m, a) => Math.max(m, Number(a?.attempt_no ?? a?.attemptNo ?? -Infinity)), -Infinity)
  const no = Number(attempt.attempt_no ?? attempt.attemptNo)
  if (Number.isFinite(maxNo) && Number.isFinite(no) && no !== maxNo) {
    return Object.freeze({
      ok: false, code: CLAIM_REJECTIONS.ATTEMPT_SUPERSEDED,
      userText: `这不是最新的尝试（这条是第 ${no} 次，最新是第 ${maxNo} 次）`,
      gate: 'latest-attempt',
    })
  }
  return Object.freeze({ ok: true, code: null, userText: null, gate: null })
}

/**
 * 一次完整的"该不该认领"判定（两条路径合并后的口径）。
 *
 * 路径 A 命中时要回答的是"这条任务能不能变成第 1 次尝试"，
 * 路径 B 命中时回答的是"这一次尝试能不能被租走"。`path` 参数把这件事说清楚，
 * 因为**两者的前提不一样**：A 要求"没有活跃尝试"，B 要求"这次是最新的"。
 */
export function explainClaim({ path, task, attempt = null, attempts = [], nowMs = Date.now(), scope = null } = {}) {
  const t = isTaskEligible(task, { scope })
  if (t.ok !== true) return t
  if (path === 'claimable-task') {
    if (hasActiveAttempt(attempts)) {
      return Object.freeze({
        ok: false, code: CLAIM_REJECTIONS.ATTEMPT_ACTIVE,
        userText: '这条任务已经有活跃尝试了，不能重新入队',
        gate: 'no-active-attempt',
      })
    }
    return Object.freeze({ ok: true, code: null, userText: null, gate: null })
  }
  if (path === 'queued-candidate') {
    return isAttemptClaimable(attempt, attempts, { nowMs })
  }
  return Object.freeze({
    ok: false, code: CLAIM_REJECTIONS.NO_ELIGIBLE_ATTEMPT,
    userText: `不认识的认领路径：${path}`,
    gate: 'path',
  })
}

/** 供 `--json` 诊断输出用的策略快照（纯数据，不含任何实时对象）。 */
export function claimPolicySnapshot() {
  return Object.freeze({
    version: CLAIM_POLICY_VERSION,
    terminalAttemptStates: TERMINAL_ATTEMPT_STATES,
    taskGates: Object.freeze(TASK_GATES.map((g) => Object.freeze({
      id: g.id, sql: g.sql, userText: g.userText,
    }))),
    queuedAttemptGates: Object.freeze(QUEUED_ATTEMPT_GATES.map((g) => Object.freeze({
      id: g.id, sql: g.sql, userText: g.userText,
    }))),
    priorityOrderSql: PRIORITY_ORDER_SQL,
    rejections: CLAIM_REJECTIONS,
  })
}
