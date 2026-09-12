// team-hub/handoff-store.test.mjs
// ============================================================================
// 交接接入运行面（PRT-308，spec 第 333 行）的用例
//
// spec 对 `HandingOff` 的定义是「当前 Task 收口并**原子创建/释放下一岗位任务**」。
// 这一组问的就是那两件事：
//   ① 后继任务真的被建出来了吗（而不是"状态走到了 Completed"就算数）；
//   ② 收口与建任务是**一个事务**吗（崩在中间不会留下孤儿后继）。
// 以及交接特有的三个陷阱：链断、重放、环。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { createRunStore, ensureRunSchema, RUN_ERRORS } from './run-store.mjs'

/** 三岗位的链：analyst → coder → tester（tester 是链尾）。 */
const CHAIN = [
  { role: 'analyst', label: '分析', next: 'coder', enabled: true },
  { role: 'coder', label: '开发', next: 'tester', enabled: true },
  { role: 'tester', label: '测试', next: null, enabled: true },
]

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', description TEXT DEFAULT '',
      priority TEXT DEFAULT 'medium', status TEXT NOT NULL DEFAULT 'backlog',
      version INTEGER NOT NULL DEFAULT 1, soldier TEXT, scope TEXT DEFAULT 'default',
      hold INTEGER DEFAULT 0, role TEXT, parent TEXT, goalId TEXT,
      createdAt TEXT, updatedAt TEXT, acceptance TEXT DEFAULT '[]'
    )
  `)
  ensureRunSchema(db)
  return db
}

let clockMs = 1_700_000_000_000
const clock = () => clockMs

/**
 * 建库 + 建任务 + 推到 HandingOff，并注入交接所需的 createTask/readPipeline。
 *
 * `createTask` 是一个**记录调用的假实现**（真实现属于 server.mjs，要写 30 个列）。
 * 但它走的是同一条注入路径、同一个事务，因此"原子性"这件事是被真实验证的。
 */
function makeEnv({ stages = CHAIN, role = 'analyst', acceptance = JSON.stringify([{ kind: 'run-completed' }]) } = {}) {
  clockMs = 1_700_000_000_000
  const db = makeDb()
  const created = []
  let nextId = 1
  db.prepare('INSERT INTO tasks (id, title, description, status, scope, role, parent, goalId, hold, createdAt, updatedAt, acceptance) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('T-1', '【分析】做一件事', '目标描述', 'todo', 'default', role, null, 'G-1', 0,
      new Date(clockMs).toISOString(), new Date(clockMs).toISOString(), acceptance)

  const createTask = (payload) => {
    const id = `T-new-${nextId++}`
    // 真的插进去：这样"后继存在"这件事是可查的，而唯一索引也能真的生效
    db.prepare('INSERT INTO tasks (id, title, description, status, scope, role, parent, goalId, hold, createdAt, updatedAt, acceptance) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, payload.title, payload.description, payload.status, payload.scope, payload.role,
        payload.parent, payload.goalId, 0, new Date(clockMs).toISOString(), new Date(clockMs).toISOString(), '[]')
    created.push({ id, ...payload })
    return { id }
  }
  const readPipeline = (scope) => {
    if (scope !== 'default') throw new Error(`夹具没有这个 scope 的流水线：${scope}`)
    return stages
  }

  const store = createRunStore({ db, clock, createTask, readPipeline })
  const claimed = store.claim({ workerId: 'w1' })
  assert.ok(claimed.claimed !== null, '夹具应当能领到任务')
  const attemptId = claimed.claimed.attemptId
  const epoch = claimed.claimed.leaseEpoch
  for (const to of ['PreparingWorkspace', 'BuildingContext', 'Running']) {
    store.transition({ attemptId, leaseEpoch: epoch, workerId: 'w1', to })
  }
  store.transition({ attemptId, leaseEpoch: epoch, workerId: 'w1', outcome: 'completed' })
  return { db, store, attemptId, epoch, created, tasksIn: () => db.prepare('SELECT * FROM tasks ORDER BY id').all() }
}

/** 把一条尝试推到 HandingOff（验收通过 + hasNextPost=true）。 */
function toHandingOff(env) {
  const r = env.store.recordValidation({
    attemptId: env.attemptId, leaseEpoch: env.epoch, actor: 'w1',
    runResult: { outcome: 'completed' }, hasNextPost: true,
  })
  assert.equal(r.decision, 'accepted')
  assert.equal(env.store.getAttempt(env.attemptId).state, 'HandingOff')
  return r
}

test('① 交接真的把下一岗位的任务建出来了，并收口到 Completed', () => {
  const env = makeEnv()
  toHandingOff(env)
  const r = env.store.handoff({ attemptId: env.attemptId, leaseEpoch: env.epoch, actor: 'w1', prevSummary: '✓ 分析完了' })

  assert.equal(r.action, 'handed-off')
  assert.equal(r.successorRole, 'coder', '下一岗位必须是流水线里 analyst.next')
  const successor = env.tasksIn().find((t) => t.id === r.successorId)
  assert.ok(successor !== undefined, '后继任务必须真的在库里')
  assert.equal(successor.role, 'coder')
  assert.equal(successor.status, 'todo', '下一岗位要能被领走')
  assert.equal(successor.parent, 'T-1', 'parent 指向上一环，这是交接的幂等键')
  assert.equal(successor.goalId, 'G-1', 'goalId 必须继承：否则下一环不属于同一个目标')
  assert.match(successor.description, /\[前序阶段\] 分析（analyst）已完成：✓ 分析完了/)
  assert.match(successor.description, /\[本阶段\] 开发（coder）/)
  assert.equal(successor.title, '【开发】做一件事')

  assert.equal(env.store.getAttempt(env.attemptId).state, 'Completed', '本尝试必须收口')
  assert.equal(r.taskStatus, 'done')
  // 交接记录落库：它同时是 `HandingOff → Completed` 要的证据
  const hs = env.store.handoffsOf(env.attemptId)
  assert.equal(hs.length, 1)
  assert.equal(hs[0].successorId, r.successorId)
  assert.equal(hs[0].successorRole, 'coder')
  assert.equal(hs[0].actor, 'w1')
})

test('② 重放交接是正常路径：返回同一条后继，不会建第二条', () => {
  // worker 交接完就崩、重扫时重放同一次交接。若这里各建一条，
  // 下一岗位就会有两份任务，于是这一环被做两遍。
  const env = makeEnv()
  toHandingOff(env)
  const first = env.store.handoff({ attemptId: env.attemptId, leaseEpoch: env.epoch, actor: 'w1' })
  const replay = env.store.handoff({ attemptId: env.attemptId, leaseEpoch: env.epoch, actor: 'w1' })

  assert.equal(replay.action, 'already-handed-off')
  assert.equal(replay.successorId, first.successorId, '重放必须返回**同一条**后继')
  assert.equal(env.created.length, 1, `只能建一条后继，实际建了 ${env.created.length} 条`)
  assert.equal(env.store.handoffsOf(env.attemptId).length, 1)
})

test('② 数据库层面也挡重复：successor_id 上有唯一索引', () => {
  // 只在应用层查重时，两个并发进程会各查一次、各建一条。
  // 这条用例直接撞唯一索引，证明那道保险真的在。
  const env = makeEnv()
  toHandingOff(env)
  env.store.handoff({ attemptId: env.attemptId, leaseEpoch: env.epoch, actor: 'w1' })
  assert.throws(
    () => env.db.prepare('INSERT INTO run_handoffs (attempt_id, task_id, successor_id, successor_role, actor, at_ms) VALUES (?,?,?,?,?,?)')
      .run(env.attemptId, 'T-1', 'T-new-1', 'coder', 'w1', clockMs),
    (e) => /UNIQUE|constraint/i.test(String(e.message)),
    '同一条后继不得被交接两次')
})

test('③ 链断：下一岗位不存在 → 拒绝，**不**当链尾收口', () => {
  // next 拼错一个字母。数据上"链断"与"链尾"长得一模一样，
  // 而当成链尾会让任务链静默断在这里。
  const env = makeEnv({ stages: [
    { role: 'analyst', label: '分析', next: 'codeer', enabled: true },
    { role: 'coder', label: '开发', next: 'tester', enabled: true },
    { role: 'tester', label: '测试', next: null, enabled: true },
  ] })
  toHandingOff(env)
  assert.throws(
    () => env.store.handoff({ attemptId: env.attemptId, leaseEpoch: env.epoch, actor: 'w1' }),
    (e) => e.code === RUN_ERRORS.HANDOFF_REJECTED && /codeer/.test(e.message))
  assert.equal(env.store.getAttempt(env.attemptId).state, 'HandingOff', '被拒绝后不得收口')
  assert.equal(env.created.length, 0, '不得建出任何后继')
  assert.equal(env.store.handoffsOf(env.attemptId).length, 0)
})

test('③ 最后一环（链尾）不该走到 HandingOff；真走到了就必须报出这份不一致', () => {
  // 走到了 HandingOff 而流水线说这是链尾：两处判断不一致。
  // 自动收口成 Completed 会把这份不一致藏掉，而藏掉之后没人会去查
  // 到底是验收时判错了，还是流水线在这中间被改过。
  const env = makeEnv({ stages: [{ role: 'analyst', label: '分析', next: null, enabled: true }] })
  toHandingOff(env)
  assert.throws(
    () => env.store.handoff({ attemptId: env.attemptId, leaseEpoch: env.epoch, actor: 'w1' }),
    (e) => e.code === RUN_ERRORS.HANDOFF_REJECTED && /链尾/.test(e.message))
  assert.equal(env.store.getAttempt(env.attemptId).state, 'HandingOff')
})

test('③ 任务没记岗位 → 拒绝（不默认成链尾）', () => {
  const env = makeEnv({ role: null })
  toHandingOff(env)
  assert.throws(
    () => env.store.handoff({ attemptId: env.attemptId, leaseEpoch: env.epoch, actor: 'w1' }),
    (e) => e.code === RUN_ERRORS.HANDOFF_REJECTED && /不默认成链尾/.test(e.message))
})

test('④ 只有 HandingOff 上的尝试能交接', () => {
  const env = makeEnv()
  // 还在 Running 上就交接 = 跳过"验收通过"这一步
  const env2 = makeEnv()
  assert.equal(env2.store.getAttempt(env2.attemptId).state, 'Validating')
  assert.throws(
    () => env2.store.handoff({ attemptId: env2.attemptId, leaseEpoch: env2.epoch, actor: 'w1' }),
    (e) => e.code === RUN_ERRORS.NOT_HANDING_OFF)
  assert.equal(env2.created.length, 0)
})

test('④ 过期 epoch 不得交接；缺 actor 不得交接', () => {
  const env = makeEnv()
  toHandingOff(env)
  assert.throws(
    () => env.store.handoff({ attemptId: env.attemptId, leaseEpoch: 99, actor: 'w1' }),
    (e) => e.code === RUN_ERRORS.LEASE_EPOCH_STALE && e.currentEpoch === env.epoch)
  for (const bad of [undefined, null, '', 42]) {
    assert.throws(() => env.store.handoff({ attemptId: env.attemptId, leaseEpoch: env.epoch, actor: bad }),
      (e) => e.code === RUN_ERRORS.WORKER_REQUIRED, `actor=${JSON.stringify(bad)} 必须被拒绝`)
  }
  assert.equal(env.created.length, 0, '被拒绝时不得建出后继')
})

test('⑤ 没接线时拒绝（`HANDOFF_NOT_WIRED`），而**不是**降级成"没有下一岗位"', () => {
  // 降级会让交接在静默中变成收口：任务链断在第一环，而库里看起来一切正常。
  const db = makeDb()
  db.prepare('INSERT INTO tasks (id, title, status, scope, role, hold, createdAt, updatedAt, acceptance) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('T-1', 't', 'todo', 'default', 'analyst', 0, new Date(clockMs).toISOString(), new Date(clockMs).toISOString(), '[]')
  const store = createRunStore({ db, clock }) // 不注入 createTask / readPipeline
  const claimed = store.claim({ workerId: 'w1' })
  const attemptId = claimed.claimed.attemptId
  const epoch = claimed.claimed.leaseEpoch
  for (const to of ['PreparingWorkspace', 'BuildingContext', 'Running']) {
    store.transition({ attemptId, leaseEpoch: epoch, workerId: 'w1', to })
  }
  store.transition({ attemptId, leaseEpoch: epoch, workerId: 'w1', outcome: 'completed' })
  store.recordValidation({ attemptId, leaseEpoch: epoch, actor: 'w1', runResult: { outcome: 'completed' }, hasNextPost: true })
  assert.throws(
    () => store.handoff({ attemptId, leaseEpoch: epoch, actor: 'w1' }),
    (e) => e.code === RUN_ERRORS.HANDOFF_NOT_WIRED && e.statusCode === 500)
})

test('⑥ createTask 没返回 id → 拒绝，且不记交接记录', () => {
  // 没有 id 就没有后继可指，而记一条空的交接等于把"下一岗位已建好"写成事实。
  const env = makeEnv()
  toHandingOff(env)
  const broken = createRunStore({
    db: env.db, clock,
    createTask: () => ({}),                 // 忘了返回 id
    readPipeline: () => CHAIN,
  })
  assert.throws(
    () => broken.handoff({ attemptId: env.attemptId, leaseEpoch: env.epoch, actor: 'w1' }),
    (e) => e.code === RUN_ERRORS.HANDOFF_REJECTED && /没有返回后继任务 id/.test(e.message))
  assert.equal(env.store.handoffsOf(env.attemptId).length, 0)
  assert.equal(env.store.getAttempt(env.attemptId).state, 'HandingOff', '不得收口')
})

test('⑥ 建任务抛错时整笔回滚：不留交接记录，状态不动（原子性）', () => {
  // 这是"原子创建/释放"那句话的可验证形态：建任务失败了，
  // 不能留下一条"交接发生过"的记录，也不能把本尝试收口。
  const env = makeEnv()
  toHandingOff(env)
  let calls = 0
  const failing = createRunStore({
    db: env.db, clock,
    createTask: () => { calls += 1; throw new Error('模拟建任务失败') },
    readPipeline: () => CHAIN,
  })
  assert.throws(() => failing.handoff({ attemptId: env.attemptId, leaseEpoch: env.epoch, actor: 'w1' }), /模拟建任务失败/)
  assert.equal(calls, 1)
  assert.equal(env.store.handoffsOf(env.attemptId).length, 0, '失败时不得留下交接记录')
  assert.equal(env.store.getAttempt(env.attemptId).state, 'HandingOff', '失败时不得收口')
  assert.equal(env.tasksIn().length, 1, '不得留下孤儿后继任务')
})

test('⑥ 唯一索引挡住重复时，**连刚建出来的后继任务也一起回滚**（原子性的可验证形态）', () => {
  // 这一条同时验两件事：
  //   ① `successor_id` 的唯一索引在事务内真的会挡；
  //   ② 它挡住时，先前 `createTask` 插进去的那条任务**也被回滚**——
  //      否则库里会留下一条没人认领的孤儿任务（本尝试没交接，任务却存在）。
  // 造法：让 createTask 返回一个**已经被交接过的** id。
  const env = makeEnv()
  toHandingOff(env)
  const first = env.store.handoff({ attemptId: env.attemptId, leaseEpoch: env.epoch, actor: 'w1' })
  // 第一次交接建出来的后继也是 todo，会被下面的 claim 抢先领走。
  // 把它收掉，让队列里只剩 T-2——否则这条用例问的东西就换了。
  env.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(first.successorId)

  // 另造一条任务/尝试，让它的 createTask 返回上面那条已被占用的后继 id
  env.db.prepare('INSERT INTO tasks (id, title, description, status, scope, role, hold, createdAt, updatedAt, acceptance) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('T-2', '【分析】第二件事', 'd', 'todo', 'default', 'analyst', 0,
      new Date(clockMs).toISOString(), new Date(clockMs).toISOString(), JSON.stringify([{ kind: 'run-completed' }]))
  const claimed2 = env.store.claim({ workerId: 'w1' })
  assert.equal(claimed2.claimed.taskId, 'T-2')
  const a2 = claimed2.claimed.attemptId
  const e2 = claimed2.claimed.leaseEpoch
  for (const to of ['PreparingWorkspace', 'BuildingContext', 'Running']) {
    env.store.transition({ attemptId: a2, leaseEpoch: e2, workerId: 'w1', to })
  }
  env.store.transition({ attemptId: a2, leaseEpoch: e2, workerId: 'w1', outcome: 'completed' })
  env.store.recordValidation({ attemptId: a2, leaseEpoch: e2, actor: 'w1', runResult: { outcome: 'completed' }, hasNextPost: true })

  const before = env.tasksIn().length
  let orphanId = null
  const colliding = createRunStore({
    db: env.db, clock,
    createTask: (payload) => {
      // 建一条真任务（会插进库），但返回**已被占用**的 id
      orphanId = 'T-orphan'
      env.db.prepare('INSERT INTO tasks (id, title, description, status, scope, role, parent, hold, createdAt, updatedAt, acceptance) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(orphanId, payload.title, payload.description, payload.status, payload.scope, payload.role,
          payload.parent, 0, new Date(clockMs).toISOString(), new Date(clockMs).toISOString(), '[]')
      return { id: first.successorId }
    },
    readPipeline: () => CHAIN,
  })
  assert.throws(
    () => colliding.handoff({ attemptId: a2, leaseEpoch: e2, actor: 'w1' }),
    (e) => /UNIQUE|constraint/i.test(String(e.message)),
    '唯一索引必须挡住"同一条后继被交接两次"')

  assert.equal(env.tasksIn().length, before, '刚建出来的孤儿任务必须一起回滚')
  assert.equal(env.tasksIn().find((t) => t.id === orphanId), undefined, '孤儿任务不得留在库里')
  assert.equal(env.store.getAttempt(a2).state, 'HandingOff', '第二条尝试不得收口')
  assert.equal(env.store.handoffsOf(a2).length, 0, '第二条尝试不得留下交接记录')
})
