// ============================================================================
// PRT-316 切片 48：切片展开 —— 1 条，`exact`
//   POST /api/goal/slices   { testDesignerTaskId, slices: [{title, files, acceptance}] }
//
// ★★★ 本片只搬**路由**，域层 `expandGoalSlices` 仍在 `server.mjs`。
//   所以下面这些判据钉的是**这条缝暴露出来的契约**（校验顺序、状态码、
//   域层拒绝的**可达性**、幂等重放），不是域层的内部实现。
//
//   ★ 路由自己只管一件事：`testDesignerTaskId` 非空。
//     其余全部（role 必须是 test-designer、必须带 `[auto-goal]`、
//     必须 done、`slices` 1..16、幂等重放）都由 `expandGoalSlices` 决定 ——
//     而它**留在原处**，这正是"一搬到新家就变成 ReferenceError"要防的那种搬法。
// ============================================================================
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createGoalSlicesRoutes } from './routes/goal-slices.mjs'

const dir = mkdtempSync(join(tmpdir(), 'legion-goal-slices-'))
process.env.TEAM_HUB_DB = join(dir, 'team.db')
process.env.TEAM_HUB_TOKEN = ''
const mod = await import('./server.mjs')
await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + mod.server.address().port

const post = async (p, body) => {
  const res = await fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  })
  const t = await res.text(); let j; try { j = JSON.parse(t) } catch { j = t }
  return { status: res.status, body: j }
}

const reset = () => {
  mod.db.prepare('DELETE FROM tasks').run()
  mod.db.prepare('DELETE FROM audit').run()
}
/** ★ 只填必填列，其余走 DEFAULT。 */
const seedTask = (id, over = {}) => {
  mod.db.prepare('INSERT INTO tasks (id, title, description, role, scope, status) VALUES (?,?,?,?,?,?)')
    .run(id, over.title ?? id, over.description ?? '', over.role ?? 'coder', over.scope ?? 'default', over.status ?? 'backlog')
}
/** 一个**能通过**全部前置校验的 test-designer 任务。 */
const seedTD = (id = 'TD1', over = {}) => seedTask(id, {
  role: 'test-designer', status: 'done',
  description: '[auto-goal]\n目标：把这件事做完\n', ...over,
})
const sliceTasks = () => mod.db.prepare("SELECT id, slice, role, scope FROM tasks WHERE slice IS NOT NULL ORDER BY slice").all()

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close?.() } catch { /* 已关 */ }
  try { mod?.db?.close?.() } catch { /* 已关 */ }
  rmSync(dir, { recursive: true, force: true })
})

const GOOD = [{ title: '切片一', files: ['a.mjs'], acceptance: ['跑得通'] }]

// ══════════════════════ 路由自己的校验 ══════════════════════

test('① ★★★ `testDesignerTaskId` 必填 —— 缺 / 空串 / 非字符串都 400', async () => {
  reset()
  for (const v of [undefined, null, '', 42, {}, []]) {
    const r = await post('/api/goal/slices', { by: 'general', testDesignerTaskId: v })
    assert.equal(r.status, 400, `★★ testDesignerTaskId=${JSON.stringify(v)}`)
    // ★★ 破验 M6 教我收紧的这一条：原来写的是
    //   `assert.match(error, /缺少参数 testDesignerTaskId/)`
    //   —— 而**它连 `…TaskIdX` 也照样匹配**（正则没锚右端），
    //   于是"把文案改错"这个变异**没被抓住**。
    //   > 一个「我断言了那句报错文案」的印象，
    //   > 与一个「我的正则只钉住了它的**前缀**」的事实，
    //   > 在有人往那句话后面多打一个字母之前是同一个东西。
    //   改成**逐字相等**。
    assert.equal(String(r.body.error), '缺少参数 testDesignerTaskId',
      '★★★ 文案要**逐字**钉住，不能用只锚左端的正则')
  }
  // ★ 注意：`[]` 与 `{}` 都不是 string ⇒ 也要拒
  // ★ 空白串是**例外**：`length===0` 判的是原值，所以 `' '` 能过这一关
  //   （它会走进域层，然后因为查不到任务而失败）—— 这是**量出来的**行为，钉住。
  const blank = await post('/api/goal/slices', { by: 'general', testDesignerTaskId: ' ' })
  assert.doesNotMatch(String(blank.body.error ?? ''), /缺少参数 testDesignerTaskId/,
    '★ 全是空格**不算**"缺少参数"（判的是 `length === 0`，不是 `trim()`）')
})

test('② ★★ 缺操作者身份 ⇒ 400（`handleWrite` 的第一道闸）', async () => {
  reset()
  const r = await post('/api/goal/slices', { testDesignerTaskId: 'TD1' })
  assert.equal(r.status, 400)
  assert.match(String(r.body.error), /缺少操作者身份 by/)
})

test('③ ★★★ 任务不存在 ⇒ 400，且**一条切片任务都不该被建出来**', async () => {
  reset()
  const r = await post('/api/goal/slices', { by: 'general', testDesignerTaskId: 'NOPE', slices: GOOD })
  assert.equal(r.status, 400, JSON.stringify(r.body))
  assert.notEqual(r.body.ok, true, '★ 失败路径不带 ok:true')
  assert.equal(sliceTasks().length, 0, '★★★ 失败时不该留下任何切片任务（域层包了 withTx）')
})

// ══════════════════════ 域层的三道前置闸（经由本缝可达） ══════════════════════

test('④ ★★★ 三道前置闸：role 必须是 test-designer、必须 `[auto-goal]`、必须 done', async () => {
  // (a) role 不对
  reset()
  seedTask('T1', { role: 'coder', status: 'done', description: '[auto-goal]' })
  const a = await post('/api/goal/slices', { by: 'general', testDesignerTaskId: 'T1', slices: GOOD })
  assert.equal(a.status, 400); assert.match(String(a.body.error), /需要 test-designer 任务/)
  assert.equal(sliceTasks().length, 0, '★★ 被拒时一条都不建')

  // (b) 不是自动目标链任务
  reset()
  seedTask('T2', { role: 'test-designer', status: 'done', description: '普通任务，没有那个标记' })
  const b = await post('/api/goal/slices', { by: 'general', testDesignerTaskId: 'T2', slices: GOOD })
  assert.equal(b.status, 400); assert.match(String(b.body.error), /不是自动目标链任务/)
  assert.equal(sliceTasks().length, 0)

  // (c) 还没 done
  reset()
  seedTask('T3', { role: 'test-designer', status: 'in_progress', description: '[auto-goal]' })
  const c = await post('/api/goal/slices', { by: 'general', testDesignerTaskId: 'T3', slices: GOOD })
  assert.equal(c.status, 400); assert.match(String(c.body.error), /分析前缀未完成/)
  assert.equal(sliceTasks().length, 0)

  // ★ 三道闸的顺序：role 先于 auto-goal、auto-goal 先于 done
  reset()
  seedTask('T4', { role: 'coder', status: 'backlog', description: '啥都没有' })
  const d = await post('/api/goal/slices', { by: 'general', testDesignerTaskId: 'T4', slices: GOOD })
  assert.match(String(d.body.error), /需要 test-designer 任务/, '★★ 三道都不满足时报的是**第一条**')
})

test('⑤ ★★★ `slices` 必须是 1..16 个 —— 空 / 非数组 / 17 个都 400', async () => {
  reset(); seedTD('TD')
  for (const v of [undefined, null, [], 'nope', 42, new Array(17).fill({ title: 'x' })]) {
    const r = await post('/api/goal/slices', { by: 'general', testDesignerTaskId: 'TD', slices: v })
    assert.equal(r.status, 400, `★★ slices=${JSON.stringify(v)?.slice(0, 40)}`)
    assert.match(String(r.body.error), /slices 必须是 1\.\.16 个切片的数组/)
  }
  assert.equal(sliceTasks().length, 0, '★★ 被拒时一条都不建')
  // ★ 边界：正好 1 个和正好 16 个都要过
  reset(); seedTD('TD')
  assert.equal((await post('/api/goal/slices', { by: 'general', testDesignerTaskId: 'TD', slices: [{ title: '一个' }] })).status, 200)
})

test('⑥ ★★ 每个切片必须有 `title`（空白不算）；缺了整批回滚', async () => {
  reset(); seedTD('TD')
  for (const bad of [undefined, '', '   ', 42]) {
    const r = await post('/api/goal/slices', { by: 'general', testDesignerTaskId: 'TD', slices: [{ title: 'ok' }, { title: bad }] })
    assert.equal(r.status, 400, `★★ title=${JSON.stringify(bad)}`)
    assert.match(String(r.body.error), /缺少 title/)
    assert.equal(sliceTasks().length, 0,
      '★★★ 第二个切片非法 ⇒ **第一个也不该留下**（整批在一个事务里）')
  }
})

// ══════════════════════ 成功路径 ══════════════════════

test('⑦ ★★★ 成功 ⇒ 200 `{ok:true, task}`；★★★ **首次与重放的形状不一样**（量出来的）', async () => {
  reset(); seedTD('TD')
  const r = await post('/api/goal/slices', { by: 'general', testDesignerTaskId: 'TD', slices: GOOD })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.ok, true, '★★ handleWrite 外面那层形状')
  const t = r.body.task
  assert.equal(t.mode, 'slice', '★ mode 是 slice（不是 chain）')
  assert.equal(t.testDesignerTaskId, 'TD')
  assert.ok(Array.isArray(t.created) && t.created.length > 0, '★★ 要报出建了哪些任务')
  assert.ok(typeof t.devops === 'string' && t.devops !== '', '★★ 首次会多一个 `devops`（目标级收尾任务 id）')

  // ★★★ **首次那条路根本没有 `existed` 这个字段**：
  //   域层的两条 return 形状不同 ——
  //     首次：`{ mode, testDesignerTaskId, created, devops }`
  //     重放：`{ mode, testDesignerTaskId, created: [], existed }`
  //   ⇒ 调用方不能无条件读 `task.existed`（首次拿到的是 `undefined`）。
  //
  //   > 一个「两条 return 都是同一个形状，只是字段值不同」的印象，
  //   > 与一个「**键本身**只在一半的路径上存在」的事实，
  //   > 在我把两条 return 逐字打出来看之前是同一个东西。
  assert.equal(t.existed, undefined, '★★★ 首次展开**没有** `existed` 键（这是两条 return 的形状差）')
  assert.ok(!('existed' in t), '★★★ 用 `in` 验一次：那个键**不在**对象上')
  assert.ok(sliceTasks().length > 0, '★★ 真的落库了')
  assert.ok(sliceTasks().every((x) => x.scope === 'default'), '★ 切片跟 test-designer 同一个作用域')
})

test('⑦b ★★★ 一个切片建 **2** 个任务（coder + tester），外加 **1** 个目标级 devops', async () => {
  reset(); seedTD('TD')
  const r = await post('/api/goal/slices', { by: 'general', testDesignerTaskId: 'TD', slices: GOOD })
  const rows = sliceTasks()
  assert.equal(r.body.task.created.length, 3, '★★★ 1 切片 ⇒ created 3 条（coder + tester + devops）')
  assert.equal(rows.length, 3, '★★★ 落库也是 3 行')
  const byRole = {}
  for (const x of rows) byRole[x.role] = (byRole[x.role] ?? 0) + 1
  assert.deepEqual(byRole, { coder: 1, tester: 1, devops: 1 }, '★★ 三种角色各一')
  // ★★ devops 是**目标级**收尾：它的 `slice` 是 **td.id 本身**（不是 `:S<n>`）
  const dev = rows.find((x) => x.role === 'devops')
  assert.equal(dev.slice, 'TD',
    '★★★ devops 行的 `slice` 是 test-designer 的 id 本身 —— 不是切片键')
})

test('⑧ ★★★ 幂等重放：同一个 testDesignerTaskId 再来一次 ⇒ `created: []`、`existed` 非空', async () => {
  reset(); seedTD('TD')
  const first = await post('/api/goal/slices', { by: 'general', testDesignerTaskId: 'TD', slices: GOOD })
  assert.equal(first.status, 200)
  const n1 = sliceTasks().length
  const second = await post('/api/goal/slices', { by: 'general', testDesignerTaskId: 'TD', slices: GOOD })
  assert.equal(second.status, 200, JSON.stringify(second.body))
  assert.deepEqual(second.body.task.created, [], '★★★ 重放不再建新的')
  assert.ok(second.body.task.existed.length > 0, '★★★ 要说清哪些已经在了')
  assert.equal(second.body.task.mode, 'slice')
  assert.equal(sliceTasks().length, n1, '★★★ 任务数**不变**（幂等重放不重复建）')
})

test('⑨ ★★ 切片任务带上 `slice` 键（`<tdId>:S<n>`）；devops 那个是例外', async () => {
  reset(); seedTD('TD')
  await post('/api/goal/slices', { by: 'general', testDesignerTaskId: 'TD', slices: GOOD })
  const sliced = sliceTasks().filter((x) => x.role !== 'devops')
  assert.ok(sliced.length > 0)
  assert.ok(sliced.every((x) => /^TD:S\d+$/.test(x.slice)),
    `★★ 切片任务形如 TD:S1：${JSON.stringify(sliced.map((x) => x.slice))}`)
  assert.ok(sliceTasks().some((x) => x.role === 'coder'), '★ 至少有一个编码切片')
  assert.ok(sliceTasks().some((x) => x.role === 'tester'), '★ 至少有一个测试切片')
})

test('⑩ ★★ `body.slices` 里的 `files`/`acceptance` 是可选的非数组也容错', async () => {
  reset(); seedTD('TD')
  const r = await post('/api/goal/slices', {
    by: 'general', testDesignerTaskId: 'TD',
    slices: [{ title: '只有标题' }, { title: '带怪东西', files: 'nope', acceptance: 42 }],
  })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.ok(r.body.task.created.length > 0)
})

// ══════════════════════ 接缝契约 ══════════════════════

const stub = (over = {}) => createGoalSlicesRoutes({
  json: (res, code, p) => { res.sent = { code, payload: p } },
  // ★★ 默认**不跑路由体**：这条路由的体第一件事就是校验 `testDesignerTaskId`，
  //   跑起来会把"路由判据"和"业务校验"搅在一起（切片 45 踩过同一个坑）。
  handleWrite: async () => {},
  expandGoalSlices: () => ({ mode: 'slice', created: [], existed: [] }),
  ...over,
})

test('⑪ ★★★ dispatch 契约：只认 `POST /api/goal/slices`，`exact` 不退化成 `prefix`', async () => {
  const router = stub()
  const ctx = (p) => ({ path: p, url: new URL('http://x' + p) })
  assert.equal(await router.dispatch({ method: 'POST' }, {}, ctx('/api/goal/slices')), true)
  assert.equal(await router.dispatch({ method: 'POST' }, {}, ctx('/api/goal/slicesX')), false, '★ exact 不许退化成 startsWith')
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/goal/slices')), false, '★ 只认 POST')
  // ★★ 同前缀的兄弟：`/api/goal/*` 下的其它路由不归本族
  assert.equal(await router.dispatch({ method: 'POST' }, {}, ctx('/api/goal/status')), false, '★★ 不许越界认领 /api/goal/ 下的兄弟')
  assert.equal(await router.dispatch({ method: 'POST' }, {}, ctx('/api/goal/context')), false)
  assert.deepEqual(router.routes.map((r) => `${r.method} ${r.match} ${r.path}`), ['POST exact /api/goal/slices'])
  assert.equal(router.id, 'goal-slices')
})

test('⑫ ★★★ 路由**真的**调了域层的 `expandGoalSlices`，并把三个字段原样递过去', async () => {
  let seen = null
  const router = stub({
    handleWrite: async (req, res, run) => {
      res.sent = { code: 200, payload: await run({ testDesignerTaskId: 'TD9', slices: ['S'] }, 'me', 'sc') }
    },
    expandGoalSlices: (args) => { seen = args; return { mode: 'slice', created: [], existed: [] } },
  })
  await router.dispatch({ method: 'POST' }, {}, { path: '/api/goal/slices', url: new URL('http://x/api/goal/slices') })
  assert.ok(seen, '★★★ 必须调域层（搬丢这一句就是"一搬到新家就变成 ReferenceError"那类）')
  assert.equal(seen.testDesignerTaskId, 'TD9', '★ 第一个字段从 body 取')
  assert.deepEqual(seen.slices, ['S'], '★ `slices` **原样**递过去（路由不做二次校验）')
  assert.equal(seen.by, 'me', '★★ `by` 取的是 **handleWrite 给的身份**，不是 body.by')
})

test('⑬ ★★★ `by` 用的是写闸给的身份，不是 `body.by`（否则审计可被伪造）', async () => {
  let seen = null
  const router = stub({
    handleWrite: async (req, res, run) => {
      // ★ body 里塞一个**伪造的** by，同时写闸给出**真**身份
      await run({ testDesignerTaskId: 'TD', by: '我是伪造的' }, '真正的身份', 'sc')
    },
    expandGoalSlices: (args) => { seen = args; return {} },
  })
  await router.dispatch({ method: 'POST' }, {}, { path: '/api/goal/slices', url: new URL('http://x/api/goal/slices') })
  assert.equal(seen.by, '真正的身份', '★★★ 必须用第二个形参（handleWrite 验过的身份）')
  assert.notEqual(seen.by, '我是伪造的', '★★★ body 里的 by 不许直接影响域层')
})

test('⑭ ★★ 缺注入项 ⇒ **构造时**就抛（fail closed）', async () => {
  const full = {
    json: () => {}, handleWrite: async () => {},
    expandGoalSlices: () => ({}),
  }
  for (const k of Object.keys(full)) {
    const partial = { ...full }
    delete partial[k]
    assert.throws(() => createGoalSlicesRoutes(partial), /缺注入项/, `★★ 少了 ${k} 必须在构造时就抛`)
  }
})
