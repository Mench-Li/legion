// ============================================================================
// PRT-316 切片 42：编队投影与改动重叠审计 —— 2 条，全 `exact`
//   GET /api/roster    空间里每个智能体的状态/任务（编队岗位 + 未入编队的执行者）
//   GET /api/overlaps  L3 跨任务改动重叠审计（按"改到同一个文件"分组）
//
// ★★★ **本片两条此前都是零判据**（`seg-survey.mjs` 读数：0 套件提到过这两个路径）。
// ★ 两条都是 **GET / 只读** —— 模块里没有任何写动作，连 `now()` 都不取。
// ============================================================================
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTeamViewsRoutes } from './routes/team-views.mjs'

const dir = mkdtempSync(join(tmpdir(), 'legion-team-views-'))
process.env.TEAM_HUB_DB = join(dir, 'team.db')
process.env.TEAM_HUB_TOKEN = ''
const mod = await import('./server.mjs')
await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + mod.server.address().port

const get = async (p) => {
  const res = await fetch(base + p)
  const t = await res.text(); let j; try { j = JSON.parse(t) } catch { j = t }
  return { status: res.status, body: j }
}

const iso = (n) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString()
const mkTask = (id, { scope = 'default', role = 'dev', soldier = null, status = 'todo', patches = null, at = 0 } = {}) => {
  mod.db.prepare('INSERT OR REPLACE INTO tasks (id,title,priority,status,scope,role,soldier,hold,patches,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, 'T-' + id, 'medium', status, scope, role, soldier, 0, patches === null ? null : JSON.stringify(patches), iso(at), iso(at))
}
const mkRoster = (scope, role, name, sort = 0, kind = 'ai', avatar = '🤖') => {
  mod.db.prepare('INSERT OR REPLACE INTO roster (scope,sort,role,name,kind,avatar) VALUES (?,?,?,?,?,?)')
    .run(scope, sort, role, name, kind, avatar)
}
const reset = () => { mod.db.prepare('DELETE FROM tasks').run(); mod.db.prepare('DELETE FROM roster').run() }

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close?.() } catch { /* 已关 */ }
  try { mod?.db?.close?.() } catch { /* 已关 */ }
  rmSync(dir, { recursive: true, force: true })
})

// ══════════════════════ GET /api/roster ══════════════════════

test('① ★★★ 没有任务、没有编队 ⇒ 200 + 空 agents（不是 404、不炸）', async () => {
  reset()
  const r = await get('/api/roster')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body, { scope: 'all', agents: [] })
})

test('② ★★★ `scope` 缺省 = `all`（聚合全部空间），给了就只算那一个', async () => {
  reset()
  mkRoster('default', 'dev', '开发')
  mkRoster('other', 'qa', '测试')
  const all = await get('/api/roster')
  assert.equal(all.body.scope, 'all')
  assert.deepEqual(all.body.agents.map((a) => a.role).sort(), ['dev', 'qa'], '★★ 缺省要聚合**全部**空间')
  const one = await get('/api/roster?scope=other')
  assert.equal(one.body.scope, 'other')
  assert.deepEqual(one.body.agents.map((a) => a.role), ['qa'], '★ 给了 scope 就只算那一个')
  // ★ scope 为空串 = 缺省（源码是 `?? ''` 再 trim）
  const empty = await get('/api/roster?scope=')
  assert.equal(empty.body.scope, 'all', '★ 空串按缺省处理')
})

test('③ ★★★ `mode` 的优先级：blocked > review > busy > idle', async () => {
  reset()
  mkRoster('default', 'r-blocked', 'B')
  mkRoster('default', 'r-review', 'R')
  mkRoster('default', 'r-busy', 'U')
  mkRoster('default', 'r-idle', 'I')
  mkTask('t1', { role: 'r-blocked', status: 'blocked' })
  mkTask('t2', { role: 'r-blocked', status: 'in_progress' })  // blocked 与 in_progress 同时有 ⇒ blocked 赢
  // ★★★ 破验 M4 教我补的这一条：`blocked` 与 `in_review` **同时**有时，也必须是 blocked 赢。
  //   没有这个用例，把优先级判据整条**反过来**都不会有判据变红（第一版 22 个变异里漏了这个）。
  mkTask('t2b', { role: 'r-blocked', status: 'in_review' })
  mkTask('t3', { role: 'r-review', status: 'in_review' })
  mkTask('t4', { role: 'r-busy', status: 'in_progress' })
  mkTask('t5', { role: 'r-idle', status: 'todo' })
  const by = Object.fromEntries((await get('/api/roster')).body.agents.map((a) => [a.role, a.mode]))
  assert.equal(by['r-blocked'], 'blocked', '★★ blocked 压过 in_progress')
  assert.equal(by['r-review'], 'review')
  assert.equal(by['r-busy'], 'busy')
  assert.equal(by['r-idle'], 'idle', '★ 只有 todo ⇒ idle（todo 不算"在办"到能改变 mode，但会进 chips）')
})

test('④ ★★★ chips 的四种标签与"空则回落"', async () => {
  reset()
  mkRoster('default', 'r1', 'A')
  mkRoster('default', 'r2', 'B')
  mkRoster('default', 'r3', 'C')
  mkTask('a1', { role: 'r1', status: 'in_progress' })
  mkTask('a2', { role: 'r1', status: 'in_review' })
  mkTask('a3', { role: 'r1', status: 'blocked' })
  mkTask('a4', { role: 'r1', status: 'todo' })
  mkTask('b1', { role: 'r2', status: 'done' })      // 有历史 ⇒ 「已完成 N」
  mkTask('b2', { role: 'r2', status: 'canceled' })  // canceled 不进 mine
  const agents = Object.fromEntries((await get('/api/roster')).body.agents.map((a) => [a.role, a]))
  assert.deepEqual(agents.r1.chips.map((c) => c.label), ['进行中 1', '待验收 1', '受阻 1', '待命 1'],
    '★★ 四种标签的顺序是固定的：进行中 / 待验收 / 受阻 / 待命')
  assert.deepEqual(agents.r1.chips.map((c) => c.cls), ['green', 'yellow', 'red', ''],
    '★ 颜色：green / yellow / red / 空')
  assert.deepEqual(agents.r2.chips.map((c) => c.label), ['已完成 1'], '★★ 无在办但有历史 ⇒ 已完成 N')
  assert.deepEqual(agents.r3.chips.map((c) => c.label), ['待命'], '★★ 什么都没有 ⇒ 待命')
  assert.deepEqual(agents.r3.chips[0].cls, '')
})

test('⑤ ★★★ `done` 与 `total` 是两个口径：`total` 是"非 canceled 的总数"，`done` 只数 done', async () => {
  reset()
  mkRoster('default', 'r', 'R')
  mkTask('x1', { role: 'r', status: 'done' })
  mkTask('x2', { role: 'r', status: 'canceled' })
  mkTask('x3', { role: 'r', status: 'todo' })
  const a = (await get('/api/roster')).body.agents.find((x) => x.role === 'r')
  assert.equal(a.done, 1, '★ done 只数 done')
  // ★★ 实测：`summarize` 收的 `list` 是**调用方已经滤掉 canceled** 的那个数组，
  //   而 `total: list.length` ⇒ total 数的是**除 canceled 以外**的全部（done 也算）。
  //   我第一版以为 total 数的是"未完成的"，红在我自己的预期上。
  assert.equal(a.total, 2, '★★ total = 非 canceled 的总数（done 1 + todo 1），canceled 不算')
})

test('⑥ ★★★ 未入编队但认领了该空间任务的执行者**也要出现**（`external` 标记）', async () => {
  reset()
  mkRoster('default', 'r', '正式岗位')
  mkTask('s1', { role: 'solo-soldier', soldier: 'solo-soldier', status: 'in_progress' })
  const agents = (await get('/api/roster')).body.agents
  const ext = agents.find((a) => a.external)
  assert.ok(ext, '★★★ 未入编队的执行者必须也返回（否则切空间后信息丢失）')
  assert.equal(ext.role, 'solo-soldier')
  assert.equal(ext.name, 'solo-soldier · 执行中', '★ 名字后缀')
  assert.equal(ext.avatar, '⚙️')
  assert.equal(ext.scope, 'default')
  assert.equal(agents.find((a) => a.role === 'r').external, false, '★ 编队岗位 external=false')
})

test('⑥b ★★ `canceled` 与"已入编队"的任务都不进 external 那一组', async () => {
  reset()
  mkRoster('default', 'r', 'R')
  mkTask('c1', { role: 'r', soldier: 'r', status: 'in_progress' })   // 已入编队 ⇒ 不算 external
  mkTask('c2', { role: 'ghost', soldier: 'ghost', status: 'canceled' }) // canceled ⇒ 不算
  const agents = (await get('/api/roster')).body.agents
  assert.equal(agents.filter((a) => a.external).length, 0, '★★ 已入编队 / canceled 都不该落到 external')
  assert.equal(agents.length, 1)
})

test('⑦ ★★ 每个 agent 只带未完成的 `tasks`（`{id,title,status}` 三字段）', async () => {
  reset()
  mkRoster('default', 'r', 'R')
  mkTask('p1', { role: 'r', status: 'todo' })
  mkTask('p2', { role: 'r', status: 'done' })       // done 不进 tasks
  mkTask('p3', { role: 'r', status: 'in_progress' })
  const a = (await get('/api/roster')).body.agents.find((x) => x.role === 'r')
  assert.deepEqual(a.tasks.map((t) => t.id).sort(), ['p1', 'p3'], '★★ done 的不进 tasks 列表')
  assert.deepEqual(Object.keys(a.tasks[0]).sort(), ['id', 'status', 'title'], '★ 只带三个字段')
})

// ══════════════════════ GET /api/overlaps ══════════════════════

const patch = (files) => [{ by: 'general', at: iso(0), summary: '', files: files.map((f) => ({ path: f, status: 'M', add: 1, del: 0 })), diff: '' }]

test('⑧ ★★★ 没有补丁 ⇒ 空 groups；只被一个任务改过的文件**不成组**', async () => {
  reset()
  const r0 = await get('/api/overlaps')
  assert.equal(r0.status, 200)
  assert.deepEqual(r0.body, { scope: 'all', groups: [] })
  mkTask('o1', { patches: patch(['a.mjs']) })
  const r1 = await get('/api/overlaps')
  assert.deepEqual(r1.body.groups, [], '★★ 只有一个任务改过的文件不算"重叠"（默认 min=2）')
})

test('⑨ ★★★ `min` 被**钳到至少 2**（`min=1` / `min=abc` 都等于 2）', async () => {
  reset()
  mkTask('o1', { patches: patch(['shared.mjs']) })
  mkTask('o2', { patches: patch(['shared.mjs']) })
  // ★★★ 破验 M11 教我补的这一条：库必须**同时**有一个"只被一个任务改过"的文件，
  //   否则把 `Math.max(2, …)` 那个钳子整条删掉也不会有判据变红。
  mkTask('solo', { patches: patch(['only-one.mjs']) })
  for (const q of ['', '?min=1', '?min=abc', '?min=0', '?min=-5']) {
    const g = (await get('/api/overlaps' + q)).body.groups
    assert.deepEqual(g.map((x) => x.file), ['shared.mjs'],
      `★★★ min${q} 必须钳到 2：只被一个任务改过的 only-one.mjs **不许**成组`)
  }
  const g3 = (await get('/api/overlaps?min=3')).body.groups
  assert.equal(g3.length, 0, '★ min=3 时两个任务不够')
})

test('⑩ ★★★ `patches` 的三种形态都认（旧库纯字符串 / 数组 / CSV 字符串）', async () => {
  reset()
  // 旧库：patches 里直接是字符串
  mkTask('old1', { patches: ['legacy.mjs'] })
  mkTask('old2', { patches: ['legacy.mjs'] })
  // 数组形态
  mkTask('arr1', { patches: patch(['arr.mjs']) })
  mkTask('arr2', { patches: patch(['arr.mjs']) })
  // CSV 字符串形态
  mkTask('csv1', { patches: [{ files: 'a.mjs, b.mjs' }] })
  mkTask('csv2', { patches: [{ files: 'b.mjs' }] })
  const files = (await get('/api/overlaps')).body.groups.map((g) => g.file).sort()
  assert.deepEqual(files, ['arr.mjs', 'b.mjs', 'legacy.mjs'],
    '★★★ 三种形态都要认；`a.mjs` 只被一个任务改过 ⇒ 不成组')
})

test('⑪ ★★ 同一个任务在同一个文件上出现多次只算**一次**', async () => {
  reset()
  mkTask('m1', { patches: [...patch(['dup.mjs']), ...patch(['dup.mjs'])] })
  mkTask('m2', { patches: patch(['dup.mjs']) })
  const g = (await get('/api/overlaps')).body.groups.find((x) => x.file === 'dup.mjs')
  assert.equal(g.tasks.length, 2, '★★ 一个任务在一个文件上只记一条（用了 Set）')
})

test('⑫ ★★★ `id` 过滤：只留含该任务的组；`scope` 过滤同理', async () => {
  reset()
  mkTask('g1', { scope: 'A', patches: patch(['f1.mjs']) })
  mkTask('g2', { scope: 'A', patches: patch(['f1.mjs']) })
  mkTask('g3', { scope: 'B', patches: patch(['f2.mjs']) })
  mkTask('g4', { scope: 'B', patches: patch(['f2.mjs']) })
  const all = await get('/api/overlaps')
  assert.equal(all.body.scope, 'all')
  assert.deepEqual(all.body.groups.map((g) => g.file).sort(), ['f1.mjs', 'f2.mjs'])
  const onlyA = await get('/api/overlaps?scope=A')
  assert.deepEqual(onlyA.body.groups.map((g) => g.file), ['f1.mjs'], '★ scope 过滤')
  const byId = await get('/api/overlaps?id=g3')
  assert.deepEqual(byId.body.groups.map((g) => g.file), ['f2.mjs'], '★★ id 过滤到含该任务的组')
  const none = await get('/api/overlaps?id=nope')
  assert.deepEqual(none.body.groups, [])
})

test('⑬ ★★ 组内按 id **自然序**排；组间按 `updatedAt` 倒序', async () => {
  reset()
  mkTask('n10', { patches: patch(['nat.mjs']), at: 500 })
  mkTask('n2', { patches: patch(['nat.mjs']), at: 100 })
  mkTask('n1', { patches: patch(['nat.mjs']), at: 900 })
  const g = (await get('/api/overlaps')).body.groups.find((x) => x.file === 'nat.mjs')
  assert.deepEqual(g.tasks.map((t) => t.id), ['n1', 'n2', 'n10'],
    '★★ 自然序：n2 在 n10 前面（不是字典序）')
  // 两个组：新的在前
  mkTask('p1', { patches: patch(['newer.mjs']), at: 9999 })
  mkTask('p2', { patches: patch(['newer.mjs']), at: 9999 })
  const order = (await get('/api/overlaps')).body.groups.map((x) => x.file)
  assert.equal(order[0], 'newer.mjs', '★★ 最近改动的组排在前面')
})

test('⑭ ★★ 组里的任务带 `{id,title,status,updatedAt}`', async () => {
  reset()
  mkTask('z1', { patches: patch(['z.mjs']), at: 7 })
  mkTask('z2', { patches: patch(['z.mjs']), at: 7 })
  const g = (await get('/api/overlaps')).body.groups[0]
  assert.deepEqual(Object.keys(g.tasks[0]).sort(), ['id', 'status', 'title', 'updatedAt'])
  assert.ok(g.tasks[0].updatedAt, '★ updatedAt 要从任务上取到')
})

// ══════════════════════ 接缝契约 ══════════════════════

const stub = (over = {}) => createTeamViewsRoutes({
  json: (res, code, p) => { res.sent = { code, payload: p } },
  db: { prepare: () => ({ all: () => [], get: () => undefined, run: () => {} }) },
  listTasks: () => [],
  ...over,
})

test('⑮ ★★★ dispatch 契约：只认 GET / 命中回 true / `exact` 不退化成 `prefix`', async () => {
  const router = stub()
  const ctx = (p) => ({ path: p, url: new URL('http://x' + p) })
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/roster')), true)
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/overlaps')), true)
  assert.equal(await router.dispatch({ method: 'POST' }, {}, ctx('/api/roster')), false, '★ 只认 GET')
  assert.equal(await router.dispatch({ method: 'DELETE' }, {}, ctx('/api/overlaps')), false)
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/rosterX')), false, '★ exact 不许退化成 startsWith')
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/nope')), false)
  assert.deepEqual(router.routes.map((r) => `${r.method} ${r.match} ${r.path}`),
    ['GET exact /api/roster', 'GET exact /api/overlaps'])
  assert.equal(router.id, 'team-views')
})

test('⑯ ★★ 缺注入项 ⇒ **构造时**就抛（fail closed）', async () => {
  const full = { json: () => {}, db: {}, listTasks: () => [] }
  for (const k of Object.keys(full)) {
    const partial = { ...full }
    delete partial[k]
    assert.throws(() => createTeamViewsRoutes(partial), /缺注入项/, `★★ 少了 ${k} 必须在构造时就抛`)
  }
})
