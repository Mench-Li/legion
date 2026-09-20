// team-hub/role-pack-http.test.mjs
// ============================================================================
// F-19 缺口②的 **HTTP 边界**：冻结真的能通过产品库 API 落盘、读回、
// 并且 **409 真的走得到网络上**。
//
// 最后那一条是本文件的主要理由：`freezeRolePack` 里那个 409 是由
// `fail(..., 409)` 造出来的，而"库里抛了 409"与"客户端收到 409"之间
// 隔着一层 `handleRun` 的 `Number(e?.statusCode) || 400`。那层一旦不认识它，
// 调用方就会拿到 400，把"版本冲突"读成"我的请求格式不对"——
// 于是它永远不会去递增版本号，只会反复重试同一个请求。
// ============================================================================
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ROLE_PACK_SECTIONS, buildRolePack, normalizeRolePack } from '../runtime/employee/role-pack.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOKEN = 'role-pack-http-token'
const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-rp-http-'))
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
  try { parsed = JSON.parse(text) } catch { /* 导出那条返回 JSON 文本 */ }
  return { status: res.status, text, json: parsed }
}

/**
 * 造一个合法的内容哈希。
 *
 * ★ 它**校验**字符是十六进制：`H('z')` 会造出 `sha256:zzzz…`，而那是**不合法**的
 *   ——第一次跑这组时它就让我看到 `role-pack-hash-missing`，只不过报错发生在
 *   `buildRolePack` 里，看起来像实现的问题。一个"默默造出非法输入"的测试助手，
 *   会把测试自己的 bug 伪装成被测代码的 bug。
 */
const H = (c) => {
  assert.match(c, /^[0-9a-f]$/, `H() 只接受单个十六进制字符，收到 ${JSON.stringify(c)}`)
  return `sha256:${c.repeat(64)}`
}

/** 一份真实岗位包。`salt` 用来造"内容确实不同"的另一版。 */
function pack({ id = 'rp.dev', version = '1.0.0', promptVersion = '3', salt = 'a' } = {}) {
  return buildRolePack({
    rolePackId: id,
    role: 'dev',
    version,
    sections: {
      prompt: { id: 'dev-base', version: promptVersion, hash: H(salt) },
      skills: [{ id: 'skill.diff', version: '1.0.0' }],
      tools: { id: 'tools.dev', version: '1.2.0', hash: H('b') },
      permissions: { presetId: 'perm.dev', version: '1.0.0', hash: H('c') },
      model: { profileId: 'gpt-4-0613', version: '2024-01-01' },
      connectors: [],
      budget: { policyId: 'budget.std', version: '1.0.0', hash: H('d') },
    },
  })
}

test('① 冻结一版，读回来**原样**能喂给 `normalizeRolePack`', async () => {
  const p = pack()
  const post = await call('/api/role-packs', { method: 'POST', body: { pack: p, frozenBy: 'alice' } })
  assert.equal(post.status, 200, post.text)
  assert.equal(post.json.frozen, true)
  assert.equal(post.json.created, true)
  assert.equal(post.json.contentHash, p.contentHash)

  const get = await call('/api/role-packs?rolePackId=rp.dev')
  assert.equal(get.status, 200)
  // ★ 形状是 `records` + `latest`，**不随参数变**（见路由里的说明）。
  assert.equal(get.json.records.length, 1)
  assert.equal(get.json.records[0].packReadable, true)
  assert.equal(get.json.latest.pack.version, '1.0.0')
  // ★ 判据：从 HTTP 拿到的 `pack` **不做任何转写**就能喂回校验。
  const back = normalizeRolePack(get.json.records[0].pack)
  assert.equal(back.contentHash, p.contentHash)
  assert.deepEqual(Object.keys(back.sections), [...ROLE_PACK_SECTIONS])
})

test('② ★★★ 同版本换内容 ⇒ HTTP **409**（不是 400，也不是 200）', async () => {
  // 400 会让调用方以为"我的请求格式不对"，于是永远不去递增版本号。
  const p = pack({ id: 'rp.conflict', version: '2.0.0' })
  const first = await call('/api/role-packs', { method: 'POST', body: { pack: p } })
  assert.equal(first.status, 200, first.text)

  const different = pack({ id: 'rp.conflict', version: '2.0.0', promptVersion: '4', salt: 'f' })
  assert.notEqual(different.contentHash, p.contentHash, '两份包的内容必须真的不同')
  const clash = await call('/api/role-packs', { method: 'POST', body: { pack: different } })
  assert.equal(clash.status, 409, `期望 409，实际 ${clash.status}：${clash.text}`)
  assert.equal(clash.json.code, 'ROLE_PACK_VERSION_CONFLICT')
  assert.match(clash.json.error ?? '', /没有发生/)
  // 原来那一版一字未动。
  const after = await call('/api/role-packs?rolePackId=rp.conflict&version=2.0.0')
  assert.equal(after.json.records.length, 1)
  assert.equal(after.json.records[0].pack.contentHash, p.contentHash)
})

test('③ ★★ 同版本同内容 ⇒ 200 且 `created:false`（幂等重放不是错误）', async () => {
  const p = pack({ id: 'rp.idem' })
  const a = await call('/api/role-packs', { method: 'POST', body: { pack: p, frozenAtMs: 1000 } })
  const b = await call('/api/role-packs', { method: 'POST', body: { pack: p, frozenAtMs: 8888, frozenBy: 'bob' } })
  assert.equal(a.status, 200)
  assert.equal(b.status, 200, b.text)
  assert.equal(b.json.created, false, '重放应该报 created:false，而不是新建一版')
  assert.equal(b.json.frozenAtMs, 1000, '重试把冻结时刻改了')
  // 库里也只有一个版本。
  // ★ 用 `records.length` 而不是 `counts.total`：后者是**这个空间里一共有几版**
  //   （见 `rolePackCounts`），与"这个 id 有几版"是两个数。混用时——
  //   同一组用例里先冻过别的包——断言会莫名其妙地红，而红的理由与要看的东西无关。
  const list = await call('/api/role-packs?rolePackId=rp.idem')
  assert.equal(list.json.records.length, 1, '重放新建了一版')
  assert.equal(list.json.counts.total >= 1, true)
})

test('④ ★★★ 多个版本同时列出来（"当时是哪一版"要有得查）', async () => {
  const id = 'rp.multi'
  for (const [v, pv, salt, at] of [['1.0.0', '3', 'a', 1000], ['1.1.0', '4', 'e', 2000]]) {
    const r = await call('/api/role-packs', {
      method: 'POST', body: { pack: pack({ id, version: v, promptVersion: pv, salt }), frozenAtMs: at },
    })
    assert.equal(r.status, 200, r.text)
  }
  // 不传 version ⇒ 最新那一版。
  const latest = await call(`/api/role-packs?rolePackId=${id}`)
  assert.equal(latest.json.latest.pack.version, '1.1.0')
  assert.equal(latest.json.records.length, 2, '不给 version 时应该列出这个 id 的**全部**版本')
  // 显式要旧版 ⇒ 拿得到（这一条就是"冻结"与"就地更新"的分界）。
  const old = await call(`/api/role-packs?rolePackId=${id}&version=1.0.0`)
  assert.equal(old.json.records.length, 1)
  assert.equal(old.json.records[0].pack.version, '1.0.0')
  // 要一个没冻过的版本 ⇒ 空清单，而 `latest` 仍然如实给出最新那一版
  //    （"这个版本不存在"与"这个 id 没有历史"是两件事）。
  const missing = await call(`/api/role-packs?rolePackId=${id}&version=9.9.9`)
  assert.deepEqual(missing.json.records, [])
  assert.equal(missing.json.latest.pack.version, '1.1.0')
})

test('⑤ 按岗位列出（跨 rolePackId）', async () => {
  const mine = pack({ id: 'rp.byrole', salt: '9' })
  await call('/api/role-packs', { method: 'POST', body: { pack: mine } })
  const r = await call('/api/role-packs?role=dev')
  assert.equal(r.status, 200)
  const ids = r.json.records.map((x) => x.pack.rolePackId)
  assert.equal(ids.includes('rp.byrole'), true)
  // 找不到的角色给出空清单（而不是全部）。
  const none = await call('/api/role-packs?role=nobody')
  assert.deepEqual(none.json.records, [])
})

test('⑥ ★★ 坏事实在写入前被拒，且**一条都没落盘**', async () => {
  const before = (await call('/api/role-packs')).json.counts.total
  // 七类缺一。
  const p = pack({ id: 'rp.bad' })
  const sections = { ...p.sections }
  delete sections.budget
  const bad = await call('/api/role-packs', {
    method: 'POST',
    body: { pack: { ...p, sections, contentHash: p.contentHash } },
  })
  assert.equal(bad.status, 400, bad.text)
  assert.equal(bad.json.code, 'ROLE_PACK_SECTIONS_MISMATCH')
  // 形态版本不对。
  const bad2 = await call('/api/role-packs', {
    method: 'POST', body: { pack: { ...p, manifestVersion: 'legion/role-pack@9' } },
  })
  assert.equal(bad2.status, 400)
  assert.equal(bad2.json.code, 'ROLE_PACK_RECORD_MALFORMED')
  const after = (await call('/api/role-packs')).json.counts.total
  assert.equal(after, before, '坏输入在库里留下了东西')
})

test('⑦ ★ 没有"改一版 / 删一版"的路由（冻结只追加）', async () => {
  for (const [method, path] of [
    ['PUT', '/api/role-packs'], ['PATCH', '/api/role-packs'], ['DELETE', '/api/role-packs'],
    ['DELETE', '/api/role-packs?rolePackId=rp.dev'],
  ]) {
    const r = await call(path, { method })
    // 404/405 都行，但**绝不能**是 200——一次"顺手改一版"会让
    // "这个岗位当时是哪一版"在写的那一刻失去答案。
    assert.notEqual(r.status, 200, `${method} ${path} 居然成功了`)
  }
})

test('⑧ ★★ 导出是一条可下载的文本，含七类引用且不含整包内容', async () => {
  const res = await call('/api/role-packs/export', { raw: true })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-disposition') ?? '', /legion-role-packs-frozen\.json/)
  const doc = JSON.parse(res.text)
  assert.equal(doc.format, 'legion/role-pack-frozen@1')
  assert.equal(doc.packs.length > 0, true)
  const one = doc.packs.find((x) => x.rolePackId === 'rp.multi' && x.version === '1.1.0')
  assert.notEqual(one, undefined, '导出里没有刚冻的那一版')
  assert.deepEqual(Object.keys(one.sections), [...ROLE_PACK_SECTIONS])
  assert.equal(one.sections.prompt, 'dev-base@4')
  // 白名单：不许把整包 dump 出去，也不许出现凭证类字段名。
  assert.equal(res.text.includes('"pack"'), false, '导出把整包 dump 出去了')
  for (const forbidden of ['token', 'secret', 'password', 'apiKey']) {
    assert.equal(new RegExp(`"${forbidden}"`, 'i').test(res.text), false, `导出里出现了 ${forbidden}`)
  }
})

test('⑨ 未授权一律 401（读面与写面都是）', async () => {
  for (const [method, path] of [
    ['POST', '/api/role-packs'], ['GET', '/api/role-packs'], ['GET', '/api/role-packs/export'],
  ]) {
    const res = await fetch(`${base}${path}`, { method })
    assert.equal(res.status, 401, `${method} ${path} 没有鉴权`)
  }
})

test('⑩ ★ `scope` 隔离：同名 id 在两个空间里互不可见', async () => {
  const a = pack({ id: 'rp.scoped', version: '1.0.0', salt: 'a' })
  const b = pack({ id: 'rp.scoped', version: '1.0.0', promptVersion: '7', salt: '7' })
  assert.equal((await call('/api/role-packs', { method: 'POST', body: { pack: a, scope: 'team-a' } })).status, 200)
  assert.equal((await call('/api/role-packs', { method: 'POST', body: { pack: b, scope: 'team-b' } })).status, 200)
  const ra = await call('/api/role-packs?rolePackId=rp.scoped&scope=team-a')
  const rb = await call('/api/role-packs?rolePackId=rp.scoped&scope=team-b')
  assert.equal(ra.json.records[0].pack.contentHash, a.contentHash)
  assert.equal(rb.json.records[0].pack.contentHash, b.contentHash)
  // 没冻过的空间里没有它。
  const rc = await call('/api/role-packs?rolePackId=rp.scoped&scope=team-c')
  assert.deepEqual(rc.json.records, [])
  assert.equal(rc.json.latest, null)
})

// ══════════════════════════════════════════════════════════════════════════════
// ④ PRT-316 切片 10：role-packs 族搬进 `routes/role-packs.mjs` 之后的**缝上契约**
//
// 破验 16 条，第一轮咬住 13 条、漏网 3 条。逐条查完之后：
//
//   ① **真缺口**（2 条）—— 补判据：
//        K5  空白 `scope`：用例有 3 处 `scope=`，但**没有一处是空白**。
//            ⇒"规整"这一层没被验过。与切片 8 的 K10 是同一条。
//            ★ 它是**真行为差异**：`scope: '   '` 会把这一版冻进字面量 `'   '`
//            空间，之后按正常 scope 查不回来 —— 冻结没丢，但**读不回来**。
//        K10 `?limit=`：整份用例**一次都没用过**这个参数（已 grep 确认）。
//            ★ 这是**连续第二族**出现同一个缺口（切片 9 的 packs K11 也是它）——
//            两族的 `limit` 都接了线、都从没被测过。
//
//   ② **可证等价**（1 条）—— 不补判据，只记录证明并**钉住前提**：
//        K6  `frozenBy` 的 `?? null`：store 里是
//            `input.frozenBy === undefined || input.frozenBy === null ? null : String(input.frozenBy)`
//            ⇒ 路由端给 `null` 还是 `undefined`，到 SQL 都是 `null`。
//
//   ★ 缺口的**形状**与切片 8/9 完全同族：**用例只喂过"刚刚好正确"的输入**
//     （路径恰好等于前缀、参数恰好给了值、scope 恰好正常）。
//
// ▲ 既有 10 例仍在**真 hub** 上验（不替换、不删除）。
// ▲ 追加而非新建文件：`git ls-files "*.test.mjs"` 的条数被 `boundary-facts` 钉着。
// ══════════════════════════════════════════════════════════════════════════════

import { createRolePacksRoutes } from './routes/role-packs.mjs'
// K6 的等价性要钉住 store 端的前提，所以需要读源码。
import { readFileSync } from 'node:fs'

/** 会记录调用的假依赖 + 假 `res`（export 那条自己写响应头，不走 `json`）。 */
function rpSpy(over = {}) {
  const calls = []
  const sent = []
  const written = []
  const res = {
    writeHead: (code, headers) => { written.push([code, headers]) },
    end: (body) => { written.push(['end', body]) },
  }
  const body = over.body ?? { pack: { rolePackId: 'rp1', version: '1.0.0' }, frozenAtMs: 7, frozenBy: 'me' }
  const frozen = {
    frozen: { rolePackId: 'rp1', version: '1.0.0' },
    created: true,
    record: { projected: { rolePackId: 'rp1', version: '1.0.0', contentHash: 'h1' }, frozenAtMs: 7 },
  }
  const deps = {
    json: (_res, code, obj) => { sent.push([code, obj]) },
    authorized: over.authorized ?? (() => true),
    handleRun: async (_req, _res, fn) => {
      const out = await fn(body, 'me')
      sent.push([200, out])
      return out
    },
    freezeRolePack: (a) => { calls.push(['freeze', a]); return over.frozen ?? frozen },
    listRolePacks: (a) => { calls.push(['list', a]); return over.list ?? [{ pack: { rolePackId: 'rp1', version: '1.0.0' } }] },
    // 与 `server.mjs` 里的实现逐字一致
    optionalIntParam: (url, name) => {
      const raw = url.searchParams.get(name)
      if (raw === null || raw.trim() === '') return null
      const n = Number(raw)
      return Number.isSafeInteger(n) ? n : null
    },
    getRolePack: (a) => { calls.push(['get', a]); return { rolePackId: 'rp1', version: '1.0.0' } },
    rolePackCounts: (a) => { calls.push(['counts', a]); return { total: 1 } },
    exportRolePacks: (a) => { calls.push(['export', a]); return 'EXPORT-TEXT' },
    db: { __db: true },
  }
  Object.assign(deps, over.deps ?? {})
  const fam = createRolePacksRoutes(deps)
  const dispatch = (method, target) => {
    const url = new URL(`http://x${target}`)
    return fam.dispatch({ method, headers: {} }, res, { path: url.pathname, url })
  }
  return { dispatch, calls, sent, written }
}
const last = (calls, n) => calls.filter((c) => c[0] === n).at(-1)

test('④ ★★ K16：`exact` 不许退化成前缀 —— 邻接命名空间一个都不许被吃掉', async () => {
  // 既有用例只请求过**刚刚好正确**的路径（与前两片的 K14/K12 同一族）。
  const s = rpSpy()
  for (const [m, p] of [['GET', '/api/role-packsX'], ['GET', '/api/role-packs/exportX'],
    ['GET', '/api/role-packs/export/more'], ['POST', '/api/role-packsZ'],
    ['GET', '/api/role-pack'], ['GET', '/api/role-packs/']]) {
    assert.equal(await s.dispatch(m, p), false, `${m} ${p} 被本族接住了 —— exact 退化了？`)
  }
  assert.deepEqual(s.calls, [], '未匹配的请求却碰了仓储')
  // 正面控制：三条正路径必须被接住（否则"一律不接"也能让上面通过）
  for (const [m, p, fn] of [['POST', '/api/role-packs', 'freeze'],
    ['GET', '/api/role-packs', 'list'], ['GET', '/api/role-packs/export', 'export']]) {
    const ok = rpSpy()
    assert.equal(await ok.dispatch(m, p), true, `${m} ${p} 没被接住`)
    assert.ok(last(ok.calls, fn), `${m} ${p} 没走到 ${fn}`)
  }
})

test('④ ★★ K10：`?limit=` 必须真的传下去（不是收了不用）', async () => {
  // ★ 这是**连续第二族**出现同一个缺口（切片 9 的 packs K11 也是它）：
  //   两族的 `limit` 都接了线、都从没被测过。
  const s = rpSpy()
  await s.dispatch('GET', '/api/role-packs?limit=2')
  assert.equal(last(s.calls, 'list')?.[1]?.limit, 2, 'limit 没有传到 store')
  const empty = rpSpy()
  await empty.dispatch('GET', '/api/role-packs?limit=')
  assert.equal(last(empty.calls, 'list')[1].limit, null, '空 limit 应当是 null')
  // 非数值折成 null；★ 负数**不会**被这一层拒（`optionalIntParam` 只要求安全整数），
  // 真正忽略它的是 store。这条与切片 9 记的是同一个既有不对称。
  for (const q of ['limit=abc', 'limit=1.5']) {
    const x = rpSpy()
    await x.dispatch(`GET`, `/api/role-packs?${q}`)
    assert.equal(last(x.calls, 'list')[1].limit, null, `${q} 应当折成 null`)
  }
  const neg = rpSpy()
  await neg.dispatch('GET', '/api/role-packs?limit=-3')
  assert.equal(last(neg.calls, 'list')[1].limit, -3, '负数 limit 的处置变了 ⇒ 请复核 store 的兜底')
  const storeSrc = readFileSync('team-hub/role-pack-store.mjs', 'utf8').replace(/\s+/g, ' ')
  assert.ok(/limit/.test(storeSrc), 'store 不再认 limit ⇒ 请补路由端判据')
})

test('④ ★★ K5：`scope` 必须**规整**（空白 ⇒ default，两侧空白去掉）', async () => {
  // 既有用例有 3 处 `scope=`，但没有一处是**空白** —— 于是"规整"整个没被验过。
  // ★ 真行为差异：`scope: '   '` 会把这一版冻进字面量 `'   '` 空间，
  //   之后按正常 scope 查不回来 —— 冻结没丢，但**读不回来**。
  const CASES = [[undefined, 'default'], ['', 'default'], ['   ', 'default'],
    ['  x  ', 'x'], ['ops', 'ops']]
  for (const [given, want] of CASES) {
    const body = { pack: { rolePackId: 'rp1', version: '1.0.0' }, frozenAtMs: 1,
      ...(given === undefined ? {} : { scope: given }) }
    const s = rpSpy({ body })
    await s.dispatch('POST', '/api/role-packs')
    assert.equal(last(s.calls, 'freeze')?.[1]?.scope, want,
      `冻结 scope ${JSON.stringify(given)} 得到 ${JSON.stringify(last(s.calls, 'freeze')?.[1]?.scope)}`)
  }
})

test('④ ★★★ 列表的**形状不随查询参数变**（这是模块里写明的契约）', async () => {
  // 模块里有一段长注释说明这件事：早先是"给了 rolePackId 就返回单条 `record`"，
  // 于是调用方必须知道"我刚才给没给 rolePackId"才知道读哪个字段。
  // 这里把它钉住：无论给什么参数组合，`records`/`latest`/`counts` 三个键**都在**。
  const COMBOS = ['', '?rolePackId=rp1', '?version=1.0.0', '?role=ops', '?scope=x',
    '?rolePackId=rp1&version=1.0.0&role=ops&scope=x&limit=1']
  for (const q of COMBOS) {
    const s = rpSpy()
    await s.dispatch('GET', `/api/role-packs${q}`)
    const b = s.sent.at(-1)?.[1] ?? {}
    assert.deepEqual(Object.keys(b).sort(), ['counts', 'latest', 'ok', 'records'],
      `查询参数 ${q || '（无）'} 改变了响应形状`)
  }
  // `latest` 只在**给了 rolePackId** 时才有值；`version` 只过滤清单、不改变形状
  const noId = rpSpy()
  await noId.dispatch('GET', '/api/role-packs?version=1.0.0')
  assert.equal(noId.sent.at(-1)?.[1].latest, null, '没给 rolePackId 时 latest 必须是 null')
  assert.equal(noId.calls.filter((c) => c[0] === 'get').length, 0, '没给 id 却去查了 latest')
  const withId = rpSpy()
  await withId.dispatch('GET', '/api/role-packs?rolePackId=rp1')
  assert.ok(last(withId.calls, 'get'), '给了 rolePackId 却没查 latest')
  assert.equal(withId.sent.at(-1)?.[1].latest?.rolePackId, 'rp1')
  // 空串与"没给"同样按"没给"处理
  const emptyId = rpSpy()
  await emptyId.dispatch('GET', '/api/role-packs?rolePackId=')
  assert.equal(emptyId.sent.at(-1)?.[1].latest, null, '空 rolePackId 应当按"没给"处理')
  assert.equal(emptyId.calls.filter((c) => c[0] === 'get').length, 0)
})

test('④ ★ `version` 只**过滤**清单（空串与"没给"都不过滤）', async () => {
  const list = [{ pack: { version: '1.0.0' } }, { pack: { version: '2.0.0' } }, { pack: null }]
  for (const q of ['', '?version=', '?version=1.0.0', '?version=9.9.9']) {
    const s = rpSpy({ list })
    await s.dispatch('GET', `/api/role-packs${q}`)
    const recs = s.sent.at(-1)?.[1].records
    const want = q === '?version=1.0.0' ? 1 : q === '?version=9.9.9' ? 0 : 3
    assert.equal(recs.length, want, `version=${JSON.stringify(q)} 过滤出了 ${recs.length} 条（期望 ${want}）`)
  }
  // ★ `pack: null` 的记录在过滤时**不许抛**（用了可选链），且不过滤时必须原样保留
  const s = rpSpy({ list })
  await s.dispatch('GET', '/api/role-packs?version=1.0.0')
  assert.equal(s.sent.at(-1)?.[1].ok, true)
})

test('④ 两条读路由：未授权 401 且**不查仓储 / 不写响应头**', async () => {
  for (const p of ['/api/role-packs', '/api/role-packs/export']) {
    const s = rpSpy({ authorized: () => false })
    assert.equal(await s.dispatch('GET', p), true)
    assert.equal(s.sent.at(-1)?.[0], 401, `${p} 没有 401`)
    assert.deepEqual(s.calls, [], `${p} 在未授权时仍然查了仓储`)
    assert.deepEqual(s.written, [], `${p} 在未授权时已经写了响应头`)
  }
})

test('④ 冻结**不**做 authorized 前置（鉴权在 `handleRun` 里，与既有语义一致）', async () => {
  const s = rpSpy({ authorized: () => false })
  await s.dispatch('POST', '/api/role-packs')
  assert.notEqual(s.sent.at(-1)?.[0], 401, '冻结在路由头做了 401 —— 与既有语义不符')
})

test('④ ★ 冻结必须**先**把 `pack` 原样交给 store（不在这一层挑字段/补默认值）', async () => {
  // 模块里写明的理由：`pack` 原样收下，控制面不挑字段、不重排、不补默认值
  // ——挑字段就是一份多余的转写。这里钉住"这一层没有转写"。
  const pack = { rolePackId: 'rp1', version: '1.0.0', tools: ['a', 'b'], extra: { deep: 1 } }
  const s = rpSpy({ body: { pack, frozenAtMs: 9, frozenBy: 'me' } })
  await s.dispatch('POST', '/api/role-packs')
  const arg = last(s.calls, 'freeze')?.[1]
  assert.equal(arg.record.pack, pack, 'pack 被转写了（不是同一个对象/同一份内容）')
  assert.deepEqual(Object.keys(arg.record).sort(), ['frozenAtMs', 'frozenBy', 'pack'],
    '这一层往 record 里加了/减了字段')
  assert.equal(arg.db.__db, true, '没有把 db 交给 store')
})

test('④ ★ 冻结的响应必须能分清「冻了新一版」与「这一版早就冻过」', async () => {
  for (const created of [true, false]) {
    const s = rpSpy({ frozen: { frozen: { rolePackId: 'rp1', version: '1.0.0' }, created,
      record: { projected: { rolePackId: 'rp1', version: '1.0.0', contentHash: 'h1' }, frozenAtMs: 7 } } })
    await s.dispatch('POST', '/api/role-packs')
    const b = s.sent.at(-1)?.[1]
    assert.equal(b.created, created, 'created 没有透传 —— 幂等重放与新建分不出')
    assert.equal(b.ok, true)
    assert.equal(b.rolePackId, 'rp1')
    assert.equal(b.version, '1.0.0')
    assert.equal(b.contentHash, 'h1')
    assert.equal(b.frozenAtMs, 7)
    assert.ok(b.frozen, 'frozen 没有透传')
  }
})

test('④ ★ export 是**附件**且正文来自 `exportRolePacks`（自己写响应头，不走 json）', async () => {
  // ★ 注意 store 那侧的形状与 packs 族**不同**：`exportRolePacks` 直接返回**字符串**，
  //   而 `exportPackFacts` 返回 `{ text }`。这个差别是原样搬过来的（零改写）。
  const s = rpSpy()
  assert.equal(await s.dispatch('GET', '/api/role-packs/export'), true)
  assert.deepEqual(s.sent, [], 'export 不该走 json（它自己写响应头）')
  const [code, headers] = s.written[0] ?? []
  assert.equal(code, 200)
  assert.equal(headers?.['content-disposition'],
    'attachment; filename="legion-role-packs-frozen.json"', '导出不再是附件')
  assert.equal(headers?.['content-type'], 'application/json; charset=utf-8')
  assert.equal(s.written.at(-1)?.[0], 'end')
  assert.equal(s.written.at(-1)?.[1], 'EXPORT-TEXT', '导出的正文不是 store 给的那份')
  // scope 要透传（导出的是**某一个空间**的账）
  const scoped = rpSpy()
  await scoped.dispatch('GET', '/api/role-packs/export?scope=ops')
  assert.equal(last(scoped.calls, 'export')?.[1]?.scope, 'ops')
})

test('④ ★ K6 是可证等价：把前提钉在 store 源码上，而不是把实参钉死', async () => {
  // `frozenBy: body.frozenBy ?? null` 被去掉之后没有任何输入能分叉，
  // 因为 store 自己也兜了同一个值。处置：不写"实参必须是什么"（那会把实现细节钉死），
  // 而是**钉住下游那处兜底** —— 它一变，这里就红，那时才真需要补路由端判据。
  const store = readFileSync('team-hub/role-pack-store.mjs', 'utf8').replace(/\s+/g, ' ')
  const needle = 'input.frozenBy === undefined || input.frozenBy === null ? null : String(input.frozenBy)'
  assert.ok(store.includes(needle),
    'store 端对 frozenBy 的兜底不见了 ⇒ K6 那条"可证等价"的前提失效，请补一条路由端判据。'
    + `\n  期望在 role-pack-store.mjs 里找到：${needle}`)
  // 等价性本身用可执行的等式写下来（读的人不必再推一遍）
  const asFrozenBy = (v) => (v === undefined || v === null ? null : String(v))
  assert.equal(asFrozenBy(undefined), asFrozenBy(null))
  assert.equal(asFrozenBy('me'), 'me')
})
