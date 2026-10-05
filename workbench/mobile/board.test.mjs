// workbench/mobile/board.test.mjs
// 手机端看板与意图投影。守的是两件"按下去之后才看得见"的事：
//   ① 用户打的字到底变成询问还是任务；
//   ② 任务在看板上出现在哪一列、以及"等电脑"与"电脑在做"有没有被分开。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BOARD_COLUMNS,
  DEFAULT_INTENT,
  INTENT_CODES,
  INTENT_OPTIONS,
  IntentError,
  attentionCount,
  boardColumns,
  intentOf,
  isWaitingForNode,
  mergeAttempts,
  planSend,
  taskLine,
  taskMeta,
} from './board.mjs'

const codeOf = (fn) => { try { fn(); return null } catch (e) { return e instanceof IntentError ? e.code : `UNEXPECTED:${e.message}` } }

// ── 意图 ────────────────────────────────────────────────────────────────────

test('默认是"询问"——安全的默认，不是"派任务"', () => {
  assert.equal(DEFAULT_INTENT, 'ask')
  assert.equal(planSend({ body: '登录页现在什么状态？' }).intent.id, 'ask')
  assert.equal(planSend({ body: '登录页现在什么状态？' }).intent.createsTask, false)
})

test('意图 id 必须落在服务端白名单里（不在的那几个发出去会被 400）', () => {
  // 服务端 `agent-conversations.mjs` 的白名单：ask / feedback / answer_question / create_task。
  // 这里只暴露其中三个——`answer_question` 走问题卡片的专用路径，不该出现在输入框里。
  const ids = INTENT_OPTIONS.map((o) => o.id)
  assert.deepEqual(ids, ['ask', 'create_task', 'feedback'])
  for (const id of ids) assert.ok(['ask', 'feedback', 'create_task'].includes(id))
})

test('「派任务」明确说它会创建任务；三种意图都有一句后果说明', () => {
  assert.equal(intentOf('create_task').createsTask, true)
  assert.equal(intentOf('feedback').createsTask, false)
  for (const o of INTENT_OPTIONS) assert.ok(o.hint.length > 0, `${o.id} 缺后果说明`)
})

test('「追加要求」没有指定任务就拒绝——隐含默认会在有两条活动任务时改错那一条', () => {
  assert.equal(codeOf(() => planSend({ intent: 'feedback', body: '改成蓝色' })), INTENT_CODES.TASK_REQUIRED)
  assert.equal(codeOf(() => planSend({ intent: 'feedback', body: '改成蓝色', taskId: '  ' })), INTENT_CODES.TASK_REQUIRED)
  assert.equal(planSend({ intent: 'feedback', body: '改成蓝色', taskId: 'T-003' }).taskId, 'T-003')
})

test('空消息与不认识的意图各自具名拒绝', () => {
  assert.equal(codeOf(() => planSend({ body: '   ' })), INTENT_CODES.EMPTY_BODY)
  assert.equal(codeOf(() => planSend({ intent: 'deploy_everything', body: 'x' })), INTENT_CODES.UNKNOWN_INTENT)
})

test('正文去掉首尾空白；taskId 也 trim', () => {
  const p = planSend({ intent: 'create_task', body: '  把登录页的错误提示改一下  ' })
  assert.equal(p.body, '把登录页的错误提示改一下')
  assert.equal(p.taskId, null, '"派任务"不需要先有任务')
})

// ── 看板 ────────────────────────────────────────────────────────────────────

test('六列都在，且顺序把"要人动手的"排在前面', () => {
  assert.deepEqual(BOARD_COLUMNS.map((c) => c.id), ['blocked', 'in_review', 'in_progress', 'todo', 'backlog', 'done'])
})

test('任务按状态入列，`done` 与 `canceled` 同列（都是"结束了"）', () => {
  const r = boardColumns([
    { id: 'T-1', status: 'todo' },
    { id: 'T-2', status: 'in_progress' },
    { id: 'T-3', status: 'done' },
    { id: 'T-4', status: 'canceled' },
  ])
  const col = (id) => r.columns.find((c) => c.id === id)
  assert.deepEqual(col('todo').tasks.map((t) => t.id), ['T-1'])
  assert.deepEqual(col('in_progress').tasks.map((t) => t.id), ['T-2'])
  assert.deepEqual(col('done').tasks.map((t) => t.id), ['T-3', 'T-4'])
  assert.equal(r.total, 4)
})

test('`backlog` 有自己的一列：库里有、界面上没有 = 用户以为它丢了', () => {
  const r = boardColumns([{ id: 'T-9', status: 'backlog' }])
  assert.deepEqual(r.columns.find((c) => c.id === 'backlog').tasks.map((t) => t.id), ['T-9'])
  assert.equal(r.unknown.length, 0)
})

test('不认识的状态**不丢弃**：状态机新增状态时手机上看不到，是个不报错的错', () => {
  const r = boardColumns([{ id: 'T-1', status: 'todo' }, { id: 'T-X', status: 'quarantined' }])
  assert.equal(r.unknown.length, 1)
  assert.equal(r.unknown[0].id, 'T-X')
  assert.equal(r.total, 2, '总数要算上不认识的，否则"少了几个"永远看不出来')
  assert.equal(r.columns.reduce((n, c) => n + c.count, 0), 1, '已知列里不含它')
})

test('空列表是干净的空，不是报错', () => {
  const r = boardColumns([])
  assert.equal(r.total, 0)
  assert.equal(r.columns.every((c) => c.count === 0), true)
  assert.equal(attentionCount([]), 0)
})

test('attentionCount 只数"要人动手的"：受阻 + 待验收', () => {
  assert.equal(attentionCount([
    { status: 'blocked' }, { status: 'in_review' }, { status: 'in_progress' }, { status: 'done' },
  ]), 2)
  // 进行中与待办都不是"要人动手"——把它们算进去会让红点永远亮着，于是没人再看它。
  assert.equal(attentionCount([{ status: 'in_progress' }, { status: 'todo' }]), 0)
})

// ── 任务一句话 ──────────────────────────────────────────────────────────────

test('"等电脑领取"与"电脑在做"必须分得开', () => {
  const waiting = { id: 'T-1', status: 'todo', attempt: null }
  const running = { id: 'T-2', status: 'in_progress', attempt: { state: 'Running' } }
  assert.equal(isWaitingForNode(waiting), true)
  assert.equal(isWaitingForNode(running), false)
  assert.equal(taskLine(waiting), '等电脑领取')
  assert.equal(taskLine(running), '正在电脑上执行')
})

test('"执行结束"不等于"交付完成"：Validating 说的是等验收', () => {
  assert.match(taskLine({ status: 'in_progress', attempt: { state: 'Validating' } }), /等待验收/)
  assert.match(taskLine({ status: 'in_review', attempt: { state: 'Validating' } }), /等待验收/)
})

test('`UnknownOutcome` 不许被翻译成"失败"——那会让人去重跑', () => {
  const line = taskLine({ status: 'blocked', attempt: { state: 'UnknownOutcome' } })
  assert.match(line, /待确认/)
  assert.doesNotMatch(line, /失败/)
  assert.match(taskLine({ status: 'blocked', attempt: { state: 'DeadLetter' } }), /失败已停手/)
})

test('没有执行记录时不编造进展', () => {
  assert.equal(taskLine({ status: 'done', attempt: null }), '已完成')
  assert.equal(taskLine({ status: 'todo', attempt: null }), '等电脑领取')
  assert.equal(taskLine({ status: 'backlog', attempt: null }), '未排期：还不该被领取')
  assert.equal(taskLine({}), '尚无执行记录')
})

test('卡片第二行只在真有内容时出现分隔符', () => {
  assert.equal(taskMeta({}), '')
  assert.equal(taskMeta({ role: 'coder' }), 'coder')
  assert.equal(taskMeta({ role: 'coder', priority: 'high' }), 'coder · 高优先级')
  assert.equal(taskMeta({ priority: 'medium' }), '')
  // 兼容旧字段名：`soldier` 与 `role` 都可能出现。
  assert.equal(taskMeta({ soldier: 'tester' }), 'tester')
})

// ── 两个端点的一半拼成一条 ──────────────────────────────────────────────────

test('详情里的 attempt 被并进看板行', () => {
  const merged = mergeAttempts(
    [{ id: 'T-1', status: 'in_progress' }, { id: 'T-2', status: 'todo' }],
    [{ id: 'T-1', attempt: { state: 'Running' } }],
  )
  assert.equal(taskLine(merged[0]), '正在电脑上执行')
  // 别岗位的任务不在详情里 → 保持原样，按任务状态说它确定的那句话。
  assert.equal(merged[1].attempt, undefined)
  assert.equal(taskLine(merged[1]), '等电脑领取')
})

test('详情里没有 attempt 字段时**不**覆盖：不能替另一台电脑断言它没在跑', () => {
  const merged = mergeAttempts([{ id: 'T-1', status: 'in_progress', attempt: undefined }], [{ id: 'T-1', title: 'x' }])
  assert.equal(merged[0].attempt, undefined)
})

test('空输入不炸，也不凭空造行', () => {
  assert.deepEqual(mergeAttempts([], []), [])
  assert.deepEqual(mergeAttempts(undefined, undefined), [])
  assert.equal(mergeAttempts([{ id: 'T-1' }], null).length, 1)
})
