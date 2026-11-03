// team-hub/regression-store.test.mjs
// ============================================================================
// F9 · 错误归纳机械化（设计稿 §8.4 / M7）
//
// 失败不该只留在 `docs/bugs/` 的手写记录里。这里把「失败事件 → 聚类 → 回归用例草稿」
// 做成机械流程，但**只有人能把它晋升成 active**——
// 自动晋升的回归集会迅速长出一堆"永远红"的用例，然后所有人学会忽略它。
//
// 判据：
//   ① 聚类键稳定（I-9.2）：同一失败重复出现不会被拆成两个簇
//   ② 失败来源：decisions 的 stop/unavailable + audit 的 rework
//   ③ 簇按出现次数排序，带样本任务与建议命令
//   ④ 只能生成 draft；active 必须由人晋升（I-9.1），agent 晋升被拒
//   ⑤ 同一簇重复生成不产生第二份草稿（幂等）
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { ensureDecisionSchema, recordDecision } from './decisions.mjs'
import {
  ensureRegressionSchema,
  clusterKeyOf,
  collectFailures,
  clusterFailures,
  draftCaseFor,
  saveDraft,
  promoteCase,
  listCases,
  planRun,
  REGRESSION_ERRORS,
  CASE_STATES,
} from './regression-store.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, scope TEXT DEFAULT 'default', status TEXT, role TEXT, updatedAt TEXT);
    CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, member TEXT, scope TEXT,
      action TEXT, taskId TEXT, detail TEXT);
  `)
  ensureDecisionSchema(db)
  ensureRegressionSchema(db)
  return db
}

test('① 聚类键稳定：同一失败不会被拆成两个簇', () => {
  const a = clusterKeyOf({ stage: 'coder', rule: 'R-2', pathPrefix: 'team-hub/routes/' })
  const b = clusterKeyOf({ stage: 'coder', rule: 'R-2', pathPrefix: 'team-hub/routes/' })
  const c = clusterKeyOf({ stage: 'coder', rule: 'R-2', pathPrefix: 'team-hub/scripts/' })
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.equal(a, 'coder:R-2:team-hub/routes/')
  assert.equal(clusterKeyOf({}), 'unknown:unknown:')
})

test('② 失败来源：decisions(stop/unavailable) + audit(rework)', () => {
  const db = makeDb()
  db.prepare("INSERT INTO tasks (id, status, role) VALUES ('T-1','blocked','coder')").run()
  recordDecision(db, { subject: 'task:T-1', kind: 'stop', by: 'general', at: '2026-11-03T01:00:00.000Z', matchedRuleIds: ['R-2'], reason: '越域' })
  recordDecision(db, { subject: 'task:T-1', kind: 'unavailable', by: 'general', at: '2026-11-03T01:05:00.000Z', matchedRuleIds: [], reason: '上游没就绪' })
  recordDecision(db, { subject: 'task:T-1', kind: 'accept', by: 'general', at: '2026-11-03T01:10:00.000Z', matchedRuleIds: ['R-2'] })
  db.prepare("INSERT INTO audit (ts, member, scope, action, taskId, detail) VALUES (?,?,?,?,?,?)")
    .run('2026-11-03T02:00:00.000Z', 'general', 'default', 'rework', 'T-1', JSON.stringify({ reason: '测试红了', stage: 'coder' }))

  const failures = collectFailures(db, { since: null })
  const kinds = failures.map((f) => f.kind).sort()
  assert.deepEqual(kinds, ['rework', 'stop', 'unavailable'], '★ accept 不算失败')
})

test('③ 聚类：按次数排序，带样本与建议命令', () => {
  const db = makeDb()
  for (const id of ['T-1', 'T-2', 'T-3']) {
    db.prepare('INSERT INTO tasks (id, status, role) VALUES (?,?,?)').run(id, 'blocked', 'coder')
    recordDecision(db, { subject: `task:${id}`, kind: 'stop', by: 'general', at: '2026-11-03T01:00:00.000Z', matchedRuleIds: ['R-2'], reason: '越域 team-hub/routes/' })
  }
  db.prepare("INSERT INTO tasks (id, status, role) VALUES ('T-9','blocked','tester')").run()
  recordDecision(db, { subject: 'task:T-9', kind: 'unavailable', by: 'general', at: '2026-11-03T01:00:00.000Z', matchedRuleIds: [], reason: '上游没就绪' })

  const clusters = clusterFailures(db, { since: null })
  assert.equal(clusters.length, 2)
  assert.equal(clusters[0].count, 3, '★ 最多的簇排第一')
  assert.equal(clusters[0].samples.length, 3)
  assert.ok(clusters[0].clusterKey.startsWith('coder:'), 'stage 来自任务角色')

  const draft = draftCaseFor(clusters[0], { at: '2026-11-03T03:00:00.000Z' })
  assert.equal(draft.state, 'draft', '★ 只能生成草稿（I-9.1）')
  assert.ok(draft.command.length > 0, '草稿必须有可执行命令')
  assert.ok(draft.expect.length > 0, '草稿必须有可机器判定的期望')
  assert.ok(draft.source_task, '要指回来源任务')
})

test('④ 晋升必须由人（I-9.1）：agent 被拒，人通过', () => {
  const db = makeDb()
  const draft = saveDraft(db, draftCaseFor({ clusterKey: 'coder:R-2:team-hub/', count: 1, samples: ['T-1'], reason: '越域' }, { at: '2026-11-03T03:00:00.000Z' }))

  assert.deepEqual([...CASE_STATES], ['draft', 'active', 'retired'])
  assert.throws(() => promoteCase(db, { id: draft.id, by: 'agent:coder' }), (e) => e.code === REGRESSION_ERRORS.HUMAN_REQUIRED)
  const promoted = promoteCase(db, { id: draft.id, by: 'general', at: '2026-11-03T04:00:00.000Z' })
  assert.equal(promoted.state, 'active')
  assert.equal(promoted.promoted_by, 'general')
  assert.deepEqual(listCases(db, { state: 'active' }).map((c) => c.id), [draft.id])
})

test('⑤ 同一簇重复生成不产生第二份草稿（幂等）', () => {
  const db = makeDb()
  const cluster = { clusterKey: 'coder:R-2:team-hub/', count: 2, samples: ['T-1', 'T-2'], reason: '越域' }
  const first = saveDraft(db, draftCaseFor(cluster, { at: '2026-11-03T03:00:00.000Z' }))
  const second = saveDraft(db, draftCaseFor(cluster, { at: '2026-11-03T05:00:00.000Z' }))

  assert.equal(second.id, first.id, '★ 同簇同 id')
  assert.equal(listCases(db).length, 1)
})

test('⑥ CI 计划只取 active，没有命令的如实跳过（I-9.1）', () => {
  const db = makeDb()
  const draft = saveDraft(db, draftCaseFor({ clusterKey: 'coder:R-2:a/', count: 1, samples: ['T-1'], reason: 'x' }, { at: '2026-11-03T03:00:00.000Z' }))
  const active = saveDraft(db, draftCaseFor({ clusterKey: 'coder:R-3:b/', count: 1, samples: ['T-2'], reason: 'y' }, { at: '2026-11-03T04:00:00.000Z' }))
  promoteCase(db, { id: active.id, by: 'general' })
  // 一条没有命令的 active 用例：如实跳过，而不是静默消失
  db.prepare(`INSERT INTO regression_cases (id, cluster_key, kind, command, expect, state, created_at)
    VALUES ('rc-nocmd','coder:R-4:c/','unit','','期望', 'active','2026-11-03T06:00:00.000Z')`).run()

  const plan = planRun(db)
  assert.deepEqual(plan.planned.map((p) => p.id), [active.id], '★ 草稿不进 CI')
  assert.equal(plan.planned[0].command.length > 0, true)
  assert.deepEqual(plan.skipped.map((s) => s.id), ['rc-nocmd'])
  assert.ok(!plan.planned.some((p) => p.id === draft.id))
})
