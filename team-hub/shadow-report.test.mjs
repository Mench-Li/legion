// team-hub/shadow-report.test.mjs
// ============================================================================
// F10 · 规则候选影子验证（设计稿 §8.5 / M11，E2）
//
// 改规则之前，先问一句：**这条新规则要是早就在，历史决策会怎么变？**
// 影子跑必须严守两条：
//   I-10.1 不得产生真实任务、不得写 tasks
//   I-10.2 差异率超过阈值 ⇒ 标记"需人工评审"，**禁止**自动晋升
//
// 判据：
//   ① 不受影响的决策计入 same
//   ② always 候选会把"缺依据被拒"翻转成 accept
//   ③ never 候选会把"已受理"翻转成 stop
//   ④ 翻转率超阈值 ⇒ needsReview=true
//   ⑤ 时间窗生效
//   ⑥ 只读：跑完 decisions / tasks 一行不变（I-10.1）
//   ⑦ 候选规则不存在 ⇒ 明确报错，而不是给一份"零差异"的报告
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { ensureDecisionSchema, recordDecision } from './decisions.mjs'
import { ensureShadowSchema, shadowReport, SHADOW_ERRORS } from './shadow-report.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, scope TEXT DEFAULT 'default', status TEXT DEFAULT 'todo', updatedAt TEXT);
    CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, member TEXT, scope TEXT,
      action TEXT, taskId TEXT, detail TEXT);
  `)
  ensureDecisionSchema(db)
  ensureShadowSchema(db)
  return db
}

const rule = (db, id, kind, extra = {}) => {
  db.prepare('INSERT OR REPLACE INTO policy_rules (id, kind, text, scope, enabled, rule_ref) VALUES (?,?,?,?,?,?)')
    .run(id, kind, extra.text ?? '候选规则', extra.scope ?? null, extra.enabled ?? 1, null)
}

test('① 不受影响的决策计入 same', () => {
  const db = makeDb()
  rule(db, 'R-9', 'when')
  recordDecision(db, { subject: 'task:T-1', kind: 'accept', by: 'general', at: '2026-11-03T00:00:00.000Z', matchedRuleIds: ['R-2'] })
  recordDecision(db, { subject: 'task:T-2', kind: 'ignore', by: 'general', at: '2026-11-03T00:01:00.000Z', matchedRuleIds: [], wouldAccept: true, reason: '容量满' })

  const report = shadowReport(db, { candidateRuleId: 'R-9' })
  assert.equal(report.n, 2)
  assert.equal(report.same, 2)
  assert.equal(report.flipToAccept, 0)
  assert.equal(report.flipToIgnore, 0)
})

test('② always 候选：把"缺依据被拒"翻成 accept', () => {
  const db = makeDb()
  rule(db, 'R-7', 'always')
  recordDecision(db, {
    subject: 'task:T-1', kind: 'stop', by: 'general', at: '2026-11-03T00:00:00.000Z',
    matchedRuleIds: [], reason: 'MISSING_BASIS: 没有受理依据',
  })

  const report = shadowReport(db, { candidateRuleId: 'R-7' })
  assert.equal(report.flipToAccept, 1)
  assert.equal(report.flips[0].subject, 'task:T-1')
  assert.equal(report.flips[0].current, 'stop')
  assert.equal(report.flips[0].candidate, 'accept')
  assert.match(String(report.flips[0].why), /R-7/)
})

test('③ never 候选：把"已受理"翻成 stop', () => {
  const db = makeDb()
  rule(db, 'R-8', 'never')
  recordDecision(db, { subject: 'task:T-1', kind: 'accept', by: 'general', at: '2026-11-03T00:00:00.000Z', matchedRuleIds: ['R-2'] })

  const report = shadowReport(db, { candidateRuleId: 'R-8' })
  assert.equal(report.flipToIgnore, 1, '★ accept → stop 记为 flipToIgnore（收紧方向）')
  assert.equal(report.flips[0].candidate, 'stop')
})

test('④ 翻转率超阈值 ⇒ needsReview（I-10.2）', () => {
  const db = makeDb()
  rule(db, 'R-7', 'always')
  for (const id of ['T-1', 'T-2', 'T-3']) {
    recordDecision(db, {
      subject: `task:${id}`, kind: 'stop', by: 'general', at: '2026-11-03T00:00:00.000Z',
      matchedRuleIds: [], reason: 'MISSING_BASIS',
    })
  }
  recordDecision(db, { subject: 'task:T-4', kind: 'accept', by: 'general', at: '2026-11-03T00:00:00.000Z', matchedRuleIds: ['R-2'] })

  const report = shadowReport(db, { candidateRuleId: 'R-7', threshold: 0.2 })
  assert.equal(report.n, 4)
  assert.equal(report.flipToAccept, 3)
  assert.equal(report.flipRate, 0.75)
  assert.equal(report.needsReview, true, '★ 差异太大时必须标记人工评审')
})

test('⑤ 时间窗生效', () => {
  const db = makeDb()
  rule(db, 'R-7', 'always')
  recordDecision(db, { subject: 'task:old', kind: 'stop', by: 'general', at: '2026-10-01T00:00:00.000Z', matchedRuleIds: [], reason: 'MISSING_BASIS' })
  recordDecision(db, { subject: 'task:new', kind: 'stop', by: 'general', at: '2026-11-03T00:00:00.000Z', matchedRuleIds: [], reason: 'MISSING_BASIS' })

  assert.equal(shadowReport(db, { candidateRuleId: 'R-7', from: '2026-11-01T00:00:00.000Z' }).n, 1)
  assert.equal(shadowReport(db, { candidateRuleId: 'R-7' }).n, 2)
})

test('⑥ 只读：不写 decisions、不建任务（I-10.1）', () => {
  const db = makeDb()
  rule(db, 'R-7', 'always')
  recordDecision(db, { subject: 'task:T-1', kind: 'stop', by: 'general', at: '2026-11-03T00:00:00.000Z', matchedRuleIds: [], reason: 'MISSING_BASIS' })
  const before = {
    decisions: db.prepare('SELECT COUNT(*) c FROM decisions').get().c,
    tasks: db.prepare('SELECT COUNT(*) c FROM tasks').get().c,
    audit: db.prepare('SELECT COUNT(*) c FROM audit').get().c,
  }
  shadowReport(db, { candidateRuleId: 'R-7' })
  const after = {
    decisions: db.prepare('SELECT COUNT(*) c FROM decisions').get().c,
    tasks: db.prepare('SELECT COUNT(*) c FROM tasks').get().c,
    audit: db.prepare('SELECT COUNT(*) c FROM audit').get().c,
  }
  assert.deepEqual(after, before, '★ 影子跑只有影子')
})

test('⑦ 候选规则不存在 ⇒ 明确报错（不给一份"零差异"的假报告）', () => {
  const db = makeDb()
  let error = null
  try { shadowReport(db, { candidateRuleId: 'R-nope' }) } catch (e) { error = e }
  assert.ok(error)
  assert.equal(error.code, SHADOW_ERRORS.RULE_NOT_FOUND)
})
