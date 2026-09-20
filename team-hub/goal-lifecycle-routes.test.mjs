// ============================================================================
// PRT-316 切片 40：目标的发布与生命周期 —— 3 条，全 `exact`
//   POST /api/goal          发布（含阶段任务链）
//   POST /api/goal/context  更新目标级上下文
//   POST /api/goal/status   状态迁移（暂停 / 恢复 / 完成 / 取消）
//
// ★★★ **本族 3 条里有 2 条此前一个判据都没有**：
//   survey 读数是 `/api/goal` 强判据 3 套 / 11 个请求点，
//   而 `/api/goal/context` 与 `/api/goal/status` 都是 **0 套 / 0 个请求点**。
//   全仓库搜过：`goal/context` **连一个调用方都没有**；
//   `goal/status` 只在 `scratch/verify-cancel-strand.mjs` 与 `scripts/prt/gf001-run.mjs` 里被调过 ——
//   而那两处**不在回归选择器里**（选择器只扫 `team-hub/*.test.mjs` 且要含 `server.mjs`）。
//
//   > 一个「这一族有 3 套判据」的印象，
//   > 与一个「3 条里有 2 条从来没被任何判据碰过，其中一条连调用方都没有」的事实，
//   > 在我**逐条**去问请求点之前是同一个东西。
//
// ★★ 所以本文件重点不在"再测一遍发布"，而在**注入点上的参数搬运契约** ——
//   这三条路由本身几乎只是胶水：真正的活儿全在 `publishGoalRecord` /
//   `setGoalContext` / `setGoalState` 三个被注入的域函数里。
//   胶水**搬错了参数**（作用域回落、mode 映射、docSync 的两个来源、forceGeneral 的严格 true），
//   域层再正确也没用，而这三处此前**没人看过**。
// ============================================================================
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createGoalLifecycleRoutes } from './routes/goal-lifecycle.mjs'

const dir = mkdtempSync(join(tmpdir(), 'legion-goal-life-'))
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
const post = (p, b) => call('POST', p, b)
const goalOf = (r) => r.body?.task?.goal

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close?.() } catch { /* 已关 */ }
  try { mod?.db?.close?.() } catch { /* 已关 */ }
  rmSync(dir, { recursive: true, force: true })
})

// ── 真 hub：三条路由的可观测行为 ────────────────────────────────────────
test('① ★★★ 三条都先过 `handleWrite` 的操作者闸（`by` 排在最前）', async () => {
  for (const p of ['/api/goal', '/api/goal/context', '/api/goal/status']) {
    const r = await post(p, {})
    assert.equal(r.status, 400, `${p} 空 body 应当 400`)
    assert.match(String(r.body.error), /缺少操作者身份 by/,
      `★★ ${p}：应当**先**报"谁干的"，实际 ${JSON.stringify(r.body)}`)
  }
})

test('② ★★★ `POST /api/goal` 缺 `objective`（或只有空白）⇒ 400', async () => {
  for (const b of [{ by: 'general' }, { by: 'general', objective: '' }, { by: 'general', objective: '   ' }]) {
    const r = await post('/api/goal', b)
    assert.equal(r.status, 400, JSON.stringify(b))
    assert.match(String(r.body.error), /缺少参数 objective/)
  }
})

test('②b ★★★ 正常发布 ⇒ `{ok, task:{goal}}`，status=active、version=1、`mode` 缺省是 `chain`', async () => {
  const r = await post('/api/goal', { by: 'general', objective: '切片 40 目标' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.ok, true)
  const g = goalOf(r)
  assert.ok(g && typeof g === 'object', '★★ 正文在 `task.goal` 里')
  assert.match(String(g.id), /^G-/, '★ 目标 id 形如 G-…')
  assert.equal(g.status, 'active')
  assert.equal(g.version, 1)
  assert.equal(g.mode, 'chain', '★★ mode 缺省是 chain（不是 slice）')
  assert.equal(g.contextVersion, 0, '★ 新目标的上下文版本是 0')
  assert.equal(g.docSync, false)
})

test('②c ★★★ `mode: slice` 在**人手不够**时会**静默回落**成 `chain`（记录也跟着改）', async () => {
  // ★★★ 我第一版断言"给了 slice 就该回 slice" —— **错了**。
  //   域层 L2124 写着：「记录实际生效的模式（**slice 缺岗会回退 chain**）」：
  //     const chain = createGoalChain(goalId, targetScope, objective.trim(), rawMode)
  //     if (chain.mode !== rawMode) { UPDATE goal SET mode=? ... }
  //   所以回复里的 `mode` 是**实际生效**的那个，不是**请求**的那个。
  //   一个空空间没有人手 ⇒ slice 建不出阶段链 ⇒ 回落 chain，并把记录改成 chain。
  //
  //   > 一个「给了 `mode: slice` 就得到 slice」的印象，
  //   > 与一个「它按**编队能不能站满**决定实际模式、还可能回头改记录」的事实，
  //   > 在我读到那行注释之前是同一个东西。
  const a = await post('/api/goal', { by: 'general', objective: 'A', mode: 'slice' })
  assert.equal(goalOf(a).mode, 'chain',
    '★★ 没有编队/流水线时，slice 必须回落 chain（这是设计，不是 bug）')
  // ★ 请求的那个 mode **确实**被原样递进了域函数 —— 用 spy 才看得见（见 ⑤c）
  const { router, calls } = spyRouter()
  await drive(router, '/api/goal', { by: 'general', objective: 'B', mode: 'slice' })
  assert.equal(calls.publish[0][2], 'slice', '★★★ 路由把**请求的** mode 原样递进去；回落是域层的决定')
  await drive(router, '/api/goal', { by: 'general', objective: 'B', mode: 'chain' })
  assert.equal(calls.publish[1][2], 'chain')
  for (const m of ['SLICE', 'slice-ish', '', null, 123]) {
    await drive(router, '/api/goal', { by: 'general', objective: 'B', mode: m })
    assert.equal(calls.publish.at(-1)[2], 'chain', `★★ 请求 mode=${JSON.stringify(m)} 只映射成 chain`)
  }
})

test('③ ★★★ `POST /api/goal/status` 只认四个状态（`done` / `canceled` 是终态）', async () => {
  const g = goalOf(await post('/api/goal', { by: 'general', objective: '状态闸' })).id
  for (const s of ['', 'nope', 'ACTIVE', 'Paused', null]) {
    const r = await post('/api/goal/status', { by: 'general', id: g, status: s })
    assert.equal(r.status, 400, `status=${JSON.stringify(s)} 应当 400`)
    assert.match(String(r.body.error), /status 必须是 active\|paused\|done\|canceled/,
      `★★ 错误里要**逐个列出**合法取值，实际 ${JSON.stringify(r.body)}`)
  }
})

test('③b ★★★ 状态迁移**每次 version +1**（乐观锁），且能来回切', async () => {
  const g0 = goalOf(await post('/api/goal', { by: 'general', objective: '版本' }))
  assert.equal(g0.version, 1)
  const p = goalOf(await post('/api/goal/status', { by: 'general', id: g0.id, status: 'paused' }))
  assert.equal(p.status, 'paused')
  assert.equal(p.version, 2, '★★ 每次迁移 version 必须自增（调用方拿它做乐观锁）')
  const a = goalOf(await post('/api/goal/status', { by: 'general', id: g0.id, status: 'active' }))
  assert.equal(a.status, 'active')
  assert.equal(a.version, 3, '★★ 恢复也要自增')
})

test('③c ★★★ `status` 仅允许将军（`by=general`）', async () => {
  const g = goalOf(await post('/api/goal', { by: 'general', objective: '将军闸' })).id
  const r = await post('/api/goal/status', { by: 'someone', id: g, status: 'paused' })
  assert.equal(r.status, 400)
  assert.match(String(r.body.error), /仅允许将军/, `★★ 实际 ${JSON.stringify(r.body)}`)
  // ★ 被拒之后状态不许变
  const now = goalOf(await post('/api/goal/context', { by: 'general', id: g, text: 'x' }))
  assert.equal(now.status, 'active', '★★★ 身份不够时**什么都不许发生**')
})

test('④ ★★★ `POST /api/goal/context` 空/缺 `text` ⇒ 400；正常则 `contextVersion` +1', async () => {
  const g = goalOf(await post('/api/goal', { by: 'general', objective: '上下文' })).id
  for (const t of [undefined, '', '   ']) {
    const r = await post('/api/goal/context', { by: 'general', id: g, text: t })
    assert.equal(r.status, 400, `text=${JSON.stringify(t)} 应当 400`)
    assert.match(String(r.body.error), /context 必须是非空字符串/)
  }
  const r1 = await post('/api/goal/context', { by: 'general', id: g, text: '# 第一版' })
  assert.equal(r1.status, 200, JSON.stringify(r1.body))
  assert.equal(goalOf(r1).context, '# 第一版')
  assert.equal(goalOf(r1).contextVersion, 1, '★★ 每次更新 contextVersion 必须自增')
  const r2 = await post('/api/goal/context', { by: 'general', id: g, text: '# 第二版' })
  assert.equal(goalOf(r2).contextVersion, 2)
  assert.equal(goalOf(r2).context, '# 第二版')
})

test('④b ★★★ 未知目标 ⇒ 400「未知目标 X」，**三条都**如此', async () => {
  const ghost = 'G-nope-does-not-exist'
  for (const [p, b] of [
    ['/api/goal/context', { by: 'general', id: ghost, text: 'x' }],
    ['/api/goal/status', { by: 'general', id: ghost, status: 'paused' }],
  ]) {
    const r = await post(p, b)
    assert.equal(r.status, 400, `${p} 应当 400`)
    assert.match(String(r.body.error), /未知目标/, `★★ ${p} 实际 ${JSON.stringify(r.body)}`)
  }
})

test('④c ★★ 缺 `id` ⇒ 400（`id` 排在 `text`/`status` 之前被检查）', async () => {
  for (const p of ['/api/goal/context', '/api/goal/status']) {
    const r = await post(p, { by: 'general' })
    assert.equal(r.status, 400)
    assert.match(String(r.body.error), /缺少参数 id/, `★★ ${p} 应当先报缺 id`)
  }
})

// ── ★★★ 注入点上的**参数搬运契约**（这三条路由的正文，此前没人看过）────
const spyRouter = (over = {}) => {
  const calls = { publish: [], setCtx: [], setState: [] }
  const router = createGoalLifecycleRoutes({
    json: (res, code, p) => { res.sent = { code, payload: p } },
    // 桩要**照实**：真 `handleWrite` 先查 by，再把回调**包在 try/catch 里**、出错转 400。
    //   ★ 我第一版漏了那层 catch ⇒ ⑥ 里用空 body 驱动 `/api/goal` 时，
    //     回调抛的「缺少参数 objective」**直接穿出 dispatch** —— 桩比真东西**严**，
    //     于是一条本该测"命中回 true"的判据，变成了"路由会抛异常"。
    //   （切片 39 的教训是"桩比真东西**宽松**"，本片是反过来的那一面。）
    handleWrite: async (req, res, fn) => {
      const body = req.body ?? {}
      if (body.by !== 'general') { res.sent = { code: 400, payload: { error: '缺少操作者身份 by' } }; return }
      try {
        res.sent = { code: 200, payload: await fn(body, 'general', 'scope-from-hub') }
      } catch (e) {
        res.sent = { code: 400, payload: { error: e instanceof Error ? e.message : String(e) } }
      }
    },
    publishGoalRecord: (...a) => { calls.publish.push(a); return { ok: 1 } },
    setGoalContext: (...a) => { calls.setCtx.push(a); return { ok: 1 } },
    setGoalState: (...a) => { calls.setState.push(a); return { ok: 1 } },
    ...over,
  })
  return { router, calls }
}
const drive = async (router, path, body) => {
  const res = {}
  await router.dispatch({ method: 'POST', body }, res, { path, url: new URL('http://x') })
  return res
}

test('⑤ ★★★ 发布时**作用域回落**：`body.scope` 有就用（trim），没有就用 hub 给的那个', async () => {
  const { router, calls } = spyRouter()
  await drive(router, '/api/goal', { by: 'general', objective: 'O' })
  assert.deepEqual(calls.publish[0], ['scope-from-hub', 'O', 'chain', 'general', false],
    '★★★ 没有 body.scope 时必须回落到 handleWrite 递进来的 scope')
  await drive(router, '/api/goal', { by: 'general', objective: 'O', scope: '  other  ' })
  assert.equal(calls.publish[1][0], 'other', '★★ 给了 scope 就用它，且要去空白')
  await drive(router, '/api/goal', { by: 'general', objective: 'O', scope: '   ' })
  assert.equal(calls.publish[2][0], 'scope-from-hub', '★ 只有空白等于没给')
  await drive(router, '/api/goal', { by: 'general', objective: 'O', scope: 123 })
  assert.equal(calls.publish[3][0], 'scope-from-hub', '★ 非字符串也等于没给')
})

test('⑤b ★★★ `docSync` 有**两个来源**：`body.docSync === true` **或** `body.feature === true`', async () => {
  const { router, calls } = spyRouter()
  await drive(router, '/api/goal', { by: 'general', objective: 'O' })
  assert.equal(calls.publish[0][4], false, '★ 都没有 ⇒ false')
  await drive(router, '/api/goal', { by: 'general', objective: 'O', docSync: true })
  assert.equal(calls.publish[1][4], true, '★ docSync: true ⇒ true')
  await drive(router, '/api/goal', { by: 'general', objective: 'O', feature: true })
  assert.equal(calls.publish[2][4], true, '★★ feature: true 也 ⇒ true（第二个来源）')
  // ★ 严格 `=== true`：真值不算
  for (const v of [1, 'true', 'yes', {}]) {
    await drive(router, '/api/goal', { by: 'general', objective: 'O', docSync: v })
    assert.equal(calls.publish.at(-1)[4], false, `★★ docSync=${JSON.stringify(v)} 必须当作 false（严格 === true）`)
  }
})

test('⑤c ★★★ `context` / `status` 的参数**按位置**搬：`(id, text|status, by, forceGeneral)`', async () => {
  const { router, calls } = spyRouter()
  await drive(router, '/api/goal/context', { by: 'general', id: 'G1', text: 'T' })
  assert.deepEqual(calls.setCtx[0], ['G1', 'T', 'general', false], '★★★ context 的参数顺序')
  await drive(router, '/api/goal/status', { by: 'general', id: 'G2', status: 'paused' })
  assert.deepEqual(calls.setState[0], ['G2', 'paused', 'general', false], '★★★ status 的参数顺序')
  // ★ `context` 的参数是 (id, **text**)，`status` 是 (id, **status**) —— 搬串了就全乱
  assert.equal(calls.setCtx[0][1], 'T', '★★ context 第 2 个位置是 text')
  assert.equal(calls.setState[0][1], 'paused', '★★ status 第 2 个位置是 status')
})

test('⑤d ★★★ `forceGeneral` **严格 === true** 才算（绕过"仅将军"的那把钥匙）', async () => {
  const { router, calls } = spyRouter({
    // 桩要照实允许一个非 general 的 by 进来，才能测到第 4 个参数
    handleWrite: async (req, res, fn) => { res.sent = { code: 200, payload: await fn(req.body ?? {}, 'someone', 's') } },
  })
  await drive(router, '/api/goal/context', { id: 'G', text: 'T' })
  assert.equal(calls.setCtx[0][3], false, '★ 缺省 false')
  await drive(router, '/api/goal/context', { id: 'G', text: 'T', forceGeneral: true })
  assert.equal(calls.setCtx[1][3], true, '★ === true 才算')
  for (const v of [1, 'true', 'yes']) {
    await drive(router, '/api/goal/context', { id: 'G', text: 'T', forceGeneral: v })
    assert.equal(calls.setCtx.at(-1)[3], false, `★★ forceGeneral=${JSON.stringify(v)} 不算（严格 === true）`)
  }
  await drive(router, '/api/goal/status', { id: 'G', status: 'paused', forceGeneral: true })
  assert.equal(calls.setState.at(-1)[3], true, '★★ status 那一路也要能透传')
})

// ── 接缝契约 ────────────────────────────────────────────────────────────
test('⑥ ★★★ dispatch 契约：看方法、命中回 true、不命中回 false', async () => {
  const { router } = spyRouter()
  const ctx = (p) => ({ path: p, url: new URL('http://x' + p) })
  for (const p of ['/api/goal', '/api/goal/context', '/api/goal/status']) {
    assert.equal(await router.dispatch({ method: 'GET', body: { by: 'general' } }, {}, ctx(p)), false, `★★ ${p} 只认 POST`)
    assert.equal(await router.dispatch({ method: 'POST', body: { by: 'general' } }, {}, ctx(p)), true)
  }
  assert.equal(await router.dispatch({ method: 'POST', body: {} }, {}, ctx('/api/goal/nope')), false)
  assert.equal(await router.dispatch({ method: 'POST', body: {} }, {}, ctx('/api/goalX')), false, '★ exact 不许退化成 startsWith')
  assert.deepEqual(router.routes.map((r) => `${r.method} ${r.match} ${r.path}`), [
    'POST exact /api/goal', 'POST exact /api/goal/context', 'POST exact /api/goal/status',
  ])
  assert.equal(router.id, 'goal-lifecycle')
})

test('⑦ ★★★ 本族**不许**吃掉同前缀下那条孤在别处的兄弟 `POST /api/goal/slices`', async () => {
  // ★★★ 它是本族**第 4 条同前缀路由**，但在 L5311、与这三条跨了 400+ 行，
  //   中间全是别人的族 ⇒ 本片取不到它，它**必须原样留着**。
  const { router } = spyRouter()
  const ctx = (p) => ({ path: p, url: new URL('http://x' + p) })
  assert.equal(await router.dispatch({ method: 'POST', body: { by: 'general' } }, {}, ctx('/api/goal/slices')), false,
    '★★★ goal/slices 不属本片 —— 吃了它就会让"切片拆分"静默走错域函数')
})

test('⑧ ★★ 缺注入项 ⇒ **构造时**就抛（fail closed）', async () => {
  const full = {
    json: () => {}, handleWrite: async () => {}, publishGoalRecord: () => {},
    setGoalContext: () => {}, setGoalState: () => {},
  }
  for (const k of Object.keys(full)) {
    const partial = { ...full }
    delete partial[k]
    assert.throws(() => createGoalLifecycleRoutes(partial), /缺注入项/, `★★ 少了 ${k} 必须在构造时就抛`)
  }
})
