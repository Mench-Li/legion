// team-hub/binding-routes.test.mjs
// ============================================================================
// 岗位模型绑定的 HTTP 契约（PRT-502）
//
// 独立进程与自己的库：这一组要建档案再建绑定，共用库会让别的路由测试
// 撞上残留档案（而那种影响看起来像"随机的 409"）。
//
// 这里补的只有真实请求才暴露的三件事：
//   ① `/resolve` 必须**先**于 `/api/model-bindings/` 前缀被匹配到
//      （前缀匹配会把 `resolve` 当成一个 scope 名）；
//   ② 状态码要能区分「参数不对」（400）、「绑定的键不对」（404）、
//      「引用的档案状态与请求不符」（409）；
//   ③ 解析结果里没有密钥。
// ============================================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-bindroutes-'))
let mod
let base = ''

before(async () => {
  process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_TOKEN = ''
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close() } catch { /* 已关闭 */ }
  try { mod?.db?.close() } catch { /* 已关闭 */ }
  rmSync(tmpRoot, { recursive: true, force: true })
})

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, body: parsed, raw: text }
}

async function mkProfile(id, over = {}) {
  const r = await call('POST', '/api/model-profiles', {
    actor: 'route-test',
    profile: {
      id, displayName: `档案 ${id}`, runtimeType: 'dsh', provider: 'deepseek',
      model: `model-${id}`, secretRef: `legion/${id}/secret`, ...over,
    },
  })
  assert.equal(r.status, 200, r.raw)
  return id
}

test('① 建档案 → 建绑定 → 解析出主档案在前的链', async () => {
  await mkProfile('rb-main')
  await mkProfile('rb-b')
  const r = await call('POST', '/api/model-bindings', {
    actor: 'u1', scope: 's1', employeeRole: 'coder',
    primaryProfile: 'rb-main', fallbackProfiles: ['rb-b'],
  })
  assert.equal(r.status, 200, r.raw)
  assert.equal(r.body.binding.primaryProfile, 'rb-main')

  const res = await call('GET', '/api/model-bindings/resolve?scope=s1&role=coder')
  assert.equal(res.status, 200, res.raw)
  assert.deepEqual(res.body.resolution.chain.map((c) => c.id), ['rb-main', 'rb-b'])
  assert.equal(res.body.resolution.ok, true)
})

test('① `/resolve` 不被前缀匹配吃掉（否则它会被当成一个 scope 名）', async () => {
  // 前缀块在 `/resolve` 之后，因此这里拿到的是解析结果，而不是 400「路径应为 …」
  const r = await call('GET', '/api/model-bindings/resolve?scope=s1&role=coder')
  assert.equal(r.status, 200, r.raw)
  assert.ok(r.body.resolution !== undefined, `必须走到 resolve 分支：${r.raw}`)
  assert.equal(r.body.code, undefined, `不得落进前缀分支的 MISSING_PARAM：${r.raw}`)
})

test('① 解析结果里**没有密钥**（在原始响应字节上验）', async () => {
  const r = await call('GET', '/api/model-bindings/resolve?scope=s1&role=coder')
  assert.ok(!r.raw.includes('legion/rb-main/secret'), `解析结果泄露了引用名：${r.raw}`)
  assert.ok(!/sk-[A-Za-z0-9]{10,}/.test(r.raw), `解析结果泄露了密钥：${r.raw}`)
  assert.ok(!r.raw.includes('secretRef'), `解析结果含 secretRef 字段：${r.raw}`)
  for (const c of r.body.resolution.chain) assert.equal(c.hasCredential, true)
})

test('② 状态码三分：参数不对 400 / 键不对 404 / 引用档案状态不符 409', async () => {
  // 键不对 → 404（不是 200 带空链：空链会被读成"没有可用的模型"）
  let r = await call('GET', '/api/model-bindings/resolve?scope=s1&role=nobody')
  assert.equal(r.status, 404, r.raw)
  assert.equal(r.body.code, 'BINDING_NOT_FOUND')

  // 路径段数不对 → 400
  r = await call('GET', '/api/model-bindings/onlyone')
  assert.equal(r.status, 400, r.raw)
  assert.equal(r.body.code, 'MISSING_PARAM')

  // 缺 role → 400（role 是键的一半，没有它无法定位）
  r = await call('GET', '/api/model-bindings/resolve?scope=s1')
  assert.equal(r.status, 400, r.raw)
  assert.equal(r.body.code, 'ROLE_REQUIRED')

  // 引用一个不存在的档案 → 409（引用的东西不存在，是状态冲突而不是参数格式错）
  r = await call('POST', '/api/model-bindings', {
    actor: 'u1', scope: 's1', employeeRole: 'bad', primaryProfile: 'rb-none',
  })
  assert.equal(r.status, 409, r.raw)
  assert.equal(r.body.code, 'PRIMARY_UNRESOLVED')

  // 缺 actor → 400
  r = await call('POST', '/api/model-bindings', { scope: 's1', employeeRole: 'x', primaryProfile: 'rb-main' })
  assert.equal(r.status, 400, r.raw)
  assert.equal(r.body.code, 'ACTOR_REQUIRED')
})

test('② 读到绑定本体（GET 单条），不存在时 404', async () => {
  let r = await call('GET', '/api/model-bindings/s1/coder')
  assert.equal(r.status, 200, r.raw)
  assert.equal(r.body.binding.primaryProfile, 'rb-main')
  assert.deepEqual(r.body.binding.fallbackProfiles, ['rb-b'])

  r = await call('GET', '/api/model-bindings/s1/nobody')
  assert.equal(r.status, 404, r.raw)
  assert.equal(r.body.code, 'BINDING_NOT_FOUND')
})

test('② 列表按 scope 过滤', async () => {
  await call('POST', '/api/model-bindings', {
    actor: 'u1', scope: 's2', employeeRole: 'coder', primaryProfile: 'rb-main',
  })
  let r = await call('GET', '/api/model-bindings')
  assert.equal(r.status, 200)
  assert.ok(r.body.bindings.length >= 2)

  r = await call('GET', '/api/model-bindings?scope=s2')
  assert.equal(r.body.bindings.length, 1)
  assert.equal(r.body.bindings[0].scope, 's2')
})

test('③ 改档案立刻影响解析（删除备用档案后它从链里消失）', async () => {
  await mkProfile('rb-live')
  await mkProfile('rb-doomed')
  let r = await call('POST', '/api/model-bindings', {
    actor: 'u1', scope: 's3', employeeRole: 'coder',
    primaryProfile: 'rb-live', fallbackProfiles: ['rb-doomed'],
  })
  assert.equal(r.status, 200, r.raw)
  r = await call('GET', '/api/model-bindings/resolve?scope=s3&role=coder')
  assert.deepEqual(r.body.resolution.chain.map((c) => c.id), ['rb-live', 'rb-doomed'])

  // 下线备用档案
  const del = await call('DELETE', '/api/model-profiles/rb-doomed', { actor: 'u1', version: 1 })
  assert.equal(del.status, 200, del.raw)

  r = await call('GET', '/api/model-bindings/resolve?scope=s3&role=coder')
  assert.deepEqual(r.body.resolution.chain.map((c) => c.id), ['rb-live'], '下线的备用必须立刻消失')
  assert.equal(r.body.resolution.skipped[0].code, 'PROFILE_DELETED')

  // 下线主档案 → 绑定不可用（不自动让备用顶替）
  await call('DELETE', '/api/model-profiles/rb-live', { actor: 'u1', version: 1 })
  r = await call('GET', '/api/model-bindings/resolve?scope=s3&role=coder')
  assert.equal(r.body.resolution.ok, false)
  assert.match(r.body.resolution.message, /不自动降级到 fallback/)
})

test('③ 删除绑定 → 204/200 且再解析是 404；删不存在是 404', async () => {
  let r = await call('DELETE', '/api/model-bindings/s2/coder', { actor: 'u1' })
  assert.equal(r.status, 200, r.raw)
  assert.equal(r.body.deleted, true)

  r = await call('GET', '/api/model-bindings/resolve?scope=s2&role=coder')
  assert.equal(r.status, 404, r.raw)

  r = await call('DELETE', '/api/model-bindings/s2/coder', { actor: 'u1' })
  assert.equal(r.status, 404, r.raw)
  assert.equal(r.body.code, 'BINDING_NOT_FOUND')
})

test('④ 审计留痕：键能从审计里直接读出来，且没有密钥', async () => {
  const rows = mod.db.prepare(
    "SELECT action, member, scope, taskId, detail FROM audit WHERE action LIKE 'model-binding.%' ORDER BY seq",
  ).all()
  assert.ok(rows.length >= 3, `应当有建/改/删的审计：${JSON.stringify(rows)}`)
  for (const r of rows) {
    // taskId 位置放的是 `scope/role`：不该埋在 detail 里，否则查"谁改了这个岗位"要扫全表
    assert.match(r.taskId, /^[^/]+\/.+$/, `审计的 taskId 应为 scope/role：${JSON.stringify(r)}`)
  }
  const text = JSON.stringify(rows)
  assert.ok(!/sk-[A-Za-z0-9]{10,}/.test(text), `审计泄露密钥：${text}`)
  assert.ok(!text.includes('legion/'), `审计泄露引用名：${text}`)
})

test('④ 分号与斜杠形态的 scope/role 不会切错位置', async () => {
  // `/api/model-bindings/<scope>/<role>`：两段分别解码，整段解码会把 scope 里的
  // 编码斜杠也解出来，于是切错位置（看起来像"绑到了别的岗位"）。
  await mkProfile('rb-x')
  const r = await call('POST', '/api/model-bindings', {
    actor: 'u1', scope: 'sp%2Fweird', employeeRole: 'te%2Fch', primaryProfile: 'rb-x',
  })
  assert.equal(r.status, 200, r.raw)
  // 路径上把 `/` 编码成 %2F 时，段数仍是 2，且解析回来的 scope 含真实的 `/`
  const g = await call('GET', '/api/model-bindings/sp%252Fweird/te%252Fch')
  assert.equal(g.status, 200, `应当取到那条绑定：${g.raw}`)
  assert.equal(g.body.binding.scope, 'sp%2Fweird')
})
