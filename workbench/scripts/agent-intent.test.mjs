import test from 'node:test'
import assert from 'node:assert/strict'
import { planAgentSend, isStructuredIntent } from '../src/agentIntent.ts'

// C2 的发送路由：一次岗位对话有两条通道，选错 = 消息去错地方或根本发不出去。
// 这组用例守的是**路由与三条护栏**（都是服务端会拒、但应当在这里先说清楚的）。
// 与 React 无关（纯函数），所以 `node --test` 直接跑。

const base = { body: '看看进度', attachmentIds: [], targetTaskId: '', pendingQuestion: null }

test('询问走聊天通道：附件原样带下去（不能被路由吞掉）', () => {
  const plan = planAgentSend({ ...base, intent: 'ask', attachmentIds: [7, 8] })
  assert.equal(plan.ok, true)
  assert.equal(plan.via, 'chat')
  assert.deepEqual(plan.attachmentIds, [7, 8],
    '附件必须原样传递：静默丢附件比报错更坏（用户以为发出去了）')
})

test('★ 询问**不**走 agent-messages：它是人说人话，走 AI 回复管道', () => {
  const plan = planAgentSend({ ...base, intent: 'ask' })
  assert.equal(plan.ok && plan.via, 'chat')
  assert.equal(plan.ok && 'intent' in plan, false, 'ask 不该带结构化 intent 载荷')
})

test('追加要求必须带具体任务（服务端 TARGET_AMBIGUOUS 会拒，这里先拦）', () => {
  const noTarget = planAgentSend({ ...base, intent: 'feedback' })
  assert.equal(noTarget.ok, false)
  assert.match(noTarget.reason, /必须选择具体任务/)
  const withTarget = planAgentSend({ ...base, intent: 'feedback', targetTaskId: 'T-42' })
  assert.equal(withTarget.ok, true)
  assert.equal(withTarget.via, 'agent')
  assert.equal(withTarget.intent, 'feedback')
  assert.equal(withTarget.targetTaskId, 'T-42')
})

test('★ 结构化意图不许带附件（agent-messages 没有这个参数）', () => {
  for (const intent of ['feedback', 'create_task']) {
    const plan = planAgentSend({ ...base, intent, attachmentIds: [3], targetTaskId: 'T-1' })
    assert.equal(plan.ok, false, `${intent} + 附件必须被拦下`)
    assert.match(plan.reason, /不能带附件/)
  }
})

test('新建任务：正文即标题，不需要目标', () => {
  const plan = planAgentSend({ ...base, intent: 'create_task', body: '加一个导出按钮' })
  assert.equal(plan.ok, true)
  assert.equal(plan.via, 'agent')
  assert.equal(plan.targetTaskId, null)
})

test('★ 待决策问题优先于意图：锁定 answer_question 并带上问题身份（服务端按 version 拒旧答复）', () => {
  const plan = planAgentSend({
    ...base, intent: 'ask', // 用户可能还停在 ask 上，但点了「回答」
    pendingQuestion: { id: 'q-1', version: 3, taskId: 'T-9' },
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.via, 'agent')
  assert.equal(plan.intent, 'answer_question')
  assert.equal(plan.questionId, 'q-1')
  assert.equal(plan.questionVersion, 3)
  assert.equal(plan.targetTaskId, 'T-9', '回答必须落在提出问题的那条任务上')
})

test('回答待决策也不许带附件', () => {
  const plan = planAgentSend({
    ...base, intent: 'ask', attachmentIds: [1],
    pendingQuestion: { id: 'q-1', version: 1, taskId: 'T-9' },
  })
  assert.equal(plan.ok, false)
  assert.match(plan.reason, /不能带附件/)
})

test('空正文不发（trim 之后为空也算空）', () => {
  assert.equal(planAgentSend({ ...base, intent: 'ask', body: '   ' }).ok, false)
  assert.equal(planAgentSend({ ...base, intent: 'ask', body: '' }).ok, false)
})

test('正文两端空白被裁掉后再提交', () => {
  const plan = planAgentSend({ ...base, intent: 'ask', body: '  进度？  ' })
  assert.equal(plan.ok && plan.body, '进度？')
})

test('isStructuredIntent：ask 不是结构化，其余是；有待决策问题时一律算结构化', () => {
  assert.equal(isStructuredIntent('ask', null), false)
  assert.equal(isStructuredIntent('feedback', null), true)
  assert.equal(isStructuredIntent('create_task', null), true)
  assert.equal(isStructuredIntent('answer_question', null), true)
  assert.equal(isStructuredIntent('ask', { id: 'q' }), true, '有待决策问题时必须走结构化通道')
})
