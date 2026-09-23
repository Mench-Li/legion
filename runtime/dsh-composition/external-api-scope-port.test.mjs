// runtime/dsh-composition/external-api-scope-port.test.mjs
// ============================================================================
// PRT-606 的端口：外部 API 授权表 → 读/写检查。
//
// ## 本套件最要紧的两条（④a / ④b）
//
// 端口的职责是"把 URL 拆成 host + path + query"给 `checkExternalApi`。而**怎么拆**
// 决定了 `external-api-scope.mjs` 那 24 例里的三条检查是"会触发"还是"从不触发"。
//
// 本批实测：用 `new URL()` 拆，两条**真的**从不触发——
//
//   · `u.hostname` 把 `https://api.example.com:8443/v1` 读成 `api.example.com`
//     ⇒ `HOST_HAS_PORT` 从不触发；
//   · `u.pathname` 把 `/api/items/../admin` 读成 `/api/admin`
//     ⇒ `PATH_ESCAPE` 从不触发。
//
// ⇒ ④a / ④b 就是那两条的**反向读数**。它们红的方式很特殊：
//   端口若退回 `new URL()`，这两条会变成 `ENDPOINT_NOT_GRANTED`（"不匹配任何端点"）
//   ——**方向仍然是拒**，所以一个只看 `allowed === false` 的用例**抓不到它**。
//   因此这里断言的是**码**，不是 `allowed`。
//
//   > 一个「只看 allowed 是不是 false」的用例，
//   > 与一个「分不清"端口与 userinfo 没被检查"与"这个端点没被授权"」的用例，
//   > 是同一个东西——只不过前者在适配器退回解析器之后**照样是绿的**。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  EXTERNAL_API_SCOPE_PORT_CODES,
  EXTERNAL_API_SCOPE_PORT_ENV_KEY,
  EXTERNAL_API_SCOPE_PORT_ENV_KEYS,
  EXTERNAL_API_SCOPE_PORT_STATES,
  EXTERNAL_API_SCOPE_PORT_VERSION,
  createExternalApiScopePort,
  externalApiScopePortFromEnv,
  splitRawPathAndQuery,
} from './external-api-scope-port.mjs'
import { API_CODES, EXTERNAL_API_SCOPE_VERSION } from './external-api-scope.mjs'
import { EXECUTION_SCOPE_PORT_VERSION } from './execution-scope-port.mjs'
import { deriveScopeFacts } from './scope-facts.mjs'

// ── 夹具 ────────────────────────────────────────────────────────────────────

/**
 * 一份合法的授权表：`api.example.com` 上 `/api/items/{id}` 只读。
 *
 * ★ `riskClass` **不写**：它是一个**封闭的高风险词表**（`publish`/`payment`/`delete`/
 *   `credential`/`permission`/`transfer`），"低风险"的表达方式就是**省略**它。
 *   第一版我写了 `riskClass: 'low'`，装载期直接拒——
 *   *一个"低风险也是个类别"的印象，与一个"高风险必须被点名、而低风险是被省略"
 *   的闭集，在配置里看起来都像在描述风险等级。*
 */
const GRANT = Object.freeze({
  version: EXTERNAL_API_SCOPE_VERSION,
  schemes: ['https'], endpoints: Object.freeze([
    Object.freeze({
      host: 'api.example.com',
      pattern: '/api/items/{id}',
      effects: Object.freeze(['read']),
      idempotent: true,
    }),
  ]),
})

/** 走**投影**那条路造事实：与生产里完全同一条链（`deriveScopeFacts`）。 */
function projectionFor({ toolName = 'fetch-item', capabilities = ['external-api:read'], args }) {
  const facts = deriveScopeFacts({ capabilities, args, toolName })
  return Object.freeze({ scopeFacts: facts })
}

/** 断言一个裁决：`allowed` 与**码**都要对。 */
function expectDeny(verdict, code, why) {
  assert.equal(verdict.allowed, false, `${why}：本该拒绝，实际 ${JSON.stringify(verdict)}`)
  assert.equal(verdict.code, code, `${why}：码不对（${JSON.stringify(verdict.reason)}）`)
}

// ══════════════════════════════════════════════════════════════════════════
// ① 装配期：坏表当场抛，空表是合法的
// ══════════════════════════════════════════════════════════════════════════

test('① ★★★ 装配期就归一化：坏表**现在**抛，而"什么都不许"是合法的表', () => {
  // 坏表：没写 effects。"第一次调用时才炸"会把错误推迟到已经有副作用的那一刻。
  assert.throws(
    () => createExternalApiScopePort({ grant: { schemes: ['https'], endpoints: [{ host: 'h.example.com', pattern: '/x' }] } }),
    (err) => err.code === API_CODES.BAD_GRANT,
    '缺 effects 的表必须在**装配期**抛，而不是等第一次调用',
  )
  // 不认识的字段同样拒（一个多打的字母不该让整条限制静默失效）
  assert.throws(
    () => createExternalApiScopePort({ grant: { schemes: ['https'], endpoints: [], endpoitns: [] } }),
    (err) => err.code === API_CODES.BAD_GRANT,
  )
  // ★ 反向对照：`endpoints: []` 是**合法**的表——"这个岗位什么外部 API 都不许调"
  //   必须配得出来，否则那条授权形态根本表达不了。
  const port = createExternalApiScopePort({ grant: { schemes: ['https'], endpoints: [] } })
  const v = port(projectionFor({ args: { url: 'https://api.example.com/api/items/1' } }))
  expectDeny(v, API_CODES.ENDPOINT_NOT_GRANTED, '空授权表 ⇒ 任何端点都不匹配')
})

// ══════════════════════════════════════════════════════════════════════════
// ② ★★★ 端口**只读** projection.scopeFacts，不偷看 arguments
// ══════════════════════════════════════════════════════════════════════════

test('② ★★★ 端口**不读 arguments**：同一份 arguments，事实缺席时放行、有事实时拒', () => {
  // 这两条读数**必须成对**。只有一条时，"端口自己从 arguments 兜底"
  // 与"端口只读事实"在大多数夹具上是同一个读数。
  const port = createExternalApiScopePort({ grant: GRANT })
  const args = { url: 'https://evil.example.com/api/items/1' }

  // ②a 事实缺席 ⇒ 放行。★ 注意 arguments 里明明白白躺着一个**未被授权**的 URL。
  const without = port(Object.freeze({ scopeFacts: null, arguments: Object.freeze(args) }))
  assert.equal(without.allowed, true,
    'scopeFacts 是 null 时必须放行——端口若在这里读 arguments 自己兜底，'
    + '就意味着"事实只算一次"那条纪律在端口这一层被破坏了')

  // ②b 补上同一份 facts ⇒ 立刻拒。
  const withFacts = port(Object.freeze({
    scopeFacts: deriveScopeFacts({ capabilities: ['external-api:read'], args, toolName: 'fetch-item' }),
    arguments: Object.freeze(args),
  }))
  expectDeny(withFacts, API_CODES.ENDPOINT_NOT_GRANTED, '有事实时未被授权的 host 必须拒')

  // ②c 两份读数的**差别只能来自 facts**：两次调用传的 arguments 逐字相同。
  assert.notEqual(without.allowed, withFacts.allowed,
    '同一份 arguments 必须给出两个不同结论——否则 ②a 是空的')
})

// ══════════════════════════════════════════════════════════════════════════
// ③ 能力说这一类、事实里没有 ⇒ 拒（fail closed）
// ══════════════════════════════════════════════════════════════════════════

test('③ ★★ 能力里有 external-api、而事实缺席 ⇒ NO_FACTS；有项但没 url ⇒ NO_URL', () => {
  const port = createExternalApiScopePort({ grant: GRANT })

  // 能力说是外部 API 调用，而 facts 里连 external-api 类别都没有
  // （构造一个"接线坏了"的投影：kinds 说 external-api，项却不在）。
  expectDeny(
    port(Object.freeze({ scopeFacts: Object.freeze({ kinds: Object.freeze(['external-api']) }) })),
    EXTERNAL_API_SCOPE_PORT_CODES.NO_FACTS,
    'kinds 说了这一类而项缺席 ⇒ 证明不了它要访问哪，不能读成"与外部 API 无关"',
  )

  // 有 externalApi 项，而 url 是 null（能力说是外部 API 调用，工具这次没给地址）
  expectDeny(
    port(Object.freeze({
      scopeFacts: Object.freeze({
        kinds: Object.freeze(['external-api']),
        externalApi: Object.freeze({ url: null, method: null }),
      }),
    })),
    EXTERNAL_API_SCOPE_PORT_CODES.NO_URL,
    '★ "没给地址"与"给了个看不懂的地址"必须分开——修复动作不同',
  )
})

// ══════════════════════════════════════════════════════════════════════════
// ④ ★★★ 两个实测到的洞：URL **不许**交给解析器再取 host/path
// ══════════════════════════════════════════════════════════════════════════

test('④a ★★★ 端口**丢掉端口号** ⇒ 必须仍报 HOST_HAS_PORT（不是"端点不匹配"）', () => {
  const port = createExternalApiScopePort({ grant: GRANT })
  // `new URL('https://api.example.com:8443/api/items/1').hostname` === 'api.example.com'
  // ⇒ 若端口取 `parsed.host`，这次调用会被当成"命中 api.example.com 的读授权"而放行。
  const v = port(projectionFor({ args: { url: 'https://api.example.com:8443/api/items/1' } }))
  expectDeny(v, API_CODES.HOST_HAS_PORT,
    '★ 带端口的 authority 必须原样带给 normalizeHost。'
    + '若这里收到 ENDPOINT_NOT_GRANTED，说明适配器把端口摘掉了'
    + '（方向仍是拒，所以只看 allowed 的用例抓不到）')

  // ★ 正面对照：同一个 host、**不带**端口 ⇒ 命中授权，放行。
  //   少了这条，④a 无法区分"端口被正确拦了"与"这个 host 本来就不被授权"。
  const ok = port(projectionFor({ args: { url: 'https://api.example.com/api/items/1' } }))
  assert.equal(ok.allowed, true, `不带端口的同一请求应当放行（理由：${ok.reason}）`)
})

test('④b ★★★ 端口让解析器**折叠 `..`** ⇒ 必须仍报 PATH_ESCAPE（不是"端点不匹配"）', () => {
  const port = createExternalApiScopePort({ grant: GRANT })
  // `new URL('https://api.example.com/api/items/../admin').pathname` === '/api/admin'
  // ⇒ 若端口取 `parsed.path`，`..` 那条检查**从不触发**，而折叠后的路径
  //    还可能命中一条它本来不匹配的授权。
  const v = port(projectionFor({ args: { url: 'https://api.example.com/api/items/../admin' } }))
  expectDeny(v, API_CODES.PATH_ESCAPE,
    '★ 原始串上的 `..` 必须原样带给 normalizeUrlPath')
})

test('④c ★★ userinfo 混淆 ⇒ HOST_HAS_USERINFO（原始串上的 @ 不许被解析掉）', () => {
  const port = createExternalApiScopePort({ grant: GRANT })
  // `new URL('https://api.example.com@evil.com/x').hostname` === 'evil.com'
  const v = port(projectionFor({ args: { url: 'https://api.example.com@evil.com/api/items/1' } }))
  expectDeny(v, API_CODES.HOST_HAS_USERINFO,
    'userinfo 必须由 normalizeHost 具名拒——那是"一次 userinfo 混淆"而不是"一个没授权的 host"')
})

test('④d ★★ `splitRawPathAndQuery` 只切不改，且与 `parseEgressUrl` 的 authority 一致', async () => {
  // 它**不许**做任何规范化：这正是它存在的理由。
  assert.deepEqual(
    { ...splitRawPathAndQuery('https://api.example.com/api/items/../admin?x=1#f') },
    { path: '/api/items/../admin', query: 'x=1' },
    '★ 切出来的 path 必须逐字是原始串里的那一段（`..` 不许被折叠）',
  )
  // 省略路径 ⇒ 根路径，而不是空串（`normalizeUrlPath('')` 会报"路径非法"）
  assert.equal(splitRawPathAndQuery('https://api.example.com').path, '/',
    'URL 里省略路径是合法的根请求，不该被读成"路径非法"')
  assert.equal(splitRawPathAndQuery('https://api.example.com').query, '')
  // 没有 scheme://authority 的串 ⇒ 具名拒绝，而不是拆出一个莫名其妙的结果
  assert.throws(() => splitRawPathAndQuery('api.example.com/x'),
    (err) => err.code === EXTERNAL_API_SCOPE_PORT_CODES.BAD_URL)

  // ★★ 交叉核对：本模块切 authority 用的正则**不取** authority，
  //    所以 authority 只有一个来源（`parseEgressUrl`）。这条断言把"只有一个来源"
  //    钉成读数：如果哪天有人在这里补一个 authority 组，它就会红。
  const { parseEgressUrl } = await import('./execution-scope.mjs')
  for (const u of ['https://api.example.com:8443/v1', 'https://a@b.example.com/x',
    'https://api.example.com', 'http://例子.测试/x']) {
    const parsed = parseEgressUrl({ url: u })
    const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(u)
    assert.equal(parsed.rawAuthority, m[1],
      `authority 的两种取法在 ${u} 上不一致——那意味着有两个来源`)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// ⑤ query 必须**解码后**再判（手切会漏掉编码过的覆盖键）
// ══════════════════════════════════════════════════════════════════════════

test('⑤ ★★★ `?%6dethod=DELETE` 必须报 METHOD_OVERRIDE（手切 query 会漏掉它）', () => {
  const port = createExternalApiScopePort({ grant: GRANT })
  // ★ 手切（按 & 与 = 切）出来的键是 `%6dethod`，而 METHOD_OVERRIDE_KEYS 里
  //   只有 `method` ⇒ 那条"能覆盖方法的东西一律拒绝"的检查**从不触发**，
  //   于是这个 GET 会被按**读**判，而服务端执行的是 DELETE。
  const v = port(projectionFor({
    args: { url: 'https://api.example.com/api/items/1?%6dethod=DELETE' },
  }))
  expectDeny(v, API_CODES.METHOD_OVERRIDE,
    '★ query 必须先百分号解码再交给 collectOverrides')

  // 明文形态（对照：证明这条链本来就会拦，问题是"编码过的形态"）
  const plain = port(projectionFor({
    args: { url: 'https://api.example.com/api/items/1?_method=DELETE' },
  }))
  expectDeny(plain, API_CODES.METHOD_OVERRIDE, '明文覆盖键本来就该被拦')

  // `?action=delete`（读请求带动作名）
  const action = port(projectionFor({
    args: { url: 'https://api.example.com/api/items/1?action=delete' },
  }))
  expectDeny(action, API_CODES.ACTION_IN_QUERY, '读请求的 query 里带动作名')
})

test('⑤b ★★ 读请求带请求体 ⇒ READ_WITH_BODY（body 从事实表来）', () => {
  const port = createExternalApiScopePort({ grant: GRANT })
  const v = port(projectionFor({
    capabilities: ['external-api:read'],
    args: { url: 'https://api.example.com/api/items/1', body: { force: true } },
  }))
  expectDeny(v, API_CODES.READ_WITH_BODY, 'GET 带非空 body 是"读权限变成写"的一种')
})

// ══════════════════════════════════════════════════════════════════════════
// ⑥ 不是外部 API 的调用 ⇒ 无话可说（唯一的放行分支）
// ══════════════════════════════════════════════════════════════════════════

test('⑥ ★★ 别的类别（command / network / mcp）与"没有执行面事实"都放行', () => {
  const port = createExternalApiScopePort({ grant: GRANT })
  // 普通文件工具：根本没有 scopeFacts
  assert.equal(port(projectionFor({ capabilities: ['file:read'], args: { path: 'C:/x' } })).allowed, true)
  // `network:read` 是 executionScopePort 管的（checkNetwork），本端口不管
  const net = projectionFor({ capabilities: ['network:read'], args: { url: 'https://evil.example.com/x' } })
  assert.equal(net.scopeFacts.kinds.includes('network'), true, '载具：这必须是 network 类')
  assert.equal(net.scopeFacts.kinds.includes('external-api'), false, '载具：network 类**不是** external-api 类')
  assert.equal(port(net).allowed, true,
    '本端口对 network 类的读数是"无话可说"——那一道由 executionScopePort 负责')
  // 命令类同理
  const cmd = projectionFor({ capabilities: ['command:exec'], args: { argv: ['rm', '-rf', '/'] } })
  assert.equal(port(cmd).allowed, true, '命令类由 executionScopePort 负责')
})

// ══════════════════════════════════════════════════════════════════════════
// ⑦ 判定器抛异常 ⇒ 拒（带码），不把强制面炸掉、也不变成放行
// ══════════════════════════════════════════════════════════════════════════

test('⑦ ★★★ 判定器抛异常 ⇒ 拒绝并带码（既不炸掉强制面，也不放行）', () => {
  const port = createExternalApiScopePort({ grant: GRANT })
  // 不认识的 HTTP 方法：`effectOfMethod` 抛 `UNKNOWN_METHOD`，
  // 而 `checkExternalApi` 会把它**接住**并返回 `{allowed:false, code}`。
  const v = port(projectionFor({
    args: { url: 'https://api.example.com/api/items/1', method: 'UPLOAD' },
  }))
  expectDeny(v, API_CODES.UNKNOWN_METHOD, '不认识的方法不许"默认按读处理"（那是放行方向）')

  // ★ 而"端口自己抛"那一支（`checkExternalApi` 真的炸了）也要有读数：
  //   用一个**坏投影**去触发——kinds 说 external-api，而 externalApi 不是对象。
  const broken = port(Object.freeze({
    scopeFacts: Object.freeze({
      kinds: Object.freeze(['external-api']),
      externalApi: Object.freeze({ url: 'https://api.example.com/x', method: 'GET', headers: 'not-an-object' }),
    }),
  }))
  // `headers` 被端口主动降级成 `{}`（`isPlainObject` 守卫），所以这一条**不会**炸；
  // 它落到"端点不匹配"。这条断言把"端口对坏 headers 的处置"钉成读数。
  expectDeny(broken, API_CODES.ENDPOINT_NOT_GRANTED,
    '坏 headers 不该让端口炸掉；它只该让这次调用判不过')
})

// ══════════════════════════════════════════════════════════════════════════
// ⑧ 环境侧：缺席如实记 absent、配了却解释不通 ⇒ 抛
// ══════════════════════════════════════════════════════════════════════════

test('⑧ ★★ env 侧三态：缺席 ⇒ absent/port:null；坏文本 ⇒ 抛；配好 ⇒ configured', () => {
  const absent = externalApiScopePortFromEnv({ env: {} })
  assert.equal(absent.state, EXTERNAL_API_SCOPE_PORT_STATES.ABSENT)
  assert.equal(absent.port, null, '★ 缺席时端口是 null——组合根那一格才会如实报 false')
  assert.equal(absent.grant, null)
  assert.match(absent.reason, new RegExp(EXTERNAL_API_SCOPE_PORT_ENV_KEY),
    '缺席的理由要点名那个键，否则值班的人不知道该配什么')

  // 空串按缺席（与另两个端口同一条口径）
  assert.equal(externalApiScopePortFromEnv({ env: { [EXTERNAL_API_SCOPE_PORT_ENV_KEY]: '  ' } }).state,
    EXTERNAL_API_SCOPE_PORT_STATES.ABSENT)

  // ★ 配了却解释不通 ⇒ **抛**。一个被静默丢掉的授权表，与一张什么都没限制的，读数一样。
  assert.throws(
    () => externalApiScopePortFromEnv({ env: { [EXTERNAL_API_SCOPE_PORT_ENV_KEY]: '{ not json' } }),
    (err) => err.code === EXTERNAL_API_SCOPE_PORT_CODES.BAD_TABLE_TEXT,
  )
  // 合法 JSON 但不是一份合法授权表 ⇒ 也抛（归一化在装配期跑）
  assert.throws(
    () => externalApiScopePortFromEnv({ env: { [EXTERNAL_API_SCOPE_PORT_ENV_KEY]: '{"endpoints":[{}]}' } }),
    (err) => err.code === API_CODES.BAD_GRANT,
  )

  // 配好 ⇒ configured，且端口真的能判
  const good = externalApiScopePortFromEnv({
    env: { [EXTERNAL_API_SCOPE_PORT_ENV_KEY]: JSON.stringify(GRANT) },
  })
  assert.equal(good.state, EXTERNAL_API_SCOPE_PORT_STATES.CONFIGURED)
  assert.equal(typeof good.port, 'function')
  assert.equal(good.port(projectionFor({ args: { url: 'https://api.example.com/api/items/1' } })).allowed, true)
  expectDeny(
    good.port(projectionFor({ args: { url: 'https://api.example.com/api/other/1' } })),
    API_CODES.ENDPOINT_NOT_GRANTED,
    '配好的端口必须真的在判',
  )
  // 非对象 env ⇒ 具名拒
  assert.throws(() => externalApiScopePortFromEnv({ env: null }),
    (err) => err.code === EXTERNAL_API_SCOPE_PORT_CODES.BAD_INPUT)
})

// ══════════════════════════════════════════════════════════════════════════
// ⑨ 版本与键导出（记账用）
// ══════════════════════════════════════════════════════════════════════════

test('⑨ ★ 版本常量与 env 键都导出，且三个端口的版本互不相同', () => {
  assert.equal(EXTERNAL_API_SCOPE_PORT_VERSION, 'legion/external-api-scope-port@1')
  assert.deepEqual([...EXTERNAL_API_SCOPE_PORT_ENV_KEYS], [EXTERNAL_API_SCOPE_PORT_ENV_KEY])
  assert.equal(EXTERNAL_API_SCOPE_PORT_ENV_KEY, 'LEGION_EXTERNAL_API_SCOPE')
  // ★ 与"判定器"的版本**有意不同**：一个是表的版本，一个是端口的版本。
  assert.notEqual(EXTERNAL_API_SCOPE_PORT_VERSION, EXTERNAL_API_SCOPE_VERSION,
    '端口与判定器的版本不该相等——它们的兼容性是两件事')
  // 三个端口的版本互不相同（一个"全都叫同一个版本"的写法会让记账失去意义）
  assert.notEqual(EXTERNAL_API_SCOPE_PORT_VERSION, EXECUTION_SCOPE_PORT_VERSION)
})

// ══════════════════════════════════════════════════════════════════════════
// ⑩ ★★★ 三个端口长得一样，而"归一化器幂等吗"这件事一个字都没写
// ══════════════════════════════════════════════════════════════════════════

test('⑩ ★★★ `normalizeApiGrant` **不幂等**（它在端点上挂派生字段 `parsed`）——这条是本批实测出来的', async () => {
  const { normalizeApiGrant } = await import('./external-api-scope.mjs')
  const { normalizeGrant } = await import('./execution-scope.mjs')

  const raw = {
    schemes: ['https'], endpoints: [{ host: 'h.example.com', pattern: '/x', effects: ['read'], idempotent: true }],
  }
  const once = normalizeApiGrant(raw)
  // ★ 派生字段：`parsed` 是**算出来的**，而它不在 `ENDPOINT_FIELDS` 里。
  assert.equal(once.endpoints[0].parsed !== undefined, true,
    '载具：归一化后的端点带着派生字段 parsed——这正是"再归一化一次会抛"的原因')
  assert.throws(() => normalizeApiGrant(once),
    (err) => err.code === API_CODES.BAD_GRANT,
    '★ 把已归一化的表再喂一次必须抛（`parsed` 不在 ENDPOINT_FIELDS 里）')

  // ★ 而 PRT-605 那一份**是**幂等的——两边的差别就是本套件 ⑧ 那次红的根因。
  const g1 = normalizeGrant({})
  assert.doesNotThrow(() => normalizeGrant(g1),
    'normalizeGrant 是幂等的：三个端口"归一化两次"的同一段接线，在它这里是绿的')

  // ★★ 所以"三个端口长得一样"这件事本身是个陷阱：
  //    `fromEnv` 归一化一次、`create*Port` 再归一化一次——在 PRT-604/605 上是绿的，
  //    在 PRT-606 上是**装配期就抛**。本套件 ⑧ 的 configured 那一支就是那个读数。
  assert.throws(
    () => createExternalApiScopePort({ grant: once }),
    (err) => err.code === API_CODES.BAD_GRANT,
    '把已归一化的表交给端口也必须抛——所以 fromEnv 只能传**原始**声明',
  )
})

// ══════════════════════════════════════════════════════════════════════════
// ⑭ ★★★ 第 26 条裁决「管 scheme」的**端到端**读数：协议从 URL 一路走到判定器
// ══════════════════════════════════════════════════════════════════════════

test('⑭ ★★★ `ftp://` / `http://` 对一份 https-only 的表一律拒（同一 host、同一条路径）', () => {
  // 缺陷的原读数（§5 第 26 条）：判定器**完全不看 scheme** ⇒ 只要 host 与路径匹配，
  // `ftp://api.example.com/api/items/1` 会按 `https://…` 的授权**放行**。
  // 本用例钉住那条链的两端：URL 的协议必须一路走到判定器。
  const port = createExternalApiScopePort({ grant: GRANT })
  const at = (p, url) => p(Object.freeze({
    scopeFacts: deriveScopeFacts({
      capabilities: ['external-api:read'], args: { url }, toolName: 'fetch-item',
    }),
    arguments: Object.freeze({ url }),
  }))

  // 正对照：`GRANT` 的端点就是 `https://api.example.com/api/items/{id}`
  assert.equal(at(port, 'https://api.example.com/api/items/1').allowed, true,
    '正对照失败——那下面的"拒"什么也证明不了')

  for (const url of ['http://api.example.com/api/items/1', 'ftp://api.example.com/api/items/1']) {
    expectDeny(
      at(port, url),
      API_CODES.SCHEME_NOT_GRANTED,
      `${url} 与那条 https 授权只差协议，必须拒，而且拒因要具名是协议问题`,
    )
  }

  // ★ 而"表里声明了 http"之后同一个 URL 就放行 ⇒ 证明拒的依据是**表**，不是硬编码。
  //   ★ 传的是**原始声明**：`createExternalApiScopePort` 自己会归一化一次，
  //     喂一份已经归一化的表进去会抛（见本套件 ⑬——`parsed` 不在 ENDPOINT_FIELDS 里）。
  const both = createExternalApiScopePort({
    grant: {
      version: EXTERNAL_API_SCOPE_VERSION,
      schemes: ['https', 'http'],
      endpoints: [{ host: 'api.example.com', pattern: '/api/items/{id}', effects: ['read'], idempotent: true }],
    },
  })
  assert.equal(at(both, 'http://api.example.com/api/items/1').allowed, true,
    '白名单里声明了 http，却还是拒 ⇒ 判据可能是硬编码的')
})
