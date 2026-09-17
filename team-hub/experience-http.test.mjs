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
