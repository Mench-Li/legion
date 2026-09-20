// team-hub/tool-call-http.test.mjs
// ============================================================================
// PRT-610 的路由判据（**真 HTTP**，不是直接调函数）。
//
// 这一批要钉住的东西几乎全都在"函数之外"：
//
//   ① ★★★ 就绪判据 `decisionSourceRecorded` 终于有了**产出点**。
//      在此之前它全仓没有产出者，于是 `release-gate.mjs` 那一项永远判否——
//
//        > 一个「判据说缺少证据、而没有任何地方能提供证据」的判据，
//        > 与一个「永远判否」的判据，是同一个东西——只不过前者看起来更谨慎。
//
//   ② 它必须报**三态**（表不在 / 读不出来 / 读得出来），而不是一个布尔：
//      "表还没建"（全新部署，正常）与"库读不出来"（故障）要能分开。
//
//   ③ 路由守卫必须是**字面量**而不是正则：`baseline-snapshot.mjs` 的抽取器
//      只认字面量，正则守卫会**悄悄**不进平台契约（PRT-507 那个坑）。
//
//   ④ 顺序：`/api/tool-calls` 是 `/api/tool-calls/evidence` 的前缀。
//      前缀先匹配就会把更长的路径吃掉——而这个错误**只在这两条路由都在时**才出现。
// ============================================================================
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TOKEN = 'tool-call-http-token'
const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-toolcall-http-'))
let mod
let base = ''

// ★ 环境变量必须在 `import('./server.mjs')` **之前**设好，而这个 import 必须
//   发生在 `before()` 里：`server.mjs` 在模块求值期就开了库。
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

async function call(path, { auth = true } = {}) {
  const res = await fetch(`${base}${path}`, { headers: auth ? AUTH : {} })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON 时保留原文 */ }
  return { status: res.status, json, text }
}

test('① ★★★ `/api/tool-calls/evidence` 是就绪判据的产出点（此前后者永远判否）', async () => {
  const r = await call('/api/tool-calls/evidence')
  assert.equal(r.status, 200)
  // 这个字段名必须和 `release-gate.mjs` 里读的那个**逐字相同**——
  // 差一个字母，那一项就永远拿到 `undefined`，而 `undefined` 按否处理，
  // 于是"接线错了"与"真的没记录"长得一模一样。
  assert.ok('decisionSourceRecorded' in r.json, `响应里没有 decisionSourceRecorded：${Object.keys(r.json)}`)
  assert.equal(typeof r.json.decisionSourceRecorded, 'boolean')
  // ★ 严格布尔：`'false'` 是 truthy，而那正是"把没记录读成记录"的形状。
  assert.equal(r.json.decisionSourceRecorded, false)
  // 三态之一，且是"表在但没记录"这一态（server.mjs 已经建过表）。
  assert.equal(r.json.state, 'readable')
  assert.equal(r.json.recorded, false)
  assert.equal(r.json.table, 'tool_calls')
})

test('① ★★★ 写进一条真实调用之后，证据真的翻成 true（正对照）', async () => {
  // 少了这一条，上面那些 `false` 可能只是"这个字段永远 false"——
  //   > 一个恒定 false 的读数，与一个正确报出"没有证据"的读数，
  //   > 在只断言 false 的用例下是同一条绿。
  const { recordToolCall } = await import('./tool-call-log.mjs')
  recordToolCall({
    db: mod.db,
    callId: 'http-1',
    toolName: 'file_write',
    decision: 'deny',
    decisionSource: 'guard',
    reason: 'hard floor',
    rawInput: { path: '/w/a.txt' },
    canonicalInput: { path: '/w/a.txt' },
    canonicalHash: 'hash-http-1',
    atText: '2026-09-12T00:00:01.000Z',
  })
  const r = await call('/api/tool-calls/evidence')
  assert.equal(r.json.recorded, true, '有了带来源的记录，证据必须翻成 true')
  assert.equal(r.json.decisionSourceRecorded, true)
  assert.equal(r.json.sourced, 1)
})

test('② ★★ evidence 要 401 之前先鉴权（安全项不能匿名读）', async () => {
  const r = await call('/api/tool-calls/evidence', { auth: false })
  assert.equal(r.status, 401)
})

test('③ ★★ 路由守卫是字面量，且 `/api/tool-calls` 不会吃掉 `/evidence`', async () => {
  // 前缀与子路径同时存在时，顺序错会让 `/evidence` 返回**统计**（200，形状不同），
  // 而不是 404 —— 于是它看起来"能用"，只是字段对不上。
  const stats = await call('/api/tool-calls')
  assert.equal(stats.status, 200)
  assert.ok(Array.isArray(stats.json.counts), '/api/tool-calls 应返回 counts 数组')
  assert.equal('decisionSourceRecorded' in stats.json, false,
    '/api/tool-calls 返回了 evidence 的字段——前缀把子路径吃掉了')

  const ev = await call('/api/tool-calls/evidence')
  assert.equal(ev.status, 200)
  assert.ok('decisionSourceRecorded' in ev.json, '/evidence 被前缀路由吃掉了')
  assert.equal(Array.isArray(ev.json.counts), false, '/evidence 返回了统计的形状')
})

test('③ ★★ 统计面把"两类拒绝的修复动作不同"直接答出来（§6.8 line 480）', async () => {
  const r = await call('/api/tool-calls')
  assert.equal(r.status, 200)
  // 每个来源的可能决定都要在响应里，否则调用方看不出"这一栏缺了哪一类"
  assert.deepEqual(Object.keys(r.json.sourceDecisions).sort(),
    ['approval', 'guard', 'pre-execute', 'sandbox'])
  assert.deepEqual(r.json.sourceDecisions.guard, ['deny'])
  assert.deepEqual(r.json.sourceDecisions.sandbox, ['deny'])
  // 修复动作必须是**不同的字符串**，而且沙箱那条要明说"改策略没有效果"
  assert.notEqual(r.json.sourceRepairActions.sandbox, r.json.sourceRepairActions['pre-execute'])
  assert.match(r.json.sourceRepairActions.sandbox, /沙箱/)
  // 按来源分组：刚才那条 guard/deny 要在里面
  const guardDeny = r.json.counts.find((c) => c.decisionSource === 'guard' && c.decision === 'deny')
  assert.equal(guardDeny.count, 1)
  // `decision` 筛选要真的生效
  const onlyDeny = await call('/api/tool-calls?decision=deny')
  assert.equal(onlyDeny.json.counts.every((c) => c.decision === 'deny'), true)
  const onlyAsk = await call('/api/tool-calls?decision=ask')
  assert.deepEqual(onlyAsk.json.counts, [])
})

test('③ ★★ 统计面是只读的（**刻意没有**写路径）', async () => {
  // 一次工具调用的账必须来自那一次真实执行（raw 与 canonical 要对得起来）。
  // 放一条手工写入口，等于允许控制面凭空造一条"执行过"的记录：
  //
  //   > 一个「可以由外部直接写入」的执行账，
  //   > 与一个「审计里的执行历史可以是任意值」的账，是同一个东西。
  const res = await fetch(`${base}/api/tool-calls`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ callId: 'forged', toolName: 'x', decision: 'allow', decisionSource: 'pre-execute' }),
  })
  assert.notEqual(res.status, 200, '存在一条可以手工写入执行账的路径')
  const after = await call('/api/tool-calls/evidence')
  assert.equal(after.json.total, 1, 'POST 竟然写进了账里')
})

test('④ ★★ `/repair` 让值班的人直接读出"该去改哪里"', async () => {
  const r = await call('/api/tool-calls/repair?callId=http-1')
  assert.equal(r.status, 200)
  assert.equal(r.json.call.decisionSource, 'guard')
  assert.equal(r.json.call.decision, 'deny')
  // 关键：修复动作要**指向 guard 那一类**，而不是笼统地说"策略拒绝"
  assert.equal(r.json.repair.denied, true)
  assert.match(r.json.repair.repairAction, /hard floor|工具声明/)
  assert.equal(/沙箱/.test(r.json.repair.repairAction), false,
    'guard 的修复动作把值班的人指向了沙箱——那是另一类拒绝的修法')
  // `isSandboxFallback` 是给值班的人看的**第三层**区分：沙箱兜底不是策略问题
  assert.equal(r.json.repair.isSandboxFallback, false)

  // 非拒绝的行 → `explainRejection` 如实报 denied:false，而不是编一个动作
  const { recordToolCall } = await import('./tool-call-log.mjs')
  recordToolCall({
    db: mod.db, callId: 'http-allow', toolName: 'file_read', decision: 'allow',
    decisionSource: 'pre-execute', rawInput: { path: '/w/a' }, canonicalInput: { path: '/w/a' },
    canonicalHash: 'hash-http-allow', atText: '2026-09-12T00:00:02.000Z',
  })
  const allow = await call('/api/tool-calls/repair?callId=http-allow')
  assert.equal(allow.status, 200)
  assert.equal(allow.json.repair.denied, false, '把一次放行读成了需要修复')
  assert.equal(allow.json.repair.repairAction, null, '放行不该有一个修复动作')
})

test('④ ★★ `/repair` 缺 callId 是 400（不是 404，也不是猜一个来源）', async () => {
  //   > 一条拒绝的修复动作由**它的来源**决定；没有 callId 就只能靠猜，
  //   > 而猜错的修复动作会把人指向错误的文件。
  for (const q of ['', '?callId=', '?callId=%20']) {
    const r = await call(`/api/tool-calls/repair${q}`)
    assert.equal(r.status, 400, `${q} 应当是 400（缺参数），实际 ${r.status}`)
    assert.equal(r.json.code, 'TOOL_CALL_REPAIR_NEEDS_CALL_ID')
  }
  // 给了 callId 但查不到 → 404，而且要说清是**哪一个** callId
  const miss = await call('/api/tool-calls/repair?callId=never-existed')
  assert.equal(miss.status, 404)
  assert.equal(miss.json.code, 'TOOL_CALL_NOT_FOUND')
  assert.match(miss.json.error, /never-existed/)
})

test('④ ★★ `/repair` 的键归一化与写入侧**同一份**（否则查不到与没记录过同形）', async () => {
  // 写入侧用 `toolCallIdempotencyKey` 归一化（trim + NFC）。读取侧若自己 trim 一遍，
  // 就会出现"用 A 的键写、用 B 的键读"——而"查不到"与"从来没记过"长得一样。
  const { recordToolCall } = await import('./tool-call-log.mjs')
  recordToolCall({
    db: mod.db, callId: '  spaced-call  ', toolName: 'file_read', decision: 'deny',
    decisionSource: 'sandbox', rawInput: { path: '/w/a' }, canonicalInput: { path: '/w/a' },
    canonicalHash: 'hash-spaced', atText: '2026-09-12T00:00:03.000Z',
  })
  // 带空白的查询也要命中（写入侧 trim 过）
  const r = await call(`/api/tool-calls/repair?callId=${encodeURIComponent('  spaced-call  ')}`)
  assert.equal(r.status, 200, '读取侧没有用与写入侧同一份归一化')
  assert.equal(r.json.call.decisionSource, 'sandbox')
  // 沙箱兜底的修复动作必须明说"这不是策略问题"
  assert.match(r.json.repair.repairAction, /沙箱/)
})

test('⑤ ★ 三条路由都要求鉴权', async () => {
  for (const p of ['/api/tool-calls', '/api/tool-calls/evidence', '/api/tool-calls/repair?callId=http-1']) {
    const r = await call(p, { auth: false })
    assert.equal(r.status, 401, `${p} 未鉴权时应当是 401，实际 ${r.status}`)
  }
})

// ══════════════════════════════════════════════════════════════════════════════
// ④ PRT-316 切片 11：tool-calls 族搬进 `routes/tool-calls.mjs` 之后的**缝上契约**
//
// 破验 16 条，第一轮咬住 13 条、漏网 3 条。三条**全是真缺口**，且三条各有一个理由：
//
//   K2  `table` —— 统计面回了 `TOOL_CALL_TABLE`（"哪些表在记"），没有任何用例断言过它。
//   K6  `?decision=` 空串 —— ★ 真行为差异，不是等价：store 里是
//         `decision === null ? 全量 GROUP BY : WHERE decision=?`
//         ⇒ 空串会走**另一条 SQL 分支**，查出 **0 行**；而 null 查全量。
//         "给了空串"与"没给"在调用方是同一个意图，在这里却是两个结果。
//   K8  `decisionSourceRecorded: ev.recorded === true` —— 模块里专门写了一段注释
//         解释**为什么是严格比较**（`'false'` 这个字符串是 truthy，
//         而那正是"把没记录读成记录"的形状）。
//         ★ 而这段注释所指的那个场景，**没有任何用例造出来过**：
//           既有用例喂的是 store 真实返回的布尔。
//         ⇒ 用替身喂**那个字符串本身**，这条防御才有判据。
//
//   > 一条"为了挡住某个具体形状"而写下的判据，与一条"顺手写严格一点"的判据，
//   > 在没有用例造出那个形状的时候，是同一个东西。
//
// ▲ 这一族**全是只读**：三条 GET，没有 `handleRun`（模块里有一段长注释解释
//   为什么刻意没有写路径）。所以这里的替身**没有** `handleRun` —— 第一族如此。
// ▲ 既有 10 例仍在**真 hub** 上验（不替换、不删除）。
// ▲ 追加而非新建文件：`git ls-files "*.test.mjs"` 的条数被 `boundary-facts` 钉着。
// ══════════════════════════════════════════════════════════════════════════════

import { createToolCallsRoutes } from './routes/tool-calls.mjs'

/** 会记录调用的假依赖（三条路由**都不写**，所以没有 `handleRun`）。 */
function tcSpy(over = {}) {
  const calls = []
  const sent = []
  const deps = {
    json: (_res, code, obj) => { sent.push([code, obj]) },
    authorized: over.authorized ?? (() => true),
    TOOL_CALL_TABLE: 'tool_calls',
    DECISION_SOURCES: ['policy', 'sandbox'],
    SOURCE_DECISIONS: { policy: ['allow', 'deny'], sandbox: ['allow', 'deny'] },
    SOURCE_REPAIR_ACTIONS: { policy: '改策略文件', sandbox: '改沙箱配置' },
    countBySource: (a) => { calls.push(['counts', a]); return over.counts ?? [{ decisionSource: 'policy', decision: 'deny', count: 1 }] },
    toolCallLogEvidence: (a) => { calls.push(['evidence', a]); return over.evidence ?? { state: 'ok', table: 'tool_calls', recorded: true, rows: 3 } },
    readToolCall: (a) => { calls.push(['read', a]); return over.row === undefined ? { callId: 'c1', decision: 'deny', decisionSource: 'policy' } : over.row },
    toolCallIdempotencyKey: (a) => { calls.push(['key', a]); return `k:${String(a?.callId ?? '').trim()}` },
    explainRejection: (row) => { calls.push(['explain', row]); return { ok: false, repairAction: '改策略文件' } },
    db: { __db: true },
  }
  const fam = createToolCallsRoutes(deps)
  const dispatch = (target) => {
    const url = new URL(`http://x${target}`)
    return fam.dispatch({ method: 'GET', headers: {} }, {}, { path: url.pathname, url })
  }
  return { dispatch, calls, sent }
}
const last = (calls, n) => calls.filter((c) => c[0] === n).at(-1)

test('④ ★★ K16：`exact` 不许退化成前缀 —— `/api/tool-calls` 不许吃掉 `/evidence`', async () => {
  // 模块里专门标注了这个顺序（"放在 `/api/tool-calls` 之后，否则前缀会先把这个
  // 更长的路径吃掉；这个顺序本身就是一处会安静失效的地方"）。
  // 既有用例 ③ 验过它在**当前顺序**下没被吃掉 —— 但没验"精确匹配"本身。
  const s = tcSpy()
  for (const p of ['/api/tool-callsX', '/api/tool-calls/evidenceX', '/api/tool-calls/repair/x',
    '/api/tool-calls/evidence/more', '/api/tool-call']) {
    assert.equal(await s.dispatch(p), false, `GET ${p} 被本族接住了 —— exact 退化了？`)
  }
  assert.deepEqual(s.calls, [], '未匹配的请求却碰了仓储')
  for (const [p, fn] of [['/api/tool-calls', 'counts'], ['/api/tool-calls/evidence', 'evidence'],
    ['/api/tool-calls/repair?callId=c1', 'read']]) {
    const ok = tcSpy()
    assert.equal(await ok.dispatch(p), true, `GET ${p} 没被接住`)
    assert.ok(last(ok.calls, fn), `GET ${p} 没走到 ${fn}`)
  }
})

test('④ ★★ K6：`?decision=` 空串必须按"没给"处理（不是另一个 SQL 分支）', async () => {
  // ★ 这是**真行为差异**：store 里 `decision === null` 走全量 GROUP BY，
  //   否则走 `WHERE decision=?` —— 空串会查出 **0 行**。
  //   "给了空串"与"没给"在调用方是同一个意图，在这里却是两个结果。
  for (const q of ['', '?decision=']) {
    const s = tcSpy()
    await s.dispatch(`/api/tool-calls${q}`)
    assert.equal(last(s.calls, 'counts')?.[1]?.decision, null,
      `decision=${JSON.stringify(q)} 没有被折成 null（会走 WHERE 分支查出 0 行）`)
  }
  // ★ 但**只有**空串会折：空白串（`%20`）**不折**，原样下传。
  //   我第一版顺手断言了 `?decision=%20` 也折成 null —— 那是照着"我以为的实现"写的，
  //   实测它透传 `' '`，于是 store 走 WHERE 分支查出 0 行。
  //   （*一条照着"我脑子里那个实现"写出来的断言，与一条照着真实实现写出来的断言，
  //   在**它通过**的时候是同一个东西* —— 这是本会话第三次栽在同一处。）
  //   ⇒ 只把**真值**记成契约，不顺手改行为（零改写是纪律）。
  //   与切片 9 的负数 `limit`、切片 8 的 `scope`/`enabled` 同属既有的**不对称**。
  const blank = tcSpy()
  await blank.dispatch('/api/tool-calls?decision=%20')
  assert.equal(last(blank.calls, 'counts')?.[1]?.decision, ' ',
    '空白 decision 的处置变了 ⇒ 请复核 store 的 `decision === null` 分支')
  const given = tcSpy()
  await given.dispatch('/api/tool-calls?decision=deny')
  assert.equal(last(given.calls, 'counts')?.[1]?.decision, 'deny', '真档位没有被透传')
})

test('④ ★★ K2：统计面必须答出「哪些表在记」（`table`）', async () => {
  const s = tcSpy()
  await s.dispatch('/api/tool-calls')
  assert.equal(s.sent.at(-1)?.[1]?.table, 'tool_calls', '统计面没有回 table')
})

// ★ 用例名里**不能**出现裸的单引号：整条名字本身就是单引号字符串。
//   第一版写的是 `（\`'false'\` 不许读成 true）`，于是这里成了
//   `SyntaxError: missing ) after argument list` —— 一个把**测试的标题**
//   写坏了的错误，报的却是"参数列表少了右括号"。
test('④ ★★ K8：`decisionSourceRecorded` 必须是**严格布尔**（字符串 "false" 不许读成 true）', async () => {
  // 模块里专门解释了为什么是 `=== true`：`'false'` 这个字符串是 truthy，
  // 而那正是"把没记录读成记录"的形状。
  // ★ 既有用例喂的是 store 真实返回的布尔，于是这段防御**从来没有被造出来过**。
  for (const [recorded, want] of [[true, true], [false, false], ['false', false], ['true', false],
    [1, false], [0, false], [null, false], [undefined, false]]) {
    const s = tcSpy({ evidence: { state: 'ok', table: 'tool_calls', recorded } })
    await s.dispatch('/api/tool-calls/evidence')
    assert.equal(s.sent.at(-1)?.[1]?.decisionSourceRecorded, want,
      `recorded=${JSON.stringify(recorded)} 被判成了 ${s.sent.at(-1)?.[1]?.decisionSourceRecorded}（期望 ${want}）`)
  }
})

test('④ ★ 就绪证据必须**从库里读**，不许由调用方传一个它自己相信的布尔', async () => {
  // 既有用例 ①/② 已经验过"产出点存在"与"写入后翻 true"。
  // 这里补的是**来源**：它必须真的去问 store（而不是这一层凭空给 true）。
  const s = tcSpy()
  await s.dispatch('/api/tool-calls/evidence')
  const ev = last(s.calls, 'evidence')
  assert.ok(ev, 'evidence 没有去问 store')
  assert.deepEqual(Object.keys(ev[1]), ['db'], 'evidence 收到了不该有的入参')
  // store 的其它字段要**摊开**（调用方要能看到"为什么判否"）
  const b = s.sent.at(-1)?.[1]
  assert.equal(b.ok, true)
  assert.equal(b.state, 'ok', 'store 的 state 没有被摊开')
  assert.equal(b.table, 'tool_calls')
  assert.equal(b.rows, 3)
  // 表不存在时 store 会回 `state` 别的值 —— 那也要原样透出去，不许吞掉
  const bad = tcSpy({ evidence: { state: 'unreadable', table: 'tool_calls', recorded: false } })
  await bad.dispatch('/api/tool-calls/evidence')
  assert.equal(bad.sent.at(-1)?.[1]?.state, 'unreadable', 'store 的"读不出来"被吞掉了')
  assert.equal(bad.sent.at(-1)?.[1]?.decisionSourceRecorded, false)
})

test('④ 三条路由：未授权 401 且**不查仓储**', async () => {
  for (const p of ['/api/tool-calls', '/api/tool-calls/evidence', '/api/tool-calls/repair?callId=c1']) {
    const s = tcSpy({ authorized: () => false })
    assert.equal(await s.dispatch(p), true)
    assert.equal(s.sent.at(-1)?.[0], 401, `${p} 没有 401`)
    assert.deepEqual(s.calls, [], `${p} 在未授权时仍然查了仓储`)
  }
})

test('④ ★★ 这一族**刻意没有写路径**：任何非 GET 都不许被接住', async () => {
  // 模块里用一整段注释解释这件事：一次工具调用的账要记
  // 「原始输入 + canonical 输入 + 哈希 + 决定来源 + 结果状态」，
  // 其中输入必须来自**那一次真实的执行**。放一条"手工记一笔"的 HTTP 写口，
  // 等于允许控制面凭空造出一条"执行过"的记录。
  //
  // > 一个「可以由外部直接写入」的执行账，与一个「没有账」的执行账，
  // > 在事后复盘里都会让人得出错误结论 —— 只不过前者的账看起来是完整的。
  const url = new URL('http://x/api/tool-calls')
  const fam = createToolCallsRoutes({
    json: () => {}, authorized: () => true,
    TOOL_CALL_TABLE: 'tool_calls', DECISION_SOURCES: [], SOURCE_DECISIONS: {}, SOURCE_REPAIR_ACTIONS: {},
    countBySource: () => [], toolCallLogEvidence: () => ({ recorded: false }),
    readToolCall: () => null, toolCallIdempotencyKey: () => 'k', explainRejection: () => ({}),
    db: { __db: true },
  })
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const p of ['/api/tool-calls', '/api/tool-calls/evidence', '/api/tool-calls/repair']) {
      assert.equal(await fam.dispatch({ method: m, headers: {} }, {}, { path: p, url }),
        false, `${m} ${p} 被接住了 —— 执行账出现了写口`)
    }
  }
})

test('④ ★ `/repair` 的两条具名拒绝路径（缺 callId / 查不到）码与语义都对', async () => {
  // 既有用例 ④ 验过这两种情况；这里把**具名码**与"没有多余的仓储访问"钉住。
  const missing = tcSpy()
  await missing.dispatch('/api/tool-calls/repair')
  assert.equal(missing.sent.at(-1)?.[0], 400)
  assert.equal(missing.sent.at(-1)?.[1]?.code, 'TOOL_CALL_REPAIR_NEEDS_CALL_ID')
  assert.equal(missing.calls.filter((c) => c[0] === 'read').length, 0, '缺 callId 却去查了库')
  // 空白串与"没给"同样按"没给"处理
  const blank = tcSpy()
  await blank.dispatch('/api/tool-calls/repair?callId=%20%20')
  assert.equal(blank.sent.at(-1)?.[1]?.code, 'TOOL_CALL_REPAIR_NEEDS_CALL_ID')
  assert.equal(blank.calls.filter((c) => c[0] === 'read').length, 0)

  const notFound = tcSpy({ row: null })
  await notFound.dispatch('/api/tool-calls/repair?callId=nope')
  assert.equal(notFound.sent.at(-1)?.[0], 404, '查不到应当是 404（不是 400，也不是猜一个来源）')
  assert.equal(notFound.sent.at(-1)?.[1]?.code, 'TOOL_CALL_NOT_FOUND')
  assert.equal(notFound.calls.filter((c) => c[0] === 'explain').length, 0, '查不到却去解释了')
})

test('④ ★ `/repair` 的键必须与写入侧**同一份**归一化', async () => {
  // 既有用例 ④ 验过"两处归一化一致"。这里补**方向**：路由必须把**原始 callId**
  // 交给归一化函数，而不是先自己 trim 一次再交给它
  // —— 两处各归一化一次就会出现"用 A 的键写、用 B 的键读"。
  for (const raw of ['c1', '  c1  ', 'c 1']) {
    const s = tcSpy()
    await s.dispatch(`/api/tool-calls/repair?callId=${encodeURIComponent(raw)}`)
    assert.deepEqual(last(s.calls, 'key')?.[1], { callId: raw },
      `callId=${JSON.stringify(raw)} 在路由层被预处理过了（应当原样交给归一化函数）`)
    assert.equal(last(s.calls, 'read')?.[1]?.idempotencyKey, `k:${raw.trim()}`)
  }
})
