// team-hub/preemption-exec.test.mjs
// ============================================================================
// F7 · 抢占的**执行面**（设计稿 §8.2 / M9 剩余）
//
// 判定层只回答"能不能抢"。真正让槽还得做四步，而且顺序不能乱：
//   ① 记台账（I-7.4 要按它数次数）
//   ② 在任务时间线写"被谁因何抢占"（I-7.2）
//   ③ 让任务回到 `todo`（**可被重新认领 = 可 resume**）
//   ④ 尽力通知持有者停手（`agent_commands.stop_run`）——通知失败不能让 ①②③ 回滚，
//      因为"任务已释放"是事实，"通知没发出去"是另一个问题。
//
// 判据：
//   ① 三步都做了：台账 + 说明 + 状态回 todo
//   ② 通知失败不回滚：状态仍是 todo，但回报里如实带 `notified:false`
//   ③ 任务不在 in_progress ⇒ 只记账，不改状态（不越权）
//   ④ 未知任务 ⇒ 明确报错
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { ensurePreemptionSchema, applyPreemption, PREEMPTION_ERRORS } from './preemption.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, scope TEXT NOT NULL DEFAULT 'default',
      status TEXT NOT NULL DEFAULT 'in_progress', soldier TEXT, claimedAt TEXT, version INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE task_input (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL,
      actor TEXT, actor_kind TEXT, body TEXT, meta TEXT DEFAULT '{}', channel TEXT,
      created_at TEXT NOT NULL, consumed_at TEXT, consumed_by TEXT, superseded INTEGER DEFAULT 0);
  `)
  ensurePreemptionSchema(db)
  db.prepare("INSERT INTO tasks (id, status, soldier, claimedAt) VALUES ('T-1','in_progress','soldier-coder','2026-11-03T00:00:00.000Z')").run()
  return db
}
/** 假的三件依赖：只要被调用就记录一次，便于断言"做了几步"。 */
function fakes({ failCommand = false } = {}) {
  const calls = { transition: [], command: [], input: [], audit: [] }
  return {
    calls,
    deps: {
      transitionTask(id, to, by) { calls.transition.push({ id, to, by }); return { ok: true } },
      commandFn(input) {
        if (failCommand) throw new Error('agent 通道不可用')
        calls.command.push(input)
        return { id: 'cmd-1' }
      },
      appendInput(db, spec) { calls.input.push(spec); return { input: { id: 'inp-1' } } },
      audit(...args) { calls.audit.push(args) },
    },
  }
}

test('① 三步都做：台账 + 说明 + 回到 todo', () => {
  const db = makeDb()
  const { deps, calls } = fakes()

  const out = applyPreemption(db, { taskId: 'T-1', by: 'general', reason: '线上故障', at: '2026-11-03T00:10:00.000Z' }, deps)

  assert.equal(out.applied, true)
  assert.equal(out.transitioned, true)
  assert.equal(db.prepare("SELECT COUNT(*) c FROM preemptions WHERE task_id='T-1'").get().c, 1, '台账')
  assert.equal(calls.input.length, 1, '★ 时间线要留下"被谁因何抢占"')
  assert.match(String(calls.input[0].body), /线上故障/)
  assert.deepEqual(calls.transition, [{ id: 'T-1', to: 'todo', by: 'general' }], '★ 回到 todo 才能被重新认领')
})

test('② 通知失败不回滚（任务已释放是事实，通知是另一件事）', () => {
  const db = makeDb()
  const { deps } = fakes({ failCommand: true })

  const out = applyPreemption(db, { taskId: 'T-1', by: 'general', reason: '急', at: '2026-11-03T00:10:00.000Z' }, deps)
  assert.equal(out.applied, true)
  assert.equal(out.notified, false, '★ 如实说"没通知到"，而不是假装成功')
  assert.equal(db.prepare("SELECT COUNT(*) c FROM preemptions WHERE task_id='T-1'").get().c, 1)
})

test('③ 任务不在 in_progress ⇒ 只记账，不改状态（不越权）', () => {
  const db = makeDb()
  db.prepare("UPDATE tasks SET status='in_review' WHERE id='T-1'").run()
  const { deps, calls } = fakes()

  const out = applyPreemption(db, { taskId: 'T-1', by: 'general', reason: '急', at: '2026-11-03T00:10:00.000Z' }, deps)
  assert.equal(out.applied, true)
  assert.equal(out.transitioned, false)
  assert.deepEqual(calls.transition, [], '★ 不动不该动的状态')
  assert.equal(db.prepare("SELECT status FROM tasks WHERE id='T-1'").get().status, 'in_review')
})

test('④ 未知任务 ⇒ 明确报错', () => {
  const db = makeDb()
  const { deps } = fakes()
  assert.throws(
    () => applyPreemption(db, { taskId: 'T-nope', by: 'general' }, deps),
    (e) => e.code === PREEMPTION_ERRORS.TASK_NOT_FOUND,
  )
})
