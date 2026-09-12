// scripts/prt/baseline-snapshot.test.mjs — PRT-007 平台契约基线提取器单测
//
// 重点不是「能提取出东西」，而是：
//   ① 四种书写顺序都要认全——漏一种就会少记一半端点，基线随即失去对拍价值；
//   ② 提取失败必须**抛错**而不是记录空基线（空基线会让后续 diff 全成噪音）；
//   ③ diff 能定位到具体路由/表/状态边，而不只是「有变化」；
//   ④ 当前仓库提取结果与已记录基线一致（无未记录的漂移）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertSchemaCoverage,
  buildSnapshot,
  diffSnapshots,
  extractPermissionModes,
  extractRouteOccurrences,
  extractRoutes,
  extractStringArray,
  extractTables,
  extractTransitions,
  findSchemaCreatingFiles,
  REPO_ROOT,
  SCHEMA_SCAN_DIRS,
  SCHEMA_SOURCE_FOR,
  SCHEMA_SOURCE_PATHS,
  findOpaqueRouteGuards,
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

test('⑤ **每个建表模块都登记进了 schema 采集**（漏登记 = 那张表对基线不可见）', () => {
  // 背景：`dbTables` 曾经只扫 server.mjs，于是 run-store.mjs 的四张表
  // 与 model-store.mjs 的 model_profiles 对基线完全不可见——`--check` 报
  // "无漂移"，而真实 schema 已经多了五张。一个看不见某类变更的棘轮比没有
  // 棘轮更坏：它给出"已核对过"的错觉。
  //
  // **这条检查的实现已经搬进工具本身**（`assertSchemaCoverage`），
  // 并由 `buildSnapshot()` 调用，所以 `--check` 与 `--record` 都会先撞上它。
  // 原因是一次真实的双层失效：`--check` 报"无漂移"而本用例会红——
  // 两者都对，但**人跑门禁时拿到的是绿灯**。本项目纪律是
  // 「一道没人必须记得的闸门才是能守住的闸门」，所以这里只断言"工具确实在查"，
  // 不再自己再实现一遍（两份实现会漂移，而那正是被检查的东西）。
  const r = assertSchemaCoverage()
  assert.ok(r.found >= 5, `只扫到 ${r.found} 个建表文件，扫描目录可能已与仓库结构脱节`)
  assert.ok(r.registered >= 6, `只登记了 ${r.registered} 个 schema 源`)
  // 六个建表模块必须都在扫到的集合里——否则"扫到了但没建表"这类错会被反向检查
  // 当成"列表老化"，报出一个方向完全相反的结论。
  const found = findSchemaCreatingFiles()
  for (const p of SCHEMA_SOURCE_PATHS) {
    assert.ok(found.includes(resolve(p)), `${p} 未被 findSchemaCreatingFiles 扫到`)
  }

  // **反向验证必须真的生效。**
  // 第一版这里写的是 `SCHEMA_SOURCES.length = 0; push('server')` ——而那**什么都没改**：
  // `SCHEMA_SOURCE_PATHS` 是模块加载时算好的快照，运行时改 `SCHEMA_SOURCES`
  // 影响不到它。于是 `assert.throws` 拿到了"没抛"，用例红了——
  // **是这条断言抓住了"我的变红手法没生效"**。
  // （同族：一个没生效的变红验证，和一个通过的验证，在输出上完全一样。）
  // 现在改成注入一个被削减的登记表，走的是同一条实现。
  assert.throws(
    () => assertSchemaCoverage({ registeredPaths: [SCHEMA_SOURCE_PATHS[0]] }),
    /未登记进 SCHEMA_SOURCES/,
    '漏登记一个建表模块时，覆盖率检查必须红',
  )
  assert.throws(
    () => assertSchemaCoverage({ registeredPaths: [...SCHEMA_SOURCE_PATHS, join(REPO_ROOT, 'team-hub', 'ghost.mjs')] }),
    /不再建表/,
    '登记了一个不建表的文件时，反向检查必须红',
  )
})

test('⑦ **用常量做路径守卫的路由必须被拒绝，而不是静默漏掉**', () => {
  // 这是一次真实事故（PRT-507）。抽取正则要求路径是**字符串字面量**，而
  // 源码里很容易写成 `path.startsWith(MODEL_PREFIX)`。当时那条新路由
  // `/api/model-profiles/:id/probe` 就是这样写的：
  //
  //   * `--record` 报「125 条」，与改动前**一模一样**；
  //   * `--check` 说「与基线一致」；
  //   * 端到端请求完全正常。
  //
  // 也就是说：**一条真实的 HTTP 端点，从平台契约里彻底消失了，而所有闸门都是绿的。**
  // 这正是本仓库记过的那条——**一道看不见某类改动的闸门，比没有闸门更危险**，
  // 因为它给人"已经守住了"的错觉。
  //
  // 修法不是"记得用字面量"（那是靠人记），而是让抽取器**主动拒绝**这种写法。
  const opaque = [
    "const MODEL_PREFIX = '/api/model-profiles/'",
    "if (req.method === 'POST' && path.startsWith(MODEL_PREFIX)) { }",
  ].join('\n')
  assert.deepEqual(findOpaqueRouteGuards(opaque), ['MODEL_PREFIX'], '必须认出常量守卫')
  assert.throws(() => extractRoutes(opaque, { min: 0 }), /常量/, '必须抛错，而不是安静地少一条')

  // 反方向也要守：字面量不该被误报（否则这条闸门会因为正确代码而红）
  assert.deepEqual(findOpaqueRouteGuards("if (req.method === 'GET' && path.startsWith('/api/x/')) { }"), [])
  // 普通变量的路径比较不是"路由常量"，不该被误报
  assert.deepEqual(findOpaqueRouteGuards("if (req.method === 'GET' && path === somePath) { }"), [])
})

test('⑥ **同一条路由不得被写两次**（后写的会静默遮蔽先写的）', () => {
  // 为什么这条必须单独存在：`extractRoutes` 返回的是 `Set`，重复的路由被静默
  // 合并成一条。于是"新增了一条与既有路由同名的路由"在 `--check` 的 diff 里
  // **完全看不出来**，而先写那条已经变成不可达的死代码。
  //
  // 实测（PRT-503）：费用预算账本一度也用 `GET /api/runtime/budget`，
  // 而该路径已被 PRT-309 的**重试预算**读面占用。基线报"无漂移"，
  // 但 `run-plane` 的"还能自动重试几次"读面已经永久返回错误结构
  // ——它的字段从 `budget.attemptsUsed` 变成了 `reservations`。
  const occ = extractRouteOccurrences(readFileSync(SCHEMA_SOURCE_FOR.server, 'utf8'))
  const dupes = occ.filter((r) => r.count > 1)
  assert.deepEqual(
    dupes.map((d) => `${d.route} ×${d.count}`), [],
    '这些路由被写了不止一次：后写的那条会遮蔽先写的，先写的那条成为死代码。\n' +
    '请给新的那条换一个路径（两个不同的业务概念不应共用同一个 URL）。',
  )
  // 抽取器本身要能看见重复——否则这条用例会假绿
  const synthetic = `
    if (req.method === 'GET' && path === '/api/x') { a() }
    if (req.method === 'GET' && path === '/api/x') { b() }
    if (req.method === 'POST' && path === '/api/x') { c() }
  `
  const s = extractRouteOccurrences(synthetic)
  assert.deepEqual(s, [
    { route: 'GET /api/x', count: 2 },
    { route: 'POST /api/x', count: 1 },
  ], '抽取器必须给出真实次数（按次数降序）')
})

test('④ 基线含源文件哈希，可把漂移归因到文件', () => {  const recorded = JSON.parse(readFileSync(BASELINE, 'utf8'))
  assert.ok(Object.keys(recorded.sources).length >= 2)
  for (const [file, hash] of Object.entries(recorded.sources)) {
    assert.match(hash, /^[0-9a-f]{64}$/, `${file} 的哈希形态不对`)
  }
})
