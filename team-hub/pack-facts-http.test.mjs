// team-hub/pack-facts-http.test.mjs
// ============================================================================
// F-20 缺口③的 **HTTP 边界**：安装事实真的能通过产品库 API 落盘、读回，
// 并且能在**换一个进程内模块实例**之后重建出同一份状态。
//
// 为什么非要起真 hub：这一层的工作全部在"跨请求、跨实例"上。
// 一个用假 db 喂出来的"路由已验证"，与一个从没发过那次请求的路由，
// 在部署上是同一个东西——只不过前者的用例数是完整的。
// ============================================================================
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOKEN = 'pack-facts-http-token'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-pack-http-'))
const DB_FILE = join(tmpRoot, 'team.db')
let mod
let base = ''

/** 所有起过的实例，收尾时一并关掉（否则会留下句柄让套件超时）。 */
const opened = []

function closeAll() {
  for (const m of opened.reverse()) {
    try { m.server.closeAllConnections?.() } catch { /* 无连接 */ }
    try { m.server.close() } catch { /* 已关 */ }
    try { m.db.close() } catch { /* 已关 */ }
  }
  opened.length = 0
}

/**
 * 起一个 hub 实例（**在进程内**，与 `automation-http.test.mjs` 同一套约定）。
 *
 * `tag` 拼进 import 说明符，于是拿到的是一个**全新的模块实例**——
 * 这正是"重启"在本文件里的含义：内存里什么都不带，账只能从盘上回来。
 *
 * ★ 诚实边界：这是"模块实例重启"，不是"操作系统进程重启"。
 *   对**这一层**要证明的事（账不在内存里）两者等价；不等价的那部分
 *   （真进程边界、端口、句柄）由 launcher 那一组与 `run-kill-drill` 覆盖。
 *
 * ★ `dbFile` 显式给：两个实例共用同一个库文件时 SQLite 会互相锁，
 *   而"这个用例偶尔红"与"实现有并发缺陷"在报告上长得一样。
 *   用例之间用不同的库文件把它们**在结构上**分开，而不是靠运气。
 */
async function freshHub(tag, { dbFile = DB_FILE } = {}) {
  process.env.TEAM_HUB_DB = dbFile
  process.env.TEAM_HUB_TOKEN = TOKEN
  process.env.TEAM_HUB_HOST = '127.0.0.1'
  const m = await import(`./server.mjs?${tag}`)
  await new Promise((resolve) => m.server.listen(0, '127.0.0.1', resolve))
  opened.push(m)
  return { mod: m, base: `http://127.0.0.1:${m.server.address().port}` }
}

before(async () => {
  const h = await freshHub('boot')
  mod = h.mod
  base = h.base
})

after(() => {
  closeAll()
  rmSync(tmpRoot, { recursive: true, force: true })
})

const auth = { authorization: `Bearer ${TOKEN}` }

async function callOn(target, path, { method = 'GET', body = null } = {}) {
  const res = await fetch(`${target.base}${path}`, {
    method,
    headers: { ...auth, 'content-type': 'application/json' },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* 导出那条返回的是原始 JSON 文本 */ }
  return { status: res.status, text, json: parsed }
}

const call = (path, opts) => callOn({ base }, path, opts)

const FACT = (over = {}) => ({
  at: 1700000000000, kind: 'install', packId: 'legion.software-delivery',
  version: '1.0.0', packType: 'team', packProtocolVersion: 'legion/pack-manifest@1',
  contentHash: 'h-1.0.0', declaredContentHash: 'h-1.0.0', trust: 'builtin',
  verdictCodes: [], preflightVersion: 'legion/pack-preflight@1',
  ...over,
})

/** 从某实例的 `/api/packs/account` 拿账并交给**真的** `createPackStore`。 */
async function rebuildStore(target) {
  const acc = await callOn(target, '/api/packs/account')
  const { createPackStore } = await import('../runtime/packs/store.mjs')
  return createPackStore({ now: () => 0, history: acc.json })
}

test('① 追加一条事实，读回来是同一条（真 HTTP、真落盘）', async () => {
  const post = await call('/api/packs/facts', { method: 'POST', body: FACT({ packId: 'legion.basic' }) })
  assert.equal(post.status, 200, post.text)
  assert.equal(post.json.ok, true)
  assert.equal(post.json.seq, 1)

  const get = await call('/api/packs/facts?packId=legion.basic')
  assert.equal(get.status, 200)
  assert.equal(get.json.records.length, 1)
  const r = get.json.records[0]
  assert.equal(r.kind, 'install')
  assert.equal(r.packId, 'legion.basic')
  assert.equal(r.version, '1.0.0')
  assert.equal(r.contentHash, 'h-1.0.0')
  assert.equal(r.trust, 'builtin')
  assert.equal(r.seq, 1)
})

test('② ★★★ 账能跨**模块实例重启**重建：新实例读出同一份状态，seq 接着走', async () => {
  const rdb = join(tmpRoot, 'restart.db')
  const h1 = await freshHub('restart-1', { dbFile: rdb })
  for (const f of [
    FACT({ packId: 'legion.restart', version: '1.0.0', contentHash: 'r1', declaredContentHash: 'r1' }),
    FACT({
      packId: 'legion.restart', kind: 'upgrade', version: '1.1.0',
      contentHash: 'r2', declaredContentHash: 'r2', fromVersion: '1.0.0', fromContentHash: 'r1',
    }),
    FACT({ packId: 'legion.restart', kind: 'enable', version: '1.1.0' }),
  ]) {
    const r = await callOn(h1, '/api/packs/facts', { method: 'POST', body: f })
    assert.equal(r.status, 200, r.text)
  }
  const before = await callOn(h1, '/api/packs/account')
  const seqBefore = before.json.seq
  assert.equal(seqBefore, 3)

  // ★ 全新的模块实例 = 内存里什么都不带。同一个实例里再读一次永远是对的，
  //   而那证明不了"账不在内存里"。
  const h2 = await freshHub('restart-2', { dbFile: rdb })
  const after = await callOn(h2, '/api/packs/account')
  assert.equal(after.json.seq, seqBefore)
  assert.equal(after.json.version, before.json.version)
  assert.deepEqual(
    after.json.records.map((r) => [r.seq, r.kind, r.version]),
    before.json.records.map((r) => [r.seq, r.kind, r.version]),
  )
  // 追加的下一条接着走，不从 1 重来——seq 从 1 重来会让两条不同的记录
  // 共用同一个 seq，而 seq 是"账只追加、记录不可变"唯一的凭据。
  const next = await callOn(h2, '/api/packs/facts', {
    method: 'POST', body: FACT({ packId: 'legion.restart', kind: 'rollback', version: '1.0.0' }),
  })
  assert.equal(next.json.seq, seqBefore + 1, 'seq 在新实例里重来了——账的顺序失去了凭据')
  // 重建出来的状态也是对的。
  const store = await rebuildStore(h2)
  const s = store.stateOf('legion.restart')
  assert.equal(s.activeVersion, '1.0.0')
  assert.equal(s.enabled, true)
})

test('③ ★★★ `/api/packs/account` 的形状**真的**能喂给 `createPackStore`', async () => {
  const h = await freshHub('account-shape', { dbFile: join(tmpRoot, 'shape.db') })
  await callOn(h, '/api/packs/facts', { method: 'POST', body: FACT({ packId: 'legion.shape' }) })
  await callOn(h, '/api/packs/facts', {
    method: 'POST',
    body: FACT({ packId: 'legion.shape', kind: 'upgrade', version: '1.1.0', contentHash: 'h-1.1.0', declaredContentHash: 'h-1.1.0' }),
  })
  await callOn(h, '/api/packs/facts', { method: 'POST', body: FACT({ packId: 'legion.shape', kind: 'enable', version: '1.1.0' }) })

  // ★ 判据：从 HTTP 拿到的账**原样**能重建出 store，调用方不做任何转写。
  //   需要转写时，那个转写就是第二份推导——两份推导今天一致、没人维持。
  const store = await rebuildStore(h)
  const s = store.stateOf('legion.shape')
  assert.equal(s.installed, true)
  assert.equal(s.enabled, true)
  assert.equal(s.activeVersion, '1.1.0')
  assert.equal(s.contentHash, 'h-1.1.0')
  assert.deepEqual([...s.installedVersions].sort(), ['1.0.0', '1.1.0'])
  assert.deepEqual(store.rollbackTargets('legion.shape'), ['1.0.0'])
})

test('④ ★★ 坏事实在写入前被拒，且**账上一条都不多**', async () => {
  const h = await freshHub('bad-facts', { dbFile: join(tmpRoot, 'bad.db') })
  const bad = await callOn(h, '/api/packs/facts', { method: 'POST', body: FACT({ kind: 'sideways' }) })
  assert.equal(bad.status, 400, bad.text)
  assert.equal(bad.json.code, 'PACK_FACT_UNKNOWN_KIND')
  const bad2 = await callOn(h, '/api/packs/facts', { method: 'POST', body: FACT({ packId: '' }) })
  assert.equal(bad2.status, 400)
  const after = await callOn(h, '/api/packs/facts')
  assert.equal(after.json.records.length, 0, '坏输入在账上留下了东西')
  assert.equal(after.json.counts.total, 0)
})

test('⑤ ★ 没有"改一条 / 删一条"的路由（账只追加）', async () => {
  const h = await freshHub('no-mutate', { dbFile: join(tmpRoot, 'nomutate.db') })
  await callOn(h, '/api/packs/facts', { method: 'POST', body: FACT({ packId: 'legion.immutable' }) })
  for (const method of ['DELETE', 'PUT', 'PATCH']) {
    const r = await callOn(h, '/api/packs/facts', { method })
    // 404/405 都行，但**绝不能**是 200——一次"顺手修正"会让
    // "这条记录是谁改的"永远无法回答。
    assert.notEqual(r.status, 200, `${method} /api/packs/facts 居然成功了`)
  }
  const after = await callOn(h, '/api/packs/facts?packId=legion.immutable')
  assert.equal(after.json.records.length, 1)
})

test('⑥ ★★ 导出是一条可下载的文本，且不含包内容 / 凭证', async () => {
  const h = await freshHub('export', { dbFile: join(tmpRoot, 'export.db') })
  await callOn(h, '/api/packs/facts', { method: 'POST', body: FACT({ packId: 'legion.exported' }) })
  const res = await fetch(`${h.base}/api/packs/export`, { headers: auth })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-disposition') ?? '', /legion-pack-install-facts\.json/)
  const text = await res.text()
  const doc = JSON.parse(text)
  assert.equal(doc.format, 'legion/pack-install-facts@1')
  assert.equal(doc.accountVersion, 'legion/pack-store@1')
  assert.deepEqual(doc.packs.map((p) => p.packId), ['legion.exported'])
  // 导出里不许出现内容 / 密钥引用。一个把包内容一起导出的文件，
  // 会在第一次 `git add .` 时把内容带进版本历史，而版本历史删不掉。
  for (const forbidden of ['content', 'files', 'secretRef', 'token', 'credentials']) {
    assert.equal(new RegExp(`"${forbidden}"`).test(text), false, `导出里出现了 ${forbidden}`)
  }
})

test('⑦ 未授权一律 401（读面与写面都是）', async () => {
  const h = await freshHub('auth', { dbFile: join(tmpRoot, 'auth.db') })
  for (const [method, path] of [
    ['POST', '/api/packs/facts'], ['GET', '/api/packs/facts'],
    ['GET', '/api/packs/account'], ['GET', '/api/packs/export'],
  ]) {
    const res = await fetch(`${h.base}${path}`, { method })
    assert.equal(res.status, 401, `${method} ${path} 没有鉴权`)
  }
})

test('⑧ ★ `?packId=` 与 `?sinceSeq=` 真的过滤（不是收了不用）', async () => {
  const h = await freshHub('filters', { dbFile: join(tmpRoot, 'filters.db') })
  await callOn(h, '/api/packs/facts', { method: 'POST', body: FACT({ packId: 'fa' }) })
  await callOn(h, '/api/packs/facts', { method: 'POST', body: FACT({ packId: 'fb' }) })
  await callOn(h, '/api/packs/facts', { method: 'POST', body: FACT({ packId: 'fa', kind: 'upgrade', version: '1.1.0' }) })
  const byPack = await callOn(h, '/api/packs/facts?packId=fa')
  assert.deepEqual(byPack.json.records.map((r) => r.seq), [1, 3])
  const since = await callOn(h, '/api/packs/facts?sinceSeq=1')
  assert.deepEqual(since.json.records.map((r) => r.seq), [2, 3])
})
