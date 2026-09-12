// product/upgrade/preflight.mjs
// ============================================================================
// PRT-805：升级前兼容性、磁盘和在途任务检查
//
// spec §9.4 line 721 的第一步就是「检查兼容性与空间」；line 724–726 继续说：
//
//   「停止任务认领 → 等待或安全中断在途运行 → 停止服务 → 原子切换程序版本」
//
// 也就是说"在途任务"不是一个提示，而是**流程上的一个前置条件**：没收敛就不能切。
//
// ## 为什么这三项检查必须是三份独立读数
//
// 三项检查的失败处置完全不同：
//
//   · 兼容性不满足 → **永远**不能升（换一次机器、等一次发布都不行）；
//   · 磁盘不够     → 清一下缓存、换个盘就能升；
//   · 在途任务没收敛 → 等几分钟就能升。
//
// 把三项压成一个 `ok` 布尔，调用方就只能对三种完全不同的处境给出同一种反应——
// 而人会选最省事的那一种，也就是"再试一次"：
//
//   > 一个把"版本不兼容"与"磁盘剩 200MB"合成同一个红点的体检，
//   > 与一个"重试到成功为止"的升级脚本，是同一个东西。
//
// 所以本模块返回逐项读数，并额外给出 `blockingReasons`（哪几项必须在**这次**
// 升级里被解决）。`runPreflight` 的 `ok` 只是这三项的合取，不替代它们。
//
// ## 磁盘余量必须按"最坏情况"算
//
// 升级过程中同时存在的字节量是：旧版本 + 新版本 + 备份 + 解压临时文件。
// 只按"新包大小"算余量的实现会在真实机器上写到一半没空间——
// 而**写到一半**正是最坏的时刻：程序已经换了一半，数据库可能已经迁移。
// ============================================================================

import { compareVersions, isExactVersion, upgradeWindow } from './manifest.mjs'

/** 本模块的三个检查 id。顺序即 spec §9.4 的句子顺序。 */
export const PREFLIGHT_CHECKS = Object.freeze(['compatibility', 'disk', 'in-flight-tasks'])

/** 单项裁决。`unknown` 与 `ok` 是**不同**的读数——见 `checkInFlightTasks`。 */
export const PREFLIGHT_VERDICTS = Object.freeze(['ok', 'blocked', 'unknown'])

export const PREFLIGHT_CODES = Object.freeze({
  COMPATIBLE: 'preflight-compatible',
  /** N-1 窗口外（N-2、更旧或降级）。 */
  WINDOW_VIOLATION: 'preflight-window-violation',
  /** 通道不同。 */
  CHANNEL_MISMATCH: 'preflight-channel-mismatch',
  /** 产品 ID 不同（拿另一个产品的包来升）。 */
  PRODUCT_MISMATCH: 'preflight-product-mismatch',
  /** 目标平台不同。 */
  PLATFORM_MISMATCH: 'preflight-platform-mismatch',
  /** schema 版本**降级**，没有对应的降级迁移。 */
  SCHEMA_DOWNGRADE: 'preflight-schema-downgrade',
  /** DSH 版本低于当前要求的最低版本。 */
  DSH_TOO_OLD: 'preflight-dsh-too-old',
  /** 清单本身不合法。 */
  MANIFEST_INVALID: 'preflight-manifest-invalid',

  DISK_OK: 'preflight-disk-ok',
  /** 可用空间不足。 */
  DISK_INSUFFICIENT: 'preflight-disk-insufficient',
  /** 没有磁盘读数——**不是**"空间充足"。 */
  DISK_UNOBSERVED: 'preflight-disk-unobserved',

  TASKS_DRAINED: 'preflight-tasks-drained',
  /** 仍有在途任务。 */
  TASKS_IN_FLIGHT: 'preflight-tasks-in-flight',
  /** 没有任务状态读数——**不是**"没有在途任务"。 */
  TASKS_UNOBSERVED: 'preflight-tasks-unobserved',
})

function preflightError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

const ok = (check, reasons = []) => Object.freeze({
  check, verdict: 'ok', code: null, reasons: Object.freeze(reasons),
})
const blocked = (check, code, reason) => Object.freeze({
  check, verdict: 'blocked', code, reasons: Object.freeze([reason]),
})
const unknown = (check, code, reason) => Object.freeze({
  check, verdict: 'unknown', code, reasons: Object.freeze([reason]),
})

// ---------------------------------------------------------------------------
// ① 兼容性
// ---------------------------------------------------------------------------

/**
 * 兼容性判定。
 *
 * @param {object} args
 * @param {object} args.current    当前安装的清单
 * @param {object} args.target     目标清单
 * @param {string|null} [args.platform]      目标平台（`win32` / `linux` / `darwin`）
 * @param {number|null} [args.minDshVersionMajor] 接受的最低 DSH 主版本
 * @param {'match'|'mismatch'|null} [args.patchPair] 补丁层与 DSH 版本成对关系的已知结论
 */
export function checkCompatibility({
  current, target, platform = null, minDshVersionMajor = null, patchPair = null,
} = {}) {
  const reasons = []
  if (current === null || typeof current !== 'object') {
    return blocked('compatibility', PREFLIGHT_CODES.MANIFEST_INVALID, '没有当前安装的版本清单：没有基线就无从判断"兼容"是兼容什么')
  }
  if (target === null || typeof target !== 'object') {
    return blocked('compatibility', PREFLIGHT_CODES.MANIFEST_INVALID, '没有目标版本清单')
  }
  for (const [field, label] of [['productVersion', '产品版本'], ['dshVersion', 'DSH 版本']]) {
    if (!isExactVersion(target[field])) {
      return blocked(
        'compatibility', PREFLIGHT_CODES.MANIFEST_INVALID,
        `目标清单的 ${label}（${field}）不是精确版本：${JSON.stringify(target[field])}`,
      )
    }
  }
  if (current.productId !== undefined && target.productId !== undefined && current.productId !== target.productId) {
    return blocked(
      'compatibility', PREFLIGHT_CODES.PRODUCT_MISMATCH,
      `产品 ID 不同（${current.productId} → ${target.productId}）：这不是一次升级`,
    )
  }

  // 窗口（N-1 / 降级 / 跨多主版本）。判定逻辑只在 manifest.mjs 一处，
  // 这里不重写一遍——两份"能不能升"的判定必然漂移，而漂移的方向是放行。
  const window = upgradeWindow(current.productVersion, target.productVersion)
  if (!window.allowed) reasons.push(`${window.code}: ${window.reason}`)

  if (current.channel !== undefined && target.channel !== undefined && current.channel !== target.channel) {
    reasons.push(
      `${PREFLIGHT_CODES.CHANNEL_MISMATCH}: 通道不同（${current.channel} → ${target.channel}）：` +
      '跨通道升级必须由通道策略（PRT-810）决定，不由升级流程自行判断',
    )
  }

  const targetPlatform = target.platform ?? target.installPlatform ?? null
  if (platform !== null && targetPlatform !== null && targetPlatform !== platform) {
    reasons.push(
      `${PREFLIGHT_CODES.PLATFORM_MISMATCH}: 包的平台是 ${targetPlatform}，当前是 ${platform}`,
    )
  }

  // schema 只能向前。降级需要"经过验证的数据库恢复"，那不是升级流程能顺手做的事。
  if (Number.isInteger(current.schemaVersion) && Number.isInteger(target.schemaVersion) &&
      target.schemaVersion < current.schemaVersion) {
    reasons.push(
      `${PREFLIGHT_CODES.SCHEMA_DOWNGRADE}: schema 从 ${current.schemaVersion} 退到 ${target.schemaVersion}。` +
      '数据库迁移只做 expand（向前兼容）；schema 降级必须走经过验证的数据库恢复，不是升级流程的一部分',
    )
  }

  if (minDshVersionMajor !== null) {
    const major = Number(String(target.dshVersion).split('.')[0])
    if (Number.isInteger(major) && major < minDshVersionMajor) {
      reasons.push(
        `${PREFLIGHT_CODES.DSH_TOO_OLD}: 目标 DSH ${target.dshVersion} 低于本产品要求的最低主版本 ${minDshVersionMajor}`,
      )
    }
  }

  // 补丁层成对关系。`null`（没有结论）时**不**放行——
  // 它落到下面的 `unknown`，而不是 `ok`。
  if (patchPair === 'mismatch') {
    reasons.push(
      `preflight-patch-pair-mismatch: 目标补丁层 ${target.dshCompositionPatchVersion} 与 DSH ${target.dshVersion} 不成对：` +
      '锚点失效时进程照常启动、而强制面全部不在',
    )
  }

  if (reasons.length > 0) {
    return Object.freeze({
      check: 'compatibility', verdict: 'blocked', code: reasons[0].split(':')[0], reasons: Object.freeze(reasons), window,
    })
  }
  if (patchPair === null) {
    return Object.freeze({
      check: 'compatibility', verdict: 'unknown',
      code: 'preflight-patch-pair-unverified',
      reasons: Object.freeze([
        '补丁层与 DSH 版本的成对关系没有结论（没有绑定表）：' +
        '"没有验证过成对"与"成对已验证"在本次升级里必须区分',
      ]),
      window,
    })
  }
  return Object.freeze({
    check: 'compatibility', verdict: 'ok', code: null, reasons: Object.freeze([]), window,
  })
}

// ---------------------------------------------------------------------------
// ② 磁盘
// ---------------------------------------------------------------------------

/** 磁盘余量的默认倍数：新包、解压临时、备份同时存在的保守估计。 */
export const DEFAULT_DISK_POLICY = Object.freeze({
  /** 安装目录需要的余量 = 包大小 × 该倍数（旧+新+解压同时存在）。 */
  installFactor: 3,
  /** 数据目录需要的余量 = 备份大小 × 该倍数 + 固定余量。 */
  dataFactor: 2,
  /** 无论多大的库，数据目录都再留这么多字节。SQLite 的 WAL 与 VACUUM 会用掉它。 */
  dataHeadroomBytes: 64 * 1024 * 1024,
})

/**
 * 算出本次升级需要的字节数与各项分解。
 *
 * 分解要能被打印出来：一句"空间不足"没法让人决定该清哪个盘。
 */
export function requiredBytes({ packageBytes, backupBytes = 0, dataDirBytes = 0 }, policy = DEFAULT_DISK_POLICY) {
  const install = Math.ceil(packageBytes * policy.installFactor)
  const backup = Math.ceil(backupBytes * policy.dataFactor)
  const data = dataDirBytes + policy.dataHeadroomBytes
  return Object.freeze({
    installDir: install,
    dataDir: backup + data,
    total: install + backup + data,
    breakdown: Object.freeze({
      packageBytes,
      installFactor: policy.installFactor,
      backupBytes,
      dataFactor: policy.dataFactor,
      dataDirBytes,
      dataHeadroomBytes: policy.dataHeadroomBytes,
    }),
  })
}

/**
 * 磁盘检查。
 *
 * `freeBytes` 缺失时返回 `unknown`——**绝不**当成"空间充足"。
 * 磁盘余量是本模块三项检查里唯一"缺读数就必须停"的一项：它的失败后果
 * （写到一半没空间）发生在程序已经换了一半之后，不可回退。
 */
export function checkDiskSpace({ freeBytes = null, packageBytes = null, backupBytes = 0, dataDirBytes = 0, policy = DEFAULT_DISK_POLICY } = {}) {
  if (!Number.isFinite(packageBytes) || packageBytes <= 0) {
    return unknown('disk', PREFLIGHT_CODES.DISK_UNOBSERVED, '没有包大小读数：算不出需要多少空间')
  }
  if (!Number.isFinite(freeBytes) || freeBytes < 0) {
    return unknown(
      'disk', PREFLIGHT_CODES.DISK_UNOBSERVED,
      '没有可用空间读数：读不到磁盘余量时"空间充足"是一句没有依据的话',
    )
  }
  const needed = requiredBytes({ packageBytes, backupBytes, dataDirBytes }, policy)
  if (freeBytes < needed.total) {
    return Object.freeze({
      check: 'disk', verdict: 'blocked', code: PREFLIGHT_CODES.DISK_INSUFFICIENT,
      reasons: Object.freeze([
        `可用 ${freeBytes} 字节，需要 ${needed.total} 字节` +
        `（安装目录 ${needed.installDir} + 数据目录 ${needed.dataDir}）。` +
        '升级过程中旧版本、新版本、备份与解压临时文件同时存在，只按新包大小算余量会在写到一半时没空间',
      ]),
      needed, freeBytes,
    })
  }
  return Object.freeze({
    check: 'disk', verdict: 'ok', code: null, reasons: Object.freeze([]), needed, freeBytes,
    marginBytes: freeBytes - needed.total,
  })
}

// ---------------------------------------------------------------------------
// ③ 在途任务
// ---------------------------------------------------------------------------

/** 认作"不能切"的任务状态。与 §6.3 表里 `upgrading` 一行的 `drain` 语义一致。 */
export const ACTIVE_TASK_STATES = Object.freeze([
  'claimed', 'running', 'awaiting-approval', 'cancelling', 'retrying',
])

/** 认作"已经收敛"的状态。 */
export const TERMINAL_TASK_STATES = Object.freeze([
  'completed', 'failed', 'cancelled', 'dead-letter',
])

/**
 * 在途任务检查。
 *
 * ★ 三项判定，不是两项：
 *
 *   · `ok`      —— 读到了任务读数，且其中没有活跃任务；
 *   · `blocked` —— 读到了，且有 `n > 0` 个活跃任务；
 *   · `unknown` —— **没有读数**。
 *
 * 第三档是必需的。把"读不到"归进 `ok` 的那个实现，会在数据库连不上、
 * 或查询超时的时刻，把"不知道有没有任务在跑"读成"没有任务在跑"，
 * 然后开始换程序——而正在跑的任务在那一刻恰好是最脆弱的。
 *
 *   > 一个在查不到任务状态时照常升级的检查，
 *   > 与一个从来没有查过在途任务的检查，是同一个东西。
 *
 * `leaseGraceMs`：给了当前时刻与最老活跃任务的 lease 到期时刻时，
 * 可以判定"等 `n` 毫秒即可收敛"，从而把"再等一下"与"必须人工介入"分开。
 */
export function checkInFlightTasks({
  tasks = null, activeStates = ACTIVE_TASK_STATES, nowMs = null, oldestLeaseExpiryMs = null,
} = {}) {
  if (!Array.isArray(tasks)) {
    return unknown(
      'in-flight-tasks', PREFLIGHT_CODES.TASKS_UNOBSERVED,
      '没有拿到任务读数：查不到在途任务不等于没有在途任务',
    )
  }
  const activeSet = new Set(activeStates)
  const active = tasks.filter((t) => activeSet.has(t?.state))
  // 认不出的状态按**活跃**处理：新加了一个状态而这里没跟上时，
  // "当成已完成"会让一次升级踩着它开始，而"当成活跃"只会让升级多等一轮。
  const unrecognized = tasks.filter((t) => !activeSet.has(t?.state) && !TERMINAL_TASK_STATES.includes(t?.state))

  if (active.length === 0 && unrecognized.length === 0) {
    return Object.freeze({
      check: 'in-flight-tasks', verdict: 'ok', code: null, reasons: Object.freeze([]),
      activeCount: 0, unrecognizedCount: 0, activeIds: Object.freeze([]),
    })
  }

  const blocking = [...active, ...unrecognized]
  const reasons = []
  if (active.length > 0) reasons.push(`仍有 ${active.length} 个活跃任务：${active.slice(0, 5).map((t) => t.id ?? '(无 id)').join(', ')}`)
  if (unrecognized.length > 0) {
    reasons.push(
      `${unrecognized.length} 个任务的状态不在已知集合里（${[...new Set(unrecognized.map((t) => JSON.stringify(t?.state)))].join(', ')}）：` +
      `按"可能仍在执行"处理，因为把它们当成已完成会让一次升级踩着它们开始`,
    )
  }

  let waitMs = null
  if (Number.isFinite(nowMs) && Number.isFinite(oldestLeaseExpiryMs)) {
    waitMs = Math.max(0, oldestLeaseExpiryMs - nowMs)
  }

  return Object.freeze({
    check: 'in-flight-tasks', verdict: 'blocked', code: PREFLIGHT_CODES.TASKS_IN_FLIGHT,
    reasons: Object.freeze(reasons),
    activeCount: active.length,
    unrecognizedCount: unrecognized.length,
    activeIds: Object.freeze(blocking.map((t) => t.id ?? null)),
    waitMs,
  })
}

// ---------------------------------------------------------------------------
// 合成
// ---------------------------------------------------------------------------

/**
 * 跑完三项检查。
 *
 * `stage` 指出这次体检发生在流程的哪一步：`pre-download`（还不知道包多大）时
 * 磁盘项允许用"无读数"通过——因为此时确实还没有包可量。**其余任何 stage**
 * 都不允许，`verifyPackage` 之后磁盘必须是有读数的。
 *
 * @param {object} args
 * @param {object} args.current
 * @param {object} args.target
 * @param {'pre-download'|'pre-switch'} [args.stage]
 */
export function runPreflight({
  current, target, stage = 'pre-switch', platform = null, minDshVersionMajor = null,
  patchPair = null, freeBytes = null, packageBytes = null, backupBytes = 0, dataDirBytes = 0,
  tasks = null, nowMs = null, oldestLeaseExpiryMs = null, diskPolicy = DEFAULT_DISK_POLICY,
} = {}) {
  if (stage !== 'pre-download' && stage !== 'pre-switch') {
    throw preflightError('preflight-stage-unknown', `未知的体检阶段 ${JSON.stringify(stage)}`)
  }
  const compatibility = checkCompatibility({ current, target, platform, minDshVersionMajor, patchPair })
  const disk = checkDiskSpace({ freeBytes, packageBytes, backupBytes, dataDirBytes, policy: diskPolicy })
  const inFlight = checkInFlightTasks({ tasks, nowMs, oldestLeaseExpiryMs })

  const checks = Object.freeze([compatibility, disk, inFlight])
  const blockedChecks = checks.filter((c) => c.verdict === 'blocked')
  const unknownChecks = checks.filter((c) => c.verdict === 'unknown')

  // `pre-download` 阶段磁盘没读数是可以接受的（此时还没有包）；
  // 但"读不到任务状态"在任何阶段都不可接受。
  const toleratedUnknown = stage === 'pre-download' ? new Set(['disk']) : new Set()
  const fatalUnknown = unknownChecks.filter((c) => !toleratedUnknown.has(c.check))

  const explicitReasons = [
    ...blockedChecks.flatMap((c) => c.reasons),
    ...fatalUnknown.map((c) => `${c.check}: ${c.reasons.join('；')}`),
  ]

  return Object.freeze({
    ok: blockedChecks.length === 0 && fatalUnknown.length === 0,
    stage,
    checks,
    blocked: Object.freeze(blockedChecks.map((c) => c.check)),
    unknown: Object.freeze(unknownChecks.map((c) => c.check)),
    toleratedUnknown: Object.freeze([...toleratedUnknown]),
    reasons: Object.freeze(explicitReasons),
    // 三项各自的处置不同，因此按项给出"怎么办"。
    remedies: Object.freeze({
      compatibility: compatibility.verdict === 'ok' ? null : '换用经过验证的 N-1 组合，或走逐级升级/离线迁移；不要重试同一份包',
      disk: disk.verdict === 'ok' ? null : '清理缓存或更换目标盘；**不要**在原盘上重试',
      'in-flight-tasks': inFlight.verdict === 'ok' ? null : '停止认领新任务并等待在途运行收敛，再重新体检',
    }),
  })
}
