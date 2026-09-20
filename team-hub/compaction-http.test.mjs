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
import { describe, it } from 'node:test'
import { createCompactionRoutes } from './routes/compaction.mjs'
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

// ══════════════════════════════════════════════════════════════════════════════
// PRT-316 切片 5：搬走的 compaction 族的**缝上契约**
//
// 为什么补：破验 11 条变异，第一轮咬住 8 条。逐条查清后**两条是等价、一条是真缺口**：
//
//   ★ K1（`baseVersion === undefined ? null : baseVersion` 改写成 `?? null`）
//     是**可穷举证明的观测等价**：对 undefined / null / 0 / 1 / -1 / '' / 'x' / false / NaN
//     全部输入逐一求值，两边结果 `Object.is` 相同（含 NaN）。
//     它不是"没人测"，而是"改了也测不出来"。
//
//   ★★ K7（`Number(e?.statusCode) || 400` 改成恒 `400`）是**真缺口**：
//     `compaction-store` 里 `fail(code, msg, extra, statusCode = 400)` 确实会抛
//     404（会话无原文）、409（CAS/重叠）、500（库内不一致），但既有的 5 例
//     只把 **409 与 401** 走到了 —— 而那两条路径走的是 `handleRun`，
//     **不是** `context` 路由的 catch。于是"非 400 的 statusCode 会被吞成 400"
//     这件事在 HTTP 面上从来没有被观测过。
//
//     > 一个"错误码映射"的分支，与一个"从来没有非 400 抛错经过它"的分支，
//     > 在用例全绿时是同一个东西——只不过前者把 500 报成了 400。
//
//     ⇒ 用**注入桩**直接把 500 抛进那条 catch（不需要伪造库内不一致）。
//
// ★ 判据打在**缝**上（注入桩）：本片改动引入的正是缝。既有 5 例仍在**真 hub** 上验。
// ★ 追加而非新建文件：`git ls-files "*.test.mjs"` 的条数被 `boundary-facts` 钉着。
// ══════════════════════════════════════════════════════════════════════════════

const COMPACT_DEPS = ['handleRun', 'requireString', 'authorized', 'compactionStore']

/** 一条**合法**的写请求体：桩替掉了真 `handleRun`，所以由桩提供解析结果。 */
const COMPACT_BODY = {
  sessionId: 'sess', seq: 1, role: 'user', content: 'x',
  coversFromSeq: 1, coversToSeq: 1, summary: 'x', by: 'me', author: 'model',
}

/** 造一个 compaction 族：记录注入点调用；`compactionStore` 可用 overrides 覆写方法。 */
function compSpy(over = {}) {
  const calls = { sent: [], run: [], store: [] }
  const store = {
    appendMessage: (a) => { calls.store.push(['appendMessage', a]); return { seq: a.seq } },
    proposeSummary: (a) => { calls.store.push(['proposeSummary', a]); return { version: 1 } },
    effectiveContext: (id, o) => { calls.store.push(['effectiveContext', { id, ...o }]); return { totalTokens: 1, isPartial: false } },
    compactionState: (id) => { calls.store.push(['compactionState', id]); return { activeCount: 0 } },
    summariesOf: (id) => { calls.store.push(['summariesOf', id]); return [{ version: 1 }] },
  }
  Object.assign(store, over)
  const deps = {
    json: (_res, code, obj) => { calls.sent.push([code, obj]) },
    handleRun: async (_req, _res, fn) => { calls.run.push(await fn(COMPACT_BODY, 'general')) },
    requireString: (b, k) => {
      const v = b?.[k]
      if (typeof v !== 'string' || v.trim() === '') { const e = new Error(`缺少参数 ${k}`); e.code = 'MISSING_PARAM'; throw e }
      return v
    },
    authorized: () => true,
    compactionStore: store,
  }
  Object.assign(deps, over.deps ?? {})
  return { fam: createCompactionRoutes(deps), calls }
}

/** 按真实 `handle()` 的约定派发。 */
function compDispatch(fam, method, target) {
  const url = new URL(`http://x${target}`)
  return fam.dispatch({ method, headers: {} }, {}, { path: url.pathname, url })
}

describe('PRT-316 切片 5：compaction 族 5 条路由的**接线**契约（缝上）', () => {
  it('① 5 条路由每一条都接到正确的注入依赖上（正向 + 反向）', async () => {
    const table = [
      ['POST', '/api/compaction/messages', 'appendMessage'],
      ['POST', '/api/compaction/summarize', 'proposeSummary'],
      ['GET', '/api/compaction/context?sessionId=s', 'effectiveContext'],
      ['GET', '/api/compaction/state?sessionId=s', 'compactionState'],
      ['GET', '/api/compaction/summaries?sessionId=s', 'summariesOf'],
    ]
    assert.equal(table.length, 5, '路由表条数与族声明不符——加了路由就要来这里登记')
    for (const [method, target, fn] of table) {
      const d = compSpy()
      assert.equal(await compDispatch(d.fam, method, target), true, `${method} ${target} 没被本族接住`)
      const hit = d.calls.store.filter((x) => x[0] === fn)
      assert.equal(hit.length, 1, `${method} ${target} 没有走到 ${fn}（走了 ${d.calls.store.map((x) => x[0]).join(',') || '无'}）`)
      const others = d.calls.store.filter((x) => x[0] !== fn).map((x) => x[0])
      assert.deepEqual(others, [], `${method} ${target} 额外碰了 ${others.join(',')}`)
    }
  })

  it('② 方法或路径不匹配 ⇒ false；等值路由不吞前缀', async () => {
    const { fam } = compSpy()
    assert.equal(await compDispatch(fam, 'GET', '/api/compaction/context?sessionId=s'), true)
    assert.equal(await compDispatch(fam, 'DELETE', '/api/compaction/context'), false)
    assert.equal(await compDispatch(fam, 'POST', '/api/compaction/context'), false, 'context 只读')
    assert.equal(await compDispatch(fam, 'GET', '/api/compaction/nope'), false)
    assert.equal(await compDispatch(fam, 'GET', '/api/compaction/context/extra'), false, '等值路由不该吞前缀')
  })

  it('③ ★★ 错误码映射：非 400 的 statusCode 必须**原样透出**（K7 的正解）', async () => {
    for (const code of [404, 409, 500, 503]) {
      const d = compSpy({
        effectiveContext: () => { const e = new Error(`boom-${code}`); e.statusCode = code; e.code = 'X'; throw e },
      })
      await compDispatch(d.fam, 'GET', '/api/compaction/context?sessionId=s')
      assert.equal(d.calls.sent[0]?.[0], code, `statusCode=${code} 没有被透出（拿到 ${d.calls.sent[0]?.[0]}）`)
      assert.equal(d.calls.sent[0][1].error, `boom-${code}`, '错误信息被改写')
    }
    // 没有 statusCode ⇒ 回落 400（且不因为 undefined 变成 NaN）
    for (const [label, mk] of [
      ['无 statusCode', () => new Error('plain')],
      ['statusCode=0', () => { const e = new Error('zero'); e.statusCode = 0; return e }],
      ['statusCode 非数', () => { const e = new Error('nan'); e.statusCode = 'nope'; return e }],
    ]) {
      const d = compSpy({ effectiveContext: () => { throw mk() } })
      await compDispatch(d.fam, 'GET', '/api/compaction/context?sessionId=s')
      assert.equal(d.calls.sent[0]?.[0], 400, `${label} 应回落 400`)
    }
  })

  it('④ 未授权 ⇒ 401，且**不读也不查**（三条只读路由）', async () => {
    for (const target of ['/api/compaction/context?sessionId=s', '/api/compaction/state?sessionId=s', '/api/compaction/summaries?sessionId=s']) {
      const d = compSpy({ deps: { authorized: () => false } })
      assert.equal(await compDispatch(d.fam, 'GET', target), true)
      assert.equal(d.calls.sent[0]?.[0], 401, `${target} 没有 401：` + JSON.stringify(d.calls.sent))
      assert.deepEqual(d.calls.store, [], `${target} 在未授权时仍然查了仓储`)
    }
    // 反面控制：授权时确实会查
    const ok = compSpy()
    await compDispatch(ok.fam, 'GET', '/api/compaction/context?sessionId=s')
    assert.equal(ok.calls.store.length, 1, '授权时没有查仓储')
  })

  it('⑤ sessionId 缺省/空串 ⇒ 400 MISSING_PARAM（三条只读路由，且不查仓储）', async () => {
    // ★ 边界是**长度 0**，不是"空白"：路由判据是 `sessionId === null || sessionId.length === 0`，
    //   所以单个空格（`?sessionId=%20`）**是放行的**。这是搬运前的既有语义，本片不改它，
    //   只把它钉成契约——否则下一个人会把"空格也该拒"当成回归。
    for (const q of ['', '?sessionId=']) {
      for (const p of ['context', 'state', 'summaries']) {
        const d = compSpy()
        await compDispatch(d.fam, 'GET', `/api/compaction/${p}${q}`)
        assert.equal(d.calls.sent[0]?.[0], 400, `${p}${q} 没有 400`)
        assert.equal(d.calls.sent[0][1].code, 'MISSING_PARAM', `${p}${q} 的 code 不是 MISSING_PARAM`)
        assert.deepEqual(d.calls.store, [], `${p}${q} 在缺参时仍然查了仓储`)
      }
    }
    // 反面控制：单空格**要**透传到仓储（记录既有边界）。
    // ★ 注意断言的是"**没有错误响应**"，不是"没有任何响应"——放行意味着会 200，
    //   我第一版写成 `sent.length === 0`，那是在断言"路由不回答"，与边界无关。
    const blank = compSpy()
    await compDispatch(blank.fam, 'GET', '/api/compaction/state?sessionId=%20')
    assert.equal(blank.calls.sent[0]?.[0], 200, `单空格应放行（200），实际 ${blank.calls.sent[0]?.[0]}`)
    assert.equal(blank.calls.store[0]?.[1], ' ', `单空格应原样透传，实际 ${JSON.stringify(blank.calls.store[0]?.[1])}`)
  })

  it('⑥ maxTokens 非法/非正 ⇒ 回落 null（不是 0、不是 NaN）', async () => {
    for (const [q, want] of [['', null], ['&maxTokens=0', null], ['&maxTokens=-5', null], ['&maxTokens=abc', null],
      ['&maxTokens=1.5', null], ['&maxTokens=100', 100]]) {
      const d = compSpy()
      await compDispatch(d.fam, 'GET', `/api/compaction/context?sessionId=s${q}`)
      const got = d.calls.store[0][1].maxTokens
      assert.equal(got, want, `maxTokens${q || '(缺省)'} ⇒ 期望 ${want}，实际 ${got}`)
    }
  })

  it('⑦ baseVersion 缺省 ⇒ null（"我以为还没有摘要"与"我没传"在**这一层**是同一件事）', async () => {
    // ★ 这条**证明**了 K1 的等价性：路由把 `undefined` 折成 `null` 是**有意**的，
    //   所以 `body.baseVersion === undefined ? null : body.baseVersion` 与 `?? null`
    //   在全部输入上同值（另有穷举脚本佐证）。
    const a = compSpy()
    await compDispatch(a.fam, 'POST', '/api/compaction/summarize')
    assert.equal(a.calls.store[0][1].baseVersion, null, '缺省 baseVersion 不是 null')
    const b = compSpy()
    await compDispatch(b.fam, 'POST', '/api/compaction/summarize')
    assert.equal(b.calls.run.length, 1, 'summarize 没有走 handleRun')
  })

  it('⑧ 两条写路由都走 handleRun（不是 handleWrite），且 by/author 由路由补齐', async () => {
    for (const [target, fn] of [['/api/compaction/messages', 'appendMessage'], ['/api/compaction/summarize', 'proposeSummary']]) {
      const d = compSpy()
      await compDispatch(d.fam, 'POST', target)
      assert.equal(d.calls.run.length, 1, `${target} 没有走 handleRun`)
      assert.equal(d.calls.store.length, 1, `${target} 没有落到 ${fn}`)
      assert.equal(d.calls.store[0][0], fn, `${target} 落到了 ${d.calls.store[0][0]}`)
    }
  })
})
