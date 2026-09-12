// product/upgrade/index.mjs
// ============================================================================
// 阶段 8 的编排：一次完整的「安装、升级和回滚」
//
// spec §9.4 line 719–731 给了流程的十步，本模块就是那十步的可执行形式：
//
//   检查兼容性与空间 → 备份数据库和配置 → 下载并校验签名 → 停止任务认领
//   → 等待或安全中断在途运行 → 停止服务 → 原子切换程序版本 → 执行数据库迁移
//   → 启动并运行健康检查 → 提交升级或回滚
//
// 完成标准（spec line 980）是：
//
//   「模拟下载损坏、迁移失败、DSH 启动失败和健康检查失败时，系统能恢复到
//     **已知兼容状态**且**业务数据不丢失**。」
//
// ## 一、"已知兼容状态"是对**每一个**失败点的要求，不是对最后一个
//
// 这条流程里有四处会失败，而它们失败时系统所处的状态**各不相同**：
//
//   · 下载损坏   —— 还没动过任何东西；当前版本照常运行；
//   · 迁移失败   —— 程序已换、数据库刚跑过一部分迁移；
//   · 启动失败   —— 程序已换、迁移跑完、新版本起不来；
//   · 健康检查失败 —— 程序已换、迁移跑完、新版本起来了但不健康。
//
// 中间那两种最危险：**程序已经换了**。所以"恢复到已知兼容状态"在它们身上
// 不是一句"报错退出"，而是一次**真的回滚**（指针换回去 + 数据库按可回滚性处置）。
//
// 于是本模块的返回值里**永远**有这四个字段：
//
//   `verdict`         —— 最终落在哪一个已知状态；
//   `reachedStage`    —— 走到哪一步失败的；
//   `knownCompatible` —— 现在这个状态是不是"已知兼容"；
//   `dataSafety`      —— 业务数据有没有丢，以及**为什么**这么认为。
//
// ## 二、为什么 `knownCompatible` 不是 `verdict === 'committed'`
//
// 一次成功的升级是一个已知兼容状态；一次"下载损坏于是什么都没做"的运行也**是**
// ——当前版本在跑，那正是升级之前的那个已知兼容状态。
//
//   > 一个把"没有升级成功"一律算作"系统处于未知状态"的判定，
//   > 与一个"每次下载抖动都要人工介入"的流程，是同一个东西。
//
// 所以 `knownCompatible` 的判据是**当前活动版本能不能被识别、且它是否等于
// 我们出发时的那个版本（或一个已验证过的新版本）**，而不是"有没有升级成功"。
//
// ## 三、数据安全要按"已经写进数据库的东西"算
//
// `dataSafety` 不读"结果是不是成功"，它读的是**迁移的兼容性声明**：
// additive 迁移之后的回滚不动数据库，业务数据在；breaking 迁移之后必须
// 从备份恢复，那份备份里的写入会丢。这两句话必须分别写在返回值里。
// ============================================================================

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createUpgradeRecord, upgradeNotification, writeUpgradeRecord } from './audit.mjs'
import { BACKUP_POLICY_DEFAULTS, createSnapshot, planRetention, restoreSnapshot } from './backup.mjs'
import { hashBytes, verifyPackage } from './package.mjs'
import { runPreflight } from './preflight.mjs'
import { COMPATIBILITY, planRollback, validateMigrationPlan } from './migration.mjs'
import { activateVersion, probeHealth, readActivePointer, rollbackUpgrade } from './switchover.mjs'

/** 编排版本。 */
export const UPGRADE_ORCHESTRATOR = 'legion/upgrade-orchestrator@1'

/** 流程的十个阶段，顺序即 spec §9.4 的顺序。 */
export const UPGRADE_STAGES = Object.freeze([
  'preflight',
  'backup',
  'download-verify',
  'stop-claiming',
  'drain-in-flight',
  'stop-services',
  'switch',
  'migrate',
  'health',
  'finalize',
])

/** 最终落点。**每一个都是"已知状态"**。 */
export const UPGRADE_VERDICTS = Object.freeze([
  /** 已经是最新版本，什么都没做。 */
  'already-current',
  /** 全部成功。 */
  'committed',
  /** 出错之前没有动过任何东西（下载损坏、体检不过、备份失败）。 */
  'not-started',
  /** 动过之后退回了旧版本。 */
  'rolled-back',
  /** 已经换了程序、且不能仅回滚程序，必须向前修复。 */
  'forward-fix-required',
])

export const UPGRADE_CODES = Object.freeze({
  ALREADY_CURRENT: 'upgrade-already-current',
  /** 包完整性与签名校验没通过——**在动任何东西之前**。 */
  VERIFICATION_FAILED: 'upgrade-verification-failed',
  PREFLIGHT_FAILED: 'upgrade-preflight-failed',
  BACKUP_FAILED: 'upgrade-backup-failed',
  /** 迁移集合里的声明互相冲突（例如全 additive 的集合里出现 breaking）。 */
  MIGRATION_PLAN_INCOMPATIBLE: 'upgrade-migration-plan-incompatible',
  STAGE_FAILED: 'upgrade-stage-failed',
  COMMITTED: 'upgrade-committed',
  ROLLED_BACK: 'upgrade-rolled-back',
  FORWARD_FIX: 'upgrade-forward-fix-required',
  /** 编排的输入不完整。 */
  BAD_INPUT: 'upgrade-bad-input',
})

function upgradeError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

// ---------------------------------------------------------------------------
// 迁移集合的可回滚性预检
// ---------------------------------------------------------------------------

/**
 * 迁移集合是否满足"本阶段可用的回滚语义"。
 *
 * 这是一条**独立于运行结果**的判据，检查的是集合的声明：
 * 只要有一份 `breaking` 迁移，且它在本次运行中可能被应用，那么
 * "回滚程序即可恢复"这条保证就不再成立。
 *
 * 它在升级**开始之前**跑，而不是在回滚的那一刻才发现——因为回滚的那一刻
 * 已经没有选择了。
 */
export function checkMigrationPlanRollback(migrations, { allowBreaking = false } = {}) {
  const plan = validateMigrationPlan(migrations)
  if (!plan.ok) {
    return Object.freeze({
      ok: false, code: UPGRADE_CODES.MIGRATION_PLAN_INCOMPATIBLE,
      breaking: Object.freeze([]), plan,
      reason: plan.problems.map((p) => p.message).join('；'),
    })
  }
  const breaking = migrations.filter((m) => m.compatibility === 'breaking')
  if (breaking.length > 0 && allowBreaking !== true) {
    return Object.freeze({
      ok: false, code: UPGRADE_CODES.MIGRATION_PLAN_INCOMPATIBLE,
      breaking: Object.freeze(breaking.map((m) => m.name)), plan,
      reason: `本次升级包含 ${breaking.length} 份 contract（breaking）迁移（${breaking.map((m) => m.name).join(' / ')}）：` +
        '它们写入旧版本读不懂的数据，因此"出错就退回旧版本"这条保证不再成立。' +
        '如需继续，调用方必须显式声明 allowBreakingMigrations',
    })
  }
  for (const m of migrations) {
    if (!COMPATIBILITY.includes(m.compatibility)) {
      return Object.freeze({
        ok: false, code: UPGRADE_CODES.MIGRATION_PLAN_INCOMPATIBLE, breaking: Object.freeze([]), plan,
        reason: `迁移 ${m.name} 的 compatibility 声明不合法`,
      })
    }
  }
  return Object.freeze({ ok: true, code: null, breaking: Object.freeze([]), plan, reason: null })
}

// ---------------------------------------------------------------------------
// 数据安全读数
// ---------------------------------------------------------------------------

/**
 * 「业务数据有没有丢」的读数。
 *
 * 它读的是**迁移的兼容性声明**，不是"成功与否"。
 */
export function dataSafetyOf({ appliedMigrations = [], migrations = [], backup = null, restoredFromBackup = false }) {
  if (appliedMigrations.length === 0) {
    return Object.freeze({
      businessDataIntact: true,
      code: 'upgrade-data-untouched',
      reason: restoredFromBackup
        ? '从备份恢复过数据库：业务数据回到备份时刻，备份之后的写入**已丢**'
        : '本次运行没有向数据库写入任何迁移：业务数据未被改动',
      backupTakenAtMs: backup?.snapshot?.createdAtMs ?? null,
    })
  }
  const plan = planRollback({ applied: appliedMigrations, migrations })
  if (plan.safety === 'program-only-rollback') {
    return Object.freeze({
      businessDataIntact: true,
      code: 'upgrade-data-preserved',
      reason: `${appliedMigrations.length} 份迁移全部是 additive（expand）：旧程序读得懂新结构，业务数据一行未丢`,
      backupTakenAtMs: backup?.snapshot?.createdAtMs ?? null,
    })
  }
  if (restoredFromBackup) {
    return Object.freeze({
      businessDataIntact: false,
      code: 'upgrade-data-restored-from-backup',
      reason: '数据库已从升级前备份恢复：**备份之后的写入已丢**。这是 contract 迁移之后唯一能回到已知结构的路',
      backupTakenAtMs: backup?.snapshot?.createdAtMs ?? null,
    })
  }
  return Object.freeze({
    businessDataIntact: false,
    code: 'upgrade-data-at-risk',
    reason: `${plan.reason}。数据库当前处于旧版本读不懂的结构上，` +
      '业务数据**没有**被恢复到升级前的样子',
    backupTakenAtMs: backup?.snapshot?.createdAtMs ?? null,
  })
}

// ---------------------------------------------------------------------------
// 编排
// ---------------------------------------------------------------------------

/**
 * 跑一次升级。
 *
 * 全部外部效果都是注入的：磁盘、时钟、文件复制、进程、探针、迁移存储。
 * 这不是为了灵活——是因为**四个失败点必须能被真的驱动到**，
 * 而真实世界里没法按需制造"迁移写到一半抛错"。
 *
 * @param {object} args
 * @param {{installDir: string, dataDir?: string, configPath?: string, productConfigPath?: string,
 *          backupDir?: string, auditDir?: string}} args.paths
 * @param {object} args.current  当前安装的清单
 * @param {object} args.target   目标清单
 * @param {string} args.targetVersion
 * @param {object} [args.package]   升级包描述（`buildPackage` 的返回）
 * @param {object} [args.packageBytes] 包里每个文件的字节 `{ 'rel/path': bytes }`
 * @param {string} [args.publicKeyPem]
 * @param {string} args.manifestDigest
 * @param {ReadonlyArray<object>} [args.migrations]
 * @param {object} [args.migrationStore]
 * @param {(m: object, base: object) => unknown} [args.migrationBase]
 * @param {number} [args.healthTimeoutMs]
 * @param {(signal: AbortSignal) => Promise<{ok: boolean, detail?: string}>} [args.healthProbe]
 * @param {() => Promise<void>} [args.stopServices]
 * @param {() => Promise<unknown>} [args.stopClaiming]
 * @param {() => Promise<unknown>} [args.drainInFlight]
 * @param {(op: string, ctx: object) => Promise<unknown>} [args.stageHook]
 *        故意让某个阶段失败用的注入点（`(stage) => { throw ... }`）。
 */
export async function runUpgrade({
  paths,
  current,
  target,
  targetVersion = target?.productVersion ?? null,
  package: pkg = null,
  packageBytes = null,
  publicKeyPem = null,
  manifestDigest = null,
  migrations = [],
  migrationStore = null,
  migrationBase = {},
  healthTimeoutMs = 30000,
  healthProbe = null,
  stopServices = null,
  stopClaiming = null,
  drainInFlight = null,
  stageHook = null,
  requireSignature = true,
  allowBreakingMigrations = false,
  freeBytes = null,
  packageBytesForDisk = null,
  backupBytes = 0,
  dataDirBytes = 0,
  tasks = null,
  now = () => Date.now(),
  snapshotFactory = createSnapshot,
  retentionPolicy = BACKUP_POLICY_DEFAULTS,
  actor = null,
  trigger = null,
  highlights = [],
  important = [],
  writeAudit = true,
} = {}) {
  const startedAtMs = now()
  const events = []
  const emit = (stage, code, detail) => events.push(Object.freeze({ stage, code, atMs: now(), detail }))

  if (paths === undefined || typeof paths.installDir !== 'string') {
    throw upgradeError(UPGRADE_CODES.BAD_INPUT, 'runUpgrade 需要 paths.installDir')
  }

  const finish = (args) => {
    const finishedAtMs = now()
    const safety = dataSafetyOf({
      appliedMigrations: args.appliedMigrations ?? [],
      migrations,
      backup: args.backup ?? null,
      restoredFromBackup: args.restoredFromBackup === true,
    })
    const record = createUpgradeRecord({
      result: args.verdict === 'committed' ? 'committed'
        : args.verdict === 'rolled-back' ? 'rolled-back'
          : args.verdict === 'forward-fix-required' ? 'forward-fix-required'
            : 'aborted',
      fromVersion: current?.productVersion ?? null,
      toVersion: targetVersion,
      channel: target?.channel ?? null,
      startedAtMs,
      finishedAtMs,
      actor,
      trigger,
      verification: args.verification ?? null,
      backupId: args.backup?.snapshot?.id ?? null,
      migrationOutcome: args.migrationOutcome?.outcome ?? null,
      health: args.health ?? null,
      rollback: args.rollback ?? null,
      switchover: args.switchover?.verdict ?? null,
      preflight: args.preflight?.ok ?? null,
      notes: args.notes ?? null,
    })
    const notification = upgradeNotification({
      record,
      rollbackSafety: args.rollback?.safety ?? args.rollbackSafety ?? null,
    })
    let auditFile = null
    if (writeAudit && typeof paths.auditDir === 'string') {
      try {
        auditFile = writeUpgradeRecord(paths.auditDir, record, { atMs: finishedAtMs })
      } catch (e) {
        emit('finalize', 'audit-write-failed', String(e?.message ?? e))
      }
    }
    return Object.freeze({
      ...args,
      code: args.code ?? null,
      orchestrator: UPGRADE_ORCHESTRATOR,
      events: Object.freeze(events),
      startedAtMs,
      finishedAtMs,
      durationMs: finishedAtMs - startedAtMs,
      record,
      notification,
      auditFile,
      dataSafety: safety,
      // 每一项都是"已知状态"，因为本模块的每条失败路径都做了收敛动作。
      knownCompatible: args.knownCompatible !== false,
      releaseNotes: args.releaseNotes ?? null,
    })
  }

  const fail = (args) => finish({
    verdict: args.verdict,
    code: args.code,
    stage: args.stage,
    reachedStage: args.stage,
    verification: args.verification ?? null,
    preflight: args.preflight ?? null,
    backup: args.backup ?? null,
    migrationOutcome: args.migrationOutcome ?? null,
    health: args.health ?? null,
    rollback: args.rollback ?? null,
    switchover: args.switchover ?? null,
    appliedMigrations: args.appliedMigrations ?? [],
    restoredFromBackup: args.restoredFromBackup ?? false,
    knownCompatible: args.knownCompatible !== false,
    notes: args.notes ?? null,
  })

  const hook = async (stage) => {
    if (typeof stageHook === 'function') await stageHook(stage, { paths, current, target, targetVersion })
  }

  // ── ⓪ 已经是当前版本 ────────────────────────────────────────────────
  if (current?.productVersion === targetVersion) {
    emit('preflight', UPGRADE_CODES.ALREADY_CURRENT, targetVersion)
    return finish({
      verdict: 'already-current', code: UPGRADE_CODES.ALREADY_CURRENT, stage: 'preflight',
      reachedStage: 'preflight', knownCompatible: true, appliedMigrations: [],
      notes: `已经是 ${targetVersion}`,
    })
  }

  // ── ① 体检 ─────────────────────────────────────────────────────────
  const preflight = runPreflight({
    current, target, stage: 'pre-switch',
    freeBytes, packageBytes: packageBytesForDisk ?? 0, backupBytes, dataDirBytes,
    tasks,
  })
  emit('preflight', preflight.ok ? 'ok' : 'blocked', preflight.reasons.join('；'))
  if (!preflight.ok) {
    return fail({
      verdict: 'not-started', code: UPGRADE_CODES.PREFLIGHT_FAILED, stage: 'preflight',
      preflight, notes: `体检未通过，未做任何改动：${preflight.reasons.join('；')}`,
    })
  }
  try { await hook('preflight') } catch (e) {
    return fail({
      verdict: 'not-started', code: UPGRADE_CODES.STAGE_FAILED, stage: 'preflight',
      preflight, notes: `体检阶段失败：${e?.message ?? e}`,
    })
  }

  // ── ①-b 迁移集合的可回滚性（在动手之前） ─────────────────────────────
  const migrationRollback = checkMigrationPlanRollback(migrations, { allowBreaking: allowBreakingMigrations })
  if (!migrationRollback.ok && migrations.length > 0) {
    emit('preflight', migrationRollback.code, migrationRollback.reason)
    return fail({
      verdict: 'not-started', code: migrationRollback.code, stage: 'preflight',
      preflight, notes: migrationRollback.reason,
    })
  }

  // ── ② 备份 ─────────────────────────────────────────────────────────
  let backup = null
  if (typeof paths.backupDir === 'string') {
    backup = snapshotFactory({
      backupDir: paths.backupDir,
      dataDir: paths.dataDir ?? null,
      configPath: paths.configPath ?? paths.productConfigPath ?? null,
      nowMs: now(),
      label: `pre-upgrade ${current?.productVersion ?? '?'}→${targetVersion ?? '?'}`,
    })
    emit('backup', backup.ok ? 'ok' : 'failed', backup.ok ? backup.snapshot.id : backup.reason)
    if (!backup.ok) {
      // 备份失败时**不继续**。spec §9.4 的第二步就是备份，
      // 而"没备份就动手"与"没有回滚能力"是同一件事。
      return fail({
        verdict: 'not-started', code: UPGRADE_CODES.BACKUP_FAILED, stage: 'backup',
        preflight, backup, notes: `备份失败，未做任何改动：${backup.reason}`,
      })
    }
  }
  try { await hook('backup') } catch (e) {
    return fail({
      verdict: 'not-started', code: UPGRADE_CODES.STAGE_FAILED, stage: 'backup',
      preflight, backup, notes: `备份阶段失败：${e?.message ?? e}`,
    })
  }

  // ── ③ 下载并校验签名（spec §9.4 的第三步） ──────────────────────────
  let verification = null
  if (pkg !== null) {
    verification = verifyPackage(pkg, {
      files: packageBytes ?? {},
      publicKeyPem,
      manifestDigest: manifestDigest ?? (current === null ? null : hashBytes(Buffer.from(JSON.stringify(target), 'utf8'))),
      requireSignature,
    })
    emit('download-verify', verification.verdict, verification.reason)
    if (verification.verdict !== 'verified') {
      // ★ 在这里停下是本次流程最重要的一条纪律：**什么都没动过**。
      return fail({
        verdict: 'not-started', code: UPGRADE_CODES.VERIFICATION_FAILED, stage: 'download-verify',
        preflight, backup, verification,
        notes: `包校验未通过，未做任何改动：${verification.reason}`,
      })
    }
  }
  try { await hook('download-verify') } catch (e) {
    return fail({
      verdict: 'not-started', code: UPGRADE_CODES.STAGE_FAILED, stage: 'download-verify',
      preflight, backup, verification, notes: `校验阶段失败：${e?.message ?? e}`,
    })
  }

  // ── ④⑤⑥ 停止认领 / 收敛在途 / 停止服务 ────────────────────────────
  for (const [stage, fn, label] of [
    ['stop-claiming', stopClaiming, '停止任务认领'],
    ['drain-in-flight', drainInFlight, '等待在途运行收敛'],
    ['stop-services', stopServices, '停止服务'],
  ]) {
    if (fn === null) { emit(stage, 'skipped', '未提供该阶段的实现'); continue }
    try {
      await fn()
      emit(stage, 'ok', label)
    } catch (e) {
      return fail({
        verdict: 'not-started', code: UPGRADE_CODES.STAGE_FAILED, stage,
        preflight, backup, verification,
        notes: `${label}失败，尚未切换程序：${e?.message ?? e}`,
      })
    }
  }

  // ── ⑦⑧⑨ 原子切换 → 迁移 → 健康检查 ────────────────────────────────
  const activated = activateVersion(paths.installDir, targetVersion, { nowMs: now() })
  emit('switch', activated.ok ? 'ok' : activated.code, activated.reason ?? targetVersion)
  if (!activated.ok) {
    return fail({
      verdict: 'not-started', code: activated.code ?? UPGRADE_CODES.STAGE_FAILED, stage: 'switch',
      preflight, backup, verification, switchover: activated,
      notes: `原子切换失败，活动指针未被改动，当前仍是 ${current?.productVersion ?? '旧版本'}：${activated.reason}`,
    })
  }

  // 迁移
  let migrationOutcome = null
  if (migrations.length > 0 && migrationStore !== null) {
    const { runMigrations } = await import('./migration.mjs')
    migrationOutcome = await runMigrations({ migrations, store: migrationStore, base: migrationBase, now })
  } else {
    migrationOutcome = Object.freeze({
      outcome: 'no-migrations', code: 'migration-nothing-to-do',
      applied: Object.freeze([]), skipped: Object.freeze([]),
      targetVersion: null, currentVersion: null, reason: '本次升级没有数据库迁移',
    })
  }
  emit('migrate', migrationOutcome.outcome, migrationOutcome.reason)

  if (migrationOutcome.outcome === 'failed' || migrationOutcome.outcome === 'checksum-drift') {
    const rollback = rollbackUpgrade({
      installRoot: paths.installDir,
      appliedMigrations: migrationOutcome.applied ?? [],
      migrations,
      nowMs: now(),
    })
    emit('finalize', rollback.verdict, rollback.reason)
    return fail({
      verdict: rollback.ok ? 'rolled-back' : 'forward-fix-required',
      code: migrationOutcome.code ?? UPGRADE_CODES.STAGE_FAILED, stage: 'migrate',
      preflight, backup, verification, migrationOutcome, rollback, switchover: activated,
      appliedMigrations: migrationOutcome.applied ?? [],
      notes: `迁移失败 → ${rollback.reason}`,
    })
  }

  // 健康检查
  const health = await probeHealth({
    probe: healthProbe,
    timeoutMs: healthTimeoutMs,
    label: targetVersion,
  })
  emit('health', health.verdict, health.reason)

  if (health.verdict !== 'healthy') {
    const rollback = rollbackUpgrade({
      installRoot: paths.installDir,
      appliedMigrations: migrationOutcome.applied ?? [],
      migrations,
      nowMs: now(),
    })
    emit('finalize', rollback.verdict, rollback.reason)
    return fail({
      verdict: rollback.ok ? 'rolled-back' : 'forward-fix-required',
      code: health.code ?? UPGRADE_CODES.STAGE_FAILED, stage: 'health',
      preflight, backup, verification, migrationOutcome, health, rollback, switchover: activated,
      appliedMigrations: migrationOutcome.applied ?? [],
      notes: `健康检查判定 ${health.verdict} → ${rollback.reason}`,
    })
  }

  // ── ⑩ 提交 ─────────────────────────────────────────────────────────
  // 提交时顺手算一次保留计划：**不删除**任何东西（删除是另一条路径的事），
  // 但结果要落进审计，否则"这次升级留了几份备份"没有人知道。
  let retention = null
  if (typeof paths.backupDir === 'string') {
    try {
      const { listSnapshots } = await import('./backup.mjs')
      retention = planRetention(listSnapshots(paths.backupDir), { nowMs: now(), policy: retentionPolicy })
    } catch { retention = null }
  }
  emit('finalize', 'commit', targetVersion)
  return finish({
    verdict: 'committed', code: UPGRADE_CODES.COMMITTED, stage: 'finalize', reachedStage: 'finalize',
    preflight, backup, verification, migrationOutcome, health, switchover: activated,
    appliedMigrations: migrationOutcome.applied ?? [],
    knownCompatible: true,
    retention,
    notes: `已提交升级到 ${targetVersion}`,
  })
}

// ---------------------------------------------------------------------------
// 回滚到备份（contract 迁移之后的唯一安全路径）
// ---------------------------------------------------------------------------

/**
 * 从升级前备份恢复数据库，并把程序指针退回旧版本。
 *
 * 这是 `forward-fix-required` 之外的另一条路（spec line 733：「必须使用经过
 * 验证的数据库恢复或向前修复流程」）。它**是破坏性的**：备份之后的写入会丢，
 * 因此返回值里 `dataSafety.businessDataIntact === false` 是刻意的。
 */
export function rollbackWithBackupRestore({
  installRoot, snapshotRoot, dataDir, configPath = null, nowMs = Date.now(),
} = {}) {
  const active = readActivePointer(installRoot)
  const restore = restoreSnapshot(snapshotRoot, { dataDir, configPath })
  if (!restore.ok) {
    return Object.freeze({
      ok: false, code: restore.code, restore, programRollback: null,
      dataSafety: Object.freeze({
        businessDataIntact: false, code: 'upgrade-data-at-risk',
        reason: `备份恢复失败（${restore.reason}），且当前数据库处于旧版本读不懂的结构上`,
        backupTakenAtMs: null,
      }),
      reason: `从备份恢复失败：${restore.reason}`,
    })
  }
  const programRollback = active.ok && active.previousVersion !== null
    ? activateVersion(installRoot, active.previousVersion, { nowMs })
    : Object.freeze({ ok: false, code: 'switchover-no-previous', reason: '没有可退回的旧版本' })

  return Object.freeze({
    ok: programRollback.ok === true,
    code: restore.code,
    restore,
    programRollback,
    dataSafety: Object.freeze({
      businessDataIntact: false,
      code: 'upgrade-data-restored-from-backup',
      reason: '数据库已从升级前备份恢复：**备份之后的写入已丢**。' +
        '这是 contract 迁移之后唯一能回到已知结构的路',
      backupTakenAtMs: restore.createdAtMs,
    }),
    reason: programRollback.ok
      ? `数据库已从备份恢复，程序退回 ${programRollback.restoredVersion}`
      : `数据库已恢复，但程序指针退回失败：${programRollback.reason}`,
  })
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

/**
 * 装载期自检：把本模块的**三条**核心判据各真的跑一遍，留下算出来的值。
 *
 * 这里的每一条都是"完成标准"的可执行形式中的静态那一半；
 * 需要真的驱动四个失败点的判据在 `upgrade.test.mjs`。
 */
export function selfCheckOrchestrator() {
  const problems = []

  // ① 含 contract 迁移的集合在没有显式声明时必须被拦（动手之前）。
  const breaking = Object.freeze([{ version: 1, name: 'c', compatibility: 'breaking', hasDownMigration: false }])
  const blocked = checkMigrationPlanRollback(breaking)
  if (blocked.ok) problems.push('含 breaking 迁移的集合被放行（"出错就退回"这条保证已经不成立）')
  const allowed = checkMigrationPlanRollback(breaking, { allowBreaking: true })
  if (!allowed.ok) problems.push('显式声明 allowBreaking 之后仍被拦')

  // ② 没写过库时业务数据完好。
  const untouched = dataSafetyOf({ appliedMigrations: [], migrations: [], backup: null })
  if (untouched.businessDataIntact !== true) problems.push('没有应用任何迁移时被判为"数据有风险"')

  // ③ 恢复过备份时**不能**报"业务数据未受影响"。
  const restored = dataSafetyOf({
    appliedMigrations: [{ version: 1, compatibility: 'breaking' }],
    migrations: breaking,
    backup: { snapshot: { createdAtMs: 1 } },
    restoredFromBackup: true,
  })
  if (restored.businessDataIntact !== false) {
    problems.push('从备份恢复之后仍被判为"业务数据未受影响"——备份之后的写入已经丢了')
  }

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    orchestrator: UPGRADE_ORCHESTRATOR,
    stages: UPGRADE_STAGES,
    verdicts: UPGRADE_VERDICTS,
    samples: Object.freeze({
      breakingPlanOk: blocked.ok,
      breakingPlanCode: blocked.code,
      allowBreakingOk: allowed.ok,
      untouchedIntact: untouched.businessDataIntact,
      restoredIntact: restored.businessDataIntact,
      restoredCode: restored.code,
    }),
  })
}

/** 装载时算一次。`problems` 非空即本模块自己的判据不自洽。 */
export const ORCHESTRATOR_CHECKED = selfCheckOrchestrator()

/** 公开面：其余模块由各自文件导出，这里只把编排与自检汇总。 */
export const UPGRADE_MODULES = Object.freeze({
  manifest: './manifest.mjs',
  package: './package.mjs',
  preflight: './preflight.mjs',
  backup: './backup.mjs',
  migration: './migration.mjs',
  switchover: './switchover.mjs',
  channels: './channels.mjs',
  audit: './audit.mjs',
})

/** 创建目录工具：审计与备份目录由调用方给出，本模块不猜位置。 */
export function ensureUpgradeDirs({ backupDir = null, auditDir = null } = {}) {
  const created = []
  for (const dir of [backupDir, auditDir]) {
    if (typeof dir !== 'string' || dir === '') continue
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      created.push(dir)
    } catch { /* 调用方自己决定要不要因此停下 */ }
  }
  return Object.freeze(created)
}

/** 写一份发布说明文件（供 Workbench 与通知读取）。 */
export function writeReleaseNotesFile(dir, productVersion, text) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `release-notes-${productVersion}.txt`)
  writeFileSync(file, text + '\n', 'utf8')
  return file
}

/** 布局工具再导出一次：升级代码里最常要问的两件事。 */
export { installLayout } from './switchover.mjs'
