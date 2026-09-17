// team-hub/compaction-http.test.mjs
// ============================================================================
// F-17 的**接线**判据：真 hub 进程 + 真 HTTP。
//
// `compaction-store.test.mjs` 的 14 例验的是仓储语义。它全绿也可能
// **没有任何 HTTP 面能走到那些函数**——正是本仓反复记过的形状：
// "能力齐全、用例全绿、而没有调用方"。
//
// 本组只钉四件只有真接线才有的事：
//   ① 原文追加走 HTTP，重复 seq 被 409 拒；
//   ② `baseVersion` 的 CAS 在 HTTP 层**照样生效**（不因为过了序列化而失效）；
//   ③ `context` 端点拼出的东西里**不再出现被压缩的原文**；
//   ④ 版本史端点能取回旧版（"曾经有过一个更好的摘要"必须可证明）。
// ============================================================================
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-compact-http-'))
let mod
let base = ''
const TOKEN = 'compact-e2e-token'
const S = 'sess-e2e'

before(async () => {
  process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_TOKEN = TOKEN
  process.env.TEAM_HUB_HOST = '127.0.0.1'
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

const auth = { authorization: `Bearer ${TOKEN}` }
async function post(path, body) {
  const r = await fetch(base + path, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}
async function get(path) {
  const r = await fetch(base + path, { headers: auth })
  return { status: r.status, body: await r.json().catch(() => null) }
}
async function seed(n) {
  for (let i = 1; i <= n; i += 1) {
    const r = await post('/api/compaction/messages', {
      sessionId: S, seq: i, role: i % 2 === 1 ? 'user' : 'assistant', content: `第 ${i} 条消息的原文内容`,
    })
    assert.equal(r.status, 200, JSON.stringify(r.body))
  }
}

test('① 原文追加走 HTTP；重复 seq 被 409 拒（不覆盖）', async () => {
  await seed(6)
  const dup = await post('/api/compaction/messages', { sessionId: S, seq: 1, role: 'user', content: '改过的内容' })
  assert.equal(dup.status, 409, JSON.stringify(dup.body))
  const src = await get(`/api/compaction/context?sessionId=${S}`)
  assert.equal(src.body.parts[0].text, '第 1 条消息的原文内容', '原文被改写了')
  const badSeq = await post('/api/compaction/messages', { sessionId: S, seq: -3, role: 'user', content: 'x' })
  assert.equal(badSeq.status, 400)
  assert.equal(badSeq.body.code, 'COMPACTION_BAD_RANGE')
  // ★ 分层：HTTP 边界用 `requireString` 统一答 `MISSING_PARAM`（缺字段与
  //   全空白是同一件事），所以仓储自己的 `COMPACTION_SESSION_REQUIRED`
  //   在**这条路由上**是走不到的。两个码都指向同一个 400，不是缺口——
  //   但写成"期望 COMPACTION_SESSION_REQUIRED"会让这条用例永远红，
  //   而红的位置指向一个与真实原因无关的地方。
  //
  //   这里**不**为了断言那个码而给 server.mjs 加一个测试专用导出：
  //   仓储层的码由 `compaction-store.test.mjs` ①⑧ 直接验（它是同一个
  //   函数的真调用方，而不是一个为了测试才存在的旁门）。
  const noSess = await post('/api/compaction/messages', { sessionId: '', seq: 1, role: 'user', content: 'x' })
  assert.equal(noSess.status, 400)
  assert.equal(noSess.body.code, 'MISSING_PARAM')
  const blankSess = await post('/api/compaction/messages', { sessionId: '   ', seq: 1, role: 'user', content: 'x' })
  assert.equal(blankSess.status, 400)
  assert.equal(blankSess.body.code, 'MISSING_PARAM')
})

test('② ★ baseVersion 的 CAS 在 HTTP 层照样生效', async () => {
  const first = await post('/api/compaction/summarize', {
    sessionId: S, coversFromSeq: 1, coversToSeq: 2, summary: '前两条的摘要', by: 'auto-e2e',
  })
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.summary.version, 1)
  assert.equal(first.body.coveredCount, 2)
  assert.equal(typeof first.body.savedTokens, 'number')

  // 第二个并发压缩还拿着"我认为还没有任何摘要"的观点 → 必须 409。
  const stale = await post('/api/compaction/summarize', {
    sessionId: S, coversFromSeq: 3, coversToSeq: 4, summary: '第二批', by: 'auto-e2e', baseVersion: null,
  })
  assert.equal(stale.status, 409, JSON.stringify(stale.body))
  assert.equal(stale.body.code, 'COMPACTION_VERSION_CONFLICT')

  // 带上正确的 baseVersion 就能过。
  const ok = await post('/api/compaction/summarize', {
    sessionId: S, coversFromSeq: 3, coversToSeq: 4, summary: '第二批', by: 'auto-e2e', baseVersion: 1,
  })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.equal(ok.body.summary.version, 2)

  // 引用了不存在的原文 → 内容完整性错误（不是 400 参数错误）。
  const dangling = await post('/api/compaction/summarize', {
    sessionId: S, coversFromSeq: 5, coversToSeq: 99, summary: 'x', by: 'auto-e2e', baseVersion: 2,
  })
  assert.equal(dangling.status, 409, JSON.stringify(dangling.body))
  assert.equal(dangling.body.code, 'COMPACTION_DANGLING_REFERENCE')

  // 没有 by → 边界答 MISSING_PARAM（同 ① 的分层说明；仓储层的
  // `COMPACTION_ACTOR_REQUIRED` 由 store 用例⑧直接验）。
  const noActor = await post('/api/compaction/summarize', {
    sessionId: S, coversFromSeq: 5, coversToSeq: 5, summary: 'x', baseVersion: 2,
  })
  assert.equal(noActor.status, 400)
  assert.equal(noActor.body.code, 'MISSING_PARAM')
})

test('③ ★ context 端点里**不再出现**被压缩的原文，且摘要排在前面', async () => {
  const ctx = await get(`/api/compaction/context?sessionId=${S}`)
  assert.equal(ctx.status, 200)
  const kinds = ctx.body.parts.map((p) => p.kind)
  assert.equal(kinds[0], 'summary', '摘要不在最前面 —— 拼出来的是一段语义错乱但仍合法的文本')
  const seqs = ctx.body.parts.filter((p) => p.kind === 'message').map((p) => p.seq)
  assert.deepEqual(seqs, [5, 6],
    '被压缩的 1..4 又出现在了上下文里 —— 那会被算两次 token（实际 ' + JSON.stringify(seqs) + '）')
  assert.equal(ctx.body.truncated, false)
  assert.equal(ctx.body.isPartial, false)
  // token 合计可解释（等于各部分之和，不给一个"算出来但解释不了"的数）。
  assert.equal(ctx.body.totalTokens, ctx.body.parts.reduce((a, p) => a + p.tokens, 0))
})

test('④ 版本史能取回旧版；state 端点给出压缩程度', async () => {
  const sums = await get(`/api/compaction/summaries?sessionId=${S}`)
  assert.equal(sums.status, 200)
  assert.equal(sums.body.summaries.length, 2, '旧版被覆盖了 —— "曾经有过一个更好的摘要"无法证明')
  assert.equal(sums.body.summaries[0].version, 1)
  assert.equal(sums.body.summaries[0].summary, '前两条的摘要')
  assert.equal(sums.body.summaries[1].version, 2)

  const st = await get(`/api/compaction/state?sessionId=${S}`)
  assert.equal(st.status, 200)
  assert.equal(st.body.versions, 2)
  assert.equal(st.body.latestVersion, 2)
  assert.equal(st.body.byState.compacted.count, 4)
  assert.equal(st.body.byState.active.count, 2)
  assert.equal(st.body.settled, true)
  assert.deepEqual([...st.body.unrecognizedStates], [])
})

test('⑤ maxTokens 截断：isPartial 与"刚好装下"分得开；摘要永不丢', async () => {
  const full = await get(`/api/compaction/context?sessionId=${S}`)
  const tight = Math.max(1, full.body.totalTokens - 3)
  const cut = await get(`/api/compaction/context?sessionId=${S}&maxTokens=${tight}`)
  assert.equal(cut.status, 200)
  assert.equal(cut.body.truncated, true)
  assert.equal(cut.body.isPartial, true)
  assert.ok(cut.body.parts.some((p) => p.kind === 'summary'),
    '摘要被丢掉了 —— 丢掉摘要等于把"曾经压缩过一次"忘掉，下一轮会把那些原文重新当成 active')
  assert.ok(cut.body.totalTokens <= tight)
  // 上限给足 → 不截断。
  const roomy = await get(`/api/compaction/context?sessionId=${S}&maxTokens=${full.body.totalTokens}`)
  assert.equal(roomy.body.isPartial, false)
  // 缺参数与鉴权。
  assert.equal((await get('/api/compaction/context')).status, 400)
  assert.equal((await get('/api/compaction/state')).status, 400)
  for (const p of ['/api/compaction/context?sessionId=x', '/api/compaction/state?sessionId=x', '/api/compaction/summaries?sessionId=x']) {
    assert.equal((await fetch(base + p)).status, 401, `${p} 没有鉴权`)
  }
  assert.equal((await post('/api/compaction/summarize', { sessionId: S, coversFromSeq: 1, coversToSeq: 1, summary: 'x', by: 'y' })).status, 409)
})
