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

function samplePack() {
  return validateWorkflowPack({ format: 'legion/workflow-pack@1', id: 'test.software', version: '1.0.0',
    name: '测试软件流程', description: '测试包', scope: { id: 'software', name: '软件协作' },
    roles: [{ role: 'coder', name: '编码工程师', kind: '实现', avatar: '💻' }],
    stages: [{ role: 'coder', label: '编码', prompt: 'Implement safely.', next: null, gate: false, artifact: null, docs: null, enabled: true }],
    assets: [{ id: 'guide', type: 'document', title: '协作指南', path: 'docs/guide.md', content: '# Guide\nUse the installed workflow.' }] })
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
  } })
}
harness.audits = []

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
