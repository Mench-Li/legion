// ============================================================================
// 阶段 8 的完成标准（spec line 980）的可执行形式：
//
//   「模拟下载损坏、迁移失败、DSH 启动失败和健康检查失败时，系统能恢复到
//     **已知兼容状态**且**业务数据不丢失**。」
//
// 这一组是阶段 8 唯一真正重要的那组用例。它盯的**不是**编排有没有返回值，
// 而是**四个失败点各自的落点是不是"已知兼容"**：
//
//   ① 下载损坏   —— 什么都没动过 → 旧版本照常跑 → 兼容，数据未动；
//   ② 迁移失败   —— 程序换了、库跑过一部分 → 必须**真的退回**
//                   （指针换回去 + 库按可回滚性处置）；
//   ③ 启动失败   —— 新版本进程起不来（探针 ECONNREFUSED）；
//   ④ 健康检查失败 —— 新版本起来了但不健康（探针答了但答的是"不行"）。
//
// ③ 与 ④ 是**两件事**：一个的处置是"程序有 bug"，另一个的处置是"配置或依赖
// 没就位"。把它们压成一档的实现，会在排障时给出同一个建议。
//
//   > 一个把"没有升级成功"一律算作"系统处于未知状态"的判定，
//   > 与一个"每次下载抖动都要人工介入"的流程，是同一个东西。
//
// 还有第五条：一次 **contract 迁移之后**的失败，回滚不再是"换指针"能解决的。
// 那时候"恢复到已知兼容状态"只剩一条路——从升级前备份恢复数据库——而它会
// 丢掉备份之后的写入。本组用例把这条路也真的走一遍，并验数据确实回到了
// 备份时刻的内容。**数据不丢失**在那一档上是"丢多少说得清"，不是"没丢"。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ORCHESTRATOR_CHECKED,
  RESULT_BY_VERDICT,
  UPGRADE_CODES,
  UPGRADE_STAGES,
  UPGRADE_VERDICTS,
  checkMigrationPlanRollback,
  dataSafetyOf,
  ensureUpgradeDirs,
  rollbackWithBackupRestore,
  runUpgrade,
  writeReleaseNotesFile,
} from '../../product/upgrade/index.mjs'
import { listUpgradeRecords } from '../../product/upgrade/audit.mjs'
import { listSnapshots } from '../../product/upgrade/backup.mjs'
import { createManifest } from '../../product/upgrade/manifest.mjs'
import {
  buildPackage, generateSigningKeyPair, hashBytes, signPackage,
} from '../../product/upgrade/package.mjs'
import { createMemoryMigrationStore, defineMigration } from '../../product/upgrade/migration.mjs'
import { activateVersion, readActivePointer } from '../../product/upgrade/switchover.mjs'

const OLD_VERSION = '0.8.0'
const NEW_VERSION = '0.9.0'

const OLD_MANIFEST = createManifest({
  productVersion: OLD_VERSION, legionVersion: OLD_VERSION, dshVersion: '0.8.2',
  dshCompositionPatchVersion: 1, schemaVersion: 11, runtimeContractVersion: 1,
  packProtocolVersion: 1, channel: 'stable',
})
const NEW_MANIFEST = createManifest({
  productVersion: NEW_VERSION, legionVersion: NEW_VERSION, dshVersion: '0.8.3',
  dshCompositionPatchVersion: 2, schemaVersion: 12, runtimeContractVersion: 1,
  packProtocolVersion: 1, channel: 'stable',
})

const PACKAGE_CONTENTS = Object.freeze({
  'runtime.mjs': 'export const v = 1\n',
  'dsh-composition/patch-layer.mjs': 'export const patch = 1\n',
})

/**
 * 一个完整的现场：装好两个版本、指针指向旧版本、有一份数据目录与配置、
 * 一份签名过的升级包。
 */
function site({ extraData = {}, noBackupDir = false, noAuditDir = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'legion-orch-'))
  const installDir = join(root, 'install')
  const dataDir = join(root, 'data')
  const configPath = join(root, 'product.config.json')
  const backupDir = noBackupDir ? undefined : join(root, 'backup')
  const auditDir = noAuditDir ? undefined : join(root, 'audit')

  for (const v of [OLD_VERSION, NEW_VERSION]) {
    mkdirSync(join(installDir, 'versions', v), { recursive: true })
    writeFileSync(join(installDir, 'versions', v, 'runtime.mjs'), `export const version = '${v}'\n`, 'utf8')
  }
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'team.db'), 'SQLITE-DATA-v1', 'utf8')
  writeFileSync(join(dataDir, 'audit.log'), 'line-1\n', 'utf8')
  for (const [name, body] of Object.entries(extraData)) writeFileSync(join(dataDir, name), body, 'utf8')
  writeFileSync(configPath, '{"model":"x"}', 'utf8')
  activateVersion(installDir, OLD_VERSION, { nowMs: 1 })

  const keys = generateSigningKeyPair()
  const manifestDigest = hashBytes(Buffer.from(JSON.stringify(NEW_MANIFEST), 'utf8'))
  const built = buildPackage({ productId: 'legion', manifest: NEW_MANIFEST, files: PACKAGE_CONTENTS })
  const pkg = signPackage(built, {
    privateKeyPem: keys.privateKeyPem, manifestDigest, signedAt: '2026-01-01T00:00:00Z', keyId: 'orchestrator-test',
  })

  /** 一份"标准输入"。每个用例只覆盖它需要改的那几项。 */
  const args = (overrides = {}) => ({
    paths: { installDir, dataDir, configPath, backupDir, auditDir },
    current: OLD_MANIFEST,
    target: NEW_MANIFEST,
    targetVersion: NEW_VERSION,
    package: pkg,
    packageBytes: PACKAGE_CONTENTS,
    publicKeyPem: keys.publicKeyPem,
    manifestDigest,
    freeBytes: 10 * 1024 * 1024 * 1024,
    packageBytesForDisk: 1 * 1024 * 1024,
    tasks: [],
    // ★ 一张真的绑定表：不给它时体检会以 "unverified" 拦住（见下面单独的用例）。
    patchBindings: [
      { dshVersion: '0.8.2', compositionPatchVersion: 1 },
      { dshVersion: '0.8.3', compositionPatchVersion: 2 },
    ],
    healthTimeoutMs: 500,
    healthProbe: async () => ({ ok: true }),
    now: () => 1000,
    ...overrides,
  })

  return {
    root, installDir, dataDir, configPath, backupDir, auditDir, keys, pkg, manifestDigest,
    args,
    activeVersion: () => readActivePointer(installDir).version,
    data: (name) => readFileSync(join(dataDir, name), 'utf8'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

/** 一个说了算的假数据库：可以指定某条语句抛错。 */
function fakeDb({ failOn = null } = {}) {
  const executed = []
  return {
    executed,
    exec(sql) {
      if (failOn !== null && sql.includes(failOn)) {
        const e = new Error(`模拟：${failOn} 失败`)
        e.code = 'SIMULATED'
        throw e
      }
      executed.push(sql)
    },
  }
}

// ── ① 下载损坏 ──────────────────────────────────────────────────────────────

test('① ★★ 下载损坏：**什么都没动过**，旧版本照常跑', async () => {
  const s = site()
  try {
    // 一个字节的差别：`v = 1` 改成 `v = 2`。
    const tampered = { ...PACKAGE_CONTENTS, 'runtime.mjs': 'export const v = 2\n' }
    const r = await runUpgrade(s.args({ packageBytes: tampered }))

    assert.equal(r.verdict, 'not-started', r.notes)
    assert.equal(r.code, UPGRADE_CODES.VERIFICATION_FAILED)
    assert.equal(r.reachedStage, 'download-verify')
    assert.equal(r.verification.verdict, 'rejected')
    assert.equal(r.verification.integrity.verdict, 'mismatch')

    // ★ 三条独立读数，而不是一句"升级失败"。
    assert.equal(r.knownCompatible, true, '什么也没动过，却报"未知状态"')
    assert.equal(r.dataSafety.businessDataIntact, true)
    assert.equal(r.dataSafety.code, 'upgrade-data-untouched')
    assert.equal(s.activeVersion(), OLD_VERSION, '校验失败却动了活动指针')
    assert.equal(s.data('team.db'), 'SQLITE-DATA-v1')
    // 切换、迁移、健康检查都没有发生过。
    assert.equal(r.events.some((e) => e.stage === 'switch' && e.code !== 'disk-recheck-ok'), false)
    assert.equal(r.events.some((e) => e.stage === 'health'), false)
  } finally { s.cleanup() }
})

test('① ★★ 没有签名的包默认被拒（`unsigned` 不是"可以装"）', async () => {
  const s = site()
  try {
    const unsigned = buildPackage({ productId: 'legion', manifest: NEW_MANIFEST, files: PACKAGE_CONTENTS })
    const r = await runUpgrade(s.args({ package: unsigned }))
    assert.equal(r.verdict, 'not-started')
    assert.equal(r.verification.signature.verdict, 'unsigned')
    assert.equal(s.activeVersion(), OLD_VERSION)
  } finally { s.cleanup() }
})

test('① ★ 备份失败也停在**动过任何东西之前**（spec §9.4 第二步）', async () => {
  const s = site()
  try {
    // 两个源都不存在 → 备份工厂拒绝建一份空快照 → 编排在第二步停下。
    const r = await runUpgrade(s.args({
      paths: { ...s.args().paths, dataDir: join(s.root, '不存在'), configPath: join(s.root, '也不存在') },
    }))
    assert.equal(r.verdict, 'not-started', r.notes)
    assert.equal(r.code, UPGRADE_CODES.BACKUP_FAILED)
    assert.equal(r.reachedStage, 'backup')
    assert.equal(r.backup.ok, false)
    assert.equal(r.knownCompatible, true)
    assert.equal(s.activeVersion(), OLD_VERSION)
    // 而且没有留下任何"空备份"被当成备份。
    assert.equal(listSnapshots(s.backupDir).filter((x) => x.status === 'complete').length, 0)
  } finally { s.cleanup() }
})

test('① 体检不通过时不动任何东西（在途任务没收敛）', async () => {
  const s = site()
  try {
    const r = await runUpgrade(s.args({ tasks: [{ id: 'a', state: 'running' }] }))
    assert.equal(r.verdict, 'not-started')
    assert.equal(r.code, UPGRADE_CODES.PREFLIGHT_FAILED)
    assert.equal(r.reachedStage, 'preflight')
    assert.equal(r.knownCompatible, true)
    assert.equal(s.activeVersion(), OLD_VERSION)
  } finally { s.cleanup() }
})

test('① ★★ 切换前用真实包大小复查磁盘：不够时**在切换之前**拒动', async () => {
  const s = site()
  try {
    // pre-download 阶段容忍磁盘读数未知，所以第一次体检会过；
    // 切换前那次用真实包大小算，于是这条被拦住。
    const r = await runUpgrade(s.args({
      freeBytes: 1024,
      packageBytesForDisk: 100 * 1024 * 1024,
      dataDirBytes: 10 * 1024 * 1024,
    }))
    assert.equal(r.verdict, 'not-started', r.notes)
    assert.equal(r.code, UPGRADE_CODES.DISK_RECHECK_FAILED)
    assert.equal(r.reachedStage, 'switch')
    assert.equal(r.diskRecheck.ok, false)
    assert.equal(s.activeVersion(), OLD_VERSION, '磁盘不够却已经切了程序')
    assert.equal(r.preflight.ok, true, 'pre-download 那次体检本该通过（磁盘读数未知被容忍）')
  } finally { s.cleanup() }
})

// ── ② 迁移失败 ──────────────────────────────────────────────────────────────

test('② ★★ 迁移失败：程序**真的退回**旧版本，数据库停在旧版本读得懂的结构上', async () => {
  const s = site()
  try {
    const db = fakeDb({ failOn: 'ADD COLUMN 坏了的列' })
    const migrations = [
      defineMigration({
        version: 1, name: 'add-col', compatibility: 'additive',
        up: (base) => { base.exec('ALTER TABLE runs ADD COLUMN started_at') },
      }),
      defineMigration({
        version: 2, name: 'add-broken', compatibility: 'additive',
        up: (base) => { base.exec('ALTER TABLE runs ADD COLUMN 坏了的列') },
      }),
    ]
    const store = createMemoryMigrationStore()
    const r = await runUpgrade(s.args({ migrations, migrationStore: store, migrationBase: db }))

    assert.equal(r.verdict, 'rolled-back', r.notes)
    assert.equal(r.code, 'migration-up-failed')
    assert.equal(r.reachedStage, 'migrate')
    assert.equal(r.migrationOutcome.outcome, 'failed')
    // ★ 指针真的换回去了 —— 这是"恢复到已知兼容状态"的可执行形式。
    assert.equal(s.activeVersion(), OLD_VERSION, '迁移失败后活动指针仍指向新版本')
    assert.equal(r.rollback.ok, true)
    assert.equal(r.rollback.safety, 'program-only-rollback')
    assert.equal(r.rollback.restoredVersion, OLD_VERSION)

    // ★ 数据：第 1 份 additive 迁移已应用，旧程序读得懂 → 一行未丢。
    assert.equal(r.dataSafety.businessDataIntact, true)
    assert.equal(r.dataSafety.code, 'upgrade-data-preserved')
    assert.equal(r.knownCompatible, true)
    assert.equal(s.data('team.db'), 'SQLITE-DATA-v1')
    // 迁移记录里第 1 份是 applied、第 2 份是 failed —— 不是"都没跑"。
    assert.deepEqual(store.rows().map((row) => row.status), ['applied', 'failed'])
    // 健康检查没有跑（程序已经不在了，没有意义）。
    assert.equal(r.health, null)
    assert.equal(r.events.some((e) => e.stage === 'health'), false)
  } finally { s.cleanup() }
})

test('② ★★ 迁移**校验和漂移**也是失败，也要退回（不是"跳过"）', async () => {
  const s = site()
  try {
    const db = fakeDb()
    const original = [
      defineMigration({ version: 1, name: 'a', compatibility: 'additive', up: (base) => { base.exec('CREATE TABLE a') } }),
    ]
    const store = createMemoryMigrationStore()
    // 先跑一次把记录留下。
    await runUpgrade(s.args({ migrations: original, migrationStore: store, migrationBase: db }))
    assert.equal(s.activeVersion(), NEW_VERSION)

    // 回到旧版本，然后改掉已应用迁移的代码再跑一次。
    activateVersion(s.installDir, OLD_VERSION, { nowMs: 2 })
    const edited = [
      defineMigration({ version: 1, name: 'a', compatibility: 'additive', up: (base) => { base.exec('CREATE TABLE a (id TEXT)') } }),
    ]
    const r = await runUpgrade(s.args({ migrations: edited, migrationStore: store, migrationBase: fakeDb() }))
    assert.equal(r.migrationOutcome.outcome, 'checksum-drift', JSON.stringify(r.migrationOutcome))
    assert.equal(r.verdict, 'rolled-back', r.notes)
    assert.equal(s.activeVersion(), OLD_VERSION)
  } finally { s.cleanup() }
})

test('② ★★ contract 迁移在没有显式声明时**在动手之前**被拦', async () => {
  const s = site()
  try {
    const migrations = [
      defineMigration({ version: 1, name: 'contract', compatibility: 'breaking', up: (base) => { base.exec('DROP VIEW v') } }),
    ]
    const r = await runUpgrade(s.args({ migrations, migrationStore: createMemoryMigrationStore(), migrationBase: fakeDb() }))
    assert.equal(r.verdict, 'not-started')
    assert.equal(r.code, UPGRADE_CODES.MIGRATION_PLAN_INCOMPATIBLE)
    assert.equal(r.reachedStage, 'preflight')
    assert.equal(s.activeVersion(), OLD_VERSION, '被拦却已经切了程序')
    assert.ok(r.notes.includes('allowBreakingMigrations'), r.notes)
  } finally { s.cleanup() }
})

// ── ③ DSH 启动失败 ──────────────────────────────────────────────────────────

test('③ ★★ DSH 启动失败（进程起不来）：退回旧版本，数据未丢', async () => {
  const s = site()
  try {
    const connRefused = new Error('connect ECONNREFUSED 127.0.0.1:3080')
    connRefused.code = 'ECONNREFUSED'
    const r = await runUpgrade(s.args({
      healthProbe: async () => { throw connRefused },
    }))

    assert.equal(r.verdict, 'rolled-back', r.notes)
    assert.equal(r.reachedStage, 'health')
    assert.equal(r.health.verdict, 'unhealthy')
    assert.ok(r.health.reason.includes('ECONNREFUSED'), r.health.reason)
    assert.equal(s.activeVersion(), OLD_VERSION)
    assert.equal(r.knownCompatible, true)
    assert.equal(r.dataSafety.businessDataIntact, true)
    // 备份确实是先做过的（回滚的输入）。
    assert.equal(listSnapshots(s.backupDir).filter((x) => x.status === 'complete').length, 1)
  } finally { s.cleanup() }
})

// ── ④ 健康检查失败 ──────────────────────────────────────────────────────────

test('④ ★★ 健康检查失败（答了，但答的是"不行"）：与启动失败分档，同样退回', async () => {
  const s = site()
  try {
    const r = await runUpgrade(s.args({
      healthProbe: async () => ({ ok: false, detail: 'worker 未就绪：数据库版本不匹配' }),
    }))
    assert.equal(r.verdict, 'rolled-back', r.notes)
    assert.equal(r.health.verdict, 'unhealthy')
    assert.notEqual(r.health.verdict, 'timeout', '答了"不行"被记成了超时——排障会从错的地方开始')
    assert.equal(r.health.detail, 'worker 未就绪：数据库版本不匹配')
    assert.equal(s.activeVersion(), OLD_VERSION)
    assert.equal(r.dataSafety.businessDataIntact, true)
    assert.equal(r.knownCompatible, true)
    // 与 ③ 的差别落在 reason 上：一个是探针抛错，一个是探针返回非 ok。
    assert.ok(r.health.reason.includes('非 ok'), r.health.reason)
  } finally { s.cleanup() }
})

test('④ ★★ 健康检查**挂起**：超时也算失败，也必须收敛（不能一起挂）', async () => {
  const s = site()
  try {
    const started = Date.now()
    const r = await runUpgrade(s.args({
      healthTimeoutMs: 50,
      healthProbe: () => new Promise(() => {}),
    }))
    const elapsed = Date.now() - started
    assert.equal(r.verdict, 'rolled-back', r.notes)
    assert.equal(r.health.verdict, 'timeout')
    assert.equal(r.reachedStage, 'health')
    assert.equal(s.activeVersion(), OLD_VERSION)
    assert.ok(elapsed < 5000, `挂起的探针把编排也挂住了：${elapsed}ms`)
    assert.ok(r.health.reason.includes('超时是失败'), r.health.reason)
  } finally { s.cleanup() }
})

test('④ ★ 没有健康探针时不提交：没有检查不等于检查通过', async () => {
  const s = site()
  try {
    const r = await runUpgrade(s.args({ healthProbe: null }))
    assert.equal(r.verdict, 'rolled-back', '没有探针却提交了升级')
    assert.equal(r.health.verdict, 'unsupported')
    assert.equal(s.activeVersion(), OLD_VERSION)
  } finally { s.cleanup() }
})

// ── ⑤ contract 迁移之后的失败：只剩"从备份恢复"这一条路 ─────────────────────

test('⑤ ★★ contract 迁移失败且**无 down**：不能仅回滚程序，落点是 forward-fix-required', async () => {
  const s = site()
  try {
    const db = fakeDb({ failOn: '第二句' })
    const migrations = [
      defineMigration({
        version: 1, name: 'contract-drop', compatibility: 'breaking', destructive: true,
        up: (base) => {
          // 第一句成功（旧结构已被改写），第二句失败。
          base.exec('ALTER TABLE runs DROP COLUMN legacy')
          base.exec('第二句')
        },
      }),
    ]
    const store = createMemoryMigrationStore()
    const r = await runUpgrade(s.args({
      migrations, migrationStore: store, migrationBase: db, allowBreakingMigrations: true,
    }))

    assert.equal(r.migrationOutcome.outcome, 'failed')
    assert.equal(r.verdict, 'forward-fix-required', r.notes)
    assert.equal(r.code, UPGRADE_CODES.FORWARD_FIX)
    assert.equal(r.reachedStage, 'migrate')
    // ★ 拒绝仅回滚程序：指针留在新版本，且明确说了为什么。
    assert.equal(s.activeVersion(), NEW_VERSION, 'contract 迁移之后悄悄退回了旧版本')
    assert.equal(r.rollback.ok, false)
    assert.equal(r.rollback.safety, 'forward-fix-required')
    assert.equal(r.rollback.restoredVersion, null)
    assert.ok(r.rollback.doesNotRestore.some((x) => x.includes('数据库')), JSON.stringify(r.rollback.doesNotRestore))

    // ★ 两条独立的坏读数，都要报出来。
    assert.equal(r.knownCompatible, false, 'forward-fix-required 被判成了"已知兼容"')
    assert.equal(r.dataSafety.businessDataIntact, false)
    assert.equal(r.dataSafety.code, 'upgrade-data-at-risk')
    assert.ok(r.dataSafety.reason.includes('无法确定'), r.dataSafety.reason)
    // 失败的迁移被记录下来了，而不是"好像什么都没发生"。
    assert.deepEqual([...r.failedMigrations.map((m) => m.version)], [1])
    // 通知必须是 critical（不能静默）。
    assert.equal(r.notification.level, 'critical')
    assert.equal(r.notification.actionRequired, true)
  } finally { s.cleanup() }
})

test('⑤ ★★ 从升级前备份恢复：数据库真的回到备份时刻的内容，程序也退回去', async () => {
  const s = site()
  try {
    // 走一遍完整的升级（无迁移），提交 → 留一份备份。
    const committed = await runUpgrade(s.args())
    assert.equal(committed.verdict, 'committed', committed.notes)
    const snapshotId = committed.backup.snapshot.id
    const snapshotRoot = join(s.backupDir, 'snapshots', snapshotId)

    // 提交之后又写了两行 —— 这就是"备份之后的写入"。
    writeFileSync(join(s.dataDir, 'team.db'), 'SQLITE-DATA-v2-升级之后写的', 'utf8')
    writeFileSync(join(s.dataDir, 'audit.log'), 'line-1\nline-2-升级之后写的\n', 'utf8')

    const r = rollbackWithBackupRestore({
      installRoot: s.installDir, snapshotRoot, dataDir: s.dataDir, configPath: s.configPath, nowMs: 5,
    })
    assert.equal(r.ok, true, r.reason)
    // 文件内容回到了备份时刻 —— 这是"已知兼容状态"的可执行形式。
    assert.equal(s.data('team.db'), 'SQLITE-DATA-v1')
    assert.equal(s.data('audit.log'), 'line-1\n')
    // 程序指针也退回去了。
    assert.equal(s.activeVersion(), OLD_VERSION)
    assert.equal(r.programRollback.version, OLD_VERSION)
    assert.ok(r.reason.includes(OLD_VERSION), r.reason)
    // ★ 而"数据没丢"这句**不成立**：备份之后的写入没了，必须说出来。
    assert.equal(r.dataSafety.businessDataIntact, false)
    assert.equal(r.dataSafety.code, 'upgrade-data-restored-from-backup')
    assert.ok(r.dataSafety.reason.includes('已丢'), r.dataSafety.reason)
  } finally { s.cleanup() }
})

test('⑤ ★★ 从备份恢复时先删 `-wal`/`-shm`：不删就等于把两个时刻的库合并', async () => {
  const s = site()
  try {
    const committed = await runUpgrade(s.args())
    const snapshotRoot = join(s.backupDir, 'snapshots', committed.backup.snapshot.id)
    writeFileSync(join(s.dataDir, 'team.db'), '升级之后的库', 'utf8')
    writeFileSync(join(s.dataDir, 'team.db-wal'), '升级期间的未合并提交', 'utf8')

    const r = rollbackWithBackupRestore({
      installRoot: s.installDir, snapshotRoot, dataDir: s.dataDir, configPath: s.configPath, nowMs: 8,
    })
    assert.equal(r.ok, true, r.reason)
    assert.equal(s.data('team.db'), 'SQLITE-DATA-v1')
    assert.equal(existsSync(join(s.dataDir, 'team.db-wal')), false, '覆盖了主库却把升级期间的 WAL 留在原地')
    assert.deepEqual([...r.restore.sidecarsRemoved].map((x) => x.path.split(/[\\/]/).pop()), ['team.db-wal'])
  } finally { s.cleanup() }
})

test('⑤ ★★ 备份损坏时恢复失败，且不谎报"数据已保住"', async () => {
  const s = site()
  try {
    const committed = await runUpgrade(s.args())
    const snapshotRoot = join(s.backupDir, 'snapshots', committed.backup.snapshot.id)
    // 篡改快照里的字节。
    writeFileSync(join(snapshotRoot, 'data', 'team.db'), '被改了', 'utf8')
    writeFileSync(join(s.dataDir, 'team.db'), '当前数据', 'utf8')

    const r = rollbackWithBackupRestore({
      installRoot: s.installDir, snapshotRoot, dataDir: s.dataDir, nowMs: 6,
    })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'backup-snapshot-corrupt')
    assert.equal(r.dataSafety.businessDataIntact, false)
    assert.equal(r.dataSafety.code, 'upgrade-data-at-risk')
    // 目标目录没被动过 —— 失败的恢复不该留下"半份备份"。
    assert.equal(s.data('team.db'), '当前数据')
    assert.equal(s.activeVersion(), NEW_VERSION, '恢复失败却把程序退了回去——那是一个新的未知状态')
  } finally { s.cleanup() }
})

// ── ⑥ 成功路径与幂等 ────────────────────────────────────────────────────────

test('⑥ ★★ 一路顺利：十个阶段按 spec §9.4 的顺序走过，最后提交', async () => {
  const s = site()
  try {
    const store = createMemoryMigrationStore()
    const migrations = [
      defineMigration({ version: 1, name: 'a', compatibility: 'additive', up: (base) => { base.exec('CREATE TABLE a') } }),
      defineMigration({ version: 2, name: 'b', compatibility: 'additive', up: (base) => { base.exec('ALTER TABLE a ADD c') } }),
    ]
    const r = await runUpgrade(s.args({ migrations, migrationStore: store, migrationBase: fakeDb() }))

    assert.equal(r.verdict, 'committed', r.notes)
    assert.equal(r.code, UPGRADE_CODES.COMMITTED)
    assert.equal(r.reachedStage, 'finalize')
    assert.equal(s.activeVersion(), NEW_VERSION)
    assert.equal(r.health.verdict, 'healthy')
    assert.equal(r.migrationOutcome.outcome, 'applied-all')
    assert.equal(r.knownCompatible, true)
    assert.equal(r.dataSafety.businessDataIntact, true)
    assert.equal(r.notification.level, 'info')
    assert.equal(r.notification.actionRequired, false)

    // 事件里出现过的阶段都落在声明的十个里，且切换在迁移之前。
    const stages = r.events.map((e) => e.stage).filter((x) => UPGRADE_STAGES.includes(x))
    assert.ok(stages.indexOf('switch') < stages.indexOf('migrate'), JSON.stringify(stages))
    assert.ok(stages.indexOf('migrate') < stages.indexOf('health'), JSON.stringify(stages))
    assert.ok(stages.indexOf('preflight') === 0, JSON.stringify(stages))
    assert.equal(r.retention !== null, true, '提交时没有算保留计划')
  } finally { s.cleanup() }
})

test('⑥ ★★ 已经是当前版本：什么都不做，而且审计结果**不是** aborted', async () => {
  const s = site()
  try {
    const r = await runUpgrade(s.args({ current: NEW_MANIFEST, targetVersion: NEW_VERSION }))
    assert.equal(r.verdict, 'already-current')
    assert.equal(r.code, UPGRADE_CODES.ALREADY_CURRENT)
    assert.equal(r.record.result, 'not-started')
    assert.equal(RESULT_BY_VERDICT['already-current'], 'not-started')
    assert.equal(s.activeVersion(), OLD_VERSION, '"已经是最新"却动了指针')
  } finally { s.cleanup() }
})

test('⑥ ★★ 再跑一次同一份升级：迁移全部"已应用"，不重复执行 SQL', async () => {
  const s = site()
  try {
    const store = createMemoryMigrationStore()
    const db = fakeDb()
    const migrations = [
      defineMigration({ version: 1, name: 'a', compatibility: 'additive', up: (base) => { base.exec('CREATE TABLE a') } }),
    ]
    const first = await runUpgrade(s.args({ migrations, migrationStore: store, migrationBase: db }))
    assert.equal(first.verdict, 'committed')
    assert.equal(db.executed.length, 1)

    activateVersion(s.installDir, OLD_VERSION, { nowMs: 7 })
    const second = await runUpgrade(s.args({ migrations, migrationStore: store, migrationBase: db }))
    assert.equal(second.verdict, 'committed', second.notes)
    assert.equal(second.migrationOutcome.outcome, 'already-current')
    assert.equal(db.executed.length, 1, '第二次又执行了一遍迁移 SQL')
  } finally { s.cleanup() }
})

test('⑥ ★ 每个阶段都可以被注入失败，且失败时**没有半覆盖**', async () => {
  const s = site()
  try {
    for (const stage of ['preflight', 'backup', 'download-verify']) {
      const r = await runUpgrade(s.args({ stageHook: (name) => { if (name === stage) throw new Error(`注入失败@${stage}`) } }))
      assert.equal(r.verdict, 'not-started', `${stage} 注入失败后的落点是 ${r.verdict}`)
      assert.equal(r.code, UPGRADE_CODES.STAGE_FAILED)
      assert.equal(r.reachedStage, stage)
      assert.equal(r.knownCompatible, true)
      assert.equal(r.dataSafety.businessDataIntact, true)
      assert.equal(s.activeVersion(), OLD_VERSION, `${stage} 失败却动了活动指针`)
    }
  } finally { s.cleanup() }
})

// ── ⑦ 审计与发布说明 ────────────────────────────────────────────────────────

test('⑦ ★★ 审计落盘：四个失败点各自留下一条可查的记录', async () => {
  const s = site()
  try {
    const connRefused = new Error('ECONNREFUSED'); connRefused.code = 'ECONNREFUSED'
    const runs = [
      await runUpgrade(s.args({ packageBytes: { ...PACKAGE_CONTENTS, 'runtime.mjs': 'export const v = 9\n' } })),
      await runUpgrade(s.args({
        migrations: [defineMigration({ version: 1, name: 'x', compatibility: 'additive', up: (b) => { b.exec('坏了') } })],
        migrationStore: createMemoryMigrationStore(), migrationBase: fakeDb({ failOn: '坏了' }),
      })),
      await runUpgrade(s.args({ healthProbe: async () => { throw connRefused } })),
      await runUpgrade(s.args({ healthProbe: async () => ({ ok: false }) })),
    ]
    assert.deepEqual(runs.map((r) => r.verdict), ['not-started', 'rolled-back', 'rolled-back', 'rolled-back'])
    for (const r of runs) assert.ok(r.auditFile !== null, '审计没有落盘')

    const records = listUpgradeRecords(s.auditDir)
    // 四条失败记录 + 前一条成功的不同名文件：都读得出来，且没有 unreadable。
    assert.ok(records.length >= 4, `只读到 ${records.length} 条审计`)
    assert.equal(records.some((x) => x.unreadable === true), false, JSON.stringify(records))
    assert.ok(records.every((x) => x.kind === 'legion/upgrade-audit@1'))
    // 每条都带上了"为什么"所需的字段（缺的就是显式 null）。
    for (const rec of records) {
      for (const key of ['result', 'fromVersion', 'toVersion', 'verification', 'backupId', 'migrationOutcome', 'health', 'rollback']) {
        assert.equal(key in rec, true, `审计记录缺少 ${key}`)
      }
    }
  } finally { s.cleanup() }
})

test('⑦ ★ 发布说明文件写得下去，且内容就是渲染过的那份', async () => {
  const s = site()
  try {
    const dir = join(s.root, 'notes')
    const file = writeReleaseNotesFile(dir, NEW_VERSION, 'Legion 0.9.0\n回滚：向前兼容')
    assert.equal(readFileSync(file, 'utf8'), 'Legion 0.9.0\n回滚：向前兼容\n')
    assert.ok(file.includes('release-notes-0.9.0'), file)
  } finally { s.cleanup() }
})

test('⑦ `ensureUpgradeDirs` 建目录且不猜位置；空/缺值跳过', () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-dirs-'))
  try {
    const created = ensureUpgradeDirs({ backupDir: join(root, 'b'), auditDir: join(root, 'a') })
    assert.equal(created.length, 2)
    assert.deepEqual([...ensureUpgradeDirs({ backupDir: '', auditDir: null })], [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('⑦ ★ 编排的输入不完整时直接抛（不猜安装目录）', async () => {
  await assert.rejects(() => runUpgrade({}), (e) => {
    assert.equal(e.code, UPGRADE_CODES.BAD_INPUT)
    return true
  })
})

// ── ⑧ 装载期自检 ────────────────────────────────────────────────────────────

test('⑧ ★ 装载期自检留下的是算出来的值，四条判据都真的跑过', () => {
  assert.deepEqual([...ORCHESTRATOR_CHECKED.problems], [])
  assert.equal(ORCHESTRATOR_CHECKED.ok, true)
  const s = ORCHESTRATOR_CHECKED.samples
  assert.equal(s.breakingPlanOk, false)
  assert.equal(s.breakingPlanCode, UPGRADE_CODES.MIGRATION_PLAN_INCOMPATIBLE)
  assert.equal(s.allowBreakingOk, true)
  assert.equal(s.untouchedIntact, true)
  assert.equal(s.restoredIntact, false)
  assert.equal(s.restoredCode, 'upgrade-data-restored-from-backup')
  assert.equal(s.restoredNoMigrationsIntact, false)
  assert.equal(s.unmappedCount, 0)
  assert.equal(s.verdictCount, UPGRADE_VERDICTS.length)
  assert.equal(s.mappedResults.length, UPGRADE_VERDICTS.length)
  assert.deepEqual([...ORCHESTRATOR_CHECKED.stages], [...UPGRADE_STAGES])
})

test('⑧ ★★ `knownCompatible` 不是恒真的：三个失败点里有一个会为假', () => {
  // 这条与上面那些"knownCompatible 为真"的用例配对：如果它永远是 true，
  // 那它就只是一个装饰。它必须能被驱动到 false —— 唯一的入口是
  // "程序换了、而数据库不能再退回去"。
  assert.equal(dataSafetyOf({ appliedMigrations: [], migrations: [] }).businessDataIntact, true)
  const atRisk = dataSafetyOf({
    appliedMigrations: [{ version: 1, compatibility: 'breaking' }],
    migrations: [{ version: 1, name: 'c', compatibility: 'breaking', hasDownMigration: false }],
  })
  assert.equal(atRisk.businessDataIntact, false)
  assert.equal(atRisk.code, 'upgrade-data-at-risk')
  void checkMigrationPlanRollback
})
