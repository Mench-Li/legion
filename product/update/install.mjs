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
import { createSnapshot } from '../upgrade/backup.mjs'
import { checkMigrationPlanRollback, dataSafetyOf, patchPairOf } from '../upgrade/index.mjs'
import { migrationPlanDigest, planRollback } from '../upgrade/migration.mjs'
import { verifyPackage } from '../upgrade/package.mjs'

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
  // ★ 原本这里还有一个 `LOCKED: 'install-locked'`，已删除。
  //   "已经有另一个升级事务在跑"这条判据**在**（第 ① 步取得事务锁之前那一次
  //   屏障复查），它落到的码是 `BUSY`。声明了却不发出的码会让人以为
  //   "锁被占用"与"事务进行中"是两个分开的读数，而实际上只有一个。
  RECHECK_FAILED: 'install-recheck-failed',
  /**
   * 发行清单声明的固定迁移计划与本次将要执行的集合不一致。
   *
   * 与 `RECHECK_FAILED` 分开的**理由**：前者是"包里/清单里的东西不对"，
   * 而这一条是"**声明与实现**对不上"。它们的处置相同（都在动任何东西之前
   * 停下），但排查方向完全不同——一条要去看包，一条要去看发布端有没有把
   * 迁移计划接上。共用一个码会让后者永远被读成前者。
   */
  MIGRATION_PLAN_MISMATCH: 'install-migration-plan-mismatch',
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
 * 中止路径上把认领还回去。
 *
 * ★ 为什么需要它：第 3 步停了认领之后，**第 4、5 步仍然可能放弃**
 *   （屏障建不起来、备份失败）。而那些失败的设计落点是"当前版本继续运行"
 *   （设计 §8 失败表第一行）——"继续运行"必须包含"还能领活"。
 *
 *   否则用户会得到一个**看起来完全正常**的 Legion：服务都在、界面能开、
 *   只是再也领不到任何活。而那件事没有任何界面读数会提示他。
 *
 * ★ 恢复失败**不改变**本次事务的结论：升级已经放弃了，多一个"恢复认领也失败"
 *   只应被记进日志，不该把一个"未开始"变成"维护中"——那会让用户为一件事
 *   付两次代价。但它是**如实记下**的，不是吞掉。
 */
async function resumeClaimingAfterAbort(journal, resumeClaiming) {
  if (typeof resumeClaiming !== 'function') return
  try {
    const resumed = await resumeClaiming()
    if (resumed?.ok === true) {
      journal.note('resume-claiming', { ok: true, detail: resumed.reason ?? null })
      return
    }
    journal.note('resume-claiming', { ok: false, reason: resumed?.reason ?? '恢复认领没有成功' })
  } catch (error) {
    journal.note('resume-claiming', { ok: false, reason: String(error?.message ?? error) })
  }
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
  /**
   * 恢复认领。**与 `stopClaiming` 成对**：中止路径上必须把它还回去。
   *
   * ★ 没有它就不该停认领。设计 §7 line 150 对超时说的「回到可选择界面」
   *   指的是"用户回到一个能正常干活的 Legion"——而一个认领被停掉、又不恢复
   *   的 Legion，界面上看起来完全正常，只是再也领不到活。
   */
  resumeClaiming = null,
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

  // ★★ 迁移计划必须与发行清单声明的**固定迁移计划**一致。
  //
  //   在加这条判据之前：`release.mjs` 只校验 `migrationPlanDigest` 的**格式**，
  //   全仓没有一处拿它去和任何内容比对，而桌面侧从不传 `migrations` ——
  //   于是 `[]` 一路走下去，helper 报 `no-migrations` 并**提交**。
  //   一份声明了迁移计划的发行，它的迁移会被**静默跳过**：结果是
  //   "升级成功、数据库结构从未迁移"，而用户看到的每一句话都是成功的。
  //
  //   现在：声明与将要跑的集合不一致 → **拒绝**（在动任何东西之前）。
  //   方向是 fail-closed：`migrations` 的生产方还没有接上时，任何声明了
  //   非空迁移计划的发行都会被挡下，而不是被静默降级成"没有迁移"。
  const declaredPlanDigest = typeof release.migrationPlanDigest === 'string' ? release.migrationPlanDigest : null
  const actualPlanDigest = migrationPlanDigest(migrations)
  if (declaredPlanDigest !== null && declaredPlanDigest !== actualPlanDigest) {
    const reason = '发行清单声明的迁移计划与本次将要执行的集合不一致：'
      + `清单 ${declaredPlanDigest.slice(0, 12)}…（${migrations.length} 份迁移），`
      + `本次 ${actualPlanDigest.slice(0, 12)}…。`
      + '把"没跑的迁移"报成"没有迁移"，会在升级之后留下一个结构从未迁移的数据库，'
      + '而每一句成功读数都是真的'
    journal.result('recheck', { ok: false, reason, declaredPlanDigest, actualPlanDigest, migrationCount: migrations.length })
    return finish('not-started', INSTALL_CODES.MIGRATION_PLAN_MISMATCH, {
      reachedStep: 'recheck',
      declaredPlanDigest, actualPlanDigest,
      reason: `迁移计划不符，未做任何改动：${reason}`,
    })
  }
  journal.result('recheck', { ok: true, actualPackageSha, preflightOk: true, actualPlanDigest })

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

  // ── ③ 停止认领 / 等待在途任务结束（设计 §8 第 3 步）──
  //
  // ★★ 顺序：这两步**必须**排在维护屏障与备份**之前**。
  //
  //   设计的第 3/4/5/6 步是：停认领、等在途任务 → 建立屏障 → 备份 → 停服务。
  //   而原先的实现是：屏障 → 备份 → 停认领 → 等在途 → 停服务。
  //
  //   反转的后果不是"顺序不好看"，而是**第 5 步那份备份不再是设计要的那一份**：
  //
  //     · 设计第 4 步的原话是「建立覆盖所有写入入口的维护屏障**并刷新数据**；
  //       使用 SQLite backup API 或**关闭数据库后的**完整一致快照，**禁止复制
  //       孤立的 WAL 主文件**」。
  //     · 屏障是 Launcher 的一个**闸门文件**（`barrier.mjs`），它拦的是
  //       "之后还来写的进程"，**拦不住一个已经跑起来、正在写 SQLite 的任务**。
  //     · 而"在途任务"恰恰就是那些写入者。所以原顺序下的备份是**边写边拷的**：
  //       `team.db` 与它旁边的 `-wal` 是在两个不同时刻被复制的，而同一份设计
  //       明确禁止的正是这个形状。
  //
  //   备份是整次升级的**回退源**。一个不一致的回退源，会让设计 §8 失败表里
  //   「切换后、未改数据库 → 回到旧版本」这一行落在一个坏掉的库上——而那正是
  //   用户最需要它好用的时刻。
  //
  //   > 「先立屏障、所以快照是一致的」这句话里，"一致"指的是**之后没人再写**，
  //   > 而不是**此刻没有人在写**。这两件事在"备份"这个动作上不是一回事。
  //
  // ③⑥ 的失败落点也随之下移（见下面 `maintenance` 的定义处）：
  // 认领/任务这两步现在发生在**任何东西被动过之前**，所以失败时可以干净地
  // 回到"当前版本继续运行"（设计 §8 失败表第一行把"任务等待"就归在那一档）。
  if (typeof stopClaiming === 'function') {
    journal.intent('stop-claiming', null)
    try {
      await stopClaiming()
      journal.result('stop-claiming', { ok: true })
      journal.advance('stop-claiming', '已停止任务认领')
    } catch (error) {
      journal.result('stop-claiming', { ok: false, reason: String(error?.message ?? error) })
      /**
       * ★ 抛错意味着"**不知道**它停没停"——而不是"确定没停"。
       *
       *   最典型的形状是一次 `BRIDGE_TIMEOUT`：Launcher 已经在做这件事了，
       *   只是答复没回来。那种情况下认领**可能已经停了**，而我们直接返回
       *   `not-started` 会在用户手上留下一个"服务都在跑、却再也不领活"的
       *   Legion——正是 ㉓ 修掉的那个形状，只是换了条路径。
       *
       *   所以"不知道"必须解到**对用户安全**的那一边：试着把认领恢复回来。
       *   而恢复本身是幂等的（`supervisor.start()` 对已在运行的进程返回
       *   `already-running` 而不是再起一个），所以"其实没停过"时它什么也不做。
       *
       *   > 在"我不知道它处于哪个状态"的时候，
       *   > 唯一安全的动作是那个**在两种情况下都无害**的动作。
       */
      await resumeClaimingAfterAbort(journal, resumeClaiming)
      return finish('not-started', INSTALL_CODES.SERVICES_REFUSED, {
        reachedStep: 'stop-claiming', preflight,
        reason: `停止任务认领失败，未做任何改动：${error?.message ?? error}`,
      })
    }
  } else {
    journal.intent('stop-claiming', { skipped: true })
    journal.result('stop-claiming', { ok: true, skipped: true })
  }

  if (typeof drainInFlight === 'function') {
    journal.intent('drain-in-flight', { pendingTasks: Array.isArray(pendingTasks) ? pendingTasks.length : null, timeoutMs: drainTimeoutMs })
    try {
      const drained = await drainInFlight({ timeoutMs: drainTimeoutMs, pendingTasks })
      if (drained?.ok !== true) {
        journal.result('drain-in-flight', { ok: false, reason: drained?.reason ?? null })
        // ★ 超时的落点是**回到可选择界面**，不是维护态（设计 §7 line 150：
        //   「默认等待任务结束；超时回到可选择界面，不默认强杀」；设计 §8 失败表
        //   第一行也把"任务等待"归在"当前版本继续运行"那一档）。
        //
        //   而"停在维护态"会把一次**什么都没改**的取消变成一次需要人工处理的
        //   故障——用户看到的是一台起不来的 Legion，原因只是他有个任务在跑。
        //   所以：把认领还回去，然后如实说"任务还没结束，本次没装"。
        await resumeClaimingAfterAbort(journal, resumeClaiming)
        return finish('not-started', INSTALL_CODES.DRAIN_TIMEOUT, {
          reachedStep: 'drain-in-flight', preflight,
          reason: `在途任务未在期限内结束，本次安装取消，当前版本继续运行：${drained?.reason ?? ''}`,
        })
      }
      journal.result('drain-in-flight', { ok: true, detail: drained.detail ?? null })
      journal.advance('drain-in-flight', '在途任务已收敛')
    } catch (error) {
      journal.result('drain-in-flight', { ok: false, reason: String(error?.message ?? error) })
      await resumeClaimingAfterAbort(journal, resumeClaiming)
      return finish('not-started', INSTALL_CODES.DRAIN_TIMEOUT, {
        reachedStep: 'drain-in-flight', preflight,
        reason: `等待在途任务时出错，本次安装取消，当前版本继续运行：${error?.message ?? error}`,
      })
    }
  } else {
    journal.intent('drain-in-flight', { skipped: true })
    journal.result('drain-in-flight', { ok: true, skipped: true })
  }

  // ── ④ 维护屏障（在停服务**之前**，见 barrier.mjs 的注释）──
  journal.intent('barrier-acquire', { txnId: id })
  const barrier = acquireBarrier({ dataDir: paths.dataDir, txnId: id, reason: `升级到 ${identity?.productVersion ?? '新版本'}`, now })
  if (!barrier.ok) {
    journal.result('barrier-acquire', { ok: false, reason: barrier.reason })
    await resumeClaimingAfterAbort(journal, resumeClaiming)
    return finish('not-started', INSTALL_CODES.BARRIER_FAILED, {
      reachedStep: 'barrier', barrier,
      reason: `无法建立维护屏障，未做任何改动：${barrier.reason}`,
    })
  }
  journal.result('barrier-acquire', { ok: true, reason: barrier.reason })
  journal.advance('barrier', '维护屏障已建立')

  // ── ⑤ 备份（此时认领已停、在途任务已收敛，所以快照是一致的）──
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
      //   把用户锁在维护状态里换不到任何安全性。认领也要还回去：它在第 3 步
      //   被停了，而"当前版本继续运行"的意思就是它得真的能继续干活。
      journal.result('backup', { ok: false, reason: backup.reason })
      releaseBarrier(paths.dataDir, id)
      journal.finish('rolled-back', { reason: `备份失败：${backup.reason}` })
      destroyCredential(paths.dataDir)
      await resumeClaimingAfterAbort(journal, resumeClaiming)
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

  // ── ⑥ 停止受管服务 ──
  //
  // ★ 到这一步为止认领已经停了、任务已经收敛、屏障已经立着、备份已经做完。
  //   所以这里失败时的落点仍然是**维护态**（设计 §8 失败表第二行："保留旧版本，
  //   恢复维护状态并提示重试"）：服务可能已经停了一半，直接把用户放回去会得到
  //   一个"看起来正常但少了几个服务"的 Legion。
  const maintenance = (step, code, reason, extra = {}) => {
    journal.advance('recovery-required', reason)
    return finish('maintenance-required', code, { reachedStep: step, backup, preflight, reason, ...extra })
  }

  if (typeof stopServices === 'function') {
    journal.intent('stop-services', null)
    try {
      await stopServices()
      journal.result('stop-services', { ok: true })
      journal.advance('stop-services', '受管服务已停止')
    } catch (error) {
      journal.result('stop-services', { ok: false, reason: String(error?.message ?? error) })
      return maintenance('stop-services', INSTALL_CODES.SERVICES_REFUSED, `停止受管服务失败：${error?.message ?? error}`)
    }
  } else {
    journal.intent('stop-services', { skipped: true })
    journal.result('stop-services', { ok: true, skipped: true })
  }

  if (typeof verifyExit === 'function') {
    journal.intent('verify-exit', null)
    try {
      const exit = await verifyExit()
      if (exit?.ok !== true) {
        journal.result('verify-exit', { ok: false, reason: exit?.reason ?? null })
        // ★ 设计 §8 失败表第二行：「Windows 文件占用、切换前退出失败 → 保留
        //   旧版本，恢复维护状态并提示重试」。这里**不**继续交接 helper——
        //   交接之后 helper 会去替换一个仍被占用的目录，而那在 Windows 上
        //   会以"部分文件已替换"结束。
        return maintenance('verify-exit', INSTALL_CODES.HANDLE_HELD,
          exit?.reason ?? `受管进程或桌面端尚未完全退出（${exit?.detail ?? '句柄可能仍被占用'}），已保留旧版本，请稍后重试`)
      }
      journal.result('verify-exit', { ok: true, detail: exit.detail ?? null })
      journal.advance('verify-exit', '受管进程已退出')
    } catch (error) {
      journal.result('verify-exit', { ok: false, reason: String(error?.message ?? error) })
      return maintenance('verify-exit', INSTALL_CODES.HANDLE_HELD, `核对进程退出时出错：${error?.message ?? error}`)
    }
  } else {
    journal.intent('verify-exit', { skipped: true })
    journal.result('verify-exit', { ok: true, skipped: true })
  }

  // ── ⑦ 交接 helper（解压、切换、迁移、健康验证由它在服务停止后完成）──

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
