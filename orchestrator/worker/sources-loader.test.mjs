// orchestrator/worker/sources-loader.test.mjs
// ============================================================================
// PRT-402~406 的生产数据面（`loadSources`）
//
// ## 为什么这一套起**真的 hub**
//
// 本模块的全部工作就是"在 hub 的读面上取数"：端点路径、查询参数名、
// 响应形状（`/api/goal` 回的是 `{goals:[…]}` 还是裸数组、任务详情里
// 评论到底叫什么字段）。这些全部**只能**由真的 hub 回答——
// 用一个假 hub 返回几组编好的 JSON，测的只是本模块的算术，
// 而真正会错的那一半（端点名写错、参数名写错、字段名写错）一行都没执行。
//
//   > 一个用假 hub 喂出来的"装配器已验证"，
//   > 与一个从没发过那次请求的"装配器已验证"，是同一个东西——
//   > 只不过前者的用例数是完整的。
//
// ## 本套件的主线：**读失败不是"没有"**
//
// hub 上没有的东西（teamPlan / employeeManifest / 用户反馈 / 上游交付 /
// 工作区状态）与"有但这次读失败了"，在快照里都表现为"这条来源不在"。
// 前者是世界的形状，后者是故障。把它们归成同一种处理，
// 就等于让每一次网络抖动静默地变成一次"上下文更少的运行"。
// ============================================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createHubSourceLoader, commentIdOf, epochMsOf,
  SOURCES_LOADER_CODES, UNSERVED_SOURCE_FAMILIES,
} from './sources-loader.mjs'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-srcload-'))
let mod
let base = ''

before(async () => {
  process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_TOKEN = ''
  mod = await import('../../team-hub/server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close() } catch { /* 已关闭 */ }
  try { mod?.db?.close() } catch { /* 已关闭 */ }
  rmSync(tmpRoot, { recursive: true, force: true })
})

/** 极简 hub 客户端：与 `createHubClient` 的 `read` 同形（含 `status`）。 */
function makeHub() {
  return {
    async read(path) {
      const res = await fetch(base + path)
      let payload = null
      try { payload = await res.json() } catch { payload = null }
      if (!res.ok) {
        const e = new Error(`${path} 返回 ${res.status}`)
        e.status = res.status
        e.code = payload?.code ?? null
        throw e
      }
      return payload
    },
  }
}

async function post(path, body) {
  const res = await fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const text = await res.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, body: parsed }
}

/**
 * 造一个任务（走真实写路径），返回**服务端真正用的** id。
 *
 * ★ `/api/create` **不采用**调用方给的 `id`，它自己发号（`T-001`…）。
 * 夹具必须用返回的那个，否则后面 `/api/task?id=<我编的>` 全是 404——
 * 而这会表现成"装配器读不到任务"，看起来像本模块的缺陷。
 * （写这组用例时正是这么踩了一次。）
 */
async function seedTask({ title = '做一个东西', scope = 'default', description = '描述', role = null, goalId = null, blockedBy = null } = {}) {
  const r = await post('/api/create', {
    title, description, scope, acceptance: [], boundary: { do: [], dont: [] }, by: 'general',
    // PRT-402：`role` 与 `goalId` 是装载器**取团队计划与岗位清单的键**，
    // 所以它们必须在种子这一步就能给出来——否则那两条路径只能靠手插库来测，
    // 而手插库会让"路由的参数名写错了"整条不被执行。
    ...(role === null ? {} : { role }),
    ...(goalId === null ? {} : { goalId }),
    // PRT-405：`blockedBy` 是装载器**取上游交付的键**（同一个理由）。
    ...(blockedBy === null ? {} : { blockedBy }),
  })
  assert.ok(r.status === 200 || r.status === 201, `造任务失败：${r.status} ${JSON.stringify(r.body).slice(0, 200)}`)
  const id = r.body?.task?.id
  assert.ok(typeof id === 'string' && id !== '', `create 没有返回任务 id：${JSON.stringify(r.body).slice(0, 200)}`)
  return id
}

const SCOPE = 'default'

/**
 * 把一个任务推到 `done`，**走真实的状态机**（不是直接改库）。
 *
 * ★ 为什么不是一次 `POST /api/transition {to:'done'}`：hub 的迁移是有向图，
 *   而且 `to='done'` 有两条额外的守卫——必须先到 `in_review`，且
 *   **只有 `by='general'`** 能在用户接受后完成。第一版我直接跳 `done`，
 *   断言红在 `upstreamSkipped[0].status`（实际 `backlog`）上，
 *   而红的原因是**用例自己没走状态机**，不是产品少了一层。
 *
 *   > 一个"手改库把任务标成 done"的种子，
 *   > 与一个"走真实状态机"的种子，在跑起来之后是同一个东西——
 *   > 只不过前者会让"这条链真的能走到 done 吗"这件事永远不被执行，
 *   > 而 PRT-405 读的正是 `done` 这个状态。
 */
async function driveToDone(id, scope, by = 'coder') {
  const steps = ['todo', 'in_progress', 'in_review']
  for (const to of steps) {
    const r = await post('/api/transition', { id, by, to, scope, force: true })
    assert.equal(r.status, 200, `迁移到 ${to} 失败：${r.status} ${JSON.stringify(r.body).slice(0, 200)}`)
  }
  const done = await post('/api/transition', { id, by: 'general', to: 'done', scope, force: true })
  assert.equal(done.status, 200, `迁移到 done 失败：${done.status} ${JSON.stringify(done.body).slice(0, 200)}`)
}

// ── ① 从真 hub 取到真来源 ────────────────────────────────────────────────

test('★ 从真 hub 取到真任务：标题与描述真的在 sources 里（端点/参数/字段名都对）', async () => {
  const id = await seedTask({ title: '写一份报告', description: '把 A 和 B 对比' })
  const loader = createHubSourceLoader({ hub: makeHub(), scope: SCOPE })
  const src = await loader.loadSources({ taskId: id, scope: SCOPE })
  assert.equal(src.task?.id, id)
  assert.equal(src.task?.title, '写一份报告')
  assert.equal(src.task?.description, '把 A 和 B 对比')
  assert.equal(src.scope, SCOPE)
})

test('★ 真评论被取到并且**带上稳定的内容派生 id**（hub 的评论没有 id）', async () => {
  const id = await seedTask({ title: '带评论的任务' })
  const r = await post('/api/comment', { id, text: '这条必须先做完', by: 'general' })
  assert.equal(r.status, 200, `发评论失败：${JSON.stringify(r.body).slice(0, 200)}`)

  const loader = createHubSourceLoader({ hub: makeHub(), scope: SCOPE })
  const src = await loader.loadSources({ taskId: id, scope: SCOPE })
  assert.equal(src.comments.length, 1, '任务详情里的评论必须被取出来')
  const c = src.comments[0]
  assert.equal(c.body, '这条必须先做完')
  assert.equal(c.author, 'general')
  assert.ok(typeof c.id === 'string' && c.id.length > 0, 'commentSources 要求非空 id')
  // epoch 时间：hub 给的是 ISO 字符串，而 sources.mjs 要数字
  assert.ok(typeof c.createdAtMs === 'number' && Number.isFinite(c.createdAtMs),
    'ISO 时间必须转成 epoch 数字，否则 acquiredAt 拿不到')
})

test('★ 评论 id 是**内容派生**的：同一条评论两次得到同一个 id（与查询顺序无关）', () => {
  const a = commentIdOf({ by: 'general', at: '2026-01-01T00:00:00.000Z', text: '同样的话' })
  const b = commentIdOf({ by: 'general', at: '2026-01-01T00:00:00.000Z', text: '同样的话' })
  assert.equal(a, b, '内容相同 ⇒ id 相同')
  // ★ 用数组下标当 id 会把"查询顺序"变回数据的一部分，
  //   一条评论被重排就会让同一个世界算出两个快照哈希。
  const other = commentIdOf({ by: 'general', at: '2026-01-01T00:00:00.000Z', text: '别的话' })
  assert.notEqual(a, other, '内容不同 ⇒ id 不同')
  assert.notEqual(
    commentIdOf({ by: 'a', at: null, text: 'x' }),
    commentIdOf({ by: 'b', at: null, text: 'x' }),
    '作者也要进 id：两个不同的人说同一句话是两条评论',
  )
})

test('epochMsOf 把 ISO 与数字都收敛成数字，取不到时返回 undefined（不编一个 0）', () => {
  assert.equal(epochMsOf(1700000000000), 1700000000000)
  assert.equal(epochMsOf('1970-01-01T00:00:01.000Z'), 1000)
  assert.equal(epochMsOf(null), undefined, '取不到就是 undefined——0 会被读成 1970 年')
  assert.equal(epochMsOf('不是时间'), undefined)
})

test('★ 已发布技能被取到（真 hub 的 /api/skills 形状被走通）', async () => {
  const id = await seedTask({ title: '带技能的任务' })
  const loader = createHubSourceLoader({ hub: makeHub(), scope: SCOPE })
  const src = await loader.loadSources({ taskId: id, scope: SCOPE })
  assert.ok(Array.isArray(src.skills), 'skills 必须是数组（哪怕现在是空的）')
})

test('★ 目标按任务的 goalId 精确取；取不到时是 null 而不是"随便给一个"', async () => {
  const id = await seedTask({ title: '没有对应目标的任务' })
  const loader = createHubSourceLoader({ hub: makeHub(), scope: SCOPE })
  const src = await loader.loadSources({ taskId: id, scope: SCOPE })
  // 这个任务不属于任何目标 → 目标来源缺席（而不是把别的目标安在它头上）
  assert.equal(src.goal, null, '挑不到就如实缺席——猜错等于让模型照着别的目标干活')
})

// ── ② ★ 读失败不是"没有" ────────────────────────────────────────────────

test('★★ 读失败必须抛错，**不能**当成"这条来源没有"', async () => {
  const id = await seedTask({ title: '任务' })
  // 任务读得到，但目标与技能读 500
  let n = 0
  const hub = {
    async read(path) {
      n += 1
      if (path.startsWith('/api/task')) return makeHub().read(path)
      const e = new Error('boom'); e.status = 500; throw e
    },
  }
  const loader = createHubSourceLoader({ hub, scope: SCOPE })
  await assert.rejects(
    () => loader.loadSources({ taskId: id, scope: SCOPE }),
    (e) => {
      assert.equal(e.code, SOURCES_LOADER_CODES.READ_FAILED)
      // 错误信息必须说清"这不是没有"
      assert.match(e.message, /不是"没有这条来源"/)
      return true
    },
    '500 被当成"没有目标来源"，会让这次运行静默地少掉一部分世界观',
  )
  assert.ok(n >= 2)
})

test('★★ 404（真的没有）与 500（读失败）被分开：404 不抛，500 抛', async () => {
  const id = await seedTask({ title: '任务' })
  // 目标端点回 404 → 应当被当成"没有"，装配继续
  const hub404 = {
    async read(path) {
      if (path.startsWith('/api/goal')) { const e = new Error('没有'); e.status = 404; throw e }
      return makeHub().read(path)
    },
  }
  const ok = await createHubSourceLoader({ hub: hub404, scope: SCOPE }).loadSources({ taskId: id, scope: SCOPE })
  assert.equal(ok.goal, null, '404 = 问过了，它说没有')
  assert.ok(ok.task, '别的来源不受影响')

  // 同一个端点回 500 → 必须抛
  const hub500 = {
    async read(path) {
      if (path.startsWith('/api/goal')) { const e = new Error('炸了'); e.status = 500; throw e }
      return makeHub().read(path)
    },
  }
  await assert.rejects(() => createHubSourceLoader({ hub: hub500, scope: SCOPE }).loadSources({ taskId: id, scope: SCOPE }))
})

test('★ 任务不存在（404）→ 明确的 TASK_NOT_FOUND，而不是 READ_FAILED', async () => {
  const loader = createHubSourceLoader({ hub: makeHub(), scope: SCOPE })
  await assert.rejects(
    () => loader.loadSources({ taskId: '根本不存在的任务', scope: SCOPE }),
    (e) => {
      // 与"读不到"分开：这个 Attempt 是为一个不存在的任务领的，修复动作完全不同
      assert.equal(e.code, SOURCES_LOADER_CODES.TASK_NOT_FOUND)
      return true
    },
  )
})

// ── ③ 拒绝静默地少给 ────────────────────────────────────────────────────

test('★ 缺 taskId → 拒绝（默认），而不是给一份没有任务定义的上下文', async () => {
  const loader = createHubSourceLoader({ hub: makeHub(), scope: SCOPE })
  await assert.rejects(
    () => loader.loadSources({ scope: SCOPE }),
    (e) => {
      assert.equal(e.code, SOURCES_LOADER_CODES.NO_TASK_ID)
      return true
    },
    '没有任务定义的上下文会让模型照样跑完并给出结论',
  )
})

test('requireTask: false 时允许无任务（演练/空跑），但来源里仍然如实为空', async () => {
  const loader = createHubSourceLoader({ hub: makeHub(), scope: SCOPE, requireTask: false })
  const src = await loader.loadSources({ scope: SCOPE })
  assert.equal(src.task, null)
  assert.deepEqual(src.comments, [])
})

test('★ 缺 scope → 拒绝（放错空间就是一次越权）', async () => {
  const loader = createHubSourceLoader({ hub: makeHub() })
  await assert.rejects(
    () => loader.loadSources({ taskId: 'x' }),
    (e) => {
      assert.equal(e.code, SOURCES_LOADER_CODES.NO_SCOPE)
      return true
    },
  )
})

test('lease 上的 scope 优先于构造时的兜底 scope', async () => {
  const id = await seedTask({ title: '任务', scope: 'other-space' })
  const loader = createHubSourceLoader({ hub: makeHub(), scope: 'default' })
  const src = await loader.loadSources({ taskId: id, scope: 'other-space' })
  assert.equal(src.scope, 'other-space', '以 lease 为准')
})

// ── ④ 拿不到的来源必须被点名 ─────────────────────────────────────────────

test('★★ 取不到的来源族被**点名**列出，且每条都说清缺的是什么', () => {
  const loader = createHubSourceLoader({ hub: makeHub(), scope: SCOPE })
  const av = loader.availability()
  const keys = av.unserved.map((u) => u.key)
  for (const k of ['workspaceState']) {
    assert.ok(keys.includes(k), `${k} 必须被点名——"静静地不出现"与"取不到"在账本上长得一样`)
  }
  for (const u of av.unserved) {
    assert.ok(u.reason.length > 20, `${u.key} 的原因必须具体，不能只写"没有"`)
  }
  // ★ PRT-402 / 404 / 405 之后这几条**不再缺**，所以它们必须从 `unserved` 里消失。
  //   留着它们的后果不是"多说了一句"：`unserved` 是**产品缺口的清单**，
  //   而一个已经补上的缺口挂在上面，会让这份清单失去"照着它能干完活"的性质。
  for (const k of ['teamPlan', 'employeeManifest', 'userFeedback', 'upstreamDeliveries']) {
    assert.ok(!keys.includes(k), `${k} 已经接上了，不该还留在 unserved 里`)
  }
})

test('★★ 补上的缺口进 `formerlyUnserved`，且写明**当时缺的是什么**', () => {
  const loader = createHubSourceLoader({ hub: makeHub(), scope: SCOPE })
  const av = loader.availability()
  const keys = av.formerlyUnserved.map((u) => u.key)
  assert.deepEqual([...keys].sort(), ['employeeManifest', 'teamPlan', 'upstreamDeliveries', 'userFeedback'])
  for (const u of av.formerlyUnserved) {
    assert.ok(['PRT-402', 'PRT-404', 'PRT-405'].includes(u.fixedBy), `${u.key} 要写明是哪一批补上的`)
    assert.ok(u.servedBy.startsWith('/api/'), `${u.key} 要写清现在由哪条端点供上`)
    // "当时缺的是什么"必须留着：删掉它，下一次有人看到一份带 missing 候选的
    // 快照时，就没有任何地方告诉他这几条**曾经每次运行都缺**。
    assert.ok(u.was.length > 20, `${u.key} 要写明它当时为什么缺`)
  }
  // 与 unserved 是**互补**的两份，不是同一份的两种叫法
  const unservedKeys = av.unserved.map((u) => u.key)
  for (const k of keys) assert.ok(!unservedKeys.includes(k), `${k} 不能两边都在`)
})

test('★★ 列表形来源的缺席**不留痕迹**——这条边界被写出来，而不是留给运维猜', () => {
  // `teamPlan` / `employeeManifest` 是单值来源：缺席传 `null`，装配器产出
  // 一条带原因的 `missing` 候选，"没有"与"没去读"分得开。
  // 而 `comments` / `userFeedback` 是**列表形**：缺席只能传 `[]`，产出**零个**
  // 候选——两种完全不同的处境在快照里是同一个形状。
  const loader = createHubSourceLoader({ hub: makeHub(), scope: SCOPE })
  const av = loader.availability()
  const keys = av.listShapedAbsence.map((u) => u.key)
  for (const k of ['userFeedback', 'comments']) {
    assert.ok(keys.includes(k), `${k} 的形状边界必须被登记，否则它会看起来不存在`)
  }
  for (const u of av.listShapedAbsence) {
    assert.deepEqual(u.absentAs, [], '列表形缺席只能表示为空数组')
    assert.ok(u.why.length > 20 && u.needs.length > 5, `${u.key} 要说清为什么、以及需要什么才能表达`)
  }
  // 单值来源**不在**这份清单里（它们有 `missing` 候选这个位置）
  assert.ok(!keys.includes('teamPlan'), '单值来源缺席有 missing 候选，不属于这条边界')
})

test('★★ 团队计划与岗位清单**真的从 hub 读得到**（PRT-402 的接线）', async () => {
  // 这份种子数据走的是**真实路由**（POST /api/team-plans、POST /api/employee-manifests），
  // 不是往库里手插行。手插行会让"路由的参数名写错了"这件事整条不被执行——
  // 而参数名写错正是本批最容易犯的错。
  const scope = 'src-load-plan'
  // ★ `goalId` 是取团队计划的**键**——不给它，装载器按设计**不发那次请求**。
  //   第一版这份用例忘了给，于是"计划必须读回来"红在 `null` 上，
  //   而红的原因是**用例自己少给了一个参数**。这正是 §「没有 goalId 就不猜」
  //   那条用例存在的价值：它把这个前提变成了一条会红的断言。
  const goalId = 'g-src-load'
  const planSeeded = await post('/api/team-plans', {
    scope, actor: 'tester',
    plan: {
      id: 'tp-src-load', version: 1, goalId,
      title: '装载器用例的团队计划', objective: '证明它读得到',
      stages: ['dev', 'review'],
    },
  })
  assert.equal(planSeeded.status, 200, `种子计划写入失败：${JSON.stringify(planSeeded.body)}`)
  const seeded = await post('/api/employee-manifests', {
    scope, actor: 'tester',
    manifest: {
      role: 'dev', employeeId: 'e-src-load', displayName: '装载器用例岗位',
      responsibilities: ['写代码'], allowedTools: ['read', 'edit'], deniedTools: ['deploy'],
      approvalPolicy: 'ask-on-write', limits: { maxTokens: 1000 },
    },
  })
  assert.equal(seeded.status, 200, `种子清单写入失败：${JSON.stringify(seeded.body)}`)

  const id = await seedTask({ title: '任务', scope, role: 'dev', goalId })
  const loader = createHubSourceLoader({ hub: makeHub(), scope })
  const src = await loader.loadSources({ taskId: id, scope, role: 'dev' })

  assert.equal(src.teamPlan?.id, 'tp-src-load', '团队计划必须真的读回来')
  assert.equal(src.teamPlan?.version, 1)
  assert.equal(src.teamPlan?.stages.length, 2)
  assert.equal(src.employeeManifest?.employeeId, 'e-src-load', '岗位清单必须真的读回来')
  assert.deepEqual(src.employeeManifest?.deniedTools, ['deploy'])

  // ★ 端点回的是 `{ok, plan}` / `{ok, manifest}`，而 `sources.mjs` 要的是**里面那个**。
  //   忘了拆包的表现极其隐蔽：`teamPlanSource({ok:true,plan:{…}})` 里 `plan.id`
  //   是 `undefined` → 抛 `TeamPlan 必须有 id` → 整条装配 400。
  //   或者更坏：`employeeManifestSource` 取 `manifest.employeeId ?? manifest.id`
  //   两个都是 undefined，同样抛错——**但它抛的是"必须有 employeeId"**，
  //   而响应里明明有一个 employeeId。这正是本断言要钉住的形状。
  assert.ok(!('ok' in src.teamPlan), '包装层必须被拆掉，不能把 {ok, plan} 整个递下去')
  assert.ok(!('ok' in src.employeeManifest))

  // 读过的端点要出现在 lastReads 里——"到底问了哪些端点"是排障时的一半答案
  const paths = loader.lastReads().map((r) => r.path)
  assert.ok(paths.some((p) => p.startsWith('/api/team-plan?')), `没读过团队计划端点：${paths.join(' | ')}`)
  assert.ok(paths.some((p) => p.startsWith('/api/employee-manifest?')), `没读过岗位清单端点：${paths.join(' | ')}`)
})

test('★★ 读不到时是 `null`（→ missing 候选），**不是** `{}` 也不是 400', async () => {
  // 没有种子的空间：两条端点都回 404，而 404 必须翻成 `null`。
  // `goalId` 要给（否则按设计不发请求，测的就成了"没问过"而不是"问过说没有"）。
  const scope = 'src-load-empty'
  const id = await seedTask({ title: '空空间任务', scope, role: 'nobody', goalId: 'g-src-load-empty' })
  const loader = createHubSourceLoader({ hub: makeHub(), scope })
  const src = await loader.loadSources({ taskId: id, scope, role: 'nobody' })

  assert.equal(src.teamPlan, null)
  assert.equal(src.employeeManifest, null)
  // ★ 键**必须存在**。少了键会让 collectCandidates 里 `input.teamPlan ?? null`
  //   同样得到 null，看似一样——但一个显式的 null 是一个"我们知道它该在这"
  //   的声明，缺键不是。
  assert.ok('teamPlan' in src, '键必须在：缺席与没说过的区别就在这里')
  assert.ok('employeeManifest' in src)
  // ★ 而 `{}` 会让 `sources.mjs` 走进"有来源"那条分支，产出一条**内容为空**的
  //   TeamPlan，于是它不再出现在 `excluded[]` 里——快照会声称模型看过团队计划。
  assert.notDeepEqual(src.teamPlan, {})
  assert.notDeepEqual(src.employeeManifest, {})

  // 404 是**问过之后**才知道的事，所以它不该让整次装配失败
  const reads = loader.lastReads().filter((r) => r.path.startsWith('/api/team-plan'))
  assert.equal(reads.length, 1)
  assert.equal(reads[0].ok, false)
  assert.equal(reads[0].status, 404)
})

test('★ 没有 goalId / role 时**不发那次请求**（不猜 = 不读别人的东西）', async () => {
  // ★ 两个都缺时若照样去问（比如把 goalId 省略成空串），会在 hub 上拿到 400；
  //   而把 400 也当"没有"处理，与**根本没问过**在账本上是同一行。
  //   这里钉的是更强的一件事：**不猜身份就不读**。
  const scope = 'src-load-noguess'
  const id = await seedTask({ title: '无目标无岗位的任务', scope })
  const loader = createHubSourceLoader({ hub: makeHub(), scope })
  const src = await loader.loadSources({ taskId: id, scope })

  // 任务没有 goalId、没有 role → 两条来源都取不到，且**没有发出请求**
  assert.equal(src.teamPlan, null)
  assert.equal(src.employeeManifest, null)
  const paths = loader.lastReads().map((r) => r.path)
  assert.ok(!paths.some((p) => p.startsWith('/api/team-plan')), `不该读团队计划：${paths.join(' | ')}`)
  assert.ok(!paths.some((p) => p.startsWith('/api/employee-manifest')), `不该读岗位清单：${paths.join(' | ')}`)
})

// ── ④c PRT-404：用户反馈（与评论**分开**的一条来源）────────────────────
test('★★★ 用户反馈**真的从 hub 读得到**，且以 `user-feedback` 而不是 `comment` 进快照', async () => {
  const scope = 'src-load-feedback'
  const id = await seedTask({ title: '要被反馈的任务', scope, role: 'coder' })
  // 同时写一条**普通评论**和一条**用户反馈**——两者的文本刻意不同，
  // 这样"谁进了哪一类"是可判定的。
  const c = await post('/api/comment', { id, by: 'coder', text: '同事的一句普通评论', scope })
  assert.equal(c.status, 200, JSON.stringify(c.body))
  const fb = await post('/api/comment', { id, by: 'general', text: '用户要求：把导出改成 CSV', kind: 'feedback', scope })
  assert.equal(fb.status, 200, JSON.stringify(fb.body))

  const loader = createHubSourceLoader({ hub: makeHub(), scope })
  const src = await loader.loadSources({ taskId: id, scope })
  // 装载器把反馈读回来了（形状对齐 commentSources）
  assert.equal(src.userFeedback.length, 1, JSON.stringify(src.userFeedback))
  assert.equal(src.userFeedback[0].author, 'general')
  assert.equal(src.userFeedback[0].body, '用户要求：把导出改成 CSV')
  assert.ok(Number.isFinite(src.userFeedback[0].createdAtMs), '时间要换成 epoch 毫秒')
  assert.ok(src.userFeedback[0].id.startsWith('c-'), '内容派生的稳定 id')

  // ★ 反馈**不在**评论列表里（结构上分开的两个列）
  assert.equal(src.comments.length, 1)
  assert.equal(src.comments[0].body, '同事的一句普通评论')

  // 装配一次：类型必须是 user-feedback，且**只出现一次**
  const { collectCandidates } = await import('../../runtime/context/sources.mjs')
  const cands = collectCandidates({ ...src, scope })
  const fbCands = cands.filter((x) => x.source.type === 'user-feedback')
  const cCands = cands.filter((x) => x.source.type === 'comment')
  assert.equal(fbCands.length, 1, `反馈候选应恰好 1 条：${JSON.stringify(cands.map((x) => [x.source.type, x.source.id]))}`)
  assert.equal(cCands.length, 1, '普通评论候选应恰好 1 条')
  // 两条候选的 id 不能相同（否则同一份内容在快照里有两个身份）
  const ids = cands.map((x) => x.source.id)
  assert.equal(new Set(ids).size, ids.length, `来源 id 必须唯一：${ids.join(' | ')}`)
  assert.ok(!JSON.stringify(fbCands[0].source.content).includes('同事的一句普通评论'),
    '反馈的内容里不该混进评论')
})

test('★★★ 用户反馈**读的是专门那个端点**，不是从任务行里自己挑出来', async () => {
  // 这条钉的是"不混淆"的**机制**：hub 的任务行上同时有三个批注列
  // （comments / evidence / feedback），若装载器从 `/api/task` 里自己挑，
  // 那么"哪一列是用户反馈"就会被复制到每个读点，忘了挑的那一处会把
  // "同事说了一句话"读成"用户要求调整"。
  const scope = 'src-load-fbroute'
  const id = await seedTask({ title: '端点归属', scope, role: 'coder' })
  await post('/api/comment', { id, by: 'general', text: '一条反馈', kind: 'feedback', scope })
  const loader = createHubSourceLoader({ hub: makeHub(), scope })
  await loader.loadSources({ taskId: id, scope })
  const paths = loader.lastReads().map((r) => r.path.split('?')[0])
  assert.ok(paths.includes('/api/task-feedback'), `必须读专门端点：${paths.join(' | ')}`)
})

test('★ 反馈端点：任务不存在 → 404（不是 `{feedback: []}`）', async () => {
  const res = await fetch(`${base}/api/task-feedback?scope=default&taskId=T-不存在`)
  assert.equal(res.status, 404)
  const body = await res.json()
  assert.equal(body.code, 'TASK_NOT_FOUND')
})

test('★ 反馈端点：缺 taskId → 400；跨空间问别人空间的 id → 404', async () => {
  const noId = await fetch(`${base}/api/task-feedback?scope=default`)
  assert.equal(noId.status, 400)
  assert.equal((await noId.json()).code, 'MISSING_PARAM')

  const scope = 'src-load-fbscope'
  const id = await seedTask({ title: '空间校验', scope })
  await post('/api/comment', { id, by: 'general', text: '反馈', kind: 'feedback', scope })
  // ★ 任务 id 是全库唯一的，但拿别空间的 id 来问**仍然是一次越权读取**
  //   （装配是按空间做的）——所以拒绝，而不是照答。
  const cross = await fetch(`${base}/api/task-feedback?scope=别的空间&taskId=${id}`)
  assert.equal(cross.status, 404)
  // 同一空间则答得出来
  const own = await fetch(`${base}/api/task-feedback?scope=${scope}&taskId=${id}`)
  assert.equal(own.status, 200)
  assert.equal((await own.json()).count, 1)
})

test('★★ 没有 taskId 且 `requireTask: false` 时**不读**反馈端点（不猜）', async () => {
  const loader = createHubSourceLoader({ hub: makeHub(), scope: SCOPE, requireTask: false })
  const src = await loader.loadSources({ scope: SCOPE })
  assert.deepEqual(src.userFeedback, [])
  const paths = loader.lastReads().map((r) => r.path.split('?')[0])
  assert.ok(!paths.includes('/api/task-feedback'), `没有 taskId 就不该读：${paths.join(' | ')}`)
})


// ── ④d PRT-405：上游员工交付（`blockedBy` 前驱）──────────────────────────
test('★★★ 上游交付**真的读得到**：按 `blockedBy` 读前驱，且只认 `done` 的', async () => {
  const scope = 'src-load-upstream'
  // 上游（coder）先建、做成 done、登记一条产物；下游（tester）blockedBy 指向上游。
  const up = await seedTask({ title: '实现导出', scope, role: 'coder' })
  assert.equal((await post('/api/artifact', { id: up, by: 'coder', kind: 'file', path: 'src/export.mjs', title: '导出实现', scope })).status, 200)
  // ★ 上游**没完成**时：下游拿不到交付（这是后半段要验的）
  const down = await seedTask({ title: '测试导出', scope, role: 'tester', blockedBy: [up] })

  const mk = () => createHubSourceLoader({ hub: makeHub(), scope })
  let src = await mk().loadSources({ taskId: down, scope })
  assert.deepEqual(src.upstreamDeliveries, [], '上游还没 done，不能产出交付')
  assert.equal(src.upstreamSkipped.length, 1, '但**必须记下来**，不能静默')
  assert.equal(src.upstreamSkipped[0].taskId, up)
  assert.notEqual(src.upstreamSkipped[0].status, 'done', '还没 done')
  assert.ok(src.upstreamSkipped[0].reason.includes('done'), src.upstreamSkipped[0].reason)

  // 把上游推到 done（**走真实状态机**，见 driveToDone）
  await driveToDone(up, scope)

  const loader = mk()
  src = await loader.loadSources({ taskId: down, scope })
  assert.equal(src.upstreamDeliveries.length, 1, JSON.stringify(src.upstreamDeliveries))
  const d = src.upstreamDeliveries[0]
  assert.equal(d.id, up, '交付 id 就是上游任务 id')
  assert.equal(d.fromRole, 'coder')
  assert.equal(d.taskId, up)
  assert.equal(d.artifacts.length, 1, '上游登记的产物要带在交付里')
  assert.equal(d.artifacts[0].path, 'src/export.mjs')
  // ★ 四个键**一律出现**（缺的写 null）：省略会让"从没填过"与"填了空"
  //   得到同一个内容哈希。
  assert.deepEqual(Object.keys(d.artifacts[0]), ['kind', 'path', 'title', 'digest'])
  assert.equal(d.artifacts[0].digest, null, '没给 digest 就是 null，不是被省略')
  assert.ok(typeof d.summary === 'string' && d.summary.includes('coder'), d.summary)
  assert.deepEqual(src.upstreamSkipped, [], '读到了就没有跳过的')

  // 装配一次：类型是 upstream-delivery，且**不可信**
  const { collectCandidates } = await import('../../runtime/context/sources.mjs')
  const cands = collectCandidates({ ...src, scope })
  const upCands = cands.filter((x) => x.source.type === 'upstream-delivery')
  assert.equal(upCands.length, 1, `上游交付候选应恰好 1 条：${JSON.stringify(cands.map((x) => x.source.type))}`)
  assert.equal(upCands[0].source.trust, 'untrusted',
    '上游是内部员工**不构成可信理由**：它的输出可能含它读到的外部内容（污染的传递性）')
  assert.ok(upCands[0].source.content.includes('src/export.mjs'), '产物引用要进内容')
})

test('★★ 上游交付读的是 `blockedBy` 前驱，**不是**别的任务（`/api/task` 覆盖不算数）', async () => {
  // 这条钉的是"读的是**哪些**任务"：`consumed` 里只有 `/api/task`，
  // 而 PRT-405 的全部内容恰恰是"读的是前驱"。
  const scope = 'src-load-upstream2'
  const a = await seedTask({ title: '无关任务 A', scope, role: 'coder' })
  await driveToDone(a, scope)
  const leaf = await seedTask({ title: '没有上游的任务', scope, role: 'coder' })

  const loader = createHubSourceLoader({ hub: makeHub(), scope })
  const src = await loader.loadSources({ taskId: leaf, scope })
  // ★ 链头**没有**上游：不该因为"A 是 done"就把它当成交付。
  assert.deepEqual(src.upstreamDeliveries, [], '没有 blockedBy 就没有上游交付')
  const readIds = loader.lastReads().map((r) => r.path).filter((p) => p.startsWith('/api/task?'))
  assert.deepEqual(readIds, [`/api/task?id=${leaf}`],
    `只该读自己那一个任务：${readIds.join(' | ')}`)

  // availability 要把"读的是前驱"这件事写出来
  const av = loader.availability()
  assert.equal(av.upstreamSelection.by, 'task.blockedBy')
  assert.equal(av.upstreamSelection.maxUpstream, 20)
  assert.equal(av.upstreamSelection.onlyDone, true)
})

test('★★ 上游前驱**不存在**时不静默（数据不一致要说出来，而不是当成链头）', async () => {
  const scope = 'src-load-upstream3'
  // blockedBy 指向一个不存在的任务：链被删过 / 数据不一致。
  // 若当成"没有上游"，模型会以为自己是链头——而它是链断了。
  const t = await seedTask({ title: '依赖幽灵', scope, role: 'tester', blockedBy: ['T-根本不存在'] })
  const loader = createHubSourceLoader({ hub: makeHub(), scope })
  const src = await loader.loadSources({ taskId: t, scope })
  assert.deepEqual(src.upstreamDeliveries, [])
  assert.equal(src.upstreamSkipped.length, 1)
  assert.equal(src.upstreamSkipped[0].taskId, 'T-根本不存在')
  assert.ok(src.upstreamSkipped[0].reason.includes('不存在'), src.upstreamSkipped[0].reason)
})

test('★★ `maxUpstream` 截断时**说出来**（没读 ≠ 不存在）', async () => {
  const scope = 'src-load-upstream4'
  const deps = []
  for (let i = 0; i < 3; i += 1) {
    const d = await seedTask({ title: `前驱 ${i}`, scope, role: 'coder' })
    await driveToDone(d, scope)
    deps.push(d)
  }
  const last = await seedTask({ title: '三个上游', scope, role: 'tester', blockedBy: deps })
  const loader = createHubSourceLoader({ hub: makeHub(), scope, maxUpstream: 2 })
  const src = await loader.loadSources({ taskId: last, scope })
  assert.equal(src.upstreamDeliveries.length, 2, '只读前 2 个')
  const trunc = src.upstreamSkipped.find((s) => s.truncated !== undefined)
  assert.ok(trunc, `截断必须被说出来：${JSON.stringify(src.upstreamSkipped)}`)
  assert.equal(trunc.truncated, 1)
  assert.ok(trunc.reason.includes('maxUpstream=2'), trunc.reason)
})

test('★ `maxUpstream` 必须是非负整数（接线错误在构造期说清）', () => {
  for (const bad of [-1, 1.5, 'x', null]) {
    assert.throws(() => createHubSourceLoader({ hub: makeHub(), scope: SCOPE, maxUpstream: bad }),
      /maxUpstream/, `maxUpstream=${JSON.stringify(bad)} 应当构造期就拒绝`)
  }
})


// ── ④b PRT-402 的**路由参数校验**（探针⑭量出来的缺口）───────────────────
//
// 这一段是断验证逼出来的，不是我事先想到的：探针⑭把
// 「清单端点必须要求 role/employeeId」改坏成 `if (false)`，**一条用例都没红**。
// 也就是说那几行校验**没有任何用例覆盖**——它们看起来像防线，
// 而没有任何东西证明它们真的拦得住。
//
//   > 一段"写了但没被任何用例打过"的参数校验，
//   > 与一段"根本没写"的参数校验，在有人真的漏传参数的时候是同一个东西——
//   > 只不过前者在代码审查里看起来是完成的。
test('★★ 清单端点缺 role 与 employeeId → 400，**不猜**给一份别人的边界', async () => {
  const scope = 'src-load-norole'
  const res = await fetch(`${base}/api/employee-manifest?scope=${scope}`)
  const body = await res.json()
  assert.equal(res.status, 400)
  assert.equal(body.code, 'MISSING_PARAM')
  assert.match(body.error, /role|employeeId/)
})

test('★ 团队计划端点缺 scope → 400（计划是挂在空间上的）', async () => {
  const res = await fetch(`${base}/api/team-plan?goalId=g1`)
  const body = await res.json()
  assert.equal(res.status, 400)
  assert.equal(body.code, 'MISSING_PARAM')
})

test('★★ `?version=` 不是正整数 → 400 BAD_VERSION（不是静默退回最新版）', async () => {
  // ★ 这是这一组里最要紧的一条：若非法 version 被**静默忽略**，
  //   调用方要"第 3 版"却拿到最新版，而响应里带着一个合法的 plan——
  //   它会以为历史那一版就是这样的。
  for (const bad of ['0', '-1', 'abc', '1.5']) {
    const res = await fetch(`${base}/api/team-plan?scope=default&id=x&version=${encodeURIComponent(bad)}`)
    const body = await res.json()
    assert.equal(res.status, 400, `version=${bad} 应被拒`)
    assert.equal(body.code, 'BAD_VERSION')
  }
})

test('★ 列表路由：`/api/team-plans` 与 `/api/employee-manifests` 都答得出，且按空间过滤', async () => {
  const scope = 'src-load-list'
  const seeded = await post('/api/team-plans', {
    scope, actor: 'tester',
    plan: { id: 'tp-list', version: 1, goalId: 'g-list', stages: ['dev'] },
  })
  assert.equal(seeded.status, 200, JSON.stringify(seeded.body))
  await post('/api/employee-manifests', {
    scope, actor: 'tester', manifest: { role: 'dev', employeeId: 'e-list' },
  })

  const plans = await (await fetch(`${base}/api/team-plans?scope=${scope}`)).json()
  assert.equal(plans.ok, true)
  assert.deepEqual(plans.plans.map((p) => p.id), ['tp-list'])
  assert.equal(plans.count, 1)

  const mans = await (await fetch(`${base}/api/employee-manifests?scope=${scope}`)).json()
  assert.equal(mans.ok, true)
  assert.deepEqual(mans.manifests.map((m) => m.employeeId), ['e-list'])

  // 别的空间看不到它们（列表也必须带隔离）
  const other = await (await fetch(`${base}/api/team-plans?scope=src-load-list-other`)).json()
  assert.deepEqual(other.plans, [])
})

test('★ 冻结冲突经 HTTP 是 **409**，且带上 id/version（调用方要据此发新版本）', async () => {
  const scope = 'src-load-frozen'
  const payload = { scope, actor: 'tester', plan: { id: 'tp-frozen', version: 1, stages: ['dev'] } }
  assert.equal((await post('/api/team-plans', payload)).status, 200)
  const again = await post('/api/team-plans', payload)
  assert.equal(again.status, 200, '同版同内容是幂等，不是冲突')
  const conflict = await post('/api/team-plans', {
    scope, actor: 'tester', plan: { id: 'tp-frozen', version: 1, stages: ['dev', 'review'] },
  })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.code, 'TEAM_PLAN_FROZEN')
  // ★ 从 HTTP 一路带出来，不是只留在 store 的异常对象上
  assert.equal(conflict.body.id, 'tp-frozen')
  assert.equal(conflict.body.version, 1)
})


test('★★★ 发布目标 → 团队计划被**冻住** → 装载器读得到（PRT-402 的触发点）', async () => {
  // 这是整批的**端到端链条**：spec 说 TeamPlan 是「目标创建时**冻结**的
  // 团队、岗位、流水线和能力包组合快照」。读端点、表、装载器都齐了之后，
  // 唯一还缺的就是那个**时点**——没有任何地方在目标创建时写一份计划。
  //
  //   > 一个"读写两端都齐、只是没人写"的数据面，
  //   > 与一个"根本没有这张表"的数据面，在**第一次运行**的时候是同一个东西——
  //   > 只不过前者的用例是绿的。
  const scope = 'src-load-goalfreeze'
  // 先配编队：链上的阶段由「编队 ∩ 流水线启用岗位」决定，流水线为空时入链 = 编队。
  for (const role of ['coder', 'tester']) {
    const r = await post('/api/agents', { scope, by: 'general', role, name: `${role}-甲` })
    assert.equal(r.status, 200, `配编队失败：${JSON.stringify(r.body)}`)
  }

  const published = await post('/api/goal', { scope, by: 'general', objective: '把某件事做成' })
  assert.equal(published.status, 200, `发布目标失败：${JSON.stringify(published.body)}`)
  // ★ `handleWrite` 把结果包在 `task` 下（`{ok, task:{goal, …}}`），
  //   不是 `{ok, goal}`。第一版我写的 `body.goal.id` 拿到 undefined，
  //   而断言说的是"没有返回 goal id"——**看起来像服务端没返回 id**。
  //   *一个"找错了一层"的断言，与一个"服务端真的没给"的断言，在失败信息上是同一个东西。*
  const result = published.body?.task
  const goalId = result?.goal?.id
  assert.ok(typeof goalId === 'string' && goalId !== '', `发布目标没有返回 goal id：${JSON.stringify(published.body)}`)
  // 发布响应里要能一眼看到"计划被冻住了、冻的是第几版"
  assert.equal(result.teamPlan?.id, goalId)
  assert.equal(result.teamPlan?.version, 1)
  assert.equal(result.teamPlan?.stages, 2, `阶段数应为 2，响应：${JSON.stringify(result.teamPlan)}`)

  // ★ 冻的是**那一刻的**流水线，而且阶段顺序就是链的顺序
  const plan = await (await fetch(`${base}/api/team-plan?scope=${scope}&goalId=${encodeURIComponent(goalId)}`)).json()
  assert.equal(plan.ok, true)
  assert.equal(plan.plan.id, goalId)
  assert.equal(plan.plan.version, 1)
  assert.deepEqual(plan.plan.stages.map((s) => s.role), ['coder', 'tester'])
  assert.equal(plan.plan.goalId, goalId)

  // ★ 装载器现在读得到它——用它自己的那三个键（scope + goalId）
  const taskId = await seedTask({ title: '目标下的任务', scope, role: 'coder', goalId })
  const loader = createHubSourceLoader({ hub: makeHub(), scope })
  const src = await loader.loadSources({ taskId, scope, role: 'coder' })
  assert.equal(src.teamPlan?.id, goalId, '装载器必须能读到刚冻住的那一版')

  // 装配一次：它必须在 included 里，而不是 exexcluded 里的 missing
  const { collectCandidates } = await import('../../runtime/context/sources.mjs')
  const { assembleContext } = await import('../../runtime/context/assembler.mjs')
  const { createConservativeTokenizer } = await import('../../runtime/context/tokenizer.mjs')
  const asm = assembleContext({
    candidates: collectCandidates({ ...src, scope }),
    scope,
    policy: { maxTokens: 100000, canRead: () => true },
    tokenizer: createConservativeTokenizer(),
    runId: 'r-goalfreeze', attemptId: 'a-goalfreeze', frozenAtMs: Date.now(),
  })
  const included = asm.sources.map((s) => s.id)
  assert.ok(included.includes(`team-plan:${goalId}`), `团队计划必须在 included 里：${included.join(' | ')}`)
  assert.ok(!included.some((i) => i.endsWith(':missing')), `不该再有 missing：${included.join(' | ')}`)
})

test('★★ 冻结之后**改流水线**不会改写已冻住的那一版（历史运行指向的还是当时那一份）', async () => {
  const scope = 'src-load-frozen2'
  await post('/api/agents', { scope, by: 'general', role: 'coder', name: 'coder-乙' })
  const published = await post('/api/goal', { scope, by: 'general', objective: '冻结不可回改' })
  const goalId = published.body.task.goal.id
  assert.equal(published.body.task.teamPlan.stages, 1)

  // 目标发布**之后**再加一个人
  await post('/api/agents', { scope, by: 'general', role: 'tester', name: 'tester-乙' })

  // 已冻住的那一版**一个字段都不变**
  const plan = await (await fetch(`${base}/api/team-plan?scope=${scope}&goalId=${encodeURIComponent(goalId)}`)).json()
  assert.equal(plan.plan.version, 1)
  assert.deepEqual(plan.plan.stages.map((s) => s.role), ['coder'], '冻的是目标创建那一刻的流水线')
})

test('★★ 计划里**不含用户散文**（否则一句像密钥的正文会让"发布目标"失败）', async () => {
  // 这条钉的是一个**刻意的设计决定**，不是实现细节：
  // 计划里放 `objective` 会带来一个没人要的新失败模式——正文里有一句
  // 长得像密钥的话，`findPlaintextSecrets` 会让**发布目标**失败，
  // 而真正把正文发给供应商的那条路（目标上下文）一点没变。
  const scope = 'src-load-noprose'
  const objective = '把 key: sk-live-abcdefghijklmnopqrstuvwxyz 记进笔记里'
  const published = await post('/api/goal', { scope, by: 'general', objective })
  // ★ 发布**成功**——正文里那句像密钥的话不该拦住一个目标的创建
  assert.equal(published.status, 200, `发布目标不该被正文里的疑似密钥拦住：${JSON.stringify(published.body)}`)
  const goalId = published.body.task.goal.id

  const plan = await (await fetch(`${base}/api/team-plan?scope=${scope}&goalId=${encodeURIComponent(goalId)}`)).json()
  // 计划里**没有**那段散文（标题是 id 派生的，note 是固定措辞）
  assert.ok(!JSON.stringify(plan.plan).includes('sk-live-abcdefghijklmnopqrstuvwxyz'),
    '目标正文不该出现在团队计划里——它只该走目标来源那一条路')
  assert.equal(plan.plan.objective, '')
})

test('★★★ 编队带边界内容 → 岗位清单被写出来 → 装载器读得到（PRT-402 的另一个触发点）', async () => {
  const scope = 'src-load-manifest'
  const r = await post('/api/agents', {
    scope, by: 'general', role: 'reviewer', name: '审查员',
    responsibilities: ['审代码'], allowedTools: ['read'], deniedTools: ['deploy'],
    approvalPolicy: 'ask-on-write', limits: { maxTokens: 2048 },
  })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const ref = r.body?.task?.employeeManifest
  assert.equal(ref?.role, 'reviewer')
  assert.equal(ref?.version, 1)
  assert.equal(ref?.created, true)

  const got = await (await fetch(`${base}/api/employee-manifest?scope=${scope}&role=reviewer`)).json()
  assert.equal(got.ok, true)
  assert.deepEqual(got.manifest.deniedTools, ['deploy'])
  assert.equal(got.manifest.approvalPolicy, 'ask-on-write')
  assert.deepEqual(got.manifest.limits, { maxTokens: 2048 })

  // 装载器读得到
  const taskId = await seedTask({ title: '给审查员的任务', scope, role: 'reviewer' })
  const src = await createHubSourceLoader({ hub: makeHub(), scope }).loadSources({ taskId, scope, role: 'reviewer' })
  assert.equal(src.employeeManifest?.role, 'reviewer')
})

test('★★★ 编队**不带**边界内容 → 不写空清单（空 allowedTools 是一条**假规则**）', async () => {
  // 这条钉的是一个刻意的设计决定：编队记录本来只有 role/name/kind/avatar。
  // 若替它写一份空清单，`allowedTools: []` 会被模型读成"这个岗位不允许使用
  // 任何工具"——那是一条它自己编出来的**假规则**，而那句话会改变它的行为。
  //
  //   > 一个"没配置就写一份空清单"的实现，与一个"没配置就不写"的实现，
  //   > 在界面上都显示"没有"——只不过前者会让模型读到一条**假规则**。
  const scope = 'src-load-nomanifest'
  const r = await post('/api/agents', { scope, by: 'general', role: 'coder', name: '只有名字' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.task.employeeManifest, null, '没给边界内容就不该写清单')

  const got = await fetch(`${base}/api/employee-manifest?scope=${scope}&role=coder`)
  assert.equal(got.status, 404, '不该存在一份空清单')

  // 而"没写"必须在快照里表现为**带原因的 missing**，不是"少一项"
  const taskId = await seedTask({ title: '没清单的任务', scope, role: 'coder' })
  const src = await createHubSourceLoader({ hub: makeHub(), scope }).loadSources({ taskId, scope, role: 'coder' })
  assert.equal(src.employeeManifest, null)
  assert.ok('employeeManifest' in src)
})

test('★★ 已有清单时再改编队 → version 递增（边界变更必须改快照哈希）', async () => {
  const scope = 'src-load-manifest2'
  const first = await post('/api/agents', {
    scope, by: 'general', role: 'dev', name: '甲', allowedTools: ['read'],
  })
  assert.equal(first.body.task.employeeManifest.version, 1)
  const second = await post('/api/agents', {
    scope, by: 'general', role: 'dev', name: '甲改名', allowedTools: ['read', 'write'],
  })
  assert.equal(second.body.task.employeeManifest.created, false)
  assert.equal(second.body.task.employeeManifest.version, 2)
  const got = await (await fetch(`${base}/api/employee-manifest?scope=${scope}&role=dev`)).json()
  assert.deepEqual(got.manifest.allowedTools, ['read', 'write'])
  assert.equal(got.manifest.version, 2)
})

test('★ 边界内容里带明文密钥 → **拒绝**，且编队那一行也不该被写进去', async () => {
  // 事务性：清单写失败必须让整次编队变更回滚，否则会出现
  // "编队里有这个人、但他的清单没有"——那种状态看起来一切正常。
  const scope = 'src-load-secretagent'
  const r = await post('/api/agents', {
    scope, by: 'general', role: 'bad', name: '坏的', limits: { apiKey: 'sk-live-abcdefghijklmnopqrstuvwxyz' },
  })
  assert.notEqual(r.status, 200, `带明文密钥的边界内容必须被拒：${JSON.stringify(r.body)}`)
  assert.equal(r.body.code, 'CONTEXT_SOURCE_PLAINTEXT_SECRET')
  // 编队那一行也**没有**留下
  const roster = await (await fetch(`${base}/api/agents?scope=${scope}`)).json()
  const roles = (roster.agents ?? roster.items ?? roster.roster ?? []).map((a) => a.role)
  assert.ok(!roles.includes('bad'), `编队里不该有 bad：${JSON.stringify(roles)}`)
})

test('★ 产物只给引用：正文不装配进来（PRT-405 的预算决定留给调用方）', async () => {
  const id = await seedTask({ title: '任务' })
  const loader = createHubSourceLoader({ hub: makeHub(), scope: SCOPE })
  const src = await loader.loadSources({ taskId: id, scope: SCOPE })
  assert.ok(Array.isArray(src.artifacts))
  // 本装配器不读 /api/artifact/content
  const paths = loader.lastReads().map((r) => r.path)
  assert.ok(!paths.some((p) => p.startsWith('/api/artifact/content')),
    '产物正文是一个预算决定，不该由装配器顺手读进来')
  assert.deepEqual(loader.availability().unconsumed.map((u) => u.path).includes('/api/artifact/content'), true)
})

test('★ lastReads 如实记录读了哪些端点、成没成（排障要的是"问了什么"）', async () => {
  const id = await seedTask({ title: '任务' })
  const loader = createHubSourceLoader({ hub: makeHub(), scope: SCOPE })
  await loader.loadSources({ taskId: id, scope: SCOPE })
  const reads = loader.lastReads()
  assert.ok(reads.length >= 3)
  assert.ok(reads.every((r) => r.ok === true))
  assert.ok(reads.some((r) => r.path.startsWith('/api/task?')))
  assert.ok(reads.some((r) => r.path.startsWith('/api/goal?')))
  assert.ok(reads.some((r) => r.path.startsWith('/api/skills?')))
})

test('lastReads 每次运行重新计（不把上一次的读面累积进来）', async () => {
  const id = await seedTask({ title: '任务' })
  const loader = createHubSourceLoader({ hub: makeHub(), scope: SCOPE })
  await loader.loadSources({ taskId: id, scope: SCOPE })
  const first = loader.lastReads().length
  await loader.loadSources({ taskId: id, scope: SCOPE })
  assert.equal(loader.lastReads().length, first, '这是"上一次运行读了什么"，不是累计日志')
})

// ── ⑤ 构造期与 URL 编码 ──────────────────────────────────────────────────

test('★ 没给 read 能力 → **构造期**抛错（不推迟到某次运行）', () => {
  assert.throws(() => createHubSourceLoader({ hub: null }), (e) => {
    assert.equal(e.code, SOURCES_LOADER_CODES.BAD_WIRING)
    return true
  })
  assert.throws(() => createHubSourceLoader({ hub: {} }), (e) => {
    assert.equal(e.code, SOURCES_LOADER_CODES.BAD_WIRING)
    return true
  })
  assert.throws(() => createHubSourceLoader({ hub: makeHub(), maxSkills: -1 }), (e) => {
    assert.equal(e.code, SOURCES_LOADER_CODES.BAD_WIRING)
    return true
  })
})

test('★ 任务 id 被 URL 编码（带特殊字符的 id 不会拼出一条别的请求）', async () => {
  const seen = []
  const hub = {
    async read(path) {
      seen.push(path)
      if (path.startsWith('/api/task')) { const e = new Error('没有'); e.status = 404; throw e }
      return null
    },
  }
  const loader = createHubSourceLoader({ hub, scope: 's p a c e' })
  await assert.rejects(() => loader.loadSources({ taskId: 'a&b=c d', scope: 's p a c e' }))
  const taskPath = seen.find((p) => p.startsWith('/api/task'))
  // `&` 不编码会把 id 截断并**多出**一个查询参数
  assert.ok(!taskPath.includes('a&b=c d'), `id 必须被编码：${taskPath}`)
  assert.ok(taskPath.includes('a%26b%3Dc%20d'), `编码后的 id 应在 path 里：${taskPath}`)
})

test('maxSkills 限制带进来的技能条数（一个上限，不是建议）', async () => {
  const loader = createHubSourceLoader({ hub: makeHub(), scope: SCOPE, maxSkills: 0 })
  const id = await seedTask({ title: '任务' })
  const src = await loader.loadSources({ taskId: id, scope: SCOPE })
  assert.deepEqual(src.skills, [])
})

test('UNSERVED_SOURCE_FAMILIES 是冻结的（不是一份谁都能改的清单）', () => {
  assert.ok(Object.isFrozen(UNSERVED_SOURCE_FAMILIES))
  assert.ok(Object.isFrozen(UNSERVED_SOURCE_FAMILIES[0]))
})
