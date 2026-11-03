// team-hub/policy-rules.test.mjs
// ============================================================================
// F4 · 规则集维护（设计稿 §3 F4 / M5）
//
// `policy_rules` 是"凭什么"的来源之一：mandate 的 `basisRuleIds` 指的就是这些 id。
// 规则一旦可随意改而不留痕，台账就退化成"事后编理由"。
//
// 判据：
//   ① kind 只许 always / when / never；text 非空；id 合法
//   ② upsert：同 id 更新不新增；`created` 标记能区分
//   ③ 每次变更都递增 policyVersion（mandate 上记的就是它）
//   ④ 每次变更都写一条 `policy_changed` 审计（I-4.4：只记一条事件，不撤销在途任务）
//   ⑤ 列表可按 enabled / scope 过滤
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { ensureDecisionSchema } from './decisions.mjs'
import {
  RULE_KINDS,
  POLICY_ERRORS,
  listPolicyRules,
  policyVersion,
  upsertPolicyRule,
} from './policy-rules.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, member TEXT, scope TEXT,
    action TEXT, taskId TEXT, detail TEXT);`)
  ensureDecisionSchema(db)
  return db
}
const auditSink = () => {
  const rows = []
  const fn = (member, scope, action, taskId, detail) => { rows.push({ member, scope, action, taskId, detail }); return rows.length }
  fn.rows = rows
  return fn
}

test('① 校验：kind / text / id', () => {
  const db = makeDb()
  assert.deepEqual([...RULE_KINDS], ['always', 'when', 'never'])
  assert.throws(() => upsertPolicyRule(db, { id: 'R-1', kind: 'sometimes', text: 'x' }), (e) => e.code === POLICY_ERRORS.UNKNOWN_KIND)
  assert.throws(() => upsertPolicyRule(db, { id: 'R-1', kind: 'always', text: '   ' }), (e) => e.code === POLICY_ERRORS.EMPTY_TEXT)
  assert.throws(() => upsertPolicyRule(db, { id: '有空格 的', kind: 'always', text: 'x' }), (e) => e.code === POLICY_ERRORS.BAD_ID)
})

test('② upsert：同 id 更新不新增', () => {
  const db = makeDb()
  const a = upsertPolicyRule(db, { id: 'R-2', kind: 'always', text: '改动要有测试' }, { by: 'general', audit: auditSink() })
  assert.equal(a.created, true)
  const b = upsertPolicyRule(db, { id: 'R-2', kind: 'always', text: '改动必须带测试与证据' }, { by: 'general', audit: auditSink() })
  assert.equal(b.created, false)
  assert.equal(listPolicyRules(db).length, 1, '★ 同 id 不新增')
  assert.equal(listPolicyRules(db)[0].text, '改动必须带测试与证据')
})

test('③ 每次变更递增 policyVersion', () => {
  const db = makeDb()
  const v0 = policyVersion(db)
  upsertPolicyRule(db, { id: 'R-2', kind: 'always', text: 'a' }, { by: 'general', audit: auditSink() })
  const v1 = policyVersion(db)
  upsertPolicyRule(db, { id: 'R-3', kind: 'when', text: 'b' }, { by: 'general', audit: auditSink() })
  const v2 = policyVersion(db)

  assert.notEqual(v0, v1)
  assert.notEqual(v1, v2)
  assert.match(v2, /^legion\/policy@1\.[0-9a-f]{8}$/)
})

test('④ 每次变更都写一条 policy_changed 审计（不撤销在途任务）', () => {
  const db = makeDb()
  const audit = auditSink()
  upsertPolicyRule(db, { id: 'R-2', kind: 'always', text: 'a' }, { by: 'general', audit })
  upsertPolicyRule(db, { id: 'R-2', kind: 'never', text: 'a' }, { by: 'general', audit })

  assert.equal(audit.rows.length, 2)
  assert.ok(audit.rows.every((r) => r.action === 'policy_changed'))
  assert.match(String(audit.rows[0].detail), /R-2/)
})

test('⑤ 过滤：enabled / scope', () => {
  const db = makeDb()
  upsertPolicyRule(db, { id: 'R-1', kind: 'always', text: 'a', scope: 'default', enabled: true }, { by: 'g', audit: auditSink() })
  upsertPolicyRule(db, { id: 'R-2', kind: 'never', text: 'b', scope: 'default', enabled: false }, { by: 'g', audit: auditSink() })
  upsertPolicyRule(db, { id: 'R-3', kind: 'always', text: 'c', scope: 'other', enabled: true }, { by: 'g', audit: auditSink() })

  assert.deepEqual(listPolicyRules(db, { enabledOnly: true }).map((r) => r.id), ['R-1', 'R-3'])
  assert.deepEqual(listPolicyRules(db, { scope: 'default' }).map((r) => r.id), ['R-1', 'R-2'])
  assert.deepEqual(listPolicyRules(db, { scope: 'default', enabledOnly: true }).map((r) => r.id), ['R-1'])
})
