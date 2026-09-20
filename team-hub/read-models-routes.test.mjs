// ============================================================================
// PRT-316 切片 33：读接口（`/api/board` `/api/task` `/api/missions` `/api/scopes`
// `/api/spaces` `/api/goal` `/api/pipeline` `/api/agents`，共 8 条，全是 GET exact）
//
// ★ 本片**不是**为了"补一套判据"才写的。这一族有**七套**真 hub 的判据
//   （pipeline 22 点 / spaces 16 点 / board 1+2+3+2 点 / task 4 点 / goal 3 点 / agents 9 点）。
//   拿它们当判据、把路由层逐条改坏：**32 条里只有 8 条会红**。
//
//   ★★ 其中量出来最刺眼的一条：**`/api/missions` 一条判据都没有** ——
//      0 套、0 个请求点。而它是这一族里最长的一条（60+ 行聚合），
//      连"这个路径还在不在"都没人看着（改坏路径也没有任何用例变红）。
//
//   > 一个"这一族有七套用例守着"的印象，与一个"其中最复杂的那一条**一次都没被请求过**"的事实，
//   > 在我没有把每一条路由**逐条改坏一次、看谁变红**的时候是同一个东西。
//
// 量出来的 24 个缺口（按路由分）：
//   board   ⑫ 三个过滤参数（status / soldier / scope）各丢了都没人看
//   task    ⑬ `id` 缺失时那条 400 没了（变成拿 null 去查库）
//   missions ⑭ 路径 / ⑮ canceled 不跳过 / ⑯ percent 漏乘 100 / ⑰ blocked 优先级
//           ⑱ 排序 rank / ⑲ 标签回退 / ⑳ `scopeAware`
//   scopes  ㉑ 不并 members 表 / ㉒ 不过滤空串
//   spaces  ㉓ `agentCount` 写死 0 / ㉔ `private` 恒 false / ㉕ `name` 不回退到 id
//   goal    ㉖ 不调 `settleGoalsOfScope` / ㉗ 没给 scope 时也列 / ㉘ percent 恒 0 / ㉙ 不排除 canceled
//   pipeline㉚ scope 合法性那条 400 没了
//   agents  ㉛ 不按 role 去重 / ㉜ 丢了 `scopes` 数组
//   dispatch㉝ 认领了却回 false
//
// 夹具一律**直接写库**（`INSERT INTO …`），因为本片要钉的正是"过滤/聚合的细节"，
// 而用别的路由去造夹具会把那些路由的行为也拖进本片的前提里。
// ============================================================================
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createReadModelsRoutes } from './routes/read-models.mjs'

let mod
let base = ''
const dbDir = mkdtempSync(join(tmpdir(), 'legion-rmroutes-'))

const get = async (path) => {
  const res = await fetch(base + path, { method: 'GET', agent: false })
  let payload = null
  try { payload = await res.json() } catch { /* 无正文 */ }
  return { status: res.status, body: payload }
}

process.env.TEAM_HUB_DB = join(dbDir, 'team.db')
process.env.TEAM_HUB_TOKEN = ''
mod = await import('./server.mjs')
await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
base = 'http://127.0.0.1:' + mod.server.address().port

const db = mod.db
const clear = () => {
  for (const t of ['tasks', 'members', 'roster', 'spaces', 'goal']) db.exec(`DELETE FROM ${t}`)
}
const addTask = (o) => db.prepare(
  'INSERT INTO tasks (id, title, status, soldier, role, scope, goalId) VALUES (?,?,?,?,?,?,?)',
).run(o.id, o.title ?? o.id, o.status ?? 'todo', o.soldier ?? null, o.role ?? null,
  o.scope ?? 'default', o.goalId ?? null)
const addMember = (id, scope) => db.prepare('INSERT INTO members (id, scope) VALUES (?,?)').run(id, scope)
const addRoster = (scope, role, name) => db.prepare(
  'INSERT INTO roster (scope, role, name, kind, avatar) VALUES (?,?,?,?,?)',
).run(scope, role, name, 'agent', '🤖')
const addSpace = (o) => db.prepare(
  'INSERT INTO spaces (id, name, private, local_dir, remote_url) VALUES (?,?,?,?,?)',
).run(o.id, o.name ?? o.id, o.private ?? 0, o.localDir ?? '', o.remoteUrl ?? '')
const addGoal = (o) => db.prepare(
  'INSERT INTO goal (id, scope, objective, status, mode, createdAt) VALUES (?,?,?,?,?,?)',
).run(o.id, o.scope, o.objective, o.status ?? 'active', 'chain', o.createdAt ?? '2026-01-01T00:00:00.000Z')

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close?.() } catch { /* 已关闭 */ }
  try { mod?.db?.close?.() } catch { /* 已关闭 */ }
  rmSync(dbDir, { recursive: true, force: true })
})

// ── ⑫ board 的三个过滤参数 ───────────────────────────────────────────────
test('⑫ ★★★ `/api/board` 的 status / soldier / scope 三个过滤**各自**在生效', async () => {
  clear()
  addTask({ id: 'b1', status: 'todo', soldier: 's1', role: 'r1', scope: 'alpha' })
  addTask({ id: 'b2', status: 'done', soldier: 's2', role: 'r1', scope: 'alpha' })
  addTask({ id: 'b3', status: 'todo', soldier: 's1', role: 'r2', scope: 'beta' })

  const all = await get('/api/board')
  assert.equal(all.status, 200)
  assert.equal(all.body.length, 3, '不带过滤 ⇒ 全都要')

  const byStatus = await get('/api/board?status=todo')
  assert.deepEqual(byStatus.body.map((t) => t.id), ['b1', 'b3'], '★ 丢掉 status 就会回到 3 条')

  const bySoldier = await get('/api/board?soldier=s1')
  assert.deepEqual(bySoldier.body.map((t) => t.id), ['b1', 'b3'], '★ 丢掉 soldier 就会回到 3 条')

  const byScope = await get('/api/board?scope=beta')
  assert.deepEqual(byScope.body.map((t) => t.id), ['b3'], '★ 丢掉 scope 就会回到 3 条')

  const byRole = await get('/api/board?role=r1')
  assert.deepEqual(byRole.body.map((t) => t.id), ['b1', 'b2'])

  // 三个一起给：AND 关系
  const combo = await get('/api/board?status=todo&soldier=s1&scope=alpha')
  assert.deepEqual(combo.body.map((t) => t.id), ['b1'])
})

// ── ⑬ task ───────────────────────────────────────────────────────────────
test('⑬ ★★★ `GET /api/task` 缺 `id` ⇒ 400；未知 id ⇒ 404；已知 ⇒ 200 + 行视图', async () => {
  clear()
  addTask({ id: 't1', status: 'todo', scope: 'default' })

  const missing = await get('/api/task')
  assert.equal(missing.status, 400, '★ 去掉那道 `if (!id)` 就会拿 null 去查库、走到 404')
  assert.equal(missing.body.error, '缺少参数 id')

  const unknown = await get('/api/task?id=nope')
  assert.equal(unknown.status, 404, '★ 404 改成 200 的话，调用方会把"没有这个任务"读成"任务存在"')
  assert.match(String(unknown.body.error), /未知任务 nope/)

  const ok = await get('/api/task?id=t1')
  assert.equal(ok.status, 200)
  // rowToTask 的形态：`hold` 是布尔、`acceptance` 是数组（库行里是字符串/0-1）
  assert.equal(ok.body.id, 't1')
  assert.equal(ok.body.hold, false, '★ 不过 `rowToTask` 的话这里是 0，不是 false')
  assert.deepEqual(ok.body.acceptance, [], '★ 不过 `rowToTask` 的话这里是字符串 `"[]"`')
  assert.equal(typeof ok.body.version, 'number')
})

// ── ⑭~⑳ missions：这一族里唯一一条**一条判据都没有**的路由 ────────────────
test('⑭ ★★★ `/api/missions` 这个路径要能真被请求到', async () => {
  clear()
  addTask({ id: 'm1', status: 'done', role: 'alpha' })
  const r = await get('/api/missions')
  assert.equal(r.status, 200, '★ 改坏路径、或没接线，这里就是 404（而原有七套判据一条都不会红）')
  assert.equal(r.body.scopeAware, true, '★ 这一族是**真 scope 分区**，这个标记不能是 false')
  assert.equal(r.body.scope, null, '没给 scope ⇒ 回执里是 null')
  assert.ok(typeof r.body.generatedAt === 'string')
  assert.equal(r.body.missions.length, 1)
})

test('⑮ ★★★ missions **不**把 canceled 算进去（它连 total 都不进）', async () => {
  clear()
  addTask({ id: 'c1', status: 'done', role: 'alpha' })
  addTask({ id: 'c2', status: 'done', role: 'alpha' })
  addTask({ id: 'c3', status: 'todo', role: 'alpha' })
  addTask({ id: 'c4', status: 'canceled', role: 'alpha' })

  const [m] = (await get('/api/missions')).body.missions
  assert.equal(m.total, 3, '★ 不跳过 canceled 会变成 4')
  assert.equal(m.done, 2)
  assert.equal(m.percent, 67, '★ 2/3 ⇒ 67；不跳过 canceled 是 2/4 ⇒ 50')
})

test('⑯ ★★★ missions 的 percent 是**整数百分比**（不是 0~1 的小数）', async () => {
  clear()
  addTask({ id: 'p1', status: 'done', role: 'one-of-two' })
  addTask({ id: 'p2', status: 'todo', role: 'one-of-two' })
  const [m] = (await get('/api/missions')).body.missions
  assert.equal(m.percent, 50, '★ 漏乘 100 会得到 Math.round(0.5) = 1')
})

test('⑰ ★★★ missions 的 status：**blocked 压过一切**；全完成是 done；没人动是 waiting', async () => {
  clear()
  addTask({ id: 's1', status: 'done', role: 'blocked-one' })
  addTask({ id: 's2', status: 'blocked', role: 'blocked-one' })
  addTask({ id: 's3', status: 'done', role: 'done-one' })
  addTask({ id: 's4', status: 'todo', role: 'waiting-one' })
  addTask({ id: 's5', status: 'in_progress', role: 'running-one' })

  const byRole = Object.fromEntries((await get('/api/missions')).body.missions.map((m) => [m.role, m.status]))
  assert.equal(byRole['blocked-one'], 'blocked', '★ 去掉 blocked 优先那条，它会掉到 running/waiting')
  assert.equal(byRole['done-one'], 'done', '★ 全完成 ⇒ done')
  assert.equal(byRole['waiting-one'], 'waiting', '★ 没有 in_progress/in_review ⇒ waiting')
  assert.equal(byRole['running-one'], 'running', '★ 有 in_progress ⇒ running')
})

test('⑱ ★★★ missions 的排序：先按状态档，同档按 percent 降序', async () => {
  clear()
  // waiting 档：alpha 67% > unassigned 0%
  // ★ 第一版给这几条都塞了 `soldier: 's'` 当"同一个士兵"的标记 —— 结果分组键变成了 `s`，
  //   因为回退链是 `role ?? soldier ?? 'unassigned'`（见 ⑲d）。
  //   > 一个"我给的只是个无关的标记字段"的印象，与一个"那个字段**正是**分组键的回退来源"的事实，
  //   > 在我没有把回退链读全的时候是同一个东西。
  addTask({ id: 'o1', status: 'done', role: 'alpha' })
  addTask({ id: 'o2', status: 'done', role: 'alpha' })
  addTask({ id: 'o3', status: 'todo', role: 'alpha' })
  addTask({ id: 'o4', status: 'todo' })                    // role/soldier 都空 ⇒ unassigned
  addTask({ id: 'o5', status: 'blocked', role: 'beta' })
  addTask({ id: 'o6', status: 'done', role: 'beta' })
  addTask({ id: 'o7', status: 'done', role: 'gamma' })

  const order = (await get('/api/missions')).body.missions.map((m) => m.role)
  assert.deepEqual(order, ['alpha', 'unassigned', 'beta', 'gamma'],
    '★ 把 rank 表改掉（running/done 互换之类）这个顺序就会变')
  const percents = (await get('/api/missions')).body.missions.map((m) => m.percent)
  assert.equal(percents[0], 67, '同档按 percent 降序 ⇒ alpha 在 unassigned 前面')
})

test('⑲ ★★ missions 的 `name` 走标签表，取不到才回退 role（unassigned 有个固定标签）', async () => {
  clear()
  addTask({ id: 'n1', status: 'todo', role: 'no-such-stage' })
  addTask({ id: 'n2', status: 'todo' })  // 无 role、无 soldier ⇒ unassigned
  const byRole = Object.fromEntries((await get('/api/missions')).body.missions.map((m) => [m.role, m.name]))
  assert.equal(byRole['no-such-stage'], 'no-such-stage', '标签表里没有 ⇒ 回退成 role 本身')
  assert.equal(byRole.unassigned, '未指派',
    '★ 不用 labels 而直接写 `name: role` 的话，这里会是 `unassigned`')
})

test('⑲d ★★ 分组键的回退链是 `role ?? soldier ?? "unassigned"`（三层，不是两层）', async () => {
  clear()
  addTask({ id: 'f1', status: 'todo', role: 'real-role', soldier: 'soldier-name' })
  addTask({ id: 'f2', status: 'todo', soldier: 'soldier-name' })  // 只有 soldier
  addTask({ id: 'f3', status: 'todo' })                           // 两个都空
  const roles = (await get('/api/missions')).body.missions.map((m) => m.role).sort()
  assert.deepEqual(roles, ['real-role', 'soldier-name', 'unassigned'],
    '★ role 为空时落回 **soldier**（不是直接落 unassigned）；两个都空才是 unassigned')
})

test('⑲b ★★ missions 认 `scope` 过滤（真 scope 分区）', async () => {
  clear()
  addTask({ id: 'z1', status: 'todo', role: 'in-alpha', scope: 'alpha' })
  addTask({ id: 'z2', status: 'todo', role: 'in-beta', scope: 'beta' })
  const r = await get('/api/missions?scope=alpha')
  assert.deepEqual(r.body.missions.map((m) => m.role), ['in-alpha'])
  assert.equal(r.body.scope, 'alpha')
})

test('⑲c ★★ missions 每个分组的 `tasks` 只带 id/title/status 三个字段', async () => {
  clear()
  addTask({ id: 'k1', title: '标题', status: 'todo', role: 'alpha' })
  const [m] = (await get('/api/missions')).body.missions
  assert.deepEqual(m.tasks, [{ id: 'k1', title: '标题', status: 'todo' }],
    '★ 把整行丢出去会带上 acceptance/boundary 等一串字段')
})

// ── ㉑㉒ scopes ───────────────────────────────────────────────────────────
test('㉑ ★★★ `/api/scopes` 是**任务表 ∪ 成员表**两边的并集', async () => {
  clear()
  addTask({ id: 'sc1', scope: 'from-task' })
  addMember('mem-1', 'from-member')
  const r = await get('/api/scopes')
  // ★★ 钉住的是**真实行为**：任务表那一段先来（各自 ORDER BY），成员表那一段接在后面 ——
  //   合起来**不是**全局有序的。第一版我按"应该排好序"写了期望值，于是假红。
  //   > 一个"并集当然是排好序的"的印象，与一个"两段各自有序、拼起来不保证有序"的事实，
  //   > 在我没有把两段 SQL 的拼接顺序读一遍的时候是同一个东西。
  //   （这处不对称本片**不修** —— 改排序会动对外契约；只把读数钉住。）
  assert.deepEqual(r.body.scopes, ['from-task', 'from-member'],
    '★ 不并 members 表的话这里只有 from-task')
})

test('㉒ ★★ scopes 过滤掉 NULL 与空串', async () => {
  clear()
  addTask({ id: 'sc2', scope: 'real' })
  addTask({ id: 'sc3', scope: '' })
  addMember('mem-2', '')
  const r = await get('/api/scopes')
  assert.deepEqual(r.body.scopes, ['real'], '★ 不过滤空串的话这里会多出一个空字符串')
})

// ── ㉓㉔㉕ spaces ────────────────────────────────────────────────────────
test('㉓ ★★★ `/api/spaces` 的 `agentCount` 是**该空间真实的花名册人数**', async () => {
  clear()
  addSpace({ id: 'sp1', name: '空间一' })
  addRoster('sp1', 'r-a', 'A')
  addRoster('sp1', 'r-b', 'B')
  addSpace({ id: 'sp2', name: '空间二' })
  const byId = Object.fromEntries((await get('/api/spaces')).body.spaces.map((s) => [s.id, s]))
  assert.equal(byId.sp1.agentCount, 2, '★ 写死 0 的话这里就是 0')
  assert.equal(byId.sp2.agentCount, 0)
})

test('㉔ ★★ spaces 的 `private` 是**布尔**，且跟着库里的 0/1 走', async () => {
  clear()
  addSpace({ id: 'pv1', private: 1 })
  addSpace({ id: 'pv2', private: 0 })
  const byId = Object.fromEntries((await get('/api/spaces')).body.spaces.map((s) => [s.id, s]))
  assert.equal(byId.pv1.private, true, '★ 恒 false 的话这里就不会是 true')
  assert.equal(byId.pv2.private, false)
})

test('㉕ ★★ spaces 的 `name` 取不到时**回退成 id**（未注册的空间也要有名字）', async () => {
  clear()
  addTask({ id: 'q1', scope: 'unregistered-space' })  // 只在 tasks 里出现，spaces 表里没有
  const byId = Object.fromEntries((await get('/api/spaces')).body.spaces.map((s) => [s.id, s]))
  assert.ok(byId['unregistered-space'], '未注册的既有 scope 也要出现在列表里')
  assert.equal(byId['unregistered-space'].name, 'unregistered-space', '★ 不回退的话这里会是 undefined')
  assert.equal(byId['unregistered-space'].localDir, '')
  assert.equal(byId['unregistered-space'].remoteUrl, '')
})

// ── ㉖~㉙ goal ───────────────────────────────────────────────────────────
test('㉖ ★★★ `/api/goal?scope=` 会**先把链已完成的目标结掉**（settle 那一步不能省）', async () => {
  clear()
  addGoal({ id: 'g-auto', scope: 'gs', objective: '全做完了' })
  addTask({ id: 'ga1', status: 'done', goalId: 'g-auto' })
  addTask({ id: 'ga2', status: 'done', goalId: 'g-auto' })

  const r = await get('/api/goal?scope=gs')
  assert.equal(r.status, 200)
  assert.equal(r.body.goals[0].status, 'done',
    '★ 不调 `settleGoalsOfScope` 的话它还是 active —— "链全部完成 → 目标自动 done" 就没了')
  assert.equal(r.body.done, 2)
  assert.equal(r.body.total, 2)
  assert.equal(r.body.percent, 100)
})

test('㉗ ★★★ `/api/goal` **不给 scope 就是空列表**（哪怕库里真有 scope 为空的目标）', async () => {
  clear()
  addGoal({ id: 'g-empty', scope: '', objective: '空空间的目标' })
  const r = await get('/api/goal')
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.goals, [],
    '★ 去掉 `scopeParam ? … : []` 那个三元，`listGoals("")` 就会把 scope 为空的目标列出来')
  assert.equal(r.body.scope, '')
})

test('㉘ ★★ goal 的 `percent` 是整数百分比（不是恒 0）', async () => {
  clear()
  addGoal({ id: 'g-pct', scope: 'gp', objective: 'X' })
  addTask({ id: 'gp1', status: 'done', goalId: 'g-pct' })
  addTask({ id: 'gp2', status: 'todo', goalId: 'g-pct' })
  const r = await get('/api/goal?scope=gp')
  assert.equal(r.body.percent, 50, '★ 恒 0 的话这里就是 0')
  assert.equal(r.body.objective, 'X', '★ `objective` 取最新的 active 目标文案')
})

test('㉙ ★★★ goal 的 `done`/`total` **不**把 canceled 目标算进去', async () => {
  clear()
  addGoal({ id: 'g-live', scope: 'gm', objective: '活着的' })
  addTask({ id: 'gm1', status: 'done', goalId: 'g-live' })
  addGoal({ id: 'g-dead', scope: 'gm', objective: '已取消的', status: 'canceled' })
  addTask({ id: 'gm2', status: 'done', goalId: 'g-dead' })
  addTask({ id: 'gm3', status: 'todo', goalId: 'g-dead' })

  const r = await get('/api/goal?scope=gm')
  assert.equal(r.body.total, 1, '★ 不排除 canceled 目标的话会变成 3')
  assert.equal(r.body.done, 1)
  assert.equal(r.body.percent, 100, '★ 不排除的话是 2/3 ⇒ 67')
  assert.equal(r.body.goals.length, 2, '但**列表**里两条都在（排除只影响汇总）')
})

// ── ㉚ pipeline ──────────────────────────────────────────────────────────
test('㉚ ★★★ `/api/pipeline` 非法 scope ⇒ 400（不能把非法 scope 递到下游）', async () => {
  const bad = await get('/api/pipeline?scope=' + encodeURIComponent('非法 space!'))
  assert.equal(bad.status, 400, '★ 去掉那道 `SCOPE_KEY_RE` 校验，它就会拿着非法 scope 往下走')
  assert.match(String(bad.body.error), /scope 非法/)

  // 合法 scope 不该被这道闸门拦住（哪怕是没注册过的空间）
  const ok = await get('/api/pipeline?scope=legal_space-1')
  assert.notEqual(ok.status, 400, '★ 闸门不能把合法 scope 也当非法')
})

// ── ㉛㉜ agents ──────────────────────────────────────────────────────────
test('㉛ ★★★ `/api/agents` 按 `role` 去重，并把来源空间收进 `scopes`', async () => {
  clear()
  addRoster('sp-a', 'same-role', '同一个人')
  addRoster('sp-b', 'same-role', '同一个人')
  addRoster('sp-a', 'other-role', '另一个人')

  const r = await get('/api/agents')
  assert.equal(r.status, 200)
  assert.equal(r.body.agents.length, 2, '★ 不去重的话这里会是 3 条（同一个 role 出现两次）')

  const same = r.body.agents.find((a) => a.role === 'same-role')
  assert.deepEqual(same.scopes, ['sp-a', 'sp-b'],
    '★ 丢掉 `e.scopes.push` 的话这里会是空数组 —— "标注来源空间"就没了')
  assert.equal(same.name, '同一个人')
  assert.equal(same.kind, 'agent')
  assert.equal(same.avatar, '🤖')
})

// ── ㉝ 接缝契约 ──────────────────────────────────────────────────────────
test('㉝ ★★★ dispatch 契约：命中 ⇒ 恰好跑一次并回 true；不命中（含方法不符）⇒ false', async () => {
  const ran = []
  const deps = {
    json: (res, code, payload) => { res.sent = { code, payload } },
    db: { prepare: () => ({ all: () => [], get: () => null }) },
    listTasks: () => { ran.push('listTasks'); return [] },
    rowToTask: (r) => r,
    pipelineLabels: () => ({}),
    now: () => 'T',
    settleGoalsOfScope: () => 0,
    listGoals: () => [],
    goalView: (g) => g,
    SCOPE_KEY_RE: /^[a-z]+$/,
    readPipeline: () => ({ ok: true }),
  }
  const router = createReadModelsRoutes(deps)

  let res = {}
  assert.equal(await router.dispatch({ method: 'GET' }, res, { path: '/api/nope', url: new URL('http://x/nope') }), false)
  assert.equal(ran.length, 0)

  // ★★ 方法不符也必须 false —— 本族八条全是 GET，而 `POST /api/spaces` 那四条是**别人的**
  res = {}
  assert.equal(await router.dispatch({ method: 'POST' }, res, { path: '/api/board', url: new URL('http://x/api/board') }), false,
    '★ 不看方法的话，`POST /api/spaces` 会被这一族抢走')
  assert.equal(ran.length, 0)

  res = {}
  assert.equal(await router.dispatch({ method: 'GET' }, res, { path: '/api/board', url: new URL('http://x/api/board') }), true)
  assert.deepEqual(ran, ['listTasks'], '★ 恰好一次；回 false 会让 handle() 再答复一次')

  assert.deepEqual(router.routes.map((r) => `${r.method} ${r.path}`), [
    'GET /api/board', 'GET /api/task', 'GET /api/missions', 'GET /api/scopes',
    'GET /api/spaces', 'GET /api/goal', 'GET /api/pipeline', 'GET /api/agents',
  ])
  assert.equal(router.id, 'read-models')
})
