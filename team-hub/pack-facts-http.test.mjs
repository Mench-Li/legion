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

// ══════════════════════════════════════════════════════════════════════════════
// ④ PRT-316 切片 9：packs 族搬进 `routes/packs.mjs` 之后的**缝上契约**
//
// 为什么补：破验 14 条，第一轮咬住 8 条、漏网 6 条。逐条读完 store 的实现
// （`team-hub/pack-facts.mjs`）之后，6 条分成两类：
//
//   ① **真缺口**（3 条）—— 补判据：
//        K8  `?packId=` 空着时的**回显**：`null` 与 `''` 是两个不同的值。
//            ★★ 这一条我第一遍判成了"等价"，判错的过程写在那条测试里 ——
//            同一个表达式在路由里出现**两次**，我拿 store 那一处的等价性
//            去解释了回显那一处，而变异打的正是回显。
//        K11 `?limit=`：整份用例**一次都没用过**这个参数（已 grep 确认）。
//            去掉之后带 `?limit=1` 的请求会拿回全量 —— 而没有任何用例说过这件事。
//            ★ 它**不是等价**：3 条记录时 `?limit=1` 两边结果不同。
//        K12 `exact` 退化成 `prefix`：用例只打过"恰好等于"各前缀的路径
//            （与切片 8 的 K14 同一族）。
//
//   ② **可证等价**（3 条）—— 不补判据，只记录证明并**钉住前提**：
//        K9  `sinceSeq` 缺省：store 里是
//            `Number.isInteger(sinceSeq) && sinceSeq >= 0 ? sinceSeq : 0`
//            ⇒ `null` 与显式 `0` 落到**同一个 SQL 参数**。
//        K13 `verdictCodes` 缺省：store 里是
//            `Array.isArray(record.verdictCodes) ? … : []`
//            ⇒ `undefined` 与 `[]` 都落到同一个序列化结果。
//        K14 `packType` 缺省：store 的 INSERT 参数里是 `record.packType ?? null`
//            ⇒ 路由端给 `null` 还是 `undefined`，到 SQL 都是 `null`。
//
//        > 一个"路由端先兜了一层默认值"的写法，与一个"下游自己兜"的写法，
//        > 在两边兜出来是同一个值时是同一个东西 —— 而"同一个值"这件事
//        > 能由下游源码上的**一条断言**来守住。
//
//        所以这三条各配一条"前提断言"：下游那处兜底一旦被改掉，就会变红，
//        那时才真需要补路由端判据。**不给它们写"实参必须是什么"的断言** ——
//        那只会把实现细节钉死，让下一个合理重构无辜变红。
//
//        ★ K8 里 store 端那一层**也是**等价（前提被一并钉住），
//          但 K8 整体是**真缺口** —— 因为那处代码还有另一半在回显上，
//          而"一半等价"不能用来判另一半。
//
// ▲ 既有 8 例仍在**真 hub** 上验（不替换、不删除）。
// ▲ 追加而非新建文件：`git ls-files "*.test.mjs"` 的条数被 `boundary-facts` 钉着。
// ══════════════════════════════════════════════════════════════════════════════

import { createPacksRoutes } from './routes/packs.mjs'
// K8/K9/K13/K14 的等价性要钉住 store 端的前提，所以需要读源码。
import { readFileSync } from 'node:fs'

/** 会记录调用的假依赖 + 假 `res`（export 那条自己写响应头，不走 `json`）。 */
function packsSpy(over = {}) {
  const calls = []
  const sent = []
  const written = []
  const res = {
    writeHead: (code, headers) => { written.push([code, headers]) },
    end: (body) => { written.push(['end', body]) },
  }
  const body = over.body ?? { at: 7, kind: 'install', packId: 'p1', version: '1.0.0' }
  const deps = {
    json: (_res, code, obj) => { sent.push([code, obj]) },
    authorized: over.authorized ?? (() => true),
    handleRun: async (_req, _res, fn) => {
      const out = await fn(body, 'me')
      sent.push([200, out])
      return out
    },
    appendPackFact: (a) => { calls.push(['append', a]); return { appended: true, seq: 1 } },
    packFacts: (a) => { calls.push(['facts', a]); return [] },
    // 与 `server.mjs` 里的实现逐字一致
    optionalIntParam: (url, name) => {
      const raw = url.searchParams.get(name)
      if (raw === null || raw.trim() === '') return null
      const n = Number(raw)
      return Number.isSafeInteger(n) ? n : null
    },
    packFactCounts: (a) => { calls.push(['counts', a]); return { install: 1 } },
    packAccount: (a) => { calls.push(['account', a]); return { version: 'legion/pack-store@1', history: [] } },
    exportPackFacts: (a) => { calls.push(['export', a]); return { text: 'EXPORT-TEXT' } },
    db: { __db: true },
  }
  Object.assign(deps, over.deps ?? {})
  const fam = createPacksRoutes(deps)
  const dispatch = (method, target) => {
    const url = new URL(`http://x${target}`)
    return fam.dispatch({ method, headers: {} }, res, { path: url.pathname, url })
  }
  return { dispatch, calls, sent, written }
}
const last = (calls, n) => calls.filter((c) => c[0] === n).at(-1)

test('④ ★★ K12：`exact` 不许退化成前缀 —— 邻接命名空间一个都不许被吃掉', async () => {
  // 既有用例只请求过**刚刚好正确**的路径，于是"精确匹配"与"前缀匹配"
  // 在它眼里完全一样（与切片 8 的 K14 同一族）。
  const s = packsSpy()
  for (const [m, p] of [['GET', '/api/packsX'], ['GET', '/api/packs/factsX'],
    ['GET', '/api/packs/account/x'], ['GET', '/api/packs/export/x'],
    ['POST', '/api/packs/factsZ'], ['GET', '/api/pack/facts']]) {
    assert.equal(await s.dispatch(m, p), false, `${m} ${p} 被本族接住了 —— exact 退化了？`)
  }
  assert.deepEqual(s.calls, [], '未匹配的请求却碰了仓储')
  // 正面控制：四条正路径必须被接住（否则"一律不接"也能让上面通过）
  for (const [m, p, fn] of [['POST', '/api/packs/facts', 'append'],
    ['GET', '/api/packs/facts', 'facts'], ['GET', '/api/packs/account', 'account'],
    ['GET', '/api/packs/export', 'export']]) {
    const ok = packsSpy()
    assert.equal(await ok.dispatch(m, p), true, `${m} ${p} 没被接住`)
    assert.ok(last(ok.calls, fn), `${m} ${p} 没走到 ${fn}`)
  }
})

test('④ ★★ K11：`?limit=` 必须真的传下去（不是收了不用）', async () => {
  // 整份用例**一次都没用过 `?limit=`**，于是"分页生效"与"分页被整段删掉"
  // 在它眼里完全一样。这条是**真行为差异**，不是等价：
  // 3 条记录时 `?limit=1` 两边结果不同。
  const s = packsSpy()
  await s.dispatch('GET', '/api/packs/facts?limit=1')
  assert.equal(last(s.calls, 'facts')?.[1]?.limit, 1, 'limit 没有传到 store')
  // ★ 这里**不能**顺手断言 `packId === null`：路由把**原始**的 `''` 传给 store，
  //   只把 `null` 用在响应回显上（两条路，见 K8 那条测试）。
  //   断言成 `null` 会是一条**错的**判据 —— 它描述的是我以为的代码，不是代码。
  const empty = packsSpy()
  await empty.dispatch('GET', '/api/packs/facts?limit=&sinceSeq=&packId=')
  const a = last(empty.calls, 'facts')[1]
  assert.equal(a.limit, null, '空 limit 应当是 null')
  assert.equal(a.sinceSeq, 0, '空 sinceSeq 应当补 0')
  // 非整数 / 非数值按 `optionalIntParam` 的口径一律 null（不猜）
  for (const q of ['limit=abc', 'limit=1.5', 'limit=']) {
    const x = packsSpy()
    await x.dispatch(`GET`, `/api/packs/facts?${q}`)
    assert.equal(last(x.calls, 'facts')[1].limit, null, `${q} 应当折成 null`)
  }
  // ★ 但**负数不会**被这一层拒掉：`optionalIntParam` 只要求"安全整数"，
  //   `-3` 是安全整数 ⇒ 原样下传。真正忽略它的是 store 里的 `limit > 0`。
  //   （与 `scope` 用 `length > 0`、`enabled` 不判同类：这是**既有的**不对称，
  //   本片只把它记成契约，不顺手改行为 —— 零改写是纪律。）
  const neg = packsSpy()
  await neg.dispatch('GET', '/api/packs/facts?limit=-3')
  assert.equal(last(neg.calls, 'facts')[1].limit, -3, '负数 limit 的处置变了 ⇒ 请复核 store 的 limit > 0 兜底')
  const storeSrc = readFileSync('team-hub/pack-facts.mjs', 'utf8').replace(/\s+/g, ' ')
  assert.ok(storeSrc.includes('if (Number.isInteger(limit) && limit > 0) {'),
    'store 的 `limit > 0` 兜底不见了 ⇒ 负数 limit 会变成一条非法 SQL 的 LIMIT，请补路由端判据')
  const big = packsSpy()
  await big.dispatch('GET', '/api/packs/facts?packId=p1&sinceSeq=3&limit=7')
  const b = last(big.calls, 'facts')[1]
  assert.equal(b.packId, 'p1')
  assert.equal(b.sinceSeq, 3)
  assert.equal(b.limit, 7)
  // counts 与列表必须用**同一本账**（都拿同一个 db）
  assert.ok(last(big.calls, 'counts'), '读账没有同时给出 counts')
})

test('④ ★★ K8：`?packId=` 空着时，**回显**必须是 `null` 而不是空串', async () => {
  // ★★ 这一条我第一遍**判错了**，过程值得留在这里。
  //
  //   同一个表达式 `packId === null || packId.length === 0 ? null : packId`
  //   在路由里出现**两次**，而两次的下游完全不同：
  //     · L114：响应体里的**回显** —— `null` 与 `''` 是**两个不同的值**；
  //     · L117：传给 store 的是**原始** `packId`（**没有**规整），
  //             由 store 自己的 `String(packId).trim() !== ''` 兜住。
  //
  //   我读代码时看到 L114 的规整，就拿它去证明"空串与 null 等价"——
  //   而 K8 的变异打的正是 L114，那里两者**不等价**。
  //
  //   > 同一个表达式出现两次时，"我证明了它等价"这句话是**不完整的** ——
  //   > 它必须说清是**哪一次**。不说的那一次，读者会替你选一个。
  //
  //   ⇒ K8 是真缺口（回显的形态没人验过）；而 store 端那一层确实是等价，
  //     前提由下面那条测试钉住。
  const s = packsSpy()
  await s.dispatch('GET', '/api/packs/facts?packId=')
  const echo = s.sent.at(-1)?.[1]
  assert.equal(echo.packId, null, `空 packId 的回显应当是 null，实际是 ${JSON.stringify(echo.packId)}`)
  // `packId` 完全不给时同样是 null
  const none = packsSpy()
  await none.dispatch('GET', '/api/packs/facts')
  assert.equal(none.sent.at(-1)?.[1].packId, null)
  // 给了真值就原样回显（回显不是"永远 null"）
  const given = packsSpy()
  await given.dispatch('GET', '/api/packs/facts?packId=p1')
  assert.equal(given.sent.at(-1)?.[1].packId, 'p1')
  // ★ 而 store 收到的是**原始**值 —— 这是当前的真实契约，不是我以为的那个。
  //   它安全的前提是 store 自己会规整（下面那条测试钉住）。
  const raw = packsSpy()
  await raw.dispatch('GET', '/api/packs/facts?packId=')
  assert.equal(last(raw.calls, 'facts')[1].packId, '', '路由改了传给 store 的形态 ⇒ 请复核 store 端的规整')
})

test('④ 四条路由各自接到正确的方法上（正向 + 反向：动作不许串）', async () => {
  const table = [
    ['POST', '/api/packs/facts', 'append'],
    ['GET', '/api/packs/facts', 'facts'],
    ['GET', '/api/packs/account', 'account'],
    ['GET', '/api/packs/export', 'export'],
  ]
  for (const [m, p, fn] of table) {
    const s = packsSpy()
    assert.equal(await s.dispatch(m, p), true, `${m} ${p} 没被接住`)
    assert.ok(last(s.calls, fn), `${m} ${p} 没有走到 ${fn}`)
  }
  // 写入**只许**走 append（不许顺手去读或去算账）
  const w = packsSpy()
  await w.dispatch('POST', '/api/packs/facts')
  assert.equal(w.calls.filter((c) => c[0] !== 'append').length, 0,
    `写入路径还碰了 ${w.calls.filter((c) => c[0] !== 'append').map((c) => c[0]).join(',')}`)
})

test('④ 三条读路由：未授权 401 且**不查仓储 / 不写响应头**', async () => {
  for (const p of ['/api/packs/facts', '/api/packs/account', '/api/packs/export']) {
    const s = packsSpy({ authorized: () => false })
    assert.equal(await s.dispatch('GET', p), true)
    assert.equal(s.sent.at(-1)?.[0], 401, `${p} 没有 401`)
    assert.deepEqual(s.calls, [], `${p} 在未授权时仍然查了仓储`)
    assert.deepEqual(s.written, [], `${p} 在未授权时已经写了响应头`)
  }
})

test('④ 写入**不**做 authorized 前置（鉴权在 `handleRun` 里，与既有语义一致）', async () => {
  const s = packsSpy({ authorized: () => false })
  await s.dispatch('POST', '/api/packs/facts')
  assert.notEqual(s.sent.at(-1)?.[0], 401, '写入在路由头做了 401 —— 与既有语义不符')
})

test('④ ★ export 是**附件**且正文来自 `exportPackFacts`（自己写响应头，不走 json）', async () => {
  const s = packsSpy()
  assert.equal(await s.dispatch('GET', '/api/packs/export'), true)
  assert.deepEqual(s.sent, [], 'export 不该走 json（它自己写响应头）')
  const [code, headers] = s.written[0] ?? []
  assert.equal(code, 200)
  assert.equal(headers?.['content-disposition'],
    'attachment; filename="legion-pack-install-facts.json"', '导出不再是附件')
  assert.equal(headers?.['content-type'], 'application/json; charset=utf-8')
  assert.equal(s.written.at(-1)?.[0], 'end')
  assert.equal(s.written.at(-1)?.[1], 'EXPORT-TEXT', '导出的正文不是 store 给的那份')
})

test('④ ★ `account` 的形状必须**原样**来自 `packAccount`（不许在这层自己拼）', async () => {
  // 既有用例 ③ 验的是"这个形状能喂给 createPackStore"。
  // 这里补的是**来源**：`account` 必须来自 `packAccount({db})` 那一个调用，
  // 而不是在这里顺手算一遍（"两份推导"是这一层最想避免的事）。
  const s = packsSpy()
  await s.dispatch('GET', '/api/packs/account')
  const a = last(s.calls, 'account')
  assert.ok(a, 'account 没有走 packAccount')
  assert.deepEqual(Object.keys(a[1]), ['db'], 'account 收到了不该有的入参（多一份推导的入口）')
  const body = s.sent.at(-1)?.[1]
  assert.equal(body.ok, true)
  assert.equal(body.version, 'legion/pack-store@1', 'account 的形状不是 store 给的那份')
  // ★ 反向：account **不该**去读明细或算计数（那是另外两条路由的事）
  assert.equal(s.calls.filter((c) => c[0] === 'facts' || c[0] === 'counts').length, 0,
    'account 顺手读了明细/计数 —— 那就成了第二份推导')
})

test('④ ★★ 三条"没咬住"是**可证等价**：把前提钉在 store 源码上，而不是把实参钉死', async () => {
  // K9 / K13 / K14 这三条变异，路由端少兜了一层默认值，
  // 但**下游自己兜了同一个值**，所以没有任何输入能让它们分叉。
  //
  // 处置：不写"实参必须是什么"（那会把实现细节钉死），
  // 而是**钉住下游那处兜底**——它一变，这里就红，那时才真需要补路由端判据。
  //
  // ★ 第四条 `packId` 的规整**不在这里**：它同时出现在回显与 store 调用两处，
  //   而只有 store 那一处是等价（K8 是真缺口，另有判据），
  //   所以这里只钉"store 会规整空串"这个**前提**。
  const store = readFileSync('team-hub/pack-facts.mjs', 'utf8').replace(/\s+/g, ' ')
  const PINS = [
    ['K8 的 store 端前提：空 packId 不进 WHERE 子句',
      "if (packId !== null && packId !== undefined && String(packId).trim() !== '')"],
    ['K9 null 与显式 0 落到同一个 sinceSeq', 'Number.isInteger(sinceSeq) && sinceSeq >= 0 ? sinceSeq : 0'],
    ['K13 undefined 与 [] 落到同一个 verdictCodes', 'Array.isArray(record.verdictCodes) ? record.verdictCodes.map((c) => String(c)) : []'],
    ['K14 undefined 与 null 落到同一个 packType', 'record.packType ?? null'],
  ]
  for (const [why, needle] of PINS) {
    assert.ok(store.includes(needle.replace(/\s+/g, ' ')),
      `store 端的兜底不见了（${why}）⇒ 那条"可证等价"的前提失效，请补一条路由端判据。`
      + `\n  期望在 pack-facts.mjs 里找到：${needle}`)
  }
  // 顺带把等价性本身用可执行的等式写下来（读的人不必再去推一遍）
  const asSeq = (v) => (Number.isInteger(v) && v >= 0 ? v : 0)
  assert.equal(asSeq(null), asSeq(0))
  const entersWhere = (packId) => (packId !== null && packId !== undefined && String(packId).trim() !== '')
  assert.equal(entersWhere(''), entersWhere(null), '空串与 null 对 WHERE 子句的影响必须一致')
  const asCodes = (v) => (Array.isArray(v) ? v.map(String) : [])
  assert.deepEqual(asCodes(undefined), asCodes([]))
  const asType = (v) => v ?? null
  assert.equal(asType(undefined), asType(null))
})
