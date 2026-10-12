// team-hub/provider-store.test.mjs
// ============================================================================
// 供应商仓储自己的判据 —— 这一组补的是一个**只有仓储层才能验**的行为：
// 读出来的行（带簿记字段）能不能**改一个字段再写回去**。
//
// 由来（实测踩到）：`get()` 的产物带着 `source` / `version` / `createdAtMs` …
// 而 `normalizeProvider` 对未知字段是**拒绝**（那是密钥纪律的一部分，不能放松）。
// 于是"读出来、改一个字段、写回去"这个最自然的动作被自己的校验挡住了：
//
//     供应商不合法：未知字段：source, version, createdAtMs, updatedAtMs, deletedAtMs
//
//   > 一个"读出什么就能写回什么"的仓储，
//   > 与一个"读出来的形状比能写回去的形状多几个字段"的仓储，
//   > 在**只有手工构造输入**的那些路径上是同一个东西 —— 直到有人真的想读改写一次。
//
// 以及 `runtimeType` 这一列的往返：它在**老行**上是 NULL，而"没给"读起来是
// "我对它没意见"，不是"我要把它清掉"。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { createProviderStore, ensureProviderSchema, toProviderInput, defaultSecretRefFor, resolveCredentialRef } from './provider-store.mjs'

function freshStore() {
  const db = new DatabaseSync(':memory:')
  ensureProviderSchema(db)
  let now = 1_700_000_000_000
  const store = createProviderStore({ db, clock: () => (now += 1000), writeAudit: () => {} })
  return { db, store }
}

const input = (over = {}) => ({
  id: 'p1', displayName: 'P', api: 'openai-completions', baseURL: 'https://p.example/v1',
  secretRef: null, credentialConfigured: false, models: [{ id: 'm1' }], ...over,
})

test('① `runtimeType` 往返：写进去、读出来、再写回去', () => {
  const { store } = freshStore()
  const created = store.create(input({ runtimeType: 'dsh' }), { actor: 'u1' })
  assert.equal(created.provider.runtimeType, 'dsh')

  const read = store.get('p1')
  assert.equal(read.runtimeType, 'dsh')
  // ★ 关键：读出来的东西直接喂回去不许被自己的校验挡住
  const next = store.update('p1', { ...toProviderInput(read), displayName: 'P2' }, { actor: 'u1', version: read.version })
  assert.equal(next.displayName, 'P2')
  assert.equal(next.runtimeType, 'dsh', '改别的字段不该把运行时弄丢')
})

test('② 不给 `runtimeType` 建 ⇒ 存 NULL（默认值的判定**不在仓储这一层**）', () => {
  const { store, db } = freshStore()
  store.create(input(), { actor: 'u1' })
  assert.equal(db.prepare('SELECT runtime_type FROM model_providers WHERE id = ?').get('p1').runtime_type, null)
  assert.equal(store.get('p1').runtimeType, null)
})

test('★★ ③ update 不给 `runtimeType` ⇒ **保留原值**，不是清空', () => {
  const { store } = freshStore()
  store.create(input({ runtimeType: 'dsh' }), { actor: 'u1' })
  const read = store.get('p1')
  const next = store.update('p1', toProviderInput({ ...read, runtimeType: undefined }), { actor: 'u1', version: read.version })
  assert.equal(next.runtimeType, 'dsh',
    '★ "没给"读起来是"我对它没意见"，不是"我要把它清掉"；清掉之后自动派生就不知道该写哪个运行时了')
})

test('★★ ④ 导入**不会**把已有的 `runtimeType` 抹掉（DSH 的目录里没有这个概念）', () => {
  const { store } = freshStore()
  store.create(input({ runtimeType: 'dsh' }), { actor: 'u1' })
  // 一份"DSH 现状"形状的快照：没有 runtimeType
  const snap = [{ id: 'p1', displayName: 'P', api: 'openai-completions', baseURL: 'https://p.example/v1', secretRef: null, credentialConfigured: false, models: [{ id: 'm1' }] }]
  const r = store.importSnapshot(snap, { actor: 'u1', source: 'dsh-import' })
  assert.equal(r.created, 0)
  assert.equal(r.unchanged, 1,
    '★ 内容没变就该是 unchanged：把 runtimeType 抹成 NULL 会让它读成"改了"，于是每次导入都推进一版 version')
  assert.equal(store.get('p1').runtimeType, 'dsh')
})

test('⑤ 导入一份**带** runtimeType 的快照 ⇒ 如实写进去', () => {
  const { store } = freshStore()
  store.importSnapshot([input({ runtimeType: 'codex' })], { actor: 'u1', source: 'dsh-import' })
  assert.equal(store.get('p1').runtimeType, 'codex')
})

test('⑥ 非法 `runtimeType` 被拒（空对象、超长串），且**不落库**', () => {
  const { store, db } = freshStore()
  for (const bad of [{ runtimeType: 42 }, { runtimeType: 'x'.repeat(65) }]) {
    assert.throws(() => store.create(input(bad), { actor: 'u1' }), /runtimeType/)
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM model_providers').get().n, 0)
})

test('⑦ `toProviderInput` 收窄到能写回去的字段（簿记字段一律不带）', () => {
  const { store } = freshStore()
  store.create(input({ runtimeType: 'dsh' }), { actor: 'u1' })
  const read = store.get('p1')
  assert.ok('source' in read && 'version' in read && 'createdAtMs' in read, '读出来的确实带簿记字段')
  const narrow = toProviderInput(read)
  for (const k of ['id', 'displayName', 'api', 'baseURL', 'secretRef', 'runtimeType', 'credentialConfigured', 'models']) {
    assert.equal(k in narrow, true, `应当保留 ${k}`)
  }
  for (const k of ['source', 'version', 'createdAtMs', 'updatedAtMs', 'deletedAtMs']) {
    assert.equal(k in narrow, false, `不该带 ${k}`)
  }
  assert.throws(() => toProviderInput(null), /供应商行/)
})

test('⑧ 老库（没有 runtime_type 列）⇒ `ensureProviderSchema` 幂等补列，且不动已有行', () => {
  const db = new DatabaseSync(':memory:')
  // 模拟"上一版的建表"：没有 runtime_type
  db.exec(`CREATE TABLE model_providers (
    id TEXT PRIMARY KEY, display_name TEXT NOT NULL, api TEXT, base_url TEXT, secret_ref TEXT,
    credential_configured INTEGER NOT NULL DEFAULT 0, models_json TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT 'legion', version INTEGER NOT NULL DEFAULT 1,
    created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, deleted_at_ms INTEGER)`)
  db.prepare('INSERT INTO model_providers (id, display_name, models_json, created_at_ms, updated_at_ms) VALUES (?,?,?,?,?)')
    .run('old', '老', '[{"id":"m"}]', 1, 1)

  ensureProviderSchema(db)   // 第一遍：补列
  ensureProviderSchema(db)   // 第二遍：幂等（并发启动那条纪律）
  const cols = db.prepare('PRAGMA table_info(model_providers)').all().map((c) => c.name)
  assert.ok(cols.includes('runtime_type'))
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM model_providers').get().n, 1, '补列不许动已有行')
  assert.equal(db.prepare('SELECT runtime_type FROM model_providers WHERE id = ?').get('old').runtime_type, null)
  db.close()
})

// ============================================================================
// ⑨ 引用名的写回语义（BUG-028 的一半）
//
// 「没给」与「给了 null」必须是**两件事**：
//   · 没给   = 我对这个字段没意见 ⇒ 保留原值；
//   · null   = 我要把它清掉。
//
// 为什么这一条是修 BUG-028 的前提：读侧不再返回引用名之后，面板**没有名字可以回传**，
// 于是"用户只改了显示名"那次保存必然**不带** `secretRef`。若那种请求被当成
// "他要清掉凭证"，用户会在毫无提示的情况下丢掉凭证引用 ——
//
//   > 一个"改显示名顺手把凭证删了"的保存，
//   > 与一个"我就是要删凭证"的保存，在请求体里长得一模一样。
//
// 而两者在后果上是两个东西。
// ============================================================================

test('⑨ ★★★ update 不给 `secretRef` ⇒ **保留原值**（改显示名不会顺手删凭证）', () => {
  const { store, db } = freshStore()
  store.create(input({ secretRef: 'FJD_DS_API_KEY' }), { actor: 'u1' })
  const read = store.get('p1')
  assert.equal(read.secretRef, 'FJD_DS_API_KEY', '前提：库里确实有引用名')

  // 模拟面板：只改显示名，**不带** secretRef（读侧已经不发它了）
  const without = toProviderInput(read)
  delete without.secretRef
  const next = store.update('p1', { ...without, displayName: '改个名' }, { actor: 'u1', version: read.version })

  assert.equal(next.displayName, '改个名')
  assert.equal(next.secretRef, 'FJD_DS_API_KEY', '★ 没给 = 保留；清掉它必须显式说')
  assert.equal(db.prepare('SELECT secret_ref FROM model_providers WHERE id = ?').get('p1').secret_ref, 'FJD_DS_API_KEY')
})

test('⑨ ★★ update 显式给 `null` ⇒ **真的清掉**（"没给"与"给 null"不是同一件事）', () => {
  const { store } = freshStore()
  store.create(input({ secretRef: 'FJD_DS_API_KEY' }), { actor: 'u1' })
  const read = store.get('p1')

  const next = store.update('p1', { ...toProviderInput(read), secretRef: null }, { actor: 'u1', version: read.version })
  assert.equal(next.secretRef, null, '显式 null 是"我要清掉"，不许被保留语义吞掉')
})

test('⑨ ★ update 给了新引用名 ⇒ 换成新的', () => {
  const { store } = freshStore()
  store.create(input({ secretRef: 'OLD_KEY' }), { actor: 'u1' })
  const read = store.get('p1')
  const next = store.update('p1', { ...toProviderInput(read), secretRef: 'NEW_KEY' }, { actor: 'u1', version: read.version })
  assert.equal(next.secretRef, 'NEW_KEY')
})

test('⑨ ★ 新建不给 `secretRef` ⇒ null（保留语义只对 update 成立）', () => {
  const { store } = freshStore()
  const created = store.create({ ...input(), secretRef: undefined }, { actor: 'u1' })
  assert.equal(created.provider.secretRef, null, '没有"原值"可保留时就该是 null')
})

// ============================================================================
// ⑩ 写凭证时用哪个槽位名（BUG-028 的另一半）
//
// 读侧不再给出引用名之后，客户端**没有任何名字**能拿去写密钥库。
// 于是"写哪儿"由服务端决定，而这条规则必须是**可测的纯函数**：
//
//   已有名字优先 ＞ 派生名
//
// 反过来的后果很具体：从 DSH 导进来的行，其引用名是 DSH 侧的 `apiKeyEnv`
// （`secretRef ↔ apiKeyEnv` 两侧靠它对齐）。若用派生名覆盖它，
// 物化会把 DSH 侧的键名改掉，而 DSH 那边的钥匙就是按那个名字存的 ——
// 表现是"界面说保存成功、跑起来仍然认证失败"。
// ============================================================================

test('⑩ ★★★ 已有引用名优先（DSH 导进来的键名不许被派生名顶掉）', () => {
  const r = resolveCredentialRef({ existingRef: 'FJD_DS_API_KEY', id: 'fjd-ds' })
  assert.equal(r.ok, true)
  assert.equal(r.ref, 'FJD_DS_API_KEY')
  assert.equal(r.from, 'existing')
  // 与派生名一致时也算 existing（两者恰好相同是这台机器的巧合，不是规则）
  assert.equal(resolveCredentialRef({ existingRef: 'FJD_DS_API_KEY', id: 'fjd-ds' }).from, 'existing')
})

test('⑩ ★★ 没有已有引用名 ⇒ 用派生名（新建 / 从没配过凭证的老行）', () => {
  const r = resolveCredentialRef({ existingRef: null, id: 'my-provider' })
  assert.equal(r.ok, true)
  assert.equal(r.ref, 'MY_PROVIDER_API_KEY')
  assert.equal(r.from, 'derived')
})

test('⑩ ★ 派生名的形状：大写、非字母数字折成下划线、以 _API_KEY 结尾', () => {
  assert.equal(defaultSecretRefFor('fjd-ds'), 'FJD_DS_API_KEY')
  assert.equal(defaultSecretRefFor('a.b c'), 'A_B_C_API_KEY')
  assert.equal(defaultSecretRefFor(''), null)
  assert.equal(defaultSecretRefFor('   '), null)
  assert.equal(defaultSecretRefFor(null), null)
})

test('⑩ ★ id 为空且没有已有名字 ⇒ 具名报错（不是静默用一个空名字写进去）', () => {
  const r = resolveCredentialRef({ existingRef: null, id: null })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'SECRET_REF_UNRESOLVED')
  assert.match(r.message, /定不出凭证槽位名/)
})

test('⑩ ★ 空串/空白的已有名字**不算**已有（否则会拿一个空槽位名去写密钥库）', () => {
  for (const bad of ['', '   ', null, undefined]) {
    const r = resolveCredentialRef({ existingRef: bad, id: 'p' })
    assert.equal(r.from, 'derived', `existingRef=${JSON.stringify(bad)} 应当走派生名`)
    assert.equal(r.ref, 'P_API_KEY')
  }
})
