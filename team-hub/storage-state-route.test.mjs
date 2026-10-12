// team-hub/storage-state-route.test.mjs
// ============================================================================
// `/api/identity/storage-state` 的**端到端**行为（真 HTTP）。
//
// 纯决策由 `storage-state.test.mjs` 钉住；这一族问的是**接线**：
//
//   > 一个"算得对但没接上"的读数，与一个没写过的读数，
//   > 在运维那里是同一句话："没有在定时体检存储"。
//
// 还要钉住那个端点的**理由**本身：
//
//   > 一个"配了定时器"的部署，与一个"定时器从来没跑成功过"的部署，
//   > 在 `systemctl list-timers` 里长得一模一样 ——
//   > 只要没人去看 `LAST` 那一列。
//
// 所以这里要证明的是：**读数会随状态文件的新鲜度变化而变化**。
// 一个永远回同一句话的端点，无法回答那个问题。
// ============================================================================
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { STATE_SCHEMA, makeState } from './storage-state.mjs'
import { codeOnly } from '../scripts/lib/code-only.mjs'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-state-route-'))
const HUB_TOKEN = 'state-route-hub-token'
const IDENTITY_KEY = 'state-route-identity-key-0123456789'
const STATE_PATH = join(tmpRoot, 'run', 'storage-state.json')
let mod
let base = ''

/**
 * 落一份**带历史样本**的状态文件（模拟定时器跑了很多轮）。
 *
 * `perHour` 是库每小时长多少字节；样本以"现在"结尾 —— 否则趋势会被判成
 * 陈旧（那正是另一条判据要验的事）。
 */
const seedHistory = ({ rounds = 8, perHour = 1 * 1024 * 1024, nowMs = Date.now(), level = 'ok' } = {}) => {
  mkdirSync(join(tmpRoot, 'run'), { recursive: true })
  const HOUR = 3600 * 1000
  const history = Array.from({ length: rounds }, (_, i) => ({
    atMs: nowMs - (rounds - 1 - i) * HOUR,
    dbBytes: 4 * 1024 * 1024 + i * perHour,
    freeBytes: 45 * 1024 ** 3,
  }))
  writeFileSync(STATE_PATH, JSON.stringify(makeState({
    level, exitCode: level === 'ok' ? 0 : 1, atMs: nowMs, host: 'test-host',
    report: { dbBytes: history[history.length - 1].dbBytes, walBytes: 4 * 1024 * 1024, freeBytes: 45 * 1024 ** 3, backupAgeMs: HOUR, backupStale: false },
    problems: [], history,
  })), 'utf8')
  return history
}

/** 直接落一份状态文件（模拟定时器跑完）。 */
const seed = (over = {}) => {
  mkdirSync(join(tmpRoot, 'run'), { recursive: true })
  writeFileSync(STATE_PATH, JSON.stringify(makeState({
    level: 'ok', exitCode: 0, atMs: Date.now(), host: 'test-host',
    report: { dbBytes: 3_000_000, walBytes: 4_000_000, freeBytes: 45 * 1024 ** 3, backupAgeMs: 3600_000, backupStale: false },
    problems: [],
    ...over,
  })), 'utf8')
}

before(async () => {
  process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_HOST = '127.0.0.1'
  process.env.TEAM_HUB_TOKEN = HUB_TOKEN
  process.env.LEGION_IDENTITY_KEY = IDENTITY_KEY
  process.env.LEGION_REMOTE_AUTH = '1'
  process.env.LEGION_STORAGE_STATE_PATH = STATE_PATH
  mod = await import('./server.mjs')
  await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${mod.server.address().port}`
})

after(() => {
  try { mod?.nodeGateway?.close?.() } catch { /* 已关 */ }
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close() } catch { /* 已关闭 */ }
  try { mod?.db?.close?.() } catch { /* 已关闭 */ }
  rmSync(tmpRoot, { recursive: true, force: true })
})

/**
 * GET，默认带机器令牌。
 *
 * ★★ 这里有一个**真陷阱**，我在自己的测试里踩了一次：
 *   `token` 的默认值只在实参是 `undefined` 时生效 —— 所以
 *   `get(path, { token: null })` **会带上令牌**，而写它的人
 *   （我）想表达的是"不带令牌"。
 *
 *   > `undefined` 与"没写这个字段"在默认参数眼里是同一个东西，
 *   > 而在读代码的人眼里是两个意思。
 *
 *   所以"匿名"用 `null` 表示，在函数体里显式分流。
 */
async function get(path, { token = HUB_TOKEN } = {}) {
  const headers = {}
  // `null` = 显式匿名（不是"用默认值"）。
  const useToken = token === null ? null : token
  if (useToken !== null && useToken !== undefined) headers.authorization = `Bearer ${useToken}`
  const res = await fetch(base + path, { headers })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}

describe('/api/identity/storage-state', () => {
  it('★★★ ① 匿名访问必须 401（运维面不许公开）', async () => {
    const r = await get('/api/identity/storage-state', { token: null })
    assert.equal(r.status, 401, `匿名访问应当 401，实际 ${r.status}`)
    // ★ 而且**不许**把读数漏出去 —— 一个 401 但带 body 的实现等于公开。
    assert.equal(r.json?.storage, undefined, '401 的响应里不许带读数')
    // ⚠️ 这里**不**断言响应体的具体形状：在这一套配置下，先挡住它的是
    //    `remote-auth-gate`（回 `REMOTE_AUTH_MISSING`），而不是本路由自己的守卫。
    //    两个都会 401，但**形状不同** —— 而"哪一层挡的"取决于部署配置。
    //    路由自己那一层由下一条判据**直接**验（绕开那道门）。
  })

  it('★★★ ①② 路由**自己**的守卫也必须是 401（那道门外也可能只有它）', async () => {
    // ★ 为什么必须单独验：
    //   `remote-auth-gate` 只在 `LEGION_REMOTE_AUTH` + `LEGION_IDENTITY_KEY`
    //   都配上时才跑。一个**只绑回环、没开远端鉴权**的部署里，那道门不存在 ——
    //   此时路由自己这一层是**唯一**的保护。
    //
    //   > 一个"被别人挡住的"端点，与一个"自己会挡"的端点，
    //   > 在开了门的那套配置里长得一模一样。
    //
    //   所以这里直接构造身份族、注入一个**永远不认**的 `authorized`，
    //   绕开那一道门。
    const { createIdentityRoutes } = await import('./routes/identity.mjs')
    const family = createIdentityRoutes({
      json: (res, status, body) => { res.statusCode = status; res.body = body },
      readBody: async () => ({}),
      authorized: () => false,
      requireString: () => { },
      userStore: mod.userStore,
      deviceStore: mod.deviceStore,
      // `gateway` 允许 null，但**不能不传**（工厂会明确报缺注入项）。
      gateway: null,
      storageStatePath: STATE_PATH,
    })
    const call = async (path) => {
      const res = { statusCode: null, body: null, setHeader() { }, end() { } }
      const hit = await family.dispatch({ method: 'GET', headers: {} }, res, {
        path, url: new URL(`http://x${path}`),
      })
      return { hit, res }
    }
    const anon = await call('/api/identity/storage-state')
    assert.equal(anon.hit, true, '路由应当被匹配到')
    assert.equal(anon.res.statusCode, 401, `路由自己的守卫必须 401，实际 ${anon.res.statusCode}`)
    assert.equal(anon.res.body?.storage, undefined, '路由自己的 401 也不许带读数')
    assert.equal(anon.res.body?.ok, false)
    assert.match(anon.res.body?.error, /管理令牌|管理员/, '要说清需要什么')

    // 而**限速读数**那条（上一轮写的）走同一个守卫 —— 两处不许漂。
    const rl = await call('/api/identity/rate-limits')
    assert.equal(rl.res.statusCode, 401, '限速读数也必须被同一个守卫挡住')
    assert.equal(rl.res.body?.ok, false)
  })

  it('★★★ ①③ 两个运维端点用的是**同一个**守卫函数（不许各写一遍）', async () => {
    // 抽出来就是为了这个：`requireOperator` 调用点应当有且只有两处。
    // 新增第三个运维端点时如果自己写一遍鉴权，漂的那一次会是**更松**的那次。
    const code = codeOnly((await import('node:fs')).readFileSync(new URL('./routes/identity.mjs', import.meta.url), 'utf8'))
    const calls = code.split('\n').filter((l) => /requireOperator\(/.test(l) && !/function requireOperator/.test(l))
    assert.equal(calls.length, 2, `requireOperator 应当被调用 2 次，实际 ${calls.length}：\n  ${calls.join('\n  ')}`)
    assert.ok(/function requireOperator\(/.test(code), '守卫函数必须存在')
  })

  it('★★★ ② 机器令牌可以读（运维身份）', async () => {
    seed()
    const r = await get('/api/identity/storage-state')
    assert.equal(r.status, 200, r.text.slice(0, 200))
    assert.equal(r.json?.ok, true)
    assert.ok(r.json?.storage, '响应里必须有 storage 读数')
  })

  it('★★★ ③ 状态文件不存在时必须报 `no-state`（**不是** ok）', async () => {
    // ★ 这条是整个端点存在的理由：没有它，"定时器从来没跑过"看起来像"一切正常"。
    rmSync(STATE_PATH, { force: true })
    const r = await get('/api/identity/storage-state')
    assert.equal(r.status, 200, '读数本身是 200 —— "没人测"是一个读数，不是端点故障')
    assert.equal(r.json.storage.level, 'unknown')
    assert.equal(r.json.storage.reason, 'no-state')
    assert.equal(r.json.storage.fresh, false)
    assert.match(r.json.storage.summary.text, /没有\*\*在定时体检|没有在定时体检/)
  })

  it('★★★ ④ 新鲜的状态必须**原样**报出（等级 + 年龄 + 退出码）', async () => {
    seed({ level: 'warn', exitCode: 1 })
    const r = await get('/api/identity/storage-state')
    assert.equal(r.json.storage.level, 'warn')
    assert.equal(r.json.storage.reason, 'fresh')
    assert.equal(r.json.storage.fresh, true)
    assert.equal(r.json.storage.exitCode, 1)
    assert.equal(r.json.storage.host, 'test-host')
    // 读数里的数也要在（运维要靠它判断要清出多少）。
    assert.equal(r.json.storage.report.freeBytes, 45 * 1024 ** 3)
    assert.equal(r.json.storage.report.backupStale, false)
  })

  it('★★★ ⑤ **陈旧**的状态必须降级成 unknown，但仍报出上次的结论', async () => {
    // 这是"你以为有人看着，其实没有人在测"那一条。
    seed({ level: 'ok', exitCode: 0, atMs: Date.now() - 3 * 24 * 3600 * 1000 })
    const r = await get('/api/identity/storage-state')
    assert.equal(r.json.storage.level, 'unknown', '陈旧的 ok 绝不能报成 ok')
    assert.equal(r.json.storage.reason, 'stale')
    assert.equal(r.json.storage.lastKnownLevel, 'ok')
    assert.match(r.json.storage.summary.text, /没跑/)
    // ★ 而渲染好的句子里**不许**剩占位符（它会被人直接读）。
    assert.doesNotMatch(r.json.storage.summary.text, /\{[A-Za-z_]/)
  })

  it('★★★ ⑥ 状态文件在但读不出来 → `unreadable`，**不是** `no-state`', async () => {
    // ★ 两者的含义不同：文件在但读不出来说明**写入方**有问题（去查它），
    //   文件不在说明**从来没跑过**（去装定时器）。合成一个会让值班的人做错事。
    mkdirSync(join(tmpRoot, 'run'), { recursive: true })
    writeFileSync(STATE_PATH, '{ 这不是 json', 'utf8')
    const r = await get('/api/identity/storage-state')
    assert.equal(r.json.storage.level, 'unknown')
    assert.equal(r.json.storage.reason, 'unreadable')
    assert.notEqual(r.json.storage.reason, 'no-state')
    assert.match(r.json.storage.summary.text, /读不出来/)
  })

  it('★★★ ⑦ **版本不认识**也要分开报（脚本与 Hub 版本不一致）', async () => {
    mkdirSync(join(tmpRoot, 'run'), { recursive: true })
    writeFileSync(STATE_PATH, JSON.stringify({ schema: STATE_SCHEMA + 7, atMs: Date.now(), level: 'ok', exitCode: 0 }), 'utf8')
    const r = await get('/api/identity/storage-state')
    assert.equal(r.json.storage.reason, 'schema-mismatch')
    assert.match(r.json.storage.summary.text, /版本不认识/)
  })

  it('★★★ ⑧ 端点回出**文件路径**（运维要知道它在读哪里）', async () => {
    // 一个只回结论、不回"读的是哪个文件"的端点，在有人把
    // `LEGION_STORAGE_STATE_PATH` 配错时会让人查很久。
    seed()
    const r = await get('/api/identity/storage-state')
    assert.equal(r.json.storage.path, STATE_PATH)
  })

  it('★★★ ⑨ 读数随文件内容变化而变化（不是一句写死的话）', async () => {
    // ★ 这是"端点在真的读文件"的守卫。一个永远回同一句话的实现能通过
    //   上面所有单点断言的某几条，但过不了这条。
    const seen = new Set()
    for (const level of ['ok', 'warn', 'critical']) {
      seed({ level, exitCode: { ok: 0, warn: 1, critical: 2 }[level] })
      const r = await get('/api/identity/storage-state')
      seen.add(`${r.json.storage.level}:${r.json.storage.summary.text}`)
    }
    assert.equal(seen.size, 3, `三种状态必须给出三种不同的读数，实际 ${JSON.stringify([...seen])}`)
  })

  it('★★★ ⑩ 与限速读数一样，**不在公开名单**里', async () => {
    // 匿名能读"我有没有在限速/盘满没满"等于把运维面暴露出去。
    // 这条同时守住"以后有人顺手把它加进 PUBLIC_PATHS"。
    const anon = await get('/api/identity/storage-state', { token: null })
    assert.equal(anon.status, 401)
    // 而它们的**邻居**（公开的）仍然公开 —— 证明 401 不是被整族拖累的。
    const pub = await get('/api/identity/status', { token: null })
    assert.equal(pub.status, 200, '公开端点不该受影响')
  })

  it('★★★ ⑪ 配置的**默认值**必须在 tmpfs 上（新部署不配也对）', async () => {
    // ★ 这条查的是 `config-schema.mjs` 里的默认值，而不是这个测试进程里
    //   被我覆盖过的那个值 —— 一个默认落在 `/var/lib/legion-hub/` 的配置，
    //   会让每一台**不额外配置**的部署都踩上"写在正在满的那块盘上"。
    //
    //   （第一版我断言的是 `mod.CFG.values.storageStatePath`，而 `server.mjs`
    //     **不导出** `CFG` —— 于是判据在 `undefined` 上比较，报了个
    //     "undefined !== 路径" 的错，看起来像实现坏了。）
    const { SCHEMA } = await import('./config-schema.mjs')
    const fields = Array.isArray(SCHEMA) ? SCHEMA : (SCHEMA.fields ?? [])
    const field = fields.find((f) => f?.key === 'storageStatePath')
    assert.ok(field, 'schema 里必须有 storageStatePath')
    assert.match(field.default, /^\/run\//, `默认值必须在 tmpfs 上，实际 ${field.default}`)
    assert.equal(field.env, 'LEGION_STORAGE_STATE_PATH')
    // 与本进程里生效的那个值**不是**同一件事（测试覆盖过它）—— 正好说明
    // "默认值"与"运行时值"要分开查。
    assert.equal(mod.CFG, undefined, 'server.mjs 不导出 CFG —— 判据不该去读它')
  })

  it('★★★ ①④ 非管理员的**登录用户**也必须被挡住（走 requireSystemAdmin 那一支）', async () => {
    // ★ 这一条是破坏性验证逼出来的：上面 ①② 用的是"没有令牌"的匿名请求，
    //   于是代码**从来没走到** `requireSystemAdmin` 那一行 ——
    //   把那行删掉（"任何登录用户都能读运维面"）**没有任何判据变红**。
    //
    //   > 一段从来没有被执行过的分支，与一段没有被写过的分支，
    //   > 在覆盖率报告之外长得一模一样。
    //
    //   所以这里注入一个**认得令牌、但会拒绝系统管理员**的 userStore：
    //   `currentUser` 走通，随后必须被 `requireSystemAdmin` 拦住。
    const { createIdentityRoutes } = await import('./routes/identity.mjs')
    let adminAsked = null
    const stubStore = {
      // `currentUser` 会调它；返回成功，模拟"一个合法的普通用户"。
      verifyAccessToken: () => ({ ok: true, userId: 'u-普通用户', sessionId: 's1', name: 'probe' }),
      touchSession: () => { },
      // ★ 关键：拒绝。真实实现会抛一个带 status/code 的错误。
      requireSystemAdmin: (userId) => {
        adminAsked = userId
        throw Object.assign(new Error('需要系统管理员'), { status: 403, code: 'PERMISSION_DENIED' })
      },
    }
    const family = createIdentityRoutes({
      json: (res, status, body) => { res.statusCode = status; res.body = body },
      readBody: async () => ({}),
      authorized: () => false,
      requireString: () => { },
      userStore: stubStore,
      deviceStore: mod.deviceStore,
      gateway: null,
      storageStatePath: STATE_PATH,
    })
    const res = { statusCode: null, body: null, setHeader() { }, end() { } }
    const path = '/api/identity/storage-state'
    await family.dispatch(
      { method: 'GET', headers: { authorization: 'Bearer 一个合法的用户令牌' } },
      res,
      { path, url: new URL(`http://x${path}`) },
    )
    assert.equal(adminAsked, 'u-普通用户', '必须**真的去问过**系统管理员（那一支必须被执行）')
    assert.equal(res.statusCode, 403, `非管理员应当是 403，实际 ${res.statusCode}`)
    assert.equal(res.body?.storage, undefined, '403 也不许漏读数')

    // ★ 而**系统管理员**（放行）必须能读到 —— 否则上面那条只是"所有人都被挡"。
    const okStore = {
      verifyAccessToken: () => ({ ok: true, userId: 'u-管理员', sessionId: 's2', name: 'admin' }),
      touchSession: () => { },
      requireSystemAdmin: () => { },
    }
    const family2 = createIdentityRoutes({
      json: (res2, status, body) => { res2.statusCode = status; res2.body = body },
      readBody: async () => ({}),
      authorized: () => false,
      requireString: () => { },
      userStore: okStore,
      deviceStore: mod.deviceStore,
      gateway: null,
      storageStatePath: STATE_PATH,
    })
    const res2 = { statusCode: null, body: null, setHeader() { }, end() { } }
    await family2.dispatch(
      { method: 'GET', headers: { authorization: 'Bearer 管理员令牌' } },
      res2,
      { path, url: new URL(`http://x${path}`) },
    )
    assert.equal(res2.statusCode, 200, `系统管理员应当能读，实际 ${res2.statusCode}`)
    assert.ok(res2.body?.storage, '管理员必须拿得到读数')
  })

  it('★★★ ①⑤ 状态**路径是个目录**（读文件抛非 ENOENT）→ `unreadable`，不是 `no-state`', async () => {
    // ★ 这条守的是 `e?.code === 'ENOENT' ? null : '{ 读不出来 }'` 那个三元。
    //   把它换成无条件 `null`（"读失败就当没跑过"）时，没有别的判据会红 ——
    //   因为**唯一**能让 readFileSync 抛的不是 ENOENT 的情形，就是这条。
    //
    //   ENOENT（文件不在）与其它读错误（权限、是个目录、I/O）含义完全不同：
    //   前者是"去装定时器"，后者是"去查写入方/权限"。
    // ⚠️ 先删掉可能的**文件**再建目录：`mkdirSync(…, {recursive:true})` 碰到
    //    已存在的文件会抛 EEXIST（前一条判据 seed 过一个文件）。
    rmSync(STATE_PATH, { recursive: true, force: true })
    mkdirSync(STATE_PATH, { recursive: true })
    const r = await get('/api/identity/storage-state')
    assert.equal(r.status, 200, '读数本身仍应是 200')
    assert.equal(r.json.storage.level, 'unknown')
    assert.equal(r.json.storage.reason, 'unreadable',
      `路径是目录时必须报 unreadable，实际 ${r.json.storage.reason}（ENOENT 分支被误用了）`)
    assert.notEqual(r.json.storage.reason, 'no-state')
    rmSync(STATE_PATH, { recursive: true, force: true })
  })

  it('★★★ ⑬ 端点必须报**趋势**（只有"现在多大"答不出"还剩多久"）', async () => {
    seedHistory({ rounds: 8, perHour: 1 * 1024 * 1024 })
    const r = await get('/api/identity/storage-state')
    assert.equal(r.status, 200)
    const g = r.json.storage.growth
    assert.ok(g, '响应里必须有 growth 块')
    assert.equal(g.reason, 'growing', JSON.stringify(g))
    assert.ok(Number.isFinite(g.bytesPerDay) && g.bytesPerDay > 0, `bytesPerDay=${g.bytesPerDay}`)
    assert.ok(Number.isFinite(g.daysEffective), `daysEffective=${g.daysEffective}`)
    assert.equal(g.sampleCount, 8)
    // 而说法是**渲染好的**（运维会直接读它）。
    assert.equal(typeof g.summary.text, 'string')
    assert.doesNotMatch(g.summary.text, /\{[A-Za-z_]/, `不许剩占位符：${g.summary.text}`)
  })

  it('★★★ ⑭ 样本不够时趋势是 `insufficient`，**不给任何时间数**', async () => {
    seedHistory({ rounds: 3, perHour: 1 * 1024 * 1024 })
    const r = await get('/api/identity/storage-state')
    const g = r.json.storage.growth
    assert.equal(g.reason, 'insufficient')
    assert.equal(g.bytesPerDay, null)
    assert.equal(g.daysEffective, null, '不许给一个从 3 个样本算出来的到期时间')
    assert.match(g.summary.text, /算不出来/)
  })

  it('★★★ ⑮ **陈旧样本**的趋势必须被拒绝（服务重启后 tpfs 清空就是这个情形）', async () => {
    // ★ 状态文件在 tmpfs 上 —— 机器重启后历史就没了。而下一次定时器跑之前，
    //   文件根本不在。这一条验的是"样本很老"那一路。
    seedHistory({ rounds: 8, perHour: 1 * 1024 * 1024, nowMs: Date.now() - 3 * 24 * 3600 * 1000 })
    const r = await get('/api/identity/storage-state')
    const g = r.json.storage.growth
    assert.equal(g.reason, 'stale-samples', JSON.stringify(g))
    assert.equal(g.bytesPerDay, null, '三天前的曲线不许当成现在的趋势')
    assert.match(g.summary.text, /定时器|给不出/)
  })

  it('★★★ ⑯ 没有历史（老状态文件 / 刚重启）→ `insufficient`，**不是**崩', async () => {
    seed()   // 不带 history 的那一份
    const r = await get('/api/identity/storage-state')
    assert.equal(r.status, 200)
    assert.equal(r.json.storage.growth.reason, 'insufficient')
    assert.equal(r.json.storage.growth.sampleCount, 0)
  })

  it('★★★ ⑰ 状态文件缺失时 `growth` 块**仍然在**（形状不许随情形变）', async () => {
    // ★ 一个"有时候没有 growth 字段"的响应，会让调用方在别处炸 ——
    //   而那种炸发生在**正好没有状态文件**的时候（＝还没装定时器的新部署）。
    rmSync(STATE_PATH, { force: true })
    const r = await get('/api/identity/storage-state')
    assert.equal(r.status, 200)
    assert.ok(r.json.storage.growth !== undefined, '缺文件时 growth 也必须存在')
    assert.equal(r.json.storage.growth.reason, 'insufficient')
    assert.equal(r.json.storage.growth.sampleCount, 0)
    assert.equal(typeof r.json.storage.growth.summary.text, 'string')
  })

  it('★★★ ⑱ 状态文件读不出来时 `growth` 块也在（形状一致）', async () => {
    mkdirSync(join(tmpRoot, 'run'), { recursive: true })
    writeFileSync(STATE_PATH, '{ 坏', 'utf8')
    const r = await get('/api/identity/storage-state')
    assert.equal(r.json.storage.reason, 'unreadable')
    assert.ok(r.json.storage.growth !== undefined)
    assert.equal(r.json.storage.growth.reason, 'insufficient')
  })
})
