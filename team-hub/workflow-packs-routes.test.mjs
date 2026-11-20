import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createWorkflowPackRoutes } from './routes/workflow-packs.mjs'
import { ensureWorkflowPackSchema, validateWorkflowPack } from '../product/workflow-packs/pack.mjs'

function createDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, private INTEGER DEFAULT 0,
    local_dir TEXT DEFAULT '', remote_url TEXT DEFAULT '', createdAt TEXT, updatedAt TEXT);
    CREATE TABLE roster (scope TEXT NOT NULL, role TEXT NOT NULL, name TEXT NOT NULL, kind TEXT,
    avatar TEXT, sort INTEGER, PRIMARY KEY (scope, role));
    CREATE TABLE space_stages (scope TEXT NOT NULL, role TEXT NOT NULL, label TEXT NOT NULL, prompt TEXT,
    next TEXT, gate INTEGER, artifact TEXT, docs TEXT, sort INTEGER, enabled INTEGER, updatedAt TEXT,
    PRIMARY KEY(scope, role));`)
  ensureWorkflowPackSchema(db)
  return db
}

function samplePack(over = {}) {
  return validateWorkflowPack({ format: 'legion/workflow-pack@1', id: 'test.software', version: '1.0.0',
    name: '测试软件流程', description: '测试包', scope: { id: 'software', name: '软件协作' },
    roles: [{ role: 'coder', name: '编码工程师', kind: '实现', avatar: '💻' }],
    stages: [{ role: 'coder', label: '编码', prompt: 'Implement safely.', next: null, gate: false, artifact: null, docs: null, enabled: true }],
    assets: [{ id: 'guide', type: 'document', title: '协作指南', path: 'docs/guide.md', content: '# Guide\nUse the installed workflow.' }],
    ...over })
}

function harness(db, { by = 'general' } = {}) {
  const json = (_res, status, payload) => { _res.status = status; _res.body = payload }
  return createWorkflowPackRoutes({ db, json, audit: (...args) => { harness.audits.push(args) }, withTx: mutate => {
    db.exec('BEGIN IMMEDIATE')
    try { const result = mutate(); db.exec('COMMIT'); return result }
    catch (error) { db.exec('ROLLBACK'); throw error }
  }, handleWrite: async (req, res, callback) => {
    const result = await callback({ ...req.body, by: req.body?.by ?? by }, req.body?.by ?? by, req.body?.scope ?? 'default')
    json(res, 200, { ok: true, task: result })
  },
  // ★ BUG-048：装包会顺手建出空间，所以这条族也要接"建空间即授予创建者"。
  //   这里只记下调用（真的授予在 `identity-remote.test.mjs` 里用真 HTTP + 真令牌验）。
  grantSpaceCreator: (call) => { harness.grants.push(call) } })
}
harness.audits = []
harness.grants = []

test('workflow pack route previews without writing and imports only after explicit install', async () => {
  harness.audits = []
  const db = createDb()
  const routes = harness(db)
  const pack = samplePack()
  const preview = { body: { by: 'general', scope: 'software', pack: pack.pack } }
  let res = {}
  await routes.dispatch({ method: 'POST', ...preview }, res, { path: '/api/workflow-packs/preview' })
  assert.equal(res.body.task.action, 'install')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM spaces').get().n, 0)

  res = {}
  await routes.dispatch({ method: 'POST', ...preview }, res, { path: '/api/workflow-packs/install' })
  assert.equal(res.body.task.installed, true)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM space_stages WHERE scope = ?').get('software').n, 1)
  assert.equal(harness.audits.length, 1)
  db.close()
})

test('workflow pack route refuses unconfirmed overwrite and non-general install', async () => {
  const db = createDb()
  db.prepare('INSERT INTO spaces (id, name) VALUES (?, ?)').run('software', 'Existing')
  const routes = harness(db)
  const body = { by: 'general', scope: 'software', pack: samplePack().pack }
  const response = { body: null }
  await assert.rejects(() => routes.dispatch({ method: 'POST', body }, response, { path: '/api/workflow-packs/install' }), /SCOPE_ALREADY_EXISTS/)
  await assert.rejects(() => routes.dispatch({ method: 'POST', body: { ...body, by: 'coder' } }, {}, { path: '/api/workflow-packs/install' }), /general/)
  assert.equal(db.prepare('SELECT name FROM spaces WHERE id = ?').get('software').name, 'Existing')
  db.close()
})

test('installed workflow pack assets can be read by their package and scope', async () => {
  const db = createDb()
  const routes = harness(db)
  const pack = samplePack()
  await routes.dispatch({ method: 'POST', body: { by: 'general', scope: 'software', pack: pack.pack } }, {}, { path: '/api/workflow-packs/install' })
  const res = {}
  await routes.dispatch({ method: 'GET', url: '/api/workflow-packs/assets?scope=software&pack=test.software' }, res,
    { path: '/api/workflow-packs/assets' })
  assert.equal(res.status, 200)
  assert.deepEqual({ ...res.body.assets[0] }, { id: 'guide', type: 'document', title: '协作指南', path: 'docs/guide.md', content: '# Guide\nUse the installed workflow.' })
  db.close()
})

test('★★★ 装包建出空间时也要走"创建者授予"钩子，且升级**不**再触发（BUG-048 第二条入口）', async () => {
  const db = createDb()
  harness.grants = []
  const routes = harness(db)
  const pack = samplePack()

  // ① 第一次装：这个包还没装过 ⇒ `installWorkflowPack` 会 INSERT 空间行
  await routes.dispatch({ method: 'POST', body: { by: 'general', scope: 'software', pack: pack.pack } }, {}, { path: '/api/workflow-packs/install' })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM spaces WHERE id = ?').get('software').n, 1, '★ 空间确实是装包建出来的')
  assert.equal(harness.grants.length, 1, '★★★ 建空间的那一次必须请求授予 —— 少了它，登录用户装个包就得到一个自己进不去的空间')
  assert.equal(harness.grants[0].space, 'software')
  assert.equal(harness.grants[0].created, true, '★★ 必须是"新建"口径（只有新建才授予）')

  // ② 同一个包升级（内容变了 ⇒ 新 digest，空间已经在了）：**不许**再走创建授予
  harness.grants = []
  const upgraded = samplePack({ version: '1.0.1', description: '测试包（第二版）' })
  await routes.dispatch({ method: 'POST', body: { by: 'general', scope: 'software', pack: upgraded.pack } }, {}, { path: '/api/workflow-packs/install' })
  assert.deepEqual(harness.grants, [], '★★ 既有空间不重复授予（与 POST /api/spaces 的"只有新建才授予"同一条闸）')
  db.close()
})
