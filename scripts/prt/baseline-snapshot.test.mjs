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
  assertRouteFamilyCoverage,
  extractDeclaredRoutes,
  ROUTE_FAMILY_SOURCES,
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

test('① 数量下限这道**机制**仍然可用（显式给 min 时照样抛）', () => {
  assert.throws(() => extractRoutes("if (req.method === 'GET' && path === '/api/only') {}", { min: 5 }),
    /抽取规则可能已与源码脱节/)
})

// ★★★★★ 2026-09-20（切片 49）：下面这条**取代**了原来那条
//   「路由数量崩到阈值以下必须抛错」——它断言的是**默认下限**，而那个默认下限
//   被 PRT-316 自己追上了**两次**（切片 45 剩 9 条撞下限 10；切片 49 剩 4 条撞下限 5），
//   于是默认值改成 **0**（不再设绝对下限），那道断言必然不再成立。
//
//   ★★★ 但**不能**因此就把这条判据删掉充数：真正要守的是"搬家没搬丢"。
//     接替它的判据在下面这条 —— 抽取器脱节时，`server.mjs` 那部分会**塌**，
//     而这个并集（`snapshot()` 里 `httpRoutes` 的拼法）就会**少掉**那些路由。
//     这道判据**不依赖任何魔数，剩下 0 条时也成立**。
test('① ★★★ 抽取器脱节时：默认**不抛**，但并集能照出"少掉的路由"', () => {
  // 默认不再有绝对下限 —— 这是**有意的**（任何正数都会被迁移追上）
  assert.deepEqual(extractRoutes("if (req.method === 'GET' && path === '/api/only') {}"), ['GET /api/only'])
  assert.deepEqual(extractRoutes('// 抽取规则完全失配'), [], '★ 一条都认不出时返回空数组，而不是抛')

  // ★★★ 而"搬家没搬丢"由**并集**守：把 server 侧塌成空，并集就会少掉它那一份。
  const server = "if (req.method === 'GET' && path === '/api/from-server') {}"
  const family = "export function createX() { return { routes: [{ method: 'GET', path: '/api/from-family', run() {} }] } }"
  const union = (s, f) => [...extractRoutes(s), ...extractDeclaredRoutes(f)].sort()
  assert.deepEqual(union(server, family), ['GET /api/from-family', 'GET /api/from-server'])
  assert.deepEqual(union('// 脱节', family), ['GET /api/from-family'],
    '★★★ server 侧塌掉 ⇒ 并集里**少了** `/api/from-server` ⇒ diffSnapshots 会报 `- 路由: GET /api/from-server`')
  assert.deepEqual(union('// 脱节', '// 也脱节'), [], '★ 两侧都塌 ⇒ 并集空 ⇒ 基线上 188 条全被报成删除，一眼可见')
})

// ---------------------------------------------------------------- ② 失败要响

test('② 表数量过少抛错而不是记录空基线', () => {
  assert.throws(() => extractTables('CREATE TABLE IF NOT EXISTS tasks (id TEXT)'), /抽取规则可能已与源码脱节/)
  // 同一护栏在夹具上可通过 min 放宽，证明它是「护栏」而非「解析限制」
  assert.deepEqual(extractTables('CREATE TABLE IF NOT EXISTS tasks (id TEXT)', { min: 1 }), ['tasks'])
})

test('② ★★ 表名写成字符串常量时要**解析出来**（PRT-615 的真实回归）', () => {
  // PRT-615 把 `permission_requests` 的 DDL 从 `server.mjs` 搬进
  // `approval-binding.mjs`，并改用 `const APPROVAL_TABLE = 'permission_requests'`。
  // 当时的抽取规则只认字面量，于是那张表**静默消失**：32 张变 31 张，
  // 而报出来的漂移是"表被移除了"——如果同时新增一张表，它根本不会出现在漂移里。
  //
  //   > 一个"认不出来的建表语句就当它没建表"的抽取，
  //   > 与一个"可以被无声地绕过的契约门禁"，是同一个东西。
  const src = `
    const APPROVAL_TABLE = 'permission_requests'
    db.exec(\`CREATE TABLE IF NOT EXISTS \${APPROVAL_TABLE} (requestId TEXT PRIMARY KEY)\`)
  `
  assert.deepEqual(extractTables(src, { min: 1 }), ['permission_requests'])
})

test('② ★★ 解析不出来的常量引用要**抛错**，不是静默跳过', () => {
  // 「跳过」的后果是那张表对基线不可见，而门禁报"无漂移"——正是上面那条的形状。
  // 宁可它报"抽取规则已与源码脱节"（人一看就知道去改抽取器），
  // 也不要它报"无漂移"（人不会去看）。
  assert.throws(
    () => extractTables('CREATE TABLE IF NOT EXISTS ${MYSTERY_TABLE} (id TEXT)', { min: 1 }),
    /找不到 `const MYSTERY_TABLE/,
    '认不出来的表名引用被静默跳过了——那张表会对契约基线不可见',
  )
  // 常量存在但值不是纯标识符时同样要拒绝（例如拼出来的名字）
  assert.throws(
    () => extractTables("const T = 'a' + 'b'\nCREATE TABLE IF NOT EXISTS ${T} (id TEXT)", { min: 1 }),
    /找不到 `const T/,
  )
})

test('② 两种写法可以混用', () => {
  const src = `
    const OTHER = 'other_table'
    CREATE TABLE IF NOT EXISTS literal_table (id TEXT)
    CREATE TABLE IF NOT EXISTS \${OTHER} (id TEXT)
  `
  assert.deepEqual(extractTables(src, { min: 1 }), ['literal_table', 'other_table'])
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

// ══════════════════════════════════════════════════════════════════════════
// ⑧⑨⑩ PRT-316：路由**被提取出去**之后，基线还得看得见它们
//
// 起因是真的：把 GET/POST `/api/rules` 搬进 `team-hub/routes/rules.mjs` 之后，
// `--check` 报这两条路由**被删了**——抽取器只扫 `server.mjs` 的字面量 if 链，
// 于是"搬家"在它眼里等于"删除"。
//
//   > 一个只认识"路由长什么样"的抽取器，与一个认识"路由住在哪里"的抽取器，
//   > 在被提取之前是同一个东西——只不过前者会把每一次提取都报成一次删除。
// ══════════════════════════════════════════════════════════════════════════

test('⑧ 声明式路由（提取出去的族）能被提取，且两种书写顺序都认', () => {
  const mf = [
    "export function createXRoutes() {",
    '  const routes = [',
    "    { method: 'GET', path: '/api/aaa', async run() {} },",
    "    { path: '/api/bbb', method: 'POST', async run() {} },",
    '  ]',
    '}',
  ].join('\n')
  assert.deepEqual(extractDeclaredRoutes(mf), ['GET /api/aaa', 'POST /api/bbb'],
    '声明式路由没被提全（换一下 method/path 的顺序就少扫一半）')

  // 非 /api/ 不进平台契约（与字面量抽取器同一口径）
  const nonApi = "{ method: 'GET', path: '/health', async run() {} }"
  assert.deepEqual(extractDeclaredRoutes(nonApi), [], '非 /api/ 路径混进了平台契约')

  // 识别不了时返回空数组（由下面的覆盖判据负责报红，而不是在这里猜）
  assert.deepEqual(extractDeclaredRoutes('const x = 1'), [])
})

test('⑨ ★★★ 装配了未登记的路由族 ⇒ 必须抛错（否则那个族的路由对基线不可见）', () => {
  // ★ 反面例子的工厂名**不许写死**。
  //   这条判据是切片 1 写的，当时拿 `createChatRoutes` 当"未登记"的例子——
  //   那在切片 1 是事实，到切片 3（chat 真的登记了）就变成了**假命题**：
  //   夹具不再是"未登记的族"，于是它不抛错，而它罚的其实是**正确**的行为。
  //
  //   > 一个把"哪个族还没登记"写进夹具的用例，
  //   > 与一个假设"注册表永不变化"的用例，是同一个东西。
  //
  //   现在从一个**确定不存在**的名字推出来，本判据再也不会随注册表演进而失效。
  const registered = new Set(ROUTE_FAMILY_SOURCES.map((x) => x.factory))
  const unregistered = 'createZzzNeverRegisteredRoutes'
  assert.ok(!registered.has(unregistered), `夹具选的名字 ${unregistered} 竟然登记了 ⇒ 换一个`)
  const wired = `const router = createRouter([\n  createRulesRoutes({}),\n  ${unregistered}({}),\n])`
  assert.throws(() => assertRouteFamilyCoverage(wired), new RegExp(unregistered),
    '装配了未登记的族却报绿 ⇒ 那个族的路由对基线完全不可见，而 --check 会说"一致"')
  // 反过来：登记了却没装配 ⇒ 也要红（列名过期）
  assert.throws(
    () => assertRouteFamilyCoverage("createRouter([\n  createRulesRoutes({}),\n])".replace('createRulesRoutes({}),', '')),
    /找不到|createRulesRoutes/,
  )
})

test('⑩ 真仓库：装配处与实际登记**互相齐全**，且族的声明式路由真的进了快照', () => {
  const server = readFileSync(join(REPO_ROOT, 'team-hub/server.mjs'), 'utf8')
  const wired = assertRouteFamilyCoverage(server) // 不齐就抛
  assert.deepEqual(wired, ROUTE_FAMILY_SOURCES.map((x) => x.factory),
    '装配处与 ROUTE_FAMILY_SOURCES 不一致')

  // 每个族的模块必须存在，且它声明的路由都在快照里
  const snap = buildSnapshot()
  for (const { module, family } of ROUTE_FAMILY_SOURCES) {
    const p = SCHEMA_SOURCE_FOR[module]
    assert.ok(p && existsSync(p), `路由族 ${family} 的模块不存在：${p}`)
    const declared = extractDeclaredRoutes(readFileSync(p, 'utf8'))
    assert.ok(declared.length > 0, `路由族 ${family} 一条声明式路由都没提出来（形态变了？）`)
    for (const r of declared) {
      assert.ok(snap.httpRoutes.includes(r), `${family} 的路由 ${r} 不在快照的 httpRoutes 里`)
    }
  }

  // ★ 已记录基线也必须含它们——否则 --check 会把搬家报成删除
  const base = JSON.parse(readFileSync(BASELINE, 'utf8'))
  for (const r of ['GET /api/rules', 'POST /api/rules']) {
    assert.ok(base.httpRoutes.includes(r), `基线里没有 ${r}（--check 会把搬家报成删除）`)
  }
})
