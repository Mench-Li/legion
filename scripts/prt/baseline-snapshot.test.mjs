// scripts/prt/baseline-snapshot.test.mjs — PRT-007 平台契约基线提取器单测
//
// 重点不是「能提取出东西」，而是：
//   ① 四种书写顺序都要认全——漏一种就会少记一半端点，基线随即失去对拍价值；
//   ② 提取失败必须**抛错**而不是记录空基线（空基线会让后续 diff 全成噪音）；
//   ③ diff 能定位到具体路由/表/状态边，而不只是「有变化」；
//   ④ 当前仓库提取结果与已记录基线一致（无未记录的漂移）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildSnapshot,
  diffSnapshots,
  extractPermissionModes,
  extractRoutes,
  extractStringArray,
  extractTables,
  extractTransitions,
} from './baseline-snapshot.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const BASELINE = join(ROOT, 'docs', 'superpowers', 'prt', 'prt-007-baseline.json')

// ---------------------------------------------------------------- ① 抽取顺序

test('① 四种书写顺序都能提取到路由', () => {
  const src = `
    if (req.method === 'GET' && path === '/api/a') {}
    if (path === '/api/b' && req.method === 'POST') {}
    if (req.method === 'PUT' && path.startsWith('/api/c/')) {}
    if (path.startsWith('/api/d/') && req.method === 'DELETE') {}
  `
  const routes = extractRoutes(src, { min: 1 })
  assert.deepEqual(routes, [
    'DELETE /api/d/',
    'GET /api/a',
    'POST /api/b',
    'PUT /api/c/',
  ])
})
test('① 非 /api/ 路径（静态资源、内部路径）不进入平台契约', () => {
  const src = `
    if (req.method === 'GET' && path === '/index.html') {}
    if (req.method === 'GET' && path === '/api/real') {}
    if (req.method === 'GET' && path === '/api/real2') {}
    if (req.method === 'GET' && path === '/api/real3') {}
    if (req.method === 'GET' && path === '/api/real4') {}
    if (req.method === 'GET' && path === '/api/real5') {}
    if (req.method === 'GET' && path === '/api/real6') {}
    if (req.method === 'GET' && path === '/api/real7') {}
    if (req.method === 'GET' && path === '/api/real8') {}
    if (req.method === 'GET' && path === '/api/real9') {}
    if (req.method === 'GET' && path === '/api/real10') {}
  `
  const routes = extractRoutes(src)
  assert.ok(routes.every((r) => r.includes('/api/')))
  assert.equal(routes.length, 10)
})

test('① 同一路由重复声明只记一次', () => {
  const src = Array.from({ length: 11 }, () => "if (req.method === 'GET' && path === '/api/same') {}").join('\n')
  assert.deepEqual(extractRoutes(src, { min: 1 }), ['GET /api/same'])
})

test('① 路由数量崩到阈值以下必须抛错（抽取规则脱节的早期信号）', () => {
  assert.throws(() => extractRoutes("if (req.method === 'GET' && path === '/api/only') {}"), /抽取规则可能已与源码脱节/)
})

// ---------------------------------------------------------------- ② 失败要响

test('② 表数量过少抛错而不是记录空基线', () => {
  assert.throws(() => extractTables('CREATE TABLE IF NOT EXISTS tasks (id TEXT)'), /抽取规则可能已与源码脱节/)
  // 同一护栏在夹具上可通过 min 放宽，证明它是「护栏」而非「解析限制」
  assert.deepEqual(extractTables('CREATE TABLE IF NOT EXISTS tasks (id TEXT)', { min: 1 }), ['tasks'])
})

test('② 找不到目标字面量时抛错', () => {
  assert.throws(() => extractStringArray('const OTHER = []', 'STATUSES'), /找不到 STATUSES/)
  assert.throws(() => extractTransitions('const OTHER = {', 'TRANSITIONS'), /找不到 TRANSITIONS/)
  assert.throws(() => extractPermissionModes('const X = 1'), /找不到 MODES/)
})

test('② 状态数组解析出预期内容', () => {
  const s = "const STATUSES = ['backlog', 'todo', 'done']"
  assert.deepEqual(extractStringArray(s, 'STATUSES'), ['backlog', 'todo', 'done'])
})

test('② 迁移表解析成「状态 → 排序后的目标集合」', () => {
  const src = `
const TRANSITIONS = {
  backlog: ['todo', 'canceled'],
  todo: ['in_progress'],
  in_progress: ['in_review'],
  in_review: ['done'],
  done: [],
}
`
  const t = extractTransitions(src, 'TRANSITIONS')
  assert.deepEqual(t.backlog, ['canceled', 'todo'], '目标状态必须排序，否则 diff 会有假漂移')
  assert.deepEqual(t.done, [])
})

// ---------------------------------------------------------------- ③ diff 定位

const SNAP = (over = {}) => ({
  version: 1,
  sources: { 'a.mjs': 'h1' },
  httpRoutes: ['GET /api/a'],
  dbTables: ['tasks'],
  taskStatuses: ['todo'],
  taskTransitions: { todo: ['done'] },
  goalStatuses: ['active'],
  permissionModes: ['ask'],
  ...over,
})

test('③ 无差异时返回空', () => {
  assert.deepEqual(diffSnapshots(SNAP(), SNAP()), [])
})

test('③ 路由增删被逐条列出', () => {
  const lines = diffSnapshots(SNAP(), SNAP({ httpRoutes: ['GET /api/a', 'POST /api/b'] }))
  assert.equal(lines.length, 1)
  assert.match(lines[0], /\+ 路由: POST \/api\/b/)
})

test('③ 数据表与状态增删被归类', () => {
  const lines = diffSnapshots(SNAP(), SNAP({ dbTables: ['tasks', 'goals'], taskStatuses: ['todo', 'done'] }))
  assert.ok(lines.some((l) => /\+ 数据表: goals/.test(l)))
  assert.ok(lines.some((l) => /\+ 任务状态: done/.test(l)))
})

test('③ 迁移边差异定位到具体状态', () => {
  const lines = diffSnapshots(SNAP(), SNAP({ taskTransitions: { todo: ['done', 'blocked'] } }))
  assert.equal(lines.length, 1)
  assert.match(lines[0], /\+ 迁移 todo: blocked/)
})

test('③ 源文件哈希变化单独提示（需人工判断是否契约变化）', () => {
  const lines = diffSnapshots(SNAP(), SNAP({ sources: { 'a.mjs': 'h2' } }))
  assert.equal(lines.length, 1)
  assert.match(lines[0], /源文件已变更/)
})

// ---------------------------------------------------------------- ④ 与仓库现状对账

test('④ 已记录基线存在，且当前提取结果与之一致（无未记录漂移）', () => {
  assert.ok(existsSync(BASELINE), '缺少 docs/superpowers/prt/prt-007-baseline.json，请先 --record')
  const recorded = JSON.parse(readFileSync(BASELINE, 'utf8'))
  const current = buildSnapshot()
  const lines = diffSnapshots(recorded, current)
  assert.deepEqual(lines, [], `平台契约已漂移但基线未刷新：\n${lines.join('\n')}`)
})

test('④ 基线不含时间戳（否则每次 diff 都会假红）', () => {
  const recorded = JSON.parse(readFileSync(BASELINE, 'utf8'))
  const flat = JSON.stringify(recorded)
  assert.doesNotMatch(flat, /generatedAt|timestamp|\d{4}-\d{2}-\d{2}T/)
})

test('④ 基线含源文件哈希，可把漂移归因到文件', () => {
  const recorded = JSON.parse(readFileSync(BASELINE, 'utf8'))
  assert.ok(Object.keys(recorded.sources).length >= 2)
  for (const [file, hash] of Object.entries(recorded.sources)) {
    assert.match(hash, /^[0-9a-f]{64}$/, `${file} 的哈希形态不对`)
  }
})
