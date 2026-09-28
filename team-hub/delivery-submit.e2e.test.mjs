import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGit, revParse, isWorktreeClean } from './git-plumbing.mjs'

test('HTTP 正式交付入口完成真实集成并同步主工作区', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-submit-e2e-'))
  const repo = join(root, 'repo')
  mkdirSync(repo)
  assert.equal(runGit(['init', '-q', '-b', 'main'], repo).status, 0)
  runGit(['config', 'user.name', 'Test'], repo)
  runGit(['config', 'user.email', 'test@example.invalid'], repo)
  mkdirSync(join(repo, '.legion'))
  writeFileSync(join(repo, '.legion', 'delivery.json'), JSON.stringify({ targetRef: 'refs/heads/main', verify: [{ id: 'pass', argv: ['node', '-e', 'process.exit(0)'], timeoutMs: 20000 }] }))
  writeFileSync(join(repo, 'base.txt'), 'base\n')
  runGit(['add', '.'], repo)
  assert.equal(runGit(['commit', '-qm', 'base'], repo).status, 0)
  runGit(['checkout', '-q', '-b', 'w/T-e2e'], repo)
  writeFileSync(join(repo, 'same.txt'), 'feature\n')
  runGit(['add', 'same.txt'], repo)
  assert.equal(runGit(['commit', '-qm', 'feature'], repo).status, 0)
  const source = revParse(repo, 'HEAD')
  runGit(['checkout', '-q', 'main'], repo)

  process.env.TEAM_HUB_DB = join(root, 'team.db')
  process.env.TEAM_HUB_TOKEN = ''
  process.env.LEGION_INTEGRATION_MODE = 'integration'
  const hub = await import('./server.mjs')
  hub.db.prepare("INSERT INTO spaces (id,name,local_dir) VALUES ('delivery-test','Delivery',?)").run(repo)
  hub.db.prepare("INSERT INTO tasks (id,title,status,scope,fixCount) VALUES ('T-e2e','E2E','todo','delivery-test',0)").run()
  await new Promise((resolve) => hub.server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + hub.server.address().port
  const post = async (path, body) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  try {
    const intent = await post('/api/tasks/T-e2e/write-intent', { by: 'planner', scope: 'delivery-test', paths: ['same.txt'] })
    assert.equal(intent.status, 200, JSON.stringify(intent.body))
    const claim = await post('/api/claim', { id: 'T-e2e', by: 'worker', scope: 'delivery-test' })
    assert.equal(claim.status, 200, JSON.stringify(claim.body))
    const missingEvidence = await post('/api/deliveries/submit', { by: 'worker', scope: 'delivery-test', taskId: 'T-e2e', sourceCommit: source, acceptanceEvidence: { passed: true }, humanApproved: true })
    assert.equal(missingEvidence.status, 422)
    assert.equal(missingEvidence.body.delivery.state, 'awaiting-acceptance')
    const evidence = await post('/api/comment', { id: 'T-e2e', by: 'worker', scope: 'delivery-test', isEvidence: true, text: `sourceCommit=${source}\n验收通过` })
    assert.equal(evidence.status, 200)
    const unapproved = await post('/api/deliveries/submit', { by: 'worker', scope: 'delivery-test', taskId: 'T-e2e', sourceCommit: source, humanApproved: true, humanApprovalRequired: false })
    assert.equal(unapproved.status, 422)
    assert.equal(unapproved.body.reasons.some((reason) => reason.code === 'human-review-unapproved'), true)
    const delivered = await post('/api/deliveries/approve', { by: 'general', scope: 'delivery-test', taskId: 'T-e2e' })
    assert.equal(delivered.status, 200, JSON.stringify(delivered.body))
    assert.equal(delivered.body.delivery.state, 'integrated')
    assert.equal(readFileSync(join(repo, 'same.txt'), 'utf8').replaceAll('\r\n', '\n'), 'feature\n')
    assert.equal(isWorktreeClean(repo).clean, true)
    assert.equal(hub.db.prepare("SELECT COUNT(*) AS n FROM write_reservations WHERE task_id='T-e2e' AND state='reserved'").get().n, 0)
    const unsafe = await post('/api/deliveries', { by: 'worker', taskId: 'T-e2e', sourceCommit: source, targetRef: 'refs/heads/main' })
    assert.equal(unsafe.body.code, 'USE_VERIFIED_SUBMISSION')
    const unsafeDecision = await post(`/api/deliveries/${delivered.body.delivery.id}/decision`, { by: 'general', decision: 'adopt-a', version: delivered.body.delivery.version })
    assert.equal(unsafeDecision.body.code, 'USE_VERIFIED_SUBMISSION')
    const unconfirmedRecovery = await post('/api/integration/recover', { by: 'general', jobId: 'unknown' })
    assert.equal(unconfirmedRecovery.status, 403)
    const other = join(root, 'other')
    assert.equal(runGit(['worktree', 'add', '-q', '-b', 'other', other], repo).status, 0)
    hub.db.prepare("INSERT INTO spaces (id,name,local_dir) VALUES ('other-space','Other',?)").run(other)
    const divergent = await fetch(base + '/api/tasks/T-e2e/contention')
    assert.equal(divergent.status, 409)
    assert.equal((await divergent.json()).code, 'REPO_UNBOUND')
    runGit(['worktree', 'remove', '-f', other], repo)
  } finally {
    hub.server.closeAllConnections?.()
    hub.server.close()
    hub.db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
