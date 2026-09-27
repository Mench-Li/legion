// team-hub/integration-worker.test.mjs —— S3（R-4 / 集成六步 + journal 恢复）
// 夹具全部位于系统临时目录；绝不触碰本仓真实仓库与 live 库。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGit, revParse, isAncestor, commitTree, updateRef } from './git-plumbing.mjs'
import { createDeliveryStore, ensureDeliverySchema } from './delivery-store.mjs'
import { createIntegrationWorker, INTEGRATION_OUTCOMES } from './integration-worker.mjs'

const TARGET = 'refs/heads/main'
const ENV = { GIT_AUTHOR_NAME: 'T-170', GIT_AUTHOR_EMAIL: 't170@example.invalid', GIT_COMMITTER_NAME: 'T-170', GIT_COMMITTER_EMAIL: 't170@example.invalid' }

function commitFile(repo, name, content, message) {
  writeFileSync(join(repo, name), content)
  runGit(['add', name], repo)
  const r = runGit(['commit', '-q', '-m', message], repo)
  assert.equal(r.status, 0, r.stderr)
  return revParse(repo, 'HEAD')
}

function fixture(tag) {
  // 单仓库夹具：本地沙箱禁止 git push（需要 shell 管道），故不用 bare+push，
  // 直接在同一个非 bare 仓库里造 main / feat 两个引用与对象。
  const repo = mkdtempSync(join(tmpdir(), 'legion-t170-int-' + tag + '-'))
  assert.equal(runGit(['init', '-q', '-b', 'main'], repo).status, 0)
  runGit(['config', 'user.email', 't170@example.invalid'], repo)
  runGit(['config', 'user.name', 'T-170'], repo)
  const base = commitFile(repo, 'a.txt', 'base\n', 'base')
  runGit(['checkout', '-q', '-b', 'feat'], repo)
  const source = commitFile(repo, 'feat.txt', 'feature\n', 'feat')
  runGit(['checkout', '-q', 'main'], repo)
  return { root: repo, repo, base, source }
}

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'legion-t170-intdb-'))
  const db = new DatabaseSync(join(dir, 'd.db'))
  ensureDeliverySchema(db)
  db.exec("CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, status TEXT, scope TEXT)")
  return createDeliveryStore(db)
}

function readyJob(store, fix, tag) {
  const d = store.createDelivery({ taskId: 'T-' + tag, attemptId: 'A-' + tag, sourceCommit: fix.source, baseCommit: fix.base, targetRef: TARGET }).delivery
  const enq = store.enqueueDelivery({ id: d.id, version: d.version, gates: { acceptanceEvidence: { passed: true } } })
  assert.equal(enq.ok, true)
  const job = store.claimIntegrationJob({ repoId: fix.repo, targetRef: TARGET, deliveryId: d.id, owner: 'w-' + tag, expectedHead: fix.base, leaseEpoch: 1 })
  assert.equal(job.ok, true)
  return { delivery: enq.delivery, job: job.job }
}

const passVerify = { targetRef: TARGET, verify: [{ id: 'pass', argv: ['node', '-e', 'process.exit(0)'], timeoutMs: 20000 }] }
const failVerify = { targetRef: TARGET, verify: [{ id: 'fail', argv: ['node', '-e', 'process.exit(1)'], timeoutMs: 20000 }] }

test('TC-S3-11 干净合入：目标 ref 前进且包含 source commit，delivery=integrated，记录 integrated_commit，释放预约', () => {
  const fix = fixture('clean')
  const store = freshStore()
  const { delivery, job } = readyJob(store, fix, 'clean')
  let released = false
  const worker = createIntegrationWorker({
    deliveryStore: store, repoDir: fix.repo, targetRef: TARGET, verifyConfig: passVerify,
    workspaceDir: fix.repo, env: ENV, releaseReservation: () => { released = true },
  })
  const r = worker.runJob({ jobId: job.id, leaseEpoch: 1 })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.outcome, INTEGRATION_OUTCOMES.INTEGRATED)
  assert.equal(revParse(fix.repo, TARGET), r.integratedCommit)
  assert.equal(isAncestor(fix.repo, fix.source, TARGET), true)
  const d = store.getDelivery(delivery.id)
  assert.equal(d.state, 'integrated')
  assert.equal(d.integratedCommit, r.integratedCommit)
  assert.equal(released, true)
  assert.equal(store.getIntegrationJob(job.id).journalPhase, 'finalized')
  const events = store.listIntegrationEvents({ jobId: job.id })
  assert.ok(events.some((e) => e.to_state === 'ref-updated'))
  assert.ok(events.some((e) => e.to_state === 'finalized'))
})

test('TC-S3-12 Git 无冲突但候选验证失败：目标 ref SHA 不变且不 integrated', () => {
  const fix = fixture('fail')
  const store = freshStore()
  const { delivery, job } = readyJob(store, fix, 'fail')
  const worker = createIntegrationWorker({
    deliveryStore: store, repoDir: fix.repo, targetRef: TARGET, verifyConfig: failVerify,
    workspaceDir: fix.repo, env: ENV,
  })
  const r = worker.runJob({ jobId: job.id, leaseEpoch: 1 })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'VALIDATION_FAILED')
  assert.equal(r.targetRefUnchanged, true)
  assert.equal(revParse(fix.repo, TARGET), fix.base, '验证失败不得移动目标 ref')
  assert.equal(store.getDelivery(delivery.id).state, 'needs-review')
  assert.equal(r.report.candidateSha.length, 40)
  assert.equal(r.report.commands[0].exitCode, 1)
  assert.ok(typeof r.report.commands[0].durationMs === 'number')
})

test('TC-S3-18 未配置仓库验证命令 -> 停 needs-review 且不集成', () => {
  const fix = fixture('noverify')
  const store = freshStore()
  const { delivery, job } = readyJob(store, fix, 'noverify')
  const worker = createIntegrationWorker({ deliveryStore: store, repoDir: fix.repo, targetRef: TARGET, verifyConfig: null, workspaceDir: fix.repo, env: ENV })
  const r = worker.runJob({ jobId: job.id, leaseEpoch: 1 })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NO_VERIFY_CONFIG')
  assert.equal(revParse(fix.repo, TARGET), fix.base)
  assert.equal(store.getDelivery(delivery.id).state, 'needs-review')
})

test('TC-S3-16 绑定工作区脏时集成暂停且这些字节前后不变', () => {
  const fix = fixture('dirty')
  const store = freshStore()
  const { delivery, job } = readyJob(store, fix, 'dirty')
  const dirtyPath = join(fix.repo, 'user-wip.txt')
  writeFileSync(dirtyPath, 'local uncommitted work\n')
  const before = readFileSync(dirtyPath, 'utf8')
  const worker = createIntegrationWorker({ deliveryStore: store, repoDir: fix.repo, targetRef: TARGET, verifyConfig: passVerify, workspaceDir: fix.repo, env: ENV })
  const r = worker.runJob({ jobId: job.id, leaseEpoch: 1 })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'DIRTY_WORKSPACE')
  assert.equal(revParse(fix.repo, TARGET), fix.base)
  assert.equal(readFileSync(dirtyPath, 'utf8'), before, '用户字节必须原样保留')
  assert.equal(store.getDelivery(delivery.id).state, 'ready')
})

test('TC-S3-13 集成期间目标 HEAD 前进：候选与验证作废并按新 HEAD 重算，超上限进 needs-review', () => {
  const fix = fixture('advance')
  const store = freshStore()
  const { delivery, job } = readyJob(store, fix, 'advance')
  let round = 0
  const worker = createIntegrationWorker({
    deliveryStore: store, repoDir: fix.repo, targetRef: TARGET, verifyConfig: passVerify,
    workspaceDir: fix.repo, env: ENV, maxRecompute: 2,
    hooks: {
      beforeApply() {
        // 模拟外部 worker 在最终提交前推进了目标 ref
        const head = revParse(fix.repo, TARGET)
        const tree = runGit(['rev-parse', head + '^{tree}'], fix.repo).stdout.trim()
        const next = commitTree(fix.repo, tree, [head], 'external-' + round, { env: ENV }).commit
        updateRef(fix.repo, TARGET, next, head)
        round += 1
      },
    },
  })
  const r = worker.runJob({ jobId: job.id, leaseEpoch: 1 })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'HEAD_ADVANCED_LIMIT')
  assert.equal(r.recompute, 3, '上限 2：第 3 次前进即停')
  assert.equal(round, 3)
  assert.equal(store.getDelivery(delivery.id).state, 'needs-review')
})

test('TC-S3-14/15 journal 恢复：已应用未记账只补记不重跑 merge，不删分支', () => {
  const fix = fixture('recover')
  const store = freshStore()
  const { delivery, job } = readyJob(store, fix, 'recover')
  // 模拟崩溃：候选已 apply 到目标 ref，但 job 停在 applying、delivery 未 integrated
  const merged = runGit(['merge-tree', '--write-tree', fix.base, fix.source], fix.repo)
  assert.equal(merged.status, 0)
  const candidate = commitTree(fix.repo, merged.stdout.split('\n')[0].trim(), [fix.base, fix.source], 'candidate-recover', { env: ENV }).commit
  assert.equal(updateRef(fix.repo, TARGET, candidate, fix.base).ok, true)
  store.transitionIntegrationJob({ id: job.id, leaseEpoch: 1, to: 'applying', phase: 'prepared', preparedCommit: candidate, expectedHead: fix.base })

  const worker = createIntegrationWorker({ deliveryStore: store, repoDir: fix.repo, targetRef: TARGET, verifyConfig: passVerify, workspaceDir: fix.repo, env: ENV })
  const rec = worker.recover()
  assert.equal(rec.actions.length, 1)
  assert.equal(rec.actions[0].action, 'record-only')
  assert.equal(rec.actions[0].deleteBranch, false)
  assert.equal(store.getDelivery(delivery.id).state, 'integrated')
  assert.equal(store.getDelivery(delivery.id).integratedCommit, candidate)
  assert.equal(revParse(fix.repo, TARGET), candidate, '不重跑 merge（ref 未变）')
  assert.equal(store.getIntegrationJob(job.id).state, 'finalized')
  // source 提交仍然可达（不丢产物）
  assert.equal(isAncestor(fix.repo, fix.source, TARGET), true)
})

test('TC-S3-14b 每个 source commit 至多集成一次（重复 recover 无副作用）', () => {
  const fix = fixture('once')
  const store = freshStore()
  const { delivery, job } = readyJob(store, fix, 'once')
  const worker = createIntegrationWorker({ deliveryStore: store, repoDir: fix.repo, targetRef: TARGET, verifyConfig: passVerify, workspaceDir: fix.repo, env: ENV })
  const first = worker.runJob({ jobId: job.id, leaseEpoch: 1 })
  assert.equal(first.ok, true)
  const headAfter = revParse(fix.repo, TARGET)
  const rec = worker.recover()
  assert.equal(rec.actions.length, 0, 'finalized job 不再进入恢复')
  assert.equal(revParse(fix.repo, TARGET), headAfter)
  const d = store.getDelivery(delivery.id)
  assert.equal(d.state, 'integrated')
})