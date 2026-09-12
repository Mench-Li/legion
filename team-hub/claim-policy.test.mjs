// team-hub/claim-policy.test.mjs
// ============================================================================
// PRT-304 任务扫描与认领策略的用例
//
// 这一组盯的**不是**"认领能不能跑通"（那是 run-store 那一组的事），而是
// **两条候选路径的资格条件会不会分家**。
//
// 两条路径的差别只在「从哪一侧去找这条任务」：
//   A. 从等着的尝试里挑（已有第 N 次尝试）
//   B. 从可入队的看板任务里挑（还没有任何尝试）
// 它们的**任务级资格必须完全一致**。
//
//   > 一个「从等着的尝试里挑」与一个「从可入队的任务里挑」各写一遍资格条件的
//   > 认领逻辑，与一个「被将军拦下的任务照样会被领走」的认领逻辑，
//   > 是同一个东西——只是前者只在某一条路径上发生，平时看不出来。
//
// 所以第 ① 组逐条比对"两条 SQL 里都有每一个任务级片段"，第 ④ 组用**真的库**
// 把"被将军拦下的任务两条路径都领不走"验一遍。两者缺一不可：
// 前者防"生成器被绕过"，后者防"生成器本身写错了"。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import {
  CLAIM_POLICY_VERSION,
  CLAIM_REJECTIONS,
  PRIORITY_ORDER_SQL,
  QUEUED_ATTEMPT_GATES,
  TASK_GATES,
  TERMINAL_ATTEMPT_STATES,
  assertScopePlaceholder,
  assertTaskGatesShared,
  buildClaimableTaskSql,
  buildQueuedCandidateSql,
  claimPolicySnapshot,
  explainClaim,
  hasActiveAttempt,
  isAttemptClaimable,
  isTaskEligible,
  isTerminalAttemptState,
} from './claim-policy.mjs'
import { createRunStore, ensureRunSchema } from './run-store.mjs'

// ---------------------------------------------------------------- 夹具

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', priority TEXT DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'backlog', version INTEGER NOT NULL DEFAULT 1,
      soldier TEXT, scope TEXT DEFAULT 'default', hold INTEGER DEFAULT 0,
      createdAt TEXT, updatedAt TEXT, acceptance TEXT DEFAULT '[]'
    )
  `)
  ensureRunSchema(db)
  return db
}

let clockMs = 1_700_000_000_000
const clock = () => clockMs

function insertTask(db, { id = 't1', status = 'todo', scope = 'default', hold = 0, priority = 'medium' } = {}) {
  const iso = new Date(clockMs).toISOString()
  db.prepare(
    'INSERT INTO tasks (id, title, status, scope, hold, priority, createdAt, updatedAt, acceptance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, `任务 ${id}`, status, scope, hold, priority, iso, iso, '[]')
}

// ---------------------------------------------------------------- ① 两条路径共用资格

test('① ★★ 两条候选路径**逐条**包含每一个任务级资格（这是本模块存在的理由）', () => {
  const a = buildClaimableTaskSql()
  const b = buildQueuedCandidateSql()
  for (const g of TASK_GATES) {
    assert.ok(a.includes(g.sql), `路径 A（可入队任务）缺少资格「${g.id}」：${g.sql}`)
    assert.ok(b.includes(g.sql), `路径 B（排队尝试）缺少资格「${g.id}」：${g.sql}`)
  }
})

test('① ★ 「将军拦截」（hold）必须在**两条**路径上都出现', () => {
  // 这是最容易漏、后果最具体的一条：一条被 hold 住的任务会在操作员
  // 以为它停着的时候被执行，连带它的外部写操作。
  const held = TASK_GATES.find((g) => g.id === 'not-held')
  assert.ok(held, '任务级资格里没有 hold 这一条')
  assert.ok(buildClaimableTaskSql().includes(held.sql))
  assert.ok(buildQueuedCandidateSql().includes(held.sql))
})

test('① `assertTaskGatesShared()` 对生成出来的两条 SQL 判 ok', () => {
  const r = assertTaskGatesShared()
  assert.equal(r.ok, true)
  assert.deepEqual([...r.missing], [])
})

test('① ★★ 有人绕过生成器手写一条 SQL 时，自检**必须**报出来', () => {
  // 生成器保证了"由它生成的两条 SQL"一致，但拦不住"有人另写了一条"。
  // 一个只靠"大家记得用生成器"的约束，与一个不存在这个约束，
  // 在"下一个人会不会绕过它"上是同一个东西。
  // 注意两次替换都直接拿 **gate 自己的 sql 片段**当作要删的文本，
  // 而不是 `AND ...` 那种带前缀的写法：第一条 gate 前面是 `WHERE` 不是 `AND`，
  // 按前缀去删会**静默删不掉**，于是这条用例会在"其实什么都没改"的情况下
  // 绿过去——一个永远不失败的用例，与一个不存在的用例是同形的。
  const heldGate = TASK_GATES.find((g) => g.id === 'not-held')
  const statusGate = TASK_GATES.find((g) => g.id === 'status-todo')
  const handwrittenA = buildClaimableTaskSql().replace(heldGate.sql, '')
  assert.notEqual(handwrittenA, buildClaimableTaskSql(), '补丁没生效，这条用例等于没测')
  const r = assertTaskGatesShared(handwrittenA, buildQueuedCandidateSql())
  assert.equal(r.ok, false, '少了一条 hold 条件却判 ok')
  assert.ok(r.missing.some((m) => m.gate === 'not-held' && m.query === 'claimable-task'),
    JSON.stringify(r.missing))

  const handwrittenB = buildQueuedCandidateSql().replace(statusGate.sql, '')
  assert.notEqual(handwrittenB, buildQueuedCandidateSql(), '补丁没生效，这条用例等于没测')
  const r2 = assertTaskGatesShared(buildClaimableTaskSql(), handwrittenB)
  assert.equal(r2.ok, false)
  assert.ok(r2.missing.some((m) => m.gate === 'status-todo' && m.query === 'queued-candidate'),
    JSON.stringify(r2.missing))
})

test('① ★ 两条 SQL 都必须保留 `{scope}`（删掉它会静默变成跨空间领取）', () => {
  assert.equal(assertScopePlaceholder().ok, true)
  const noScope = buildClaimableTaskSql().replace('{scope}', '')
  const r = assertScopePlaceholder(noScope, buildQueuedCandidateSql())
  assert.equal(r.ok, false)
  assert.deepEqual([...r.missing], ['claimable-task'])
})

test('① ★★ 加载时自检**真的会拦**（不是一段删掉也不会变红的判断）', async () => {
  // 原来的写法只断言"import 成功"，那在自检被删掉时照样绿——
  // 一个删掉也不会让任何用例变红的判断，与不存在同形。
  // 所以这里喂一对**故意分家**的 SQL 进去，验它真的会抛。
  const m = await import('./run-store.mjs')
  assert.equal(typeof m.assertClaimSqlInvariants, 'function', '自检没有被导出，因此不可验证')

  // 好的一对：不抛
  assert.equal(m.assertClaimSqlInvariants().ok, true)

  const heldGate = TASK_GATES.find((g) => g.id === 'not-held')
  // 排队那条路径少了 hold → 必须抛，且说清缺的是哪一条
  const leaky = buildQueuedCandidateSql().replace(heldGate.sql, '')
  assert.notEqual(leaky, buildQueuedCandidateSql(), '补丁没生效，这条用例等于没测')
  assert.throws(
    () => m.assertClaimSqlInvariants(leaky, buildClaimableTaskSql()),
    /PRT-304/,
    '两条路径分家了，加载时自检却没有抛',
  )

  // 少了 {scope} → 同样必须抛
  const noScope = buildClaimableTaskSql().replace('{scope}', '')
  assert.throws(() => m.assertClaimSqlInvariants(buildQueuedCandidateSql(), noScope), /PRT-304/)

  // ★ 而且它必须**真的在加载时跑过、且校的正是这两条 SQL**。
  // 上面那几条只证明了"这个函数会抛"——把 run-store 里那一行调用删掉，
  // 或者把它换成一个写死的"通过"，它们照样绿。
  //
  // 所以这里断言的是**证据的内容**（它校过的那两条 SQL 文本），而不是一个
  // 布尔标记：一个可以被人随手写成 `true` 的标记，与一个恒真的校验，
  // 在"它到底拦不拦得住"上是同一个东西——而能把它写成 `true` 的，
  // 恰恰就是那个把自检删掉的改动。
  const ev = m.CLAIM_SQL_INVARIANTS_CHECKED
  assert.ok(ev !== null && typeof ev === 'object', '加载时自检没有导出证据——它跑没跑没人知道')
  assert.equal(ev.ok, true, '加载时自检没有跑过')
  assert.equal(ev.sqlA, buildQueuedCandidateSql(), '加载时自检校的不是「排队候选」这条 SQL')
  assert.equal(ev.sqlB, buildClaimableTaskSql(), '加载时自检校的不是「可入队任务」这条 SQL')
})

// ---------------------------------------------------------------- ② 单源化

test('② 终态尝试状态只有**一处**定义，两条 SQL 的 `NOT IN` 列表由它生成', () => {
  const a = buildClaimableTaskSql()
  for (const s of TERMINAL_ATTEMPT_STATES) assert.ok(a.includes(`'${s}'`), `${s} 没进 NOT IN 列表`)
  // 列表确实是拼出来的：改一个状态名，SQL 跟着变
  assert.ok(a.includes(TERMINAL_ATTEMPT_STATES.map((s) => `'${s}'`).join(', ')))
})

test('② ★★ 终态名单被钉死成字面量（漏一个＝那条任务永远领不到，而 SQL 会忠实地跟着漏）', () => {
  // 只断言"每个列出来的状态都进了 SQL"挡不住"名单本身漏了一个成员"——
  // 单一来源在这里反而让错误更隐蔽：SQL 会一致地错。
  assert.deepEqual([...TERMINAL_ATTEMPT_STATES], ['Completed', 'Cancelled', 'DeadLetter'])
})

test('② ★ 三种终态之外的状态一律算活跃', () => {
  for (const s of ['Queued', 'Leased', 'Running', 'Validating', 'PreparingWorkspace', 'AwaitingApproval']) {
    assert.equal(isTerminalAttemptState(s), false, `${s} 被当成了终态`)
  }
})

test('② `isTerminalAttemptState` 与 SQL 列表同源', () => {
  for (const s of TERMINAL_ATTEMPT_STATES) assert.equal(isTerminalAttemptState(s), true, s)
  assert.equal(isTerminalAttemptState('Queued'), false)
  assert.equal(isTerminalAttemptState('Running'), false)
  assert.equal(isTerminalAttemptState(null), false)
})

test('② `hasActiveAttempt` 只把非终态算活跃', () => {
  assert.equal(hasActiveAttempt([]), false)
  assert.equal(hasActiveAttempt([{ state: 'Completed' }, { state: 'Cancelled' }]), false)
  assert.equal(hasActiveAttempt([{ state: 'Completed' }, { state: 'Queued' }]), true)
  assert.equal(hasActiveAttempt([{ state: 'Running' }]), true)
})

test('② 策略版本与快照都是冻结的纯数据（供 --json 诊断）', () => {
  assert.equal(typeof CLAIM_POLICY_VERSION, 'string')
  assert.ok(CLAIM_POLICY_VERSION.includes('@'))
  const snap = claimPolicySnapshot()
  assert.equal(Object.isFrozen(snap), true)
  assert.equal(snap.version, CLAIM_POLICY_VERSION)
  assert.deepEqual([...snap.terminalAttemptStates], [...TERMINAL_ATTEMPT_STATES])
  assert.equal(snap.taskGates.length, TASK_GATES.length)
  // 快照里不得夹带函数（它会进 JSON）
  for (const g of snap.taskGates) {
    assert.deepEqual(Object.keys(g).sort(), ['id', 'sql', 'userText'])
  }
})

test('② 优先级排序片段出现在可入队任务的 ORDER BY 里', () => {
  assert.ok(buildClaimableTaskSql().includes(PRIORITY_ORDER_SQL))
})

// ---------------------------------------------------------------- ③ 纯函数参考实现

test('③ ★ 每个 gate 的 `sql` 与 `holds` 必须在**同一批任务**上给出同一结论', () => {
  // 一个与 SQL 不一致的「参考实现」比没有参考实现更糟：
  // 一个说法与做法不一样的说明书，与一本印错的说明书，
  // 在"照它做会不会出事"上是同一个东西。
  const cases = [
    { status: 'todo', hold: 0 },
    { status: 'todo', hold: 1 },
    { status: 'todo' },
    { status: 'todo', hold: null },
    { status: 'todo', hold: false },
    { status: 'done', hold: 0 },
    { status: 'backlog', hold: 0 },
    { status: 'in_progress', hold: 1 },
  ]
  for (const g of TASK_GATES) {
    for (const t of cases) {
      const sqlSays = evalGateAgainstSql(g, t)
      assert.equal(g.holds(t), sqlSays,
        `资格「${g.id}」对 ${JSON.stringify(t)} 的 sql 判定是 ${sqlSays}，holds 却是 ${g.holds(t)}`)
    }
  }
})

/**
 * 用**真的 SQLite** 判这一条 gate —— 不是重写一遍逻辑，而是把那条片段
 * 交给引擎执行。这样"参考实现与 SQL 是否一致"才是被真正验证的，
 * 而不是"两段我手写的逻辑是否一致"。
 */
function evalGateAgainstSql(gate, task) {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE tasks (status TEXT, hold INTEGER)')
  // node:sqlite 不接受布尔绑定参数，所以 `hold` 要显式归一成 0/1/NULL。
  // 归一化本身也必须忠于原值：`false` → 0、`true` → 1、缺失 → NULL。
  const hold = task.hold === undefined || task.hold === null ? null : (task.hold ? 1 : 0)
  db.prepare('INSERT INTO tasks (status, hold) VALUES (?, ?)').run(task.status ?? null, hold)
  const row = db.prepare(`SELECT 1 AS hit FROM tasks t WHERE ${gate.sql}`).get()
  return row !== undefined && row !== null
}

test('③ `isTaskEligible` 认可一条正常的 todo 任务', () => {
  const r = isTaskEligible({ status: 'todo', hold: 0, scope: 'default' })
  assert.equal(r.ok, true)
  assert.equal(r.code, null)
})

test('③ ★ 被将军拦下的任务被拒，且给出**具体的**理由码', () => {
  const r = isTaskEligible({ status: 'todo', hold: 1, scope: 'default' })
  assert.equal(r.ok, false)
  assert.equal(r.code, CLAIM_REJECTIONS.TASK_HELD)
  assert.ok(r.userText.includes('将军'), r.userText)
})

test('③ 非 todo 状态被拒，理由码与 hold 不同（两者不该混成一件事）', () => {
  const r = isTaskEligible({ status: 'done', hold: 0, scope: 'default' })
  assert.equal(r.code, CLAIM_REJECTIONS.TASK_NOT_TODO)
  assert.notEqual(r.code, CLAIM_REJECTIONS.TASK_HELD)
})

test('③ ★ 空间不匹配有**自己的**理由码（把它混进"资格不够"里会掩盖一次跨空间访问）', () => {
  const r = isTaskEligible({ status: 'todo', hold: 0, scope: 'acme' }, { scope: 'default' })
  assert.equal(r.ok, false)
  assert.equal(r.code, CLAIM_REJECTIONS.SCOPE_MISMATCH)
  assert.ok(r.userText.includes('acme') && r.userText.includes('default'), r.userText)
})

test('③ 找不到任务与"资格不够"是两件事', () => {
  assert.equal(isTaskEligible(null).code, CLAIM_REJECTIONS.TASK_NOT_FOUND)
  assert.equal(isTaskEligible(undefined).code, CLAIM_REJECTIONS.TASK_NOT_FOUND)
})

test('③ ★ 退避没到点时拒绝，并说清还要等多久', () => {
  const now = 1_700_000_000_000
  const r = isAttemptClaimable(
    { state: 'Queued', attempt_no: 1, next_attempt_at_ms: now + 30_000 },
    [{ attempt_no: 1, state: 'Queued' }],
    { nowMs: now },
  )
  assert.equal(r.ok, false)
  assert.equal(r.code, CLAIM_REJECTIONS.ATTEMPT_BACKOFF)
  assert.ok(r.userText.includes('30'), r.userText)
})

test('③ 退避到点、或没有闸门时放行', () => {
  const now = 1_700_000_000_000
  for (const gate of [null, undefined, now - 1, now]) {
    const r = isAttemptClaimable(
      { state: 'Queued', attempt_no: 1, next_attempt_at_ms: gate },
      [{ attempt_no: 1, state: 'Queued' }],
      { nowMs: now },
    )
    assert.equal(r.ok, true, `闸门 ${gate} 不该被拒`)
  }
})

test('③ ★★ 不是最新那一次尝试时拒绝（否则同一条任务会被执行两遍）', () => {
  const now = 1_700_000_000_000
  // 两条**都是 Queued**：如果老的那条是 DeadLetter，"不是最新"这个判定
  // 会被更靠前的"根本不是 Queued"抢先命中，于是这条用例测不到它想测的东西。
  const attempts = [
    { attempt_no: 1, state: 'Queued' },
    { attempt_no: 2, state: 'Queued' },
  ]
  const stale = isAttemptClaimable(attempts[0], attempts, { nowMs: now })
  assert.equal(stale.ok, false)
  assert.equal(stale.code, CLAIM_REJECTIONS.ATTEMPT_SUPERSEDED)
  const latest = isAttemptClaimable(attempts[1], attempts, { nowMs: now })
  assert.equal(latest.ok, true)
})

test('③ 非 Queued 的尝试被拒（码与"退避"不同）', () => {
  const r = isAttemptClaimable({ state: 'Running', attempt_no: 1 }, [{ attempt_no: 1, state: 'Running' }])
  assert.equal(r.ok, false)
  assert.equal(r.code, CLAIM_REJECTIONS.ATTEMPT_NOT_QUEUED)
})

test('③ `explainClaim` 把两条路径的前提分清楚', () => {
  const now = 1_700_000_000_000
  const task = { status: 'todo', hold: 0, scope: 'default' }
  // 路径 A 的前提是"没有活跃尝试"
  assert.equal(explainClaim({ path: 'claimable-task', task, attempts: [] }).ok, true)
  const active = explainClaim({ path: 'claimable-task', task, attempts: [{ state: 'Running' }] })
  assert.equal(active.code, CLAIM_REJECTIONS.ATTEMPT_ACTIVE)
  // 路径 B 的前提是"这次尝试能领"
  assert.equal(
    explainClaim({ path: 'queued-candidate', task, attempt: { state: 'Queued', attempt_no: 1 }, attempts: [{ attempt_no: 1, state: 'Queued' }], nowMs: now }).ok,
    true,
  )
  // 不认识的路径不静默放行
  assert.equal(explainClaim({ path: 'wat', task }).code, CLAIM_REJECTIONS.NO_ELIGIBLE_ATTEMPT)
})

test('③ ★ 任务级不合格时，两条路径都**不会**走到尝试级判定（任务级优先）', () => {
  const held = { status: 'todo', hold: 1, scope: 'default' }
  const now = 1_700_000_000_000
  const viaA = explainClaim({ path: 'claimable-task', task: held, attempts: [] })
  assert.equal(viaA.code, CLAIM_REJECTIONS.TASK_HELD)
  const viaB = explainClaim({
    path: 'queued-candidate', task: held,
    attempt: { state: 'Queued', attempt_no: 1 }, attempts: [{ attempt_no: 1, state: 'Queued' }], nowMs: now,
  })
  assert.equal(viaB.code, CLAIM_REJECTIONS.TASK_HELD, '路径 B 让一条被拦下的任务进入了尝试级判定')
})

test('③ `QUEUED_ATTEMPT_GATES` 的 holds 与它的 sql 也一致', () => {
  assert.equal(QUEUED_ATTEMPT_GATES.length >= 1, true)
  for (const g of QUEUED_ATTEMPT_GATES) {
    assert.equal(g.holds({ state: 'Queued' }), g.sql.includes("'Queued'"))
    assert.equal(g.holds({ state: 'Running' }), false)
  }
})

// ---------------------------------------------------------------- ④ 端到端：真的库

test('④ ★★ 被将军拦下的任务：**两条路径都领不走**（端到端）', () => {
  // 这是那个缺陷的正面证据。
  clockMs = 1_700_000_000_000
  const db = makeDb()
  insertTask(db, { id: 'held', hold: 1 })
  const store = createRunStore({ db, clock })

  // 路径 B（直接从看板入队）领不到
  const r1 = store.claim({ workerId: 'w1' })
  assert.equal(r1.claimed, null, '被将军拦下的任务被领走了')
  assert.equal(r1.reason, 'queue-empty')

  // 就算**手工**塞一条 Queued 尝试进去（模拟"先排了队，然后才被拦截"），
  // 路径 A 也必须领不走——这一条正是"漏掉任务级条件"时会失守的地方。
  insertTask(db, { id: 'held2', hold: 1 })
  const iso = new Date(clockMs).toISOString()
  db.prepare(
    `INSERT INTO run_attempts (id, task_id, scope, attempt_no, state, lease_epoch, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('a-held', 'held2', 'default', 1, 'Queued', 0, clockMs, clockMs)
  const r2 = store.claim({ workerId: 'w1' })
  assert.equal(r2.claimed, null,
    '有了一条排队尝试之后，被将军拦下的任务被领走了——「将军拦截优先于队列」失效')
  void iso
})

test('④ ★ 被标成 done 的任务同样两条路径都领不走', () => {
  clockMs = 1_700_000_000_000
  const db = makeDb()
  insertTask(db, { id: 't-done', status: 'done' })
  const store = createRunStore({ db, clock })
  assert.equal(store.claim({ workerId: 'w1' }).claimed, null)

  db.prepare(
    `INSERT INTO run_attempts (id, task_id, scope, attempt_no, state, lease_epoch, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('a-done', 't-done', 'default', 1, 'Queued', 0, clockMs, clockMs)
  assert.equal(store.claim({ workerId: 'w1' }).claimed, null)
})

test('④ ★ 正常任务仍然领得到（改动没有把整条路堵死）', () => {
  clockMs = 1_700_000_000_000
  const db = makeDb()
  insertTask(db, { id: 'ok' })
  const store = createRunStore({ db, clock })
  const r = store.claim({ workerId: 'w1' })
  assert.ok(r.claimed !== null, '正常任务领不到——资格条件被改坏了')
  assert.equal(r.claimed.taskId, 'ok')
  assert.equal(r.claimed.state, 'Leased')
})

test('④ 认领响应里带着 scope（缺了它 worker 只能拒绝一切或自己猜一个）', () => {
  clockMs = 1_700_000_000_000
  const db = makeDb()
  insertTask(db, { id: 'scoped', scope: 'acme' })
  const store = createRunStore({ db, clock })
  const r = store.claim({ workerId: 'w1', scope: 'acme' })
  assert.ok(r.claimed !== null)
  assert.equal(r.claimed.scope, 'acme')
})

test('④ ★ 分空间领取：另一个空间的任务领不走', () => {
  clockMs = 1_700_000_000_000
  const db = makeDb()
  insertTask(db, { id: 'other', scope: 'other-space' })
  const store = createRunStore({ db, clock })
  const r = store.claim({ workerId: 'w1', scope: 'default' })
  assert.equal(r.claimed, null, '跨空间领到了一条任务')
})

test('④ ★ 退避没到点时那条排队尝试领不走（端到端）', () => {
  clockMs = 1_700_000_000_000
  const db = makeDb()
  insertTask(db, { id: 'backoff' })
  db.prepare(
    `INSERT INTO run_attempts (id, task_id, scope, attempt_no, state, lease_epoch, created_at_ms, updated_at_ms, next_attempt_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('a-backoff', 'backoff', 'default', 1, 'Queued', 0, clockMs, clockMs, clockMs + 60_000)
  const store = createRunStore({ db, clock })
  assert.equal(store.claim({ workerId: 'w1' }).claimed, null, '退避没到点却领走了')

  // 时间推过去之后必须能领到（否则"闸门"变成了"永久堵死"）
  clockMs += 60_001
  const r = store.claim({ workerId: 'w1' })
  assert.ok(r.claimed !== null, '退避到点之后仍然领不到——闸门把路堵死了')
  assert.equal(r.claimed.attemptId, 'a-backoff')
})

test('④ ★ 只有最新那一次尝试会被领走（老的不该被重放）', () => {
  clockMs = 1_700_000_000_000
  const db = makeDb()
  insertTask(db, { id: 'multi' })
  const ins = db.prepare(
    `INSERT INTO run_attempts (id, task_id, scope, attempt_no, state, lease_epoch, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  ins.run('a-old', 'multi', 'default', 1, 'Queued', 0, clockMs, clockMs)
  ins.run('a-new', 'multi', 'default', 2, 'Queued', 0, clockMs + 1, clockMs + 1)
  const store = createRunStore({ db, clock })
  const r = store.claim({ workerId: 'w1' })
  assert.ok(r.claimed !== null)
  assert.equal(r.claimed.attemptId, 'a-new', '领走了一条被取代的旧尝试')
})

// ---------------------------------------------------------------- ⑤ 拒绝理由可读

test('⑤ 每一个拒绝码都是一句能读的话的键（不是缩写）', () => {
  for (const [k, v] of Object.entries(CLAIM_REJECTIONS)) {
    assert.equal(typeof v, 'string')
    assert.ok(v.startsWith('claim-'), `${k} = ${v} 的形态与其余不一致`)
  }
  assert.equal(new Set(Object.values(CLAIM_REJECTIONS)).size, Object.keys(CLAIM_REJECTIONS).length,
    '有两个拒绝码重名——分不清两件事')
})

test('⑤ 纯函数的返回对象都是冻结的', () => {
  assert.equal(Object.isFrozen(isTaskEligible({ status: 'todo', hold: 0 })), true)
  assert.equal(Object.isFrozen(isTaskEligible(null)), true)
  assert.equal(Object.isFrozen(isAttemptClaimable(null)), true)
  assert.equal(Object.isFrozen(explainClaim({ path: 'claimable-task', task: { status: 'todo', hold: 0 } })), true)
})
