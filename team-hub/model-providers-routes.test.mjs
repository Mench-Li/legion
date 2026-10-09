// ============================================================================
// P1（DECISION-legion-owns-model-config）：**供应商目录的导入**
//   `GET  /api/model-providers`         · 只读目录
//   `POST /api/model-providers/import`  · 幂等导入（快照 → Legion 的库）
//
// 这一组守的是 P1 的**验收条件本身**，逐条对着散落的"看起来对"：
//
//   ① **幂等**：同一份快照导入两次 ⇒ 第二次 `created=0 updated=0 unchanged=N`，
//      且 `version` 不推进。一个"每次启动都重写一遍"的导入器，
//      与一个"只在真变了才写"的导入器，在只启动一次的部署里是同一个东西；
//      而前者会让 P2 的影子 diff 每轮都报"刚改过"，把真变化淹掉。
//   ② **不删除**：第二份快照里少了一个供应商 ⇒ 它**仍在**。
//      P1 的方向是"把现状收进来"，不是"让 DSH 决定 Legion 里该有什么"。
//   ③ **拒绝未知字段**（不是忽略）：带 `apiKey` 的请求必须 400，
//      而且那个值**不许出现在库里任何地方** —— 这是本模块的密钥纪律。
//   ④ **secretRef 只收引用名**：形状不对（像一把真密钥）就拒绝。
//   ⑤ 型号条目里不认识的字段要被**报出名字**，不是静默丢掉。
//   ⑥ 墓碑复活：删过后再导入同名 ⇒ 复活（不是新建），version 前进。
//   ⑦ 空目录读数是引导导入的开关（`empty`）。
//
// 夹具：临时库 + 真实 listen(0)，与 `model-bindings-routes.test.mjs` 同一手法。
// ★ 注意 readOnly 的库读不回来 `PRAGMA` 之外的写——这里全部走 HTTP 与仓储公开面。
// ============================================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'legion-provstore-'))
process.env.TEAM_HUB_DB = join(dir, 'team.db')
process.env.TEAM_HUB_TOKEN = ''
const mod = await import('./server.mjs')
await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + mod.server.address().port

const call = async (m, p, b) => {
  const res = await fetch(base + p, {
    method: m,
    headers: b === undefined ? {} : { 'content-type': 'application/json' },
    body: b === undefined ? undefined : JSON.stringify(b),
  })
  const t = await res.text()
  let j; try { j = JSON.parse(t) } catch { j = t }
  return { status: res.status, body: j }
}
const get = (p) => call('GET', p)
const post = (p, b) => call('POST', p, b)

/** 一份"DSH 现状"的形状：与 ctx.settings.describe + ctx.llm 能读出来的东西同形。 */
const SNAPSHOT = [
  {
    id: 'fjd-ds', displayName: 'FJD', api: 'openai-responses', baseURL: 'https://fjbigmodel.fjdac.cn/v1',
    secretRef: 'FJD_DS_API_KEY', credentialConfigured: true,
    models: [
      { id: 'deepseek-v4-pro-openai', name: 'deepseek-v4-pro-openai', input: ['text', 'image'] },
      { id: 'deepseek-v4-flash-openai', name: 'deepseek-v4-flash-openai', contextWindow: 1000000, maxTokens: 393216 },
    ],
  },
  {
    id: 'svea-ds', displayName: 'SVEA', api: 'openai-completions', baseURL: 'https://fjbigmodel.fjdac.cn/v1',
    secretRef: 'SVEA_DS_API_KEY', credentialConfigured: true,
    models: [{ id: 'deepseek-v4-flash-openai', name: 'deepseek-v4-flash-openai' }],
  },
]

const importSnapshot = (providers, extra = {}) => post('/api/model-providers/import', { actor: 'general', ...extra, providers })

test('⑦ 初始：目录为空（`empty=true`）—— 这是引导导入的开关', async () => {
  const r = await get('/api/model-providers')
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.providers, [])
  assert.equal(r.body.empty, true, '空目录读数必须为 true：调用方据此决定"要不要做这次引导导入"')
})

test('① 幂等：同一份快照导入两次，第二次写 0 行且 version 不推进', async () => {
  const first = await importSnapshot(SNAPSHOT)
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.created, 2)
  assert.equal(first.body.updated, 0)
  assert.equal(first.body.unchanged, 0)

  const versions = () => mod.db.prepare('SELECT id, version, updated_at_ms FROM model_providers ORDER BY id').all()
  const after1 = versions()

  const second = await importSnapshot(SNAPSHOT)
  assert.equal(second.status, 200)
  assert.equal(second.body.created, 0, '第二次不许新建')
  assert.equal(second.body.updated, 0, '第二次不许更新 —— 内容没变')
  assert.equal(second.body.unchanged, 2, '第二次应当把两条都读成"没变"')
  assert.deepEqual(versions(), after1,
    'version 与 updated_at_ms 都不许动：推进它们会让 P2 的影子 diff 每轮都报"刚改过"')
})

test('①b 内容真变了才写，且 `unchanged` 与 `updated` 分辨得开', async () => {
  const changed = SNAPSHOT.map((p) => p.id === 'svea-ds' ? { ...p, displayName: 'SVEA（改名）' } : p)
  const r = await importSnapshot(changed)
  assert.equal(r.body.created, 0)
  assert.equal(r.body.updated, 1, '只有 svea-ds 变了')
  assert.equal(r.body.unchanged, 1, 'fjd-ds 没变 —— 它必须仍然算 unchanged')
  const row = mod.db.prepare("SELECT version, display_name FROM model_providers WHERE id='svea-ds'").get()
  assert.equal(row.display_name, 'SVEA（改名）')
  assert.equal(Number(row.version), 2)
})

test('② 不删除：快照里少了 svea-ds，它**仍然在**（P1 不替 DSH 做删除）', async () => {
  const onlyFjd = SNAPSHOT.filter((p) => p.id === 'fjd-ds')
  const r = await importSnapshot(onlyFjd)
  assert.equal(r.status, 200)
  const ids = (await get('/api/model-providers')).body.providers.map((p) => p.id)
  assert.deepEqual(ids, ['fjd-ds', 'svea-ds'],
    '导入不是"用快照替换整张表"：把 DSH 里少了一条读成 Legion 里也该少，就抹掉了"谁改了它"这个问题')
})

test('③ 未知字段必须**拒绝**，且那个值不许出现在库里任何地方', async () => {
  const sneaky = [{ id: 'evil-ds', displayName: 'E', apiKey: 'sk-live-DO-NOT-STORE' }]
  const r = await importSnapshot(sneaky)
  assert.equal(r.status, 400, '带未知字段的请求必须被拒 —— 忽略它会让这次写入看起来完全成功')
  assert.match(JSON.stringify(r.body), /未知字段|apiKey/)
  // 三重证明"真的没落库"：目录里没有它、磁盘上没有那个值、审计里也没有。
  assert.equal((await get('/api/model-providers')).body.providers.some((p) => p.id === 'evil-ds'), false)
  const dump = JSON.stringify(mod.db.prepare('SELECT * FROM model_providers').all())
  assert.equal(dump.includes('sk-live-DO-NOT-STORE'), false, '密钥值不许出现在供应商表里')
  const audits = JSON.stringify(mod.db.prepare('SELECT * FROM audit').all())
  assert.equal(audits.includes('sk-live-DO-NOT-STORE'), false, '密钥值也不许出现在审计里')
})

test('④ secretRef 只收"引用名"：形状不对（像一把真密钥）就拒绝', async () => {
  const bad = [{ id: 'bad-ds', displayName: 'B', secretRef: 'sk-live-abcdef0123456789' }]
  const r = await importSnapshot(bad)
  assert.equal(r.status, 400)
  assert.match(JSON.stringify(r.body), /引用名/)
  // 对照：合法引用名通过（证明拒绝的是形状，不是这个字段本身）
  const ok = await importSnapshot([{ id: 'ok-ds', displayName: 'O', secretRef: 'MY_API_KEY' }])
  assert.equal(ok.status, 200)
  assert.equal(ok.body.created, 1)
})

test('⑤ 型号里不认识的字段要被**报出名字**，不是静默丢掉', async () => {
  const withExtra = [{
    id: 'extra-ds', displayName: 'X', api: 'openai-completions', baseURL: 'https://x.example/v1',
    models: [{ id: 'm1', name: 'M1', contextWindow: 1000, somethingNew: 'v', anotherThing: 1 }],
  }]
  const r = await importSnapshot(withExtra)
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.droppedFields, ['anotherThing', 'somethingNew'],
    '丢掉的字段名必须报出来：否则 P3 物化时会静默少写字段，而没有人知道少了什么')
  // 白名单里的字段要真的留住（否则"报名字"就成了丢掉一切的借口）
  const kept = r.body.providers.find((p) => p.id === 'extra-ds')
  assert.deepEqual(kept.models, [{ id: 'm1', name: 'M1', contextWindow: 1000 }])
})

test('⑥ 墓碑复活：删过后再导入同名 ⇒ 复活（不是新建），version 前进', async () => {
  // 直接落一个墓碑行（模拟"用户删过它"）
  const now = Date.now()
  mod.db.prepare(
    `INSERT INTO model_providers (id, display_name, models_json, source, version, created_at_ms, updated_at_ms, deleted_at_ms)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run('back-ds', 'BACK', '[]', 'legion', 3, now, now, now)
  const r = await importSnapshot([{ id: 'back-ds', displayName: 'BACK', api: 'openai-completions', baseURL: 'https://b.example/v1' }])
  assert.equal(r.status, 200)
  assert.equal(r.body.created, 0, '复活不是新建：审计里混起来会让中间那次删除消失')
  assert.equal(r.body.updated, 1)
  const row = mod.db.prepare("SELECT version, deleted_at_ms FROM model_providers WHERE id='back-ds'").get()
  assert.equal(row.deleted_at_ms, null, '复活后墓碑必须清掉')
  assert.equal(Number(row.version), 4, '复活要推进 version（它确实变了）')
})

test('⑧ 缺 actor 必须拒绝（谁导的必须留痕）', async () => {
  const r = await post('/api/model-providers/import', { providers: [{ id: 'noactor-ds', displayName: 'N' }] })
  assert.equal(r.status, 400)
  assert.match(JSON.stringify(r.body), /actor/)
})

test('⑨ 未知 source 必须拒绝（`source` 是来源标注，不是自由文本）', async () => {
  const r = await importSnapshot([{ id: 'src-ds', displayName: 'S' }], { source: 'whatever' })
  assert.equal(r.status, 400)
  assert.match(JSON.stringify(r.body), /source/)
})

test('⑩ 重复 id 的快照必须整份拒绝（不是"后者覆盖前者"）', async () => {
  const r = await importSnapshot([
    { id: 'dup-ds', displayName: 'A' },
    { id: 'dup-ds', displayName: 'B' },
  ])
  assert.equal(r.status, 400)
  assert.match(JSON.stringify(r.body), /重复/)
  assert.equal((await get('/api/model-providers')).body.providers.some((p) => p.id === 'dup-ds'), false,
    '整份拒绝：半份写进去会让"这份快照对不对"变成一个没法回答的问题')
})

after(() => {
  try { mod.server.close() } catch { /* ignore */ }
  // ★ 清理是**尽力而为**：Windows 上 SQLite 的句柄还没放开时 `rmSync` 会 EPERM，
  //   而一个"断言全绿、退出码 1"的收尾会让这一套看起来是红的（实测踩到）。
  //   临时目录由 OS 回收；这里失败不该影响判据。
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* 句柄未放开：交给 OS */ }
})
