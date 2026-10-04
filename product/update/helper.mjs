// product/update/helper.mjs
// ============================================================================
// 独立升级 helper —— 设计 §8 第 7–9 步，以及 §3 line 57
//
// 原文（§3 line 57）：
//
//   「helper 位于本次事务的独立受控目录，由随包 Node 运行，启动前核对程序
//     摘要。它及所需 Node 文件不属于本次待切换的目录。不得由已退出的
//     Electron 进程承担恢复责任。」
//
// 三条硬要求，每一条都决定了本模块的形状：
//
//   ① **独立进程**：Electron（或 Launcher）交接完之后就地退出。恢复责任
//      不能挂在"刚刚被停掉的那批进程"上——它们正是被停掉才让替换成为可能
//      的，而它们退出之后就没有任何人能接着做第 8、9 步。
//
//   ② **独立受控目录**：helper 与随包 Node 不在待切换目录里。反过来的话，
//      一次"替换程序目录 → 重启 → 新版本起不来"的过程里，负责恢复的那段
//      代码本身已经被换成了未验证的新版本代码。
//
//   ③ **启动前核对程序摘要**：见 `credential.mjs` 的 `verifyProgramDigest`。
//
// ## 第 7–9 步的顺序是**不可交换**的
//
//   7. 解压并验证目标版本目录 → **同一卷内原子切换活动指针** → 启动目标程序
//   8. 新 Launcher **保持维护模式**，跑固定迁移计划、补丁自检、服务健康
//   9. 验证成功后**刷盘提交事务**，再解除维护屏障、恢复认领
//
// 容易写错的是 8 与 9 之间：迁移跑完之后如果直接解除屏障（"反正迁移成功了"），
// 那么一次在健康检查里失败的新版本会在**已经开放写入**的数据上回退，
// 而回退后的旧版本读不懂那些写入。所以屏障必须一直立到验证通过为止。
// ============================================================================

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { consumeCredential, destroyCredential, isOutsideSwitchTarget, verifyProgramDigest } from './credential.mjs'
import { createJournal } from './journal.mjs'
import { readBarrier, releaseBarrier } from './barrier.mjs'
import { helperReportPath, writeHelperReport } from './install.mjs'
import { extractArchive, verifyExtractedTree } from './extract.mjs'
import { createHealthProbe } from './health.mjs'
import { activateVersion, installLayout, listInstalledVersions, probeHealth, readActivePointer, rollbackUpgrade } from '../upgrade/switchover.mjs'
import { planRetention, listSnapshots } from '../upgrade/backup.mjs'
import { runMigrations } from '../upgrade/migration.mjs'
import { hashFile } from '../upgrade/package.mjs'
import { readFileSync as readFileSyncDefault } from 'node:fs'

export const HELPER_PROTOCOL = 'legion/update-helper@1'

export const HELPER_CODES = Object.freeze({
  BAD_INVOCATION: 'helper-bad-invocation',
  NOT_OUTSIDE: 'helper-not-outside-install-root',
  PROGRAM_DIGEST_MISMATCH: 'helper-program-digest-mismatch',
  CREDENTIAL_REJECTED: 'helper-credential-rejected',
  NO_BARRIER: 'helper-no-barrier',
  UNPACK_FAILED: 'helper-unpack-failed',
  UNPACK_INCOMPLETE: 'helper-unpack-incomplete',
  SWITCH_FAILED: 'helper-switch-failed',
  MIGRATION_FAILED: 'helper-migration-failed',
  HEALTH_FAILED: 'helper-health-failed',
  /** 「没有验证」与「验证失败」在能不能提交上是同一件事。 */
  HEALTH_UNVERIFIED: 'helper-health-unverified',
  COMMITTED: 'helper-committed',
  ROLLED_BACK: 'helper-rolled-back',
  RECOVERY_REQUIRED: 'helper-recovery-required',
})

/** helper 需要的全部注入点。默认实现是"真的去做"，测试里换成替身。 */
const DEFAULT_EFFECTS = Object.freeze({
  /**
   * 解压目标版本目录（设计 §6 line 142 + §8 第 7 步）。
   *
   * 默认实现是**真的**解压：读包 → 过五条拒绝判据 → 写进版本目录 →
   * 解压之后再核一次闭包。发布端由我们自己控制，所以这里不需要"可插拔"，
   * 需要的是"判据一定在"。注入点仍然保留（测试要能按需制造解压失败）。
   */
  unpack: defaultUnpack,
  /** 由 helper **自己**在进程内构造迁移存储（活的数据库句柄跨不过进程边界）。 */
  createMigrationStore: null,
  runMigrationsImpl: runMigrations,
  activateVersionImpl: activateVersion,
  probeHealthImpl: probeHealth,
  rollbackUpgradeImpl: rollbackUpgrade,
  // ★ 这里原本还有 `restoreSnapshotImpl: restoreSnapshot`，已删除：**它从来没被
  //   调用过**（全文件只出现那一次）。
  //
  //   它比一个无用的导入更糟：一个叫 `restoreSnapshotImpl` 的参数**看起来就是**
  //   "helper 会在失败时恢复备份"。而设计 §8 line 192 恰恰是**限制**这件事的：
  //
  //     「自动恢复备份仅限已证明维护屏障期间没有业务写入的**未提交**事务。
  //       提交后恢复旧备份可能丢失新写入，必须明确告知并取得用户确认。」
  //
  //   所以 helper 在迁移之后失败时的正确落点是 `recovery-required`（保持维护
  //   模式、交给人），**不是**自己把库换回去。留着这个参数会让下一个人以为
  //   那条自动恢复已经实现了——而"看起来实现了的危险动作"是最不该留的注释。
  //
  //   用户侧的恢复入口是另一件事（`docs/DEPLOY.md` §6 有手工步骤），见实施
  //   记录 §6.1 里如实记下的那一条。
  listInstalledVersionsImpl: listInstalledVersions,
  hashFileImpl: hashFile,
  now: () => Date.now(),
})

/**
 * 从事务文件里取出包内闭包条目。
 *
 * 两个字段都要在，且形状要对。只给一个时返回 `null` 并**不**报错——
 * "没有闭包"是一种合法的旧形态（解压端仍会拒未授权的可执行文件），
 * 而把它当成错误会让一次本来安全的升级在解压之前就失败。
 */
function normalizeClosureEntry(transaction) {
  if (transaction.closureEntry !== undefined && transaction.closureEntry !== null) {
    const entry = transaction.closureEntry
    if (typeof entry?.path === 'string' && typeof entry?.sha256 === 'string') return entry
    return null
  }
  if (typeof transaction.closurePath === 'string' && typeof transaction.closureSha256 === 'string') {
    return { path: transaction.closurePath, sha256: transaction.closureSha256 }
  }
  return null
}

/**
 * 默认解压实现。
 *
 * 返回的 `closure` 用来在**解压之后**再核一次目录内容——设计 §6 要求
 * "解压前后校验闭包"，而两次校验回答的是不同的问题：
 *
 *   · 解压**前**：这个归档允不允许展开（越界/链接/重复/炸弹/未知可执行）；
 *   · 解压**后**：展开出来的东西与计划是否逐字节一致（含"目录里有没有
 *     上次留下的残留"）。
 */
async function defaultUnpack({
  packagePath, installDir, toVersion, releaseId,
  closure = null, closureEntry = null, readFile = readFileSyncDefault, log = () => {},
} = {}) {
  const layout = installLayout(installDir)
  const targetDir = join(layout.versionsDir, toVersion)
  let archiveBytes
  try {
    archiveBytes = readFile(packagePath)
  } catch (error) {
    return { ok: false, reason: `读不到升级包 ${packagePath}：${error?.message ?? error}` }
  }
  const extracted = extractArchive({ archiveBytes, targetDir, closure, closureEntry })
  if (extracted.ok !== true) {
    return { ok: false, reason: `${extracted.code}：${extracted.reason}` }
  }
  const verdict = verifyExtractedTree({ targetDir, expected: extracted.written })
  if (verdict.ok !== true) {
    return { ok: false, reason: `解压之后的闭包核对失败：${verdict.problems.join('；')}` }
  }
  log(`[update-helper] 解压 ${extracted.fileCount} 个文件到 ${targetDir}（releaseId=${releaseId ?? '?'}）`)
  return {
    ok: true,
    detail: `${extracted.fileCount} 个文件 / ${extracted.totalBytes} 字节`,
    targetDir,
    digests: extracted.digests,
  }
}

/**
 * 跑 helper 主流程。
 *
 * @param {object} args
 * @param {{installDir: string, dataDir: string, helperDir: string}} args.paths
 * @param {object} args.transaction  事务文件的内容（由 Launcher 写好；helper 只读它）
 * @param {object} [args.effects]    注入点
 * @param {Function} [args.journalFactory]
 */
export async function runHelper({
  paths,
  transaction,
  credentialSecretHex = null,
  programFiles = {},
  expectedProgramDigests = {},
  effects = {},
  journalFactory = createJournal,
  writeReport = true,
  log = () => {},
} = {}) {
  const fx = { ...DEFAULT_EFFECTS, ...effects }
  const now = fx.now
  const startedAtMs = now()
  const steps = []
  const step = (name, ok, detail = null) => {
    steps.push(Object.freeze({ name, ok, atMs: now(), detail }))
    log(`[update-helper] ${ok ? 'ok  ' : 'FAIL'} ${name}${detail === null ? '' : `：${detail}`}`)
  }

  // ── ⓪ 调用面校验：三条硬要求 ──
  const invocation = validateInvocation({ paths, transaction })
  if (!invocation.ok) {
    step('invocation', false, invocation.reason)
    return finalize(null, {
      verdict: 'recovery-required', code: invocation.code, reason: invocation.reason, steps, startedAtMs, now,
    })
  }
  const { installDir, dataDir, helperDir } = paths
  step('invocation', true, `事务 ${transaction.txnId}`)

  // ★ ② helper 必须在待切换目录**之外**。
  if (!isOutsideSwitchTarget(helperDir, installDir)) {
    const reason = `helper 目录 ${helperDir} 与待切换的程序目录 ${installDir} 有包含关系：升级过程中执行恢复的代码自己会被替换`
    step('outside-install-root', false, reason)
    return finalize(dataDir, {
      verdict: 'recovery-required', code: HELPER_CODES.NOT_OUTSIDE, reason, steps, startedAtMs, now,
    })
  }
  step('outside-install-root', true)

  // ★ ③ 启动前核对程序摘要。
  if (Object.keys(expectedProgramDigests).length > 0) {
    const digests = verifyProgramDigest({ files: programFiles, expected: expectedProgramDigests })
    if (!digests.ok) {
      const reason = `helper 程序摘要核对失败：${digests.problems.join('；')}`
      step('program-digest', false, reason)
      return finalize(dataDir, {
        verdict: 'recovery-required', code: HELPER_CODES.PROGRAM_DIGEST_MISMATCH, reason, steps, startedAtMs, now,
      })
    }
    step('program-digest', true)
  } else {
    step('program-digest', true, '未提供期望摘要（调用方负责在真实部署中提供）')
  }

  // ── 凭证：一次性、且绑定到本次事务 ──
  const credential = consumeCredential({
    dataDir,
    secretHex: credentialSecretHex,
    expect: {
      txnId: transaction.txnId,
      dataDir,
      toVersion: transaction.toVersion ?? null,
      releaseId: transaction.releaseId ?? null,
      packageSha256: transaction.packageSha256 ?? null,
    },
    now,
  })
  if (!credential.ok) {
    // ★ 凭证不通过时**不继续**，也不解除屏障：屏障还立着，维护模式还在，
    //   现场是安全的。放行会让一个未授权（或被改动过）的事务去替换程序。
    const reason = `一次性事务凭证校验失败：${credential.reason}`
    step('credential', false, reason)
    return finalize(dataDir, {
      verdict: 'recovery-required', code: HELPER_CODES.CREDENTIAL_REJECTED, reason, steps, startedAtMs, now,
    })
  }
  step('credential', true)

  // 屏障必须仍然立着。它是"没有任何写入入口"的证明；读不出来时按"维护中"
  // 处理（见 barrier.mjs），所以这里只要求 `blocked === true`。
  const barrier = readBarrier(dataDir)
  if (!barrier.blocked) {
    const reason = '交接时维护屏障不在：无法保证备份与迁移期间没有业务写入'
    step('barrier', false, reason)
    return finalize(dataDir, {
      verdict: 'recovery-required', code: HELPER_CODES.NO_BARRIER, reason, steps, startedAtMs, now,
    })
  }
  step('barrier', true, barrier.reason)

  const journal = journalFactory({ dataDir, txnId: transaction.txnId, owner: 'helper', now })

  // ── 第 7 步：解压、验证目标版本目录、原子切换 ──
  journal.intent('unpack', { releaseId: transaction.releaseId, targetVersion: transaction.toVersion })
  let unpacked = { ok: true, skipped: true }
  if (typeof fx.unpack === 'function') {
    try {
      unpacked = await fx.unpack({
        packagePath: transaction.packagePath,
        installDir,
        toVersion: transaction.toVersion,
        releaseId: transaction.releaseId,
        expectedSha256: transaction.packageSha256,
        // 闭包的两个来源，按可信度排序：
        //   ① `closureEntry` —— 包内闭包条目，摘要在**签过名的发行清单**里
        //      （发行清单有 256 KiB 上限，放不下逐文件闭包，见 closure.mjs）。
        //   ② `closure` —— 直接给出的闭包数组（测试路径）。
        // 两者都不给时 `extractArchive` 仍然会拒可执行文件（见它的注释：
        // 一条"没给闭包所以随便进"的默认路径会在某次忘了传闭包时静默放行）。
        closureEntry: normalizeClosureEntry(transaction),
        closure: Array.isArray(transaction.closure) ? transaction.closure : null,
        log,
      })
    } catch (error) {
      unpacked = { ok: false, reason: String(error?.message ?? error) }
    }
  }
  if (unpacked?.ok !== true) {
    // 解压失败：活动指针还没动 → 保留旧版本。
    journal.result('unpack', { ok: false, reason: unpacked?.reason ?? null })
    const reason = `解压目标版本失败：${unpacked?.reason ?? '未说明原因'}。活动指针未被改动`
    step('unpack', false, reason)
    releaseBarrier(dataDir, transaction.txnId)
    journal.finish('rolled-back', reason)
    destroyCredential(dataDir)
    return finalize(dataDir, {
      verdict: 'rolled-back', code: HELPER_CODES.UNPACK_FAILED, reason, steps, startedAtMs, now,
      fromVersion: transaction.fromVersion, toVersion: transaction.toVersion,
    })
  }
  journal.result('unpack', { ok: true, detail: unpacked.detail ?? null })
  step('unpack', true)

  // 目标版本目录必须**完整**（设计 §8 第 7 步"解压并验证目标版本目录"）。
  const layout = installLayout(installDir)
  const installed = typeof fx.listInstalledVersionsImpl === 'function' ? fx.listInstalledVersionsImpl(installDir) : []
  if (Array.isArray(installed) && installed.length > 0 && !installed.includes(transaction.toVersion)) {
    const reason = `目标版本目录 ${transaction.toVersion} 在解压之后仍然不完整（已安装：${installed.join(', ')}）`
    journal.note('unpack-incomplete', { installed })
    step('unpack-complete', false, reason)
    releaseBarrier(dataDir, transaction.txnId)
    journal.finish('rolled-back', reason)
    destroyCredential(dataDir)
    return finalize(dataDir, {
      verdict: 'rolled-back', code: HELPER_CODES.UNPACK_INCOMPLETE, reason, steps, startedAtMs, now,
      fromVersion: transaction.fromVersion, toVersion: transaction.toVersion, layout: layoutVersionsDir(layout),
    })
  }
  step('unpack-complete', true)

  const before = readActivePointer(installDir)
  journal.intent('switch-pointer', { from: before?.version ?? null, to: transaction.toVersion })
  const activated = fx.activateVersionImpl(installDir, transaction.toVersion, { nowMs: now() })
  if (activated?.ok !== true) {
    journal.result('switch-pointer', { ok: false, code: activated?.code ?? null, reason: activated?.reason ?? null })
    const reason = `原子切换活动指针失败：${activated?.reason ?? '未说明原因'}。当前仍是 ${before?.version ?? '旧版本'}`
    step('switch-pointer', false, reason)
    releaseBarrier(dataDir, transaction.txnId)
    journal.finish('rolled-back', reason)
    destroyCredential(dataDir)
    return finalize(dataDir, {
      verdict: 'rolled-back', code: HELPER_CODES.SWITCH_FAILED, reason, steps, startedAtMs, now,
      fromVersion: before?.version ?? transaction.fromVersion, toVersion: transaction.toVersion,
    })
  }
  journal.result('switch-pointer', { ok: true, version: activated.version ?? transaction.toVersion })
  journal.advance('switch', `活动指针 → ${transaction.toVersion}`)
  step('switch-pointer', true, `${before?.version ?? '?'} → ${transaction.toVersion}`)

  // ── 第 8 步：迁移 + 健康检查（**保持维护模式**）──
  //
  // ★ 迁移存储必须由 helper **自己**构造。
  //
  //   事务文件是 JSON，而一个迁移存储是一个活的数据库句柄——它**跨不过
  //   进程边界**。早先的版本读的是 `transaction.migrationStore`，于是
  //   "有迁移要跑"这条分支在真实部署里**永远进不去**：helper 会安静地报
  //   `no-migrations`，然后去跑健康检查，最后提交一次**数据库没有迁移**的
  //   升级。那比"迁移失败"危险得多：它是一次成功的假象。
  journal.advance('migrate', '程序已切换，开始迁移')
  const migrations = Array.isArray(transaction.migrations) ? transaction.migrations : []
  let migrationOutcome
  const migrationStore = typeof fx.createMigrationStore === 'function'
    ? fx.createMigrationStore({ dataDir, transaction })
    : (transaction.migrationStore ?? null)
  if (migrations.length > 0 && migrationStore !== null && migrationStore !== undefined && typeof fx.runMigrationsImpl === 'function') {
    journal.intent('migrate', { count: migrations.length })
    try {
      migrationOutcome = await fx.runMigrationsImpl({
        migrations, store: migrationStore, base: transaction.migrationBase ?? {}, now,
      })
    } catch (error) {
      migrationOutcome = Object.freeze({ outcome: 'failed', code: 'migration-threw', reason: String(error?.message ?? error), applied: Object.freeze([]), failed: null })
    }
    journal.result('migrate', { outcome: migrationOutcome.outcome, reason: migrationOutcome.reason ?? null })
  } else if (migrations.length > 0) {
    // 有迁移要跑、却没有可用的存储：**这不是"没有迁移"**，是一次未知状态。
    // 放行它会得出"一次数据库未迁移的升级"。
    migrationOutcome = Object.freeze({
      outcome: 'failed', code: HELPER_CODES.MIGRATION_FAILED,
      applied: Object.freeze([]), failed: null,
      reason: `${migrations.length} 份迁移待执行，但 helper 拿不到迁移存储：不能把"不知道跑没跑"当成"没有迁移"`,
    })
    journal.result('migrate', { ok: false, reason: migrationOutcome.reason })
  } else {
    migrationOutcome = Object.freeze({
      outcome: 'no-migrations', code: 'migration-nothing-to-do',
      applied: Object.freeze([]), skipped: Object.freeze([]), reason: '本次升级没有数据库迁移',
    })
    journal.intent('migrate', { skipped: true })
    journal.result('migrate', { ok: true, skipped: true })
  }
  step('migrate', migrationOutcome.outcome === 'no-migrations' || migrationOutcome.outcome === 'applied',
    migrationOutcome.reason ?? migrationOutcome.outcome)

  if (migrationOutcome.outcome === 'failed' || migrationOutcome.outcome === 'checksum-drift') {
    // ★ 迁移失败之后能不能"仅回退程序"，取决于那份迁移的**兼容性声明**。
    //   这里复用 `product/upgrade` 的裁决，而不是自己编一个：
    //   把"写到一半的 contract 迁移当成没跑过"正是那条裁决要防的事。
    const failedDef = migrationOutcome.failed?.version === undefined || migrationOutcome.failed?.version === null
      ? null
      : migrations.find((m) => m.version === migrationOutcome.failed.version) ?? null
    const partial = migrationOutcome.failed?.partialWrites ?? null
    const nothingWritten = partial === false && migrationOutcome.outcome === 'checksum-drift'
    const fullyWritten = partial === false && migrationOutcome.outcome === 'failed'
    const appliedForSafety = fullyWritten && failedDef !== null
      ? [...(migrationOutcome.applied ?? []), { version: failedDef.version, compatibility: failedDef.compatibility }]
      : (migrationOutcome.applied ?? [])
    const failedMigrations = (nothingWritten || fullyWritten || failedDef === null) ? [] : [failedDef]
    const rollback = fx.rollbackUpgradeImpl({
      installRoot: installDir,
      appliedMigrations: appliedForSafety,
      failedMigrations,
      migrations,
      nowMs: now(),
    })
    journal.note('migration-failure', { rollbackVerdict: rollback.verdict, rollbackOk: rollback.ok })
    if (rollback.ok === true) {
      releaseBarrier(dataDir, transaction.txnId)
      journal.finish('rolled-back', rollback.reason)
      destroyCredential(dataDir)
      step('rollback', true, rollback.reason)
      return finalize(dataDir, {
        verdict: 'rolled-back', code: HELPER_CODES.MIGRATION_FAILED, reason: `迁移失败 → ${rollback.reason}`,
        steps, startedAtMs, now, migrationOutcome, rollback,
        fromVersion: before?.version ?? transaction.fromVersion, toVersion: transaction.toVersion,
      })
    }
    // 不能仅回退程序：保持维护模式，等人工。
    journal.advance('recovery-required', rollback.reason)
    destroyCredential(dataDir)
    step('rollback', false, rollback.reason)
    return finalize(dataDir, {
      verdict: 'recovery-required', code: HELPER_CODES.RECOVERY_REQUIRED,
      reason: `迁移失败且不能仅回退程序：${rollback.reason}`,
      steps, startedAtMs, now, migrationOutcome, rollback,
      fromVersion: before?.version ?? transaction.fromVersion, toVersion: transaction.toVersion,
    })
  }

  // 健康检查。**屏障仍然立着**：这一步失败要能干净地退回去。
  //
  // ★ 这里**不能** fail-open。
  //
  //   设计 §8 第 8–9 步的顺序是：新 Launcher 保持维护模式 → 跑迁移、补丁自检、
  //   服务健康验证 → **验证成功之后**才刷盘提交。也就是说"没验证"与
  //   "验证失败"在提交这件事上必须是同一个结论：不提交。
  //
  //   早先的实现把 `unsupported`（没有探针）当成通过，于是一次**没有任何
  //   健康证据**的升级会一路提交。那正是设计 §10 验收表里
  //   「切换或迁移期间断电、helper 崩溃、指针损坏 → 不能把未知状态显示成
  //   升级成功」要防的那一类，只是它出现在"验证缺席"而不是"崩溃"上。
  //
  //   所以默认是 fail-closed：没有探针 → 按失败处置（尝试回退；回退被拒则
  //   保持维护模式等人工）。部署方如果确实知道自己在做什么，可以在事务文件
  //   里显式写 `allowUnverifiedHealth: true` 来承担这个风险。
  journal.advance('validate', '开始健康检查')
  // ★ 探针的两种来源，顺序是刻意的：
  //
  //   ① `healthProbeSpec`（**声明式**，生产路径）—— 事务文件里的一组回环
  //      HTTP 检查，helper 在**本进程内**把它变成探针函数
  //      （见 `health.mjs`：函数跨不过 JSON 事务文件，而"允许事务文件带一段
  //      可执行代码"等于把 helper 变成任意代码执行器）。
  //   ② `healthProbe`（函数，测试路径）—— 只由注入产生，不来自磁盘。
  const specProbe = transaction.healthProbeSpec === undefined || transaction.healthProbeSpec === null
    ? null
    : (fx.createHealthProbe ?? createHealthProbe)(transaction.healthProbeSpec, {
      ...(fx.healthFetchImpl === undefined ? {} : { fetchImpl: fx.healthFetchImpl }),
    })
  if (specProbe !== null && specProbe.ok !== true) {
    // 规格**存在但非法**：那是一次明确的配置错误，不是"没有证据"。
    // 如实记下来，然后按不健康落地（`healthProbe` 仍然会被下面当成一个
    // 恒为 false 的探针，所以提交路径自然走不通）。
    journal.note('health-spec-invalid', { code: specProbe.code, reason: specProbe.reason })
    step('health-spec', false, specProbe.reason)
  } else if (specProbe !== null) {
    step('health-spec', true, `${transaction.healthProbeSpec.checks?.length ?? 0} 项回环检查`)
  }
  const effectiveProbe = specProbe !== null && specProbe.ok === true
    ? specProbe.probe
    : (typeof transaction.healthProbe === 'function' ? transaction.healthProbe : (specProbe === null ? null : specProbe.probe))
  const probeConfigured = typeof effectiveProbe === 'function'
  let health = probeConfigured
    ? await fx.probeHealthImpl({
      probe: effectiveProbe,
      timeoutMs: transaction.healthTimeoutMs ?? 30_000,
      label: transaction.toVersion,
    })
    : {
      verdict: 'unsupported',
      reason: '事务文件里没有健康探针（也没有 healthProbeSpec）：helper 无法确认新版本可用。'
        + '「没有验证」与「验证失败」在能不能提交上是同一件事，所以本次不提交',
    }
  if (health === null || health === undefined) health = { verdict: 'unsupported', reason: '健康探针没有给出结论' }
  journal.note('health', { verdict: health.verdict, reason: health.reason ?? null, probeConfigured })
  step('health', health.verdict === 'healthy' || (health.verdict === 'unsupported' && transaction.allowUnverifiedHealth === true),
    health.reason ?? health.verdict)

  const healthFailed = health.verdict === 'unhealthy' || health.verdict === 'timeout'
    || (health.verdict === 'unsupported' && transaction.allowUnverifiedHealth !== true)
  if (healthFailed) {
    const unverified = health.verdict === 'unsupported'
    const rollback = fx.rollbackUpgradeImpl({
      installRoot: installDir,
      appliedMigrations: migrationOutcome.applied ?? [],
      migrations,
      nowMs: now(),
    })
    journal.note('health-failure', { verdict: health.verdict, rollbackVerdict: rollback.verdict, rollbackOk: rollback.ok })
    if (rollback.ok === true) {
      releaseBarrier(dataDir, transaction.txnId)
      journal.finish('rolled-back', rollback.reason)
      destroyCredential(dataDir)
      step('rollback', true, rollback.reason)
      return finalize(dataDir, {
        verdict: 'rolled-back',
        code: unverified ? HELPER_CODES.HEALTH_UNVERIFIED : HELPER_CODES.HEALTH_FAILED,
        reason: unverified
          ? `新版本未经健康验证（${health.reason}）→ ${rollback.reason}`
          : `新版本健康检查未通过（${health.verdict}）→ ${rollback.reason}`,
        steps, startedAtMs, now, migrationOutcome, health, rollback,
        fromVersion: before?.version ?? transaction.fromVersion, toVersion: transaction.toVersion,
      })
    }
    journal.advance('recovery-required', rollback.reason)
    destroyCredential(dataDir)
    step('rollback', false, rollback.reason)
    return finalize(dataDir, {
      verdict: 'recovery-required', code: HELPER_CODES.RECOVERY_REQUIRED,
      reason: unverified
        ? `新版本未经健康验证且不能自动回退：${rollback.reason}`
        : `新版本不健康且不能自动回退：${rollback.reason}`,
      steps, startedAtMs, now, migrationOutcome, health, rollback,
      fromVersion: before?.version ?? transaction.fromVersion, toVersion: transaction.toVersion,
    })
  }

  // ── 第 9 步：提交 → **然后**才解除屏障 ──
  journal.intent('commit', { toVersion: transaction.toVersion })
  journal.result('commit', { ok: true })
  journal.advance('committed', `已提交 ${transaction.toVersion}`)

  const released = releaseBarrier(dataDir, transaction.txnId)
  journal.intent('barrier-release', { ok: released.ok })
  journal.result('barrier-release', { ok: released.ok })
  journal.finish('committed', '升级完成')
  destroyCredential(dataDir)

  // 保留策略只**算**不删（与 `product/upgrade/index.mjs` 的提交路径一致）。
  let retention = null
  if (typeof transaction.backupDir === 'string') {
    try {
      retention = planRetention(listSnapshots(transaction.backupDir), { nowMs: now() })
    } catch { retention = null }
  }

  step('commit', true, `已升级到 ${transaction.toVersion}`)
  return finalize(dataDir, {
    verdict: 'committed', code: HELPER_CODES.COMMITTED,
    reason: `已提交升级到 ${transaction.toVersion}`,
    steps, startedAtMs, now, migrationOutcome, health, retention,
    fromVersion: before?.version ?? transaction.fromVersion, toVersion: transaction.toVersion,
  }, { writeReport })
}

/**
 * 调用面校验：三条硬要求里能在这里查的两条。
 *
 * 第三条（程序摘要）在下面查，因为它需要文件系统。
 */
export function validateInvocation({ paths, transaction } = {}) {
  if (paths === null || typeof paths !== 'object') {
    return Object.freeze({ ok: false, code: HELPER_CODES.BAD_INVOCATION, reason: 'helper 需要 paths' })
  }
  for (const field of ['installDir', 'dataDir', 'helperDir']) {
    if (typeof paths[field] !== 'string' || paths[field] === '') {
      return Object.freeze({ ok: false, code: HELPER_CODES.BAD_INVOCATION, reason: `helper 需要 paths.${field}` })
    }
  }
  if (transaction === null || typeof transaction !== 'object') {
    return Object.freeze({ ok: false, code: HELPER_CODES.BAD_INVOCATION, reason: 'helper 需要事务文件内容' })
  }
  for (const field of ['txnId', 'toVersion', 'packagePath', 'packageSha256']) {
    if (typeof transaction[field] !== 'string' || transaction[field] === '') {
      return Object.freeze({ ok: false, code: HELPER_CODES.BAD_INVOCATION, reason: `事务文件缺少 ${field}` })
    }
  }
  // ★ 事务文件里的包路径只允许是**缓存目录**里已经存在的文件。
  //   设计 §7 line 162：「不信任网页输入的包路径」——所以这里的判据是
  //   "这个路径来自固定事务文件"，而固定事务文件由安装事务（主进程）
  //   写好，渲染进程无法影响它。
  if (!existsSync(transaction.packagePath)) {
    return Object.freeze({ ok: false, code: HELPER_CODES.BAD_INVOCATION, reason: `事务文件里的包不存在：${transaction.packagePath}` })
  }
  return Object.freeze({ ok: true, code: null, reason: null })
}

function layoutVersionsDir(layout) {
  return layout?.versionsDir ?? null
}

function finalize(dataDir, report, { writeReport = true } = {}) {
  const full = Object.freeze({
    protocol: HELPER_PROTOCOL,
    ...report,
    durationMs: report.now() - report.startedAtMs,
  })
  if (writeReport && typeof dataDir === 'string' && dataDir !== '') {
    try { writeHelperReport(dataDir, full) } catch { /* 报告写不进去不该掩盖结论本身 */ }
  }
  return full
}

/**
 * helper 的进程入口。
 *
 * 从**固定位置**读事务文件（设计 §7 line 162），而不是从命令行参数读——
 * 命令行是可以被同一用户下的任何进程构造的，而固定文件的位置与内容
 * 由安装事务在屏障之内写入，并且带着一次性凭证的 MAC。
 */
export async function runHelperProcess({
  dataDir,
  installDir,
  helperDir,
  readFileImpl = (path) => readFileSync(path, 'utf8'),
  stdout = process.stdout,
  effects = {},
  programFiles = {},
  expectedProgramDigests = {},
} = {}) {
  const transactionFile = join(dataDir, 'update', 'transaction.json')
  let transaction
  try {
    transaction = JSON.parse(readFileImpl(transactionFile))
  } catch (error) {
    const message = `读不到事务文件 ${transactionFile}：${error?.message ?? error}`
    stdout.write(`${JSON.stringify({ protocol: HELPER_PROTOCOL, verdict: 'recovery-required', code: HELPER_CODES.BAD_INVOCATION, reason: message })}\n`)
    return Object.freeze({ verdict: 'recovery-required', code: HELPER_CODES.BAD_INVOCATION, reason: message })
  }
  const report = await runHelper({
    paths: { installDir, dataDir, helperDir },
    transaction,
    programFiles,
    expectedProgramDigests,
    effects,
    log: (line) => stdout.write(`${line}\n`),
  })
  stdout.write(`${JSON.stringify({ protocol: HELPER_PROTOCOL, verdict: report.verdict, code: report.code })}\n`)
  return report
}

/** 写事务文件（安装事务调用；helper 只读）。原子替换。 */
export function writeTransactionFile(dataDir, transaction) {
  const file = join(dataDir, 'update', 'transaction.json')
  mkdirSync(join(dataDir, 'update'), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(transaction, null, 2)}\n`, 'utf8')
  renameSync(temp, file)
  return file
}

/** 清理事务文件（升级结束、恢复完成）。 */
export function clearTransactionFile(dataDir) {
  const file = join(dataDir, 'update', 'transaction.json')
  try { rmSync(file, { force: true }); return true } catch { return false }
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

export function selfCheckHelper() {
  const problems = []
  // 调用面校验：缺字段一律拒。
  if (validateInvocation({}).ok) problems.push('缺 paths 时调用面校验通过')
  if (validateInvocation({ paths: { installDir: 'a', dataDir: 'b', helperDir: 'c' }, transaction: {} }).ok) {
    problems.push('事务文件缺字段时调用面校验通过')
  }
  // ★ 目录关系：helper 在程序目录里必须被拒。
  if (isOutsideSwitchTarget('C:\\Legion\\helper', 'C:\\Legion')) problems.push('程序目录内的 helper 没有被拒')
  // 三个落点都要有码。
  for (const code of [HELPER_CODES.COMMITTED, HELPER_CODES.ROLLED_BACK, HELPER_CODES.RECOVERY_REQUIRED]) {
    if (typeof code !== 'string') problems.push('helper 落点缺码')
  }
  // 恢复责任不能在 Electron 侧：本模块不导入 electron。
  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    protocol: HELPER_PROTOCOL,
    reportPath: helperReportPath(join(process.cwd(), '.legion')),
  })
}

export const HELPER_CHECKED = selfCheckHelper()
