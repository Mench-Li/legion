// team-hub/delivery-store.test.mjs —— S3（R-4 / 交付子状态 + 集成 job + 登记校验）
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createDeliveryStore, ensureDeliverySchema, checkEnqueueGates,
  DELIVERY_STATES, SCHEDULING_STATES, INTEGRATION_JOB_STATES, TERMINAL_DELIVERY_STATES,
} from './delivery-store.mjs'
import { parseDeliveryConfig, hasExecutableVerification } from './verify-config.mjs'

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'legion-t170-delivery-'))
  const db = new DatabaseSync(join(dir, 'd.db'))
  ensureDeliverySchema(db)
  db.exec("CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, status TEXT, scope TEXT)")
  return { db, store: createDeliveryStore(db), clock: { t: 1000 } }
}

const base = { taskId: 'T-1', attemptId: 'A-1', sourceCommit: 'a'.repeat(40), baseCommit: 'b'.repeat(40), targetRef: 'refs/heads/main' }

test('TC-S3-01/02/03 入队门禁：越域 diff / 证据缺失 / 人审未批都不得进入 ready', () => {
  const { store } = fresh()
  const d = store.createDelivery(base).delivery
  assert.equal(d.state, 'awaiting-acceptance')

  const outOfDomain = store.enqueueDelivery({ id: d.id, gates: {
    finalDiffPaths: ['src/a.mjs', 'docs/x.md'], fileDomain: ['src'], intentPaths: ['src/a.mjs', 'docs/x.md'],
    acceptanceEvidence: { passed: true }, humanApprovalRequired: false, humanApproved: false,
  } })
  assert.equal(outOfDomain.ok, false)
  assert.equal(outOfDomain.code, 'ENQUEUE_GATE')
  assert.ok(outOfDomain.reasons.some((r) => r.code === 'out-of-domain-diff'))
  assert.equal(store.getDelivery(d.id).state, 'awaiting-acceptance')

  const noEvidence = store.enqueueDelivery({ id: d.id, gates: { finalDiffPaths: ['src/a.mjs'], fileDomain: ['src'], intentPaths: ['src/a.mjs'] } })
  assert.equal(noEvidence.ok, false)
  assert.ok(noEvidence.reasons.some((r) => r.code === 'acceptance-evidence-missing'))

  const unapproved = store.enqueueDelivery({ id: d.id, gates: {
    finalDiffPaths: ['src/a.mjs'], fileDomain: ['src'], intentPaths: ['src/a.mjs'],
    acceptanceEvidence: { passed: true }, humanApprovalRequired: true, humanApproved: false,
  } })
  assert.equal(unapproved.ok, false)
  assert.ok(unapproved.reasons.some((r) => r.code === 'human-review-unapproved'))
  assert.equal(store.getDelivery(d.id).state, 'awaiting-acceptance')

  const beyondIntent = store.enqueueDelivery({ id: d.id, gates: {
    finalDiffPaths: ['src/b.mjs'], fileDomain: ['src'], intentPaths: ['src/a.mjs'],
    acceptanceEvidence: { passed: true },
  } })
  assert.equal(beyondIntent.ok, false)
  assert.ok(beyondIntent.reasons.some((r) => r.code === 'beyond-write-intent'))
})

test('TC-S3-04 门禁全过才进入 ready；纯函数判定与 store 一致', () => {
  const { store } = fresh()
  const d = store.createDelivery(base).delivery
  const gate = checkEnqueueGates({
    finalDiffPaths: ['src/a.mjs'], fileDomain: ['src'], intentPaths: ['src/a.mjs'],
    acceptanceEvidence: { passed: true }, humanApprovalRequired: true, humanApproved: true,
  })
  assert.equal(gate.ok, true)
  const r = store.enqueueDelivery({ id: d.id, version: d.version, gates: {
    finalDiffPaths: ['src/a.mjs'], fileDomain: ['src'], intentPaths: ['src/a.mjs'],
    acceptanceEvidence: { passed: true }, humanApprovalRequired: true, humanApproved: true,
  }, actor: 'w1' })
  assert.equal(r.ok, true)
  assert.equal(r.delivery.state, 'ready')
  assert.equal(r.delivery.version, 2)
})

test('TC-S3-05 version CAS：过期提交被拒且不落库', () => {
  const { store } = fresh()
  const d = store.createDelivery(base).delivery
  store.enqueueDelivery({ id: d.id, version: d.version, gates: { acceptanceEvidence: { passed: true } } })
  const stale = store.enqueueDelivery({ id: d.id, version: d.version, gates: { acceptanceEvidence: { passed: true } } })
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'VERSION_CONFLICT')
  assert.equal(stale.currentVersion, 2)
  const badTransition = store.transitionDelivery({ id: d.id, version: 1, to: 'integrated' })
  assert.equal(badTransition.code, 'VERSION_CONFLICT')
})

test('TC-S3-06 状态机：awaiting-acceptance→ready→preparing→validating→integrated；终态不可再迁', () => {
  const { store } = fresh()
  const d = store.createDelivery(base).delivery
  let cur = store.enqueueDelivery({ id: d.id, version: 1, gates: { acceptanceEvidence: { passed: true } } }).delivery
  const seen = [cur.state]
  for (const to of ['preparing', 'validating', 'integrated']) {
    const r = store.transitionDelivery({ id: d.id, version: cur.version, to, actor: 'worker', gitSha: 'c'.repeat(40) })
    assert.equal(r.ok, true, JSON.stringify(r))
    cur = r.delivery
    seen.push(cur.state)
  }
  assert.deepEqual(seen, ['ready', 'preparing', 'validating', 'integrated'])
  assert.ok(TERMINAL_DELIVERY_STATES.includes('integrated'))
  const again = store.transitionDelivery({ id: d.id, version: cur.version, to: 'needs-review' })
  assert.equal(again.ok, false)
  assert.equal(again.code, 'TERMINAL_STATE')
})

test('TC-S3-06b needs-review→abandoned 与 needs-review→ready 两条路', () => {
  const { store } = fresh()
  const a = store.createDelivery(base).delivery
  store.enqueueDelivery({ id: a.id, version: 1, gates: { acceptanceEvidence: { passed: true } } })
  const reviewing = store.transitionDelivery({ id: a.id, version: 2, to: 'preparing' }).delivery
  const nr = store.transitionDelivery({ id: a.id, version: reviewing.version, to: 'needs-review' }).delivery
  assert.equal(nr.state, 'needs-review')
  const abandoned = store.transitionDelivery({ id: a.id, version: nr.version, to: 'abandoned' })
  assert.equal(abandoned.ok, true)
  assert.equal(abandoned.delivery.state, 'abandoned')

  const b = store.createDelivery({ ...base, attemptId: 'A-2', sourceCommit: 'd'.repeat(40) }).delivery
  store.enqueueDelivery({ id: b.id, version: 1, gates: { acceptanceEvidence: { passed: true } } })
  const prep = store.transitionDelivery({ id: b.id, version: 2, to: 'preparing' }).delivery
  const nr2 = store.transitionDelivery({ id: b.id, version: prep.version, to: 'needs-review' }).delivery
  const decision = store.requestDecision({ id: b.id, version: nr2.version, decision: 'rework', decider: 'general', reason: '补测试' })
  assert.equal(decision.ok, true)
  assert.equal(decision.delivery.state, 'ready')
  assert.ok(decision.decisionId)
  const events = store.listIntegrationEvents({ deliveryId: b.id })
  assert.ok(events.some((e) => e.detail_json && e.detail_json.includes('补测试') && e.detail_json.includes('general')))
})

test('TC-S3-06c 重做产生新 Attempt 与新 delivery，旧 integrated 行不被覆盖', () => {
  const { store } = fresh()
  const first = store.createDelivery(base).delivery
  const integrated = store.transitionDelivery({ id: first.id, version: 1, to: 'abandoned' })
  assert.equal(integrated.ok, true)
  const redo = store.createDelivery({ ...base, attemptId: 'A-2', sourceCommit: 'e'.repeat(40) }).delivery
  assert.notEqual(redo.id, first.id)
  assert.equal(redo.attemptId, 'A-2')
  assert.equal(store.getDelivery(first.id).state, 'abandoned')
  assert.equal(store.getDeliveryByTask('T-1').id, redo.id)
})

test('TC-S3-07/08 同仓库同 target ref 同时至多一个活跃 integration job（epoch 租约唯一赢家）', () => {
  const { store } = fresh()
  const d1 = store.createDelivery(base).delivery
  const d2 = store.createDelivery({ ...base, taskId: 'T-2', sourceCommit: 'f'.repeat(40) }).delivery
  const a = store.claimIntegrationJob({ repoId: 'r1', targetRef: 'refs/heads/main', deliveryId: d1.id, owner: 'w1', expectedHead: '1'.repeat(40), leaseEpoch: 1 })
  assert.equal(a.ok, true)
  assert.equal(a.job.state, 'leased')
  const b = store.claimIntegrationJob({ repoId: 'r1', targetRef: 'refs/heads/main', deliveryId: d2.id, owner: 'w2', expectedHead: '1'.repeat(40), leaseEpoch: 1 })
  assert.equal(b.ok, false)
  assert.equal(b.code, 'JOB_CONTENTION')
  assert.equal(b.holder.deliveryId, d1.id)
  const other = store.claimIntegrationJob({ repoId: 'r2', targetRef: 'refs/heads/main', deliveryId: d2.id, owner: 'w2' })
  assert.equal(other.ok, true, '不同仓库互不阻塞')

  const stale = store.transitionIntegrationJob({ id: a.job.id, leaseEpoch: 99, to: 'applying', phase: 'applying' })
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'EPOCH_STALE')
  assert.equal(stale.currentEpoch, 1)

  const adv = store.transitionIntegrationJob({ id: a.job.id, leaseEpoch: 1, to: 'ref-updated', phase: 'ref-updated', gitSha: '2'.repeat(40) })
  assert.equal(adv.ok, true)
  const finalized = store.transitionIntegrationJob({ id: a.job.id, leaseEpoch: 1, to: 'finalized', phase: 'finalized' })
  assert.equal(finalized.ok, true)
  const reusable = store.claimIntegrationJob({ repoId: 'r1', targetRef: 'refs/heads/main', deliveryId: d2.id, owner: 'w3' })
  assert.equal(reusable.ok, true, 'job 完成后释放同一仓库的集成锁')
})

test('数据库唯一约束阻止绕过 store 的并发活跃集成任务', () => {
  const { db, store } = fresh()
  const first = store.claimIntegrationJob({ repoId: 'shared', targetRef: 'refs/heads/main', owner: 'one' })
  assert.equal(first.ok, true)
  assert.throws(() => db.prepare(`INSERT INTO integration_jobs
    (id,repo_id,target_ref,journal_phase,state,lease_epoch,attempts,created_at_ms,updated_at_ms)
    VALUES ('forced','shared','refs/heads/other','prepared','leased',1,0,1,1)`).run())
  assert.equal(store.listIntegrationJobs('shared').length, 1)
})

test('TC-S3-19 integration_events 只追加：每个状态迁移都留下事件', () => {
  const { store } = fresh()
  const d = store.createDelivery(base).delivery
  store.enqueueDelivery({ id: d.id, version: 1, gates: { acceptanceEvidence: { passed: true } }, actor: 'w1' })
  const before = store.listIntegrationEvents({ deliveryId: d.id }).length
  const cur = store.getDelivery(d.id)
  store.transitionDelivery({ id: d.id, version: cur.version, to: 'preparing', actor: 'w2' })
  const after = store.listIntegrationEvents({ deliveryId: d.id })
  assert.equal(after.length, before + 1)
  assert.equal(after[after.length - 1].actor, 'w2')
  assert.equal(after[after.length - 1].from_state, 'ready')
  assert.equal(after[after.length - 1].to_state, 'preparing')
})

test('TC-S3-20 legacy-unknown 迁移不倒推历史 done（不写假成功证据）', () => {
  const { db, store } = fresh()
  db.prepare("INSERT INTO tasks (id, status, scope) VALUES ('T-old','done','default')").run()
  db.prepare("INSERT INTO tasks (id, status, scope) VALUES ('T-new','todo','default')").run()
  const legacy = store.listLegacyUnknownTasks()
  assert.deepEqual(legacy.map((x) => x.taskId), ['T-old'])
  assert.equal(legacy[0].deliveryState, 'legacy-unknown')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_deliveries').get().n, 0, '不得为历史 done 造出集成记录')
})

test('TC-S3-18 未配置验证命令 -> 校验失败且不得标记交付', () => {
  const missing = parseDeliveryConfig({})
  assert.equal(missing.ok, false)
  assert.ok(missing.errors.some((e) => e.includes('targetRef')))
  assert.ok(missing.errors.some((e) => e.includes('verify')))
  assert.equal(hasExecutableVerification(null), false)

  const shell = parseDeliveryConfig({ targetRef: 'refs/heads/main', verify: [{ id: 'v', argv: 'node test.mjs', timeoutMs: 1000 }] })
  assert.equal(shell.ok, false)
  assert.ok(shell.errors.some((e) => e.includes('argv')))

  const empty = parseDeliveryConfig({ targetRef: 'refs/heads/main', verify: [] })
  assert.equal(empty.ok, false)

  const ok = parseDeliveryConfig({ targetRef: 'refs/heads/main', verify: [{ id: 'v', argv: ['node', '--test'], timeoutMs: 1000 }] })
  assert.equal(ok.ok, true)
  assert.equal(hasExecutableVerification(ok.config), true)
  assert.equal(Object.isFrozen(ok.config.verify[0].argv), true)
})

test('TC-S3-06d 词表固定且交付/调度状态互相独立', () => {
  assert.deepEqual([...DELIVERY_STATES], ['awaiting-acceptance', 'ready', 'preparing', 'validating', 'needs-review', 'integrated', 'abandoned'])
  assert.deepEqual([...SCHEDULING_STATES], ['unplanned', 'waiting-file', 'reserved', 'reconciling', 'released'])
  assert.ok(INTEGRATION_JOB_STATES.includes('finalized'))
  assert.equal(SCHEDULING_STATES.includes('integrated'), false)
  assert.equal(DELIVERY_STATES.includes('waiting-file'), false)
})
