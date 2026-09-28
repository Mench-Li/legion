import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveSceneCues, projectSceneAgents } from '../src/scene/sceneState.ts'

const agent = (role, external = false) => ({ role, name: role, scope: 'lab', external, avatar: '🤖', tasks: [], mode: 'idle' })
const task = (id, role, status, extra = {}) => ({ id, role, soldier: role, status, scope: 'lab', blockedBy: [], goalId: null, ...extra })
const event = (seq, taskId, action = 'transition') => ({ seq, taskId, action, scope: 'lab', ts: new Date(1000).toISOString(), payload: action === 'transition' ? { to: 'done' } : action === 'claim' ? { soldier: 'qa' } : {} })

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
