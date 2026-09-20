// ============================================================================
// PRT-316 切片 51：产物文件内容 —— 1 条，`exact`
//   GET /api/artifact/content?task=&i=
//
// ★★★ 这条路由只有 6 行，而它的**全部语义就是"原样透传"**：
//     const result = artifactContent(url.searchParams.get('task') ?? '', url.searchParams.get('i') ?? undefined)
//     json(res, result.status, result.body)
//
//   状态码是**域层决定的**（400 缺参 / 400 无产物 / 400 越界 / 400 非 file /
//   403 路径不在允许范围 / 404 取不到 / 404 文件不存在 / 200 成功）。
//   ⇒ 判据要钉的不是"返回 200"，而是**"域层说什么就是什么，路由一个字都不许改"**。
//
//   ★★★ 最要紧的一条：**403 必须原样是 403**。
//       一个"友好化"地把 4xx 统一成 200 的改动，在这里就是**越权读取**。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createArtifactContentRoutes } from './routes/artifact-content.mjs'

/** 造一个路由器，`artifactContent` 换成桩；把收到的实参记下来。 */
const make = (impl) => {
  const calls = []
  const sent = []
  const router = createArtifactContentRoutes({
    json: (res, code, payload) => { sent.push({ code, payload }); res.sent = { code, payload } },
    artifactContent: (...a) => { calls.push(a); return impl(...a) },
  })
  return { router, calls, sent }
}

const ctx = (q) => ({ path: '/api/artifact/content', url: new URL('http://x/api/artifact/content' + q) })
const curl = (q) => ctx(q)

// ══════════════════════ 透传：状态码与正文都是域层的 ══════════════════════

test('① ★★★★★ 域层给什么状态码就发什么 —— **403 原样是 403**', async () => {
  // ★★★ 这是本族最要紧的一条。若有人把 403 "友好化"成 200（或统一成 404 掩盖），
  //     那就是**越权读取产物文件**。
  for (const status of [200, 400, 403, 404, 500, 418]) {
    const { router, sent } = make(() => ({ status, body: { tag: `s${status}` } }))
    await router.routes[0].run({ method: 'GET' }, {}, curl('?task=T'))
    assert.equal(sent.length, 1, `★ 只写一次响应（${status}）`)
    assert.equal(sent[0].code, status, `★★★★★ 域层给 ${status}，路由必须发 ${status} —— 一个字都不许改`)
    assert.deepEqual(sent[0].payload, { tag: `s${status}` }, '★ 正文也是原样')
  }
})

test('② ★★★ 正文**原样**透传（不包 `{ok:true}`、不挑字段）', async () => {
  const body = {
    taskId: 'T', i: 2, path: 'a/b.md', relPath: 'b.md', source: 'worktree',
    size: 12, limit: 65536, truncated: false, previewable: true, mime: 'text/markdown', content: '# hi',
  }
  const { router, sent } = make(() => ({ status: 200, body }))
  await router.routes[0].run({ method: 'GET' }, {}, curl('?task=T&i=2'))
  assert.deepEqual(sent[0].payload, body, '★★★ 逐字相同 —— 不包壳、不投影、不改名')
  assert.ok(!('ok' in sent[0].payload), '★ 没有 `ok` 包壳（与 handleWrite/handleRun 那条路不同）')
})

test('③ ★★★ 连 `undefined` 状态码也照发（路由不做校验、不做兜底）', async () => {
  // ★ 这是"原样透传"的**边界**：路由**不**替域层兜底。
  const { router, sent } = make(() => ({ status: undefined, body: {} }))
  await router.routes[0].run({ method: 'GET' }, {}, curl('?task=T'))
  assert.equal(sent[0].code, undefined, '★★ 路由不把 undefined 兜成 500 —— 那是域层的责任')
  assert.deepEqual(sent[0].payload, {})
})

test('④ ★★ 域层抛出 ⇒ 让异常**冒上去**（不吞、不改状态）', async () => {
  const { router, sent } = make(() => { throw new Error('域层炸了') })
  await assert.rejects(() => router.routes[0].run({ method: 'GET' }, {}, curl('?task=T')), /域层炸了/,
    '★★★ 路由不 try/catch —— 兜底在 `handle()` 那一层')
  assert.equal(sent.length, 0, '★ 抛出时一条响应都没写（交给外层记 500）')
})

// ══════════════════════ 两个查询参数的**缺省值不对等** ══════════════════════

test('⑤ ★★★ `task` 缺省是**空串**，`i` 缺省是 **undefined**（两个 `??` 兜底不同）', async () => {
  const { router, calls } = make(() => ({ status: 200, body: {} }))
  await router.routes[0].run({ method: 'GET' }, {}, curl(''))
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['', undefined],
    '★★★ 全不给 ⇒ `artifactContent("", undefined)` —— **task 是空串、i 是 undefined**，'
    + '不是两个都给 undefined、也不是两个都给空串')
})

test('⑥ ★★★ `?i=` 给的是**空串**，而 `?` 不给是 **undefined** —— 域层把两者当同一件事', async () => {
  const { router, calls } = make(() => ({ status: 200, body: {} }))
  await router.routes[0].run({ method: 'GET' }, {}, curl('?task=T'))
  assert.equal(calls[0][1], undefined, '★ 不给 `i` ⇒ undefined')
  await router.routes[0].run({ method: 'GET' }, {}, curl('?task=T&i='))
  assert.equal(calls[0 + 1][1], '', '★ `?i=` ⇒ **空串**（`null ?? undefined` 那条路走不到，因为 `get` 给了 `""`）')

  // ★★ 但域层那边 `rawI === undefined || rawI === null || rawI === ''` **三个一起判**，
  //    ⇒ 这两种在**下游完全等价**。这个不对称是**冗余**的，不是缺陷。
  //    > 一个「路由把 i 分成了 undefined 和 '' 两种，域层大概会区别对待」的印象，
  //    > 与一个「域层把 undefined / null / '' 三个一起当"没给"」的事实，
  //    > 在我把域层第一个判断读出来之前是同一个东西。
  assert.match('rawI === undefined || rawI === null || rawI === \'\'', /undefined.*null.*''/,
    '★ 记下这条等价关系（域层三值同判）')
})

test('⑦ ★★ 参数原样进域层（不 trim、不 Number、不去空）', async () => {
  const { router, calls } = make(() => ({ status: 200, body: {} }))
  const cases = [
    ['?task=%20T%20&i=01', [' T ', '01']],
    ['?task=%20&i=%20', [' ', ' ']],
    ['?task=T&i=abc', ['T', 'abc']],
    ['?task=T&i=-1', ['T', '-1']],
    ['?task=T&i=1e3', ['T', '1e3']],
    ['?task=%E4%B8%AD%E6%96%87', ['中文', undefined]],
  ]
  for (const [q, want] of cases) {
    await router.routes[0].run({ method: 'GET' }, {}, curl(q))
    assert.deepEqual(calls.at(-1), want, `★★ ${q} ⇒ 原样的 [task, i]（不做任何规范化）`)
  }
})

// ══════════════════════ 接缝契约 ══════════════════════

test('⑧ ★★★ dispatch 契约：只认 `GET /api/artifact/content`，`exact` 不退化成 `prefix`', async () => {
  const { router } = make(() => ({ status: 200, body: {} }))
  const c = (p) => ({ path: p, url: new URL('http://x' + p) })
  assert.equal(await router.dispatch({ method: 'GET' }, {}, c('/api/artifact/content')), true)
  assert.equal(await router.dispatch({ method: 'GET' }, {}, c('/api/artifact/contentX')), false, '★★ exact 不许退化成 startsWith')
  assert.equal(await router.dispatch({ method: 'GET' }, {}, c('/api/artifact/contents')), false)
  assert.equal(await router.dispatch({ method: 'GET' }, {}, c('/api/artifact')), false, '★★★ 父路径**不**命中（否则会把别的路由抢走）')
  assert.equal(await router.dispatch({ method: 'GET' }, {}, c('/api/artifacts/content')), false)
  assert.equal(await router.dispatch({ method: 'POST' }, {}, c('/api/artifact/content')), false, '★ 只认 GET')
  assert.equal(await router.dispatch({ method: 'HEAD' }, {}, c('/api/artifact/content')), false, '★ HEAD 也不认')
  assert.deepEqual(router.routes.map((r) => `${r.method} ${r.match} ${r.path}`), ['GET exact /api/artifact/content'])
  assert.equal(router.id, 'artifact-content')
})

test('⑨ ★★★ 只查 `url.searchParams`（不看 body、不看 header）', async () => {
  const { router, calls } = make(() => ({ status: 200, body: {} }))
  await router.routes[0].run(
    { method: 'GET', body: { task: 'FROM_BODY', i: '9' }, headers: { 'x-task': 'FROM_HEADER' } },
    {}, curl('?task=FROM_QUERY'))
  assert.deepEqual(calls[0], ['FROM_QUERY', undefined],
    '★★★ 只从查询串取 —— body / header 都不该被读（这条是 GET，没有 body）')
})

test('⑩ ★★ 缺注入项 ⇒ **构造时**就抛（fail closed）', async () => {
  const full = { json: () => {}, artifactContent: () => ({ status: 200, body: {} }) }
  for (const k of Object.keys(full)) {
    const partial = { ...full }
    delete partial[k]
    assert.throws(() => createArtifactContentRoutes(partial), /缺注入项/, `★★ 少了 ${k} 必须在构造时就抛`)
  }
})

test('⑪ ★★★ 模块里**没有** try/catch、也没有自己的状态码字面量', async () => {
  const src = await import('node:fs').then((m) => m.readFileSync('team-hub/routes/artifact-content.mjs', 'utf8'))
  const body = src.slice(src.indexOf('run('))
  assert.ok(!/try\s*\{/.test(body), '★★★ 路由体里不许有 try —— 兜底在 handle() 那一层')
  assert.ok(!/catch\s*\(/.test(body), '★★★ 也不许 catch')
  // ★ 状态码只能来自 `result.status`，不许出现写死的 200/400/403/404
  const hard = body.match(/\bjson\([^)]*?\b([1-5]\d\d)\b/g) ?? []
  assert.deepEqual(hard, [], '★★★★★ 路由里**一个写死的状态码都不许有** —— 那就是"友好化"403 的入口')
  assert.match(body, /json\(res,\s*result\.status,\s*result\.body\)/,
    '★★★ 只能是 `json(res, result.status, result.body)` 这一种形状')
})
