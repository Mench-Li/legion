// ============================================================================
// PRT-806 / PRT-812 的判据：数据库与配置备份、保留策略、恢复演练。
//
// 这一组盯的**不是**"备份文件建出来了没有"，而是三件在"备份"这个词下
// 很容易被混成一件的事：
//
//   ① **备份不校验，等于没有备份。** 一份三个月前就坏掉的备份，
//      只有在恢复的那一刻才被发现——而那是最不方便的时刻。
//   ② **保留得不够不是"通过"。** 一台闲置两周的机器上，保留策略的执行结果
//      永远"没有可清理的"，那与"策略满足"是两个读数。
//   ③ **演练失败不算演练过。** 一次"复制了文件但校验失败"的演练，
//      与一次通过的演练，在"能不能恢复"上是相反的两件事。
//
//   > 一个把"演练失败"也算作"演练过了"的新鲜度读数，
//   > 与一个"演练从来没有真正成功过"的读数，是同一个东西——只不过前者是绿的。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BACKUP_CHECKED,
  BACKUP_CODES,
  BACKUP_FORMAT,
  BACKUP_POLICY_DEFAULTS,
  DRILL_DIRNAME,
  applyRetention,
  createSnapshot,
  drillStatus,
  listDrills,
  listSnapshots,
  planRetention,
  restoreDrill,
  restoreSnapshot,
  snapshotId,
} from '../../product/upgrade/backup.mjs'

const DAY = 24 * 60 * 60 * 1000

/** 搭一个"数据目录 + 配置文件"的真实现场。 */
function fixture() {
  const scratch = mkdtempSync(join(tmpdir(), 'legion-backup-'))
  const dataDir = join(scratch, 'data')
  const configPath = join(scratch, 'product.config.json')
  const backupDir = join(scratch, 'backup')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'team.db'), 'SQLITE-DATA-v1', 'utf8')
  writeFileSync(join(dataDir, 'audit.log'), 'line\n', 'utf8')
  writeFileSync(configPath, '{"model":"x"}\n', 'utf8')
  return { scratch, dataDir, configPath, backupDir, cleanup: () => rmSync(scratch, { recursive: true, force: true }) }
}

// ── 备份与可恢复性 ──────────────────────────────────────────────────────────

test('① 一份快照：逐文件摘要被**复算**后落进 snapshot.json', () => {
  const f = fixture()
  try {
    const r = createSnapshot({ backupDir: f.backupDir, dataDir: f.dataDir, configPath: f.configPath, nowMs: 0 })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.snapshot.status, 'complete')
    assert.equal(r.snapshot.format, BACKUP_FORMAT)
    assert.equal(r.snapshot.fileCount, 3)
    assert.equal(r.files.length, 3)
    assert.ok(r.files.every((x) => /^sha256:[0-9a-f]{64}$/.test(x.sha256)), JSON.stringify(r.files))

    const snapshots = listSnapshots(f.backupDir)
    assert.equal(snapshots.length, 1)
    assert.equal(snapshots[0].status, 'complete')
    assert.equal(snapshots[0].totalBytes, r.snapshot.totalBytes)
  } finally { f.cleanup() }
})

test('① ★★ 源一个都不存在时**不建空快照**——空备份不是备份', () => {
  const f = fixture()
  try {
    const r = createSnapshot({
      backupDir: f.backupDir,
      dataDir: join(f.scratch, '不存在'),
      configPath: join(f.scratch, '也不存在.json'),
      nowMs: 0,
    })
    assert.equal(r.ok, false, '源都不存在却报备份成功')
    assert.equal(r.code, BACKUP_CODES.SOURCE_MISSING)
    assert.equal(r.snapshot.status, 'failed')
    // 而且**没有被算进"成功快照"**——保留策略读的是 complete。
    assert.equal(listSnapshots(f.backupDir).filter((s) => s.status === 'complete').length, 0)
  } finally { f.cleanup() }
})

test('① ★ 快照描述丢失或坏掉时，那份目录必须**看得见**（不静默跳过）', () => {
  const f = fixture()
  try {
    createSnapshot({ backupDir: f.backupDir, dataDir: f.dataDir, nowMs: 0 })
    mkdirSync(join(f.backupDir, 'snapshots', '2026-01-01T00-00-00-000Z'), { recursive: true })
    const all = listSnapshots(f.backupDir)
    assert.equal(all.length, 2)
    const unreadable = all.find((s) => s.status === 'unreadable')
    assert.ok(unreadable, JSON.stringify(all))
    assert.equal(unreadable.code, BACKUP_CODES.SNAPSHOT_UNREADABLE)
    // 它**不**算成功快照。
    assert.equal(listSnapshots(f.backupDir).filter((s) => s.status === 'complete').length, 1)
  } finally { f.cleanup() }
})

test('① 恢复：内容与配置都还原，且返回**逐项**落了哪些文件', () => {
  const f = fixture()
  try {
    const r = createSnapshot({ backupDir: f.backupDir, dataDir: f.dataDir, configPath: f.configPath, nowMs: 0 })
    const root = join(f.backupDir, 'snapshots', r.snapshot.id)
    writeFileSync(join(f.dataDir, 'team.db'), '被改坏了', 'utf8')
    const restored = restoreSnapshot(root, { dataDir: f.dataDir, configPath: f.configPath })
    assert.equal(restored.ok, true, restored.reason)
    assert.equal(readFileSync(join(f.dataDir, 'team.db'), 'utf8'), 'SQLITE-DATA-v1')
    assert.equal(readFileSync(f.configPath, 'utf8'), '{"model":"x"}\n')
    assert.equal(restored.restored.length, 3)
    assert.equal(restored.snapshotId, r.snapshot.id)
  } finally { f.cleanup() }
})

test('① ★★ 静默损坏必须在**落盘之前**被抓住：目标目录保持原样', () => {
  const f = fixture()
  try {
    const r = createSnapshot({ backupDir: f.backupDir, dataDir: f.dataDir, nowMs: 0 })
    const root = join(f.backupDir, 'snapshots', r.snapshot.id)
    // 篡改快照里的字节，让它在恢复时对不上账。
    const victim = join(root, 'data', 'team.db')
    writeFileSync(victim, 'SQLITE-DATA-v1-被改了', 'utf8')

    // 目标目录里现在是**新的**数据，恢复失败时不许被覆盖。
    writeFileSync(join(f.dataDir, 'team.db'), 'CURRENT-NEW-DATA', 'utf8')
    const restored = restoreSnapshot(root, { dataDir: f.dataDir })
    assert.equal(restored.ok, false, '损坏的快照被用来恢复成功了')
    assert.equal(restored.code, BACKUP_CODES.SNAPSHOT_CORRUPT)
    assert.equal(restored.restored.length, 0)
    assert.equal(readFileSync(join(f.dataDir, 'team.db'), 'utf8'), 'CURRENT-NEW-DATA',
      '恢复失败却动过了目标目录——那不是任何一个已知状态')
    assert.equal(restored.mismatches[0].path, 'data/team.db')
  } finally { f.cleanup() }
})

test('① ★ 非 `complete` 的快照不许用来恢复；空清单同理', () => {
  const f = fixture()
  try {
    const r = createSnapshot({ backupDir: f.backupDir, dataDir: f.dataDir, nowMs: 0 })
    const root = join(f.backupDir, 'snapshots', r.snapshot.id)
    const meta = JSON.parse(readFileSync(join(root, 'snapshot.json'), 'utf8'))
    writeFileSync(join(root, 'snapshot.json'), JSON.stringify({ ...meta, status: 'partial' }), 'utf8')
    const restored = restoreSnapshot(root, { dataDir: f.dataDir })
    assert.equal(restored.ok, false)
    assert.equal(restored.code, BACKUP_CODES.SNAPSHOT_NOT_COMPLETE)

    writeFileSync(join(root, 'snapshot.json'), JSON.stringify({ ...meta, files: [] }), 'utf8')
    const empty = restoreSnapshot(root, { dataDir: f.dataDir })
    assert.equal(empty.ok, false)
    assert.equal(empty.code, BACKUP_CODES.SNAPSHOT_EMPTY, '空恢复与"恢复成功"没有被分开')
  } finally { f.cleanup() }
})

// ── 保留策略（PRT-812）──────────────────────────────────────────────────────

/** 造一批快照（时间递增），不带真实文件。 */
function fakeSnapshots(specs) {
  return specs.map(([id, ageDays, status = 'complete']) => Object.freeze({
    id, status, createdAtMs: -ageDays * DAY, root: `/fake/${id}`, fileCount: 1, totalBytes: 1,
  }))
}

test('② ★★ 「至少保留最近 3 个成功快照和 30 天，取更大者」是一条**并集**', () => {
  const nowMs = 0
  const snaps = fakeSnapshots([
    ['d1', 1], ['d5', 5], ['d200-a', 202], ['d200-b', 201], ['d200-c', 200],
  ])
  const plan = planRetention(snaps, { nowMs, policy: BACKUP_POLICY_DEFAULTS })
  // 30 天窗口内 2 份 + 按数量补到 3 份 → 共 3 份留下（补的是窗口外**最新**的那份）。
  assert.equal(plan.counts.inWindow, 2)
  assert.equal(plan.counts.retained, 3)
  assert.deepEqual([...plan.keep].sort(), ['d1', 'd200-c', 'd5'])
  assert.ok(plan.keep.includes('d1') && plan.keep.includes('d5'), JSON.stringify(plan.keep))
  assert.ok(plan.keep.includes('d200-c'), '时间窗口外的最新一份没有被按数量补上')
  assert.ok(!plan.keep.includes('d200-a') && !plan.keep.includes('d200-b'), '更旧的快照不该被保留')})

test('② ★★ 保留不够时 `underRetained` 必须为真——"没有可清理的"不是"策略满足"', () => {
  const fresh = fakeSnapshots([['only', 0]])
  const plan = planRetention(fresh, { nowMs: 0 })
  assert.equal(plan.prune.length, 0, '只有一份快照时居然有可清理的')
  assert.equal(plan.underRetained, true, '只有一份快照时被判为保留策略满足')
  assert.ok(plan.underReasons.some((r) => r.includes('3 份')), JSON.stringify(plan.underReasons))
  assert.ok(plan.underReasons.some((r) => r.includes('30 天')), JSON.stringify(plan.underReasons))

  // 而"份数够 + 最旧的够老"时才算满足。
  const mature = fakeSnapshots([['a', 40], ['b', 41], ['c', 42]])
  const okPlan = planRetention(mature, { nowMs: 0 })
  assert.equal(okPlan.underRetained, false, JSON.stringify(okPlan.underReasons))
  assert.equal(okPlan.counts.retained, 3)
})

test('② ★ 非 `complete` 的快照一律不保留（它们恢复不了，留着只会让人以为有备份）', () => {
  const snaps = fakeSnapshots([['good', 1], ['failed', 2, 'failed'], ['unreadable', 3, 'unreadable']])
  const plan = planRetention(snaps, { nowMs: 0 })
  assert.equal(plan.keep.includes('failed'), false)
  assert.equal(plan.keep.includes('unreadable'), false)
  const failedDecision = plan.decisions.find((d) => d.id === 'failed')
  assert.ok(failedDecision.reason.includes('恢复不了'), failedDecision.reason)
})

test('② `applyRetention` 只删计划里的那些目录', () => {
  const f = fixture()
  try {
    createSnapshot({ backupDir: f.backupDir, dataDir: f.dataDir, nowMs: 0 })
    createSnapshot({ backupDir: f.backupDir, dataDir: f.dataDir, nowMs: 1000 })
    const dry = planRetention(listSnapshots(f.backupDir), { nowMs: 2000 })
    const dryRun = applyRetention(f.backupDir, dry, { dryRun: true })
    assert.equal(dryRun.removed.length, dry.prune.length)
    assert.equal(listSnapshots(f.backupDir).length, 2, 'dryRun 真的删了东西')

    const real = applyRetention(f.backupDir, dry)
    assert.equal(real.removed.length, dry.prune.length)
    assert.equal(listSnapshots(f.backupDir).length, dry.keep.length)
  } finally { f.cleanup() }
})

// ── 恢复演练（PRT-812）──────────────────────────────────────────────────────

test('③ ★★ 演练：恢复到一个**临时**目录，校验回调说了算', () => {
  const f = fixture()
  try {
    createSnapshot({ backupDir: f.backupDir, dataDir: f.dataDir, configPath: f.configPath, nowMs: 0 })
    let sawDataDir = null
    const drill = restoreDrill({
      backupDir: f.backupDir,
      scratchDir: join(f.scratch, 'drill-scratch'),
      nowMs: 1000,
      verify: ({ dataDir }) => {
        sawDataDir = dataDir
        return { ok: readFileSync(join(dataDir, 'team.db'), 'utf8') === 'SQLITE-DATA-v1', detail: '能打开' }
      },
    })
    assert.equal(drill.ok, true, drill.reason)
    assert.equal(drill.outcome, 'ok')
    // 演练**没有**碰真实数据目录。
    assert.equal(sawDataDir.startsWith(f.dataDir), false, '演练恢复了真实数据目录')
    assert.equal(readFileSync(join(f.dataDir, 'team.db'), 'utf8'), 'SQLITE-DATA-v1')
    // 而它留下了一条记录。
    const drills = listDrills(f.backupDir)
    assert.equal(drills.length, 1)
    assert.equal(drills[0].outcome, 'ok')
    assert.equal(drills[0].snapshotId, drill.record.snapshotId)
  } finally { f.cleanup() }
})

test('③ ★★ 校验回调说不行，演练就是失败——而它必须被记成失败', () => {
  const f = fixture()
  try {
    const snap = createSnapshot({ backupDir: f.backupDir, dataDir: f.dataDir, nowMs: 0 })
    const drill = restoreDrill({
      backupDir: f.backupDir,
      scratchDir: join(f.scratch, 'drill-scratch'),
      nowMs: 1000,
      snapshotId: snap.snapshot.id,
      verify: () => ({ ok: false, detail: '恢复出来的库打不开' }),
    })
    assert.equal(drill.ok, false)
    assert.equal(drill.outcome, 'verify-failed')
    assert.equal(drill.record.detail, '恢复出来的库打不开')

    // ★ 关键：这条失败记录**不**让"新鲜度"看起来是新鲜的。
    const status = drillStatus(f.backupDir, { nowMs: 1000 })
    assert.equal(status.totalDrills, 1)
    assert.equal(status.succeededDrills, 0)
    assert.equal(status.stale, true, '唯一一次演练失败了，新鲜度却报"不需要演练"')
    assert.ok(status.reasons[0].includes('没有一次成功'), status.reasons[0])
  } finally { f.cleanup() }
})

test('③ ★ 校验回调抛错 = 失败；没有回调直接拒（没有校验的演练只会报"复制成功"）', () => {
  const f = fixture()
  try {
    createSnapshot({ backupDir: f.backupDir, dataDir: f.dataDir, nowMs: 0 })
    const snap = listSnapshots(f.backupDir)[0]
    const threw = restoreDrill({
      backupDir: f.backupDir, scratchDir: join(f.scratch, 's1'), nowMs: 1, snapshotId: snap.id,
      verify: () => { throw new Error('数据库文件被锁') },
    })
    assert.equal(threw.ok, false)
    assert.equal(threw.record.outcome, 'verify-failed')
    assert.ok(threw.record.detail.includes('被锁'), threw.record.detail)

    assert.throws(
      () => restoreDrill({ backupDir: f.backupDir, scratchDir: join(f.scratch, 's2'), nowMs: 2, snapshotId: snap.id }),
      (e) => { assert.equal(e.code, 'backup-drill-verify-required'); return true },
    )
  } finally { f.cleanup() }
})

test('③ ★★ 没有任何快照时的演练是 `no-snapshot`，且它**留下记录**（否则没人知道为什么没演练）', () => {
  const f = fixture()
  try {
    const drill = restoreDrill({
      backupDir: f.backupDir, scratchDir: join(f.scratch, 's'), nowMs: 5,
      verify: () => ({ ok: true }),
    })
    assert.equal(drill.ok, false)
    assert.equal(drill.outcome, 'no-snapshot')
    assert.equal(listDrills(f.backupDir).length, 1)
    assert.equal(listDrills(f.backupDir)[0].outcome, 'no-snapshot')
  } finally { f.cleanup() }
})

test('③ ★★ 快照损坏时演练报 `restore-failed`（不是 ok）', () => {
  const f = fixture()
  try {
    const r = createSnapshot({ backupDir: f.backupDir, dataDir: f.dataDir, nowMs: 0 })
    writeFileSync(join(f.backupDir, 'snapshots', r.snapshot.id, 'data', 'team.db'), '坏了', 'utf8')
    const drill = restoreDrill({
      backupDir: f.backupDir, scratchDir: join(f.scratch, 's'), nowMs: 1,
      snapshotId: r.snapshot.id,
      verify: () => ({ ok: true }),
    })
    assert.equal(drill.ok, false)
    assert.equal(drill.outcome, 'restore-failed')
  } finally { f.cleanup() }
})

test('③ ★★ 演练新鲜度：从没有记录 → stale；成功过且在窗口内 → 不 stale；过期 → stale', () => {
  const f = fixture()
  try {
    assert.equal(drillStatus(f.backupDir, { nowMs: 0 }).stale, true, '从来没有演练却报"不需要演练"')
    assert.ok(drillStatus(f.backupDir, { nowMs: 0 }).reasons[0].includes('从来没有'))

    createSnapshot({ backupDir: f.backupDir, dataDir: f.dataDir, nowMs: 0 })
    const snap = listSnapshots(f.backupDir)[0]
    restoreDrill({
      backupDir: f.backupDir, scratchDir: join(f.scratch, 's'),
      nowMs: 0, snapshotId: snap.id, verify: () => ({ ok: true }),
    })

    const fresh = drillStatus(f.backupDir, { nowMs: 30 * DAY })
    assert.equal(fresh.stale, false, JSON.stringify(fresh.reasons))
    assert.equal(fresh.lastSuccessAtMs, 0)
    assert.equal(fresh.dueAtMs, BACKUP_POLICY_DEFAULTS.drillIntervalDays * DAY)

    const overdue = drillStatus(f.backupDir, { nowMs: 91 * DAY })
    assert.equal(overdue.stale, true)
    assert.ok(overdue.reasons[0].includes('已超过'), overdue.reasons[0])
  } finally { f.cleanup() }
})

test('③ 演练记录目录名固定为 drills/，时间戳文件名在 Windows 上合法', () => {
  assert.equal(DRILL_DIRNAME, 'drills')
  assert.equal(snapshotId(Date.UTC(2026, 0, 2, 3, 4, 5)), '2026-01-02T03-04-05-000Z')
  assert.equal(/[:.]/.test(snapshotId(Date.now())), false, '时间戳文件名里出现了 Windows 不允许的字符')
})

// ── ④ 恢复时的 WAL/shm（PRT-809 的前置纪律，PRT-006 已定） ──────────────────

test('④ ★★ 恢复前删掉 `-wal` / `-shm`：不删就是把两个时刻的数据库合并', () => {
  const f = fixture()
  try {
    const made = createSnapshot({ backupDir: f.backupDir, dataDir: f.dataDir, configPath: f.configPath, nowMs: 0 })
    const snapshotRoot = join(f.backupDir, 'snapshots', made.snapshot.id)

    // 升级期间 SQLite 产生的两个旁挂文件：它们属于**将被替换掉**的那个 .db。
    writeFileSync(join(f.dataDir, 'team.db-wal'), 'WAL-升级期间的提交', 'utf8')
    writeFileSync(join(f.dataDir, 'team.db-shm'), 'SHM', 'utf8')
    // 主库也被升级改过了 —— 恢复要把它换回备份时刻的内容。
    writeFileSync(join(f.dataDir, 'team.db'), 'SQLITE-DATA-v2', 'utf8')

    const r = restoreSnapshot(snapshotRoot, { dataDir: f.dataDir, configPath: f.configPath })
    assert.equal(r.ok, true, r.reason)
    assert.equal(readFileSync(join(f.dataDir, 'team.db'), 'utf8'), 'SQLITE-DATA-v1')
    // ★ 两个旁挂文件必须没了：留着它们，下一次打开会把升级期间的 WAL
    //   重放到旧主库上，得到一个"能打开但不是任何一个已知时刻"的库。
    assert.equal(existsSync(join(f.dataDir, 'team.db-wal')), false, '恢复后 -wal 还在，它会被重放到旧库上')
    assert.equal(existsSync(join(f.dataDir, 'team.db-shm')), false, '恢复后 -shm 还在')
    // 删了什么必须说出来：这是排障时唯一能解释"升级期间的写入去哪了"的证据。
    assert.deepEqual([...r.sidecarsRemoved].map((x) => x.path.split(/[\\/]/).pop()), ['team.db-wal', 'team.db-shm'])
  } finally { f.cleanup() }
})

test('④ ★★ 没有旁挂文件时 `sidecarsRemoved` 是**空数组**，不是 undefined（"没检查"与"没删到"要分开）', () => {
  const f = fixture()
  try {
    const made = createSnapshot({ backupDir: f.backupDir, dataDir: f.dataDir, configPath: f.configPath, nowMs: 0 })
    const r = restoreSnapshot(join(f.backupDir, 'snapshots', made.snapshot.id), {
      dataDir: f.dataDir, configPath: f.configPath,
    })
    assert.equal(r.ok, true)
    assert.deepEqual([...r.sidecarsRemoved], [])
  } finally { f.cleanup() }
})

test('④ ★★ 不是 `.db` 的同名旁挂文件不动（`audit.log-wal` 不是 SQLite 的东西）', () => {
  const f = fixture()
  try {
    const made = createSnapshot({ backupDir: f.backupDir, dataDir: f.dataDir, configPath: f.configPath, nowMs: 0 })
    writeFileSync(join(f.dataDir, 'audit.log-wal'), '不归 SQLite 管', 'utf8')
    const r = restoreSnapshot(join(f.backupDir, 'snapshots', made.snapshot.id), {
      dataDir: f.dataDir, configPath: f.configPath,
    })
    assert.equal(r.ok, true)
    assert.equal(existsSync(join(f.dataDir, 'audit.log-wal')), true, '把非 .db 的同名文件也删了')
    assert.deepEqual([...r.sidecarsRemoved], [])
  } finally { f.cleanup() }
})

// ── ⑤ 装载期自检 ────────────────────────────────────────────────────────────

test('⑤ ★★ 装载期自检留下算出来的值，且每一格的**两侧**都真的跑过', () => {
  assert.deepEqual([...BACKUP_CHECKED.problems], [])
  assert.equal(BACKUP_CHECKED.ok, true)
  const s = BACKUP_CHECKED.samples
  // 负数格：源不存在必须拒绝；快照被改过必须报 corrupt。
  assert.equal(s.emptySnapshotOk, false)
  assert.equal(s.emptySnapshotCode, BACKUP_CODES.SOURCE_MISSING)
  assert.equal(s.corruptRestoreCode, BACKUP_CODES.SNAPSHOT_CORRUPT)
  // 正数格：恢复出来的确实是快照时刻的内容，且 -wal 真的被删了。
  assert.equal(s.restoredContent, 'SELF-CHECK-V1')
  assert.equal(s.sidecarsRemoved, 1)
  // 保留与演练新鲜度各自的两侧。
  assert.equal(s.thinUnderRetained, true)
  assert.equal(s.richUnderRetained, false)
  assert.equal(s.failedOnlyStale, true)
  assert.equal(s.failedOnlySucceeded, 0)
  assert.equal(s.afterSuccessStale, false)
})
