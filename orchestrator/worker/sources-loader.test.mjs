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
async function seedTask({ title = '做一个东西', scope = 'default', description = '描述' }) {
  const r = await post('/api/create', {
    title, description, scope, acceptance: [], boundary: { do: [], dont: [] }, by: 'general',
  })
  assert.ok(r.status === 200 || r.status === 201, `造任务失败：${r.status} ${JSON.stringify(r.body).slice(0, 200)}`)
  const id = r.body?.task?.id
  assert.ok(typeof id === 'string' && id !== '', `create 没有返回任务 id：${JSON.stringify(r.body).slice(0, 200)}`)
  return id
}

const SCOPE = 'default'

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
  for (const k of ['teamPlan', 'employeeManifest', 'userFeedback', 'upstreamDeliveries', 'workspaceState']) {
    assert.ok(keys.includes(k), `${k} 必须被点名——"静静地不出现"与"取不到"在账本上长得一样`)
  }
  for (const u of av.unserved) {
    assert.ok(u.reason.length > 20, `${u.key} 的原因必须具体，不能只写"没有"`)
  }
  // 原因要指向**具体缺的东西**，而不是一句套话
  assert.match(av.unserved.find((u) => u.key === 'teamPlan').reason, /missions|TeamPlan/)
  assert.match(av.unserved.find((u) => u.key === 'employeeManifest').reason, /members|边界|manifest/i)
})

test('★ teamPlan / employeeManifest 传 null（让 sources.mjs 产出 missing 候选，而不是少一项）', async () => {
  const id = await seedTask({ title: '任务' })
  const loader = createHubSourceLoader({ hub: makeHub(), scope: SCOPE })
  const src = await loader.loadSources({ taskId: id, scope: SCOPE })
  assert.equal(src.teamPlan, null)
  assert.equal(src.employeeManifest, null)
  // ★ 关键：这两个键**必须存在**。少了键会让 collectCandidates 里
  //   `input.teamPlan ?? null` 同样得到 null，看似一样——但一个显式的
  //   null 是一个"我们知道它该在这"的声明，缺键不是。
  assert.ok('teamPlan' in src, '键必须在：缺席与没说过的区别就在这里')
  assert.ok('employeeManifest' in src)
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
