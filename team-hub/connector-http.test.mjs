// team-hub/connector-http.test.mjs
// ============================================================================
// F-21 的路由判据（**真 HTTP**，不是直接调函数）。
//
// 为什么必须走真 HTTP：这一层的失败模式几乎都不在函数里，而在
//   · 路由守卫的形状（正则守卫会**悄悄**不进平台契约）
//   · 状态码（409 与 500 对调用方意味着完全不同的动作）
//   · 未授权（401）
//   · 响应形状（随查询参数变的字段 = 调用方只能两个都试一遍）
// 这些都是"直接调函数"看不见的。
// ============================================================================
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TOKEN = 'connector-http-token'
const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-conn-http-'))
let mod
let base = ''

// ★ 环境变量必须在 `import('./server.mjs')` **之前**设好，而这个 import 必须
//   发生在 `before()` 里：`server.mjs` 在模块求值期就开了库。
//   第一版把变量名写成了 `LEGION_DB_FILE`（真名是 `TEAM_HUB_DB`），
//   于是它会去开**默认的那个库**——本地跑起来"能过"，而在别人的机器上
//   可能是在动一份真数据。名字抄错时不会有任何报错提示你。
before(async () => {
  process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_TOKEN = TOKEN
  process.env.TEAM_HUB_HOST = '127.0.0.1'
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${mod.server.address().port}`
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close() } catch { /* 已关 */ }
  try { mod?.db?.close() } catch { /* 已关 */ }
  rmSync(tmpRoot, { recursive: true, force: true })
})

const AUTH = { authorization: `Bearer ${TOKEN}` }

async function call(method, path, body, { auth = true } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(auth ? AUTH : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON 时保留原文 */ }
  return { status: res.status, json, text, headers: res.headers }
}

/** 一份合法声明。 */
function decl(over = {}) {
  return {
    connectorId: 'github',
    version: '1.0.0',
    transport: 'stdio',
    policy: 'allow',
    tools: [
      { name: 'list_issues', capabilities: ['repo:read'], risk: 'low', policy: 'allow' },
      { name: 'create_pr', capabilities: ['repo:push'], risk: 'critical', policy: 'allow' },
    ],
    secretRefs: ['mcp.github.token'],
    ...over,
  }
}

// ---------------------------------------------------------------------------
// ① 冻结：幂等 / 409 / 401
// ---------------------------------------------------------------------------

test('① ★★★ 冻结一份声明 → 201/200 + contentHash；重放幂等；换内容 409', async () => {
  const a = await call('POST', '/api/connectors', { declaration: decl() })
  assert.equal(a.status, 200, a.text)
  assert.equal(a.json.ok, true)
  assert.equal(a.json.created, true)
  assert.equal(a.json.connectorId, 'github')
  assert.equal(a.json.version, '1.0.0')
  assert.match(a.json.contentHash, /^sha256:[0-9a-f]{64}$/)
  assert.equal(a.json.toolCount, 2)

  // 重放 ⇒ 幂等，且**哈希一致**（身份相同）。
  const b = await call('POST', '/api/connectors', { declaration: decl() })
  assert.equal(b.json.created, false)
  assert.equal(b.json.contentHash, a.json.contentHash)
  // ★ 幂等重放不能改写冻结时刻（返回 9999 时调用方会据此写下假的审计记录）。
  assert.equal(b.json.frozenAtMs, a.json.frozenAtMs)

  // 换内容 ⇒ 409（不是 500，也不是 200）。
  const dangerous = decl({
    tools: [...decl().tools, { name: 'delete_repo', capabilities: ['repo:write'], risk: 'high', policy: 'allow' }],
  })
  const c = await call('POST', '/api/connectors', { declaration: dangerous })
  assert.equal(c.status, 409, c.text)
  assert.equal(c.json.code, 'CONNECTOR_VERSION_CONFLICT')
  assert.match(c.json.error, /没有发生/)
})

test('① ★★ 未授权 ⇒ 401（写面与读面都要）', async () => {
  const w = await call('POST', '/api/connectors', { declaration: decl() }, { auth: false })
  assert.equal(w.status, 401)
  const r = await call('GET', '/api/connectors', undefined, { auth: false })
  assert.equal(r.status, 401)
  assert.equal((await call('GET', '/api/connectors/incidents', undefined, { auth: false })).status, 401)
  assert.equal((await call('GET', '/api/connectors/export', undefined, { auth: false })).status, 401)
  assert.equal((await call('POST', '/api/connectors/github/incidents', {}, { auth: false })).status, 401)
})

test('① ★★ 形状不合法 ⇒ 4xx 且带具名码（不是 500）', async () => {
  const bad = await call('POST', '/api/connectors', { declaration: decl({ transport: 'grpc' }) })
  assert.equal(bad.status, 400, bad.text)
  assert.equal(bad.json.code, 'CONNECTOR_TRANSPORT_UNKNOWN')
  const noTools = await call('POST', '/api/connectors', { declaration: decl({ tools: [] }) })
  assert.equal(noTools.json.code, 'CONNECTOR_TOOLS_EMPTY')
  const noVersion = await call('POST', '/api/connectors', { declaration: decl({ version: '' }) })
  assert.equal(noVersion.json.code, 'CONNECTOR_RECORD_MALFORMED')
  // 缺 `declaration` 整块也要报 4xx（不是 500）。
  const missing = await call('POST', '/api/connectors', {})
  assert.equal(missing.status, 400, missing.text)
})

// ---------------------------------------------------------------------------
// ② 读：形状**不随参数变**
// ---------------------------------------------------------------------------

test('② ★★★ 列表响应的形状不随查询参数变（`records` + `registration` + `counts`）', async () => {
  const noParam = await call('GET', '/api/connectors')
  assert.equal(noParam.status, 200)
  for (const k of ['records', 'registration', 'counts']) {
    assert.equal(k in noParam.json, true, `不带参数时缺字段 ${k}`)
  }
  assert.equal(Array.isArray(noParam.json.records), true)
  assert.equal(noParam.json.registration, null, '没指定 connectorId 时就是 null')

  const withParam = await call('GET', '/api/connectors?connectorId=github')
  for (const k of ['records', 'registration', 'counts']) {
    assert.equal(k in withParam.json, true, `带参数时缺字段 ${k}——形状随参数变，调用方只能两个都试一遍`)
  }
  assert.equal(Array.isArray(withParam.json.records), true)
  assert.equal(withParam.json.registration.connectorId, 'github')
  assert.equal(withParam.json.registration.version, '1.0.0')
  // ★ 坏行与"从没登记过"必须分得开：`readable` 要带出去。
  assert.equal(withParam.json.registration.readable, true)
  assert.equal(withParam.json.registration.declaration.tools.length, 2)

  // 不存在的连接器 ⇒ 仍是同一个形状，`registration` 为 null。
  const ghost = await call('GET', '/api/connectors?connectorId=nope')
  assert.equal(ghost.json.registration, null)
  assert.deepEqual(ghost.json.records, [])
  assert.equal(ghost.json.counts.registrations > 0, true, 'counts 是 scope 级的，不是这一个 id 的')
})

test('② ★★ `sinceSeq` 增量读，且只读自己那一段', async () => {
  const all = await call('GET', '/api/connectors')
  const first = all.json.records[0]
  assert.equal(Number.isInteger(first.seq), true)
  const after = await call('GET', `/api/connectors?sinceSeq=${first.seq}`)
  assert.equal(after.json.records.every((r) => r.seq > first.seq), true)
  assert.equal(after.json.records.length, all.json.records.length - 1)
})

test('② ★ 多个版本同时存在（"当时放行了哪些工具"要有得查）', async () => {
  const v = await call('POST', '/api/connectors', {
    declaration: decl({
      version: '2.0.0',
      tools: [{ name: 'list_issues', capabilities: ['repo:read'], risk: 'low', policy: 'deny' }],
    }),
  })
  assert.equal(v.status, 200, v.text)
  const one = await call('GET', '/api/connectors?connectorId=github&version=1.0.0')
  const two = await call('GET', '/api/connectors?connectorId=github&version=2.0.0')
  // 1.0.0 的工具清单与 2.0.0 不同，且都还在。
  const declOne = one.json.registration.declaration
  const declTwo = two.json.registration.declaration
  assert.equal(declOne.tools.length, 2)
  assert.equal(declTwo.tools.length, 1)
  assert.equal(declTwo.tools[0].policy, 'deny')
  // 不传 version ⇒ 最新一版（2.0.0）。
  const latest = await call('GET', '/api/connectors?connectorId=github')
  assert.equal(latest.json.registration.version, '2.0.0')
})

// ---------------------------------------------------------------------------
// ③ ★★★ 事件路由：字面量守卫 + 点名
// ---------------------------------------------------------------------------

test('③ ★★★ 记一条熔断事件，并**点名**开路的那些', async () => {
  const a = await call('POST', '/api/connectors/github/incidents', {
    kind: 'circuit-opened', circuitState: 'open', atMs: 1000, reason: '连续失败', actor: 'alice',
  })
  assert.equal(a.status, 200, a.text)
  assert.equal(a.json.appended, true)
  assert.equal(a.json.connectorId, 'github')
  assert.equal(Number.isInteger(a.json.seq), true)

  const list = await call('GET', '/api/connectors/incidents?connectorId=github')
  assert.equal(list.status, 200)
  assert.equal(list.json.records.length, 1)
  assert.equal(list.json.records[0].reason, '连续失败')
  assert.equal(list.json.records[0].actor, 'alice')
  // ★ 隔离读数点名是**哪一个**，而不是"有故障"这一个布尔。
  assert.deepEqual(list.json.counts.openCircuitIds, ['github'])
  assert.equal(Array.isArray(list.json.counts.openCircuitIds), true)

  // 恢复之后 open 清单要变空。
  await call('POST', '/api/connectors/github/incidents', {
    kind: 'circuit-closed', circuitState: 'closed', atMs: 2000, reason: '探针成功',
  })
  const after = await call('GET', '/api/connectors/incidents')
  assert.deepEqual(after.json.counts.openCircuitIds, [])
  assert.equal(after.json.records.length, 2)
})

test('③ ★★★ 事件路由的守卫是**字面量**（正则守卫会悄悄不进平台契约）', async () => {
  // id 里带 `/` ⇒ 400，而不是被当成一个合法但永远不存在的 id。
  const slash = await call('POST', '/api/connectors/a/b/incidents', {
    kind: 'circuit-opened', circuitState: 'open', atMs: 1,
  })
  assert.equal(slash.status, 400, slash.text)
  assert.equal(slash.json.code, 'CONNECTOR_EVENT_MALFORMED')
  // 空 id 同理（`/api/connectors//incidents`）。
  const empty = await call('POST', '/api/connectors//incidents', {
    kind: 'circuit-opened', circuitState: 'open', atMs: 1,
  })
  assert.equal(empty.status, 400, empty.text)
  // 尾部少一段 ⇒ 落到 404（不是被某个宽守卫吞掉）。
  const notRoute = await call('POST', '/api/connectors/github/incident', {
    kind: 'circuit-opened', circuitState: 'open', atMs: 1,
  })
  assert.equal(notRoute.status, 404, notRoute.text)
})

test('③ ★★ 事件必填项缺一个 ⇒ 4xx 且带具名码', async () => {
  // 没点名连接器不可能发生（路由里就有 id），但种类/状态/atMs 都要拦。
  const badKind = await call('POST', '/api/connectors/github/incidents', {
    kind: 'exploded', circuitState: 'open', atMs: 1,
  })
  assert.equal(badKind.status, 400, badKind.text)
  assert.equal(badKind.json.code, 'CONNECTOR_EVENT_MALFORMED')
  const badState = await call('POST', '/api/connectors/github/incidents', {
    kind: 'circuit-opened', circuitState: 'melted', atMs: 1,
  })
  assert.equal(badState.json.code, 'CONNECTOR_CIRCUIT_STATE_UNKNOWN')
  // ★ `atMs` 必填：`undefined` 与"当时就是 0"同形。
  const noAt = await call('POST', '/api/connectors/github/incidents', {
    kind: 'circuit-opened', circuitState: 'open',
  })
  assert.equal(noAt.status, 400, noAt.text)
  assert.equal(noAt.json.code, 'CONNECTOR_EVENT_MALFORMED')
  assert.match(noAt.json.error, /atMs/)
})

// ---------------------------------------------------------------------------
// ④ 导出
// ---------------------------------------------------------------------------

test('④ ★★ 导出是可提交进 Git 的审阅文本（含权限面，不含命令）', async () => {
  const res = await call('GET', '/api/connectors/export')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /application\/json/)
  assert.match(res.headers.get('content-disposition') ?? '', /legion-connectors\.json/)
  assert.equal(res.json.format, 'legion/connector-export@1')
  assert.equal(res.json.registrations.length >= 2, true)
  const first = res.json.registrations.find((r) => r.version === '1.0.0')
  // 权限面必须在（那正是这个文件存在的理由）。
  assert.equal(first.policy, 'allow')
  assert.deepEqual(first.tools.map((t) => t.name).sort(), ['create_pr', 'list_issues'])
  assert.deepEqual(first.secretRefs, ['mcp.github.token'])
  // ★ 引用的**名字**要在，而凭证值不可能在这里——声明里就装不下。
  assert.equal(/ghp_|BEGIN [A-Z ]*PRIVATE KEY/.test(res.text), false)
  // 事件也在。
  assert.equal(res.json.incidents.length >= 2, true)
})

// ---------------------------------------------------------------------------
// ⑤ 结构性：路由守卫的形状（PRT-507 那个坑）
// ---------------------------------------------------------------------------

test('⑤ ★★★ 新增路由都写在**字面量**上（基线抽取器只认字面量）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  // F-21 那一组必须能在源码里按**字面量**找到——正则守卫会让
  // `baseline-snapshot.mjs` 的抽取器看不到这条路由，于是基线看起来正常、
  // 却少了一条端点（PRT-507 的坑）。
  for (const route of [
    "path === '/api/connectors'",
    "path === '/api/connectors/incidents'",
    "path === '/api/connectors/export'",
    "path.startsWith('/api/connectors/')",
    "path.endsWith('/incidents')",
  ]) {
    assert.equal(src.includes(route), true, `源码里找不到字面量守卫：${route}`)
  }
  // 而且这一组里不许出现正则路由守卫（`/^\/api\/connectors…/`）。
  const f21 = src.slice(src.indexOf('F-21 连接器登记表'), src.indexOf('F-15 用量汇总'))
  assert.equal(/\/\^\\?\/api\//.test(f21), false, 'F-21 里出现了正则路由守卫')
})
