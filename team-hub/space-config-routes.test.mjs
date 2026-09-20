// ============================================================================
// PRT-316 切片 45：工作空间注册/更新 + 流水线配置 —— 2 条，全 `exact`
//   POST /api/spaces    幂等 upsert（id + name 必填，含仓库绑定校验）
//   POST /api/pipeline  整批 upsert（阶段契约 + 执行配置）
//
// ★★★ `/api/pipeline` 上有一道**权限闸**：只有 `general` 能改流水线。
//   它是这一族最要紧的一条语义 —— 而它藏在一行 `&&` 里，很容易被当成
//   "顺手加的校验"删掉。
// ============================================================================
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSpaceConfigRoutes } from './routes/space-config.mjs'

const dir = mkdtempSync(join(tmpdir(), 'legion-space-config-'))
process.env.TEAM_HUB_DB = join(dir, 'team.db')
process.env.TEAM_HUB_TOKEN = ''
const mod = await import('./server.mjs')
await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + mod.server.address().port

const post = async (p, body) => {
  const res = await fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  })
  const t = await res.text(); let j; try { j = JSON.parse(t) } catch { j = t }
  return { status: res.status, body: j }
}
const get = async (p) => {
  const res = await fetch(base + p)
  const t = await res.text(); let j; try { j = JSON.parse(t) } catch { j = t }
  return { status: res.status, body: j }
}

const reset = () => {
  mod.db.prepare('DELETE FROM spaces').run()
  mod.db.prepare('DELETE FROM space_stages').run()
  mod.db.prepare('DELETE FROM space_runtime').run()
  mod.db.prepare('DELETE FROM roster').run()
  mod.db.prepare('DELETE FROM audit').run()
}
const spaceRow = (id) => mod.db.prepare('SELECT * FROM spaces WHERE id = ?').get(id)
const stageRows = (scope) => mod.db.prepare('SELECT * FROM space_stages WHERE scope = ? ORDER BY sort, role').all(scope)
const audits = () => mod.db.prepare('SELECT * FROM audit ORDER BY rowid').all()

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close?.() } catch { /* 已关 */ }
  try { mod?.db?.close?.() } catch { /* 已关 */ }
  rmSync(dir, { recursive: true, force: true })
})

// ══════════════════════ POST /api/spaces ══════════════════════

test('① ★★ 注册成功 ⇒ 200 带 `{id,name,private,localDir,remoteUrl,agentCount}`，且**真的落库**', async () => {
  reset()
  const r = await post('/api/spaces', { by: 'general', id: 'sp1', name: '空间一' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.ok, true, '★★ handleWrite 外面那层形状')
  assert.deepEqual(r.body.task, { id: 'sp1', name: '空间一', private: false, localDir: '', remoteUrl: '', agentCount: 0 })
  const row = spaceRow('sp1')
  assert.ok(row, '★★ 必须真的落库')
  assert.equal(row.name, '空间一')
  assert.equal(row.private, 0)
})

test('② ★★★ 幂等 upsert：同一个 id 再来一次是**更新**不是新增', async () => {
  reset()
  await post('/api/spaces', { by: 'general', id: 'sp', name: '旧名' })
  await post('/api/spaces', { by: 'general', id: 'sp', name: '新名', private: true })
  assert.equal(mod.db.prepare('SELECT COUNT(*) c FROM spaces').get().c, 1, '★★ 不新增行')
  assert.equal(spaceRow('sp').name, '新名', '★ 覆盖 name')
  assert.equal(spaceRow('sp').private, 1, '★ 覆盖 private')
})

test('③ ★★★ 审计区分 `space:create` 与 `space:update`（同一条路两种动作）', async () => {
  reset()
  await post('/api/spaces', { by: 'general', id: 'aud', name: 'A' })
  await post('/api/spaces', { by: 'general', id: 'aud', name: 'B' })
  const acts = audits().filter((a) => a.action?.startsWith('space:')).map((a) => a.action)
  assert.deepEqual(acts, ['space:create', 'space:update'],
    '★★★ 第一次是 create、第二次是 update —— 不能都写成一个')
})

test('④ ★★ `id` 必须匹配 `^[a-z0-9][a-z0-9-]{0,63}$`', async () => {
  reset()
  for (const id of ['', 'A', '-x', 'x_y', 'x y', 'x'.repeat(65)]) {
    const r = await post('/api/spaces', { by: 'general', id, name: 'n' })
    assert.equal(r.status, 400, `★★ id=${JSON.stringify(id)} 应当被拒`)
    assert.match(String(r.body.error), /空间 id 非法/)
  }
  assert.equal((await post('/api/spaces', { by: 'general', id: 'ok-1', name: 'n' })).status, 200, '★ 合法形状要过')
  assert.equal((await post('/api/spaces', { by: 'general', id: 'x'.repeat(64), name: 'n' })).status, 200, '★ 64 字符要过')
})

test('⑤ ★★ 缺 / 空白的 `name` ⇒ 400「缺少参数 name」', async () => {
  reset()
  for (const name of [undefined, '', '   ']) {
    const r = await post('/api/spaces', { by: 'general', id: 'nm', name })
    assert.equal(r.status, 400, `★★ name=${JSON.stringify(name)} 应当被拒`)
    assert.match(String(r.body.error), /缺少参数 name/)
  }
})

test('⑥ ★★★ 两个长度上限：`localDir` ≤512、`remoteUrl` ≤1024', async () => {
  reset()
  const r1 = await post('/api/spaces', { by: 'general', id: 'l1', name: 'n', localDir: 'x'.repeat(513) })
  assert.equal(r1.status, 400); assert.match(String(r1.body.error), /localDir 过长/)
  const r2 = await post('/api/spaces', { by: 'general', id: 'l2', name: 'n', remoteUrl: 'x'.repeat(1025) })
  assert.equal(r2.status, 400); assert.match(String(r2.body.error), /remoteUrl 过长/)
  // 正好到上限要过
  assert.equal((await post('/api/spaces', { by: 'general', id: 'l3', name: 'n', localDir: 'x'.repeat(512) })).status, 200)
  assert.equal((await post('/api/spaces', { by: 'general', id: 'l4', name: 'n', remoteUrl: 'x'.repeat(1024) })).status, 200)
})

test('⑦ ★★ `localDir`/`remoteUrl` 会被 `trim()`；非字符串 ⇒ 空串（不是报错）', async () => {
  reset()
  const r = await post('/api/spaces', { by: 'general', id: 'tr', name: '  n  ', localDir: '  /a/b  ', remoteUrl: '  https://x  ' })
  assert.equal(r.body.task.name, 'n', '★ name 存的是 trim 后的')
  assert.equal(r.body.task.localDir, '/a/b', '★ localDir trim')
  assert.equal(r.body.task.remoteUrl, 'https://x', '★ remoteUrl trim')
  const r2 = await post('/api/spaces', { by: 'general', id: 'ns', name: 'n', localDir: 42, remoteUrl: null })
  assert.equal(r2.status, 200, '★★ 非字符串不报错，按空串处理')
  assert.equal(r2.body.task.localDir, ''); assert.equal(r2.body.task.remoteUrl, '')
})

test('⑧ ★★ `private` 是**真值**判定（回的是布尔，存的是 0/1）；`agentCount` 数的是**该空间的编队**', async () => {
  reset()
  await post('/api/spaces', { by: 'general', id: 'ro', name: 'n' })
  mod.db.prepare('INSERT INTO roster (scope,sort,role,name,kind,avatar) VALUES (?,?,?,?,?,?)').run('ro', 0, 'a', 'A', 'ai', '🤖')
  mod.db.prepare('INSERT INTO roster (scope,sort,role,name,kind,avatar) VALUES (?,?,?,?,?,?)').run('ro', 1, 'b', 'B', 'ai', '🤖')
  mod.db.prepare('INSERT INTO roster (scope,sort,role,name,kind,avatar) VALUES (?,?,?,?,?,?)').run('other', 0, 'c', 'C', 'ai', '🤖')
  const r = await post('/api/spaces', { by: 'general', id: 'ro', name: 'n', private: 1 })
  assert.equal(r.body.task.private, true, '★ 回的是布尔')
  assert.equal(r.body.task.agentCount, 2, '★★ 只数**这个空间**的编队（不能全库数）')
  assert.equal(spaceRow('ro').private, 1, '★ 存的是 0/1')
})

// ══════════════════════ POST /api/pipeline ══════════════════════

const S = (role, over = {}) => ({ role, label: '岗-' + role, ...over })

test('⑨ ★★★ **只有 `general` 能改流水线** —— 四个入口逐个验', async () => {
  reset()
  const stages = [S('dev')]
  // (a) 操作者不是 general、body.by 也不是 ⇒ 拒
  const a = await post('/api/pipeline', { by: 'coder', scope: 'p1', stages })
  assert.equal(a.status, 400, JSON.stringify(a.body))
  assert.match(String(a.body.error), /流水线配置仅允许 general 执行/,
    '★★★ 这道闸不能因为"顺手"就没了')
  // (b) `body.by === 'general'` ⇒ 过（即便操作者不是）
  assert.equal((await post('/api/pipeline', { by: 'general', scope: 'p1', stages })).status, 200,
    '★ body.by=general 是四个入口之一')
  // (c) `forceGeneral: true` 是逃生门 ⇒ 过
  const c = await post('/api/pipeline', { by: 'coder', scope: 'p2', stages, forceGeneral: true })
  assert.equal(c.status, 200, '★ forceGeneral 是明确的逃生门')
  // (d) 反例：`forceGeneral` 只认真 `true`
  const d = await post('/api/pipeline', { by: 'coder', scope: 'p3', stages, forceGeneral: 'yes' })
  assert.equal(d.status, 400, '★★ 字符串 "yes" 不算逃生门')
  assert.equal(stageRows('p3').length, 0, '★★ 被拒时**一行都不该落库**')
  // ★★★ (e) 破验 M6 教我补的这一条：**操作者身份那一半**要单独被钉住。
  //   `handleWrite` 里 `by = requireMember(body)` = `body.by.trim()` ——
  //   所以 `by` 与 `body.by` 在**没有空白**时是同一个值，两个半句分不开。
  //   唯一分得开的情形是 `body.by` **带空白**：`body.by !== 'general'`（原值）
  //   但 `by === 'general'`（trim 后）⇒ 只有"操作者身份那一半"能放行。
  const e = await post('/api/pipeline', { by: ' general ', scope: 'p4', stages })
  assert.equal(e.status, 200,
    '★★★ body.by 带空白时靠的是**操作者身份那一半**（trim 后是 general）—— 少了它这里会 400')
})

test('⑩ ★★★ `stages` 必须是非空数组；role 不能重复', async () => {
  reset()
  const g = { by: 'general' }
  for (const stages of [undefined, null, [], 'nope', 42]) {
    const r = await post('/api/pipeline', { ...g, scope: 'q', stages })
    assert.equal(r.status, 400, `★★ stages=${JSON.stringify(stages)} 应当被拒`)
    assert.match(String(r.body.error), /stages 必须是非空数组/)
  }
  const dup = await post('/api/pipeline', { ...g, scope: 'q', stages: [S('dev'), S('dev')] })
  assert.equal(dup.status, 400); assert.match(String(dup.body.error), /role 重复/)
})

test('⑪ ★★ 每个阶段必须有 `label`；`gate:true` 必须有 `artifact`', async () => {
  reset()
  const g = { by: 'general' }
  const noLabel = await post('/api/pipeline', { ...g, scope: 'q', stages: [{ role: 'dev' }] })
  assert.equal(noLabel.status, 400); assert.match(String(noLabel.body.error), /缺少 label/)
  const gateNoArt = await post('/api/pipeline', { ...g, scope: 'q', stages: [S('dev', { gate: true })] })
  assert.equal(gateNoArt.status, 400)
  assert.match(String(gateNoArt.body.error), /gate:true 但没有 artifact/,
    '★★ 闸门没有产物路径 ⇒ 永远过不去，写入期就该拦')
  assert.equal((await post('/api/pipeline', { ...g, scope: 'q', stages: [S('dev', { gate: true, artifact: 'a.md' })] })).status, 200)
})

test('⑫ ★★★ 整批 upsert 会**删掉没提交的旧阶段**，并在 `dropped` 里报出来', async () => {
  reset()
  const g = { by: 'general', scope: 'up' }
  await post('/api/pipeline', { ...g, stages: [S('a'), S('b')] })
  assert.deepEqual(stageRows('up').map((r) => r.role), ['a', 'b'])
  const r = await post('/api/pipeline', { ...g, stages: [S('a'), S('c')] })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(stageRows('up').map((x) => x.role).sort(), ['a', 'c'], '★★ b 被删掉了')
  assert.deepEqual(r.body.task.dropped, ['b'], '★★ 删了谁要说出来')
  assert.equal(r.body.task.added, 1, '★ 新增 1 条（c）')
  assert.equal(r.body.task.stages, 2)
})

test('⑬ ★★ `next` 必须指向**同批或库里已有**的 role', async () => {
  reset()
  const g = { by: 'general', scope: 'nx' }
  const bad = await post('/api/pipeline', { ...g, stages: [S('a', { next: 'ghost' })] })
  assert.equal(bad.status, 400); assert.match(String(bad.body.error), /next=/)
  assert.equal((await post('/api/pipeline', { ...g, stages: [S('a', { next: 'b' }), S('b')] })).status, 200, '★ 同批里指得到就行')
})

test('⑭ ★★★ `runtime` 校验：`maxWorkers` 必须是 1~8 的整数；缺省不下发', async () => {
  reset()
  const g = { by: 'general', scope: 'rt', stages: [S('a')] }
  for (const mw of [0, 9, 1.5, 'x']) {
    const r = await post('/api/pipeline', { ...g, runtime: { maxWorkers: mw } })
    assert.equal(r.status, 400, `★★ maxWorkers=${JSON.stringify(mw)} 应当被拒`)
    assert.match(String(r.body.error), /maxWorkers/)
  }
  // runtime 缺省 ⇒ **不碰** space_runtime
  await post('/api/pipeline', g)
  assert.equal(mod.db.prepare('SELECT COUNT(*) c FROM space_runtime WHERE scope = ?').get('rt').c, 0,
    '★★★ runtime 不给就**别动**那一行（不能顺手写个默认值）')
  // 给了 ⇒ 写
  const ok = await post('/api/pipeline', { ...g, runtime: { enabled: true, maxWorkers: 3, isolate: false } })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  const rt = mod.db.prepare('SELECT * FROM space_runtime WHERE scope = ?').get('rt')
  assert.equal(rt.enabled, 1); assert.equal(rt.maxWorkers, 3); assert.equal(rt.isolate, 0)
})

test('⑮ ★★ `body.scope` 覆盖写作用域；非法 scope ⇒ 400', async () => {
  reset()
  const r = await post('/api/pipeline', { by: 'general', by2: 'x', scope: 'target', stages: [S('a')] })
  assert.equal(r.status, 200)
  assert.equal(r.body.task.scope, 'target', '★ 落在 body.scope 上')
  assert.equal(stageRows('target').length, 1)
  assert.equal(stageRows('default').length, 0, '★★ 不能顺手落到写作用域')
  const bad = await post('/api/pipeline', { by: 'general', scope: 'a b!', stages: [S('a')] })
  assert.equal(bad.status, 400); assert.match(String(bad.body.error), /scope 非法/)
})

test('⑯ ★★ 成功响应带 `version` / `activeRoles` / `warnings`（供指挥台展示）', async () => {
  reset()
  const r = await post('/api/pipeline', { by: 'general', scope: 'vw', stages: [S('a'), S('b', { next: 'a' })] })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const t = r.body.task
  assert.ok(t.version !== undefined && t.version !== null, '★ 版本号（实测是**字符串**，不是数字）')
  assert.ok(Array.isArray(t.activeRoles), '★ activeRoles 是数组')
  assert.ok(Array.isArray(t.warnings), '★★ warnings —— "编队与流水线不一致"要靠它报给将军')
  // ★★ 破验 M24 教我补的这一条：`updatedAt` 必须是**真的时间戳**，不能是写死的串。
  const rows = stageRows('vw')
  assert.equal(rows.length, 2)
  for (const r of rows) {
    assert.ok(r.updatedAt, '★ 要写 updatedAt')
    const ms = Date.parse(r.updatedAt)
    assert.ok(Number.isFinite(ms), `★★ updatedAt 得能解析成时间：${r.updatedAt}`)
    assert.ok(Math.abs(Date.now() - ms) < 10 * 60 * 1000,
      '★★★ updatedAt 必须是**刚刚**（写死的常量或过期值都不行）')
  }
})

test('⑰ ★★ 整批 upsert 是**事务**：中途失败不留半套', async () => {
  reset()
  const g = { by: 'general', scope: 'tx' }
  await post('/api/pipeline', { ...g, stages: [S('keep')] })
  // 第二批里第 2 条非法 ⇒ 整批都不该生效
  const r = await post('/api/pipeline', { ...g, stages: [S('new1'), { role: 'dev' }] })
  assert.equal(r.status, 400)
  assert.deepEqual(stageRows('tx').map((x) => x.role), ['keep'],
    '★★★ 失败时旧的 `keep` 还在、新的 `new1` **没有**落进去')
})

// ══════════════════════ 接缝契约 ══════════════════════

const stub = (over = {}) => createSpaceConfigRoutes({
  json: (res, code, p) => { res.sent = { code, payload: p } },
  db: { prepare: () => ({ get: () => undefined, all: () => [], run: () => {} }) },
  now: () => 'T',
  audit: () => {},
  // ★★ 这一条只验**路由**（谁被认领、方法对不对），所以不真的跑路由体 ——
  //   第一版我让它跑，结果 `/api/spaces` 拿到空 body 就报「空间 id 非法」，
  //   于是**路由判据被业务校验绊倒**了。
  handleWrite: async () => {},
  SCOPE_KEY_RE: /^[a-z0-9_-]{1,64}$/i,
  normalizeStages: () => [],
  normalizeRuntime: () => ({ enabled: false, maxWorkers: 1, isolate: true }),
  withTx: (f) => f(),
  readPipeline: () => ({ version: 1, activeRoles: [] }),
  pipelineWarnings: () => [],
  ...over,
})

test('⑱ ★★★ dispatch 契约：两条都只认 POST / `exact` 不退化成 `prefix`', async () => {
  const router = stub()
  const ctx = (p) => ({ path: p, url: new URL('http://x' + p) })
  assert.equal(await router.dispatch({ method: 'POST' }, {}, ctx('/api/spaces')), true)
  assert.equal(await router.dispatch({ method: 'POST' }, {}, ctx('/api/pipeline')), true)
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/spaces')), false, '★ 只认 POST')
  assert.equal(await router.dispatch({ method: 'GET' }, {}, ctx('/api/pipeline')), false)
  assert.equal(await router.dispatch({ method: 'POST' }, {}, ctx('/api/spacesX')), false, '★ exact 不许退化成 startsWith')
  // ★★ 兄弟：`POST /api/spaces/` **不属于本族**，不能被本族认领
  assert.equal(await router.dispatch({ method: 'POST' }, {}, ctx('/api/spaces/provision')), false,
    '★★ `/api/spaces/` 下的路由是**另一族**的，本族不许越界认领')
  assert.deepEqual(router.routes.map((r) => `${r.method} ${r.match} ${r.path}`),
    ['POST exact /api/spaces', 'POST exact /api/pipeline'])
  assert.equal(router.id, 'space-config')
})

test('⑲ ★★ 缺注入项 ⇒ **构造时**就抛（fail closed）', async () => {
  const full = {
    json: () => {}, db: {}, now: () => 'T', audit: () => {}, handleWrite: async () => {},
    SCOPE_KEY_RE: /x/, normalizeStages: () => [], normalizeRuntime: () => ({}),
    withTx: (f) => f(), readPipeline: () => ({}), pipelineWarnings: () => [],
  }
  for (const k of Object.keys(full)) {
    const partial = { ...full }
    delete partial[k]
    assert.throws(() => createSpaceConfigRoutes(partial), /缺注入项/, `★★ 少了 ${k} 必须在构造时就抛`)
  }
})
