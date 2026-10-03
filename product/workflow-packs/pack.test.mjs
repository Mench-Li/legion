import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createSoftwareCollaborationPack } from '../../desktop/scripts/software-collaboration-pack.mjs'
import { bootstrapWorkflowPack, installWorkflowPack, planWorkflowPackInstall, validateWorkflowPack } from './pack.mjs'

const source = {
  stages: [
    { role: 'requirement', label: '需求澄清', prompt: 'Clarify the user request.', next: 'coder' },
    { role: 'coder', label: '编码实现', prompt: 'Implement and test.', next: null },
  ],
}
const roster = [
  { role: 'requirement', name: '需求分析师', kind: '需求澄清', avatar: '🧭' },
  { role: 'coder', name: '编码工程师', kind: '实现与自测', avatar: '💻' },
]
function pack(overrides = {}) {
  return { format: 'legion/workflow-pack@1', id: 'example.software', version: '1.0.0',
    name: '软件协作', description: 'Example pack', scope: { id: 'software', name: '软件协作' },
    roles: roster, stages: source.stages, assets: [], ...overrides }
}

test('built-in software pack is data-only and carries the current eight-stage workflow', async () => {
  const rolesDefinition = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../../roles.json', import.meta.url), 'utf8'))
  const soldierPrompt = await (await import('node:fs/promises')).readFile(new URL('../../workflows/soldier-prompt.md', import.meta.url), 'utf8')
  const created = createSoftwareCollaborationPack({ rolesDefinition, soldierPrompt })
  const validated = validateWorkflowPack(created)
  assert.equal(validated.pack.id, 'legion.software-collaboration')
  assert.equal(validated.pack.roles.length, 8)
  assert.equal(validated.pack.stages.length, 8)
  assert.equal(validated.pack.assets[0].content, soldierPrompt)
})

test('workflow pack rejects executable, host-specific, traversal and unknown content', () => {
  for (const invalid of [
    pack({ format: 'legion/workflow-pack@2' }),
    pack({ roles: [...roster, roster[0]] }),
    pack({ stages: [{ ...source.stages[0], next: 'missing' }, source.stages[1]] }),
    pack({ assets: [{ id: 'run', type: 'script', title: 'Run', path: 'run.js', content: 'process.exit()' }] }),
    pack({ assets: [{ id: 'escape', type: 'template', title: 'Escape', path: '../secret.md', content: 'x' }] }),
    pack({ assets: [{ id: 'absolute', type: 'template', title: 'Absolute', path: 'C:\\Users\\me\\secret.md', content: 'x' }] }),
    pack({ surprise: true }),
  ]) assert.throws(() => validateWorkflowPack(invalid))
})

test('Ozon-shaped workflows fit the same package format without carrying account data', () => {
  const ozon = validateWorkflowPack(pack({
    id: 'example.ozon-operations', version: '0.1.0', name: 'Ozon 订单协作',
    description: '订单处理和售后流程。账号授权由 Legion 密钥库单独管理。',
    scope: { id: 'ozon', name: 'Ozon 运营' },
    roles: [{ role: 'order-review', name: '订单审核', kind: '订单信息核验', avatar: '📦' }],
    stages: [{ role: 'order-review', label: '订单审核', prompt: 'Review the authorized order details.', next: null,
      gate: false, artifact: null, docs: null, enabled: true }],
  }))
  assert.equal(ozon.pack.scope.id, 'ozon')
  assert.equal(ozon.pack.stages[0].role, 'order-review')
  assert.match(ozon.pack.description, /密钥库/)
})

test('install planning creates, recognizes current version and detects local edits before upgrade', () => {
  const v1 = validateWorkflowPack(pack())
  assert.equal(planWorkflowPackInstall(v1).action, 'install')
  assert.equal(planWorkflowPackInstall(v1, { scopeExists: true }).reason, 'SCOPE_ALREADY_EXISTS')
  const receipt = { packId: v1.pack.id, scope: v1.pack.scope.id, version: v1.pack.version, digest: v1.digest, appliedDigest: 'baseline' }
  assert.equal(planWorkflowPackInstall(v1, { receipt, currentDigest: 'baseline' }).action, 'current')
  const v2 = validateWorkflowPack(pack({ version: '1.1.0', description: 'Updated.' }))
  assert.equal(planWorkflowPackInstall(v2, { receipt, currentDigest: 'user-edited' }).reason, 'LOCAL_EDITS')
  assert.equal(planWorkflowPackInstall(v2, { receipt, currentDigest: 'baseline' }).action, 'upgrade')
})

test('first install is atomic, binds the workspace, and repeat startup preserves the installed package', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, private INTEGER DEFAULT 0,
    local_dir TEXT DEFAULT '', remote_url TEXT DEFAULT '', createdAt TEXT, updatedAt TEXT);
    CREATE TABLE roster (scope TEXT NOT NULL, role TEXT NOT NULL, name TEXT NOT NULL, kind TEXT,
    avatar TEXT, sort INTEGER, PRIMARY KEY (scope, role));
    CREATE TABLE space_stages (scope TEXT NOT NULL, role TEXT NOT NULL, label TEXT NOT NULL, prompt TEXT,
    next TEXT, gate INTEGER, artifact TEXT, docs TEXT, sort INTEGER, enabled INTEGER, updatedAt TEXT,
    PRIMARY KEY(scope, role));
    CREATE TABLE space_runtime (scope TEXT PRIMARY KEY, enabled INTEGER, maxWorkers INTEGER, isolate INTEGER, updatedAt TEXT);`)
  const validated = validateWorkflowPack(pack())
  const first = installWorkflowPack(db, validated, { now: () => '2026-10-01T00:00:00Z', workspaceDir: 'D:\\projects\\demo' })
  assert.equal(first.action, 'install')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM roster WHERE scope = ?').get('software').n, 2)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM space_stages WHERE scope = ?').get('software').n, 2)
  assert.equal(db.prepare('SELECT local_dir FROM spaces WHERE id = ?').get('software').local_dir, 'D:\\projects\\demo')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM space_runtime').get().n, 0, 'installing a pack does not enable automatic execution')
  assert.equal(installWorkflowPack(db, validated).action, 'current')
  const update = validateWorkflowPack(pack({ version: '1.1.0', description: 'Compatible update.' }))
  assert.equal(installWorkflowPack(db, update).action, 'upgrade', 'an unchanged pack-managed scope can upgrade')
  assert.equal(db.prepare('SELECT local_dir FROM spaces WHERE id = ?').get('software').local_dir, 'D:\\projects\\demo')
  db.prepare('UPDATE space_stages SET prompt = ? WHERE scope = ? AND role = ?').run('user edit', 'software', 'coder')
  assert.throws(() => installWorkflowPack(db, validateWorkflowPack(pack({ version: '1.2.0' }))), error => error.code === 'LOCAL_EDITS')
  db.close()
})

test('install refuses to claim or overwrite an existing scope without a matching package receipt', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, private INTEGER DEFAULT 0,
    local_dir TEXT DEFAULT '', remote_url TEXT DEFAULT '', createdAt TEXT, updatedAt TEXT);
    CREATE TABLE roster (scope TEXT NOT NULL, role TEXT NOT NULL, name TEXT NOT NULL, kind TEXT, avatar TEXT, sort INTEGER,
    PRIMARY KEY (scope, role));
    CREATE TABLE space_stages (scope TEXT NOT NULL, role TEXT NOT NULL, label TEXT NOT NULL, prompt TEXT, next TEXT,
    gate INTEGER, artifact TEXT, docs TEXT, sort INTEGER, enabled INTEGER, updatedAt TEXT, PRIMARY KEY(scope, role));`)
  db.prepare('INSERT INTO spaces (id, name) VALUES (?, ?)').run('software', 'Existing user space')
  assert.throws(() => installWorkflowPack(db, validateWorkflowPack(pack())), error => error.code === 'SCOPE_ALREADY_EXISTS')
  assert.equal(db.prepare('SELECT name FROM spaces WHERE id = ?').get('software').name, 'Existing user space')
  db.close()
})

test('startup bootstrap never claims an existing space or silently upgrades a built-in pack', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, private INTEGER DEFAULT 0,
    local_dir TEXT DEFAULT '', remote_url TEXT DEFAULT '', createdAt TEXT, updatedAt TEXT);
    CREATE TABLE roster (scope TEXT NOT NULL, role TEXT NOT NULL, name TEXT NOT NULL, kind TEXT, avatar TEXT, sort INTEGER,
    PRIMARY KEY (scope, role));
    CREATE TABLE space_stages (scope TEXT NOT NULL, role TEXT NOT NULL, label TEXT NOT NULL, prompt TEXT, next TEXT,
    gate INTEGER, artifact TEXT, docs TEXT, sort INTEGER, enabled INTEGER, updatedAt TEXT, PRIMARY KEY(scope, role));`)
  db.prepare('INSERT INTO spaces (id, name) VALUES (?, ?)').run('software', 'Existing user space')
  const first = bootstrapWorkflowPack(db, validateWorkflowPack(pack()))
  assert.equal(first.action, 'conflict')
  assert.equal(first.skipped, true)
  assert.equal(db.prepare('SELECT name FROM spaces WHERE id = ?').get('software').name, 'Existing user space')

  db.prepare('DELETE FROM spaces WHERE id = ?').run('software')
  installWorkflowPack(db, validateWorkflowPack(pack()))
  const newer = validateWorkflowPack(pack({ version: '1.1.0', description: 'New built-in release.' }))
  const second = bootstrapWorkflowPack(db, newer)
  assert.equal(second.action, 'upgrade')
  assert.equal(second.skipped, true)
  assert.equal(db.prepare('SELECT version FROM workflow_pack_installs WHERE pack_id = ?').get('example.software').version, '1.0.0')
  db.close()
})
