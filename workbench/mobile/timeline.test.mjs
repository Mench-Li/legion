// workbench/mobile/timeline.test.mjs
// 远程 Agent 通道 S-F：手机端时间线投影。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SOURCES,
  TIMELINE_CODES,
  deriveConnectionState,
  mergeTimeline,
  pendingTasks,
  sourceOf,
  timelineEntry,
} from './timeline.mjs'

// ── 来源可区分 ──────────────────────────────────────────────────────────────

test('来源由服务端写入的事实决定，不由绘制位置决定', () => {
  assert.deepEqual([...SOURCES], ['user', 'agent', 'progress', 'command'])
  assert.equal(sourceOf({ source: 'user' }), 'user')
  assert.equal(sourceOf({ source: 'answer' }), 'agent')
  assert.equal(sourceOf({ source: 'progress' }), 'progress')
  assert.equal(sourceOf({ source: 'command' }), 'command')
})

test('认不出来的来源归到 agent，绝不默认成 user', () => {
  // ★ 把一条系统消息显示成"我说过的话"会让用户误判自己有没有发过。
  assert.equal(sourceOf({}), 'agent')
  assert.equal(sourceOf({ source: 'something-new' }), 'agent')
  assert.equal(sourceOf(undefined), 'agent')
})

test('普通消息不会被标成执行进度（即使是 Agent 发的）', () => {
  const plain = timelineEntry({ id: 1, author: 'agent-1', body: '好的', meta: { source: 'answer', semanticType: 'ask' } })
  assert.equal(plain.source, 'agent')
  assert.notEqual(plain.source, 'progress')

  const progress = timelineEntry({ id: 2, author: 'agent-1', body: 'T-1 本轮状态：Running', meta: { source: 'progress', semanticType: 'progress', taskId: 'T-1' } })
  assert.equal(progress.source, 'progress')
  assert.equal(progress.taskId, 'T-1')
  assert.equal(progress.openableTask, true)
})

test('没有任务归属的条目不提供"打开任务"入口', () => {
  const e = timelineEntry({ id: 3, author: 'general', body: '你好', meta: { source: 'user' } })
  // 给一个会跳到空页面的入口，比没有入口更糟。
  assert.equal(e.openableTask, false)
})

// ── 合并与游标 ──────────────────────────────────────────────────────────────

test('合并按 id 去重，补投的旧消息插回原位而不是排在末尾', () => {
  const existing = [
    timelineEntry({ id: 10, body: '第一句', meta: { source: 'user' } }),
    timelineEntry({ id: 20, body: '第三句', meta: { source: 'agent' } }),
  ]
  // 断线期间漏掉的 11..19，重连后补投 —— 到达顺序晚于 20。
  const incoming = [
    timelineEntry({ id: 15, body: '第二句', meta: { source: 'agent' } }),
    timelineEntry({ id: 20, body: '第三句', meta: { source: 'agent' } }),
  ]
  const merged = mergeTimeline(existing, incoming)
  assert.deepEqual(merged.entries.map((e) => e.id), [10, 15, 20])
  assert.equal(merged.appended, 1)
  assert.equal(merged.duplicates, 1)
  assert.equal(merged.cursor, 20)
})

test('重复投递整批时不产生新条目，游标不推进', () => {
  const batch = [timelineEntry({ id: 1, body: 'a', meta: { source: 'user' } }), timelineEntry({ id: 2, body: 'b', meta: { source: 'agent' } })]
  const once = mergeTimeline([], batch)
  assert.equal(once.appended, 2)
  assert.equal(once.cursor, 2)
  const twice = mergeTimeline(once.entries, batch)
  assert.equal(twice.appended, 0)
  assert.equal(twice.duplicates, 2)
  assert.equal(twice.cursor, 2)
})

test('缺 id 的条目在合并时被丢弃（无法去重也就无法排序）', () => {
  const merged = mergeTimeline([], [{ body: 'x' }, timelineEntry({ id: 5, body: 'y', meta: {} })])
  assert.deepEqual(merged.entries.map((e) => e.id), [5])
})

// ── 状态区分 ────────────────────────────────────────────────────────────────

test('Hub 不可达优先于其它一切（它决定"看到的是不是最新的"）', () => {
  const s = deriveConnectionState({ hubReachable: false, nodeOnline: true, activeTaskState: 'Running' })
  assert.equal(s.code, TIMELINE_CODES.HUB_UNREACHABLE)
  assert.equal(s.tone, 'error')
})

test('未登录与 Hub 不可达是**两件事**（不能合并）', () => {
  // ★ 实测踩过：未登录时界面显示"Hub 不可达"——而 `refreshStatus()` 刚刚成功。
  //   用户看到"服务器挂了"会去重启服务器，而其实只需要登录。
  const notSignedIn = deriveConnectionState({ hubReachable: true, signedIn: false })
  assert.equal(notSignedIn.code, TIMELINE_CODES.NOT_SIGNED_IN)
  // 措辞必须是"未登录"这一侧，且**不能**说服务器有问题。
  assert.match(notSignedIn.label, /未登录/)
  assert.ok(!/不可达|连不上|挂了/.test(notSignedIn.label), `不该说服务端有问题：${notSignedIn.label}`)
  assert.match(notSignedIn.detail, /Hub 正常/)
  assert.notEqual(notSignedIn.tone, 'error', '未登录不是错误态')

  const unreachable = deriveConnectionState({ hubReachable: false, signedIn: false })
  assert.equal(unreachable.code, TIMELINE_CODES.HUB_UNREACHABLE, 'Hub 真的不可达时仍要报不可达')
  assert.equal(unreachable.tone, 'error')
})

test('signedIn 默认 true（既有调用方不必改）', () => {
  const s = deriveConnectionState({ hubReachable: true, nodeOnline: true })
  assert.equal(s.code, TIMELINE_CODES.IDLE)
})

test('电脑离线明确说明"排队等待"而不是"执行中"', () => {
  const s = deriveConnectionState({ hubReachable: true, nodeOnline: false, activeTaskState: 'Running' })
  assert.equal(s.code, TIMELINE_CODES.NODE_OFFLINE)
  // ★ 用户会因为"执行中"而等下去；因为"等待上线"而去做别的。
  assert.match(s.detail, /排队|等待/)
  assert.ok(!/执行中/.test(s.label))
})

test('连接在但 runtime 不可用与"电脑离线"是两个不同的读数', () => {
  const s = deriveConnectionState({ hubReachable: true, nodeOnline: true, runtimeHealthy: false })
  assert.equal(s.code, TIMELINE_CODES.RUNTIME_UNAVAILABLE)
})

test('runtime 未上报(null)不当作不可用，也不当作正常', () => {
  const s = deriveConnectionState({ hubReachable: true, nodeOnline: true, runtimeHealthy: null })
  // 落回 idle 分支，但电脑状态是已知在线的 → 空闲。
  assert.equal(s.code, TIMELINE_CODES.IDLE)
  const unknownNode = deriveConnectionState({ hubReachable: true, nodeOnline: null })
  assert.equal(unknownNode.code, TIMELINE_CODES.IDLE)
  assert.match(unknownNode.label, /未知/)
})

test('等审批与结果待确认各有各的显示（用户动作不同）', () => {
  const approval = deriveConnectionState({ hubReachable: true, nodeOnline: true, activeTaskState: 'AwaitingApproval' })
  assert.equal(approval.code, TIMELINE_CODES.TASK_AWAITING_USER)
  const unknown = deriveConnectionState({ hubReachable: true, nodeOnline: true, activeTaskState: 'UnknownOutcome' })
  assert.equal(unknown.code, TIMELINE_CODES.TASK_RESULT_UNCONFIRMED)
  const running = deriveConnectionState({ hubReachable: true, nodeOnline: true, activeTaskState: 'Running' })
  assert.equal(running.code, TIMELINE_CODES.TASK_RUNNING)
})

test('六种状态互不相同（把它们压成"加载中"会让用户在关机时白等）', () => {
  const codes = new Set([
    deriveConnectionState({ hubReachable: false }).code,
    deriveConnectionState({ hubReachable: true, nodeOnline: false }).code,
    deriveConnectionState({ hubReachable: true, nodeOnline: true, runtimeHealthy: false }).code,
    deriveConnectionState({ hubReachable: true, nodeOnline: true, activeTaskState: 'Running' }).code,
    deriveConnectionState({ hubReachable: true, nodeOnline: true, activeTaskState: 'AwaitingApproval' }).code,
    deriveConnectionState({ hubReachable: true, nodeOnline: true, activeTaskState: 'UnknownOutcome' }).code,
  ])
  assert.equal(codes.size, 6)
})

// ── 待办分组 ────────────────────────────────────────────────────────────────

test('待办按"排队 / 执行中 / 需要我"分组', () => {
  const tasks = [
    { id: 'T-1', attempt: { state: 'Queued' } },
    { id: 'T-2', attempt: { state: 'Running' } },
    { id: 'T-3', attempt: { state: 'AwaitingApproval' } },
    { id: 'T-4', attempt: null },
    { id: 'T-5', attempt: { state: 'UnknownOutcome' } },
    { id: 'T-6', attempt: { state: 'Validating' } },
  ]
  const g = pendingTasks(tasks)
  assert.deepEqual(g.queued.map((t) => t.id), ['T-1', 'T-4'])
  assert.deepEqual(g.running.map((t) => t.id), ['T-2', 'T-6'])
  assert.deepEqual(g.awaiting.map((t) => t.id), ['T-3', 'T-5'])
})
