// team-hub/acceptance.test.mjs
// ============================================================================
// F4 · 「→ todo 时写授权与台账」（设计稿 §3 F4 / DEC-1）
//
// DEC-1 定下：mandate **只在 `transitionTask()` 里写**，不在路由层散落。
// 但「一上来就强制要求 mandate」会把所有在途任务一次性卡死（它们都没有 mandate），
// 所以分两步：**先记录（strict=false，默认）**，再**强制（strict=true）**。
//
// 判据：
//   ① 人能开工（by=成员）⇒ 写 manual mandate + accept 决策 + audit
//   ② 命中启用的 policy_rules ⇒ matchedRuleIds 进 mandate 与决策
//   ③ strict + 无依据（系统触发、规则不命中）⇒ 抛 OUT_OF_MANDATE，并落 stop 决策
//   ④ 幂等：同任务重复写不叠加 audit
//   ⑤ 落盘：tasks.mandate / tasks.accept_mode 都能查到
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { ensureDecisionSchema, listDecisions } from './decisions.mjs'
import { acceptOnTodo, ensureAcceptanceSchema, ACCEPTANCE_ERRORS } from './acceptance.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL DEFAULT 'default', role TEXT, soldier TEXT,
      status TEXT NOT NULL DEFAULT 'todo', version INTEGER NOT NULL DEFAULT 1, updatedAt TEXT
    );
    CREATE TABLE audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, member TEXT, scope TEXT,
      action TEXT, taskId TEXT, detail TEXT
    );
  `)
  ensureDecisionSchema(db)
  ensureAcceptanceSchema(db)
  db.prepare("INSERT INTO tasks (id, role, status, updatedAt) VALUES ('T-1','coder','todo','2026-11-03T00:00:00.000Z')").run()
  return db
}
const audits = () => {
  const rows = []
  const fn = (member, scope, action, taskId, detail) => { rows.push({ member, scope, action, taskId, detail }); return rows.length }
  fn.rows = rows
  return fn
}

test('① 人开工 ⇒ manual mandate + accept 决策 + audit', () => {
  const db = makeDb()
  const audit = audits()

  const out = acceptOnTodo(db, { taskId: 'T-1', by: 'general', at: '2026-11-03T01:00:00.000Z' }, { audit })

  assert.equal(out.decision.kind, 'accept')
  assert.equal(out.mandate.manual, true)
  assert.equal(out.mandate.strength, 'explicit')
  assert.equal(out.mandate.supersedes, null)
  assert.ok(JSON.parse(db.prepare('SELECT mandate FROM tasks WHERE id=?').get('T-1').mandate).manual === true)
  assert.equal(audit.rows.filter((r) => r.action === 'mandate').length, 1)
  assert.equal(listDecisions(db, { kind: 'accept' }).length, 1)
})

test('② 命中启用规则 ⇒ matchedRuleIds 进 mandate 与决策', () => {
  const db = makeDb()
  db.prepare("INSERT INTO policy_rules (id, kind, text, scope, enabled) VALUES ('R-2','always','像样的改动都要有测试','default',1)").run()
  db.prepare("INSERT INTO policy_rules (id, kind, text, scope, enabled) VALUES ('R-9','never','停用的规则','default',0)").run()

  const out = acceptOnTodo(db, { taskId: 'T-1', by: 'general', at: '2026-11-03T01:00:00.000Z' }, { audit: audits() })
  assert.deepEqual([...out.mandate.basisRuleIds], ['R-2'], '★ 停用的规则不参与')
  assert.deepEqual(JSON.parse(db.prepare('SELECT matched_rule_ids FROM decisions WHERE subject=?').get('task:T-1').matched_rule_ids), ['R-2'])
})

test('③ strict + 无依据 ⇒ OUT_OF_MANDATE，且台账留下 stop', () => {
  const db = makeDb()
  let error = null
  try {
    acceptOnTodo(db, { taskId: 'T-1', by: 'daemon', at: '2026-11-03T01:00:00.000Z' }, { audit: audits(), strict: true })
  } catch (e) { error = e }

  assert.ok(error, '必须拒绝')
  assert.equal(error.code, ACCEPTANCE_ERRORS.OUT_OF_MANDATE)
  assert.equal(listDecisions(db, { kind: 'stop' }).length, 1, '★ 拒绝也要留痕')
  assert.equal(db.prepare('SELECT mandate FROM tasks WHERE id=?').get('T-1').mandate, null, '被拒不得写授权')
})

test('③b 非 strict 时同样记录真实判定（先记账、后强制）', () => {
  const db = makeDb()
  const out = acceptOnTodo(db, { taskId: 'T-1', by: 'daemon', at: '2026-11-03T01:00:00.000Z' }, { audit: audits() })
  // 系统触发且无规则命中 ⇒ 真实判定是 stop；今天不拦，但台账照记
  assert.equal(out.decision.kind, 'stop', '★ 记真实判定，不粉饰')
  assert.equal(out.proceed, true, 'strict=false 时放行')
  assert.equal(listDecisions(db, { kind: 'stop' }).length, 1)
})

test('④ 幂等：同任务重复写不叠加 audit', () => {
  const db = makeDb()
  const audit = audits()
  acceptOnTodo(db, { taskId: 'T-1', by: 'general', at: '2026-11-03T01:00:00.000Z' }, { audit })
  acceptOnTodo(db, { taskId: 'T-1', by: 'general', at: '2026-11-03T02:00:00.000Z' }, { audit })
  assert.equal(audit.rows.filter((r) => r.action === 'mandate').length, 1, '★ 同版本授权只记一次')
})

test('⑤ accept_mode 快照落盘（真值在空间设置，任务上只是快照）', () => {
  const db = makeDb()
  const out = acceptOnTodo(db, { taskId: 'T-1', by: 'general', at: '2026-11-03T01:00:00.000Z' }, { audit: audits(), acceptMode: 'manual' })
  assert.equal(out.mandate.scope.fileDomain.length, 0, '未声明目录时 fileDomain 为空（fail-closed）')
  assert.equal(db.prepare('SELECT accept_mode FROM tasks WHERE id=?').get('T-1').accept_mode, 'manual')
})
