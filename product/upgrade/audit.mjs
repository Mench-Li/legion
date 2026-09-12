// product/upgrade/audit.mjs
// ============================================================================
// PRT-811 / PRT-813：升级审计、发布说明、用户通知，以及 Windows 边角
//
// spec §6.12 line 559 要求审计里可查「升级结果」；
// spec line 739 则把 Windows 的四类边角一次点全：
//
//   「Windows 安装采用 per-user 模式并处理文件占用、长路径、Defender 扫描延迟
//    和 Node 子进程树退出。……无法释放文件句柄时升级应安全中止并保留旧版本，
//     而不是部分覆盖。」
//
// ## 一、"升级成功"这条记录必须能自证
//
// 一条只写 `{ result: 'ok' }` 的审计记录，与一条**没有写过**的记录，
// 在事后追责时是同一个东西：它不能回答"当时升的是哪一版、验的是什么摘要、
// 备份是哪一份、谁按下了提交"。
//
//   > 一个写着 `result: 'ok'` 的审计记录，
//   > 与一个"我们相信它当时是成功的"的记忆，是同一个东西——
//   > 只不过前者看起来是证据。
//
// 所以 `createUpgradeRecord` 要求把 `verification`（完整性与签名的两档读数）、
// `backupId`、`migrationOutcome`、`health`、`from/to` 全部带进来，并为缺失的
// 部分显式写 `null` —— 缺失要看得见，而不是被填成一个看起来正常的默认值。
//
// ## 二、Windows 的四件事，每一件都要有"所以怎么办"
//
//   · **文件占用**：切换时旧程序的文件被占着 → 安全中止，保留旧版本（不是部分覆盖）；
//   · **长路径**：>260 字符的路径在未开启长路径支持的机器上会失败，
//     而失败发生在**拷贝到一半**的时候；
//   · **Defender 延迟**：刚写下去的文件会被扫描，`EBUSY` / `EPERM` 会持续几秒；
//     这里的处置是"重试几次"，但重试必须**有上限**，否则它会变成一次挂起；
//   · **子进程树退出**：升级前必须确认 DSH 与 Orchestrator worker 都不在了——
//     只杀父进程会留下一棵继续写数据库的子树。
//
// 这四件事在本模块里各有一个**判定函数**，因为它们的共同点是"不确定就继续"。
// ============================================================================

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { CHANNEL_LABELS } from './channels.mjs'

/** 审计记录格式。 */
export const UPGRADE_AUDIT_FORMAT = 'legion/upgrade-audit@1'

/** 审计里可查的升级结果（spec §6.12 的「升级结果」一项）。 */
export const UPGRADE_RESULTS = Object.freeze([
  'committed', 'rolled-back', 'forward-fix-required', 'aborted', 'not-started',
])

/** Windows 四类边角的具名判定码。 */
export const WINDOWS_CODES = Object.freeze({
  /** 路径超过 260 字符。 */
  LONG_PATH: 'windows-long-path',
  /** 文件被占用（EBUSY / EPERM / ETXTBSY）。 */
  FILE_IN_USE: 'windows-file-in-use',
  /** 被 Defender 之类的扫描器暂时挡住（延迟可恢复）。 */
  SCANNER_DELAY: 'windows-scanner-delay',
  /** 重试次数用完仍然被占用。 */
  RELEASE_FAILED: 'windows-release-failed',
  /** 子进程树里还有活着的进程。 */
  SUBPROCESS_TREE_ALIVE: 'windows-subprocess-tree-alive',
  /** 全部子进程都已退出。 */
  SUBPROCESS_TREE_EXITED: 'windows-subprocess-tree-exited',
})

/** Windows 单条路径的限制（未开启长路径支持时）。 */
export const MAX_PATH_LIMIT = 260

/** Defender 延迟的默认重试策略。**必须有上限**（见文件头）。 */
export const DEFAULT_RELEASE_POLICY = Object.freeze({
  attempts: 5,
  delayMs: 250,
  maxTotalMs: 5000,
})

function auditError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

// ---------------------------------------------------------------------------
// 审计记录（PRT-811）
// ---------------------------------------------------------------------------

/**
 * 一条可自证的升级审计记录。
 *
 * **所有字段都出现在返回里**，缺的就是 `null`。这不是啰嗦：
 * `JSON.stringify({ result: 'ok' })` 与
 * `JSON.stringify({ result: 'ok', verification: null, backupId: null, ... })`
 * 对后来的读者是两份完全不同的材料。
 */
export function createUpgradeRecord({
  result, fromVersion = null, toVersion = null, channel = null,
  startedAtMs = null, finishedAtMs = null,
  verification = null, backupId = null, migrationOutcome = null,
  health = null, rollback = null, switchover = null,
  actor = null, trigger = null, notes = null, preflight = null,
} = {}) {
  if (!UPGRADE_RESULTS.includes(result)) {
    throw auditError(
      'upgrade-audit-bad-result',
      `未知的升级结果 ${JSON.stringify(result)}（已知：${UPGRADE_RESULTS.join(' / ')}）。` +
      '一个认不出的结果不能写进审计：审计的价值就在于它的取值是可枚举的',
    )
  }
  const durationMs = Number.isFinite(startedAtMs) && Number.isFinite(finishedAtMs)
    ? finishedAtMs - startedAtMs
    : null
  return Object.freeze({
    kind: UPGRADE_AUDIT_FORMAT,
    result,
    fromVersion,
    toVersion,
    channel,
    channelLabel: channel === null ? null : (CHANNEL_LABELS[channel] ?? null),
    startedAtMs,
    finishedAtMs,
    durationMs,
    actor,
    trigger,
    // ★ 下面四项缺失时**显式留 null**，不填默认值。
    verification: verification === null ? null : Object.freeze({ ...verification }),
    backupId,
    migrationOutcome,
    health: health === null ? null : Object.freeze({ ...health }),
    rollback: rollback === null ? null : Object.freeze({ ...rollback }),
    switchover,
    preflight,
    notes,
  })
}

/**
 * 落一条审计记录（按时间戳命名，**追加式，绝不覆盖**）。
 *
 * 同名文件已经存在时加一个序号后缀，而不是覆盖它。审计目录的名字只有毫秒
 * 精度，而"同一毫秒里跑完两次升级"在测试里是常态、在真实机器上也可能发生
 * （两次快速重试）。一个会覆盖的"追加式"审计比没有审计更糟：它留下的
 * 唯一一条记录会让人以为只有一次升级。
 */
export function writeUpgradeRecord(auditDir, record, { atMs = record?.finishedAtMs ?? Date.now() } = {}) {
  mkdirSync(auditDir, { recursive: true })
  const stamp = new Date(atMs).toISOString().replace(/[:.]/g, '-')
  let file = join(auditDir, `${stamp}.json`)
  let seq = 0
  while (existsSync(file)) {
    seq += 1
    file = join(auditDir, `${stamp}-${String(seq).padStart(3, '0')}.json`)
  }
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n', 'utf8')
  return file
}

/** 读出升级审计（升序）。坏记录**如实报出来**，不静默跳过。 */
export function listUpgradeRecords(auditDir) {
  if (!existsSync(auditDir)) return Object.freeze([])
  const out = []
  for (const name of readdirSync(auditDir)) {
    if (!name.endsWith('.json')) continue
    try {
      out.push(Object.freeze(JSON.parse(readFileSync(join(auditDir, name), 'utf8'))))
    } catch (e) {
      out.push(Object.freeze({
        kind: UPGRADE_AUDIT_FORMAT, result: null, unreadable: true, file: name,
        error: String(e?.message ?? e),
      }))
    }
  }
  return Object.freeze(out.sort((a, b) => (a.finishedAtMs ?? 0) - (b.finishedAtMs ?? 0)))
}

/**
 * 审计里的"升级结果"读数（spec §6.12 的指标项之一）。
 *
 * ★ 没有任何记录时结果是 `not-started`，**不是** `committed`，也不是 `ok`。
 * 一台刚装好的机器上"没有升级记录"，与"最近一次升级成功了"，在仪表盘上
 * 长得一样——如果实现里把"没有记录"当成成功。
 */
export function upgradeResultMetric(records) {
  const list = (records ?? []).filter((r) => r.result !== null && r.result !== undefined)
  if (list.length === 0) {
    return Object.freeze({
      result: 'not-started', lastAtMs: null, count: 0,
      rolledBackCount: 0,
      reason: '没有任何升级记录：没有记录与"最近一次成功了"必须区分开',
    })
  }
  const last = list[list.length - 1]
  return Object.freeze({
    result: last.result,
    lastAtMs: last.finishedAtMs ?? null,
    count: list.length,
    rolledBackCount: list.filter((r) => r.result === 'rolled-back').length,
    reason: `最近一次升级结果：${last.result}（${last.fromVersion ?? '?'} → ${last.toVersion ?? '?'}）`,
  })
}

// ---------------------------------------------------------------------------
// 发布说明与用户通知（PRT-811）
// ---------------------------------------------------------------------------

/**
 * 由清单与迁移集合生成发布说明的**数据形态**。
 *
 * 关键在这两个字段：`requiresBackupRestore` 与 `mayLoseData`。
 * 一份只写"新增了什么"的发布说明，会把"这次升级含 contract 迁移，
 * 回滚需要恢复备份"这条**用户必须提前知道**的信息留在代码里。
 *
 * ★ 这两个字段回答的是**两个不同的问题**，因此它们不是同一个布尔：
 *
 *   · `requiresBackupRestore`：回滚的**步骤**里有没有"恢复数据库"这一步。
 *     它由回滚可达性（`rollbackSafety`）决定。
 *   · `mayLoseData`：回到旧版本时，**升级之后写进去的数据**能不能保住。
 *     它由迁移自己声明的 `destructive` 决定。
 *
 * 一次"加了新表、新列，旧版本不读它们"的 contract 迁移属于前者的例子：
 * 回滚要走恢复备份，但备份里的数据一条不少。把它们合成一个字段的实现，
 * 会在这种情况下喊狼来了——而喊过几次之后，真正会丢数据的那条也没人看了。
 */
export function releaseNotes({ manifest, migrations = [], highlights = [], important = [], rollbackSafety = null } = {}) {
  if (manifest === null || typeof manifest !== 'object') {
    throw auditError('release-notes-needs-manifest', 'releaseNotes 需要 manifest')
  }
  const breaking = migrations.filter((m) => m.compatibility === 'breaking')
  const destructive = migrations.filter((m) => m.destructive === true)
  const requiresBackupRestore = rollbackSafety === 'forward-fix-required' || rollbackSafety === 'db-restore-required'
  const mayLoseData = requiresBackupRestore && destructive.length > 0
  return Object.freeze({
    productVersion: manifest.productVersion ?? null,
    dshVersion: manifest.dshVersion ?? null,
    compositionPatchVersion: manifest.dshCompositionPatchVersion ?? null,
    schemaVersion: manifest.schemaVersion ?? null,
    channel: manifest.channel ?? null,
    channelLabel: manifest.channel === null ? null : (CHANNEL_LABELS[manifest.channel] ?? null),
    highlights: Object.freeze([...highlights]),
    important: Object.freeze([...important]),
    migrationCount: migrations.length,
    breakingMigrationCount: breaking.length,
    breakingMigrations: Object.freeze(breaking.map((m) => m.name)),
    destructiveMigrations: Object.freeze(destructive.map((m) => m.name)),
    rollbackSafety,
    requiresBackupRestore,
    mayLoseData,
    backupHint: requiresBackupRestore
      ? (mayLoseData
        ? '本次升级包含旧版本读不懂的数据变更，其中含**删除/改写历史数据**的迁移：' +
          '回滚二进制不够，从备份恢复会丢掉升级之后写入的数据'
        : '本次升级包含旧版本读不懂的数据变更：**回滚二进制不够**，需要从升级前的备份恢复数据库，或向前修复')
      : '本次变更向前兼容：回滚二进制即可，数据库无需恢复',
  })
}

/**
 * 把发布说明渲染成给人看的一段文字。
 *
 * `mayLoseData` 为真时**放在最前面**——一条埋在第三段的"可能丢数据"，
 * 与一条没有写过的"可能丢数据"，在读的人那里是同一件事。
 */
export function formatReleaseNotes(notes) {
  const lines = []
  if (notes.mayLoseData) {
    lines.push('⚠ 这次升级包含旧版本读不懂的数据变更。回滚程序**不能**让数据回到原样，')
    lines.push('  需要从升级前的备份恢复数据库（或向前修复）。请先确认备份可用。')
    lines.push('')
  }
  lines.push(`Legion ${notes.productVersion ?? '(未知版本)'}（${notes.channelLabel ?? notes.channel ?? '未知通道'}）`)
  lines.push(`DSH ${notes.dshVersion ?? '(未知)'}　组合补丁层 v${notes.compositionPatchVersion ?? '(未知)'}　schema ${notes.schemaVersion ?? '(未知)'}`)
  if (notes.highlights.length > 0) {
    lines.push('')
    lines.push('新内容：')
    for (const h of notes.highlights) lines.push(`  · ${h}`)
  }
  if (notes.important.length > 0) {
    lines.push('')
    lines.push('请注意：')
    for (const h of notes.important) lines.push(`  · ${h}`)
  }
  if (notes.breakingMigrationCount > 0) {
    lines.push('')
    lines.push(`数据库变更：${notes.migrationCount} 项，其中 ${notes.breakingMigrationCount} 项为 contract（${notes.breakingMigrations.join(' / ')}）`)
  }
  lines.push('')
  lines.push(`回滚：${notes.backupHint}`)
  return lines.join('\n')
}

/** 通知等级。`critical` 不静默——它必须被举手一次。 */
export const NOTIFY_LEVELS = Object.freeze(['info', 'warning', 'critical'])

/**
 * 由一次升级的结果生成用户通知。
 *
 * ★ 三种需要用户动手的结果（`forward-fix-required` / 需要恢复备份的回滚 /
 * 带 contract 迁移的提交）**必须**是 `warning` 或 `critical`。
 * 一个把"必须人工介入"渲染成 `info` 的通知实现，与一个不发这条通知的实现，
 * 在用户会不会动手上是同一个东西。
 */
export function upgradeNotification({ record, rollbackSafety = null } = {}) {
  if (record === null || typeof record !== 'object') {
    throw auditError('upgrade-notify-needs-record', 'upgradeNotification 需要一条升级审计记录')
  }
  const from = record.fromVersion ?? '?'
  const to = record.toVersion ?? '?'
  // ★ 需要用户动手的三种情形：向前修复、回滚但数据库仍需处理、以及
  //   `rollbackSafety` 说这次回滚不是纯程序回滚。
  //
  //   这里**不能**只看 `rollbackSafety === 'forward-fix-required'`：一次
  //   `db-restore-required` 的回滚同样要用户去恢复备份。漏掉它会让一条
  //   `actionRequired: true` 的通知挂在 `info` 上——而"需要动手"与"仅供参考"
  //   是这条通知唯一要说清楚的事。
  const needsAction = record.result === 'forward-fix-required'
    || rollbackSafety === 'forward-fix-required'
    || rollbackSafety === 'db-restore-required'

  if (record.result === 'committed') {
    return Object.freeze({
      level: 'info',
      title: `已更新到 ${to}`,
      body: `Legion 已从 ${from} 更新到 ${to}（${CHANNEL_LABELS[record.channel] ?? record.channel ?? '未知通道'}）。`,
      actionRequired: false,
      // 覆盖了 contract 迁移的提交仍然要举手：数据已经不可退。
      caveat: rollbackSafety === 'forward-fix-required' || rollbackSafety === 'db-restore-required'
        ? '本次升级包含 contract 迁移：如需回到旧版本，必须从升级前的备份恢复数据库'
        : null,
    })
  }
  if (record.result === 'rolled-back') {
    const programOnly = record.rollback?.safety === 'program-only-rollback'
    return Object.freeze({
      level: needsAction || !programOnly ? 'warning' : 'info',
      title: programOnly ? `更新未完成，已退回 ${from}` : `更新未完成，已退回 ${from}（数据库仍需处理）`,
      body: programOnly
        ? `新版本没有通过检查，已安全退回 ${record.rollback?.restoredVersion ?? from}，业务数据未受影响。`
        : `已退回 ${record.rollback?.restoredVersion ?? from}，但数据库里已经是旧版本读不懂的数据：` +
          '需要向前修复，或从升级前的备份恢复。',
      actionRequired: !programOnly,
      caveat: record.rollback?.doesNotRestore?.length
        ? `未恢复：${record.rollback.doesNotRestore.join('；')}`
        : null,
    })
  }
  if (record.result === 'forward-fix-required') {
    return Object.freeze({
      level: 'critical',
      title: `更新未完成，需要人工处理（${from} → ${to}）`,
      body: '新版本已切换或已迁移，但当前状态不允许仅回滚程序。请按诊断包中的指引向前修复，' +
        '或从升级前的备份恢复数据库。',
      actionRequired: true,
      caveat: null,
    })
  }
  return Object.freeze({
    level: record.result === 'aborted' ? 'warning' : 'info',
    title: record.result === 'aborted' ? `更新已安全中止（仍是 ${from}）` : '尚未进行过升级',
    body: record.result === 'aborted'
      ? '升级在改动任何东西之前中止了，当前仍是原版本。可以稍后重试。'
      : '这台机器还没有升级记录。',
    actionRequired: false,
    caveat: null,
  })
}

// ---------------------------------------------------------------------------
// Windows 边角（PRT-813）
// ---------------------------------------------------------------------------

/** 判断一个错误是否是"文件被占着"。 */
export function isInUseError(error) {
  const code = error?.code
  return code === 'EBUSY' || code === 'EPERM' || code === 'ETXTBSY' || code === 'EACCES'
}

/** 判断一个错误是否像是扫描器造成的**暂时**占用（可重试）。 */
export function isScannerDelayError(error) {
  const code = error?.code
  return code === 'EBUSY' || code === 'EPERM'
}

/**
 * 路径长度判定。
 *
 * 判定的是**完整长度**，不只是盘符之后的部分：Windows 的 260 限制作用在
 * 完整路径上，而"相对路径很短"这个直觉正是长路径问题最常见的来源。
 */
export function checkLongPath(path, { limit = MAX_PATH_LIMIT, longPathsEnabled = false } = {}) {
  if (typeof path !== 'string' || path === '') {
    return Object.freeze({
      ok: false, code: WINDOWS_CODES.LONG_PATH, length: 0, limit,
      reason: '路径为空：空路径不是"短路径"',
    })
  }
  if (longPathsEnabled) {
    return Object.freeze({ ok: true, code: null, length: path.length, limit, reason: '已启用长路径支持' })
  }
  if (path.length >= limit) {
    return Object.freeze({
      ok: false, code: WINDOWS_CODES.LONG_PATH, length: path.length, limit,
      reason: `路径长度 ${path.length} 达到 ${limit} 的限制：拷贝会在**写到一半**的时候失败，` +
        '而"写了一半的版本目录"不是任何一个已知状态。请缩短安装路径或启用长路径支持',
    })
  }
  return Object.freeze({ ok: true, code: null, length: path.length, limit, reason: null })
}

/**
 * 检查一组路径，返回**无一超限**才为 `ok`。
 */
export function checkLongPaths(paths, options = {}) {
  const results = (paths ?? []).map((p) => Object.freeze({ path: p, ...checkLongPath(p, options) }))
  const bad = results.filter((r) => !r.ok)
  return Object.freeze({
    ok: bad.length === 0,
    code: bad.length === 0 ? null : WINDOWS_CODES.LONG_PATH,
    longest: results.reduce((a, r) => Math.max(a, r.length), 0),
    checked: results.length,
    violations: Object.freeze(bad),
    reason: bad.length === 0 ? null : `${bad.length} 条路径超过 ${options.limit ?? MAX_PATH_LIMIT} 字符`,
  })
}

/**
 * 带**上限**的占用释放重试。
 *
 * `attempts` 与 `maxTotalMs` 都必须是有限值。一个 `while (true) { try ... }`
 * 的重试，与一次挂起是同一个东西——而这次挂起发生在**升级流程的中间**，
 * 用户看到的是转圈，强杀之后是"迁移跑过了、程序换了一半"。
 *
 * @param {(attempt: number) => void} op    要做的事（失败时抛）
 * @param {(ms: number) => Promise<void>} sleep 注入的等待
 */
export async function releaseWithRetry(op, {
  policy = DEFAULT_RELEASE_POLICY, isRetryable = isScannerDelayError, sleep = defaultSleep, now = () => Date.now(),
} = {}) {
  if (!Number.isFinite(policy.attempts) || policy.attempts < 1) {
    throw auditError('windows-release-policy-invalid', 'releaseWithRetry 的 attempts 必须是 >= 1 的有限整数')
  }
  if (!Number.isFinite(policy.maxTotalMs) || policy.maxTotalMs <= 0) {
    throw auditError('windows-release-policy-invalid', 'releaseWithRetry 必须有有限的 maxTotalMs：无限重试等于挂起')
  }
  const started = now()
  const attempts = []
  for (let i = 1; i <= policy.attempts; i += 1) {
    try {
      const value = await op(i)
      attempts.push(Object.freeze({ attempt: i, ok: true, elapsedMs: now() - started }))
      return Object.freeze({
        ok: true, code: null, attempts: Object.freeze(attempts), result: value,
        elapsedMs: now() - started, reason: null,
      })
    } catch (e) {
      const retryable = isRetryable(e) === true
      attempts.push(Object.freeze({
        attempt: i, ok: false, code: e?.code ?? null, retryable,
        error: String(e?.message ?? e), elapsedMs: now() - started,
      }))
      if (!retryable) {
        return Object.freeze({
          ok: false, code: e?.code ?? WINDOWS_CODES.FILE_IN_USE,
          attempts: Object.freeze(attempts), result: null, elapsedMs: now() - started,
          reason: `不可重试的失败（${e?.code ?? '未知'}）：${e?.message ?? e}`,
        })
      }
      if (i === policy.attempts) break
      if (now() - started + policy.delayMs > policy.maxTotalMs) break
      await sleep(policy.delayMs)
    }
  }
  return Object.freeze({
    ok: false,
    code: WINDOWS_CODES.RELEASE_FAILED,
    attempts: Object.freeze(attempts),
    result: null,
    elapsedMs: now() - started,
    reason: `${policy.attempts} 次重试后文件仍被占用（累计 ${now() - started}ms）。` +
      'spec line 739：无法释放文件句柄时升级应**安全中止并保留旧版本**，而不是部分覆盖',
  })
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    if (typeof t === 'object' && t !== null && typeof t.unref === 'function') t.unref()
  })
}

/**
 * 子进程树退出检查。
 *
 * spec line 739 要求处理"Node 子进程树退出"。要防的是：升级前只确认了
 * DSH 主进程退出，而 Orchestrator worker（或 DSH 派生的子进程）还在跑，
 * 于是它在程序被替换的同时继续往数据库里写。
 *
 * `alive` 是**由调用方探来的实际读数**。`null`（没探）→ `unknown`，
 * 不是"都退了"。
 */
export function checkSubprocessTreeExited({ processes = null, expected = [] } = {}) {
  if (!Array.isArray(processes)) {
    return Object.freeze({
      ok: false, code: WINDOWS_CODES.SUBPROCESS_TREE_ALIVE, verdict: 'unknown',
      alive: Object.freeze([]), expected: Object.freeze([...expected]),
      reason: '没有拿到子进程树读数：没有探过与"都退了"是两件事',
    })
  }
  const alive = processes.filter((p) => p?.alive === true)
  if (alive.length > 0) {
    return Object.freeze({
      ok: false, code: WINDOWS_CODES.SUBPROCESS_TREE_ALIVE, verdict: 'alive',
      alive: Object.freeze(alive.map((p) => Object.freeze({ key: p.key ?? null, pid: p.pid ?? null }))),
      expected: Object.freeze([...expected]),
      reason: `${alive.length} 个子进程仍在运行（${alive.map((p) => p.key ?? p.pid).join(', ')}）：` +
        '只杀父进程会留下一棵继续写数据库的子树',
    })
  }
  return Object.freeze({
    ok: true, code: WINDOWS_CODES.SUBPROCESS_TREE_EXITED, verdict: 'exited',
    alive: Object.freeze([]), expected: Object.freeze([...expected]),
    reason: null,
  })
}

/**
 * 切换前的 Windows 前置检查合成。
 *
 * 三项（长路径、子进程树、可写释放）里任何一项不通过都不许开始切换。
 * 这与 spec line 739 的最后半句一致：**安全中止并保留旧版本**。
 */
export function preSwitchWindowsCheck({
  installRoot, paths = [], processes = null, longPathsEnabled = false,
} = {}) {
  const longPath = checkLongPaths([installRoot, ...paths], { longPathsEnabled })
  const tree = checkSubprocessTreeExited({ processes })
  const reasons = []
  if (!longPath.ok) reasons.push(longPath.reason)
  if (!tree.ok) reasons.push(tree.reason)
  return Object.freeze({
    ok: longPath.ok && tree.ok,
    longPath,
    subprocessTree: tree,
    reasons: Object.freeze(reasons),
    advice: longPath.ok && tree.ok
      ? null
      : '安全中止：保留旧版本，不开始切换（半覆盖的安装目录不是任何一个已知状态）',
  })
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

/**
 * 装载期自检：把本模块的四条核心判据各真的跑一遍，留下算出来的值。
 */
export function selfCheckAudit() {
  const problems = []

  // ① 未知结果不许进审计。
  let rejectedUnknown = null
  try {
    createUpgradeRecord({ result: '差不多成功吧' })
  } catch (e) {
    rejectedUnknown = e
  }
  if (rejectedUnknown === null) problems.push('未知的升级结果被写进了审计')

  // ② 缺字段必须显式为 null，不能凭空生出默认值。
  const sparse = createUpgradeRecord({ result: 'aborted' })
  if (sparse.verification !== null || sparse.backupId !== null) {
    problems.push('审计记录给缺失字段填了默认值——缺失必须看得见')
  }

  // ③ 没有记录时结果是 not-started，不是 committed。
  const empty = upgradeResultMetric([])
  if (empty.result !== 'not-started') problems.push(`没有升级记录时的结果是 ${empty.result}`)

  // ④ 长路径与子进程树必须真的拦得住。
  const long = checkLongPath(`C:\\Users\\x\\${'a'.repeat(300)}`)
  if (long.ok) problems.push('300 字符的路径被判为可接受')
  const tree = checkSubprocessTreeExited({ processes: [{ key: 'orchestrator', alive: true }] })
  if (tree.ok) problems.push('还有活着的子进程时判为可以切换')
  const unknownTree = checkSubprocessTreeExited({ processes: null })
  if (unknownTree.ok) problems.push('没有子进程读数时判为"都退了"')

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    format: UPGRADE_AUDIT_FORMAT,
    results: UPGRADE_RESULTS,
    levels: NOTIFY_LEVELS,
    samples: Object.freeze({
      unknownResultRejected: rejectedUnknown !== null,
      unknownResultCode: rejectedUnknown?.code ?? null,
      emptyMetricResult: empty.result,
      longPathOk: long.ok,
      longPathLength: long.length,
      subprocessAliveOk: tree.ok,
      subprocessAliveCode: tree.code,
      subprocessUnknownVerdict: unknownTree.verdict,
    }),
  })
}

/** 装载时算一次。`problems` 非空即本模块自己的判据不自洽。 */
export const AUDIT_CHECKED = selfCheckAudit()
