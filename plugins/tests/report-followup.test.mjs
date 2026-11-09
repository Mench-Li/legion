// plugins/tests/report-followup.test.mjs
// ============================================================================
// F1 · 四态落地计划（设计稿 §3 F1）—— **不发消息 ≠ 不留痕**
//
// 只测 `settlementFor` 的映射是不够的：它只说"应该是什么状态"，
// 而真正会伤人的是**落地点**：dropped 到底有没有偷偷发一条评论？
// 所以这里把落地动作也提成计划函数，用控制组钉住：
//
//   ① dropped  ⇒ 评论必须为空（不打扰人）、落 canceled、审计 drop、有活动文案
//   ② waiting  ⇒ 评论必须为空（不发进度噪音）、**不迁移**、审计 report
//   ③ blocked  ⇒ 反过来：应当有评论（人必须被告知）
//   ④ 控制组：只改 status，①②的"无评论"与③的"有评论"必须翻转
//   ⑤ done / blocked 不在本计划范围内（返回 null，走常规分支）
// ============================================================================
import test from 'node:test'
import assert from 'node:assert/strict'

import { planReportFollowup, normalizeReport } from '../lib/reportSettlement.js'

const report = (input) => normalizeReport(input)

test('① dropped：不打扰人，但留痕', () => {
  const plan = planReportFollowup(report({ status: 'dropped', summary: '这批改动不在范围内' }))
  assert.equal(plan.comment, null, '★ dropped 不许发评论')
  assert.equal(plan.transitionTo, 'canceled', '★ 落 canceled（done 只有将军能写）')
  assert.equal(plan.auditAction, 'drop')
  assert.match(plan.activityText, /无需处理/)
})

test('② waiting：不发进度噪音，也不迁移', () => {
  const plan = planReportFollowup(report({ status: 'waiting', wait_for: 'human-decision', summary: '等审批' }))
  assert.equal(plan.comment, null, '★ waiting 不许发进度噪音')
  assert.equal(plan.transitionTo, null, '留在 in_progress，由 stale 回收器再评估')
  assert.equal(plan.auditAction, 'report')
  assert.match(plan.activityText, /等待/)
})

test('③ blocked：必须让知道（有评论）', () => {
  const plan = planReportFollowup(report({
    status: 'blocked', summary: '卡住了', blocker: { body: '口径按 A 还是 B？' },
  }))
  assert.equal(typeof plan.comment, 'string', '★ 受阻必须留下可读说明')
  assert.equal(plan.transitionTo, 'blocked')
})

test('④ 控制组：只改 status，评论有无必须翻转', () => {
  const dropped = planReportFollowup(report({ status: 'dropped', summary: 'x' }))
  const blocked = planReportFollowup(report({ status: 'blocked', summary: 'x', blocker: { body: 'y' } }))
  assert.equal(dropped.comment, null)
  assert.equal(typeof blocked.comment, 'string')
})

test('⑤ done 不在本计划范围（返回 null，走常规分支）', () => {
  assert.equal(planReportFollowup(report({ status: 'done', summary: '完成' })), null)
})
