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
