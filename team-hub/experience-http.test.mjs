// team-hub/experience-http.test.mjs
// ============================================================================
// F-18 落盘面的 **HTTP 边界**。
//
// 本文件的主要理由与 role-pack 那条一致：执行面/存储面抛的具名码，
// 到客户端之间还隔着一层 `handleRun` 的 `Number(e?.statusCode) || 400`。
// 那层一旦不认识它，调用方就会把"这条草稿已经处置过了"读成
// "我的请求格式不对"——于是它会去改请求体，而不是去读那条草稿现在是什么状态。
//
// 另一条：**没有"改一条记录"的路由**这件事必须在网络上验证，
// 而不是只在源码里 grep。
// ============================================================================
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TOKEN = 'experience-http-token'
const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-exp-http-'))
let mod
let base = ''

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

const auth = { authorization: `Bearer ${TOKEN}` }

async function call(path, { method = 'GET', body = null, raw = false } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...auth, 'content-type': 'application/json' },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  if (raw) return { status: res.status, text, headers: res.headers }
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* 导出那条是 JSON 文本 */ }
  return { status: res.status, text, json: parsed }
}

const post = (r) => call('/api/experience/records', { method: 'POST', body: r })

test('① 追加一条草稿记录，读回来形状不变', async () => {
  const r = await post({ kind: 'draft', draftId: 'd1', atMs: 1000, subject: { kind: 'skill', id: 'skill.diff' }, score: 9 })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.json.appended, true)
  assert.equal(r.json.kind, 'draft')
  assert.equal(r.json.seq > 0, true)

  const got = await call('/api/experience/records?draftId=d1')
  assert.equal(got.status, 200)
  assert.equal(got.json.records.length, 1)
  assert.equal(got.json.records[0].readable, true)
  assert.equal(got.json.records[0].record.draftId, 'd1')
  assert.equal(got.json.records[0].record.score, 9)
  // ★ 记录里**没有** status 字段——状态从来不存在于行里。
  assert.equal('status' in got.json.records[0].record, false)
})

test('② ★★★ 处置一条草稿：**追加**一条记录，草稿那一行不动', async () => {
  const before = await call('/api/experience/records?draftId=d1')
  const s = await call('/api/experience/drafts/d1/settle', {
    method: 'POST', body: { action: 'promote', by: 'general', reason: 'recurring', atMs: 2000 },
  })
  assert.equal(s.status, 200, s.text)
  assert.equal(s.json.appended, true)
  const after = await call('/api/experience/records?draftId=d1')
  assert.equal(after.json.records.length, before.json.records.length + 1)
  // 原来那条 draft 一字未动。
  assert.equal(after.json.records[0].record.kind, 'draft')
  assert.equal(after.json.records[0].record.score, 9)
  assert.equal(after.json.records[1].record.kind, 'promote')
  assert.equal(after.json.records[1].record.by, 'general')
  // 计数反映推导出来的状态。
  assert.equal(after.json.counts.promoted, 1)
  assert.equal(after.json.counts.draft, 0)
})

test('③ ★★★ 再次处置 ⇒ HTTP **409**，且响应里带着"现在是什么状态"', async () => {
  // 400 会让调用方去改请求体，而不是去读这条草稿现在怎么样了。
  const r = await call('/api/experience/drafts/d1/settle', {
    method: 'POST', body: { action: 'discard', by: 'other', reason: 'one-off' },
  })
  assert.equal(r.status, 409, `期望 409，实际 ${r.status}：${r.text}`)
  assert.equal(r.json.code, 'EXPERIENCE_DRAFT_ALREADY_SETTLED')
  assert.match(r.json.error ?? '', /只有一个终点/)
  // 冲突响应要能让调用方**不必再查一次**就知道现状。
  // ★ 现状走一个**具名字段**（`currentSettlement`），不是把 `by`/`reason`
  //   摊在顶层：`handleRun` 的错误出口是白名单式的（逐个字段判断，
  //   不展开整个 error 对象），而顶层那两个名字太泛、容易与别的错误语义撞车。
  assert.deepEqual(r.json.currentSettlement, {
    draftId: 'd1', state: 'promoted', by: 'general', reason: 'recurring', atMs: 2000,
  })
  // 而且真的没写进去。
  const after = await call('/api/experience/records?draftId=d1')
  assert.equal(after.json.records.length, 2)
})

test('④ ★★ 处置理由空着 ⇒ 400（丢弃也要写理由）', async () => {
  await post({ kind: 'draft', draftId: 'd2', atMs: 1001 })
  const r = await call('/api/experience/drafts/d2/settle', {
    method: 'POST', body: { action: 'discard', by: 'general', reason: '  ' },
  })
  assert.equal(r.status, 400, r.text)
  assert.equal(r.json.code, 'EXPERIENCE_RECORD_MALFORMED')
  assert.match(r.json.error ?? '', /丢弃也要写理由/)
  // 没写的还是没写。
  assert.equal((await call('/api/experience/records?draftId=d2')).json.records.length, 1)
  // 动作只有两个。
  const bad = await call('/api/experience/drafts/d2/settle', {
    method: 'POST', body: { action: 'delete', by: 'g', reason: 'one-off' },
  })
  assert.equal(bad.status, 400)
})

test('⑤ ★★ 给一条从未见过的草稿做处置 ⇒ 400 且说清来源丢了', async () => {
  const r = await call('/api/experience/drafts/ghost/settle', {
    method: 'POST', body: { action: 'promote', by: 'g', reason: 'recurring' },
  })
  assert.equal(r.status, 400, r.text)
  assert.equal(r.json.code, 'EXPERIENCE_DRAFT_NOT_FOUND')
  assert.match(r.json.error ?? '', /来源丢了/)
})

test('⑤ ★★ id 里带 `/` 的路径要说"路径写错了"，不是"来源丢了"', async () => {
  // 不拦的话 `/api/experience/drafts/a/b/settle` 会把 `a/b` 当成一个合法 id，
  // 而那个 id 永远不会有草稿——调用方拿到的会是"来源丢了"，
  // 于是它去查一条**根本不存在的草稿**，而不是去修路径。
  const r = await call('/api/experience/drafts/a/b/settle', {
    method: 'POST', body: { action: 'promote', by: 'g', reason: 'recurring' },
  })
  assert.equal(r.status, 400, r.text)
  assert.equal(r.json.code, 'EXPERIENCE_RECORD_MALFORMED')
  assert.match(r.json.error ?? '', /永远不会对应到一条草稿/)
  // 空 id 同理。
  const empty = await call('/api/experience/drafts//settle', {
    method: 'POST', body: { action: 'promote', by: 'g', reason: 'recurring' },
  })
  assert.equal(empty.status, 400, empty.text)
})

test('⑥ ★★ 图记录（node/edge/retract）走同一本账，收回不删边', async () => {
  const n1 = await post({ kind: 'node', nodeKind: 'task', id: 't1', atMs: 1 })
  assert.equal(n1.status, 200, n1.text)
  assert.equal((await post({ kind: 'node', nodeKind: 'file', id: 'a.mjs', atMs: 1 })).status, 200)
  const e = await post({
    kind: 'edge', edgeId: 'e1', from: 'task:t1', to: 'file:a.mjs',
    edgeKind: 'touched', source: 'worker', reason: 'diff 里有它', atMs: 2,
  })
  assert.equal(e.status, 200, e.text)
  assert.equal((await post({ kind: 'retract', edgeId: 'e1', by: 'general', reason: '只是读了一下', atMs: 3 })).status, 200)
  // 边与收回**都在**账里。
  const edges = await call('/api/experience/records?edgeId=e1')
  assert.deepEqual(edges.json.records.map((r) => r.record.kind), ['edge', 'retract'])
  assert.equal(edges.json.records[0].record.reason, 'diff 里有它')
  assert.equal(edges.json.records[1].record.by, 'general')
  // 按种类过滤。
  assert.equal((await call('/api/experience/records?kind=node')).json.records.length, 2)
  assert.equal((await call('/api/experience/records?kind=edge')).json.records.length, 1)
})

test('⑦ ★★ 坏事实在写入前被拒，且一条都没落盘', async () => {
  const before = (await call('/api/experience/records')).json.records.length
  // 边没有 source。
  const bad = await post({ kind: 'edge', edgeId: 'e9', from: 'a', to: 'b', edgeKind: 'touched', atMs: 5 })
  assert.equal(bad.status, 400, bad.text)
  assert.equal(bad.json.code, 'EXPERIENCE_RECORD_MALFORMED')
  // atMs 缺失（不给默认值）。
  const bad2 = await post({ kind: 'draft', draftId: 'd9' })
  assert.equal(bad2.status, 400)
  assert.match(bad2.json.error ?? '', /不给默认值/)
  // 未知种类。
  const bad3 = await post({ kind: 'mystery', atMs: 1 })
  assert.equal(bad3.status, 400)
  assert.equal(bad3.json.code, 'EXPERIENCE_KIND_UNKNOWN')
  const after = (await call('/api/experience/records')).json.records.length
  assert.equal(after, before, '坏输入在账里留下了东西')
})

test('⑧ ★★★ 没有"改一条 / 删一条 / 保存整张图"的路由', async () => {
  for (const [method, path] of [
    ['PUT', '/api/experience/records'], ['PATCH', '/api/experience/records'],
    ['DELETE', '/api/experience/records'],
    ['DELETE', '/api/experience/records?draftId=d1'],
    ['PUT', '/api/experience/drafts/d1/settle'],
    ['POST', '/api/experience/graph'], ['PUT', '/api/experience/state'],
  ]) {
    const r = await call(path, { method })
    assert.notEqual(r.status, 200, `${method} ${path} 居然成功了`)
  }
  // 一条记录都还在——没有任何一条被上面那些请求改掉。
  const all = await call('/api/experience/records')
  assert.equal(all.json.records.length > 0, true)
  assert.deepEqual(all.json.records.filter((r) => !r.readable), [])
})

test('⑨ ★ 可按 `sinceSeq` 增量拉', async () => {
  const first = await call('/api/experience/records')
  const seqs = first.json.records.map((r) => r.seq)
  const high = Math.max(...seqs)
  await post({ kind: 'draft', draftId: 'd9', atMs: 5000 })
  const delta = await call(`/api/experience/records?sinceSeq=${high}`)
  assert.equal(delta.json.records.length, 1)
  assert.equal(delta.json.records[0].record.draftId, 'd9')
})

test('⑩ ★★ 整本账：重启后控制面能据此重建（含坏行数）', async () => {
  const acct = await call('/api/experience/account')
  assert.equal(acct.status, 200)
  assert.equal(acct.json.format, 'legion/experience-record@1')
  assert.equal(Array.isArray(acct.json.records), true)
  assert.equal(acct.json.brokenCount, 0)
  assert.equal(acct.json.counts.readable, true)
  // 记录流里"每条记录自带自己的 seq"，可以从最后一条接着走。
  const seqs = acct.json.records.map((r) => r.seq)
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), '记录流必须按 seq 递增返回')
})

test('⑪ ★★ 导出是白名单文本（不含草稿正文，含积压计数）', async () => {
  const res = await call('/api/experience/export', { raw: true })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-disposition') ?? '', /legion-experience\.json/)
  const doc = JSON.parse(res.text)
  assert.equal(doc.format, 'legion/experience-export@1')
  assert.equal(doc.records.length > 0, true)
  assert.equal(doc.counts.readable, true)
  // ★ 白名单：草稿的 subject/payload/score 都不许出现。
  for (const banned of ['subject', 'payload', 'score', 'skill.diff']) {
    assert.equal(res.text.includes(banned), false, `导出里出现了 ${banned}`)
  }
  // 但"谁是按什么理由处置的"要在（那正是审阅时要看的）。
  assert.equal(doc.records.some((r) => r.reason === 'recurring'), true)
  assert.equal(doc.records.some((r) => r.actor === 'general'), true)
})

test('⑫ ★ `scope` 隔离：同名草稿在两个空间里各自独立处置', async () => {
  await post({ kind: 'draft', draftId: 'sd', atMs: 1, scope: 'team-a' })
  await post({ kind: 'draft', draftId: 'sd', atMs: 2, scope: 'team-b' })
  const a = await call('/api/experience/drafts/sd/settle', {
    method: 'POST', body: { action: 'promote', by: 'g', reason: 'recurring', scope: 'team-a' },
  })
  assert.equal(a.status, 200, a.text)
  // team-b 的那条仍然是未处置的——team-a 的处置不该影响它。
  const b = await call('/api/experience/records?scope=team-b&draftId=sd')
  assert.equal(b.json.records.length, 1)
  assert.equal(b.json.counts.draft, 1)
  // 在 team-b 里再处置一次应当是成功的（它不是"重复处置"）。
  const b2 = await call('/api/experience/drafts/sd/settle', {
    method: 'POST', body: { action: 'discard', by: 'g', reason: 'one-off', scope: 'team-b' },
  })
  assert.equal(b2.status, 200, b2.text)
})

test('⑬ 未授权一律 401（读面与写面都是）', async () => {
  for (const [method, path] of [
    ['POST', '/api/experience/records'], ['GET', '/api/experience/records'],
    ['GET', '/api/experience/export'], ['GET', '/api/experience/account'],
    ['POST', '/api/experience/drafts/d1/settle'],
  ]) {
    const res = await fetch(`${base}${path}`, { method })
    assert.equal(res.status, 401, `${method} ${path} 没有鉴权`)
  }
})

// ══════════════════════════════════════════════════════════════════════════════
// ④ PRT-316 切片 8：experience 族搬进 `routes/experience.mjs` 之后的**缝上契约**
//
// 为什么补：破验 14 条变异，第一轮咬住 7 条、漏网 7 条。逐条查过之后，
// 那 7 条分成**三类**，而三类的处置完全不同：
//
//   ① 真缺口（用例从没喂过那个输入）—— 补判据：
//        K2  空 id：`/api/experience/drafts//settle` 从没被请求过。
//        K3  百分号编码：从没请求过带 `%2F` 的 id。
//        K10 空白 scope：只喂过"没给 scope"与"给了正常 scope"。
//        K13/K14 匹配边界：只喂过**刚刚好正确**的路径。
//
//   ② **可证等价**（我改坏的那处与原文在任何输入上都同结果）—— 不补判据，只记录证明：
//        K11 `sinceSeq`: `optionalIntParam` 缺参返回 `null`，而 store 里是
//            `sinceSeq = 0` 默认参数 + `Number(sinceSeq) || 0` ⇒ `null` 与 `0` 同结果。
//        K12 `atMs`：store 里是 `atMs ?? nowMs`，`nowMs = Date.now()` 是默认参数
//            ⇒ `undefined` 与"显式 `Date.now()`"同结果。
//
//        > 一个"我改坏了但行为没变"的变异，与一个"我没测出来"的变异，
//        > 在破验报告里都是同一行"没咬住"。
//
//        这两条**不能被判据"修好"**——它们不是缺口，是等价。硬写一条断言
//        （比如断言传给 store 的实参必须是 0）只会把**实现细节**钉死，
//        而下一个合理的重构会因此变红。
//
//   ③ 已由既有用例覆盖、本轮也咬住了（K1/K4/K5/K6/K7/K8/K9）—— 不重复。
//
// ▲ 既有 13 例仍在**真 hub** 上验（不替换、不删除）。
// ▲ 追加而非新建文件：`git ls-files "*.test.mjs"` 的条数被 `boundary-facts` 钉着。
// ══════════════════════════════════════════════════════════════════════════════

import { createExperienceRoutes } from './routes/experience.mjs'
// K11/K12 的等价性要**钉住 store 端的前提**（见那两条测试的说明），所以需要读源码。
import { readFileSync } from 'node:fs'

/** 会记录调用的假依赖 + 假 `res`（export 那条自己写响应头，不走 `json`）。 */
function expSpy(over = {}) {
  const calls = []
  const sent = []
  const written = []
  const res = {
    writeHead: (code, headers) => { written.push([code, headers]) },
    end: (body) => { written.push(['end', body]) },
  }
  const body = over.body ?? { kind: 'draft', action: 'promote', draftId: 'd1', atMs: 7, by: 'me', reason: 'r' }
  const deps = {
    json: (_res, code, obj) => { sent.push([code, obj]) },
    authorized: over.authorized ?? (() => true),
    handleRun: async (_req, _res, fn) => {
      const out = await fn(body, 'me')
      sent.push([200, out])
      return out
    },
    appendExperienceRecord: (a) => { calls.push(['append', a]); return { appended: true, seq: 1, kind: a?.record?.kind } },
    experienceRecords: (a) => { calls.push(['records', a]); return [] },
    draftCounts: (a) => { calls.push(['counts', a]); return { draft: 1 } },
    // 与 `server.mjs` 里的实现逐字一致（缺参 ⇒ null，非整数 ⇒ null）
    optionalIntParam: (url, name) => {
      const raw = url.searchParams.get(name)
      if (raw === null || raw.trim() === '') return null
      const n = Number(raw)
      return Number.isSafeInteger(n) ? n : null
    },
    experienceAccount: (a) => { calls.push(['account', a]); return { records: [], counts: {} } },
    settleDraft: (a) => { calls.push(['settle', a]); return { settled: true, state: 'promoted', draftId: a?.draftId } },
    exportExperience: (a) => { calls.push(['export', a]); return { text: 'EXPORT-TEXT' } },
    db: { __db: true },
  }
  const fam = createExperienceRoutes(deps)
  const dispatch = (method, target) => {
    const url = new URL(`http://x${target}`)
    return fam.dispatch({ method, headers: {} }, res, { path: url.pathname, url })
  }
  return { dispatch, calls, sent, written, res }
}
const names = (calls) => calls.map((c) => c[0])
const last = (calls, n) => calls.filter((c) => c[0] === n).at(-1)

test('④ ★★ K14：`exact` 不许退化成前缀 —— 邻接命名空间一个都不许被吃掉', async () => {
  // 既有用例只请求过**刚刚好正确**的路径，于是"精确匹配"与"前缀匹配"
  // 在它眼里完全一样。
  //
  //   > 一个"精确匹配"的实现，与一个"前缀匹配"的实现，
  //   > 在用例只喂过**恰好等于**那些前缀的路径时是同一个东西。
  const s = expSpy()
  for (const [m, p] of [['GET', '/api/experience/recordsX'], ['GET', '/api/experience/account/x'],
    ['GET', '/api/experience/export/x'], ['POST', '/api/experience/recordsZ'],
    ['GET', '/api/experienc/records'], ['GET', '/api/experienceX']]) {
    assert.equal(await s.dispatch(m, p), false, `${m} ${p} 被本族接住了 —— exact 退化了？`)
  }
  assert.deepEqual(s.calls, [], '未匹配的请求却碰了仓储')
  // 正面控制：三条正路径必须被接住（否则"一律不接"也能让上面通过）
  for (const [m, p, fn] of [['GET', '/api/experience/records', 'records'],
    ['GET', '/api/experience/account', 'account'],
    ['GET', '/api/experience/export', 'export']]) {
    const ok = expSpy()
    assert.equal(await ok.dispatch(m, p), true, `${m} ${p} 没被接住`)
    assert.ok(last(ok.calls, fn), `${m} ${p} 没走到 ${fn}`)
  }
})

test('④ ★★ K13：`prefix+suffix` 必须**两段都对**才命中', async () => {
  // 丢掉 `endsWith` 之后，`POST /api/experience/drafts/<任意>` 都会被当成
  // 一次草稿处置 —— 而既有用例只打过**以 `/settle` 结尾**的路径。
  for (const p of ['/api/experience/drafts/d1', '/api/experience/drafts/d1/settleX',
    '/api/experience/drafts/d1/settl', '/api/experience/draftsX/d1/settle']) {
    const s = expSpy()
    assert.equal(await s.dispatch('POST', p), false, `POST ${p} 被当成了一次处置`)
    assert.deepEqual(s.calls, [], `POST ${p} 未命中却碰了仓储`)
  }
  // 正面控制：真正的处置路径必须命中，且 id 切得对
  const ok = expSpy()
  assert.equal(await ok.dispatch('POST', '/api/experience/drafts/d1/settle'), true)
  assert.equal(last(ok.calls, 'settle')?.[1]?.draftId, 'd1', 'id 没有从 URL 里切对')
})

test('④ ★★ K2：空 id 必须被本路由**自己**拒掉（具名码），不能下传', async () => {
  // `/api/experience/drafts//settle` 的 id 是空串。原判据在**这一层**就挡住它，
  // 报 `EXPERIENCE_RECORD_MALFORMED`；去掉之后它会一路走到 store，
  // 报的是"来源丢了"（DRAFT_NOT_FOUND）—— 而那是**另一回事**：
  // 前者说"你的路径写错了"，后者说"这条草稿不存在"。
  //
  //   > 一个"路径写错"与一个"草稿不存在"，
  //   > 在只看状态码是不是 400 的用例上是同一个东西。
  const s = expSpy()
  assert.equal(await s.dispatch('POST', '/api/experience/drafts//settle'), true)
  assert.equal(s.sent.at(-1)?.[0], 400, JSON.stringify(s.sent))
  assert.equal(s.sent.at(-1)[1].code, 'EXPERIENCE_RECORD_MALFORMED', '空 id 落到了下游的"草稿不存在"')
  assert.deepEqual(s.calls, [], '空 id 却调了 settleDraft')
})

test('④ ★ K3：id 的 URL 段**必须解码**后再下传（且解码在形状校验之后）', async () => {
  // 注意顺序：`includes('/')` 判据看的是**解码前**的段。
  // 所以 `a%2Fb` 是**合法**的（解码前只有一段），解码后交给 store 的是 `a/b`。
  // 把解码去掉，store 收到的就是字面量 `a%2Fb` —— 一条永远不存在的草稿 id。
  const s = expSpy()
  assert.equal(await s.dispatch('POST', '/api/experience/drafts/a%2Fb/settle'), true)
  assert.equal(last(s.calls, 'settle')?.[1]?.draftId, 'a/b', 'URL 段没有被解码')
  // 反面对照：**解码前**带 `/` 的必须仍被拒（多段路径不是合法 id）
  const slash = expSpy()
  assert.equal(await slash.dispatch('POST', '/api/experience/drafts/a/b/settle'), true)
  assert.equal(slash.sent.at(-1)?.[1]?.code, 'EXPERIENCE_RECORD_MALFORMED')
  assert.deepEqual(slash.calls, [])
})

test('④ ★★ K10：`scope` 必须**规整**（空白 ⇒ default，两侧空白去掉）', async () => {
  // 只喂过"没给 scope"（`undefined` ⇒ store 的默认参数兜住，看不出差别）
  // 与"给了正常 scope"。于是"规整"这一层整个没被验过。
  //
  //   为什么它是**真行为差异**而不是等价：`scope: '  '` 会把这批记录写进
  //   字面量 `'  '` 这个空间 —— 之后任何正常的按 scope 查询都找不到它们。
  //   记录没丢，但**读不回来**，而账看起来完全正常。
  const CASES = [[undefined, 'default'], ['', 'default'], ['   ', 'default'],
    ['  x  ', 'x'], ['software', 'software']]
  for (const [given, want] of CASES) {
    const body = { kind: 'draft', atMs: 1, ...(given === undefined ? {} : { scope: given }) }
    const s = expSpy({ body })
    await s.dispatch('POST', '/api/experience/records')
    assert.equal(last(s.calls, 'append')?.[1]?.scope, want,
      `写入 scope ${JSON.stringify(given)} 得到 ${JSON.stringify(last(s.calls, 'append')?.[1]?.scope)}`)
    // 处置那一侧同一条规则
    const t = expSpy({ body: { action: 'promote', atMs: 1, ...(given === undefined ? {} : { scope: given }) } })
    await t.dispatch('POST', '/api/experience/drafts/d1/settle')
    assert.equal(last(t.calls, 'settle')?.[1]?.scope, want,
      `处置 scope ${JSON.stringify(given)} 得到 ${JSON.stringify(last(t.calls, 'settle')?.[1]?.scope)}`)
  }
})

test('④ ★ K11 / K12：这两处**故意不设判据** —— 它们是**可证等价**，不是缺口', async () => {
  // 写下来是为了让下一个人知道"这里破验没咬住"是**查过的结论**，不是漏看。
  //
  // K11（`sinceSeq` 的 `?? 0` 被去掉）：
  //   `optionalIntParam` 缺参返回 `null`；store 的签名是
  //   `sinceSeq = 0` 默认参数 + SQL 里 `Number(sinceSeq) || 0`。
  //   `null` 不是 `undefined` ⇒ 默认参数不生效；但 `Number(null) || 0 === 0`。
  //   ⇒ `0` 与 `null` 在 store 里**落到同一个 SQL 参数**。
  const asSeq = (v) => Number(v) || 0
  assert.equal(asSeq(0), asSeq(null), '0 与 null 在 store 里必须落到同一个值')
  assert.equal(asSeq(0), 0)
  //   反过来说：如果谁把 store 改成 `sinceSeq = null` 或 `Number.isInteger(sinceSeq)` 判据，
  //   这两者就**不再**等价，届时必须补一条判据。所以这里顺手钉住 **store 端的**前提
  //   （不是路由端的实参）—— 前提若变，这条会红。
  const storeSrc = readFileSync('team-hub/experience-store.mjs', 'utf8')
  assert.ok(/sinceSeq = 0/.test(storeSrc.replace(/\s+/g, ' ')),
    'store 的 `sinceSeq = 0` 默认参数不见了 —— K11 的等价性前提失效，请补一条路由端判据')
  assert.ok(/Number\(sinceSeq\) \|\| 0/.test(storeSrc.replace(/\s+/g, ' ')),
    'store 的 `Number(sinceSeq) || 0` 不见了 —— K11 的等价性前提失效')
  //
  // K12（`atMs` 的 `: Date.now()` 被去掉）：
  //   store 里是 `atMs: atMs ?? nowMs`，而 `nowMs = Date.now()` 是**默认参数**。
  //   ⇒ 路由端给 `undefined` 与给 `Date.now()` 得到的是同一个时刻来源。
  const asAt = (routeAt, storeNow) => routeAt ?? storeNow
  assert.equal(asAt(undefined, 100), asAt(100, 999), 'undefined 与显式 now 必须落到同一个值')
  assert.ok(/atMs \?\? nowMs/.test(storeSrc.replace(/\s+/g, ' ')),
    'store 的 `atMs ?? nowMs` 不见了 —— K12 的等价性前提失效，请补一条路由端判据')
})

test('④ 三条读路由：未授权 401 且**不查仓储**', async () => {
  for (const p of ['/api/experience/records', '/api/experience/account']) {
    const s = expSpy({ authorized: () => false })
    assert.equal(await s.dispatch('GET', p), true)
    assert.equal(s.sent.at(-1)?.[0], 401, `${p} 没有 401`)
    assert.deepEqual(s.calls, [], `${p} 在未授权时仍然查了仓储`)
  }
  const e = expSpy({ authorized: () => false })
  assert.equal(await e.dispatch('GET', '/api/experience/export'), true)
  assert.equal(e.sent.at(-1)?.[0], 401)
  assert.deepEqual(e.calls, [])
  assert.deepEqual(e.written, [], '未授权却已经写了响应头')
})

test('④ 两条写路由**不**做 authorized 前置（鉴权在 `handleRun` 里，与既有语义一致）', async () => {
  for (const [m, p] of [['POST', '/api/experience/records'], ['POST', '/api/experience/drafts/d1/settle']]) {
    const s = expSpy({ authorized: () => false })
    await s.dispatch(m, p)
    assert.notEqual(s.sent.at(-1)?.[0], 401, `${m} ${p} 在路由头做了 401 —— 与既有语义不符`)
  }
})

test('④ ★ export 是**附件**且正文来自 `exportExperience`（自己写响应头，不走 json）', async () => {
  // 既有用例 ⑪ 验的是正文内容；响应头（"这是个附件"）没被验过。
  // `attachment` 与 `inline` 的差别是"点一下下载"还是"在浏览器里渲染"。
  const s = expSpy()
  assert.equal(await s.dispatch('GET', '/api/experience/export'), true)
  assert.deepEqual(s.sent, [], 'export 不该走 json（它自己写响应头）')
  const [code, headers] = s.written[0] ?? []
  assert.equal(code, 200)
  assert.equal(headers?.['content-disposition'],
    'attachment; filename="legion-experience.json"', '导出不再是附件')
  assert.equal(headers?.['content-type'], 'application/json; charset=utf-8')
  assert.equal(s.written.at(-1)?.[0], 'end')
  assert.equal(s.written.at(-1)?.[1], 'EXPORT-TEXT', '导出的正文不是 store 给的那份')
})

test('④ 五条路由各自接到正确的方法上（动作不许串）', async () => {
  const table = [
    ['POST', '/api/experience/records', 'append'],
    ['GET', '/api/experience/records', 'records'],
    ['GET', '/api/experience/account', 'account'],
    ['POST', '/api/experience/drafts/d1/settle', 'settle'],
    ['GET', '/api/experience/export', 'export'],
  ]
  for (const [m, p, fn] of table) {
    const s = expSpy()
    assert.equal(await s.dispatch(m, p), true, `${m} ${p} 没被接住`)
    assert.ok(last(s.calls, fn), `${m} ${p} 没有走到 ${fn}（走了 ${names(s.calls).join(',') || '无'}）`)
  }
  // `GET records` 必须同时给出**积压读数**（`counts`），且与列表用**同一个 scope**
  const s = expSpy()
  await s.dispatch('GET', '/api/experience/records?scope=sp')
  assert.equal(last(s.calls, 'records')?.[1]?.scope, 'sp')
  assert.equal(last(s.calls, 'counts')?.[1]?.scope, 'sp', 'counts 与 records 用了不同的 scope')
  assert.equal(s.sent.at(-1)?.[1]?.counts?.draft, 1, '响应里没有 counts')
})
