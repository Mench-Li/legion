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
