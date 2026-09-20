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

test('⑤ ★★★ F-21 的路由对**基线抽取器**可见（字面量守卫，不是常量/正则）', async () => {
  const { readFileSync } = await import('node:fs')
  const { extractDeclaredRoutes, findOpaqueRouteGuards } =
    await import('../scripts/prt/baseline-snapshot.mjs')
  // ★ PRT-316 切片 12：F-21 那一组已搬进 `routes/connectors.mjs`
  //   （`server.mjs` 里只剩一行 `router.dispatch`）。所以这里的"源码"指的是**模块** ——
  //   它也正是 `baseline-snapshot.mjs` 的 `ROUTE_FAMILY_SOURCES` 登记的抽取来源。
  //
  //   改的是**读哪个文件**，判据反而更硬了：原来是"这几个字符串能在源码里找到"，
  //   现在是"抽取器**真的能看见**这几条路由" —— 后者才是这条测试标题说的那件事。
  //
  //   > 一次搬家会同时移动"字面量"与"抽取器要读的文件"。
  //   > 只把断言里的字面量更新一遍、却仍旧读旧文件，
  //   > 这条测试就会继续对着一个**里面已经没有它要找的东西**的文件下判断。
  const mod = readFileSync(new URL('./routes/connectors.mjs', import.meta.url), 'utf8')
  const seen = extractDeclaredRoutes(mod)
  for (const r of ['POST /api/connectors', 'GET /api/connectors',
    'GET /api/connectors/incidents', 'GET /api/connectors/export',
    'POST /api/connectors/']) {
    assert.ok(seen.includes(r),
      `基线抽取器看不见这条路由：${r}（它看到的是：${seen.join('、') || '（无）'}）`)
  }
  // 用**常量**做路径守卫时抽取器会静默漏掉路由（PRT-507 的坑）。
  assert.deepEqual(findOpaqueRouteGuards(mod), [],
    'F-21 里出现了用常量做路径守卫的路由')
  // 正则守卫同样会让抽取器看不见 —— 在**模块**上从 F-21 标题切到末尾。
  const i = mod.indexOf('F-21 连接器登记表')
  assert.ok(i >= 0, '模块里找不到 F-21 的分段标题')
  const f21 = mod.slice(i)
  // ★ 切片长度自检：切片指错地方（或指到一个空区域）时，下面那条正则断言会**恒真**，
  //   于是"没有正则守卫"会以"检查了一个无关区域"的方式通过。
  assert.ok(f21.length > 1000, `F-21 区间只有 ${f21.length} 字符 —— 切片指错了地方`)
  assert.equal(/\/\^\\?\/api\//.test(f21), false, 'F-21 里出现了正则路由守卫')
})

// ══════════════════════════════════════════════════════════════════════════════
// ⑥ PRT-316 切片 12 的缝上契约（K3 K4 K5 K9 K11 K13）
// ⑥ PRT-316 切片 12：connectors 族搬进 `routes/connectors.mjs` 之后的**缝上契约**
//
// 破验 21 条，第一轮咬住 15 条、漏网 **6** 条。六条**全是真缺口**，而且集中在
// "**参数给了但没人验它真的被用上**"这一类：
//
//   K3  顶层 `body.version` —— 既有用例的 `version` 一律写在 `declaration` **里面**，
//       顶层那个从来没出现过 ⇒ **优先级**（顶层覆盖声明内）从未被验。
//   K4  顶层 `body.frozenAtMs` —— 从来没传过 ⇒ 那个 `Number.isInteger` 兜底没被验。
//   K5  列表的 `version` **过滤 `records`** —— 既有用例带 `version` 查询时
//       只断言 `registration.declaration`，`records` 只验过形状与条数。
//       ★ 这正是模块里那段长注释专门警告的坑（"静默给出另一版的答案"）。
//   K9  回显的 `scope` —— 断言过 `records`/`registration`/`counts`，唯独没断言 `scope`。
//   K11 incidents 的 `sinceSeq` —— 增量读只验过**登记**那一侧，**事件**那一侧没验。
//   K13 `decodeURIComponent` —— 既有用例的 id 全是纯字母数字，编码过的 id 一次没用过。
//
//   > 一个"收了参数并把它传下去"的路由，与一个"收了参数然后丢掉"的路由，
//   > 在没有用例问过那个参数的效果的时候，是同一个东西。
//
// ★ 与切片 11 的三条缺口**完全同族**（K6 空串、K8 严格布尔、K2 `table`），
//   也与切片 8/9/10 同族：**用例只喂过"刚刚好正确"的输入**。
//
// ★ 这六条全部走**真 HTTP**（本文件既有装置），不用替身 —— 它们验的都是
//   "这个参数到底有没有影响响应"，而这一点在真 hub 上最直接。
//   每条契约都用一个**全新的 connectorId**，因此与前面用例的库状态无关。
// ══════════════════════════════════════════════════════════════════════════════

// ---------------------------------------------------------------------------
// ⑥ ★★ 参数真的被用上了：顶层 version / 顶层 frozenAtMs / records 的 version 过滤
// ---------------------------------------------------------------------------

test('⑥ ★★ K3：顶层 `version` **覆盖**声明内的 version（优先级，不是"二选一"）', async () => {
  // ★ 真行为差异：store 里是 `version: version ?? declaration?.version`
  //   ⇒ 顶层给了就用顶层。既有用例的 version 一律写在 declaration 里面，
  //   于是"顶层覆盖声明内"这条优先级**从来没有被喂过一次**。
  const r = await call('POST', '/api/connectors', {
    version: '3.0.0',
    declaration: decl({ connectorId: 'bitbucket', version: '1.0.0' }),
  })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.json.version, '3.0.0', '顶层 version 没有覆盖声明内的 version')
  // 而且它真的**按 3.0.0 存进去了**（不是只在响应里改了个字）。
  const hit = await call('GET', '/api/connectors?connectorId=bitbucket&version=3.0.0')
  assert.equal(hit.json.registration?.version, '3.0.0')
  assert.equal(hit.json.registration.declaration.tools.length, 2)
  // 声明里那个 1.0.0 **不该**同时也被冻一份。
  const miss = await call('GET', '/api/connectors?connectorId=bitbucket&version=1.0.0')
  assert.equal(miss.json.registration, null, '声明内的旧 version 也被冻了一份（优先级没生效）')
  // 不传顶层 version ⇒ 回落到声明内的 version（这条既有用例覆盖了，一并钉住）。
  const fallback = await call('POST', '/api/connectors', {
    declaration: decl({ connectorId: 'bitbucket2', version: '4.0.0' }),
  })
  assert.equal(fallback.json.version, '4.0.0', '不传顶层 version 时没有回落到声明内的 version')
})

test('⑥ ★★ K4：顶层 `frozenAtMs` 只接受**整数**，其余一律回落到"现在"', async () => {
  // ★ 真行为差异：路由是 `Number.isInteger(body.frozenAtMs) ? body.frozenAtMs : Date.now()`。
  //   既有用例从来没传过 `frozenAtMs` ⇒ 这个兜底没被验。
  //   （store 的签名有 `frozenAtMs = Date.now()` 默认值，但它**只对 `undefined` 生效**：
  //    非整数的值会一路落库，`INTEGER` 列存不下就退化成 REAL/TEXT，
  //    于是响应里的 `frozenAtMs` 变成一个 1.5 或 NaN。）
  const NOW_LO = Date.parse('2026-01-01T00:00:00Z')

  // ① 整数：**必须被原样采纳**（这是这个参数存在的理由——回填历史冻结时刻）。
  const stamped = 1750000000000
  const a = await call('POST', '/api/connectors', {
    declaration: decl({ connectorId: 'conn-at' }), frozenAtMs: stamped,
  })
  assert.equal(a.status, 200, a.text)
  assert.equal(a.json.frozenAtMs, stamped, '整数 frozenAtMs 没有被原样采纳')

  // ② 非整数 / 非数字：必须回落到"现在"，**不许**把那个值落库。
  //   （`NaN` 不放进来：`JSON.stringify(NaN)` 就是 `null`，与下一项是同一个用例，
  //    放两个会让人以为"NaN 也验过了"。）
  for (const bad of [1.5, 'abc', null, true]) {
    const id = `conn-bad-at-${String(bad)}`
    const r = await call('POST', '/api/connectors', {
      declaration: decl({ connectorId: id }), frozenAtMs: bad,
    })
    assert.equal(r.status, 200, `${JSON.stringify(bad)}：${r.text}`)
    assert.equal(Number.isInteger(r.json.frozenAtMs), true,
      `frozenAtMs=${JSON.stringify(bad)} 被原样落库了（值=${r.json.frozenAtMs}）`)
    assert.equal(r.json.frozenAtMs > NOW_LO, true,
      `frozenAtMs=${JSON.stringify(bad)} 没有回落到"现在"（值=${r.json.frozenAtMs}）`)
  }
})

test('⑥ ★★★ K5：列表的 `version` 必须过滤 `records`，不只是 `registration`', async () => {
  // ★★ 模块里那段长注释讲的正是这件事：
  //   > "不传 version = 最新"这条默认**静默地覆盖了每一次带版本的查询 ——
  //   > 调用方问"1.0.0 当时放行了哪些工具"，拿回的是 2.0.0 的工具清单——**
  //   > 答案来自另一版，而响应里没有任何地方提示这件事**。
  //   既有用例带 `version` 查询时只看 `registration.declaration`，
  //   于是 `records` 那一侧的同样一处过滤**从来没有被问过**。
  const id = 'conn-versions'
  const one = decl({
    connectorId: id, version: '1.0.0',
    tools: [{ name: 'a', capabilities: ['x:read'], risk: 'low', policy: 'allow' }],
  })
  const two = decl({
    connectorId: id, version: '2.0.0',
    tools: [{ name: 'b', capabilities: ['y:read'], risk: 'low', policy: 'allow' }],
  })
  assert.equal((await call('POST', '/api/connectors', { declaration: one })).status, 200)
  assert.equal((await call('POST', '/api/connectors', { declaration: two })).status, 200)

  const v1 = await call('GET', `/api/connectors?connectorId=${id}&version=1.0.0`)
  assert.equal(v1.json.records.length, 1, `version=1.0.0 的 records 应当是 1 条（实际 ${v1.json.records.length}）`)
  assert.equal(v1.json.records[0].version, '1.0.0', 'records 里混进了别的版本')
  assert.equal(v1.json.records[0].declaration.tools[0].name, 'a',
    '★ records 给的是另一版的工具清单（正是那段注释警告的形状）')

  const v2 = await call('GET', `/api/connectors?connectorId=${id}&version=2.0.0`)
  assert.equal(v2.json.records.length, 1)
  assert.equal(v2.json.records[0].declaration.tools[0].name, 'b')

  // 每条记录的 version 都必须**等于**问的那个（不是"包含"）。
  for (const want of ['1.0.0', '2.0.0']) {
    const got = await call('GET', `/api/connectors?connectorId=${id}&version=${want}`)
    assert.equal(got.json.records.every((r) => r.version === want), true,
      `version=${want} 的 records 里有别的版本：${got.json.records.map((r) => r.version).join('、')}`)
  }
  // 不传 version ⇒ 两版都在（过滤只在带 version 时发生）。
  const both = await call('GET', `/api/connectors?connectorId=${id}`)
  assert.equal(both.json.records.length, 2, '不传 version 时应当两版都回')
})

test('⑥ ★ K9：回显的 `scope` 必须等于问的那个（否则调用方读的不是自己以为的那一格）', async () => {
  // ★ 真行为差异：`scope` 是"读的是哪一格"的唯一凭据。既有用例断言过
  //   `records`/`registration`/`counts` 的形状，唯独没断言过 `scope` 本身。
  //   一条丢了 `scope` 的响应，与一条读了别的 scope 的响应，在调用方是同一个东西。
  const def = await call('GET', '/api/connectors')
  assert.equal(def.json.scope, 'default', '不传 scope 时没有回显 default')

  const named = await call('GET', '/api/connectors?scope=teamA')
  assert.equal(named.json.scope, 'teamA', 'scope 没有被回显')
  assert.deepEqual(named.json.records, [], 'teamA 这一格应当是空的（隔离）')
  assert.equal(named.json.counts.registrations, 0, 'teamA 的 counts 不是 0（scope 没有真的隔离）')

  // 而且它真的**读**的是那一格：往 teamB 冻一份，teamA 与 default 都看不见。
  // ★ 注意 `scope` 在**写面**是从 **body** 读的（不是 query），列表才从 query 读
  //   —— 我第一版把 `?scope=teamB` 挂在 POST 的 URL 上，于是它落进了 default，
  //   而下面那条"teamA 里没有"的断言**照样是绿的**（因为 teamA 本来就一直是空的）。
  const r = await call('POST', '/api/connectors', {
    scope: 'teamB', declaration: decl({ connectorId: 'conn-scoped' }),
  })
  assert.equal(r.status, 200, r.text)
  const b = await call('GET', '/api/connectors?scope=teamB')
  assert.equal(b.json.scope, 'teamB')
  assert.equal(b.json.records.length, 1, 'teamB 那一份没有落进 teamB（写面的 scope 没被用上）')
  assert.equal((await call('GET', '/api/connectors?scope=teamA')).json.records.length, 0,
    'teamB 的那一份出现在 teamA 里（scope 没有隔离）')
  assert.equal((await call('GET', '/api/connectors')).json.scope, 'default')
})

// ---------------------------------------------------------------------------
// ⑥ ★★ 事件面的两个参数：incidents 的 sinceSeq 与 id 的解码
// ---------------------------------------------------------------------------

test('⑥ ★★ K11：**事件**面的 `sinceSeq` 增量读（既有用例只验过登记那一侧）', async () => {
  // ★ 真行为差异：`/api/connectors/incidents` 也接了 `sinceSeq`，
  //   而既有用例的增量读只喂过 `/api/connectors`（登记）。
  //   一个"事件面也支持增量"的实现，与一个"事件面接了参数但丢掉"的实现，
  //   在没有用例问过事件面的 seq 时，是同一个东西。
  const id = 'conn-incidents-seq'
  // ★ 词表以 store 为权威：`kind` ∈ {circuit-opened, circuit-closed}，
  //   `circuitState` ∈ {closed, open, half-open}（**连字符**，不是下划线）。
  //   我第一版写的是 `circuit_open` / `circuit_half_open` —— 照"我以为的词表"写的，
  //   与"照着真实词表"写的，在**它通过**的时候是同一个东西（第四族栽在同一处）。
  const ev = (atMs, kind, circuitState) => ({
    scope: 'default', connectorId: id, kind, circuitState, atMs, reason: null, actor: null,
  })
  const first = await call('POST', `/api/connectors/${id}/incidents`, ev(1750000001000, 'circuit-opened', 'open'))
  assert.equal(first.status, 200, first.text)
  assert.equal(Number.isInteger(first.json.seq), true, '事件响应里没有 seq（增量读无从下手）')
  const second = await call('POST', `/api/connectors/${id}/incidents`, ev(1750000002000, 'circuit-closed', 'half-open'))
  assert.equal(second.status, 200, second.text)

  const all = await call('GET', `/api/connectors/incidents?connectorId=${id}`)
  assert.equal(all.json.records.length, 2, `事件应当有 2 条（实际 ${all.json.records.length}）`)

  const after = await call('GET', `/api/connectors/incidents?connectorId=${id}&sinceSeq=${first.json.seq}`)
  assert.equal(after.json.records.every((r) => r.seq > first.json.seq), true,
    'sinceSeq 没有被用上（回的是全量）')
  assert.equal(after.json.records.length, 1, `sinceSeq 之后应当只剩 1 条（实际 ${after.json.records.length}）`)
  assert.equal(after.json.records[0].seq, second.json.seq)

  // `sinceSeq` 必须真的是**整数**参数（非整数按 0 处理，不是当成一个真边界）。
  const junk = await call('GET', `/api/connectors/incidents?connectorId=${id}&sinceSeq=abc`)
  assert.equal(junk.json.records.length, 2, '非整数 sinceSeq 没有被当成 0（读到的不是全量）')
})

test('⑥ ★★ K13：事件路由的 id 会做 `decodeURIComponent`（编码过的 id 也要能对上）', async () => {
  // ★ 真行为差异：`rawId` 从 **path** 里切出来之后要解码。
  //   既有用例的 id 全是纯字母数字，**编码过的 id 一次都没用过**。
  //   不解码时事件会记到 `conn-dec%6Fde` 名下，而按 `conn-decode` 查是查不到的
  //   —— 就是模块注释里那句"两处各归一化一次"的同形失败：
  //   **记下了，但按真名读不回来。**
  //
  //   ★ 我第一版把 `encoded` 算出来了、却拿 `id` 去发请求，于是这条用例
  //     在"代码不解码"的实现上**也是绿的** —— 一条自己没用到那个前提的用例，
  //     与一条前提根本不成立的用例，在它通过的时候是同一个东西。
  const id = 'conn-decode'
  const encoded = encodeURIComponent(id).replace('o', '%6F') // conn-dec%6Fde
  assert.notEqual(encoded, id, '这个前提不成立：编码后的 id 与原文相同')
  assert.equal(decodeURIComponent(encoded), id, '这个字面量的前提变了')

  const r = await call('POST', `/api/connectors/${encoded}/incidents`, {
    kind: 'circuit-opened', circuitState: 'open', atMs: 1750000003000,
  })
  assert.equal(r.status, 200, r.text)
  // ① 按**解码后**的 id 必须查得到（这是"解码了"的判据）。
  const byDecoded = await call('GET', `/api/connectors/incidents?connectorId=${id}`)
  assert.equal(byDecoded.json.records.length, 1, '事件没有被记到解码后的 id 名下')
  assert.equal(byDecoded.json.records[0].connectorId, id, '记录里的 connectorId 不是解码后的')
  // ② 而按**编码形式**查必须查不到（否则说明两条 id 各自记了一份，那就不是解码、是两份）。
  const byEncoded = await call('GET', `/api/connectors/incidents?connectorId=${encodeURIComponent(encoded)}`)
  assert.equal(byEncoded.json.records.length, 0,
    '同一个连接器在编码 id 与解码 id 下各记了一份 —— 解码只做了一半')
  // ③ 再从**原文**那条路径记一条，两条必须落到同一个 id 下。
  const r2 = await call('POST', `/api/connectors/${id}/incidents`, {
    kind: 'circuit-closed', circuitState: 'half-open', atMs: 1750000004000,
  })
  assert.equal(r2.status, 200, r2.text)
  const after = await call('GET', `/api/connectors/incidents?connectorId=${id}`)
  assert.equal(after.json.records.length, 2, '两条事件没有落到同一个 id 下')
  assert.equal(after.json.records.every((x) => x.connectorId === id), true)
})
