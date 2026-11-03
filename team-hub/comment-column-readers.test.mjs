// team-hub/comment-column-readers.test.mjs
// ============================================================================
// F0 · B 段前置：**还在直接读三列的地方有多少**（设计稿 §11.4 / D3 决策）
//
// 删 `tasks.comments/evidence/feedback` 的前提是"读取点收敛"。这件事不能靠感觉，
// 要有可观测的数：本模块就是一个**计数器**，不是门——它只回答"现在有几处"。
//
// 判据：
//   · 认得出直接读（`t.comments` / `SELECT comments` / `JSON.parse(x.comments)`）
//   · 认得出间接读（解构、别名）与 SQL 里的列名
//   · **不**把投影模块（task-input 的 projectField/syncField）算成读取点
//   · 不把测试与 DDL 算成线上读取点
//   · 阈值判断：< 5 处 ⇒ readyToDrop（仅作提示，不自动删）
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyReadSites, DROP_THRESHOLD } from './scripts/comment-column-readers.mjs'

const file = (path, text) => ({ path, text })

test('① 认得出直接读：属性访问 / 解构 / JSON.parse', () => {
  const out = classifyReadSites([
    file('team-hub/render.mjs', 'const list = t.comments ?? []'),
    file('team-hub/detail.mjs', 'const { comments, evidence } = task'),
    file('scrum/panel.mjs', 'const rows = JSON.parse(task.comments || "[]")'),
  ])
  assert.equal(out.sites.length, 3)
  assert.deepEqual(out.columns.sort(), ['comments', 'evidence'])
})

test('② 认得出 SQL 里的列名', () => {
  const out = classifyReadSites([
    file('team-hub/query.mjs', "db.prepare('SELECT id, comments, feedback FROM tasks WHERE id=?')"),
  ])
  assert.equal(out.sites.length, 1)
  assert.equal(out.sites[0].column, 'comments')
})

test('③ 不把投影模块算成读取点（它是写点，且是收敛的终点）', () => {
  const out = classifyReadSites([
    file('team-hub/task-input.mjs', 'const actual = JSON.stringify(parseArray(task[field]))'),
  ])
  assert.deepEqual(out.sites, [], '★ 投影模块本身不是"待收敛的读取点"')
})

test('④ 不把测试文件与 DDL 算成线上读取点', () => {
  const out = classifyReadSites([
    file('team-hub/comment-routes.test.mjs', 'assert.equal(t.comments.length, 1)'),
    file('team-hub/server.mjs', 'comments TEXT DEFAULT \'[]\''),
  ])
  assert.deepEqual(out.sites, [], '★ 测试与建表语句不算读取点')
})

test('⑤ 阈值：< 5 处才算"可以删列"', () => {
  const few = classifyReadSites([file('a.mjs', 't.comments')])
  assert.equal(few.readyToDrop, few.sites.length < DROP_THRESHOLD)
  const many = classifyReadSites(Array.from({ length: DROP_THRESHOLD }, (_, i) => file(`f${i}.mjs`, 't.feedback')))
  assert.equal(many.readyToDrop, false, '★ 达到阈值就不算收敛')
})

test('⑥ 行号可定位（要能直接跳到现场）', () => {
  const out = classifyReadSites([file('a.mjs', 'line1\nline2\nt.comments\n')])
  assert.equal(out.sites[0].line, 3)
})
