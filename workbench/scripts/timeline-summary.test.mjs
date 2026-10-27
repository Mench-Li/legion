// workbench/scripts/timeline-summary.test.mjs
// ---------------------------------------------------------------------------
// `timelineSummary.ts` 的判据（T2.2）。
//
// 这一组盯的是三件**看起来都对**的事：
//   ① 摘要会不会把关键事件一起压掉（返工/验证判词正是用户回来看的原因）；
//   ② 首拉与 SSE 增量重叠时会不会显示两条一模一样的事件（看起来像"做了两次"）；
//   ③ 增量追加后会不会乱序（乱序的时间线会让人怀疑顺序错了）。
//
// 运行：node workbench/scripts/timeline-summary.test.mjs
// ---------------------------------------------------------------------------
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  belongsToTask, mergeTimeline, summarizeTimeline, timelineHeadline,
} from '../src/timelineSummary.ts'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

let seq = 0
const ev = (action, over = {}) => ({ seq: ++seq, ts: `2026-10-27T10:00:${String(seq).padStart(2, '0')}Z`, member: 'worker', scope: 'software', action, taskId: 'T-1', detail: {}, ...over })

const reset = () => { seq = 0 }

test('① ★★★ 相邻的进度心跳折叠成一条，但返工/验证判词一条都不许丢', () => {
  reset()
  const events = [
    ev('claim'),
    ...Array.from({ length: 20 }, () => ev('progress')),
    ev('rework'),
    ev('runtime:validation'),
    ev('comment'),
  ]
  const entries = summarizeTimeline(events)
  // 20 条 progress 折成 1 条（repeat=20），其余不动。
  const progress = entries.filter((e) => e.action === 'progress')
  assert.equal(progress.length, 1, '★★ 相邻心跳必须折叠')
  assert.equal(progress[0].repeat, 20)
  assert.equal(progress[0].foldedSeqs.length, 19, '★ 被折叠的 seq 要留着，供展开')
  for (const action of ['claim', 'rework', 'runtime:validation', 'comment']) {
    assert.equal(entries.filter((e) => e.action === action).length, 1, `★★ ${action} 不许被折叠或丢掉`)
  }
  // 折叠后条数从 24 降到 5。
  assert.equal(entries.length, 5)
})

test('② ★★★ 首拉与 SSE 增量重叠：同一 seq 只显示一次，且保留先来的那份', () => {
  reset()
  const first = [ev('claim'), ev('transition')]
  // SSE 又送来同一条 transition（历史里已有），外加一条新的。
  const overlapping = [{ ...first[1], member: '来自增量' }, ev('comment')]
  const merged = mergeTimeline(first, overlapping)
  assert.equal(merged.length, 3, '★★ 同 seq 必须去重（否则看起来像做了两次）')
  assert.equal(merged.filter((e) => e.seq === first[1].seq).length, 1)
  assert.equal(merged.find((e) => e.seq === first[1].seq).member, 'worker', '★ 保留先来的那份（首次拉取是权威历史）')
})

test('③ ★★★ 增量追加后必须仍按 seq 升序（乱序 = 用户怀疑顺序错了）', () => {
  reset()
  const a = [ev('claim'), ev('transition')]
  const late = [ev('comment'), ev('rework')]
  // 故意把增量顺序打乱。
  const merged = mergeTimeline(a, [late[1], late[0]])
  const seqs = merged.map((e) => e.seq)
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y), '★★ 合并结果必须有序')
})

test('④ 真正的重复派发是两条，不是一条：不同 seq 的同类事件不合并', () => {
  reset()
  const events = [ev('rework'), ev('comment'), ev('rework')]
  const entries = summarizeTimeline(events)
  assert.equal(entries.filter((e) => e.action === 'rework').length, 2,
    '★★ 只有**相邻**才折叠——隔开两次返工是两次，不是"×2"')
})

test('⑤ ★★★ 条数上限只砍可折叠项，关键事件一条都不因上限消失', () => {
  reset()
  const events = [
    ev('rework'), ev('runtime:validation'), ev('rework:chain'),
    ...Array.from({ length: 30 }, (_, i) => ev('progress', { taskId: 'T-1' })),
    ev('goal:publish'),
  ]
  const entries = summarizeTimeline(events, 5)
  for (const action of ['rework', 'runtime:validation', 'rework:chain', 'goal:publish']) {
    assert.equal(entries.filter((e) => e.action === action).length, 1,
      `★★ ${action} 是关键的，不许因为"只留 5 条"被截掉`)
  }
})

test('⑥ 只收本任务的事件（SSE 是 scope 级流）', () => {
  reset()
  const mine = ev('claim', { taskId: 'T-1' })
  const other = ev('claim', { taskId: 'T-2' })
  assert.equal(belongsToTask(mine, 'T-1'), true)
  assert.equal(belongsToTask(other, 'T-1'), false)
  assert.equal(belongsToTask({ ...mine, taskId: null }, 'T-1'), false, '★ 没有归属的不猜')
})

test('⑦ 头部摘要：返工/验证次数要说得出来，折叠了什么也要说', () => {
  reset()
  const entries = summarizeTimeline([
    ev('rework'), ev('agent-workflow:review-rework'),
    ev('runtime:validation'),
    ev('progress'), ev('progress'), ev('progress'),
  ])
  const headline = timelineHeadline(entries)
  assert.match(headline, /返工 2 次/)
  assert.match(headline, /验证 1 次/)
  assert.match(headline, /已折叠 2 条杂项/)
  assert.equal(timelineHeadline([]), '暂无记录')
})

test('⑧ 没有 seq 的老数据不许丢，也不许伪造序号', () => {
  const legacy = { ts: '2026-01-01T00:00:00Z', member: 'x', scope: 's', action: 'comment', taskId: 'T-1', detail: {} }
  const merged = mergeTimeline([legacy], [])
  assert.equal(merged.length, 1, '★ 无法定位也要保留')
  const entries = summarizeTimeline(merged)
  assert.ok(Number.isNaN(entries[0].seq), '★★ 缺失的 seq 是 NaN，不是 0（0 看起来像"第一条"）')
})

test('⑨ 空输入安全：不抛、返回空数组', () => {
  assert.deepEqual(mergeTimeline([], []), [])
  assert.deepEqual(summarizeTimeline([]), [])
})

test('⑩ ★★★ 接线守卫：任务详情真的订阅了既有事件流，且不重拉整表', () => {
  // 纯函数测不到"有没有接上"——而"写好了但没接线"是本仓反复出现的完成态。
  const source = readFileSync(join(SRC, 'components', 'TaskDetailModal.tsx'), 'utf8')
  assert.match(source, /subscribeHubAudit\(/, '★★ 必须订阅既有 /api/events（不新增第二种事件源）')
  assert.match(source, /belongsToTask\(/, '★★ 必须按 taskId 过滤：scope 级流会把别人的事件也送来')
  assert.match(source, /mergeTimeline\(/, '★★ 增量必须走去重合并，不能直接 push')
  // 反例守卫：既有的 `hubEventStream` 之外再开一条流会让两个游标各说各话。
  assert.doesNotMatch(source, /new EventSource\(/, '★★ 不许自己再开一条 EventSource')

  const summary = readFileSync(join(SRC, 'timelineSummary.ts'), 'utf8')
  // 判据本身：关键动作集合里必须有返工与验证判词。
  assert.match(summary, /'rework'/, '★★ 返工是关键事件')
  assert.match(summary, /'runtime:validation'/, '★★ 验证判词是关键事件')
})
