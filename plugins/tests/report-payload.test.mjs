// plugins/tests/report-payload.test.mjs
// ============================================================================
// F2 · 守护侧「回报请求」的形状（设计稿 §3 F2 / DEC-2）
//
// 守护不再自己拼评论 + 再发一次 transition，而是把**一次**回报交给
// `POST /api/tasks/:id/report`。这个模块决定那次请求长什么样，所以它需要被判据钉住：
//
//   ① 幂等键 = `blocked:<taskId>:<version>`（守护重试不会造出第二个问题）
//   ② 有 blocker ⇒ 带 question；没有 ⇒ 不带（"真卡住"与"在等人"必须能分开）
//   ③ applyTransition: true ⇒ 状态与问题在同一个事务里落盘
//   ④ 路径里的任务 id 必须转义（id 里出现 `/` 时不能拼出一条别的路由）
//   ⑤ 空 blocker 不会退化成把 summary 当问题（那是噪音，不是问题）
// ============================================================================
import test from 'node:test'
import assert from 'node:assert/strict'

import { blockedReportPayload, REPORT_PATH_PREFIX, REPORT_PATH_SUFFIX } from '../lib/reportPayload.js'

test('① 幂等键与路径固定', () => {
  const { path, body } = blockedReportPayload({
    taskId: 'T-100', version: 7, role: 'soldier-coder', scope: 'default',
    summary: '做到一半', evidence: 'npm test 红了', blocker: '口径 A 还是 B',
  })
  assert.equal(path, '/api/tasks/T-100/report')
  assert.equal(body.reportId, 'blocked:T-100:7', '★ 同任务同版本只登记一次')
  assert.equal(body.status, 'blocked')
  assert.equal(body.by, 'soldier-coder')
  assert.equal(body.scope, 'default')
  assert.equal(body.applyTransition, true, '★ 一次请求落盘，不留两次写的缝')
  assert.equal(REPORT_PATH_PREFIX, '/api/tasks/')
  assert.equal(REPORT_PATH_SUFFIX, '/report')
})

test('② 有 blocker ⇒ 带 question（结构化问题才是"在等人"的真相）', () => {
  const { body } = blockedReportPayload({
    taskId: 'T-1', version: 1, role: 'r', scope: 'default', summary: 's', evidence: 'e',
    blocker: '❓ 待将军确认：验收口径 A 还是 B？',
  })
  assert.equal(body.question.body, '❓ 待将军确认：验收口径 A 还是 B？')
})

test('③ 没有 blocker ⇒ 不带 question（这条会被派生成 stuck，而不是 awaiting_answer）', () => {
  const { body } = blockedReportPayload({
    taskId: 'T-1', version: 1, role: 'r', scope: 'default', summary: '构建挂了', evidence: 'e', blocker: '',
  })
  assert.equal('question' in body, false, '★ 空 blocker 不得被填成 summary')
  assert.equal(body.summary, '构建挂了')
})

test('④ 纯空白的 blocker 同样不带 question', () => {
  const { body } = blockedReportPayload({
    taskId: 'T-1', version: 2, role: 'r', scope: 'default', summary: 's', evidence: '', blocker: '   \n ',
  })
  assert.equal('question' in body, false)
})

test('⑤ 任务 id 里的特殊字符被转义（不能拼出别的路由）', () => {
  const { path } = blockedReportPayload({
    taskId: 'T/1 x', version: 1, role: 'r', scope: 'default', summary: 's', evidence: '', blocker: '',
  })
  assert.ok(path.endsWith('/report'))
  assert.ok(!path.includes('/1 x'), '★ 空格与斜杠都必须被编码')
  assert.equal(path, `/api/tasks/${encodeURIComponent('T/1 x')}/report`)
})

test('⑥ 问题正文被截断到 800 字（提示词与看板都受不了超长文本）', () => {
  const long = 'x'.repeat(2000)
  const { body } = blockedReportPayload({
    taskId: 'T-1', version: 1, role: 'r', scope: 'default', summary: 's', evidence: '', blocker: long,
  })
  assert.equal(body.question.body.length, 800)
})

test('⑦ worktree 提示并入 evidence（不额外制造一条评论）', () => {
  const { body } = blockedReportPayload({
    taskId: 'T-1', version: 1, role: 'r', scope: 'default', summary: 's',
    evidence: 'npm test 红了', blocker: 'x', worktreeHint: '[worktree] 改动在 w/T-1',
  })
  assert.match(String(body.evidence), /npm test 红了/)
  assert.match(String(body.evidence), /w\/T-1/)
})
