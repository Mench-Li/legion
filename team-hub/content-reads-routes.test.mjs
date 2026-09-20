// ============================================================================
// PRT-316 切片 43：两个只读视图 —— 2 条，全 `exact`
//   GET /api/skills     技能目录（含 `include=pending` 收口，AC-R1-7）
//   GET /api/documents  显式文档读（PRT-406）
//
// ★★★ 本片是一个**安全语义**密集的地方：`/api/skills` 的 `pending` 收口
//   要求 `member=general` **且** `include=pending`（**与**，不是**或**），
//   并且对未发布的技能要按「**不存在**」处理（404 `skill_not_found`），不泄露存在性。
// ============================================================================
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createContentReadsRoutes } from './routes/content-reads.mjs'

const dir = mkdtempSync(join(tmpdir(), 'legion-content-reads-'))
process.env.TEAM_HUB_DB = join(dir, 'team.db')
process.env.TEAM_HUB_TOKEN = ''
const mod = await import('./server.mjs')
await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + mod.server.address().port

const get = async (p) => {
  const res = await fetch(base + p)
  const t = await res.text(); let j; try { j = JSON.parse(t) } catch { j = t }
  return { status: res.status, body: j }
}

const iso = new Date().toISOString()
const mkSkill = (id, { status = 'published', scope = 'default', grants = [], prompt = 'P-' + id, name = 'N-' + id } = {}) => {
  mod.db.prepare('INSERT OR REPLACE INTO skills (id,name,description,prompt,scope,owner,grants,version,status,contentHash,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, name, '', prompt, scope, 'general', JSON.stringify(grants), 1, status, 'h-' + id, iso, iso)
}
const mkDoc = (id, { scope = 'default', body = 'B-' + id, title = 'T-' + id, origin = 'member' } = {}) => {
  mod.db.prepare('INSERT OR REPLACE INTO documents (id,title,path,body,scope,origin,version,sha256,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, title, 'p/' + id, body, scope, origin, 1, 's-' + id, iso, iso)
}
const reset = () => { mod.db.prepare('DELETE FROM skills').run(); mod.db.prepare('DELETE FROM documents').run() }

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close?.() } catch { /* 已关 */ }
  try { mod?.db?.close?.() } catch { /* 已关 */ }
  rmSync(dir, { recursive: true, force: true })
})

// ══════════════════════ GET /api/skills ══════════════════════

test('① ★★ 按 id 取已发布技能 ⇒ 200，带 `prompt` / `bundle` / `grants`', async () => {
  reset()
  mkSkill('pub', { status: 'published', prompt: '指令正文' })
  const r = await get('/api/skills?id=pub')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.id, 'pub')
  assert.equal(r.body.prompt, '指令正文', '★★ 技能返回的是 `prompt`（会被当指令执行的那一段）')
  assert.ok(r.body.bundle, '★ 要带 bundle')
  assert.deepEqual(r.body.grants, [], '★ grants 要解析成数组（不是 JSON 字符串）')
})

test('② ★★★ 未发布技能对普通视角按「**不存在**」处理（404 `skill_not_found`，不泄露存在性）', async () => {
  reset()
  mkSkill('draft', { status: 'pending' })
  const r = await get('/api/skills?id=draft')
  assert.equal(r.status, 404, JSON.stringify(r.body))
  assert.equal(r.body.error, 'skill_not_found: draft',
    '★★★ 错误文案必须是 `skill_not_found: <id>` —— **不能**说"未发布"，那等于确认它存在')
})

test('③ ★★★ `pending` 收口要求 `member=general` **与** `include=pending`（是「与」不是「或」）', async () => {
  reset()
  mkSkill('draft2', { status: 'pending', prompt: '草稿指令' })
  // 两个条件各只满足一个 ⇒ 都必须 404
  const onlyMember = await get('/api/skills?id=draft2&member=general')
  assert.equal(onlyMember.status, 404, '★★★ 只给 member=general **不够**（还缺 include=pending）')
  assert.equal(onlyMember.body.error, 'skill_not_found: draft2')
  const onlyInclude = await get('/api/skills?id=draft2&include=pending')
  assert.equal(onlyInclude.status, 404, '★★★ 只给 include=pending **也不够**（还必须 member=general）')
  assert.equal(onlyInclude.body.error, 'skill_not_found: draft2')
  // 两个都给 ⇒ 才看得到
  const both = await get('/api/skills?id=draft2&member=general&include=pending')
  assert.equal(both.status, 200, JSON.stringify(both.body))
  assert.equal(both.body.status, 'pending')
  assert.equal(both.body.prompt, '草稿指令', '★ 复审视角才拿到草稿的 prompt')
})

test('③b ★★ `member=general` 的匹配是**严格相等**（大小写/前后缀都不算）', async () => {
  reset()
  mkSkill('d3', { status: 'pending' })
  for (const m of ['General', 'GENERAL', 'general ', 'xgeneral']) {
    const r = await get(`/api/skills?id=d3&member=${encodeURIComponent(m)}&include=pending`)
    assert.equal(r.status, 404, `★★ member=${JSON.stringify(m)} 不该被当成复审身份`)
  }
})

test('④ ★ 未知 id ⇒ 404 带「未知技能 X」（与"未发布"的文案**不同**）', async () => {
  reset()
  const r = await get('/api/skills?id=nope')
  assert.equal(r.status, 404)
  assert.match(String(r.body.error), /未知技能 nope/, '★ 真正不存在时报的是域层的错，不是 skill_not_found')
})

test('⑤ ★★★ 列表形态：缺省**只返回 published**，草稿不外泄', async () => {
  reset()
  mkSkill('a-pub', { status: 'published' })
  mkSkill('b-draft', { status: 'pending' })
  mkSkill('c-rejected', { status: 'rejected' })
  const r = await get('/api/skills')
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.map((s) => s.id), ['a-pub'],
    '★★★ 含 scope/member 全缺省的「全部空间」视图也**一律只返回 published**')
})

test('⑥ ★★★ 列表形态的"复审视角"**同时**把自己关进了 grants 过滤里', async () => {
  reset()
  mkSkill('a-pub', { status: 'published' })
  mkSkill('b-draft', { status: 'pending' })
  mkSkill('c-rejected', { status: 'rejected' })
  mkSkill('d-granted', { status: 'pending', grants: ['general'] })
  // ★★★ 实测（我第一版写错的地方）：`member=general` 一旦给了，
  //   `listSkills` 里那句 `if (scope === undefined && member === undefined) return true`
  //   就**不再放行**，于是每一行都要过 `inScope || grantedByScope || grantedToMember` ——
  //   在没有 `scope` 的情况下只有 `grantedToMember` 能命中，即 `grants` 必须含 `'general'`。
  //
  //   所以"复审视角"看到的**不是**"全部三态"，而是"**授权给我的**那些三态"。
  //   ⇒ a/b/c 三条 `grants: []` 的技能，**连复审视角也看不到**；只有 d 看得到。
  const both = await get('/api/skills?member=general&include=pending')
  assert.deepEqual(both.body.map((s) => s.id), ['d-granted'],
    '★★★ "复审视角"= 三态不限 **且** grants 含 general —— 没授权的 pending 连复审也看不到')
  assert.equal(both.body[0].status, 'pending', '★ 确实看到了 pending（三态不限那一半生效了）')
  // 只给 include ⇒ 退回"只 published"
  const one = await get('/api/skills?include=pending')
  assert.deepEqual(one.body.map((s) => s.id), ['a-pub'], '★ 少一个条件仍然只剩 published')
})

test('⑥b ★★★ 由此推出一条**无法问出的问题**：没有"列出全部空间的所有 pending"这个形态', async () => {
  reset()
  mkSkill('ungranted-pending', { status: 'pending' })          // grants: []
  mkSkill('granted-pending', { status: 'pending', grants: ['general'] })
  // 任何**不给 member** 的查询都拿不到 pending（`wantPending` 要求 member=general）
  assert.deepEqual((await get('/api/skills?include=pending')).body.map((s) => s.id), [])
  assert.deepEqual((await get('/api/skills?scope=A&include=pending')).body.map((s) => s.id), [])
  // 而**给了 member** 就必然被 grants 过滤，那条没授权的 pending 就此隐身
  const rev = await get('/api/skills?member=general&include=pending')
  assert.ok(!rev.body.some((s) => s.id === 'ungranted-pending'),
    '★★★ 一条没被 grant 给 general 的 pending 技能，**没有任何查询形态**能看到它')
  assert.ok(rev.body.some((s) => s.id === 'granted-pending'))
  // ★ 但按 **id 直取**能拿到（那是另一条分支，只判 wantPending，不过 grants）
  const byId = await get('/api/skills?id=ungranted-pending&member=general&include=pending')
  assert.equal(byId.status, 200, '★★ 按 id 直取那条分支**不**受 grants 过滤 —— 与列表形态口径不同')
})

test('⑦ ★★★ `scope` 查询自动带上 `grants` 里有 `scope:<scope>` 的已发布技能', async () => {
  reset()
  mkSkill('in-scope', { status: 'published', scope: 'A' })
  mkSkill('shared', { status: 'published', scope: 'B', grants: ['scope:A'] })
  mkSkill('other', { status: 'published', scope: 'B' })
  const r = await get('/api/skills?scope=A')
  assert.deepEqual(r.body.map((s) => s.id).sort(), ['in-scope', 'shared'],
    '★★★ 跨空间共享（R-1）：查询 scope=A 要**自动**包含 grants 含 scope:A 的已发布技能')
  assert.ok(!r.body.some((s) => s.id === 'other'), '★ 不在 A、也没授权的不返回')
})

test('⑦b ★★ `member=<名字>` 查询带上 `grants` 里有该名字的已发布技能', async () => {
  reset()
  mkSkill('for-coder', { status: 'published', scope: 'B', grants: ['coder'] })
  mkSkill('for-qa', { status: 'published', scope: 'B', grants: ['qa'] })
  const r = await get('/api/skills?member=coder')
  assert.deepEqual(r.body.map((s) => s.id), ['for-coder'], '★★ 单值授权（member 查询形态）')
})

test('⑦c ★★ 给了 `scope` 后**不再**"全都要" —— 未授权的一律滤掉', async () => {
  reset()
  mkSkill('far', { status: 'published', scope: 'Z' })
  const r = await get('/api/skills?scope=A')
  assert.deepEqual(r.body, [], '★★ 一旦给了 scope，就不再有"全缺省即全部"的放行')
})

// ══════════════════════ GET /api/documents ══════════════════════

test('⑧ ★★★ 文档返回 `body`（参考资料），**不是** `prompt`', async () => {
  reset()
  mkDoc('d1', { body: '参考正文' })
  const r = await get('/api/documents')
  assert.equal(r.status, 200)
  assert.equal(r.body.length, 1)
  assert.equal(r.body[0].body, '参考正文', '★★★ 文档的全部用处就是它的正文，必须回')
  assert.equal(r.body[0].prompt, undefined, '★ 文档**没有** prompt（与技能刻意不同）')
})

test('⑨ ★★★ 文档**没有状态过滤**（不走向导机，登记即生效）', async () => {
  reset()
  // documents 表根本没有 status 列 —— 这条钉的是"别把 skills 的那套收口抄过来"
  const cols = mod.db.prepare('PRAGMA table_info(documents)').all().map((c) => c.name)
  assert.ok(!cols.includes('status'), '★★★ documents 表没有 status 列')
  mkDoc('d2')
  const r = await get('/api/documents')
  assert.equal(r.body.length, 1, '★★ 没有任何"未发布就隐藏"的逻辑')
})

test('⑩ ★★★ `id` 过滤走的是 `String(id)` 比较；空串等于不过滤', async () => {
  reset()
  mkDoc('x1'); mkDoc('x2')
  assert.deepEqual((await get('/api/documents?id=x1')).body.map((d) => d.id), ['x1'])
  assert.deepEqual((await get('/api/documents?id=nope')).body, [])
  assert.equal((await get('/api/documents?id=')).body.length, 2, '★ 空串按"不过滤"处理')
})

test('⑪ ★★ `scope` 过滤；空串等于不限空间（与技能"全缺省即全部"同口径）', async () => {
  reset()
  mkDoc('s1', { scope: 'A' }); mkDoc('s2', { scope: 'B' })
  assert.deepEqual((await get('/api/documents?scope=A')).body.map((d) => d.id), ['s1'])
  assert.equal((await get('/api/documents?scope=')).body.length, 2, '★ 空串 = 不限空间')
  assert.equal((await get('/api/documents')).body.length, 2, '★ 缺省 = 不限空间')
})

test('⑫ ★★ `origin` 是服务端写死的字段（客户端改不动）', async () => {
  reset()
  mkDoc('o1', { origin: 'member' })
  const r = await get('/api/documents')
  assert.ok(r.body[0].origin, '★ 要带 origin（装配侧逐条判可信性的前提）')
  assert.equal(r.body[0].origin, 'member')
})

// ══════════════════════ 接缝契约 ══════════════════════

const stub = (over = {}) => createContentReadsRoutes({
  json: (res, code, p) => { res.sent = { code, payload: p } },
  getSkill: () => ({ id: 'k', status: 'published' }),
  listSkills: () => [],
  listDocuments: () => [],
  ...over,
})

test('⑬ ★★★ dispatch 契约：只认 GET / 命中回 true / `exact` 不退化成 `prefix`', async () => {
  const router = stub()
  const ctx = (p) => ({ path: p, url: new URL('http://x' + p) })
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/skills')), true)
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/documents')), true)
  assert.equal(await router.dispatch({ method: 'POST' }, {}, ctx('/api/skills')), false, '★ 只认 GET')
  assert.equal(await router.dispatch({ method: 'DELETE' }, {}, ctx('/api/documents')), false)
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/skillsX')), false, '★ exact 不许退化成 startsWith')
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/documents/1')), false, '★ 子路径不归本族')
  assert.deepEqual(router.routes.map((r) => `${r.method} ${r.match} ${r.path}`),
    ['GET exact /api/skills', 'GET exact /api/documents'])
  assert.equal(router.id, 'content-reads')
})

test('⑭ ★★★ 查询参数**原样**递给域层（`undefined` 与空串是两回事）', async () => {
  const seen = []
  const router = stub({
    listSkills: (a) => { seen.push(['skills', a]); return [] },
    listDocuments: (a) => { seen.push(['docs', a]); return [] },
  })
  const run = async (p) => router.dispatch({ method: 'GET' }, {}, { path: p.split('?')[0], url: new URL('http://x' + p) })
  await run('/api/skills')
  await run('/api/skills?scope=A&member=general&include=pending')
  await run('/api/skills?scope=A&member=coder&include=pending')
  await run('/api/documents')
  await run('/api/documents?scope=A&id=d1')
  assert.deepEqual(seen[0][1], { scope: undefined, member: undefined, includePending: false },
    '★★ 缺省时传给域层的是 **undefined**（不是空串）')
  assert.deepEqual(seen[1][1], { scope: 'A', member: 'general', includePending: true })
  // ★★★ 我第一版在这里也写错了：`member=coder` 时 `includePending` 是 **false** ——
  //   `wantPending` 要的是 `member === 'general'` 这一个**具体值**，不是"给了 member 就行"。
  assert.deepEqual(seen[2][1], { scope: 'A', member: 'coder', includePending: false },
    '★★ includePending 只认 member=general 这一个值')
  assert.deepEqual(seen[3][1], { scope: undefined, id: undefined })
  assert.deepEqual(seen[4][1], { scope: 'A', id: 'd1' })
})

test('⑮ ★★ 缺注入项 ⇒ **构造时**就抛（fail closed）', async () => {
  const full = { json: () => {}, getSkill: () => ({}), listSkills: () => [], listDocuments: () => [] }
  for (const k of Object.keys(full)) {
    const partial = { ...full }
    delete partial[k]
    assert.throws(() => createContentReadsRoutes(partial), /缺注入项/, `★★ 少了 ${k} 必须在构造时就抛`)
  }
})
