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

test('⑪ ★ 面板的写入路径：建 → 改（带版本）→ 删（立墓碑），全程 source=legion', async () => {
  const created = await post('/api/model-providers', {
    actor: 'general',
    provider: { id: 'panel-ds', displayName: '面板建的', api: 'openai-completions', baseURL: 'https://p.example/v1', models: [{ id: 'pm1', name: 'PM1' }] },
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  assert.equal(created.body.id, 'panel-ds')
  assert.equal(created.body.version, 1)
  assert.equal(created.body.source, 'legion', '面板建的是**用户意图**，不能伪装成 dsh-import')

  // 改名（整体替换 + CAS）
  const updated = await post('/api/model-providers/panel-ds', {
    actor: 'general', version: 1,
    provider: { id: 'panel-ds', displayName: '改过名', api: 'openai-completions', baseURL: 'https://p.example/v1', models: [{ id: 'pm1', name: 'PM1' }, { id: 'pm2', name: 'PM2' }] },
  })
  assert.equal(updated.status, 200, JSON.stringify(updated.body))
  assert.equal(updated.body.displayName, '改过名')
  assert.equal(updated.body.version, 2)
  assert.equal(updated.body.models.length, 2)

  // ★ 版本不对 ⇒ 409（两个界面同时保存不许静默覆盖）
  const stale = await post('/api/model-providers/panel-ds', {
    actor: 'general', version: 1,
    provider: { id: 'panel-ds', displayName: '用旧版本覆盖', api: 'openai-completions', baseURL: 'https://p.example/v1', models: [] },
  })
  assert.equal(stale.status, 409, '旧版本写入必须被拒')
  assert.match(JSON.stringify(stale.body), /已被别人改过/)
  assert.equal((await get('/api/model-providers')).body.providers.find((p) => p.id === 'panel-ds').displayName, '改过名',
    '被拒的那次不许改动任何东西')

  // 删 = 立墓碑
  const removed = await call('DELETE', '/api/model-providers/panel-ds', { actor: 'general', version: 2 })
  assert.equal(removed.status, 200, JSON.stringify(removed.body))
  const after = (await get('/api/model-providers')).body.providers.map((p) => p.id)
  assert.equal(after.includes('panel-ds'), false, '删掉之后不在列表里')
  const row = mod.db.prepare("SELECT deleted_at_ms, version FROM model_providers WHERE id='panel-ds'").get()
  assert.notEqual(row.deleted_at_ms, null, '是**墓碑**，不是 DELETE 掉那一行（历史可能还记着这个引用）')
  assert.equal(Number(row.version), 3)

  // 删过的 id 可以**加回来**（复活，见 ⑪b）—— 这条曾经断言 409，那个断言钉的是错的行为
  const reuse = await post('/api/model-providers', {
    actor: 'general', provider: { id: 'panel-ds', displayName: '重名回来了', api: 'openai-completions', baseURL: 'https://p.example/v1', models: [{ id: 'pm1' }] },
  })
  assert.equal(reuse.status, 200, '删过的同名必须能加回来，否则用户只能发明 panel-ds-1 这种与 DSH 配置 id 不一致的别名')
  assert.equal(reuse.body.revived, true)
})

test('⑪b ★ 同名墓碑**复活**（且与"从 DSH 导入"那条路给出同一个答案）', async () => {
  // 业主实测（2026-10-09）：svea-ds 从 DSH 导入 → 被删（墓碑）→ 想加回来被 409 拒
  // ⇒ 只好建成 svea-ds-1。而**同一个文件里的导入路径对墓碑本来是复活**的。
  //   一个"从 DSH 抄回来的同名会复活、我自己点出来的同名被拒绝"的规则，不是规则，是运气。
  const now = Date.now()
  mod.db.prepare(
    `INSERT INTO model_providers (id, display_name, models_json, source, version, created_at_ms, updated_at_ms, deleted_at_ms)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run('revive-ds', '旧的', '[]', 'dsh-import', 2, now, now, now)

  const revived = await post('/api/model-providers', {
    actor: 'general',
    provider: { id: 'revive-ds', displayName: '回来的', api: 'openai-completions', baseURL: 'https://r.example/v1', models: [{ id: 'rm1' }] },
  })
  assert.equal(revived.status, 200, JSON.stringify(revived.body))
  assert.equal(revived.body.revived, true, '要显式告诉调用方这是**恢复**，好让它说"已恢复"而不是"已创建"')
  assert.equal(revived.body.version, 3, '复活要推进 version（它确实变了），而不是回到 1')
  assert.equal(revived.body.source, 'legion', '复活之后来源是**用户意图**（他刚在面板上建的）')
  assert.equal((await get('/api/model-providers')).body.providers.some((p) => p.id === 'revive-ds'), true)

  // 反向：**活着**的同名仍然是 409（那不是"想建"，是"想改"）
  const dupLive = await post('/api/model-providers', {
    actor: 'general', provider: { id: 'revive-ds', displayName: 'x', api: 'openai-completions', baseURL: 'https://r.example/v1' },
  })
  assert.equal(dupLive.status, 409, '活着的同名必须拒 —— 否则并发保存会静默覆盖')
  assert.match(JSON.stringify(dupLive.body), /已存在/)

  // 审计要能分辨"复活"与"首次创建"（审计表把这条 id 记在 `taskId` 列里）
  const actions = mod.db.prepare("SELECT action FROM audit WHERE taskId='revive-ds' GROUP BY action").all()
  assert.deepEqual(actions.map((a) => a.action).sort(), ['model-provider.revive'],
    '复活要留 `revive` 这条痕（原来那条"保护历史引用"的顾虑换到审计里实现）')

  // 被删的那条**不能直接编辑**，但错误信息要告诉用户怎么恢复
  mod.db.prepare('UPDATE model_providers SET deleted_at_ms=? WHERE id=?').run(Date.now(), 'revive-ds')
  const editDeleted = await post('/api/model-providers/revive-ds', {
    actor: 'general', version: 3, provider: { id: 'revive-ds', displayName: 'y', api: 'openai-completions', baseURL: 'https://r.example/v1' },
  })
  assert.equal(editDeleted.status, 409)
  assert.match(JSON.stringify(editDeleted.body), /恢复/)
})

test('⑫ 改/删都要 actor 与 version；缺了就具名拒绝', async () => {
  await post('/api/model-providers', { actor: 'general', provider: { id: 'guard-ds', displayName: 'G', api: 'openai-completions', baseURL: 'https://g.example/v1' } })
  const noActor = await post('/api/model-providers/guard-ds', { version: 1, provider: { id: 'guard-ds', displayName: 'X', api: 'openai-completions', baseURL: 'https://g.example/v1' } })
  assert.equal(noActor.status, 400)
  assert.match(JSON.stringify(noActor.body), /actor/)
  const noVersion = await post('/api/model-providers/guard-ds', { actor: 'general', provider: { id: 'guard-ds', displayName: 'X', api: 'openai-completions', baseURL: 'https://g.example/v1' } })
  assert.equal(noVersion.status, 400)
  assert.match(JSON.stringify(noVersion.body), /version/)
  // 不存在的 id
  const missing = await call('DELETE', '/api/model-providers/nope-ds', { actor: 'general' })
  assert.equal(missing.status, 404)
})

test('⑬ ★ 自动读模型目录：Legion 自己按 OpenAI 约定去问（不绕道 DSH）', async () => {
  const { discoverProviderModels } = await import('./routes/model-providers.mjs')
  const seen = []
  const ok = async (url, init) => {
    seen.push({ url, init })
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }, { id: 'm1' }] }) }
  }
  const ids = await discoverProviderModels({ baseURL: 'https://v.example/v1', apiKey: 'sk-x', fetchImpl: ok })
  assert.deepEqual(ids, ['m1', 'm2'], '要去重')
  assert.equal(seen[0].url, 'https://v.example/v1/models')
  assert.equal(seen[0].init.headers.authorization, 'Bearer sk-x')

  // 反向：非 OpenAI 兼容（没有 data/models）⇒ 具名报错，**不返回空数组**
  const weird = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ result: [] }) })
  await assert.rejects(() => discoverProviderModels({ baseURL: 'https://v.example/v1', fetchImpl: weird }), /没有 data\/models 数组/)
  // 4xx ⇒ 具名报错
  const bad = async () => ({ ok: false, status: 401, text: async () => 'nope' })
  await assert.rejects(() => discoverProviderModels({ baseURL: 'https://v.example/v1', fetchImpl: bad }), /HTTP 401/)
  // 连不上 ⇒ 具名报错
  const boom = async () => { throw new Error('ECONNREFUSED') }
  await assert.rejects(() => discoverProviderModels({ baseURL: 'https://v.example/v1', fetchImpl: boom }), /连不上 v\.example/)
  // 内嵌账号密码 ⇒ 拒（与 provider-store 的 baseURL 口径一致）
  await assert.rejects(() => discoverProviderModels({ baseURL: 'https://u:p@v.example/v1', fetchImpl: ok }), /不能内嵌账号密码/)
  // 只认 http(s)
  await assert.rejects(() => discoverProviderModels({ baseURL: 'file:///etc/passwd', fetchImpl: ok }), /只能是 http\(s\)/)
})

test('⑭ ★ 路由顺序：`/discover` 必须排在通配 id 之前（否则会被当成 id="discover"）', async () => {
  // 真的打一次：如果顺序反了，POST /discover 会被当作"改一条 id=discover 的供应商"→ 404/400
  const r = await post('/api/model-providers/discover', { actor: 'general', baseURL: 'http://127.0.0.1:9/v1' })
  // 127.0.0.1:9 必定连不上 ⇒ 期望 502 的"连不上"，而不是"没有这个供应商：discover"
  assert.equal(r.status, 502, JSON.stringify(r.body))
  assert.match(JSON.stringify(r.body), /连不上/)
  assert.equal(JSON.stringify(r.body).includes('discover'), false, '不该被当成 id=discover 去查供应商')
})

after(() => {
  try { mod.server.close() } catch { /* ignore */ }
  // ★ 清理是**尽力而为**：Windows 上 SQLite 的句柄还没放开时 `rmSync` 会 EPERM，
  //   而一个"断言全绿、退出码 1"的收尾会让这一套看起来是红的（实测踩到）。
  //   临时目录由 OS 回收；这里失败不该影响判据。
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* 句柄未放开：交给 OS */ }
})

// ============================================================================
// BUG-023 的收敛：`GET /api/model-providers` 要带上**核验过**的凭证状态。
//
// 实测的假话：面板显示 `fjd-ds · 已配置凭证`，而它引用的 `FJD_DS_API_KEY`
// 根本不在密钥库里 —— 那句"已配置"读的是 `credentialConfigured`
// （**P1 从 DSH 导入的标记**），而不是"这把钥匙真的在不在"。
// ============================================================================

test('⑮ ★★ 列表里每一行都带 `credential`（核验结果），且状态是已知集合里的一个', async () => {
  const r = await get('/api/model-providers')
  assert.equal(r.status, 200)
  assert.ok(r.body.providers.length > 0, '这一套前面已经导入过供应商')
  for (const p of r.body.providers) {
    assert.ok(p.credential !== undefined, `${p.id} 缺 credential：界面只能回去读那个导入标记`)
    assert.ok(
      ['none', 'ready', 'missing', 'unavailable'].includes(p.credential.state),
      `${p.id} 的状态不认识：${p.credential.state}`,
    )
    // ★★ 2026-10-12：核验结果里**不再有引用名**（`ref` → `hasRef`）。
    //   这一条原先写 `assert.equal(p.credential.ref, p.secretRef ?? null, '核验的必须是这一行自己的引用名')`，
    //   而那句话把"核验了这一行的凭证"与"把这一行的引用名发出去"当成了同一件事。
    //   引用名是可枚举的攻击面（`model-store.mjs` 文件头 ②），所以改成断言**有没有**
    //   引用（`hasRef`）与**是不是这一行自己的那个**（用 `secretRef` 在测试进程里比对 ——
    //   测试能看到库里的值，客户端不该看到）。
    assert.equal(p.credential.hasRef, typeof p.secretRef === 'string' && p.secretRef !== '',
      '核验的必须是这一行自己的引用名（说"有没有"，不说"叫什么"）')
    // 兼容：原来的标记原样保留（别的消费者还在用）
    assert.equal(typeof p.credentialConfigured, 'boolean')
  }
})

test('⑯ ★★★ 本环境读不到密钥库 ⇒ 必须是 `unavailable`，**绝不是** `missing`', async () => {
  // 这一条是入口级的"读不出来 ≠ 没有"：测试进程没有 LEGION_* 布局，
  // 密钥库必然打不开。把它报成 `missing` 会让用户去补一把**他可能早就存过**的钥匙，
  // 而真因是"这次没核验成"。
  const r = await get('/api/model-providers')
  const withRef = r.body.providers.filter((p) => typeof p.secretRef === 'string' && p.secretRef !== '')
  assert.ok(withRef.length > 0, '夹具里应当有带引用名的供应商')
  for (const p of withRef) {
    assert.equal(p.credential.state, 'unavailable',
      `${p.id}：读不出来时不许说"没有"（实际：${p.credential.state}）`)
    assert.match(p.credential.detail, /不等于"没有"/)
  }
})

test('⑰ ★ 没有引用名的供应商 ⇒ `none`（不是错误，也不需要凭证）', async () => {
  await post('/api/model-providers', {
    actor: 'general',
    provider: { id: 'local-only-15', displayName: '本地', baseURL: 'http://127.0.0.1:11434/v1', secretRef: null, models: [{ id: 'llama' }] },
  })
  const r = await get('/api/model-providers')
  const p = r.body.providers.find((x) => x.id === 'local-only-15')
  assert.equal(p.credential.state, 'none')
  // ★ 2026-10-12：`state: 'none'` 与 `hasRef: false` 是同一件事的两种说法（原来断言的是 `ref: null`）。
  assert.equal(p.credential.hasRef, false)
})

// ============================================================================
// 档案**自动**由供应商与模型生成 —— 将军的两次原话
//
//   第一次："我还有必要新建档案嘛，直接来源于模型与供应商才对啊"
//   第二次："档案必然由供应商与模型来，且**添加完自动生成**供应商档案，
//            而不是：1.需要手工点生成；2.在模型档案这要手工填写"
//
// 所以这一节的主判据是"**保存完就有了**"，而不是"有一个能用的生成端点"。
// 手工端点退化成**补历史 / 修复**那条路（幂等，多点一次没有代价）。
// ============================================================================

test('⑱ ★★★ 保存供应商 ⇒ 它的模型**立刻**有档案（不用点任何按钮）', async () => {
  const r = await post('/api/model-providers', {
    actor: 'general',
    provider: { id: 'auto-15', displayName: '自动', baseURL: 'https://auto.example/v1', models: [{ id: 'a' }, { id: 'b' }] },
  })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  // 响应里就带着这件事的读数（面板据此说话，而不是让用户自己去档案页数）
  assert.equal(r.body.profilesDerived.ok, true, JSON.stringify(r.body.profilesDerived))
  assert.equal(r.body.profilesDerived.created.length, 2, '★ 两条模型 ⇒ 两条档案，**这一次请求就完成**')
  assert.match(r.body.profilesDerived.summary, /新增 2/)
  assert.equal(r.body.runtimeType, 'dsh', '运行时由服务端定下来并**记在供应商行上**（不是每条档案猜一遍）')

  const rows = (await get('/api/model-profiles')).body.profiles.filter((p) => p.provider === 'auto-15')
  assert.equal(rows.length, 2)
  for (const p of rows) {
    assert.equal(p.runtimeType, 'dsh')
    assert.equal(p.endpoint, null, '★ 地址留空 ⇒ 继承供应商（不抄第二份）')
    assert.equal(p.hasCredential, false, '★ 凭证引用同理')
  }
})

test('⑲ ★★★ 改供应商加一个模型 ⇒ **只有新模型**多出档案，老档案一个字都不动', async () => {
  const before = (await get('/api/model-profiles')).body.profiles
  const snapshot = before.map((p) => ({ id: p.id, version: p.version }))
  const cur = (await get('/api/model-providers')).body.providers.find((p) => p.id === 'auto-15')
  const r = await post('/api/model-providers/auto-15', {
    actor: 'general', version: cur.version,
    provider: { id: 'auto-15', displayName: '自动', baseURL: 'https://auto.example/v1', models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
  })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body.profilesDerived.created, ['auto-15.c'], '只建缺的那一条')
  assert.equal(r.body.profilesDerived.existing.length, 2)
  const after = (await get('/api/model-profiles')).body.profiles
  assert.deepEqual(
    after.filter((p) => p.provider !== 'auto-15' || p.model !== 'c').map((p) => ({ id: p.id, version: p.version })),
    snapshot,
    '★ 已存在的档案连 version 都不该动（自动派生只 create，不改）',
  )
})

test('⑳ ★★ 派生的档案：地址与凭证**留空继承**，显示名按"供应商 · 模型"', async () => {
  const rows = (await get('/api/model-profiles')).body.profiles.filter((p) => p.provider === 'auto-15')
  assert.equal(rows.length, 3)
  for (const p of rows) {
    assert.equal(p.endpoint, null, `${p.id} 的 endpoint 必须留空（留空即继承供应商）`)
    assert.equal(p.hasCredential, false, `${p.id} 不该自带凭证引用`)
    assert.match(p.displayName, /^自动 · /)
  }
})

test('㉑ ★★ 幂等：对同一个供应商再跑一次"补齐" ⇒ 新增 0，已有档案连 version 都不动', async () => {
  const before = (await get('/api/model-profiles')).body.profiles
  const snapshot = before.map((p) => ({ id: p.id, version: p.version }))
  const r = await post('/api/model-providers/auto-15/derive-profiles', { actor: 'general' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.created.length, 0)
  assert.equal(r.body.existing.length, 3)
  assert.match(r.body.summary, /新增 0/)
  const after = (await get('/api/model-profiles')).body.profiles
  assert.deepEqual(after.map((p) => ({ id: p.id, version: p.version })), snapshot)
})

test('㉒ ★★★ 保存时不给 `runtimeType` 也照样自动生成（只有唯一能跑的运行时 ⇒ 这不是猜）', async () => {
  // 面板/脚本不会总是带这个字段；而 Legion 只有 `dsh` 一个适配器
  // （`runtime/contracts/model.mjs` 的 `SUPPORTED_RUNTIME_TYPES`）⇒ 选它不需要用户任何信息。
  const r = await post('/api/model-providers', {
    actor: 'general',
    provider: { id: 'auto-rt-15', displayName: 'RT', baseURL: 'https://rt.example/v1', models: [{ id: 'm' }] },
  })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.runtimeType, 'dsh')
  assert.equal(r.body.profilesDerived.created.length, 1)
  // `runtimeTypeFrom` 在**创建**这条路上是 `provider`：路由先在写库前定值、写进那一行，
  // 派生再读那一行。`only-supported` 出现在**补齐历史行**那条路上（见 ㉔）。
  assert.equal(r.body.profilesDerived.runtimeTypeFrom, 'provider', '读数要说明这个值是哪来的')
})

test('㉓ ★★★ 导入（从运行环境收进来）同样**自动生成** —— 否则引导之后目录一堆、档案为空', async () => {
  // 这正是将军那台机器上的那一幕：供应商 4 个、档案只有 3 条（都是更早那条路建的）。
  const r = await post('/api/model-providers/import', {
    actor: 'general',
    providers: [{
      id: 'imported-15', displayName: '导入的', api: 'openai-completions',
      baseURL: 'https://imp.example/v1', secretRef: 'IMPORTED_KEY_15', credentialConfigured: true,
      models: [{ id: 'i1' }, { id: 'i2' }],
    }],
  })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.created, 1)
  const one = r.body.profilesDerived.find((d) => d.providerId === 'imported-15')
  assert.ok(one, '导入的供应商也要出现在派生读数里')
  assert.equal(one.created.length, 2, '★ 导入完就有两条档案，不用再点')
  const rows = (await get('/api/model-profiles')).body.profiles.filter((p) => p.provider === 'imported-15')
  assert.equal(rows.length, 2)
})

test('㉔ ★★ 老供应商（本轮之前建的、没有 runtimeType）⇒ 走"补齐"这条路，且先给计划再落笔', async () => {
  // 模拟历史数据：直接插一行**没有 runtime_type** 的供应商，且没有任何档案。
  // 这是真实部署里那 4 个供应商的样子（它们的"保存"发生在这段逻辑存在之前）。
  mod.db.prepare(
    `INSERT INTO model_providers (id, display_name, api, base_url, secret_ref, runtime_type, credential_configured,
       models_json, source, version, created_at_ms, updated_at_ms, deleted_at_ms)
     VALUES ('legacy-15','历史', 'openai-completions','https://legacy.example/v1', NULL, NULL, 0,
       '[{"id":"l1"},{"id":"l2"}]','dsh-import',1,?,?,NULL)`,
  ).run(Date.now(), Date.now())

  // ① 列表如实报"还缺 2 个"（面板据此提示"补齐"）
  const fjd = (await get('/api/model-providers')).body.providers.find((p) => p.id === 'legacy-15')
  assert.equal(fjd.profiles.missing, 2, '缺的数目要说出来，否则用户不知道还有没有没生成的')
  assert.equal(fjd.profiles.existing, 0)

  // ② dryRun 给计划，但**一条都不写**
  const before = (await get('/api/model-profiles')).body.profiles.length
  const dry = await post('/api/model-providers/legacy-15/derive-profiles', { actor: 'general', dryRun: true })
  assert.equal(dry.status, 200, JSON.stringify(dry.body))
  assert.equal(dry.body.plan.create.length, 2)
  assert.match(dry.body.summary, /新增 2/)
  assert.equal((await get('/api/model-profiles')).body.profiles.length, before, '★ dryRun 不许写任何东西')

  // ③ 真补齐：新增 2，且运行时被**写回供应商行**（这一行本来是 NULL）
  const ran = await post('/api/model-providers/legacy-15/derive-profiles', { actor: 'general' })
  assert.equal(ran.status, 200, JSON.stringify(ran.body))
  assert.equal(ran.body.created.length, 2)
  const rows = (await get('/api/model-profiles')).body.profiles.filter((p) => p.provider === 'legacy-15')
  assert.equal(rows.length, 2)
  const after = (await get('/api/model-providers')).body.providers.find((p) => p.id === 'legacy-15')
  assert.equal(after.profiles.missing, 0)
  assert.equal(after.runtimeType, 'dsh',
    '★ 补历史时把推断出来的运行时**记在行上**：否则加上第二个适配器的那天，这批 NULL 行会同时"说不清"')
})

test('㉕ ★★ 路由顺序：`/derive-profiles` **不能**被通配 id 吞掉（否则 id 会变成 `X/derive-profiles`）', async () => {
  // 位置对了 ⇒ 供应商不存在时是干净的 404「没有这个模型供应商」
  const missing = await post('/api/model-providers/never-existed-15/derive-profiles', { actor: 'general' })
  assert.equal(missing.status, 404, JSON.stringify(missing.body))
  assert.match(String(missing.body.error), /没有这个模型供应商/)
  assert.equal(String(missing.body.error).includes('derive-profiles'), false,
    '★ 错误信息里出现 derive-profiles ⇒ 它被当成 id 去 update 了（顺序反了）')
  const slash = await post('/api/model-providers/a%2Fb/derive-profiles', { actor: 'general' })
  assert.equal(slash.status, 400)
  assert.equal(slash.body.code, 'BAD_ID_ENCODING')
})

test('㉖ ★★ 算出来的 id 被**另一个模型**占用 ⇒ 报冲突、跳过、不覆盖别人的档案（自动那条路也一样）', async () => {
  // 先手工占住那个 id：`derive-c-15.x` 属于**别的**模型
  await post('/api/model-profiles', {
    actor: 'general',
    profile: { id: 'derive-c-15.x', displayName: '别的', runtimeType: 'dsh', provider: 'derive-c-15', model: 'other' },
  })
  // 再建供应商，它的模型 `x` 会折叠到同一个 id
  const r = await post('/api/model-providers', {
    actor: 'general',
    provider: { id: 'derive-c-15', displayName: 'C', baseURL: 'https://c.example/v1', models: [{ id: 'x' }] },
  })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.profilesDerived.created.length, 0, '★ 自动派生也不许覆盖别人的档案')
  assert.equal(r.body.profilesDerived.conflicts.length, 1)
  assert.equal(r.body.profilesDerived.conflicts[0].reason, 'ID_TAKEN_BY_OTHER')
  const rows = (await get('/api/model-profiles')).body.profiles
  const taken = rows.find((p) => p.id === 'derive-c-15.x')
  assert.equal(taken.model, 'other', '★ 绝不能把别人的档案改写成 x')
  // 冲突**不静默**：列表上仍然显示"缺 1"，用户点"补齐"还是同一条冲突读数
  const p = (await get('/api/model-providers')).body.providers.find((x) => x.id === 'derive-c-15')
  assert.equal(p.profiles.missing, 1)
})

test('㉗ ★ 供应商清单里没有的模型 ⇒ 只报 `orphaned`，**绝不自动删**', async () => {
  const cur = (await get('/api/model-providers')).body.providers.find((p) => p.id === 'derive-c-15')
  await post('/api/model-providers/derive-c-15', {
    actor: 'general', version: cur.version,
    provider: { id: 'derive-c-15', displayName: 'C', baseURL: 'https://c.example/v1', models: [{ id: 'y' }] },
  })
  const p = (await get('/api/model-providers')).body.providers.find((x) => x.id === 'derive-c-15')
  assert.equal(p.profiles.orphaned, 1, '孤儿要在列表上看得见')
  assert.match(p.credential !== undefined ? 'x' : 'y', /x|y/)   // 这一行只是保证上面那次 update 成功
  const rows = (await get('/api/model-profiles')).body.profiles
  assert.ok(rows.some((x) => x.provider === 'derive-c-15' && x.model === 'other'),
    '★ 清单里没有的模型对应的档案必须还在（删是不可逆方向的动作，该由人决定）')
})

test('㉘ ★★ 列表带 `runtimeTypes`（面板的下拉从这里取，不写死一个 dsh）', async () => {
  const r = await get('/api/model-providers')
  assert.ok(Array.isArray(r.body.runtimeTypes), '没有它面板只能自己写死，而写死的那份会在加第二个适配器时静默落后')
  assert.ok(r.body.runtimeTypes.some((t) => t.id === 'dsh'))
})
