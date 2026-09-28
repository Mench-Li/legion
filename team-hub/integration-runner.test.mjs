import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGit, revParse, isWorktreeClean } from './git-plumbing.mjs'
import { resolveRepoIdentity } from '../packages/shared/src/repo-identity.mjs'
import { createWriteIntentStore, ensureWriteIntentSchema } from './write-intent-store.mjs'
import { createDeliveryStore, ensureDeliverySchema } from './delivery-store.mjs'
import { runDeliveryJob } from './integration-runner.mjs'

test('真实集成入口认领 job、验证候选、同步工作区并释放预约', () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-runner-'))
  const repo = join(root, 'repo')
  mkdirSync(repo)
  assert.equal(runGit(['init', '-q', '-b', 'main'], repo).status, 0)
  runGit(['config', 'user.name', 'Test'], repo)
  runGit(['config', 'user.email', 'test@example.invalid'], repo)
  writeFileSync(join(repo, 'base.txt'), 'base\n')
  runGit(['add', 'base.txt'], repo)
  assert.equal(runGit(['commit', '-qm', 'base'], repo).status, 0)
  const base = revParse(repo, 'HEAD')
  runGit(['checkout', '-q', '-b', 'task'], repo)
  writeFileSync(join(repo, 'feat.txt'), 'feature\n')
  runGit(['add', 'feat.txt'], repo)
  assert.equal(runGit(['commit', '-qm', 'feature'], repo).status, 0)
  const source = revParse(repo, 'HEAD')
  runGit(['checkout', '-q', 'main'], repo)
  mkdirSync(join(repo, '.legion'))
  writeFileSync(join(repo, '.legion', 'delivery.json'), JSON.stringify({ targetRef: 'refs/heads/main', verify: [{ id: 'pass', argv: ['node', '-e', 'process.exit(0)'], timeoutMs: 20000 }] }))
  // The config is a tracked repository file, so the bound workspace stays clean.
  runGit(['add', '.legion/delivery.json'], repo)
  assert.equal(runGit(['commit', '-qm', 'verification config'], repo).status, 0)
  const targetHead = revParse(repo, 'HEAD')

  const db = new DatabaseSync(join(root, 'jobs.db'))
  ensureWriteIntentSchema(db)
  ensureDeliverySchema(db)
  db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT, scope TEXT, scheduling_state TEXT)')
  db.prepare("INSERT INTO tasks (id,status,scope) VALUES ('T-1','in_review','default')").run()
  const repoId = resolveRepoIdentity(repo).repoId
  const intents = createWriteIntentStore(db)
  assert.equal(intents.reserve({ repoId, taskId: 'T-1', attemptId: 'A-1', epoch: 1, paths: ['feat.txt'], targetRef: 'refs/heads/main' }).ok, true)
  const deliveries = createDeliveryStore(db)
  const delivery = deliveries.createDelivery({ taskId: 'T-1', attemptId: 'A-1', sourceCommit: source, baseCommit: base, targetRef: 'refs/heads/main' }).delivery
  assert.equal(deliveries.enqueueDelivery({ id: delivery.id, version: delivery.version, gates: { finalDiffPaths: ['feat.txt'], intentPaths: ['feat.txt'], acceptanceEvidence: { passed: true } } }).ok, true)

  const result = runDeliveryJob({ db, repoDir: repo, repoId, targetRef: 'refs/heads/main', deliveryId: delivery.id })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(deliveries.getDelivery(delivery.id).state, 'integrated')
  assert.equal(readFileSync(join(repo, 'feat.txt'), 'utf8').replaceAll('\r\n', '\n'), 'feature\n')
  assert.equal(isWorktreeClean(repo).clean, true)
  assert.equal(intents.listActiveReservations(repoId).length, 0)
  assert.notEqual(revParse(repo, 'HEAD'), targetHead)
  db.close()
})
