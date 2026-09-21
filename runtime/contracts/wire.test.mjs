// runtime/contracts/wire.test.mjs
// ============================================================================
// Runtime Contract **线上表示**的契约测试（PRT-253 跨进程边界）
//
// 本套件锁的是"两进程部署里那条缝的形状"，不是某一次调用的结果。四组：
//
//   ① 覆盖性：七个契约方法 **恰好** 等于七个线上操作（装载期断言的正面证据）
//   ② 路由与方法：三种决策各自可分，且**不互相冒充**
//   ③ 鉴权：fail closed，且 **"没配 token"与"你给错了"必须可分**
//   ④ ★ 失败语义：五种结束方式里**恰好一种**允许被读成"有结论"
//
// 第 ④ 组是本套件存在的理由。它断言的是一张**表**，而不是某一段代码的行为——
// 因为一个把 `transport-failed` 也当成功的实现，它的其余用例
// （"正常运行能拿到 completed"）**全都还是绿的**。
//
//   > 一个只在"出错的那一天"才表现不同的缺陷，
//   > 用一组"平时都正常"的用例是抓不到的。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ADAPTER_METHODS } from './adapter.mjs'
import { REQUIRED_CAPABILITIES } from './adapter.mjs'
import { isTerminalEventType } from './run.mjs'
import {
  WIRE_ADAPTER_OPERATIONS,
  WIRE_ANONYMOUS_OPERATIONS,
  WIRE_AUTH_SCHEME,
  WIRE_BASE_PATH,
  WIRE_CODES,
  WIRE_CONTROL_FRAMES,
  WIRE_CONTROL_KEY,
  WIRE_CONTRACT_CHECKED,
  WIRE_ENDING_FAILURE_CODE,
  WIRE_ENDING_YIELDS_OUTCOME,
  WIRE_EXECUTE_ENDINGS,
  WIRE_OPERATIONS,
  WIRE_ROUTES,
  assertWireCoversContract,
  decodeEventLine,
  encodeControlFrame,
  encodeEventLine,
  isAnonymousOperation,
  isControlFrame,
  isWireTerminalEvent,
  parseAuthorization,
  readEnvelope,
  readRequestEnvelope,
  routeFor,
  tokensMatch,
  wireRefusal,
  wireRequest,
  wireSuccess,
} from './wire.mjs'

// ---------------------------------------------------------------- 夹具

const TERMINAL_EVENT = Object.freeze({
  type: 'run.completed',
  runId: 'run-1',
  seq: 3,
  at: 1_700_000_000_000,
  result: {
    runId: 'run-1',
    attemptId: 'att-1',
    outcome: 'completed',
    code: null,
    output: { status: 'ok' },
    usage: { tokensIn: 1, tokensOut: 2, estimatedCostUsd: 0.001 },
    outcomeUnknown: false,
    userMessage: '运行已完成。',
  },
})

const NON_TERMINAL_EVENT = Object.freeze({
  type: 'run.started',
  runId: 'run-1',
  seq: 1,
  at: 1_700_000_000_000,
})

// ═══════════════════════════════════════════════ ① 覆盖性

test('① 装载期断言成立：七个契约方法恰好等于七个线上操作', () => {
  assert.equal(WIRE_CONTRACT_CHECKED, true)
  assert.equal(assertWireCoversContract(), true)

  // 两个方向都断言。只断言"没有少的"会让"多出来的"那一边溜过去。
  const advertised = [...ADAPTER_METHODS].sort()
  assert.deepEqual([...WIRE_ADAPTER_OPERATIONS].sort(), advertised)
  assert.equal(WIRE_ADAPTER_OPERATIONS.length, ADAPTER_METHODS.length)
})

test('① 路由表里只有 enforcement 是附加端点，且它不是适配器方法', () => {
  const adjunct = WIRE_OPERATIONS.filter((op) => WIRE_ROUTES[op].adjunct === true)
  assert.deepEqual(adjunct, ['enforcement'])
  assert.equal(ADAPTER_METHODS.includes('enforcement'), false,
    'enforcement 若是适配器方法，那它是第八个方法与七方法契约矛盾')
  assert.equal(WIRE_ADAPTER_OPERATIONS.includes('enforcement'), false)
})

test('① 每条路由都在同一个前缀下，且路径互不相同', () => {
  const paths = new Set()
  for (const op of WIRE_OPERATIONS) {
    const route = WIRE_ROUTES[op]
    assert.ok(route.path.startsWith(WIRE_BASE_PATH), `${op} 的路径不在 ${WIRE_BASE_PATH} 下：${route.path}`)
    assert.equal(paths.has(route.path), false, `两条路由共用一个路径：${route.path}`)
    paths.add(route.path)
    assert.ok(['GET', 'POST'].includes(route.method), `${op} 的方法不在 {GET,POST}：${route.method}`)
  }
  assert.equal(paths.size, WIRE_OPERATIONS.length)
})

// ═══════════════════════════════════════════════ ② 路由

test('② 三个决策各自可分：命中 / 地址错 / 动词错', () => {
  const hit = routeFor('GET', WIRE_ROUTES.getHealth.path)
  assert.equal(hit.kind, 'ok')
  assert.equal(hit.operation, 'getHealth')

  const wrongPath = routeFor('GET', `${WIRE_BASE_PATH}/nope`)
  assert.equal(wrongPath.kind, 'unknown-route')
  assert.equal(wrongPath.operation, null)

  const wrongVerb = routeFor('POST', WIRE_ROUTES.getHealth.path)
  assert.equal(wrongVerb.kind, 'method-not-allowed')
  assert.equal(wrongVerb.operation, 'getHealth')
  assert.equal(wrongVerb.allowed, 'GET')
})

test('② 尾斜杠是同一个地址（不多一条同义路由）', () => {
  const a = routeFor('GET', WIRE_ROUTES.getCapabilities.path)
  const b = routeFor('GET', `${WIRE_ROUTES.getCapabilities.path}/`)
  assert.equal(a.kind, 'ok')
  assert.equal(b.kind, 'ok')
  assert.equal(a.operation, b.operation)
})

test('② 方法名大小写不影响判定（HTTP 动词不区分大小写）', () => {
  assert.equal(routeFor('get', WIRE_ROUTES.getHealth.path).kind, 'ok')
})

test('② 带查询串的路径由调用方剥离；路由本身不匹配含 `?` 的路径', () => {
  // 这是**约定**而不是实现的巧合：服务端在调用 routeFor 之前剥查询串。
  // 断言它，是为了让"顺手把整条 url 传进来"这件事在用例上立刻变红。
  const withQuery = routeFor('GET', `${WIRE_ROUTES.getHealth.path}?x=1`)
  assert.equal(withQuery.kind, 'unknown-route')
})

test('② execute / cancel / recover **永不**匿名（三个都断言，不抽样）', () => {
  assert.deepEqual([...WIRE_ANONYMOUS_OPERATIONS], ['getHealth'])
  for (const op of ['execute', 'cancel', 'recover']) {
    assert.equal(isAnonymousOperation(op), false, `${op} 不得匿名`)
    assert.equal(WIRE_ROUTES[op].readonly, false, `${op} 不是只读操作，不得匿名`)
  }
})

test('② 匿名表里的每个操作都是只读的（匿名只允许只读）', () => {
  for (const op of WIRE_ANONYMOUS_OPERATIONS) {
    assert.equal(WIRE_ROUTES[op].readonly, true, `匿名操作 ${op} 不是只读的`)
  }
})

// ═══════════════════════════════════════════════ ③ 鉴权

test('③ parseAuthorization 只认 Bearer，形状不对一律 null（不给空串）', () => {
  assert.deepEqual(parseAuthorization(`${WIRE_AUTH_SCHEME} abc`), { scheme: 'Bearer', token: 'abc' })
  // 方案大小写不敏感（RFC 7235 的口径），但**只认这一个方案**。
  assert.deepEqual(parseAuthorization('bearer abc'), { scheme: 'bearer', token: 'abc' })

  for (const bad of [
    undefined, null, '', '   ', 'abc', // 裸 token：不接受
    'Basic abc', // 别的方案：不接受
    'Bearer', // 没有 token
    'Bearer ', // 空 token
    ' Bearer', // 只有方案
  ]) {
    assert.equal(parseAuthorization(bad), null, `${JSON.stringify(bad)} 不该被解析成一个凭证`)
  }
})

test('③ tokensMatch：相同为真、差一个字符为假、长度不同为假、空串为假', () => {
  assert.equal(tokensMatch('secret-token-1', 'secret-token-1'), true)
  assert.equal(tokensMatch('secret-token-1', 'secret-token-2'), false)
  assert.equal(tokensMatch('secret-token-1', 'secret-token-11'), false)
  assert.equal(tokensMatch('', ''), false, '空 token 不得与空 token 匹配（"没配"不是"配对了"）')
  assert.equal(tokensMatch('a', ''), false)
  assert.equal(tokensMatch('', 'a'), false)
  assert.equal(tokensMatch(undefined, 'a'), false)
  assert.equal(tokensMatch('a', null), false)
})

test('③ ★ NO_TOKEN 与 UNAUTHORIZED 是**两个不同的码**（一个是没配，一个是给错）', () => {
  assert.notEqual(WIRE_CODES.NO_TOKEN, WIRE_CODES.UNAUTHORIZED)
  // 反向锚：两条都不是空串，否则上面的 notEqual 会因为两个 undefined 而假绿。
  assert.equal(typeof WIRE_CODES.NO_TOKEN, 'string')
  assert.equal(typeof WIRE_CODES.UNAUTHORIZED, 'string')
  assert.ok(WIRE_CODES.NO_TOKEN.length > 0)
  assert.ok(WIRE_CODES.UNAUTHORIZED.length > 0)
})

test('③ UNREACHABLE / NO_TOKEN / STREAM_BROKEN 三者互不相同（修法完全不同）', () => {
  const three = [WIRE_CODES.UNREACHABLE, WIRE_CODES.NO_TOKEN, WIRE_CODES.STREAM_BROKEN]
  assert.equal(new Set(three).size, 3,
    '连不上 / 没配凭证 / 流断了必须各有其名：前两者去改配置，第三者去看网络与进程')
})

// ═══════════════════════════════════════════════ ④ 失败语义（核心）

test('④ ★★★ 五种结束方式里**恰好一种**允许被读成"有结论"', () => {
  const endings = Object.values(WIRE_EXECUTE_ENDINGS)
  assert.equal(endings.length, 5)

  const yielding = endings.filter((e) => WIRE_ENDING_YIELDS_OUTCOME[e] === true)
  assert.deepEqual(yielding, [WIRE_EXECUTE_ENDINGS.TERMINAL],
    '除 terminal 之外任何结束方式被标成"有结论"，都会让断流被读成一次成功运行')

  // 每一种都被登记过，且值都是布尔（不是 undefined）。
  for (const ending of endings) {
    assert.equal(typeof WIRE_ENDING_YIELDS_OUTCOME[ending], 'boolean', `${ending} 没有登记在产出结论表里`)
  }
  // 表里没有多余的键。
  assert.deepEqual(Object.keys(WIRE_ENDING_YIELDS_OUTCOME).sort(), [...endings].sort())
})

test('④ ★★★ 除 terminal 外每一种都有**自己的**失败码，且互不相同', () => {
  const endings = Object.values(WIRE_EXECUTE_ENDINGS)
  assert.equal(WIRE_ENDING_FAILURE_CODE[WIRE_EXECUTE_ENDINGS.TERMINAL], null,
    'terminal 不抛，不该有失败码')

  const others = endings.filter((e) => e !== WIRE_EXECUTE_ENDINGS.TERMINAL)
  const codes = others.map((e) => WIRE_ENDING_FAILURE_CODE[e])
  for (const [i, code] of codes.entries()) {
    assert.equal(typeof code, 'string', `${others[i]} 没有失败码`)
    assert.ok(code.length > 0, `${others[i]} 的失败码是空串`)
  }
  assert.equal(new Set(codes).size, others.length,
    '两种结束方式共用一个码，等于把两种不同的故障合成一个读数')
})

test('④ ★★★ no-terminal 与 transport-failed 不得合成一个读数', () => {
  // 这是本套件里最重要的一对。前者是"对端说完了但没说结论"（多半是适配器违约），
  // 后者是"我们没听完"（多半是网络/进程）。修法相反。
  const a = WIRE_ENDING_FAILURE_CODE[WIRE_EXECUTE_ENDINGS.NO_TERMINAL]
  const b = WIRE_ENDING_FAILURE_CODE[WIRE_EXECUTE_ENDINGS.TRANSPORT_FAILED]
  assert.notEqual(a, b)
  assert.equal(a, WIRE_CODES.STREAM_NO_TERMINAL)
  assert.equal(b, WIRE_CODES.STREAM_BROKEN)
})

test('④ 表里每一项都是 WIRE_CODES 里登记过的码（不发明表外的码）', () => {
  const known = new Set(Object.values(WIRE_CODES))
  for (const [ending, code] of Object.entries(WIRE_ENDING_FAILURE_CODE)) {
    if (code === null) continue
    assert.ok(known.has(code), `${ending} 的码 ${code} 不在 WIRE_CODES 里`)
  }
})

// ═══════════════════════════════════════════════ ⑤ 信封

test('⑤ 成功/拒绝/请求三种信封的形状固定，且拒绝必有码', () => {
  const ok = wireSuccess({ a: 1 })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.result, { a: 1 })

  const no = wireRefusal(WIRE_CODES.BAD_REQUEST, '坏了', ['因为'])
  assert.equal(no.ok, false)
  assert.equal(no.code, WIRE_CODES.BAD_REQUEST)
  assert.deepEqual(no.details, ['因为'])

  const req = wireRequest({ request: 1 })
  assert.equal(req.request, 1)
})

test('⑤ readEnvelope：版本对不上判 BAD_RESPONSE，而不是尽力解析', () => {
  const wrongVersion = readEnvelope({ ok: true, wireVersion: 999, result: {} })
  assert.equal(wrongVersion.ok, false)
  assert.equal(wrongVersion.code, WIRE_CODES.BAD_RESPONSE)

  const notObject = readEnvelope(null)
  assert.equal(notObject.ok, false)
  assert.equal(notObject.code, WIRE_CODES.BAD_RESPONSE)

  const noOk = readEnvelope({ wireVersion: 1 })
  assert.equal(noOk.ok, false)
  assert.equal(noOk.code, WIRE_CODES.BAD_RESPONSE)

  // 对端的拒绝信封被**原样**带出来（它的码回答了"为什么"）。
  const refused = readEnvelope(wireRefusal(WIRE_CODES.NO_TOKEN, '没配'))
  assert.equal(refused.ok, false)
  assert.equal(refused.code, WIRE_CODES.NO_TOKEN)

  // 正面读：一个合法的成功信封能读出来。
  const good = readEnvelope(wireSuccess('hi'))
  assert.equal(good.ok, true)
  assert.equal(good.result, 'hi')
})

test('⑤ readRequestEnvelope：版本对不上时判 BAD_REQUEST（与服务端口径一致）', () => {
  assert.equal(readRequestEnvelope(wireRequest({})).ok, true)
  const bad = readRequestEnvelope({ wireVersion: 2 })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, WIRE_CODES.BAD_REQUEST)
  const missing = readRequestEnvelope({})
  assert.equal(missing.ok, false, '缺 wireVersion 的请求不得被当成当前版本')
})

// ═══════════════════════════════════════════════ ⑥ NDJSON 帧

test('⑥ 事件行的编解码是一个往返，且**发之前先校验**', () => {
  const line = encodeEventLine(TERMINAL_EVENT)
  assert.ok(line.endsWith('\n'), 'NDJSON 的帧必须以换行结束，否则帧边界要靠连接关闭来猜')
  assert.equal(line.indexOf('\n'), line.length - 1, '一行里不得有内嵌换行')

  const back = decodeEventLine(line)
  assert.equal(back.ok, true)
  assert.equal(back.empty, false)
  assert.equal(back.event.type, TERMINAL_EVENT.type)
  assert.equal(back.event.seq, TERMINAL_EVENT.seq)
})

test('⑥ 坏事件**拒绝编码**（不静默换一个空行）', () => {
  // 一个没有 type 的对象：`validateRunEvent` 必拒。
  assert.throws(() => encodeEventLine({ runId: 'r', seq: 1, at: 1 }), (e) => {
    assert.equal(e.code, WIRE_CODES.ADAPTER_SHAPE_INVALID)
    return true
  })
  assert.throws(() => encodeEventLine(null))
  // 非终态事件缺 result 是合法的；终态缺 result 不是（spec §6.1）。
  const terminalNoResult = { type: 'run.completed', runId: 'r', seq: 1, at: 1 }
  assert.throws(() => encodeEventLine(terminalNoResult))
})

test('⑥ 空行是"空"，不是坏行也不是事件', () => {
  for (const blank of ['', '\n', '\r\n', '   ']) {
    const d = decodeEventLine(blank)
    assert.equal(d.ok, true, `${JSON.stringify(blank)} 该被判为空行`)
    assert.equal(d.empty, true)
    assert.equal(d.event, null)
  }
})

test('⑥ CRLF 行尾能解码（Windows 上的中间层不会凭空多出一种坏帧）', () => {
  const d = decodeEventLine(encodeEventLine(NON_TERMINAL_EVENT).replace('\n', '\r\n'))
  assert.equal(d.ok, true)
  assert.equal(d.event.type, NON_TERMINAL_EVENT.type)
})

test('⑥ 非 JSON / 畸形事件各有各的读数，且都**不**返回事件', () => {
  const notJson = decodeEventLine('{not json')
  assert.equal(notJson.ok, false)
  assert.equal(notJson.event, null)
  assert.ok(notJson.errors.length > 0)

  const malformed = decodeEventLine(JSON.stringify({ type: 'run.started', runId: 'r', seq: 0, at: 1 }))
  assert.equal(malformed.ok, false)
  assert.equal(malformed.event, null)
  assert.ok(malformed.errors.some((m) => m.includes('seq')))
})

test('⑥ ★ 控制帧**不是**事件：它被单独认出来，带上服务端那个码', () => {
  const line = encodeControlFrame(WIRE_CODES.STREAM_NO_TERMINAL, '没有终态', { sawAnyEvent: true })
  const d = decodeEventLine(line)
  assert.equal(d.ok, false)
  assert.equal(d.event, null)
  assert.ok(d.control !== undefined, '控制帧必须被认出来，否则会退化成一句"未知事件类型"')
  assert.equal(d.control.code, WIRE_CODES.STREAM_NO_TERMINAL)
  assert.equal(d.control[WIRE_CONTROL_KEY], WIRE_CONTROL_FRAMES.ERROR)
  assert.deepEqual(d.control.details, { sawAnyEvent: true })

  // 反面：控制帧若被当成事件解析，它会因为"未知事件类型"而被拒——
  // 而那样对端就**读不到**服务端想说的那个码了。两条读数必须不同。
  const asEvent = decodeEventLine(JSON.stringify({ type: 'nonsense', runId: 'r', seq: 1, at: 1 }))
  assert.equal(asEvent.ok, false)
  assert.equal(asEvent.control, undefined)
  assert.notDeepEqual(
    { code: asEvent.errors.join('|') },
    { code: d.control.code },
    '控制帧与"一条畸形事件"必须是两个读数',
  )
})

test('⑥ 控制帧不接受未登记的码（否则它自己成了一条绕过码表的通道）', () => {
  assert.throws(() => encodeControlFrame('NOT_A_REAL_CODE', 'x'), /未登记的码/)
})

test('⑥ isControlFrame 对普通事件与控制帧判定相反（负向对照）', () => {
  assert.equal(isControlFrame(JSON.parse(encodeEventLine(TERMINAL_EVENT))), false)
  assert.equal(isControlFrame(JSON.parse(encodeControlFrame(WIRE_CODES.STREAM_BROKEN, 'x'))), true)
  assert.equal(isControlFrame(null), false)
  assert.equal(isControlFrame([1, 2]), false)
})

test('⑥ isWireTerminalEvent 转发契约判定，不在这里抄一遍那四个字符串', () => {
  assert.equal(isWireTerminalEvent(TERMINAL_EVENT), true)
  assert.equal(isWireTerminalEvent(NON_TERMINAL_EVENT), false)

  // 逐条与契约自己的判定对齐：转发的那一份**不允许多出或少掉**任何一种。
  for (const type of [
    'run.started', 'run.completed', 'run.failed', 'run.cancelled', 'run.outcome_unknown',
    'model.selected', 'message.delta', 'tool.requested', 'tool.started', 'tool.completed',
    'usage.updated', 'artifact.produced', 'context.requested',
  ]) {
    assert.equal(
      isWireTerminalEvent({ type }),
      isTerminalEventType(type),
      `${type} 的终态判定与契约不一致`,
    )
  }
  // 反向锚：终态与非终态确实都存在，否则上面的循环可能空转。
  assert.ok(['run.completed', 'run.failed', 'run.cancelled', 'run.outcome_unknown']
    .every((t) => isWireTerminalEvent({ type: t })))
})

test('⑥ 能力表与需求表仍然来自契约（线上不另立一份）', () => {
  // wire 不导出自己的能力表——它直接用契约的。这里钉住"没有平行的一份"：
  // 若哪天 wire 里出现了一个 `WIRE_CAPABILITIES`，这条会红。
  //
  // ★ 2026-09-21：锚点从 `tool-permission-enforcement` 换成
  // `cancel-and-timeout`。换的理由**不是**前者"不对了"，而是它移出了
  // `REQUIRED_CAPABILITIES`（产品面能力不由引擎自答）⇒ 拿它当"必需表非空"的
  // 锚会红；而这条用例要钉的是"wire 用的是契约那份表"，与**表里有哪几项无关**。
  //
  //   > 一条拿"某一项在不在表里"当锚的用例，与一条拿"这张表从哪来"当锚的用例，
  //   > 在表**内容**变动的那天分得开——只不过前者的红指向 wire，而 wire 没动。
  //
  // ★ 并补一条正向断言：产品面那一项**不许**回到必需表里。
  assert.equal(REQUIRED_CAPABILITIES.includes('cancel-and-timeout'), true)
  assert.equal(REQUIRED_CAPABILITIES.includes('tool-permission-enforcement'), false,
    'tool-permission-enforcement 是产品面能力（PRODUCT_PLANE_CAPABILITIES），' +
    '回到必需表会让引擎探针又去答一个它不负责的问题')
})
