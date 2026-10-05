// product/update/recovery.test.mjs
// ============================================================================
// 数据备份恢复入口的判据（设计 §8 line 190 与 line 192）
//
// 这一组用**真的快照目录、真的数据目录、真的事务日志文件**驱动，因为
// 这个模块的全部风险都在"读盘上的证据、然后决定要不要动别人的数据"上：
// 一个用替身喂出来的结论，恰好证明不了它读的是哪一份盘。
//
// 三条纪律各有一组判据：
//   ① `needs-confirmation` 档**没有确认就一个字节都不写**（line 192 的"取得
//      用户确认"必须能在代码里看见，而不是靠调用方自觉）；
//   ② `refused` 档**确认也打不开**（坏备份恢复出来的不是旧数据）；
//   ③ 目标只能是快照自己的数据目录（"恢复到别处"会静默覆盖另一个部署）。
// ============================================================================

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { acquireBarrier } from './barrier.mjs'
import { createJournal } from './journal.mjs'
import {
  RECOVERY_CODES, RECOVERY_SAFETY, barrierProvedBeforeBackup, classifySnapshotSafety,
  planRecoveryFromBackups, restoreFromBackup,
} from './recovery.mjs'
import { BACKUP_CODES, createSnapshot } from '../upgrade/backup.mjs'

const NOW = Date.parse('2026-10-05T12:00:00Z')

/**
 * 造一个真实的小部署：dataDir 下有数据文件与 product.config.json，
 * 备份目录在 dataDir/backups（与 `paths.backupDir` 的约定一致）。
 */
function setup(t, { includeConfig = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'legion-recovery-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dataDir = join(root, 'data')
  mkdirSync(join(dataDir, 'team-hub'), { recursive: true })
  writeFileSync(join(dataDir, 'team-hub', 'team.db'), 'ORIGINAL-DB-CONTENT')
  writeFileSync(join(dataDir, 'team-hub', 'extra.json'), '{"v":1}')
  const configPath = includeConfig ? join(root, 'product.config.json') : null
  if (includeConfig) writeFileSync(configPath, '{"ports":{}}')
  const backupDir = join(dataDir, 'backups')
  return { root, dataDir, configPath, backupDir }
}

/** 在 setup 的部署上取一份真快照，返回快照 id。 */
function takeSnapshot(ctx, label = 'pre-update') {
  const made = createSnapshot({
    backupDir: ctx.backupDir, dataDir: ctx.dataDir, configPath: ctx.configPath,
    nowMs: NOW, label,
  })
  assert.equal(made.ok, true, made.reason ?? '')
  return made.snapshot.id
}

/** 写一份真实的日志，记录"屏障先立、然后备份"。 */
function journalWithBarrierBeforeBackup(ctx, { txnId = 'txn-1', commit = false, phase = null } = {}) {
  const journal = createJournal({ dataDir: ctx.dataDir, txnId, now: () => NOW })
  journal.begin({ fromVersion: '1.0.0', toVersion: '1.1.0', phase: 'barrier' })
  journal.intent('barrier-acquire', { txnId })
  acquireBarrier({ dataDir: ctx.dataDir, txnId, now: () => NOW })
  journal.result('barrier-acquire', { ok: true, reason: '测试' })
  journal.intent('backup', { backupDir: ctx.backupDir })
  journal.result('backup', { ok: true, snapshotId: 'x' })
  if (commit) journal.finish('committed', '测试提交')
  else if (phase !== null) journal.advance(phase, '测试')
  return journal
}

// ---------------------------------------------------------------------------
// ① 列出候选（零副作用）
// ---------------------------------------------------------------------------

test('plan：没有备份目录时是"没有可恢复的"而不是错误（并且说清为什么）', (t) => {
  const ctx = setup(t)
  const plan = planRecoveryFromBackups({ dataDir: ctx.dataDir, backupDir: ctx.backupDir })
  assert.equal(plan.ok, true)
  assert.equal(plan.code, RECOVERY_CODES.NO_BACKUP_DIR)
  assert.deepEqual(plan.candidates, [])
  assert.match(plan.reason, /从来没有成功备份过/)
})

test('plan：列出真快照，并给出安全性档位与理由', (t) => {
  const ctx = setup(t)
  const id = takeSnapshot(ctx)
  const plan = planRecoveryFromBackups({ dataDir: ctx.dataDir, backupDir: ctx.backupDir })
  assert.equal(plan.ok, true)
  assert.equal(plan.candidates.length, 1)
  const c = plan.candidates[0]
  assert.equal(c.id, id)
  assert.equal(c.status, 'complete')
  assert.equal(RECOVERY_SAFETY.includes(c.safety), true, `未知的档位 ${c.safety}`)
  assert.equal(typeof c.reason, 'string')
  assert.ok(c.reason.length > 0, '档位必须带一句能读的理由')
  // 没有任何事务证据 → 保守落到"要问"。
  assert.equal(c.safety, 'needs-confirmation')
  assert.equal(c.requiresConfirmation, true)
})

test('plan：不完整的快照被列为 refused，且不计入"可恢复"', (t) => {
  const ctx = setup(t)
  takeSnapshot(ctx, 'good')
  // 手工造一份"写了一半"的快照，模拟断电。
  const brokenRoot = join(ctx.backupDir, 'snapshots', '2026-10-05T00-00-00-000Z-broken')
  mkdirSync(brokenRoot, { recursive: true })
  writeFileSync(join(brokenRoot, 'snapshot.json'), JSON.stringify({
    format: 'legion/backup@1', id: 'broken', status: 'failed', createdAtMs: NOW, label: '断电',
    dataDir: ctx.dataDir, configPath: ctx.configPath, files: [{ path: 'data/team-hub/team.db', sha256: 'x', size: 1 }],
  }))
  const plan = planRecoveryFromBackups({ dataDir: ctx.dataDir, backupDir: ctx.backupDir })
  assert.equal(plan.candidates.length, 2)
  const broken = plan.candidates.find((c) => c.id === 'broken')
  assert.equal(broken.safety, 'refused')
  assert.equal(broken.requiresConfirmation, false, 'refused 档不该说"确认就能恢复"')
  assert.equal(plan.restorableCount, 1)
})

// ---------------------------------------------------------------------------
// ② 三档判据（直接问分类函数，边界更清楚）
// ---------------------------------------------------------------------------

test('分类：未提交 + 屏障已证明 → safe-automatic（line 192 允许自动恢复的唯一一档）', (t) => {
  const ctx = setup(t)
  takeSnapshot(ctx)
  journalWithBarrierBeforeBackup(ctx, { phase: 'migrate' })
  const plan = planRecoveryFromBackups({ dataDir: ctx.dataDir, backupDir: ctx.backupDir })
  const c = plan.candidates[0]
  assert.equal(c.safety, 'safe-automatic', c.reason)
  assert.equal(c.requiresConfirmation, false)
  assert.equal(plan.hasSafeAutomatic, true)
  assert.match(c.reason, /屏障在备份之前建立/)
})

test('分类：事务已提交 → needs-confirmation（恢复会丢提交后的新写入）', (t) => {
  const ctx = setup(t)
  takeSnapshot(ctx)
  journalWithBarrierBeforeBackup(ctx, { commit: true })
  const plan = planRecoveryFromBackups({ dataDir: ctx.dataDir, backupDir: ctx.backupDir })
  const c = plan.candidates[0]
  assert.equal(c.safety, 'needs-confirmation')
  assert.equal(c.requiresConfirmation, true)
  assert.match(c.reason, /已经提交/)
  assert.match(c.reason, /新写入/)
})

test('分类：屏障只有 intent 没有 result → **不算证明**，落到要问', (t) => {
  // 这一条守的是"证明"的严格性：`intent` 只说明"打算立屏障"，不说明立成了。
  // 而那次写盘没完成时，"备份期间没有业务写入"并没有被证明。
  const proof = barrierProvedBeforeBackup({
    records: [
      { kind: 'intent', action: 'barrier-acquire' },
      { kind: 'result', action: 'backup', detail: { ok: true } },
    ],
  })
  assert.equal(proof.proved, false)
  assert.match(proof.reason, /没有"维护屏障已建立"的完成记录/)
  const verdict = classifySnapshotSafety({
    snapshot: { id: 's', status: 'complete' },
    journal: { records: [], active: { txnId: 't', phase: 'migrate' } },
  })
  assert.equal(verdict.safety, 'needs-confirmation')
})

// ---------------------------------------------------------------------------
// ③ 恢复的三条纪律
// ---------------------------------------------------------------------------

test('★★★ 恢复：要确认的档位**没有确认就一个字节都不写**', (t) => {
  const ctx = setup(t)
  const id = takeSnapshot(ctx, 'pre-update')
  journalWithBarrierBeforeBackup(ctx, { commit: true })
  // 快照之后数据库被改过（提交后的新写入）。
  writeFileSync(join(ctx.dataDir, 'team-hub', 'team.db'), 'NEW-COMMITTED-CONTENT')
  writeFileSync(join(ctx.dataDir, 'team-hub', 'brand-new.json'), '{"created":"after-commit"}')

  const refused = restoreFromBackup({
    dataDir: ctx.dataDir, configPath: ctx.configPath, backupDir: ctx.backupDir, snapshotId: id,
  })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, RECOVERY_CODES.CONFIRMATION_REQUIRED)
  assert.equal(refused.requiresConfirmation, true)
  assert.match(refused.reason, /本次没有写入任何文件/)
  // ★ 核心断言：盘上的东西一个都没变。
  assert.equal(readFileSync(join(ctx.dataDir, 'team-hub', 'team.db'), 'utf8'), 'NEW-COMMITTED-CONTENT',
    '没有确认的恢复动了数据库')
  assert.equal(readFileSync(join(ctx.dataDir, 'team-hub', 'brand-new.json'), 'utf8'), '{"created":"after-commit"}',
    '没有确认的恢复删/改了提交后的新文件')

  // 给了确认才真的恢复（否则上面那条只是"谁都恢复不了"）。
  const done = restoreFromBackup({
    dataDir: ctx.dataDir, configPath: ctx.configPath, backupDir: ctx.backupDir, snapshotId: id, confirm: true,
  })
  assert.equal(done.ok, true, done.reason ?? '')
  assert.equal(done.code, RECOVERY_CODES.RESTORED)
  assert.equal(readFileSync(join(ctx.dataDir, 'team-hub', 'team.db'), 'utf8'), 'ORIGINAL-DB-CONTENT',
    '确认之后没有真的恢复')
})

test('★★★ 恢复：refused 档**确认也打不开**（坏备份恢复出来不是旧数据）', (t) => {
  const ctx = setup(t)
  const brokenRoot = join(ctx.backupDir, 'snapshots', '2026-10-05T00-00-00-000Z-broken')
  mkdirSync(brokenRoot, { recursive: true })
  writeFileSync(join(brokenRoot, 'snapshot.json'), JSON.stringify({
    format: 'legion/backup@1', id: 'broken', status: 'failed', createdAtMs: NOW,
    dataDir: ctx.dataDir, configPath: ctx.configPath, files: [{ path: 'data/team-hub/team.db', sha256: 'x', size: 1 }],
  }))
  for (const confirm of [false, true]) {
    const r = restoreFromBackup({
      dataDir: ctx.dataDir, configPath: ctx.configPath, backupDir: ctx.backupDir,
      snapshotId: 'broken', confirm,
    })
    assert.equal(r.ok, false, `confirm=${confirm} 时坏快照被恢复了`)
    assert.match(r.reason, /确认不能改变这一点/)
    assert.equal(readFileSync(join(ctx.dataDir, 'team-hub', 'team.db'), 'utf8'), 'ORIGINAL-DB-CONTENT')
  }
})

test('★★ 恢复：safe-automatic 档不需要确认（line 192 允许自动恢复的那一档）', (t) => {
  const ctx = setup(t)
  const id = takeSnapshot(ctx)
  journalWithBarrierBeforeBackup(ctx, { phase: 'migrate' })
  const r = restoreFromBackup({
    dataDir: ctx.dataDir, configPath: ctx.configPath, backupDir: ctx.backupDir, snapshotId: id,
  })
  assert.equal(r.ok, true, r.reason ?? '')
  assert.equal(r.safety, 'safe-automatic')
  assert.equal(r.requiresConfirmationWas, false)
  assert.equal(readFileSync(join(ctx.dataDir, 'team-hub', 'team.db'), 'utf8'), 'ORIGINAL-DB-CONTENT')
})

test('★★★ 恢复：**不能恢复到别的数据目录**（会静默覆盖另一个部署）', (t) => {
  const ctx = setup(t)
  const id = takeSnapshot(ctx)
  // 另一个部署的数据目录：它自己有一份不同的数据。
  const otherData = join(ctx.root, 'other-deploy-data')
  mkdirSync(join(otherData, 'team-hub'), { recursive: true })
  writeFileSync(join(otherData, 'team-hub', 'team.db'), 'OTHER-DEPLOY-DB')

  const r = restoreFromBackup({
    dataDir: otherData, configPath: null, backupDir: ctx.backupDir, snapshotId: id, confirm: true,
  })
  assert.equal(r.ok, false)
  assert.equal(r.code, RECOVERY_CODES.RESTORE_FAILED)
  assert.match(r.reason, /不是同一个数据目录|只能回到它自己的来源/)
  assert.equal(readFileSync(join(otherData, 'team-hub', 'team.db'), 'utf8'), 'OTHER-DEPLOY-DB',
    '恢复把另一个部署的数据覆盖了')
})

test('★ 恢复：找不到指定的快照时明确拒绝，并列出有哪些', (t) => {
  const ctx = setup(t)
  const id = takeSnapshot(ctx)
  const r = restoreFromBackup({
    dataDir: ctx.dataDir, configPath: ctx.configPath, backupDir: ctx.backupDir,
    snapshotId: 'no-such-snapshot', confirm: true,
  })
  assert.equal(r.ok, false)
  assert.equal(r.code, RECOVERY_CODES.SNAPSHOT_NOT_FOUND)
  assert.match(r.reason, new RegExp(id))
})

test('★★ 恢复：底层对账失败时**不谎报成功**，并且如实带出原因', (t) => {
  const ctx = setup(t)
  const id = takeSnapshot(ctx)
  journalWithBarrierBeforeBackup(ctx, { phase: 'migrate' })
  // 篡改快照里的数据文件：逐文件对账必须发现它。
  const snapshotDb = join(ctx.backupDir, 'snapshots', id, 'data', 'team-hub', 'team.db')
  writeFileSync(snapshotDb, 'TAMPERED-SNAPSHOT-CONTENT')
  const r = restoreFromBackup({
    dataDir: ctx.dataDir, configPath: ctx.configPath, backupDir: ctx.backupDir, snapshotId: id,
  })
  assert.equal(r.ok, false)
  assert.equal(r.code, RECOVERY_CODES.RESTORE_FAILED)
  assert.match(r.reason, /对不上|恢复失败/)
  assert.equal(readFileSync(join(ctx.dataDir, 'team-hub', 'team.db'), 'utf8'), 'ORIGINAL-DB-CONTENT',
    '对账失败却动了数据目录')
})

test('★★ 恢复：**工作空间不在写入路径上**（line 192 的"永远不作为目标"）', (t) => {
  const ctx = setup(t)
  const id = takeSnapshot(ctx)
  journalWithBarrierBeforeBackup(ctx, { phase: 'migrate' })
  // 一个"工作空间"，里面有一份用户文件；恢复的目标参数里根本没有它。
  const workspace = join(ctx.root, 'workspace')
  mkdirSync(join(workspace, 'notes'), { recursive: true })
  writeFileSync(join(workspace, 'notes', 'mine.md'), 'USER WORK')
  const before = readdirSync(join(workspace, 'notes'))

  const r = restoreFromBackup({
    dataDir: ctx.dataDir, configPath: ctx.configPath, backupDir: ctx.backupDir, snapshotId: id,
  })
  assert.equal(r.ok, true, r.reason ?? '')
  // 恢复写过的每一个路径都必须在 dataDir 或 configPath 之下。
  const allowed = [ctx.dataDir, ctx.configPath].filter((p) => typeof p === 'string')
  for (const item of r.restored) {
    const p = typeof item === 'string' ? item : item?.path
    assert.equal(typeof p, 'string', `恢复读数里有一个说不出来路的条目：${JSON.stringify(item)}`)
    assert.equal(allowed.some((a) => p.startsWith(a)),
      true, `恢复写了 ${p}，它既不在数据目录也不在配置路径下`)
    assert.equal(p.startsWith(workspace), false, `恢复写了工作空间里的 ${p}`)
  }
  assert.deepEqual(readdirSync(join(workspace, 'notes')), before)
  assert.equal(readFileSync(join(workspace, 'notes', 'mine.md'), 'utf8'), 'USER WORK')
})

test('恢复：配置文件的恢复也接上了（不只是数据库）', (t) => {
  const ctx = setup(t)
  const id = takeSnapshot(ctx)
  journalWithBarrierBeforeBackup(ctx, { phase: 'migrate' })
  writeFileSync(ctx.configPath, '{"ports":{"changed":true}}')
  const r = restoreFromBackup({
    dataDir: ctx.dataDir, configPath: ctx.configPath, backupDir: ctx.backupDir, snapshotId: id,
  })
  assert.equal(r.ok, true, r.reason ?? '')
  assert.equal(readFileSync(ctx.configPath, 'utf8'), '{"ports":{}}', '配置没有被恢复')
})

test('BACKUP_CODES 与恢复模块的错误码不冲突（两层的码要能分开）', () => {
  const overlap = Object.values(RECOVERY_CODES).filter((c) => Object.values(BACKUP_CODES).includes(c))
  assert.deepEqual(overlap, [], `恢复层与备份层复用了同一个码：${overlap.join(', ')}`)
})

test('★★ plan 的所有出口返回**同一个形状**（少给字段会在读它的那一侧炸掉）', (t) => {
  // ★ 这条是一个真实崩溃换来的：早先"没有备份目录"那条出口少给了
  //   `activeTransaction` / `barrierHeld` / `restorableCount`，于是 CLI 的
  //   渲染器读 `plan.activeTransaction.txnId` 时炸在**另一条**分支上——
  //   而那恰恰是"一台还没升级过的机器"会走的路。
  //
  //   > 一个"某个分支少给几个字段"的返回值，
  //   > 会在**读它的那一侧**变成一个看起来与这个分支无关的崩溃。
  const required = ['ok', 'code', 'backupDir', 'candidates', 'restorableCount',
    'hasSafeAutomatic', 'activeTransaction', 'barrierHeld', 'reason']
  const cases = []

  // ① 没有 dataDir（调用错误）
  cases.push(['缺 dataDir', planRecoveryFromBackups({})])
  // ② 没有备份目录（这台机器从来没备份过）
  const bare = setup(t)
  cases.push(['没有备份目录', planRecoveryFromBackups({ dataDir: bare.dataDir, backupDir: bare.backupDir })])
  // ③ 有快照、有事务
  const full = setup(t)
  takeSnapshot(full)
  journalWithBarrierBeforeBackup(full, { phase: 'migrate' })
  cases.push(['有快照', planRecoveryFromBackups({ dataDir: full.dataDir, backupDir: full.backupDir })])

  for (const [label, plan] of cases) {
    for (const key of required) {
      assert.equal(key in plan, true, `「${label}」这条出口少了字段 ${key}`)
    }
    assert.equal(Array.isArray(plan.candidates), true, `「${label}」的 candidates 不是数组`)
    assert.equal(typeof plan.restorableCount, 'number', `「${label}」的 restorableCount 不是数字`)
    assert.equal(typeof plan.hasSafeAutomatic, 'boolean', `「${label}」的 hasSafeAutomatic 不是布尔`)
    assert.equal(typeof plan.barrierHeld, 'boolean', `「${label}」的 barrierHeld 不是布尔`)
    // 没有事务时必须是 `null`（不是 `undefined`）——两者的区别只会在读它的
    // 那一侧变成一个 TypeError。
    if (plan.activeTransaction !== null) {
      assert.equal(typeof plan.activeTransaction.txnId, 'string', `「${label}」的事务没有 txnId`)
    }
  }
})
