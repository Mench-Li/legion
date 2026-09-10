/**
 * notify.test.mjs — P2-4 通知中心纯函数回归（分类/优先级/来源、批量已读、跳转协议、去重与缺口）。
 *
 * 直接 import workbench/src/notify.ts（无 JSX/DOM 依赖，与 dedupe.test.mjs 同一模式；
 * 由 run-ci 以 --experimental-strip-types 运行）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_READ_STATE, applyMarkAllRead, applyMarkRead, applyReadState, categoryCounts, filterItems,
  highestSeq, isNotifyAction, isSeqRead, jumpOf, mergeNotifyItems, normalizeReadState, notifyCategory,
  notifyReadIdsKey, notifyReadKey, notifyLabel, notifyPriority, shouldRefill, toNotifyItems, unreadCount,
} from '../src/notify.ts'

/** 构造审计行。 */
const row = (seq, action, extra = {}) => ({
  seq, ts: '2026-09-10T01:00:0' + String(seq % 10) + '.000Z', member: 'general',
  scope: 'software', action, taskId: null, detail: {}, ...extra,
})

test('白名单：生命周期/目标/空间/模型/技能入列，chat:/progress/comment/release-stale 排除', () => {
  for (const a of ['create', 'claim', 'transition', 'advance', 'hold', 'test-report', 'goal:publish', 'space:create', 'model:set', 'skill:grant']) {
    assert.equal(isNotifyAction(a), true, a + ' 应入列')
  }
  for (const a of ['chat:message', 'chat:create', 'progress', 'comment', 'release-stale', 'exec:on', 'heartbeat', 42, null]) {
    assert.equal(isNotifyAction(a), false, String(a) + ' 不应入列')
  }
  // P2-5 取舍固定：日历动作**不入通知白名单**——日程由本人创建/修改，进通知只会造成自操作噪音
  // （审计仍有 calendar:create/update/delete 全量留痕，可在活动流查看）。若日后要放开，请先想清噪音问题。
  for (const a of ['calendar:create', 'calendar:update', 'calendar:delete']) {
    assert.equal(isNotifyAction(a), false, a + ' 不应入通知白名单（P2-5 取舍）')
  }
})

test('分类：按 action 前缀落到 task/goal/space/model/skill', () => {
  assert.equal(notifyCategory('create'), 'task')
  assert.equal(notifyCategory('test-report'), 'task')
  assert.equal(notifyCategory('goal:slices'), 'goal')
  assert.equal(notifyCategory('space:delete'), 'space')
  assert.equal(notifyCategory('model:clear'), 'model')
  assert.equal(notifyCategory('skill:review'), 'skill')
})

test('优先级：high 清单 + transition 落到 blocked/in_review 升级；low 清单；其余 normal', () => {
  for (const a of ['hold', 'reassign', 'test-report', 'goal:publish', 'goal:done', 'goal:cancel']) {
    assert.equal(notifyPriority(a), 'high', a + ' 应为 high')
  }
  assert.equal(notifyPriority('transition', { to: 'blocked' }), 'high')
  assert.equal(notifyPriority('transition', { to: 'in_review' }), 'high')
  assert.equal(notifyPriority('transition', { to: 'done' }), 'normal')
  assert.equal(notifyPriority('transition'), 'normal')
  assert.equal(notifyPriority('transition', { to: 42 }), 'normal')
  for (const a of ['review-note', 'goal:context', 'model:clear', 'space:update']) {
    assert.equal(notifyPriority(a), 'low', a + ' 应为 low')
  }
  assert.equal(notifyPriority('create'), 'normal')
})

test('来源统一：审计派生项 source=hub-audit；文案覆盖白名单且未知动作兜底不抛', () => {
  const items = toNotifyItems([row(1, 'create'), row(2, 'unknown:thing')], EMPTY_READ_STATE)
  assert.equal(items.length, 1, '未知动作不入列（白名单外）')
  assert.equal(items[0].source, 'hub-audit')
  assert.equal(notifyLabel('create'), '📝 任务创建')
  assert.equal(notifyLabel('weird'), '⚡ weird')
})

test('跳转协议：task/goal/space/model/skill/none 六类，UI 只按 kind 分发', () => {
  assert.deepEqual(jumpOf({ action: 'transition', taskId: 'T-001', scope: 's' }), { kind: 'task', ref: 'T-001' })
  assert.deepEqual(jumpOf({ action: 'create', taskId: 'T-003', scope: 's' }), { kind: 'task', ref: 'T-003' })
  assert.deepEqual(jumpOf({ action: 'goal:publish', taskId: null, goalId: 'G-1', scope: 's' }), { kind: 'goal', ref: 'G-1' })
  assert.deepEqual(jumpOf({ action: 'goal:publish', taskId: null, goalId: null, scope: 's' }), { kind: 'goal', ref: null })
  assert.deepEqual(jumpOf({ action: 'space:update', taskId: null, scope: 'software' }), { kind: 'space', ref: 'software' })
  assert.deepEqual(jumpOf({ action: 'model:set', taskId: null, scope: 's' }), { kind: 'model', ref: null })
  assert.deepEqual(jumpOf({ action: 'skill:grant', taskId: null, scope: 's' }), { kind: 'skill', ref: null })
  assert.deepEqual(jumpOf({ action: 'hold', taskId: '*', scope: 's' }), { kind: 'none', ref: null })
  // P2-4 语义统一：动作所属域优先——目标类动作即使带 taskId 也跳目标面板（与分类一致）
  assert.deepEqual(jumpOf({ action: 'goal:slices', taskId: 'T-002', scope: 's' }), { kind: 'goal', ref: null })
  assert.deepEqual(jumpOf({ action: 'goal:slices', taskId: 'T-002', goalId: 'G-2', scope: 's' }), { kind: 'goal', ref: 'G-2' })
})

test('已读：游标判定 + 显式集合判定（非连续批量）', () => {
  const st = { cursor: 5, ids: [9, 12] }
  assert.equal(isSeqRead(3, st), true, '游标内已读')
  assert.equal(isSeqRead(5, st), true, '游标边界已读')
  assert.equal(isSeqRead(6, st), false)
  assert.equal(isSeqRead(9, st), true, '显式 id 已读')
  assert.equal(isSeqRead(12, st), true)
  assert.equal(isSeqRead(13, st), false)
})

test('批量已读：压实推进游标，幂等，越界/坏值安全', () => {
  // 连续批量：1..3 → 游标推进到 3，ids 清空
  const a = applyMarkRead(EMPTY_READ_STATE, [1, 2, 3])
  assert.deepEqual(a, { cursor: 3, ids: [] })
  // 非连续：5,7（游标 0）→ ids=[5,7]，游标不动
  const b = applyMarkRead(EMPTY_READ_STATE, [5, 7])
  assert.deepEqual(b, { cursor: 0, ids: [5, 7] })
  // 补满缺口 → 压实推进游标到 7
  const c = applyMarkRead(b, [1, 2, 3, 4, 6])
  assert.deepEqual(c, { cursor: 7, ids: [] })
  // 幂等：重复标记同一批不变
  assert.deepEqual(applyMarkRead(c, [1, 2, 3, 4, 5, 6, 7]), c)
  // 乱序输入同样压实
  assert.deepEqual(applyMarkRead(EMPTY_READ_STATE, [3, 1, 2]), { cursor: 3, ids: [] })
  // 坏值忽略、NaN/负数不计
  assert.deepEqual(applyMarkRead(EMPTY_READ_STATE, [Number.NaN, -4, 2]), normalizeReadState({ cursor: 0, ids: [2] }))
  // <= 游标的重复 id 被规范化丢弃
  assert.deepEqual(normalizeReadState({ cursor: 5, ids: [3, 5, 8] }), { cursor: 5, ids: [8] })
})

test('全部已读：游标推进到最大 seq，且不回退；保留游标之上的显式 id', () => {
  assert.deepEqual(applyMarkAllRead(EMPTY_READ_STATE, 20), { cursor: 20, ids: [] })
  assert.deepEqual(applyMarkAllRead({ cursor: 20, ids: [] }, 12), { cursor: 20, ids: [] }, '不回退')
  assert.deepEqual(applyMarkAllRead({ cursor: 5, ids: [30] }, 20), { cursor: 20, ids: [30] })
})

test('去重合并：乱序/重复/SSE 回放同语义，降序且截断，已读态不被新拉取覆盖', () => {
  const first = toNotifyItems([row(1, 'create'), row(3, 'claim')], EMPTY_READ_STATE)
  const read = applyReadState(first, { cursor: 3, ids: [] }) // 1,3 已读
  const incoming = toNotifyItems([row(3, 'claim'), row(4, 'transition'), row(2, 'advance')], EMPTY_READ_STATE)
  const merged = mergeNotifyItems(read, incoming, 10)
  assert.deepEqual(merged.map(i => i.seq), [4, 3, 2, 1], '降序且无重复')
  assert.equal(merged.find(i => i.seq === 3).read, true, '同 seq 以既有项为准（保留已读态）')
  // 截断
  assert.deepEqual(mergeNotifyItems(read, incoming, 2).map(i => i.seq), [4, 3])
  // 空 prev
  assert.deepEqual(mergeNotifyItems([], incoming, 10).map(i => i.seq), [4, 3, 2])
})

test('缺口检测：seq 跳变 → 需补齐；连续 → 不需；首帧建立基线不误报', () => {
  assert.equal(shouldRefill(0, [row(50, 'create')]), false, '尚无基线：首帧/回放不误报')
  assert.equal(shouldRefill(10, [row(11, 'create')]), false, '连续')
  assert.equal(shouldRefill(10, [row(12, 'create')]), true, '跳变 1 帧即判缺口')
  assert.equal(shouldRefill(10, [row(11, 'a'), row(14, 'b')]), true, '批内跳变')
  assert.equal(shouldRefill(10, []), false)
})

test('计数与过滤：未读数、分类计数、分类与仅未读过滤', () => {
  const items = toNotifyItems([
    row(1, 'create'), row(2, 'goal:publish'), row(3, 'space:update'), row(4, 'skill:grant'), row(5, 'hold'),
  ], EMPTY_READ_STATE)
  assert.equal(items.length, 5)
  assert.equal(unreadCount(items), 5)
  const readPart = applyReadState(items, { cursor: 2, ids: [] }) // seq 1,2 已读
  assert.equal(unreadCount(readPart), 3)
  const counts = categoryCounts(readPart)
  assert.deepEqual(counts.task, { total: 2, unread: 1 })   // create(已读) + hold(未读)
  assert.deepEqual(counts.goal, { total: 1, unread: 0 })   // goal:publish 已读
  assert.deepEqual(counts.space, { total: 1, unread: 1 })
  assert.deepEqual(counts.skill, { total: 1, unread: 1 })
  assert.deepEqual(counts.model, { total: 0, unread: 0 })
  assert.equal(filterItems(readPart, 'task').length, 2)
  assert.equal(filterItems(readPart, 'task', true).length, 1)
  assert.equal(filterItems(readPart, null).length, 5)
  assert.equal(filterItems(readPart, 'goal', true).length, 0)
  assert.equal(highestSeq(items), 5)
  assert.equal(highestSeq([]), 0)
})

test('已读存储键：per scope 隔离，空 scope 用 __all__（兼容旧键）；显式集合键独立', () => {
  assert.equal(notifyReadKey('software'), 'legion.notify.read.software')
  assert.equal(notifyReadKey(null), 'legion.notify.read.__all__')
  assert.equal(notifyReadIdsKey('software'), 'legion.notify.readseq.software')
  assert.equal(notifyReadIdsKey(null), 'legion.notify.readseq.__all__')
  assert.notEqual(notifyReadKey('software'), notifyReadIdsKey('software'))
})

test('通知项形状：稳定 id、白名单过滤、字段透传（含 goalId）', () => {
  const items = toNotifyItems([
    row(7, 'goal:slices', { goalId: 'G-9', taskId: 'T-9', detail: { to: 'blocked' } }),
    row(8, 'chat:message'),
  ], EMPTY_READ_STATE)
  assert.equal(items.length, 1)
  const it = items[0]
  assert.equal(it.id, 'software:7')
  assert.equal(it.goalId, 'G-9')
  assert.equal(it.taskId, 'T-9')
  assert.deepEqual(it.jump, { kind: 'goal', ref: 'G-9' }, 'goal: 动作域优先（即使带 taskId）')
  assert.equal(it.priority, 'normal', 'goal:slices 为 normal')
  assert.equal(it.label, notifyLabel('goal:slices'))
  assert.equal(it.read, false)
})
