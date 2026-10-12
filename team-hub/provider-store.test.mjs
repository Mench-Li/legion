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

import { createProviderStore, ensureProviderSchema, toProviderInput } from './provider-store.mjs'

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
