// runtime/dsh-composition/external-api-scope.test.mjs
// ============================================================================
// 判据：PRT-606 区分外部 API 读取与写入权限
//
// spec line 928 / §6.6 line 465「外部 API 读取与写入」/ line 466「发布、付款、删除等
// 高风险动作」/ line 944「未批准高风险写操作为零」。
//
// 本模块要防的不是"权限表写错了"，而是**一串"看起来是读"的东西**：
//
//   一个「只看请求行上的 method」的检查，
//   与一个「GET + X-HTTP-Method-Override: DELETE 真的删掉了」的检查，是同一个东西。
//
// 所以用例的重点是"读权限在哪些形态下变成写"，而不是"读权限能不能用"。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  API_CODES,
  EXTERNAL_API_SCOPE_VERSION,
  EXTERNAL_API_SCOPE_CHECKED,
  ACTION_QUERY_KEYS,
  DRY_RUN_KEYS,
  METHOD_OVERRIDE_KEYS,
  RISK_CLASSES,
  assertEveryCodeIsEmitted,
  canonicizeApiCall,
  checkExternalApi,
  classifyEffect,
  effectOfMethod,
  isEmptyBody,
  matchEndpoint,
  normalizeApiGrant,
  normalizeHost,
  normalizeUrlPath,
  parseEndpointPattern,
  percentDecodeOnce,
} from './external-api-scope.mjs'

// 用来做"这一类复用本身就是错的"的对照（见 ⑯）
import { normalizeForCompare } from './path-scope.mjs'

const V = EXTERNAL_API_SCOPE_VERSION
const H = 'api.example.com'

const grantOf = (endpoints, version = V) => normalizeApiGrant({ version, endpoints })

const readGrant = grantOf([{ host: H, pattern: '/api/items', effects: ['read'] }])

const verdict = (request, grant = readGrant, extra = {}) => checkExternalApi({ request, grant, ...extra })

// ============================================================ ① 读 → 写

test('① ★★ 一次读授权在七种形态下都不能变成写', () => {
  //   > 一个「允许读就顺带允许写」的端点表，
  //   > 与一个「读和写是同一个权限」的端点表，是同一个东西。
  //   > 而这正是 PRT-606 要区分的那件事。
  const cases = [
    { label: '纯读（唯一的允许）', request: { method: 'GET', path: '/api/items', host: H }, expect: 'allow' },
    { label: '写方法打读端点', request: { method: 'POST', path: '/api/items', host: H, body: {} }, expect: API_CODES.EFFECT_MISMATCH },
    { label: '方法覆盖头', request: { method: 'GET', path: '/api/items', host: H, headers: { 'X-HTTP-Method-Override': 'DELETE' } }, expect: API_CODES.METHOD_OVERRIDE },
    { label: '方法覆盖参数', request: { method: 'GET', path: '/api/items', host: H, query: { _method: 'DELETE' } }, expect: API_CODES.METHOD_OVERRIDE },
    { label: '读带 body', request: { method: 'GET', path: '/api/items', host: H, body: { a: 1 } }, expect: API_CODES.READ_WITH_BODY },
    { label: '动作写在 query 里', request: { method: 'GET', path: '/api/items', host: H, query: { action: 'delete' } }, expect: API_CODES.ACTION_IN_QUERY },
    { label: '动作写在 path 里（从不进 query）', request: { method: 'GET', path: '/api/items?action=delete', host: H }, expect: API_CODES.PATH_HAS_QUERY },
    { label: '编码斜杠制造第二段', request: { method: 'GET', path: '/api/items%2F1', host: H }, expect: API_CODES.ENDPOINT_NOT_GRANTED },
  ]
  for (const c of cases) {
    const v = verdict(c.request)
    assert.equal(v.allowed ? 'allow' : v.code, c.expect, c.label)
  }
  // ★ 而"解出来就是被授权的那条"必须仍然允许——否则这道门禁会拒绝正常调用，
  //   然后被绕过：
  //     > 一个「把正常调用也拒掉」的门禁，
  //     > 与一个「所有人都在绕它」的门禁，是同一个东西。
  assert.equal(verdict({ method: 'GET', path: '/%61pi/items', host: H }).allowed, true, '百分号编码的同一端点')
  assert.equal(verdict({ method: 'HEAD', path: '/api/items', host: H }).allowed, true, 'HEAD 是读')
  assert.equal(verdict({ method: 'OPTIONS', path: '/api/items', host: H }).allowed, true, 'OPTIONS 是读')
  // 加载自检的结论必须与上面的手写用例一致
  assert.deepEqual(EXTERNAL_API_SCOPE_CHECKED.readNeverBecomesWrite.mismatched, [])
})

test('① ★★ 读权限被拒时**仍要**把 effect 报出来（审计要知道这是读还是写）', () => {
  const v = verdict({ method: 'POST', path: '/api/items', host: H, body: {} })
  assert.equal(v.allowed, false)
  assert.equal(v.code, API_CODES.EFFECT_MISMATCH)
  assert.equal(v.effect, 'write')
  assert.match(v.reason, /只授权了/)
  assert.match(v.reason, /写/)
  // 而且理由里要出现那个端点的模式，值班的人才不用猜
  assert.match(v.reason, /\/api\/items/)
})

// ============================================================ ② 前缀 / 折叠

test('② ★★ "前缀匹配"会放行更深一段的写，段数相等才拦得住', () => {
  //   > 一个「用路径前缀判断这是哪个端点」的匹配，
  //   > 与一个「/api/items 的读权限覆盖了 /api/items/1/delete」的匹配，是同一个东西。
  const e = EXTERNAL_API_SCOPE_CHECKED.prefixMatching
  assert.equal(e.prefixWouldAllowCount, 4, '四条样本在 startsWith 下都会落进端点')
  // "更深一段"那三条的段数确实不同——段数相等才是拦得住它们的原因
  const deeper = e.rows.filter((r) => r.note === '更深一段的写')
  assert.equal(deeper.length, 3)
  for (const r of deeper) {
    assert.equal(r.startsWithWouldMatch, true, r.requested)
    assert.notEqual(r.segmentCounts[0], r.segmentCounts[1], r.requested)
  }
  // 而"边界"那一行是**另一种**形态：段数**相同**，前缀也不是真前缀
  //   （`/api/items-other` 与 `/api/items` 都是 2 段）。
  //   `startsWith` 在这里同样给出错误答案，但拦不住它的是**整段相等**，不是段数。
  //
  //   > 一个「把两种不同的前缀错法当成一种」的用例，
  //   > 与一个「只修好了其中一种」的用例，是同一个东西。
  const boundary = e.rows.find((r) => r.note === '前缀边界')
  assert.equal(boundary.startsWithWouldMatch, true)
  assert.equal(boundary.segmentCounts[0], boundary.segmentCounts[1], '边界形态的段数是相同的')
  assert.notEqual(boundary.grantedKey, boundary.requestedKey)
  assert.equal(boundary.requestedKey.startsWith(boundary.grantedKey), true)
  // 端到端：两种形态都要被拒
  for (const p of ['/api/items/1/delete', '/api/items-other']) {
    assert.equal(verdict({ method: 'GET', path: p, host: H }).code, API_CODES.ENDPOINT_NOT_GRANTED, p)
  }
})

test('② ★★ 把 `..` **折叠**掉会让一条只读规则落到另一个端点', () => {
  //   > 一个「把模式里的 .. 折叠掉」的规范化，
  //   > 与一个「/api/items/../admin 这条只读规则变成 /api/admin 的读授权」的规范化，
  //   > 是同一个东西——而它的方向是放行。
  const e = EXTERNAL_API_SCOPE_CHECKED.prefixMatching
  assert.equal(e.foldingPatternsAllRejected, true, '本模块必须拒绝，而不是折叠')
  assert.equal(e.foldingPatternsChangedEndpoint, 3, '三条都因为折叠而落到了别的端点')
  for (const f of e.foldingPatterns) {
    assert.notEqual(f.foldedPattern, f.pattern)
    assert.equal(f.normalizedCode, API_CODES.PATH_ESCAPE)
  }
  // 具体到最要紧的那一条：只读规则 → `/api/admin`
  const admin = e.foldingPatterns.find((f) => f.pattern === '/api/items/../admin')
  assert.equal(admin.foldedPattern, '/api/admin')
  assert.deepEqual(admin.effects, ['read'])
  // 付款那一条折叠之后落到 `/billing/pay`——这就是 §6.6 line 466 点名的高风险动作
  const pay = e.foldingPatterns.find((f) => f.pattern === '/api/orders/../../billing/pay')
  assert.equal(pay.foldedPattern, '/billing/pay')
  // 请求侧：编码的 `..` 解码之后才看得出
  const encoded = e.foldingRequests.find((r) => r.requested === '/api/%2e%2e/admin')
  assert.equal(encoded.folded, '/admin')
  assert.equal(encoded.normalizedCode, API_CODES.PATH_ESCAPE)
  // 而真的写到授权表里必须在**建表时**就抛——不是等到某次请求才报一个看起来
  // 像是"这次请求有问题"的码。
  //
  //   > 一个「把授权表的错报成请求的错」的诊断，
  //   > 与一个「值班的人去改请求、而配置一直错着」的诊断，是同一个东西。
  assert.throws(
    () => grantOf([{ host: H, pattern: '/api/items/../admin', effects: ['read'] }]),
    (err) => err.code === API_CODES.PATH_ESCAPE,
  )
  // 幂等：表建好之后，模式不会再被解析第二遍（省掉每次调用的解析，也让"建表时校验过"
  // 这件事在数据结构上看得见）
  const normalized = grantOf([{ host: H, pattern: '/api/items/{id}', effects: ['read'] }])
  assert.equal(normalized.endpoints[0].parsed.segments.length, 3)
  assert.deepEqual(normalized.endpoints[0].parsed.segments, ['api', 'items', '*'])
})

// ============================================================ ③ 占位符

test('③ ★★ 占位符恰好一段；半段占位符会变成通配', () => {
  //   > 一个「`{id}` 能吃下若干段」的模式，
  //   > 与一个「/api/items/{id} 的读权限覆盖了 /api/items/1/delete」的模式，
  //   > 是同一个东西。
  const g = grantOf([{ host: H, pattern: '/api/items/{id}', effects: ['read'] }])
  assert.equal(verdict({ method: 'GET', path: '/api/items/1', host: H }, g).allowed, true)
  for (const p of ['/api/items/1/delete', '/api/items', '/api/items/1/2']) {
    const v = verdict({ method: 'GET', path: p, host: H }, g)
    assert.equal(v.allowed, false, p)
    assert.equal(v.code, API_CODES.ENDPOINT_NOT_GRANTED, p)
  }
  // 捕获到的 id 就是那一段
  assert.deepEqual(verdict({ method: 'GET', path: '/api/items/42', host: H }, g).captures, { id: '42' })
  // 解析出来的模式段：占位符是一个 `*` 段
  const parsed = parseEndpointPattern({ pattern: '/api/items/{id}', host: H })
  assert.deepEqual(parsed.segments, ['api', 'items', '*'])
  assert.deepEqual(parsed.keys, [{ name: 'id', index: 2 }])
  // ★ 半段占位符必须拒绝（否则 `/api/{id}-x` 就是一个通配）
  const e = EXTERNAL_API_SCOPE_CHECKED.placeholder
  assert.equal(e.halfAllRejected, true)
  for (const p of ['/api/{id}-x', '/api/x{id}', '/api/{id}{x}']) {
    assert.equal(e.halfPlaceholders.find((h) => h.pattern === p).code, API_CODES.BAD_PATTERN, p)
  }
})

// ============================================================ ④ 方法覆盖

test('④ ★★ 方法覆盖的每一种拼法（含大小写变形）都要拒绝', () => {
  const e = EXTERNAL_API_SCOPE_CHECKED.overrides
  assert.equal(e.count, METHOD_OVERRIDE_KEYS.length)
  assert.equal(e.allRejected, true)
  // 每一个拼法都要在 header / query / 大小写变形里都拒绝——不是只测一种
  for (const row of e.keys) {
    assert.equal(row.header, API_CODES.METHOD_OVERRIDE, row.key)
    assert.equal(row.query, API_CODES.METHOD_OVERRIDE, row.key)
    assert.equal(row.upperHeader, API_CODES.METHOD_OVERRIDE, row.key)
    assert.equal(row.mixedHeader, API_CODES.METHOD_OVERRIDE, row.key)
  }
  // 大小写与连字符都不是借口
  for (const k of ['X-HTTP-Method-Override', 'x-http-method-override', 'X-Http-Method-Override']) {
    assert.equal(verdict({ method: 'GET', path: '/api/items', host: H, headers: { [k]: 'DELETE' } }).code, API_CODES.METHOD_OVERRIDE, k)
  }
})

// ============================================================ ⑤ dry_run

test('⑤ ★★ `dry_run` 之类的声明不能让写降级成读', () => {
  //   > 一个「请求里写了 dry_run 就当成读」的分类，
  //   > 与一个「由调用方自己声明自己没有副作用」的分类，是同一个东西。
  const e = EXTERNAL_API_SCOPE_CHECKED.dryRun
  assert.equal(e.count, DRY_RUN_KEYS.length)
  assert.equal(e.allStillWrite, true)
  assert.equal(e.allStillHighRisk, true)
  assert.equal(e.allFlaggedAsAttempt, true, '而且要留下"有人试图降级"的痕迹')
  for (const row of e.keys) {
    assert.equal(row.effect, 'write', row.key)
    assert.equal(row.allowed, true, row.key)
    assert.equal(row.downgradeAttempt, true, row.key)
  }
  // 单点确认：一次高风险付款不会因为 `dry_run=true` 而变成读
  const v = verdict({
    method: 'POST', path: '/api/orders', host: H, body: { amount: 1 }, query: { dry_run: 'true' },
  }, grantOf([{ host: H, pattern: '/api/orders', effects: ['write'], idempotent: false, riskClass: 'payment' }]))
  assert.equal(v.effect, 'write')
  assert.equal(v.highRisk, true)
  assert.equal(v.riskClass, 'payment')
  assert.equal(v.downgradeAttempt, true)
})

// ============================================================ ⑥ 高风险类别

test('⑥ ★★ 高风险类别必须被点名，不能从路径里猜', () => {
  //   > 一个「用路径里有没有 delete 这个词判断高风险」的分类，
  //   > 与一个「/api/items/delete-preview 被当成删除动作」的分类，是同一个东西。
  const e = EXTERNAL_API_SCOPE_CHECKED.riskClass
  // (a) 路径里写着 delete，但声明是只读 ⇒ 不是高风险
  assert.equal(e.pathSaysDeleteButReadOnly.allowed, true)
  assert.equal(e.pathSaysDeleteButReadOnly.highRisk, false)
  assert.equal(e.pathSaysDeleteButReadOnly.riskClass, null)
  // 而"从路径猜"确实会猜错——证据留着
  assert.deepEqual(e.inferredFromPath, ['delete'])
  // (b) 路径里什么都没有，但声明了 payment ⇒ 是高风险
  assert.equal(e.pathSaysNothingButDeclared.highRisk, true)
  assert.equal(e.pathSaysNothingButDeclared.riskClass, 'payment')
  assert.equal(e.pathSaysNothingButDeclared.endpointPattern, '/api/orders')
  // (c) 只读端点不能声明高风险类别（归一化时就抛）
  assert.equal(e.highRiskOnRead, API_CODES.HIGH_RISK_ON_READ)
  // (d) 不认识的类别要抛，不能当成"没有类别"
  assert.equal(e.unknownClass, API_CODES.UNKNOWN_RISK_CLASS)
  // (e) highRisk 只在**写**上成立
  const readOnly = grantOf([{ host: H, pattern: '/api/catalog', effects: ['read'] }])
  assert.equal(verdict({ method: 'GET', path: '/api/catalog', host: H }, readOnly).highRisk, false)
  const writeRisky = grantOf([{ host: H, pattern: '/api/catalog', effects: ['write'], idempotent: true, riskClass: 'publish' }])
  assert.equal(verdict({ method: 'POST', path: '/api/catalog', host: H, body: {} }, writeRisky).highRisk, true)
  // 清单本身
  assert.deepEqual([...RISK_CLASSES], ['publish', 'payment', 'delete', 'credential', 'permission', 'transfer'])
})

// ============================================================ ⑦ 两个权限

test('⑦ ★★ 读与写是两个独立的权限（六种组合都要对）', () => {
  const e = EXTERNAL_API_SCOPE_CHECKED.separatePermissions
  assert.deepEqual(e.mismatched, [])
  assert.equal(e.cases.length, 6)
  // 同一个端点，只给读时写被拒；只给写时读被拒
  const onlyRead = e.cases.find((c) => c.effects.length === 1 && c.effects[0] === 'read' && c.method === 'POST')
  assert.equal(onlyRead.allowed, false)
  assert.equal(onlyRead.code, API_CODES.EFFECT_MISMATCH)
  const onlyWrite = e.cases.find((c) => c.effects.length === 1 && c.effects[0] === 'write' && c.method === 'GET')
  assert.equal(onlyWrite.allowed, false)
  assert.equal(onlyWrite.code, API_CODES.EFFECT_MISMATCH)
})

// ============================================================ ⑧ 未知方法

test('⑧ ★★ 不认识的方法 fail-closed，而"默认按读"会放行', () => {
  //   > 一个「不认识的方法就按读处理」的分类，
  //   > 与一个「自研的上传方法 UPLOAD 被当成读」的分类，是同一个东西——
  //   > 而它的方向是放行。
  const e = EXTERNAL_API_SCOPE_CHECKED.unknownMethod
  assert.equal(e.allFailedClosed, true)
  assert.equal(e.assumedReadWouldAllowCount, 6, '六种未知方法在"默认按读"下都会变成读')
  // 大小写与首尾空白是同一个方法，必须正常工作
  assert.deepEqual(e.normalized.map((n) => n.effect), ['read', 'read', 'read', 'write', 'write'])
  // 端到端：未知方法会从 checkExternalApi 里以 UNKNOWN_METHOD 出来
  const v = verdict({ method: 'UPLOAD', path: '/api/items', host: H })
  assert.equal(v.allowed, false)
  assert.equal(v.code, API_CODES.UNKNOWN_METHOD)
  // 空方法也一样
  assert.throws(() => effectOfMethod(''), (err) => err.code === API_CODES.BAD_REQUEST)
  assert.throws(() => effectOfMethod(null), (err) => err.code === API_CODES.BAD_REQUEST)
})

// ============================================================ ⑨ 通配

test('⑨ ★★ 通配模式一律拒绝，而字面量与整段占位符必须通过', () => {
  //   > 一个「支持 * 的端点表」的授权，
  //   > 与一个「所有端点都被允许」的授权，是同一个东西——
  //   > 只不过前者在配置里看起来是有选择的。
  const e = EXTERNAL_API_SCOPE_CHECKED.wildcard
  assert.equal(e.acceptedCount, 0, '八种通配/正则形态一个都不能通过')
  assert.equal(e.allValidAccepted, true, '而合法的四种必须通过')
  assert.ok(e.rejectedCodes.includes(API_CODES.WILDCARD_PATTERN))
  assert.ok(e.rejectedCodes.includes(API_CODES.BAD_PATTERN))
  // 端到端：带 `*` 的授权表在建表时就抛
  assert.throws(
    () => grantOf([{ host: H, pattern: '/api/*', effects: ['read'] }]),
    (err) => err.code === API_CODES.WILDCARD_PATTERN,
  )
})

// ============================================================ ⑩ 授权表形态

test('⑩ ★★ 授权表字段闭合、effects 必须显式、host 必需且要规范化', () => {
  const e = EXTERNAL_API_SCOPE_CHECKED.grantShape
  assert.equal(e.allRejected, true)
  //   > 一个「没写 effects 就默认允许读」的端点表，
  //   > 与一个「每条端点都至少允许读」的端点表，是同一个东西。
  const noEffects = e.tries.find((t) => t.label === '缺 effects')
  assert.equal(noEffects.code, API_CODES.BAD_GRANT)
  // host 是必需的——一个"可以省 host 的端点表"就是"对所有 host 生效"。
  // 而且**每种形态有自己的码**：`@` 是 userinfo、`:` 是端口、非 ASCII 是同形异义。
  //
  //   > 一个「把两种不同的域名攻击报成同一个码」的检查，
  //   > 与一个「值班的人去改错误的那一处」的检查，是同一个东西。
  const hostCodes = [
    ['host 缺失', API_CODES.HOST_NOT_A_STRING],
    ['host 为空', API_CODES.HOST_NOT_A_STRING],
    ['host 带 userinfo', API_CODES.HOST_HAS_USERINFO],
    ['host 带端口', API_CODES.HOST_HAS_PORT],
    ['host 非 ASCII', API_CODES.HOST_NON_ASCII],
    ['host 带通配', API_CODES.HOST_MALFORMED],
  ]
  for (const [label, code] of hostCodes) {
    assert.equal(e.tries.find((t) => t.label === label).code, code, label)
  }
  // 每种形态的码都不重复（否则"哪一处坏了"还是要从消息里猜）
  const shapeCodes = e.hostShapes.map((h) => h.code)
  const expectedShapeCodes = {
    缺失: API_CODES.HOST_NOT_A_STRING,
    空: API_CODES.HOST_NOT_A_STRING,
    userinfo: API_CODES.HOST_HAS_USERINFO,
    路径分隔符: API_CODES.HOST_HAS_SEPARATOR,
    反斜杠: API_CODES.HOST_HAS_SEPARATOR,
    端口: API_CODES.HOST_HAS_PORT,
    '非 ASCII': API_CODES.HOST_NON_ASCII,
    通配: API_CODES.HOST_MALFORMED,
    双点: API_CODES.HOST_MALFORMED,
    前导点: API_CODES.HOST_MALFORMED,
  }
  // ★ 逐条钉住：每一层的码都必须**就是**它自己那一个。
  //   否则把某一层删掉之后，它会静默落到字符类上给一个别的码，
  //   而"这个码还在清单里"这件事就让判据以为那一层还在。
  //
  //   > 一个「被更宽的规则接管之后仍然报得出码」的检查，
  //   > 与一个「其实已经不存在、但看起来还在」的检查，是同一个东西。
  for (const [label, code] of Object.entries(expectedShapeCodes)) {
    const shape = e.hostShapes.find((h) => h.label === label)
    assert.ok(shape !== undefined, label)
    assert.equal(shape.code, code, label)
  }
  assert.equal(shapeCodes.every((c) => c !== 'NO-THROW' && c !== 'NO-CODE'), true)
  assert.ok(new Set(shapeCodes).size >= 4, '至少四种形态给出不同的码')
  // ★ 诚实边界：那四条"具体形态"的检查**不是**独立的第二道防线——
  //   字符类同样会拒掉它们（只是换一个码）。留成证据，免得有人以为这里有两层保护。
  //
  //   > 一个「其实是诊断、但看起来像一道防线」的检查，
  //   > 与一个「被前一道更宽的规则挡住」的检查，在"它到底拦住了什么"上是同一个东西。
  assert.equal(e.redundancyWithCharClass.length, 5)
  for (const r of e.redundancyWithCharClass) {
    assert.equal(r.charClassWouldReject, true, `${r.host} 的字符类也应当拒它`)
    assert.ok(r.specificCode.startsWith('api-scope-host-'), r.host)
  }
  // 空端点表合法（什么都不许调用）
  assert.equal(e.emptyOk, 0)
  // host 规范化：小写 + 去 FQDN 根点
  assert.equal(e.hostNormalized, 'api.example.com')
  assert.equal(normalizeHost('API.Example.COM.'), 'api.example.com')
  assert.equal(normalizeHost('api.example.com.'), 'api.example.com')
  //   > 一个「把 example.com. 当成另一个域名」的检查，
  //   > 与一个「FQDN 根点让它绕过白名单」的检查，是同一个东西。
  assert.equal(normalizeHost('api.example.com'), normalizeHost('API.EXAMPLE.COM.'))
})

// ============================================================ ⑪ 重试

test('⑪ ★★ 重试仍然是写；幂等键把"同一个写"配对起来', () => {
  //   > 一个「把重试当成读」的分类，
  //   > 与一个「重试算第二次写、但只审了一次」的分类，是同一个东西。
  const e = EXTERNAL_API_SCOPE_CHECKED.retry
  assert.equal(e.first.effect, 'write')
  assert.equal(e.retry.effect, 'write', '重试也是写')
  assert.equal(e.retry.retry, true, '但它是同一次写的重试')
  assert.equal(e.sameCanonical, true)
  assert.equal(e.differentCanonical, true, '换一个幂等键就是另一次写')
  assert.notEqual(e.otherKeyCanonical, e.first.canonicalKey)
  // 声明了 idempotent: false 的端点带了幂等键 ⇒ 拒绝（那个键不会被兑现）
  assert.equal(e.nonIdempotentWithKey.allowed, false)
  assert.equal(e.nonIdempotentWithKey.code, API_CODES.IDEMPOTENCY_NOT_HONORED)
  // canonicalKey 的键序固定、不用 JSON.stringify 判等（PRT-611 的纪律）
  assert.equal(canonicizeApiCall({ host: 'h', method: 'post', path: '/p', idempotencyKey: 'k' }), 'external-api@1|h|POST|/p|k')
  assert.equal(canonicizeApiCall({ method: 'GET', path: '/p' }), 'external-api@1|-|GET|/p|-')
})

// ============================================================ ⑫ URL 路径

test('⑫ ★★ URL 路径**永远**大小写敏感（这一点与平台无关）', () => {
  const e = EXTERNAL_API_SCOPE_CHECKED.urlPath
  assert.equal(e.distinctCaseKeys, 3, '三种大小写是三个不同的键')
  assert.deepEqual(e.platformFree.segments, ['API', 'Items', '1'])
  assert.equal(e.platformFree.key, '/API/Items/1')
  // 端到端：授权是小写时，大写请求不匹配（方向是拒绝，安全）
  assert.equal(verdict({ method: 'GET', path: '/API/ITEMS', host: H }).code, API_CODES.ENDPOINT_NOT_GRANTED)
  //   > 一个「在大小写敏感的地方也折叠大小写」的匹配，
  //   > 与一个「/API/x 与 /api/x 被当成同一个端点」的匹配，是同一个东西。
})

test('⑫ ★★ 百分号编码必须在**匹配之前**解码，两次编码要拒绝', () => {
  const e = EXTERNAL_API_SCOPE_CHECKED.urlPath
  const byRaw = Object.fromEntries(e.percent.map((p) => [p.raw, p]))
  // 解出来就是被授权的那条 ⇒ 允许
  assert.equal(byRaw['/%61pi/items'].key, '/api/items')
  assert.equal(byRaw['/%61pi/items'].code, null)
  // 解码后多出一段 ⇒ 那个"被授权"的判定不该成立
  assert.equal(byRaw['/api/items%2F1'].key, '/api/items/1')
  // 解码后是 `..` ⇒ 拒绝
  assert.equal(byRaw['/api/%2e%2e/admin'].code, API_CODES.PATH_ESCAPE)
  //   > 一个「解码一次就比路径」的检查，
  //   > 与一个「%252e%252e 解码一次还是 %2e%2e、服务端解码第二次就成了 ..」的检查，
  //   > 是同一个东西——而它的方向是放行。
  assert.equal(byRaw['/api/%252e%252e/admin'].code, API_CODES.DOUBLE_ENCODED)
  // 逐段解码也要能处理多字节
  assert.equal(percentDecodeOnce('%E4%B8%AD'), '中')
})

test('⑫ ★★ 规范化必须接受自己的输出（幂等）', () => {
  //   > 一个「接受不了自己输出」的规范化，
  //   > 与一个「第二次经过就抛」的规范化，是同一个东西。
  const e = EXTERNAL_API_SCOPE_CHECKED.urlPath
  assert.equal(e.allIdempotent, true)
  for (const row of e.idempotent) {
    assert.equal(row.once, row.twice, row.raw)
  }
  // 具体的那个坑：`/api/50%25off` 解成 `50%off`，而 key 又把 `%` 写回 `%25`
  const percent = e.idempotent.find((r) => r.raw === '/api/50%25off')
  assert.deepEqual(percent.decoded, ['api', '50%off'])
  assert.equal(percent.once, '/api/50%25off')
  // ★ 反面证据：拿**解码后**的字面量当 key，第二次经过会因为 `%of` 不是合法十六进制而抛
  assert.ok(e.naiveThrowCount > 0)
  const naive = e.naiveKeyWouldThrow.find((n) => n.raw === '/api/50%25off')
  assert.equal(naive.naiveKey, '/api/50%off')
  assert.equal(naive.secondPassCode, API_CODES.BAD_PERCENT)
  // 根路径是一个合法的端点（一个空段列表）
  assert.deepEqual(e.root, { key: '/', segments: [] })
})

test('⑫ ★★ 路径规范形式的八条要求逐条成立（拒绝，而不是折叠）', () => {
  const rejects = [
    { path: 'api/items', code: API_CODES.NOT_ABSOLUTE, why: '不以 / 开头' },
    { path: '/api/items/', code: API_CODES.TRAILING_SLASH, why: '结尾 /' },
    { path: '/api//items', code: API_CODES.EMPTY_SEGMENT, why: '连续 /' },
    { path: '/api/./items', code: API_CODES.DOT_SEGMENT, why: '.' },
    { path: '/api/../items', code: API_CODES.PATH_ESCAPE, why: '..' },
    { path: '/api\\items', code: API_CODES.BACKSLASH_IN_PATH, why: '反斜杠' },
    { path: '/api/items?action=x', code: API_CODES.PATH_HAS_QUERY, why: '? 查询' },
    { path: '/api/items#frag', code: API_CODES.PATH_HAS_QUERY, why: '# 片段' },
    { path: '/api/it\nems', code: API_CODES.CONTROL_CHAR, why: '控制字符' },
    { path: '/api/%zz', code: API_CODES.BAD_PERCENT, why: '非十六进制百分号' },
    { path: '/api/%E4', code: API_CODES.BAD_PERCENT, why: '被截断的 UTF-8' },
    { path: '', code: API_CODES.BAD_PATH, why: '空路径' },
  ]
  for (const r of rejects) {
    assert.throws(() => normalizeUrlPath(r.path), (err) => err.code === r.code, `${r.why}（${r.path}）`)
  }
  // 而规范形式必须通过
  for (const p of ['/', '/api', '/api/items', '/api/items/1', '/a%20b/c']) {
    assert.doesNotThrow(() => normalizeUrlPath(p), p)
  }
})

// ============================================================ ⑬ 歧义

test('⑬ ★★ 匹配到多条规则要拒绝，而不是"取第一条"', () => {
  //   > 一个「多条规则命中时取第一条」的匹配，
  //   > 与一个「换个遍历顺序结论就变」的匹配，是同一个东西。
  const e = EXTERNAL_API_SCOPE_CHECKED.ambiguity
  assert.equal(e.ambiguous.allowed, false)
  assert.equal(e.ambiguous.code, API_CODES.AMBIGUOUS_MATCH)
  // 单条命中仍然正常——不能因为防歧义就把正常匹配也拒了
  assert.equal(e.single.allowed, true)
  // 报告要列出所有命中的模式
  const g = grantOf([
    { host: H, pattern: '/api/items/{id}', effects: ['read'] },
    { host: H, pattern: '/api/{collection}/1', effects: ['read'] },
  ])
  const v = verdict({ method: 'GET', path: '/api/items/1', host: H }, g)
  assert.match(v.reason, /\/api\/items\/\{id\}/)
  assert.match(v.reason, /\/api\/\{collection\}\/1/)
  // 码名说的是"两条模式重叠"，而不是"授权表格式错误"——
  // 这两件事的修复动作完全不同
  assert.notEqual(v.code, API_CODES.BAD_GRANT)
})

// ============================================================ ⑭ 错误码

test('⑭ ★★ 每个声明的错误码都必须真的被发出过', () => {
  //   > 一个「声明了但从不发出」的错误码，
  //   > 与一个不存在的错误码，在"它到底告诉过值班的人什么"上是同一个东西。
  const src = readFileSync(fileURLToPath(new URL('./external-api-scope.mjs', import.meta.url)), 'utf8')
  const e = assertEveryCodeIsEmitted()
  assert.equal(e.count, Object.keys(API_CODES).length)
  const neverEmitted = []
  for (const name of Object.keys(API_CODES)) {
    // 数标识符的出现次数：声明处写的是 `NAME: '值'`，不含 `API_CODES.NAME`
    const sites = src.split(`API_CODES.${name}`).length - 1
    if (sites === 0) neverEmitted.push(name)
  }
  assert.deepEqual(neverEmitted, [], '这些码声明了但从不发出')
  // 反过来：码值必须唯一（两个名字指向同一个值会让审计无法区分）
  const values = Object.values(API_CODES)
  assert.equal(new Set(values).size, values.length, '码值有重复')
  // 而且全部带 api-scope- 前缀，方便在日志里筛出来
  for (const v of values) assert.match(v, /^api-scope-[a-z-]+$/, v)
})

// ============================================================ ⑮ 分类器

test('⑮ ★★ classifyEffect 把方法、路径、覆盖物一起看完才给结论', () => {
  const c = classifyEffect({ method: 'post', path: '/api/items/7', headers: {}, query: {} })
  assert.equal(c.effect, 'write')
  assert.equal(c.method, 'POST')
  assert.equal(c.pathKey, '/api/items/7')
  assert.deepEqual(c.pathSegments, ['api', 'items', '7'])
  assert.equal(c.downgradeAttempt, false)
  // 读 + dry_run 不是"试图降级"（它本来就是读）
  const r = classifyEffect({ method: 'GET', path: '/api/items', query: { dry_run: 'true' } })
  assert.equal(r.effect, 'read')
  assert.equal(r.downgradeAttempt, false)
  assert.equal(r.dryRunKeys.length, 1)
  // 写 + dry_run 是"试图降级"
  const w = classifyEffect({ method: 'POST', path: '/api/items', body: {}, query: { dry_run: 'true' } })
  assert.equal(w.effect, 'write')
  assert.equal(w.downgradeAttempt, true)
  // 动作关键词清单里不能混进"不是动作"的名字
  assert.ok(ACTION_QUERY_KEYS.includes('action'))
  // 空 body 的判定
  assert.equal(isEmptyBody(null), true)
  assert.equal(isEmptyBody(undefined), true)
  assert.equal(isEmptyBody(''), true)
  assert.equal(isEmptyBody('  '), true)
  assert.equal(isEmptyBody({}), true)
  assert.equal(isEmptyBody([]), true)
  assert.equal(isEmptyBody(Buffer.alloc(0)), true)
  assert.equal(isEmptyBody({ a: 1 }), false)
  assert.equal(isEmptyBody('x'), false)
  assert.equal(isEmptyBody(0), false)
})

// ============================================================ ⑯ 不复用路径规范化器

test('⑯ ★★ 本模块**不**复用文件系统路径规范化器（这是一次真缺陷的回归守卫）', () => {
  // 第一版复用了 `path-scope.mjs` 的 `normalizeForCompare`（"同一套规则，别两处各写"）。
  // 装载自检在 Windows 那一支直接否掉了它：
  //
  //     path-scope-not-absolute: 路径 "/API//Items/./1/" 没有盘符
  //
  //   > 一个「把文件系统路径规范化器复用到 URL 路径上」的复用，
  //   > 与一个「在 Windows 上 URL 路径因为没有盘符而被判成非法、
  //   > 在 Linux 上又悄悄折叠了大小写」的复用，是同一个东西。
  //
  // 这条用例把"这两件事不同"钉住：对照物是 PRT-604 的文件系统规范化器。
  assert.throws(
    () => normalizeForCompare('/api/items', { platform: 'win32' }),
    (err) => err.code === 'path-scope-not-absolute',
    '文件系统规范化器在 Windows 上要求盘符',
  )
  // 而 URL 路径的规范化**没有平台参数**，同一个输入在任何平台都是同一个结果
  assert.equal(normalizeUrlPath('/api/items').key, '/api/items')
  assert.deepEqual(normalizeUrlPath('/api/items').segments, ['api', 'items'])
  // 源码里不能出现对 path-scope 的**引用**（防止有人"顺手复用"回去）。
  // 注释里提到它是对的——那是记录这次教训的地方，所以只查 import 与调用。
  const src = readFileSync(fileURLToPath(new URL('./external-api-scope.mjs', import.meta.url)), 'utf8')
  assert.equal(/^\s*import[^\n]*path-scope/m.test(src), false, '不能 import 文件系统路径模块')
  assert.equal(src.includes('normalizeForCompare('), false, '不能调用文件系统路径规范化器')
  // 而"这次教训"必须留在注释里，不能因为删了引用就把原因也删了
  assert.match(src, /path-scope-not-absolute/, '注释里要留下那次装载自检的报错')
  assert.match(src, /文件系统路径规范化器复用到 URL 路径上/, '注释里要留下为什么不能复用')
  // 大小写也相反：文件系统在 win32 折叠，URL 永远不折叠
  assert.equal(
    normalizeForCompare('C:\\Work\\Sub', { platform: 'win32' }).key,
    normalizeForCompare('c:\\work\\sub', { platform: 'win32' }).key,
    '文件系统在 Windows 上折叠大小写',
  )
  assert.notEqual(normalizeUrlPath('/Work/Sub').key, normalizeUrlPath('/work/sub').key, 'URL 路径不折叠')
})

test('⑯ ★★ 自检对象里的每一项都要有内容（防止自检退化成空壳）', () => {
  const e = EXTERNAL_API_SCOPE_CHECKED
  assert.equal(e.version, V)
  const keys = [
    'readNeverBecomesWrite', 'prefixMatching', 'placeholder', 'overrides', 'dryRun',
    'riskClass', 'separatePermissions', 'unknownMethod', 'wildcard', 'grantShape',
    'retry', 'urlPath', 'ambiguity', 'codeList',
  ]
  for (const k of keys) {
    assert.ok(e[k] !== undefined && e[k] !== null, k)
    assert.ok(Object.keys(e[k]).length > 0, k)
  }
  // 清单类自检不能为空
  assert.equal(e.methodEffects.GET, 'read')
  assert.equal(e.methodEffects.DELETE, 'write')
  assert.ok(Object.keys(e.methodEffects).length >= 8)
  assert.ok(e.overrideKeys.length >= 8)
  assert.ok(e.actionKeys.length >= 6)
  assert.ok(e.dryRunKeys.length >= 8)
})

// ============================================================ ⑰ 端到端

test('⑰ ★★ 一份完整的授权表：读端点、读写端点、高风险写端点各司其职', () => {
  const g = grantOf([
    { host: H, pattern: '/api/items', effects: ['read'] },
    { host: H, pattern: '/api/items/{id}', effects: ['read', 'write'], idempotent: true },
    { host: H, pattern: '/api/orders', effects: ['write'], idempotent: false, riskClass: 'payment' },
    { host: H, pattern: '/api/files/{id}', effects: ['write'], idempotent: true, riskClass: 'delete' },
  ])
  // 读
  assert.equal(verdict({ method: 'GET', path: '/api/items', host: H }, g).allowed, true)
  assert.equal(verdict({ method: 'GET', path: '/api/items/1', host: H }, g).effect, 'read')
  // 读写端点：读与写都在，但各自的 effect 正确
  const w = verdict({ method: 'PATCH', path: '/api/items/1', host: H, body: { name: 'x' } }, g)
  assert.equal(w.allowed, true)
  assert.equal(w.effect, 'write')
  assert.equal(w.highRisk, false, '没有声明类别就不是高风险')
  // 高风险写
  const p = verdict({ method: 'POST', path: '/api/orders', host: H, body: { amount: 1 } }, g)
  assert.equal(p.allowed, true)
  assert.equal(p.highRisk, true)
  assert.equal(p.riskClass, 'payment')
  // 删除
  const d = verdict({ method: 'DELETE', path: '/api/files/9', host: H }, g)
  assert.equal(d.allowed, true)
  assert.equal(d.highRisk, true)
  assert.equal(d.riskClass, 'delete')
  // 而只读那条端点上，DELETE 被拒
  assert.equal(verdict({ method: 'DELETE', path: '/api/items', host: H }, g).code, API_CODES.EFFECT_MISMATCH)
  // host 不同 ⇒ 什么都不是
  assert.equal(verdict({ method: 'GET', path: '/api/items', host: 'other.example.com' }, g).code, API_CODES.ENDPOINT_NOT_GRANTED)
  // host 缺失 ⇒ 具体诊断（而不是"端点不匹配"，那会把人引向错误的方向）
  const noHost = verdict({ method: 'GET', path: '/api/items' }, g)
  assert.equal(noHost.code, API_CODES.HOST_NOT_A_STRING)
  assert.match(noHost.reason, /host 必须是非空字符串/)
  // 没有授权表
  const noGrant = checkExternalApi({ request: { method: 'GET', path: '/api/items', host: H }, grant: null })
  assert.equal(noGrant.code, API_CODES.BAD_GRANT)
  // 空授权表：什么都不可调用
  assert.equal(verdict({ method: 'GET', path: '/api/items', host: H }, grantOf([])).code, API_CODES.ENDPOINT_NOT_GRANTED)
})

test('⑰ ★★ 判定对象是冻结的、并且不泄漏内部可变状态', () => {
  const g = grantOf([{ host: H, pattern: '/api/items/{id}', effects: ['read'], notes: 'x' }])
  const v = verdict({ method: 'GET', path: '/api/items/1', host: H }, g)
  assert.equal(Object.isFrozen(v), true)
  assert.equal(Object.isFrozen(v.endpoint), true)
  assert.equal(Object.isFrozen(v.captures), true)
  // 改不动——判定结果不能被执行面事后改写（spec line 468）
  assert.throws(() => { v.allowed = true }, TypeError)
  // capture 是一个新对象，不是请求内部对象的引用
  assert.deepEqual(v.captures, { id: '1' })
  assert.notEqual(v.captures, v.endpoint)
  // matchEndpoint 返回的捕获也是冻结的
  const parsed = parseEndpointPattern({ pattern: '/api/items/{id}', host: H })
  const m = matchEndpoint({ endpoint: parsed, request: { host: H, segments: ['api', 'items', '1'] } })
  assert.equal(m.matched, true)
  assert.equal(Object.isFrozen(m.captures), true)
  // 段数不同时的理由要说明段数
  const m2 = matchEndpoint({ endpoint: parsed, request: { host: H, segments: ['api', 'items'] } })
  assert.equal(m2.matched, false)
  assert.match(m2.reason, /段数不同/)
  assert.equal(m2.captures, null)
})
