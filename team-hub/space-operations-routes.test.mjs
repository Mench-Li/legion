// ============================================================================
// PRT-316 切片 39：工作空间的运维面 —— 3 条，全 `exact`
//   GET  /api/spaces/impact     删除预检（只读影响面）
//   GET  /api/spaces/provision  开通自检（诊断）
//   POST /api/spaces/delete     删除（含附件目录清理）
//
// ★★★ 本族是从 `/api/spaces` 的 **5 条**里挑出**唯一连续的 3 条** ——
//   那 5 条**从来没挨在一起过**（间隔 45 / 44 / 34 / 93 / 79 行，中间夹着 5 条别人的路由）。
//   `wire-family` 删的是**一段连续区间**，所以"一个族 = 一个前缀"在这里**不成立**。
//   剩下两条（`POST /api/spaces`、`POST /api/spaces/`）**仍在 `server.mjs` 里，且必须留着** ——
//   本文件最后两条判据就钉这件事。
//
//   > 一个「`/api/spaces` 是一族」的印象，
//   > 与一个「这 5 条从来没挨在一起过」的事实，
//   > 在我把每一对相邻路由的**间隔**数出来之前是同一个东西。
//
// ★★ 本片是**第一个**需要 **node 内建**的族（`existsSync` / `readFileSync` / `join` / `rmSync`）：
//   前 36 族的 `team-hub/routes/` 下**一个都没用过**。按"依赖全注入"一起注入。
// ============================================================================
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSpaceOperationsRoutes } from './routes/space-operations.mjs'

const dir = mkdtempSync(join(tmpdir(), 'legion-space-ops-'))
process.env.TEAM_HUB_DB = join(dir, 'team.db')
process.env.TEAM_HUB_TOKEN = ''
const mod = await import('./server.mjs')
await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + mod.server.address().port

const call = async (m, p, b) => {
  const res = await fetch(base + p, {
    method: m, headers: b === undefined ? {} : { 'content-type': 'application/json' },
    body: b === undefined ? undefined : JSON.stringify(b),
  })
  const t = await res.text(); let j; try { j = JSON.parse(t) } catch { j = t }
  return { status: res.status, body: j }
}
const get = (p) => call('GET', p)
const post = (p, b) => call('POST', p, b)

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close?.() } catch { /* 已关 */ }
  try { mod?.db?.close?.() } catch { /* 已关 */ }
  rmSync(dir, { recursive: true, force: true })
})

// 造一个真空间（`POST /api/spaces` 仍在 server.mjs 里，用 by 当操作者）
const mkSpace = (id) => post('/api/spaces', { id, name: id, by: 'general' })

// ── 1. impact：删除预检（只读）──────────────────────────────────────────
test('① ★★★ `impact` 三种坏 id 都是 400，且**两种错说两句不同的话**', async () => {
  for (const [label, q] of [['缺 id', ''], ['id 是大写', '?id=BAD'], ['id 空串', '?id=']]) {
    const r = await get('/api/spaces/impact' + q)
    assert.equal(r.status, 400, `${label} 应当 400`)
    assert.match(String(r.body.error), /空间 id 非法/, `${label}：${JSON.stringify(r.body)}`)
  }
  // ★★ "格式不对"与"查无此空间"是**两个不同的事实** —— 不许合并成一句话
  const unknown = await get('/api/spaces/impact?id=no-such-space')
  assert.equal(unknown.status, 400)
  assert.match(String(unknown.body.error), /未知空间/)
  assert.ok(!/非法/.test(String(unknown.body.error)),
    '★★ 未知空间不该被报成"id 非法"——调用方会去改 id 的格式，而该改的是那个 id 本身')
})

test('①b ★★ 真空间 ⇒ 200 `{id, counts, running:{tasks}}`；且预检**只读**（再审一次结果不变）', async () => {
  assert.equal((await mkSpace('so-a')).status, 200)
  const r = await get('/api/spaces/impact?id=so-a')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.id, 'so-a')
  assert.equal(typeof r.body.counts, 'object')
  assert.ok(Array.isArray(r.body.running.tasks), '★ 在办任务要能给出来（预检的意义就在这）')
  // ★ 只读：这道"预检"不许有任何副作用
  const again = await get('/api/spaces/impact?id=so-a')
  assert.deepEqual(again.body.counts, r.body.counts, '★★ 预检跑两遍不许改数据面')
})

// ── 2. provision：诊断（**不是**查询）───────────────────────────────────
test('② ★★★ `provision` 对**不存在的**空间回 200 + `ok:false` + `checks`（诊断语义）', async () => {
  // ★★★ 这一条是"看错语义就会写错判据"的典型：
  //   它回 200 而 `ok:false`，**不是** 404 —— 因为它的工作是"告诉你这个空间缺什么"，
  //   而"这个空间根本没注册"正是它要报告的第一条。
  const r = await get('/api/spaces/provision?id=ghost-space')
  assert.equal(r.status, 200, '★★ 缺空间不是"查不到"，而是"诊断出一条 error"')
  assert.equal(r.body.ok, false, '★★ 但 `ok` 必须是 false —— 200 不等于一切正常')
  assert.equal(r.body.id, 'ghost-space')
  assert.ok(Array.isArray(r.body.checks), '★★ checks 是它的正文')
  const codes = r.body.checks.map((c) => c.code)
  assert.ok(codes.includes('space-missing'), `★★ 必须报 space-missing，实际 ${JSON.stringify(codes)}`)
  for (const c of r.body.checks) {
    // ★ 实测 level 取值是 `ok` / `warn` / `error` 三种（**有 `ok`**，不是只有问题项）
    assert.ok(['ok', 'warn', 'error', 'info'].includes(c.level), `★ level 取值可疑：${c.level}`)
    assert.equal(typeof c.message, 'string')
  }
})

test('②b ★★ `provision` 的 id 非法 ⇒ 400（**与 impact 的校验规则不同**：它多允许下划线）', async () => {
  for (const q of ['', '?id=BAD!']) {
    const r = await get('/api/spaces/provision' + q)
    assert.equal(r.status, 400, `provision${q} 应当 400`)
    assert.match(String(r.body.error), /空间 id 非法/)
  }
  // ★ 实测：impact 用 `/^[a-z0-9][a-z0-9-]{0,63}$/`（无下划线），provision 用 `SCOPE_KEY_RE`（有下划线）
  const under = await get('/api/spaces/impact?id=a_b')
  assert.equal(under.status, 400, '★ impact 不认下划线')
  const under2 = await get('/api/spaces/provision?id=a_b')
  assert.equal(under2.status, 200, '★ provision 认下划线 —— 两条用了**两套** id 校验，这是实测事实')
})

// ── 3. ★★★ delete：两道闸门 ────────────────────────────────────────────
test('③ ★★★ `delete` 是**双闸**：先要操作者 `by`，再要 `confirm` 令牌', async () => {
  assert.equal((await mkSpace('so-del')).status, 200)
  // 第一道：没有 by
  const noBy = await post('/api/spaces/delete', { id: 'so-del', confirm: 'delete-space:so-del' })
  assert.equal(noBy.status, 400)
  assert.match(String(noBy.body.error), /缺少操作者身份 by/, '★★ 第 1 道闸是"谁干的"')
  // 第二道：有 by、但没 confirm
  const noConfirm = await post('/api/spaces/delete', { id: 'so-del', by: 'general' })
  assert.equal(noConfirm.status, 400)
  assert.match(String(noConfirm.body.error), /缺少确认/, '★★ 第 2 道闸是"你确定吗"')
  assert.match(String(noConfirm.body.error), /delete-space:/, '★★ 必须说清 confirm 的确切形状')
  // ★ 被拒之后空间必须**还在**
  const still = await get('/api/spaces/impact?id=so-del')
  assert.equal(still.status, 200, '★★★ 闸门拦住之后**什么都不许发生**')
})

test('③b ★★★ `confirm` 令牌必须**点名那个 id**（换个 id 不算数）', async () => {
  assert.equal((await mkSpace('so-x')).status, 200)
  const wrong = await post('/api/spaces/delete', { id: 'so-x', by: 'general', confirm: 'delete-space:so-y' })
  assert.equal(wrong.status, 400, '★★ 令牌点的是别的空间 ⇒ 不许删')
  assert.match(String(wrong.body.error), /缺少确认/)
  const still = await get('/api/spaces/impact?id=so-x')
  assert.equal(still.status, 200, '★★★ 令牌不匹配时**什么都不许发生**')
})

test('③c ★★★ 两道闸都过 ⇒ 真的删掉，并回报 `{ok, task:{id, removed}}`', async () => {
  assert.equal((await mkSpace('so-real')).status, 200)
  assert.equal((await get('/api/spaces/impact?id=so-real')).status, 200)
  const r = await post('/api/spaces/delete', { id: 'so-real', by: 'general', confirm: 'delete-space:so-real' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  // ★ 实测形状：正文包在 `task` 里（`handleWrite` 的统一信封），`removed` 在它下面
  assert.equal(r.body.ok, true)
  assert.equal(r.body.task.id, 'so-real')
  // ★★ 必须逐项回报删掉了什么 —— 这个操作删的是该空间**全部**数据
  assert.equal(typeof r.body.task.removed, 'object', '★★ 必须回报删除清单')
  for (const k of ['tasks', 'roster', 'skills', 'goal', 'conversations', 'calendarEvents', 'spaceStages']) {
    assert.ok(k in r.body.task.removed, `★★ removed 少了一项：${k}`)
    assert.equal(typeof r.body.task.removed[k], 'number', '★ 每一项都是计数')
  }
  // ★ 删完真的没了
  const gone = await get('/api/spaces/impact?id=so-real')
  assert.equal(gone.status, 400, '★★ 回报说删了，就真得没了')
  assert.match(String(gone.body.error), /未知空间/)
})

// ── 4. ★★★ 接缝契约 ────────────────────────────────────────────────────
const stub = (over = {}) => createSpaceOperationsRoutes({
  json: (res, code, p) => { res.sent = { code, payload: p } },
  // ★ 桩要**照实**：真 `handleWrite` 在缺 `confirm` 令牌时直接拒（不调回调）。
  //   原先桩无条件调回调，于是 `delete` 的 run 在无 body 时抛错、测试红 ——
  //   **桩比真东西宽松**，这是这次 3 个红里最值得记的一个。
  handleWrite: async (req, res, fn) => {
    const { id, confirm } = req.body ?? {}
    if (typeof id !== 'string' || confirm !== `delete-space:${id}`) {
      res.sent = { code: 400, payload: { error: `缺少确认：confirm 须为 delete-space:${id ?? '<id>'}` } }
      return
    }
    res.sent = { code: 200, payload: await fn({ id }, 'general', id) }
  },
  audit: () => {}, now: () => '2026-01-01T00:00:00.000Z',
  withTx: (fn) => fn(), SCOPE_KEY_RE: /^[a-z0-9][a-z0-9_-]{0,63}$/,
  readPipeline: () => ({ version: 'v', stages: [], activeRoles: [], runtime: { enabled: false } }),
  pipelineWarnings: () => [], UPLOADS_ROOT: '/tmp/nope',
  existsSync: () => false, readFileSync: () => '', join, rmSync: () => {},
  db: { prepare: () => ({ get: () => undefined, all: () => [] }) },
  ...over,
})

test('④ ★★★ dispatch 契约：看方法、命中回 true、不命中回 false', async () => {
  const router = stub()
  const ctx = (p) => ({ path: p, url: new URL('http://x' + p) })
  assert.equal(await router.dispatch({ method: 'POST' }, {}, ctx('/api/spaces/impact')), false, '★★ `/impact` 只认 GET')
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/spaces/delete')), false, '★★ `/delete` 只认 POST')
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/spaces/nope')), false)
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/spaces/impact')), true)
  assert.equal(await router.dispatch({ method: 'POST' }, {}, ctx('/api/spaces/delete')), true)
  // ★ `exact` 不许退化成 `startsWith`
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/spaces/impactX')), false)
  assert.deepEqual(router.routes.map((r) => `${r.method} ${r.match} ${r.path}`), [
    'GET exact /api/spaces/impact', 'GET exact /api/spaces/provision', 'POST exact /api/spaces/delete',
  ])
  assert.equal(router.id, 'space-operations')
})

test('⑤ ★★★ 本族**不许**吃掉同前缀下那两条**不属本族**的路由', async () => {
  // ★★ 这两条别的片还要搬（它们被别人的路由与本族隔开，所以本族取不到）。
  //   本族与它们**同前缀**，因此必须逐条证明"不吃"。
  const router = stub()
  const ctx = (p) => ({ path: p, url: new URL('http://x' + p) })
  for (const [m, p] of [['POST', '/api/spaces'], ['POST', '/api/spaces/'], ['GET', '/api/spaces'], ['POST', '/api/spaces/anything']]) {
    assert.equal(await router.dispatch({ method: m }, {}, ctx(p)), false, `★★★ 本族不许吃掉 ${m} ${p}`)
  }
})

test('⑤b ★★ 缺注入项 ⇒ **构造时**就抛（fail closed；本族有 13 个注入项，是至今最多的）', async () => {
  const full = {
    json: () => {}, handleWrite: async () => {}, audit: () => {}, db: {}, now: () => 0,
    withTx: () => {}, SCOPE_KEY_RE: /x/, readPipeline: () => ({}), pipelineWarnings: () => [],
    UPLOADS_ROOT: '/', existsSync: () => false, readFileSync: () => '', join: () => '', rmSync: () => {},
  }
  for (const k of Object.keys(full)) {
    const partial = { ...full }
    delete partial[k]
    assert.throws(() => createSpaceOperationsRoutes(partial), /缺注入项/, `★★ 少了 ${k} 必须在构造时就抛`)
  }
})
