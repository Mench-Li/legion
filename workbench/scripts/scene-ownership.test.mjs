import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tasksForRosterAgent } from '../src/scene/agentOwnership.ts'

const task = (id, role, soldier, status = 'in_progress') => ({ id, role, soldier, status })
const agent = (role, external = false) => ({ role, external })

test('编队岗位按任务角色归属，取消任务不出现', () => {
  const tasks = [task('a', 'developer', 'runner'), task('b', null, 'developer'), task('c', 'tester', 'developer'), task('d', 'developer', null, 'canceled')]
  assert.deepEqual(tasksForRosterAgent(agent('developer'), tasks).map(t => t.id), ['a', 'b'])
})

test('未入编执行者按 soldier 归属，即使任务角色不同', () => {
  const tasks = [task('a', 'developer', 'runner'), task('b', 'tester', 'runner'), task('c', 'runner', 'other')]
  assert.deepEqual(tasksForRosterAgent(agent('runner', true), tasks).map(t => t.id), ['a', 'b'])
})

test('临时执行者不重复拿走已归属正式编队岗位的任务', () => {
  const roster = [agent('developer'), agent('runner', true)]
  const tasks = [task('a', 'developer', 'runner'), task('b', 'tester', 'runner')]
  assert.deepEqual(tasksForRosterAgent(roster[0], tasks, roster).map(t => t.id), ['a'])
  assert.deepEqual(tasksForRosterAgent(roster[1], tasks, roster).map(t => t.id), ['b'])
})
