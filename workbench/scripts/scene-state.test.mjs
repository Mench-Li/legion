import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveSceneCues, projectSceneAgents } from '../src/scene/sceneState.ts'
import * as sceneState from '../src/scene/sceneState.ts'

const agent = (role, external = false) => ({ role, name: role, scope: 'lab', external, avatar: '🤖', tasks: [], mode: 'idle' })
const task = (id, role, status, extra = {}) => ({ id, role, soldier: role, status, scope: 'lab', blockedBy: [], goalId: null, ...extra })
const event = (seq, taskId, action = 'transition') => ({ seq, taskId, action, scope: 'lab', ts: new Date(1000).toISOString(), payload: action === 'transition' ? { to: 'done' } : action === 'claim' ? { soldier: 'qa' } : {} })

test('3D 场景的当前目标进度优先取活动目标，其次暂停目标，不把历史目标当当前目标', () => {
  const currentGoalProgress = sceneState.currentGoalProgress
  assert.equal(typeof currentGoalProgress, 'function')
  assert.equal(currentGoalProgress([
    { status: 'done', percent: 100 },
    { status: 'paused', percent: 42 },
    { status: 'active', percent: 88 },
  ]), 88)
  assert.equal(currentGoalProgress([{ status: 'done', percent: 100 }, { status: 'paused', percent: 42 }]), 42)
  assert.equal(currentGoalProgress([{ status: 'done', percent: 100 }, { status: 'canceled', percent: 0 }]), null)
})

test('状态优先级、稳定身份、临时成员和焦点任务', () => {
  const roster = [agent('dev'), agent('runner', true)]
  const tasks = [task('z', 'dev', 'in_progress'), task('b', 'dev', 'in_review'), task('a', 'dev', 'blocked'), task('x', 'other', 'in_progress', { soldier: 'runner' }), task('duplicate', 'dev', 'in_progress', { soldier: 'runner' })]
  const first = projectSceneAgents('lab', roster, tasks)
  assert.equal(first[0].key, 'lab\0dev')
  assert.equal(first[0].mode, 'blocked')
  assert.equal(first[0].focusTaskId, 'a')
  assert.equal(first[1].mode, 'busy')
  assert.equal(first[1].focusTaskId, 'x')
  assert.deepEqual(first[1].taskIds, ['x'])
  assert.equal(projectSceneAgents('lab', roster, [tasks[0]])[0].appearanceSeed, first[0].appearanceSeed)
  assert.equal(projectSceneAgents('lab', roster, [task('r', 'dev', 'in_review'), task('w', 'dev', 'in_progress')])[0].mode, 'review')
  assert.equal(projectSceneAgents('lab', roster, [task('w', 'dev', 'todo')])[0].mode, 'idle')
  assert.equal(projectSceneAgents('lab', roster, [task('a', 'dev', 'done'), task('z', 'dev', 'todo')])[0].focusTaskId, 'z')
})

test('完成提示只由当前可见空间里新转 done 且有近期事件的任务触发', () => {
  const roster = [agent('dev')]
  const before = { scope: 'lab', roster, tasks: [task('one', 'dev', 'in_progress')] }
  const after = { ...before, tasks: [task('one', 'dev', 'done')] }
  assert.equal(deriveSceneCues(null, after, [event(1, 'one')], 1500, true).length, 0)
  assert.equal(deriveSceneCues(before, after, [event(1, 'one')], 1500, false).length, 0)
  assert.equal(deriveSceneCues(before, after, [event(1, 'one')], 11000, true).length, 0)
  assert.equal(deriveSceneCues(before, after, [event(1, 'one')], 1500, true)[0].kind, 'completed')
  assert.equal(deriveSceneCues(before, after, [{ ...event(1, 'one'), scope: 'other' }], 1500, true).length, 0)
  assert.equal(deriveSceneCues(before, { ...after, tasks: [task('one', 'dev', 'in_review')] }, [event(1, 'one')], 1500, true).length, 0)
  assert.equal(deriveSceneCues(before, after, [{ ...event(1, 'one'), payload: { to: 'in_review' } }], 1500, true).length, 0)
  assert.equal(deriveSceneCues(before, after, [event(1, 'one', 'claim')], 1500, true).length, 0)
})

test('交接要求同目标、明确双人归属及真实依赖认领', () => {
  const roster = [agent('dev'), agent('qa')]
  const prior = task('one', 'dev', 'done', { goalId: 'g' })
  const next = task('two', 'qa', 'in_progress', { goalId: 'g', blockedBy: ['one'] })
  const before = { scope: 'lab', roster, tasks: [prior, { ...next, status: 'todo' }] }
  const after = { ...before, tasks: [prior, next] }
  const e = event(2, 'two', 'claim')
  assert.equal(deriveSceneCues(before, after, [e], 1500, true)[0].kind, 'handoff')
  assert.equal(deriveSceneCues(before, { ...after, tasks: [prior, { ...next, goalId: 'other' }] }, [e], 1500, true).length, 0)
  assert.equal(deriveSceneCues(before, { ...after, roster: [agent('dev')] }, [e], 1500, true).length, 0)
  assert.equal(deriveSceneCues(before, { ...after, tasks: [prior, { ...next, blockedBy: [] }] }, [e], 1500, true).length, 0)
  assert.equal(deriveSceneCues(before, { ...after, tasks: [{ ...prior, scope: 'other' }, next] }, [e], 1500, true).length, 0)
  assert.equal(deriveSceneCues(before, after, [{ ...e, payload: { soldier: 'other' } }], 1500, true).length, 0)
})

// ── 气泡要显示"他的所有在办任务"，所以投影里必须带清单 ──────────────────────
// ★ 2026-10-14（将军："已完成的就不要显示了"）：这份清单只含**还没结束**的任务。
test('★ 投影带上全部**在办**任务的 chips：编号、状态、按"最要紧优先"排序，已完成与已取消都不出现', () => {
  const roster = [agent('dev')]
  const titled = (id, status, title, extra = {}) => ({ ...task(id, 'dev', status, extra), title })
  const tasks = [
    titled('T-9', 'canceled', '已取消的'),
    titled('T-5', 'done', '做完了的'),
    titled('T-3', 'todo', '还没开始的'),
    titled('T-1', 'blocked', '卡住的'),
    titled('T-2', 'in_review', '等验收的'),
    titled('T-4', 'in_progress', '在做的'),
    titled('T-6', 'other', '别人的', { role: 'other' }),
    titled('T-7', 'done', '也做完了的'),
  ]
  const [dev] = projectSceneAgents('lab', roster, tasks)
  assert.deepEqual(dev.tasks.map(t => t.id), ['T-1', 'T-2', 'T-4', 'T-3'],
    '受阻 → 待验收 → 进行中 → 待办；已完成与已取消都不进场景')
  assert.deepEqual(dev.tasks.map(t => t.title), ['卡住的', '等验收的', '在做的', '还没开始的'],
    '标题要带出来 —— 气泡平时只显示编号，悬浮时才展示它')
  assert.equal(dev.tasks.find(t => t.id === 'T-1').status, 'blocked')
  assert.equal(dev.taskCount, 4, '计数与 chips 必须同源（否则气泡里"4 项"却只列出 3 条）')
  assert.deepEqual(dev.taskIds, dev.tasks.map(t => t.id))
  assert.equal(dev.focusTaskId, 'T-1')
  assert.equal(dev.focusTitle, '卡住的')
  assert.equal(dev.mode, 'blocked', '气色取最要紧那件事')
  // 同一份事实两次投影必须逐字一致（气泡悬浮时会重算，抖动会让人以为任务变了）
  assert.deepEqual(projectSceneAgents('lab', roster, tasks)[0].tasks, dev.tasks)
})

test('★ 只剩已完成 ⇒ 场景当"没有任务"（气色回待命、计数归零）', () => {
  const done = projectSceneAgents('lab', [agent('dev')], [{ ...task('T-1', 'dev', 'done'), title: '收尾' }])[0]
  assert.deepEqual(done.tasks, [], '已完成的按需求不显示')
  assert.equal(done.taskCount, 0, '计数跟着归零（否则气泡写"1 项"却一条都列不出来）')
  assert.equal(done.focusTaskId, null)
  assert.equal(done.mode, 'idle', '没有在办的任务 ⇒ 气色回待命')
})

test('★ 空任务：气泡仍要有话说（不是空白）', () => {
  const [none] = projectSceneAgents('lab', [agent('dev')], [])
  assert.deepEqual(none.tasks, [])
  assert.equal(none.taskCount, 0)
  assert.equal(none.focusTitle, null, '没有任务就是没有，不编一句假的')
  assert.equal(none.mode, 'idle')
})
