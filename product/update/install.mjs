// product/update/install.mjs
// ============================================================================
// 安装事务 —— 设计 §8 那九步里**第 1–6 步**（Launcher 侧）
//
// 第 7–9 步（解压、切换指针、迁移、健康检查、提交）必须由**独立进程**
// 完成（设计 §3 line 57：「不得由已退出的 Electron 进程承担恢复责任」），
// 所以它们在 `helper.mjs` 里。本模块的职责在这里截止于"把现场交给 helper"。
//
// ## 为什么每一步都要在日志里留 intent/result 一对
//
// 见 `journal.mjs` 的注释。这里只补一句关于**顺序**的：
//
//   本模块的每一个 `await` 之后都先写 result，再进入下一步。看起来啰嗦，
//   但漏掉任何一处都会在"崩在这一步之后、下一步之前"时让恢复方误判。
//   所以下面每一步都是同一个形状：
//
//     journal.intent('x')  →  做 x  →  journal.result('x')
//
// ## 失败时的处置必须与设计 §8 的失败表逐行对应
//
//   · 下载、校验、预检、备份、任务等待 → 当前版本继续跑，不动活动指针；
//   · Windows 文件占用、切换前退出失败 → 保留旧版本，恢复维护状态并提示重试；
//   · 切换后、未改数据库 → 回到旧版本；
//   · 向前兼容迁移后健康失败 → 仅在旧版本兼容性已被证明时自动回退程序；
//   · 不兼容迁移、恢复证据不足 → 保持维护模式，人工介入。
//
// 本模块能到达的失败点全在前两行，所以它的 `verdict` 只会有
// `not-started` / `maintenance-required` / `handed-off` 三种。第 7 步之后
// 的判定由 helper 负责，这里通过 `helper-report.json` 读回来。
// ============================================================================

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { sha256Hex } from './canonical.mjs'
import { createJournal, TERMINAL_PHASES } from './journal.mjs'
import { acquireBarrier, DEFAULT_DRAIN_TIMEOUT_MS, readBarrier, releaseBarrier } from './barrier.mjs'
import { destroyCredential, issueCredential } from './credential.mjs'
import { runPreflight } from '../upgrade/preflight.mjs'
import { createSnapshot, restoreSnapshot } from '../upgrade/backup.mjs'
import { checkMigrationPlanRollback, dataSafetyOf, patchPairOf } from '../upgrade/index.mjs'
import { planRollback } from '../upgrade/migration.mjs'
import { verifyPackage } from '../upgrade/package.mjs'
import { readActivePointer } from '../upgrade/switchover.mjs'

/**
 * 包文件的**裸十六进制**摘要。
 *
 * ★ 不能用 `product/upgrade/package.mjs` 的 `hashFile`：它返回
 *   `sha256:<hex>`（带前缀），而设计 §5 规定发行清单里的 `package.sha256`
 *   是「64 位十六进制摘要」。两个口径直接比较会**永远不相等**——而它的
 *   表现是一次永远失败的安装，错误信息还很像"包被换了"。
 *
 *   所以这里用 `canonical.mjs` 的 `sha256Hex`：全仓只有那一处定义裸摘要。
 */
function packageDigestOf(path) {
  return sha256Hex(readFileSync(path))
}

export const INSTALL_ORCHESTRATOR = 'legion/update-install@1'

/** 本模块能产生的落点。每一个都是"已知状态"。 */
export const INSTALL_VERDICTS = Object.freeze([
  /** 出错之前没有动过任何东西（含"被检查拦住"）。 */
  'not-started',
  /** 动过（立了屏障/做了备份）但没换程序：停在维护状态，可重试。 */
  'maintenance-required',
  /** 现场已交给 helper；最终结论由 helper 的报告给出。 */
  'handed-off',
])

/** 需要写 intent/result 的步骤，顺序即执行顺序。 */
export const INSTALL_STEPS = Object.freeze([
  'lock',
  'recheck',
  'prepare',
  'barrier',
  'backup',
  'stop-claiming',
  'drain-in-flight',
  'stop-services',
  'handoff',
])

export const INSTALL_CODES = Object.freeze({
  BAD_INPUT: 'install-bad-input',
  BUSY: 'install-busy',
  LOCKED: 'install-locked',
  RECHECK_FAILED: 'install-recheck-failed',
  PREPARE_FAILED: 'install-prepare-failed',
  BARRIER_FAILED: 'install-barrier-failed',
  BACKUP_FAILED: 'install-backup-failed',
  DRAIN_TIMEOUT: 'install-drain-timeout',
  SERVICES_REFUSED: 'install-services-refused',
  HANDLE_HELD: 'install-handle-held',
  HANDOFF_FAILED: 'install-handoff-failed',
  COMPLETED: 'install-completed',
  ROLLED_BACK: 'install-rolled-back',
  RECOVERY_REQUIRED: 'install-recovery-required',
})

/** helper 报告的落点（设计 §8 失败表的后两行）。 */
export const HELPER_VERDICTS = Object.freeze(['committed', 'rolled-back', 'recovery-required'])

const REPORT_FILENAME = 'helper-report.json'

export function helperReportPath(dataDir) {
  return join(dataDir, 'update', REPORT_FILENAME)
}

/** 事务 ID：时间 + 随机。日志与凭证都靠它把"这一次"与"上一次"分开。 */
export function newTransactionId(now = () => Date.now(), random = randomBytes) {
  return `ut-${now().toString(36)}-${random(6).toString('hex')}`
}

function installError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * 跑一次安装事务。
 *
 * 全部外部效果都是注入的。这不是为了灵活——是因为**四个失败点必须能被
 * 真的驱动到**（与 `product/upgrade/index.mjs` 同一条理由），而真实世界里
 * 没法按需制造"服务拒绝退出"或"备份验证失败"。
 *
 * @param {object} args
 * @param {{installDir: string, dataDir: string, configPath?: string, backupDir?: string, cacheDir?: string,
 *          helperDir?: string}} args.paths
 * @param {object} args.current           当前产品清单
 * @param {object} args.release           已验签的发行清单（含身份与产物）
 * @param {object} args.identity          `{releaseId, productVersion, manifestSha256, …}`
 * @param {string} args.packagePath       已下载并校验过摘要的包
 * @param {object} args.package           升级包描述（`product/upgrade/package.mjs` 的 `buildPackage` 产物）
 * @param {(args: object) => Promise<object>} args.spawnHelper
 *        启动独立 helper。它必须**返回进程已退出的证据**（见 `verifyExit`）。
 * @param {(args: object) => Promise<{ok: boolean, detail?: string}>} [args.verifyExit]
 *        核对受管进程与 Electron 都已退出、句柄已释放（设计 §8 第 6 步）。
 */
export async function runInstallTransaction({
  paths,
  current,
  release,
  identity,
  packagePath,
  package: pkg = null,
  publicKeyPem = null,
  manifestDigest = null,
  // —— 注入的效果 ——
  stopClaiming = null,
  drainInFlight = null,
  stopServices = null,
  spawnHelper = null,
  verifyExit = null,
  pendingTasks = null,
  /** 任务读数（交付给预检）。`null` 会被预检判为"未知"而拦截——这是刻意的：
   *  「查不到在途任务」与「没有在途任务」必须分开（见 preflight.mjs）。 */
  tasks = null,
  // —— 预检与备份的参数 ——
  freeBytes = null,
  backupBytes = 0,
  dataDirBytes = 0,
  migrations = [],
  allowBreakingMigrations = false,
  patchBindings = null,
  minWindowsBuild = null,
  windowsBuild = null,
  // —— 时间与策略 ——
  drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
  now = () => Date.now(),
  journalFactory = createJournal,
  snapshotFactory = createSnapshot,
  readActivePointerImpl = readActivePointer,
  helperLauncher = null,
  txnId = null,
} = {}) {
  const startedAtMs = now()
  const events = []
  const emit = (step, code, detail = null) => events.push(Object.freeze({ step, code, atMs: now(), detail }))
  const id = txnId ?? newTransactionId(now)

  if (paths === undefined || typeof paths.installDir !== 'string' || typeof paths.dataDir !== 'string') {
    throw installError(INSTALL_CODES.BAD_INPUT, 'runInstallTransaction 需要 paths.installDir 与 paths.dataDir')
  }
  if (release === null || release === undefined || typeof release !== 'object') {
    throw installError(INSTALL_CODES.BAD_INPUT, 'runInstallTransaction 需要已验签的 release')
  }
  if (typeof packagePath !== 'string' || !existsSync(packagePath)) {
    throw installError(INSTALL_CODES.BAD_INPUT, `升级包不存在：${packagePath}`)
  }

  const journal = journalFactory({ dataDir: paths.dataDir, txnId: id, owner: 'launcher', now })

  const finish = (verdict, code, extra = {}) => Object.freeze({
    ok: verdict === 'handed-off',
    orchestrator: INSTALL_ORCHESTRATOR,
    txnId: id,
    verdict,
    code,
    identity,
    reachedStep: extra.reachedStep ?? null,
    events: Object.freeze(events),
    startedAtMs,
    finishedAtMs: now(),
    journalFile: journal.file,
    reason: extra.reason ?? null,
    ...extra,
  })

  // ── ⓪ 已经有未完成的事务？──
  //
  // 读**活动描述符**而不是读内存标志：另一个进程（或上一次崩溃）留下的事务
  // 必须能挡住这一次。
  const existingBarrier = readBarrier(paths.dataDir)
  if (existingBarrier.held && existingBarrier.barrier.txnId !== id) {
    return finish('not-started', INSTALL_CODES.BUSY,
      { reachedStep: 'lock', reason: `已经有一个升级事务在进行中：${existingBarrier.barrier.txnId}`, barrier: existingBarrier })
  }

  // ── ① 取得事务锁，记录身份，重新检查兼容性/签名/空间 ──
  journal.begin({
    fromVersion: current?.productVersion ?? null,
    toVersion: identity?.productVersion ?? null,
    releaseId: identity?.releaseId ?? null,
    phase: 'preflight',
  })
  journal.intent('lock', { txnId: id, fromVersion: current?.productVersion ?? null, toVersion: identity?.productVersion ?? null })
  journal.result('lock', { txnId: id })

  journal.intent('recheck', { manifestDigest, releaseId: identity?.releaseId ?? null, packagePath })
  // ★ 重新核对包摘要。用户点"安装"与真正开始之间可能隔了很久（先"稍后安装"），
  //   缓存里的文件可能已经被清理、替换或被磁盘错误损坏。
  const actualPackageSha = packageDigestOf(packagePath)
  if (typeof release.package?.sha256 === 'string' && actualPackageSha !== release.package.sha256) {
    journal.result('recheck', { ok: false, actualPackageSha })
    return finish('not-started', INSTALL_CODES.RECHECK_FAILED, {
      reachedStep: 'recheck',
      reason: `升级包摘要不符（清单 ${String(release.package.sha256).slice(0, 12)}…，实际 ${String(actualPackageSha).slice(0, 12)}…），未做任何改动`,
      packageSha256: actualPackageSha,
    })
  }
  if (pkg !== null) {
    const verification = verifyPackage(pkg, {
      files: {}, publicKeyPem, manifestDigest, requireSignature: publicKeyPem !== null,
      actualContentDigest: null,
    })
    // 只把"拒绝"当成阻断：`verifyPackage` 在没有逐文件字节时会报
    // `ok` 之外的读数，而逐文件校验属于解压阶段（第 7 步）的职责。
    if (verification.verdict === 'rejected') {
      journal.result('recheck', { ok: false, verdict: verification.verdict, reason: verification.reason })
      return finish('not-started', INSTALL_CODES.RECHECK_FAILED, {
        reachedStep: 'recheck', verification,
        reason: `包签名/完整性校验未通过，未做任何改动：${verification.reason}`,
      })
    }
  }
  const preflight = runPreflight({
    current,
    target: release.productManifest ?? release,
    stage: 'pre-switch',
    freeBytes,
    packageBytes: release.package?.sizeBytes ?? 0,
    backupBytes,
    dataDirBytes,
    // ★ 两处都必须由调用方真的给出读数，缺一个预检就会拦：
    //   · `tasks`  —— 「查不到在途任务」不等于「没有在途任务」；
    //   · `patchPair` —— 「没有验证过成对」不等于「成对已验证」。
    //   之前漏传 `tasks`/`patchBindings` 时，调用方拿到的是一句
    //   "预检未通过"，而真正的原因（我没给读数）不在里面。
    tasks,
    patchPair: patchPairOf(release.productManifest ?? release, patchBindings),
    minWindowsBuild,
    windowsBuild,
  })
  if (!preflight.ok) {
    journal.result('recheck', { ok: false, reason: preflight.reasons })
    return finish('not-started', INSTALL_CODES.RECHECK_FAILED, {
      reachedStep: 'recheck', preflight,
      reason: `预检未通过，未做任何改动：${preflight.reasons.join('；')}`,
    })
  }
  const migrationRollback = checkMigrationPlanRollback(migrations, { allowBreaking: allowBreakingMigrations })
  if (!migrationRollback.ok && migrations.length > 0) {
    journal.result('recheck', { ok: false, reason: migrationRollback.reason })
    return finish('not-started', INSTALL_CODES.RECHECK_FAILED, {
      reachedStep: 'recheck', migrationRollback,
      reason: migrationRollback.reason,
    })
  }
  journal.result('recheck', { ok: true, actualPackageSha, preflightOk: true })

  // ── ② 准备目标运行时（不改变活动指针）──
  //
  // ★ 网络/准备失败在**这里**停下，且此时什么都还没动（设计 §8 第 2 步）。
  journal.intent('prepare', { releaseId: identity?.releaseId ?? null })
  if (helperLauncher !== null && typeof helperLauncher.prepare === 'function') {
    try {
      const prepared = await helperLauncher.prepare({ release, identity, packagePath })
      if (prepared?.ok !== true) {
        journal.result('prepare', { ok: false, reason: prepared?.reason ?? null })
        return finish('not-started', INSTALL_CODES.PREPARE_FAILED, {
          reachedStep: 'prepare',
          reason: `准备目标运行时失败，未做任何改动：${prepared?.reason ?? '未说明原因'}`,
        })
      }
      journal.result('prepare', { ok: true, detail: prepared.detail ?? null })
    } catch (error) {
      journal.result('prepare', { ok: false, reason: String(error?.message ?? error) })
      return finish('not-started', INSTALL_CODES.PREPARE_FAILED, {
        reachedStep: 'prepare',
        reason: `准备目标运行时失败，未做任何改动：${error?.message ?? error}`,
      })
    }
  } else {
    journal.result('prepare', { ok: true, skipped: true })
  }

  // ── ④ 维护屏障（在停服务**之前**，见 barrier.mjs 的注释）──
  journal.intent('barrier-acquire', { txnId: id })
  const barrier = acquireBarrier({ dataDir: paths.dataDir, txnId: id, reason: `升级到 ${identity?.productVersion ?? '新版本'}`, now })
  if (!barrier.ok) {
    journal.result('barrier-acquire', { ok: false, reason: barrier.reason })
    return finish('not-started', INSTALL_CODES.BARRIER_FAILED, {
      reachedStep: 'barrier', barrier,
      reason: `无法建立维护屏障，未做任何改动：${barrier.reason}`,
    })
  }
  journal.result('barrier-acquire', { ok: true, reason: barrier.reason })
  journal.advance('barrier', '维护屏障已建立')

  // ── ⑤ 备份（屏障之内，所以快照是一致的）──
  let backup = null
  const backupDir = typeof paths.backupDir === 'string' ? paths.backupDir : null
  if (backupDir !== null) {
    journal.intent('backup', { backupDir })
    backup = snapshotFactory({
      backupDir,
      dataDir: paths.dataDir,
      configPath: paths.configPath ?? null,
      nowMs: now(),
      label: `pre-update ${current?.productVersion ?? '?'}→${identity?.productVersion ?? '?'}`,
    })
    if (backup.ok !== true) {
      // ★ 备份失败**立即停止**，并且**释放屏障**——因为此刻真的什么都没改，
      //   把用户锁在维护状态里换不到任何安全性。
      journal.result('backup', { ok: false, reason: backup.reason })
      releaseBarrier(paths.dataDir, id)
      journal.finish('rolled-back', { reason: `备份失败：${backup.reason}` })
      destroyCredential(paths.dataDir)
      return finish('not-started', INSTALL_CODES.BACKUP_FAILED, {
        reachedStep: 'backup', backup, preflight,
        reason: `备份失败，未做任何改动：${backup.reason}`,
      })
    }
    journal.result('backup', { ok: true, snapshotId: backup.snapshot?.id ?? null })
  } else {
    journal.intent('backup', { skipped: true })
    journal.result('backup', { ok: true, skipped: true })
  }
  journal.advance('backup', backup?.snapshot?.id ?? '没有备份目录')

  // ── ③⑥ 停止认领 / 等待在途任务 / 停止服务 ──
  //
  // ★ 这三步失败时**保持维护状态**（设计 §8 失败表第二行："保留旧版本，
  //   恢复维护状态并提示重试"）。为什么不像备份失败那样直接放行：
  //   此刻认领可能已经被停掉、服务可能已经停了一半，直接把用户放回去
  //   会得到一个"看起来正常但少了几个服务"的 Legion。
  const maintenance = (step, code, reason, extra = {}) => {
    journal.advance('recovery-required', reason)
    return finish('maintenance-required', code, { reachedStep: step, backup, preflight, reason, ...extra })
  }

  if (typeof stopClaiming === 'function') {
    journal.intent('stop-claiming', null)
    try {
      await stopClaiming()
      journal.result('stop-claiming', { ok: true })
      journal.advance('stop-claiming', '已停止任务认领')
    } catch (error) {
      journal.result('stop-claiming', { ok: false, reason: String(error?.message ?? error) })
      return maintenance('stop-claiming', INSTALL_CODES.SERVICES_REFUSED, `停止任务认领失败：${error?.message ?? error}`)
    }
  } else {
    journal.intent('stop-claiming', { skipped: true })
    journal.result('stop-claiming', { ok: true, skipped: true })
  }

  journal.intent('drain-in-flight', { pendingTasks: Array.isArray(pendingTasks) ? pendingTasks.length : null, timeoutMs: drainTimeoutMs })
  if (typeof drainInFlight === 'function') {
    let drained
    try {
      drained = await drainInFlight({ timeoutMs: drainTimeoutMs, pendingTasks })
    } catch (error) {
      drained = { ok: false, reason: String(error?.message ?? error) }
    }
    if (drained?.ok !== true) {
      journal.result('drain-in-flight', { ok: false, reason: drained?.reason ?? null })
      // ★ 设计 §7 line 150：「超时回到可选择界面，不默认强杀。」
      //   所以超时是一个**可选择**的落点，而不是"强行继续"。
      return maintenance('drain-in-flight', INSTALL_CODES.DRAIN_TIMEOUT,
        `等待在途任务结束未完成：${drained?.reason ?? '超时'}。当前版本未被改动，可稍后重试或先取消任务`, { drained })
    }
    journal.result('drain-in-flight', { ok: true, detail: drained.detail ?? null })
    journal.advance('drain-in-flight', '在途任务已收敛')
  } else {
    journal.result('drain-in-flight', { ok: true, skipped: true })
  }

  if (typeof stopServices === 'function') {
    journal.intent('stop-services', null)
    try {
      await stopServices()
      journal.result('stop-services', { ok: true })
      journal.advance('stop-services', '受管服务已停止')
    } catch (error) {
      journal.result('stop-services', { ok: false, reason: String(error?.message ?? error) })
      return maintenance('stop-services', INSTALL_CODES.SERVICES_REFUSED,
        `停止受管服务失败，尚未切换程序：${error?.message ?? error}`)
    }
  } else {
    journal.intent('stop-services', { skipped: true })
    journal.result('stop-services', { ok: true, skipped: true })
  }

  // ── ⑥-b 核对退出身份与进程树；句柄未释放则安全中止 ──
  if (typeof verifyExit === 'function') {
    const exit = await verifyExit()
    journal.note('verify-exit', { ok: exit?.ok === true, detail: exit?.detail ?? null })
    if (exit?.ok !== true) {
      // ★ 设计 §8 失败表第二行：「Windows 文件占用、切换前退出失败 → 保留
      //   旧版本，恢复维护状态并提示重试」。这里**不**继续交接 helper——
      //   交接之后 helper 会去替换一个仍被占用的目录，而那在 Windows 上
      //   会以"部分文件已替换"结束。
      return maintenance('verify-exit', INSTALL_CODES.HANDLE_HELD,
        `受管进程或桌面端尚未完全退出（${exit?.detail ?? '句柄可能仍被占用'}），已保留旧版本，请稍后重试`)
    }
  }

  // ── ⑦ 交接：签发一次性凭证并启动独立 helper ──
  journal.intent('helper-handoff', { helperDir: paths.helperDir ?? null })
  const credential = issueCredential({
    dataDir: paths.dataDir,
    txnId: id,
    toVersion: identity?.productVersion ?? null,
    fromVersion: current?.productVersion ?? null,
    releaseId: identity?.releaseId ?? null,
    packageSha256: actualPackageSha,
    now,
  })
  if (!credential.ok) {
    journal.result('helper-handoff', { ok: false, reason: credential.reason })
    return maintenance('handoff', INSTALL_CODES.HANDOFF_FAILED, `签发一次性事务凭证失败：${credential.reason}`)
  }
  if (typeof spawnHelper !== 'function') {
    journal.result('helper-handoff', { ok: false, reason: '没有可用的 helper 启动方式' })
    return maintenance('handoff', INSTALL_CODES.HANDOFF_FAILED, '没有配置独立升级 helper，无法完成程序切换')
  }

  let handoff
  try {
    handoff = await spawnHelper({
      txnId: id,
      dataDir: paths.dataDir,
      installDir: paths.installDir,
      cacheDir: paths.cacheDir ?? null,
      helperDir: paths.helperDir ?? null,
      credentialFile: credential.credential === null ? null : join(paths.dataDir, 'update', 'transaction-credential.json'),
      fromVersion: current?.productVersion ?? null,
      toVersion: identity?.productVersion ?? null,
      releaseId: identity?.releaseId ?? null,
      packagePath,
      packageSha256: actualPackageSha,
      backupSnapshotRoot: backup?.snapshot?.root ?? backup?.root ?? null,
      migrations,
      allowBreakingMigrations,
    })
  } catch (error) {
    handoff = { ok: false, reason: String(error?.message ?? error) }
  }

  journal.advance('handoff', `helper 已启动：${handoff?.ok === true ? '是' : '否'}`)
  if (handoff?.ok !== true) {
    journal.result('helper-handoff', { ok: false, reason: handoff?.reason ?? null })
    return maintenance('handoff', INSTALL_CODES.HANDOFF_FAILED,
      `启动独立升级 helper 失败：${handoff?.reason ?? '未说明原因'}。旧版本仍然完好`)
  }
  journal.result('helper-handoff', { ok: true, pid: handoff.pid ?? null })

  // 交接之后请求方（Electron）就地退出。最终结论由 helper 写回报告，
  // 下一次启动时由 `readHelperReport` 读出来。
  return finish('handed-off', INSTALL_CODES.COMPLETED, {
    reachedStep: 'handoff',
    backup,
    preflight,
    helperPid: handoff.pid ?? null,
    reportPath: helperReportPath(paths.dataDir),
    reason: `现场已交给独立升级 helper（事务 ${id}）。程序切换与验证由它在服务停止后完成`,
  })
}

/**
 * 读 helper 的结论。
 *
 * 下一次启动时，Launcher（或界面）用它回答"上次那一次升级最后怎么了"。
 * 读不出来时返回 `null`——那意味着 helper 还没写，或者写了一半；
 * 两种都不该被当成"没发生过升级"（那件事由 `journal.planRecovery` 判定）。
 */
export function readHelperReport(dataDir) {
  const file = helperReportPath(dataDir)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!HELPER_VERDICTS.includes(parsed?.verdict)) return null
    return Object.freeze(parsed)
  } catch {
    return null
  }
}

/** helper 写回报告（由 helper 调用）。原子替换，理由同活动描述符。 */
export function writeHelperReport(dataDir, report) {
  const file = helperReportPath(dataDir)
  mkdirSync(join(dataDir, 'update'), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  renameSync(temp, file)
  return file
}

/** 清理 helper 报告（用户看过结果、或开始新一次升级时）。 */
export function clearHelperReport(dataDir) {
  try { rmSync(helperReportPath(dataDir), { force: true }); return true } catch { return false }
}

/**
 * 把 helper 的结论折成"业务数据丢没丢"的读数。
 *
 * 与 `product/upgrade/index.mjs` 的 `dataSafetyOf` 同一条纪律：
 * **从备份恢复本身就是一次破坏性动作**，所以 `businessDataIntact` 是 false。
 */
export function helperDataSafety(report) {
  if (report === null || report === undefined) {
    return Object.freeze({ businessDataIntact: null, code: 'install-no-report', reason: 'helper 尚未给出结论' })
  }
  if (report.verdict === 'committed') {
    return Object.freeze({
      businessDataIntact: true, code: 'install-data-preserved',
      reason: report.migrationOutcome === 'no-migrations'
        ? '本次升级没有数据库迁移：业务数据未被改动'
        : '本次升级的迁移已在验证通过后提交',
    })
  }
  if (report.restoredFromBackup === true) {
    return Object.freeze({
      businessDataIntact: false, code: 'install-data-restored-from-backup',
      reason: '数据库已从升级前备份恢复：备份之后的写入已丢',
    })
  }
  if (report.verdict === 'rolled-back') {
    return Object.freeze({
      businessDataIntact: true, code: 'install-data-preserved',
      reason: '程序已退回旧版本，数据库未被迁移改动',
    })
  }
  return Object.freeze({
    businessDataIntact: false, code: 'install-data-at-risk',
    reason: '升级未能完成且证据不足以判断数据库状态：请勿继续写入，按管理员指引处理',
  })
}

/**
 * 由 helper 的报告推出最终 verdict 与"是不是已知兼容状态"。
 *
 * `knownCompatible` 不是"成功与否"：一次"什么都没做"的失败也是已知兼容的。
 */
export function finalVerdict(report, { currentVersion = null } = {}) {
  if (report === null || report === undefined) {
    return Object.freeze({
      verdict: 'recovery-required', code: INSTALL_CODES.RECOVERY_REQUIRED, knownCompatible: false,
      reason: '没有 helper 的报告，无法判断升级结果；请勿删除数据目录',
    })
  }
  switch (report.verdict) {
    case 'committed':
      return Object.freeze({
        verdict: 'committed', code: INSTALL_CODES.COMPLETED, knownCompatible: true,
        reason: `已升级到 ${report.toVersion ?? currentVersion ?? '新版本'}`,
      })
    case 'rolled-back':
      return Object.freeze({
        verdict: 'rolled-back', code: INSTALL_CODES.ROLLED_BACK, knownCompatible: true,
        reason: `升级失败，已退回 ${report.fromVersion ?? currentVersion ?? '旧版本'}；业务数据未被替换`,
      })
    default:
      return Object.freeze({
        verdict: 'recovery-required', code: INSTALL_CODES.RECOVERY_REQUIRED, knownCompatible: false,
        reason: report.reason ?? '升级未完成且不能自动恢复，请联系管理员',
      })
  }
}

export function selfCheckInstall() {
  const problems = []
  // 三个落点都必须被声明（表里缺一个会在装载期暴露）。
  for (const verdict of ['not-started', 'maintenance-required', 'handed-off']) {
    if (!INSTALL_VERDICTS.includes(verdict)) problems.push(`落点 ${verdict} 没有声明`)
  }
  // 设计 §8 的九步里，Launcher 侧要做的那些都要在步骤表里。
  for (const step of ['lock', 'recheck', 'barrier', 'backup', 'stop-claiming', 'drain-in-flight', 'stop-services', 'handoff']) {
    if (!INSTALL_STEPS.includes(step)) problems.push(`步骤 ${step} 不在表里`)
  }
  // 事务 ID 必须每次不同。
  const a = newTransactionId()
  const b = newTransactionId()
  if (a === b) problems.push('事务 ID 不是唯一的')
  // 没有报告时的最终结论必须是"需要人工"，不能是"成功"。
  const none = finalVerdict(null)
  if (none.knownCompatible !== false || none.verdict !== 'recovery-required') {
    problems.push('缺少 helper 报告时没有落到 recovery-required')
  }
  // 从备份恢复必须报"数据有损"。
  const restored = helperDataSafety({ verdict: 'recovery-required', restoredFromBackup: true })
  if (restored.businessDataIntact !== false) problems.push('从备份恢复之后仍被判为"业务数据未受影响"')
  const committed = helperDataSafety({ verdict: 'committed', migrationOutcome: 'no-migrations' })
  if (committed.businessDataIntact !== true) problems.push('提交且无迁移时被判为"数据有损"')
  if (!TERMINAL_PHASES.includes('committed')) problems.push('committed 不是终态')
  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    steps: INSTALL_STEPS,
    verdicts: INSTALL_VERDICTS,
  })
}

export const INSTALL_CHECKED = selfCheckInstall()
