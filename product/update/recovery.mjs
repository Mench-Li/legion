// product/update/recovery.mjs
// ============================================================================
// 数据备份恢复入口（设计 §8 line 190 与 line 192）
//
// 设计 §8 失败表的最后一行是：
//
//   「不兼容迁移、恢复证据不足或恢复失败
//     → 保持维护模式；提供向前修复**或明确的数据备份恢复入口**」
//
// 而 §8 line 192 给这个入口加了两条硬约束：
//
//   「自动恢复备份仅限**已证明维护屏障期间没有业务写入**的**未提交**事务。
//     提交后恢复旧备份可能丢失新写入，**必须明确告知并取得用户确认**。
//     用户工作空间**永远**不作为安装覆盖或自动恢复目标。」
//
// 这个模块就是那两句话的实现。它把"能不能恢复"拆成三档，而不是一个布尔：
//
//   · `safe-automatic`  —— 未提交事务，且屏障确实在备份**之前**立起来过
//                          （于是"备份之后没有业务写入"是被证明的，不是被假设的）；
//   · `needs-confirmation` —— 事务已提交，或证据不足。恢复**可能丢新写入**，
//                          所以必须由人明确确认（`confirm: true`）；
//   · `refused`         —— 快照本身不可用（不完整／读不出来／空）。这一档
//                          **没有确认能打开**：一份坏的备份恢复出来的不是
//                          "旧数据"，而是"一个既不是旧也不是新的状态"。
//
// ## 为什么"证据不足"归到 needs-confirmation 而不是 safe
//
// 代价不对称：
//   · 判成 safe 而实际有写入 → 静默丢业务数据，且用户**没被问过**；
//   · 判成 needs 而实际无写入 → 用户被多问一句，而那一句还顺带把
//     "将要恢复什么、可能丢什么"讲清楚了。
//
// 所以"不知道"落在"要问"那一档。
//
// ## 为什么这一层不写盘、不删东西
//
// 它只读：读事务日志、读快照描述、读屏障文件。真正的落盘由
// `product/upgrade/backup.mjs` 的 `restoreSnapshot()` 做（它先逐文件对账再写，
// 且写回 `.db` 之前会删掉旁边的 `-wal`/`-shm`）。分开的理由是：
// **"能不能恢复"这个判断必须能被反复问而不产生副作用**——
// 它要显示在界面上、要能被 `--recovery-plan` 打印出来、要能进日志。
// ============================================================================

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { listSnapshots, restoreSnapshot } from '../upgrade/backup.mjs'
import { readActive, readJournal } from './journal.mjs'
import { readBarrier } from './barrier.mjs'

export const RECOVERY_FORMAT = 'legion/update-recovery@1'

export const RECOVERY_CODES = Object.freeze({
  /** 列出了候选（含"没有可恢复的"这种情况，它不是一个错误）。 */
  LISTED: 'recovery-listed',
  NO_BACKUP_DIR: 'recovery-no-backup-dir',
  SNAPSHOT_NOT_FOUND: 'recovery-snapshot-not-found',
  /** 需要人明确确认才能恢复（设计 §8 line 192 的那一条）。 */
  CONFIRMATION_REQUIRED: 'recovery-confirmation-required',
  RESTORE_FAILED: 'recovery-restore-failed',
  RESTORED: 'recovery-restored',
})

/** 恢复候选的三档安全性。**三档而不是布尔**，理由见文件头。 */
export const RECOVERY_SAFETY = Object.freeze([
  'safe-automatic',
  'needs-confirmation',
  'refused',
])

/**
 * 判断"备份是不是在屏障保护下做的"，也就是设计 line 192 那句
 * 「已证明维护屏障期间没有业务写入」里的**证明**从哪来。
 *
 * 证据是事务日志里**已经完成**的 `barrier-acquire`（`result.ok === true`），
 * 且它出现在 `backup` 动作**之前**（设计 §8 的顺序是 ④ 屏障 → ⑤ 备份）。
 *
 * ★ 两条都要看，而且顺序要看：
 *   · 只有 `intent` 没有 `result` → 屏障**可能没立起来**（那次写盘没完成），
 *     于是"备份期间没有写入"没有被证明；
 *   · 有 `barrier-acquire` 的完成记录但它在 `backup` **之后** →
 *     那不是同一件事（备份是裸做的）。
 *
 * 只看"日志里出现过 barrier-acquire 这个词"会把这些都算成有证据。
 */
export function barrierProvedBeforeBackup(journal) {
  const records = Array.isArray(journal?.records) ? journal.records : []
  let barrierAcquiredAt = -1
  let backupAt = -1
  for (let i = 0; i < records.length; i += 1) {
    const r = records[i]
    // ★ 结果数据在 `data` 字段下（`journal.result(action, detail)` 写的是
    //   `{ kind: 'result', action, data: detail }`），不是 `detail`。
    //   写错字段名的症状是"证明永远不成立"——而它不报错，只是让每一次恢复
    //   都落到"要问"那一档（保守方向，但同时也让 safe 那一档成为死代码）。
    //   只认**完成**的屏障获取；`intent` 只说明"打算做"，不说明做成了。
    if (barrierAcquiredAt < 0 && r?.kind === 'result' && r?.action === 'barrier-acquire' && r?.data?.ok === true) {
      barrierAcquiredAt = i
    }
    if (backupAt < 0 && (r?.action === 'backup') && (r?.kind === 'result' || r?.kind === 'intent')) {
      backupAt = i
    }
  }
  return Object.freeze({
    proved: barrierAcquiredAt >= 0 && backupAt >= 0 && barrierAcquiredAt < backupAt,
    barrierAcquiredAt,
    backupAt,
    reason: barrierAcquiredAt < 0
      ? '事务日志里没有"维护屏障已建立"的完成记录：无法证明备份期间没有业务写入'
      : (backupAt < 0
        ? '事务日志里没有备份动作的记录'
        : (barrierAcquiredAt < backupAt
          ? '维护屏障在备份之前建立：备份期间没有业务写入'
          : '屏障的建立记录出现在备份**之后**：这次备份不是受屏障保护的')),
  })
}

/**
 * 从**日志记录**里读"这个事务最后停在哪"，而不是只看活动描述符。
 *
 * ★★ 这一点是写用例时被逼出来的，值得记下来：
 *
 *   `readActive()` 在事务**提交之后返回 `journal-no-active`**——描述符被删掉了
 *   （那是 finish 的最后一步，见 journal.mjs）。所以"事务已提交"这件事
 *   **不可能**从 `active.phase` 读出来：那个分支永远不成立。
 *
 *   一个"等我看到 phase==='committed' 再处理"的判据，
 *   在提交之后**永远等不到**——因为提交的动作本身就包含"把描述符删掉"。
 *   它不报错，只是永远不触发，而症状恰好是"提交后的那条约束没生效"。
 *
 *   所以"最后停在哪"必须从**日志记录**里读（`finish` / `phase-*`），
 *   活动描述符只用来回答"现在有没有未完成的事务"。
 */
export function readTransactionView(journal) {
  const records = Array.isArray(journal?.records) ? journal.records : []
  let finished = null
  let lastPhase = null
  for (const r of records) {
    if (r?.kind === 'phase' && typeof r?.data?.phase === 'string') lastPhase = r.data.phase
    // `finish` 是终态记录：`data.phase` 就是 committed / rolled-back / recovery-required。
    if (r?.kind === 'finish' && typeof r?.data?.phase === 'string') finished = r.data.phase
  }
  const active = journal?.active ?? null
  return Object.freeze({
    active,
    activePhase: active?.phase ?? null,
    finishedPhase: finished,
    lastPhase: lastPhase ?? active?.phase ?? null,
    committed: finished === 'committed',
    /** 描述符读不出来（不是"没有事务"）。 */
    activeUnreadable: journal?.activeUnreadable ?? null,
    truncatedTail: journal?.truncatedTail === true,
    badLines: Array.isArray(journal?.badLines) ? journal.badLines.length : 0,
  })
}

/**
 * 给一份快照定安全性档位。
 *
 * @returns {{safety: string, requiresConfirmation: boolean, reason: string, evidence: object}}
 */
export function classifySnapshotSafety({ snapshot, journal = null, barrier = null } = {}) {
  const view = readTransactionView(journal)

  // ① 快照本身不可用 → refused。**没有确认能打开这一档。**
  if (snapshot?.status !== 'complete') {
    return Object.freeze({
      safety: 'refused',
      requiresConfirmation: false,
      reason: `快照 ${snapshot?.id ?? '?'} 的状态是 ${snapshot?.status ?? '读不出来'}，不是 complete：`
        + '一份不完整的快照恢复出来的不是"旧数据"，而是一个既不是旧也不是新的状态',
      evidence: Object.freeze({ snapshotStatus: snapshot?.status ?? null }),
    })
  }

  // ② 事务已提交 → 一定有新写入，恢复会丢它们（设计 §8 line 192 的第二句）。
  //
  //    ★ 判据来自**日志的终态记录**，不是活动描述符——提交之后描述符就没了。
  if (view.committed === true) {
    return Object.freeze({
      safety: 'needs-confirmation',
      requiresConfirmation: true,
      reason: '这次事务**已经提交**：从升级前的备份恢复会丢掉提交之后产生的所有新写入。'
        + '请先确认这些写入可以丢失（或已经从别处备份过），再显式确认恢复',
      evidence: Object.freeze({
        snapshotStatus: 'complete', txnPhase: 'committed', committed: true,
        finishedPhase: view.finishedPhase, lastPhase: view.lastPhase,
      }),
    })
  }

  // ③ 未提交事务 + 屏障证明 → safe。这是 line 192 允许**自动**恢复的唯一一档。
  const proof = barrierProvedBeforeBackup(journal)
  const barrierHeld = barrier?.held === true
  if (view.active !== null && view.active.phase !== 'committed' && proof.proved) {
    return Object.freeze({
      safety: 'safe-automatic',
      requiresConfirmation: false,
      reason: `事务停在阶段 ${view.active.phase}（未提交），且${proof.reason}：`
        + '恢复这份备份不会丢掉任何已被接受的业务写入',
      evidence: Object.freeze({
        snapshotStatus: 'complete', txnPhase: view.active.phase, committed: false,
        barrierProved: true, barrierStillHeld: barrierHeld,
      }),
    })
  }

  // ④ 其余一切（含"证据不足"）→ 要问。理由见文件头：代价不对称。
  //
  //    描述符读不出来、日志有坏行、有不完整的事务但没有屏障证明——
  //    全部落在这里，且理由各自说清是哪一种。
  const why = view.activeUnreadable !== null
    ? `活动事务描述符读不出来（${view.activeUnreadable.reason}）`
    : (view.badLines > 0
      ? `事务日志里有 ${view.badLines} 行无法解析`
      : (view.active === null
        ? '没有未完成的事务（也没有事务日志）：无法证明这份备份之后没有业务写入'
        : `事务停在阶段 ${view.active.phase}，但${proof.reason}`))
  return Object.freeze({
    safety: 'needs-confirmation',
    requiresConfirmation: true,
    reason: `${why}。恢复可能丢失新写入，请确认后再继续`,
    evidence: Object.freeze({
      snapshotStatus: 'complete',
      txnPhase: view.activePhase ?? view.finishedPhase,
      committed: null,
      barrierProved: proof.proved,
      barrierProofReason: proof.reason,
      barrierStillHeld: barrierHeld,
      activeUnreadable: view.activeUnreadable,
      badLines: view.badLines,
    }),
  })
}

/**
 * 列出可恢复的备份，并按安全性分档。**零副作用**（只读）。
 *
 * ★ 所有出口返回**同一个形状**。这一点是写 CLI 渲染器时被逼出来的：
 *   早先"没有备份目录"那一条少给了 `activeTransaction` / `barrierHeld` /
 *   `restorableCount`，于是渲染器读 `plan.activeTransaction.txnId` 时炸在
 *   **另一条**分支上——而"没有备份"那条路恰恰最常被走到（一台还没升级过的
 *   机器）。
 *
 *   > 一个"某个分支少给几个字段"的返回值，
 *   > 会在**读它的那一侧**变成一个看起来与这个分支无关的崩溃。
 *
 *   所以哪怕是"什么都没有"的情况也把每个字段给全（`null` / `0` / `[]`），
 *   让调用方不需要知道"是哪条路把我送回来的"。
 *
 * @param {object} args
 * @param {string} args.dataDir
 * @param {string|null} [args.backupDir]
 */
export function planRecoveryFromBackups({ dataDir, backupDir = null } = {}) {
  if (typeof dataDir !== 'string' || dataDir === '') {
    return Object.freeze({
      ok: false, code: RECOVERY_CODES.NO_BACKUP_DIR,
      backupDir: null, candidates: Object.freeze([]), restorableCount: 0,
      hasSafeAutomatic: false, activeTransaction: null, barrierHeld: false,
      reason: 'recovery 需要 dataDir',
    })
  }
  // 备份目录按约定在 DataDir 下（`paths.backupDir`）；显式给了就用显式的。
  const dir = typeof backupDir === 'string' && backupDir !== '' ? backupDir : join(dataDir, 'backups')
  if (!existsSync(dir)) {
    return Object.freeze({
      ok: true, code: RECOVERY_CODES.NO_BACKUP_DIR,
      backupDir: dir, candidates: Object.freeze([]), restorableCount: 0,
      hasSafeAutomatic: false, activeTransaction: null, barrierHeld: false,
      reason: `没有备份目录（${dir}）：这个部署从来没有成功备份过，因此没有可恢复的东西`,
    })
  }

  const active = readActive(dataDir)
  const journal = readJournal(dataDir)
  // `active` 读不出来时**不当作"没有事务"**：那正是需要人来看的情况。
  const txn = active.ok === true ? active.active : null
  const journalView = Object.freeze({
    records: journal.records,
    truncatedTail: journal.truncatedTail,
    badLines: journal.badLines,
    active: txn,
    // 描述符读不出来时也留痕，好让上面那档的 reason 说得准。
    activeUnreadable: active.ok !== true ? { code: active.code, reason: active.reason } : null,
  })
  const barrier = readBarrier(dataDir)

  const candidates = listSnapshots(dir).map((snapshot) => {
    const verdict = classifySnapshotSafety({ snapshot, journal: journalView, barrier })
    return Object.freeze({
      id: snapshot.id,
      createdAtMs: snapshot.createdAtMs,
      label: snapshot.label ?? null,
      status: snapshot.status,
      fileCount: snapshot.fileCount,
      totalBytes: snapshot.totalBytes,
      root: snapshot.root,
      safety: verdict.safety,
      requiresConfirmation: verdict.requiresConfirmation,
      reason: verdict.reason,
    })
  })

  const restorable = candidates.filter((c) => c.safety !== 'refused')
  return Object.freeze({
    ok: true,
    code: RECOVERY_CODES.LISTED,
    backupDir: dir,
    candidates: Object.freeze(candidates),
    restorableCount: restorable.length,
    /** 有没有一份**不需要确认**就能恢复的（= line 192 允许自动恢复的那一档）。 */
    hasSafeAutomatic: restorable.some((c) => c.safety === 'safe-automatic'),
    activeTransaction: txn === null ? null : Object.freeze({ txnId: txn.txnId, phase: txn.phase }),
    barrierHeld: barrier.held === true,
    reason: candidates.length === 0
      ? `备份目录 ${dir} 里没有任何快照`
      : `${candidates.length} 份快照，其中 ${restorable.length} 份可恢复`,
  })
}

/**
 * 显式恢复一份备份（设计 §8 line 190 的那个"入口"）。
 *
 * ★ 三条纪律，与设计 line 192 逐条对应：
 *
 *   1. **`needs-confirmation` 档必须拿到 `confirm: true` 才动手。**
 *      没有它返回 `recovery-confirmation-required`，并且**一个字节都不写**。
 *      "明确告知并取得用户确认"里的"取得"必须在代码里看得见——否则那句话
 *      只能靠调用方自觉，而调用方自觉不是判据。
 *   2. **`refused` 档没有确认能打开。** 连 `confirm: true` 也拒绝。
 *   3. **目标只能是快照自己的 dataDir/configPath。** 工作空间、安装目录都
 *      不在写入路径上（`restoreSnapshot` 只碰那两个），而这里额外核一次
 *      "调用方给的 dataDir 与快照记的 dataDir 是同一个"——一次"恢复到别处"
 *      的调用会静默覆盖另一个部署的数据。
 *
 * @param {object} args
 * @param {Function} [args.restoreImpl] 注入点（测试用；默认是真实现）
 */
export function restoreFromBackup({
  dataDir, configPath = null, backupDir = null, snapshotId,
  confirm = false, restoreImpl = restoreSnapshot, nowMs = Date.now(),
} = {}) {
  const plan = planRecoveryFromBackups({ dataDir, backupDir })
  if (plan.ok !== true) return Object.freeze({ ...plan, ok: false, restored: Object.freeze([]) })

  const candidate = plan.candidates.find((c) => c.id === snapshotId)
  if (candidate === undefined) {
    return Object.freeze({
      ok: false, code: RECOVERY_CODES.SNAPSHOT_NOT_FOUND, restored: Object.freeze([]),
      candidates: plan.candidates,
      reason: `备份目录里没有快照 ${JSON.stringify(snapshotId)}`
        + `（有的是 ${plan.candidates.map((c) => c.id).join(', ') || '（一份都没有）'}）`,
    })
  }

  // ② refused：确认也打不开。
  if (candidate.safety === 'refused') {
    return Object.freeze({
      ok: false, code: RECOVERY_CODES.RESTORE_FAILED, restored: Object.freeze([]),
      snapshotId, candidate,
      reason: `这份快照不可恢复，且**确认不能改变这一点**：${candidate.reason}`,
    })
  }

  // ① 要确认的必须真的拿到确认。
  if (candidate.requiresConfirmation === true && confirm !== true) {
    return Object.freeze({
      ok: false, code: RECOVERY_CODES.CONFIRMATION_REQUIRED, restored: Object.freeze([]),
      snapshotId, candidate, requiresConfirmation: true,
      reason: `${candidate.reason}。（这条恢复需要显式确认——在调用处传 confirm: true；`
        + 'CLI 上是 --confirm-restore。）**本次没有写入任何文件。**',
    })
  }

  // ③ 目标必须与快照记的是同一个数据目录。快照自己记了它备份的是谁。
  let meta = null
  try {
    meta = JSON.parse(readFileSync(join(candidate.root, 'snapshot.json'), 'utf8'))
  } catch { meta = null }
  const snapshotDataDir = typeof meta?.dataDir === 'string' ? meta.dataDir : null
  if (snapshotDataDir === null) {
    return Object.freeze({
      ok: false, code: RECOVERY_CODES.RESTORE_FAILED, restored: Object.freeze([]),
      snapshotId, candidate,
      reason: '快照描述里没有记 dataDir：不知道这份备份是从哪个数据目录取的，'
        + '而"恢复到别处"会静默覆盖另一个部署的数据',
    })
  }
  if (resolveLike(snapshotDataDir) !== resolveLike(dataDir)) {
    return Object.freeze({
      ok: false, code: RECOVERY_CODES.RESTORE_FAILED, restored: Object.freeze([]),
      snapshotId, candidate,
      reason: `这份快照备份的是 ${snapshotDataDir}，而本次要恢复到 ${dataDir}：`
        + '两者不是同一个数据目录，拒绝执行（恢复只能回到它自己的来源）',
    })
  }

  const result = restoreImpl(candidate.root, { dataDir, configPath })
  if (result?.ok !== true) {
    return Object.freeze({
      ok: false, code: RECOVERY_CODES.RESTORE_FAILED, restored: result?.restored ?? Object.freeze([]),
      snapshotId, candidate, underlying: result ?? null,
      reason: `恢复失败：${result?.reason ?? '（底层没有给出原因）'}`,
    })
  }
  return Object.freeze({
    ok: true, code: RECOVERY_CODES.RESTORED,
    snapshotId, candidate, safety: candidate.safety,
    restored: result.restored ?? Object.freeze([]),
    requiresConfirmationWas: candidate.requiresConfirmation === true,
    reason: `已从快照 ${snapshotId} 恢复 ${(result.restored ?? []).length} 个文件到 ${dataDir}`,
    atMs: nowMs,
  })
}

/**
 * 与 `node:path.resolve` 同形的比较用规范化。
 *
 * 不直接 import `resolve` 是因为它依赖**当前进程的 cwd**：同一个相对路径在
 * 两个不同 cwd 下会得到不同结果，而"这两条路径是不是同一个目录"不该取决于
 * 谁在哪个目录下问。所以只做分隔符与结尾斜杠的规范化，并把大小写差异交给
 * 平台（Windows 路径不区分大小写，比较时统一小写）。
 */
function resolveLike(p) {
  const s = String(p).replace(/[\\/]+/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

/**
 * 装载期自检：把三档判据各真的跑一遍。
 *
 * ★ 用**当场构造的**日志视图，不碰磁盘：自检跑在每次 import 上，
 *   而"为了自检往磁盘写东西"会让产品在只读安装目录里起不来。
 */
export function selfCheckRecovery() {
  const problems = []
  const complete = { id: 's1', status: 'complete', createdAtMs: 1, fileCount: 1, totalBytes: 1, root: '/nowhere' }
  const broken = { id: 's2', status: 'failed', createdAtMs: 1, fileCount: 0, totalBytes: 0, root: '/nowhere' }

  // ① 不完整的快照必须 refused，且**确认打不开**。
  const refused = classifySnapshotSafety({ snapshot: broken })
  if (refused.safety !== 'refused') problems.push('不完整的快照没有被判为 refused')

  // ② 已提交事务必须 needs-confirmation。
  //
  // ★★ 这里必须用**真实**的形态：提交之后 `readActive` 返回 `journal-no-active`
  //   （描述符被删掉了），所以"已提交"只能从**日志的终态记录**读出来。
  //   早先这条自检喂的是 `active: { phase: 'committed' }`——一个**现实中不存在**
  //   的输入。于是它通过了，而真实的提交路径被判成了别的档位：
  //   一条用不可能输入做的自检，验证的是"这个函数能处理这个不存在的形状"。
  const committed = classifySnapshotSafety({
    snapshot: complete,
    journal: {
      records: [
        { kind: 'result', action: 'barrier-acquire', data: { ok: true } },
        { kind: 'result', action: 'backup', data: { ok: true } },
        { kind: 'finish', action: 'transaction-committed', data: { phase: 'committed' } },
      ],
      active: null,
    },
  })
  if (committed.safety !== 'needs-confirmation' || committed.requiresConfirmation !== true) {
    problems.push('已提交事务之后恢复备份没有被要求确认（提交后描述符就没了，"已提交"只能从日志终态读）')
  }

  // ③ 屏障证明只有在"完成记录 + 它在备份之前"时才成立。
  const proved = barrierProvedBeforeBackup({
    records: [
      { kind: 'intent', action: 'barrier-acquire' },
      { kind: 'result', action: 'barrier-acquire', data: { ok: true } },
      { kind: 'result', action: 'backup', data: { ok: true } },
    ],
  })
  if (proved.proved !== true) problems.push('屏障在备份之前建立，却没有被算作证明')
  // 顺序反了 → 不是证明。
  const inverted = barrierProvedBeforeBackup({
    records: [
      { kind: 'result', action: 'backup', data: { ok: true } },
      { kind: 'result', action: 'barrier-acquire', data: { ok: true } },
    ],
  })
  if (inverted.proved !== false) problems.push('屏障记录在备份之后，却被算作了证明')
  // 只有 intent、没有 result → 不是证明（那次写盘可能没完成）。
  const intentOnly = barrierProvedBeforeBackup({
    records: [
      { kind: 'intent', action: 'barrier-acquire' },
      { kind: 'result', action: 'backup', data: { ok: true } },
    ],
  })
  if (intentOnly.proved !== false) problems.push('只有 barrier 的 intent 没有 result，却被算作了证明')

  // ④ 未提交 + 已证明 → safe-automatic（line 192 允许自动恢复的唯一一档）。
  const safe = classifySnapshotSafety({
    snapshot: complete,
    journal: {
      records: [
        { kind: 'result', action: 'barrier-acquire', data: { ok: true } },
        { kind: 'result', action: 'backup', data: { ok: true } },
      ],
      active: { txnId: 't', phase: 'migrate' },
    },
  })
  if (safe.safety !== 'safe-automatic' || safe.requiresConfirmation !== false) {
    problems.push('未提交事务且屏障已证明时，没有判为可自动恢复')
  }

  // ⑤ 没有任何证据 → 必须落到"要问"，而不是"安全"。
  const unknown = classifySnapshotSafety({ snapshot: complete, journal: { records: [], active: null } })
  if (unknown.safety !== 'needs-confirmation') problems.push('证据不足时没有落到"需要确认"')

  // ⑥ 三档词表必须在（少一档会让上面某条断言以 undefined 的形式失败）。
  for (const s of ['safe-automatic', 'needs-confirmation', 'refused']) {
    if (!RECOVERY_SAFETY.includes(s)) problems.push(`RECOVERY_SAFETY 缺少 ${s}`)
  }

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    format: RECOVERY_FORMAT,
    safeties: RECOVERY_SAFETY,
  })
}

export const RECOVERY_CHECKED = selfCheckRecovery()
