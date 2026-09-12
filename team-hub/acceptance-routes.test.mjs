// team-hub/acceptance-routes.test.mjs
// ============================================================================
// 机器验收的 HTTP 契约（PRT-307）
//
// 上一组（`acceptance-store.test.mjs`）验的是仓储行为；这一组验的是
// **从 HTTP 进来的那条路**：判据从任务契约读、错误码与状态码能区分
// 「调用方传错」与「数据坏了」、以及验收记录能被读回来。
//
// 单独一个进程（自己的库与端口）：这一组要往库里的 `tasks.acceptance` 写各种
// 形态的值（合法 JSON、坏 JSON、非数组），而 run-routes 那套共用一个库、
// 靠"把别的任务标成 done"来控制队列——混在一起会让两边的夹具互相干扰。
// ============================================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-acceptroutes-'))
let mod
let base = ''

before(async () => {
  process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_TOKEN = ''
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close() } catch { /* 已关闭 */ }
  try { mod?.db?.close() } catch { /* 已关闭 */ }
  rmSync(tmpRoot, { recursive: true, force: true })
})

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, body: parsed }
}

/** 建一条任务（可选带验收判据），并保证此刻队列里只有它。 */
function onlyTask(id, { acceptance = '[]' } = {}) {
  mod.db.prepare("UPDATE tasks SET status = 'done' WHERE status IN ('todo','backlog')").run()
  mod.db.prepare(
    'INSERT OR REPLACE INTO tasks (id, title, priority, status, scope, hold, createdAt, updatedAt, acceptance) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run(id, id, 'medium', 'todo', 'default', 0, new Date().toISOString(), new Date().toISOString(), acceptance)
  return id
}

/** 领一条任务并把它推到 Validating（执行成功的落点）。 */
async function toValidating(id) {
  const claimed = await call('POST', '/api/runtime/claim', { workerId: 'w1' })
  assert.equal(claimed.body.claimed?.taskId, id, `应当领到 ${id}，实际 ${JSON.stringify(claimed.body.claimed)}`)
  const { attemptId, leaseEpoch } = claimed.body.claimed
  for (const to of ['PreparingWorkspace', 'BuildingContext', 'Running']) {
    const r = await call('POST', '/api/runtime/transition', { attemptId, leaseEpoch, workerId: 'w1', to })
    assert.equal(r.body.ok, true, `推进到 ${to} 失败：${JSON.stringify(r.body)}`)
  }
  const done = await call('POST', '/api/runtime/transition', { attemptId, leaseEpoch, workerId: 'w1', outcome: 'completed', detail: 'exec-ok' })
  assert.equal(done.body.attempt.state, 'Validating', '执行成功必须落在 Validating（机器验收是一道独立关卡）')
  return { attemptId, leaseEpoch }
}

test('① POST /api/runtime/validate：判据从任务契约读，通过后收口到 Completed', async () => {
  const id = onlyTask('acc-1', { acceptance: JSON.stringify([{ kind: 'run-completed' }]) })
  const { attemptId, leaseEpoch } = await toValidating(id)

  const r = await call('POST', '/api/runtime/validate', {
    attemptId, leaseEpoch, actor: 'w1',
    runResult: { outcome: 'completed', detail: 'exec-ok' },
    hasNextPost: false,
  })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.decision, 'accepted')
  assert.equal(r.body.attempt.state, 'Completed')
  assert.equal(r.body.taskStatus, 'done')

  // 结论与**当时用的判据**都要能读回来
  const read = await call('GET', `/api/runtime/validations?attemptId=${encodeURIComponent(attemptId)}`)
  assert.equal(read.status, 200)
  assert.equal(read.body.validations.length, 1)
  assert.equal(read.body.validations[0].decision, 'accepted')
  assert.deepEqual(read.body.validations[0].criteria, [{ kind: 'run-completed' }])
})

test('② 任务契约里是散文判据（stage-standards 的真实形态）→ needs-human，任务显示 in_review', async () => {
  const id = onlyTask('acc-2', { acceptance: JSON.stringify(['产出与本阶段职责一致', '每条结论可验证，不得虚构']) })
  const { attemptId, leaseEpoch } = await toValidating(id)

  const r = await call('POST', '/api/runtime/validate', {
    attemptId, leaseEpoch, actor: 'w1', runResult: { outcome: 'completed' }, hasNextPost: false,
  })
  assert.equal(r.body.decision, 'needs-human')
  assert.equal(r.body.attempt.state, 'AwaitingApproval')
  assert.equal(r.body.attempt.returnTo, 'Validating', '批准后必须回到验收，而不是重跑执行')
  // 看板上必须显示"待审"而不是"进行中"：一条等着交付审批的任务若显示为 in_progress，
  // 审批人会以为活还在干，于是它既不在待办里也没人在跑。
  assert.equal(r.body.taskStatus, 'in_review')
})

test('③ 没有验收记录就进 Completed 被拒（409 EVIDENCE_MISSING）', async () => {
  const id = onlyTask('acc-3', { acceptance: JSON.stringify([{ kind: 'run-completed' }]) })
  const { attemptId, leaseEpoch } = await toValidating(id)

  const r = await call('POST', '/api/runtime/transition', {
    attemptId, leaseEpoch, workerId: 'w1', to: 'Completed', context: { hasNextPost: false },
  })
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.equal(r.body.code, 'EVIDENCE_MISSING')
  // 错误信息要能让人知道缺的是哪一项，而不是只给一个码
  assert.match(r.body.error, /validation/)

  const st = await call('GET', `/api/runtime/attempt?attemptId=${encodeURIComponent(attemptId)}`)
  assert.equal(st.body.attempt.state, 'Validating', '被拒绝后状态必须原地不动')
})

test('④ 打回：判据不满足 → 新建尝试 + 任务回 todo；额度耗尽 → DeadLetter + blocked', async () => {
  const id = onlyTask('acc-4', { acceptance: JSON.stringify([{ kind: 'artifact', path: 'report.md' }]) })
  const { attemptId, leaseEpoch } = await toValidating(id)

  const r = await call('POST', '/api/runtime/validate', {
    attemptId, leaseEpoch, actor: 'w1',
    runResult: { outcome: 'completed', artifacts: [] }, hasNextPost: false,
  })
  assert.equal(r.body.decision, 'rejected')
  assert.equal(r.body.settlement.action, 'retry-new-attempt')
  assert.equal(r.body.taskStatus, 'todo')

  const hist = await call('GET', `/api/runtime/attempt?taskId=${id}`)
  assert.equal(hist.body.history.length, 2, '打回必须新建一次尝试')
  assert.equal(hist.body.history[0].failureCode, 'acceptance-rejected')
})

test('⑤ 判据不是 JSON / 不是数组 → 500 BAD_ACCEPTANCE_CRITERIA（数据问题，不是调用方传错）', async () => {
  for (const [id, acceptance] of [['acc-5a', '这是坏数据'], ['acc-5b', '{"not":"array"}']]) {
    onlyTask(id, { acceptance })
    const { attemptId, leaseEpoch } = await toValidating(id)
    const r = await call('POST', '/api/runtime/validate', {
      attemptId, leaseEpoch, actor: 'w1', runResult: { outcome: 'completed' }, hasNextPost: false,
    })
    // 500 而不是 400：请求完全合法，坏的是库里那一行。
    // 混成 400 会让运维去查调用方，而真正要修的是数据。
    assert.equal(r.status, 500, `${acceptance} → ${JSON.stringify(r.body)}`)
    assert.equal(r.body.code, 'BAD_ACCEPTANCE_CRITERIA')
    const st = await call('GET', `/api/runtime/attempt?attemptId=${encodeURIComponent(attemptId)}`)
    assert.equal(st.body.attempt.state, 'Validating', '报错时状态不得推进')
  }
})

test('⑥ 缺 hasNextPost → 400，且不留验收记录（整笔回滚）', async () => {
  const id = onlyTask('acc-6', { acceptance: JSON.stringify([{ kind: 'run-completed' }]) })
  const { attemptId, leaseEpoch } = await toValidating(id)

  const r = await call('POST', '/api/runtime/validate', {
    attemptId, leaseEpoch, actor: 'w1', runResult: { outcome: 'completed' },
  })
  assert.equal(r.status, 400, JSON.stringify(r.body))
  assert.equal(r.body.code, 'MISSING_GUARD_INPUT')

  const read = await call('GET', `/api/runtime/validations?attemptId=${encodeURIComponent(attemptId)}`)
  assert.equal(read.body.validations.length, 0,
    '整笔回滚：留一条没有对应状态迁移的记录，会让下一次调用以为已经验收过了')
  const st = await call('GET', `/api/runtime/attempt?attemptId=${encodeURIComponent(attemptId)}`)
  assert.equal(st.body.attempt.state, 'Validating')
})

test('⑥ runResult 形状不对 → 400，不得变成一条 rejected', async () => {
  const id = onlyTask('acc-7', { acceptance: JSON.stringify([{ kind: 'run-completed' }]) })
  const { attemptId, leaseEpoch } = await toValidating(id)

  const r = await call('POST', '/api/runtime/validate', { attemptId, leaseEpoch, actor: 'w1', runResult: null, hasNextPost: false })
  assert.equal(r.status, 400)
  assert.equal(r.body.code, 'RUN_RESULT_INVALID')
  const read = await call('GET', `/api/runtime/validations?attemptId=${encodeURIComponent(attemptId)}`)
  assert.equal(read.body.validations.length, 0)
})

test('⑥ 缺 actor / 缺 attemptId → 400；过期 epoch → 409 并带真实 epoch', async () => {
  const id = onlyTask('acc-8', { acceptance: JSON.stringify([{ kind: 'run-completed' }]) })
  const { attemptId, leaseEpoch } = await toValidating(id)

  const noActor = await call('POST', '/api/runtime/validate', { attemptId, leaseEpoch, runResult: { outcome: 'completed' }, hasNextPost: false })
  assert.equal(noActor.status, 400)
  const noAttempt = await call('POST', '/api/runtime/validate', { actor: 'w1', runResult: { outcome: 'completed' }, hasNextPost: false })
  assert.equal(noAttempt.status, 400)

  const stale = await call('POST', '/api/runtime/validate', {
    attemptId, leaseEpoch: leaseEpoch + 99, actor: 'w1', runResult: { outcome: 'completed' }, hasNextPost: false,
  })
  assert.equal(stale.status, 409, JSON.stringify(stale.body))
  assert.equal(stale.body.code, 'LEASE_EPOCH_STALE')
  // 必须告诉它**真实**的 epoch：只说"拒绝"会让过期 worker 无限重试
  assert.equal(stale.body.currentEpoch, leaseEpoch)
})

test('⑥ GET /api/runtime/validations 缺 attemptId → 400', async () => {
  const r = await call('GET', '/api/runtime/validations')
  assert.equal(r.status, 400)
  assert.equal(r.body.code, 'MISSING_PARAM')
})

test('⑦ 人工复审可显式覆盖判据（覆盖后按覆盖的判，且落库的是覆盖后的那份）', async () => {
  const id = onlyTask('acc-9', { acceptance: JSON.stringify(['产出与本阶段职责一致']) })
  const { attemptId, leaseEpoch } = await toValidating(id)

  const r = await call('POST', '/api/runtime/validate', {
    attemptId, leaseEpoch, actor: 'reviewer:alice',
    runResult: { outcome: 'completed', result: { summary: 'x' } },
    criteria: [{ kind: 'structured-result', required: ['summary'] }],
    hasNextPost: false,
  })
  assert.equal(r.body.decision, 'accepted')
  assert.equal(r.body.taskStatus, 'done')
  const read = await call('GET', `/api/runtime/validations?attemptId=${encodeURIComponent(attemptId)}`)
  assert.deepEqual(read.body.validations[0].criteria, [{ kind: 'structured-result', required: ['summary'] }],
    '"当时按什么验的"必须能读回来——覆盖过判据时尤其重要')
  assert.equal(read.body.validations[0].actor, 'reviewer:alice')
})
