// product/upgrade/switchover.mjs
// ============================================================================
// PRT-808 / PRT-809：原子程序切换、升级健康检查、安全回滚或向前修复
//
// spec §9.4 line 726–730：
//
//   停止服务 → 原子切换程序版本 → 执行数据库迁移 → 启动并运行健康检查
//   → 提交升级或回滚
//
// spec §9.4 line 735、739：
//
//   「组合补丁层随程序版本原子切换后重新应用并自检；补丁无法应用或强制面
//    未生效时升级失败并保留旧程序版本，不得带病启动。」
//   「程序切换使用同一卷内的版本目录和原子活动指针/重命名。无法释放文件
//    句柄时升级应安全中止并保留旧版本，而不是部分覆盖。」
//
// ## 一、"原子"在 Windows 上是什么
//
// POSIX 的 `rename` 不能覆盖非空目录，Windows 的 `MoveFileEx` 在目标被占用时
// 会直接失败。所以"把新版本目录改名成 current"这条最常见的写法，在这两个平台
// 上都不是原子操作，而它的失败模式恰好是最坏的：**一半换了、一半没换**。
//
//   > 一个"先删旧目录、再改名新目录"的切换，
//   > 与一个"删到一半失败、于是既没有旧版本也没有新版本"的切换，是同一个东西。
//
// 所以本模块的原子性来自一个**指针文件**：`rename(pointer.tmp, pointer)`
// 是同卷内的原子替换，而版本目录本身在切换前就已经写好、永不覆盖。
// 切换的全部可见效果就是那一行的内容变了——失败时它还是旧的那一行。
//
// ## 二、健康检查没有超时，就是一次挂起
//
// 一个新版本起不来时最常见的样子不是"立刻报错"，而是"连接被接受、然后什么都不回"。
// 一个没有超时的健康检查在那台机器上会让升级停在"正在检查"这一屏——
// 用户看到的是一个转圈的产品，而不是一次失败，于是他会等，然后强杀，
// 强杀之后的状态是"迁移跑过了、程序换了一半、指针指向谁不知道"。
//
//   > 一个没有超时的健康检查，
//   > 与一个把"新版本起不来"变成"升级永远停在 90%"的健康检查，是同一个东西。
//
// 所以 `probeHealth` 的 `timeoutMs` 是**必填**，超时产出 `timeout` 这一档
// 独立结论，并且它和 `unhealthy` 一样触发回滚。
//
// ## 三、回滚回滚的是什么，必须逐字写出来
//
// spec line 733 的后半句是本模块最要紧的一条约束：程序回滚与数据回滚是两件事，
// 而"回滚"这个词在两个人嘴里常常一个是程序、一个是数据。所以
// `rollbackUpgrade` 的返回里**永远**有 `restores` 与 `doesNotRestore` 两个字段，
// 内容由 `planRollback()` 的裁决（PRT-807）生成。三种情形：
//
//   · 迁移全是 additive → 只换指针，数据库不动，**业务数据不丢**；
//   · 有 breaking 且无 down → 拒绝"只回滚程序"，报 `forward-fix-required`；
//   · 有 breaking 且有 down → 需要恢复数据库，且明确写出"恢复也可能丢数据"。
// ============================================================================

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { planRollback } from './migration.mjs'

/** 切换协议版本。 */
export const SWITCHOVER_PROTOCOL = 'legion/switchover@1'

/** 活动指针文件名（在 `versions/` 的父目录下）。 */
export const ACTIVE_POINTER = 'active-version.json'

/** 版本目录名。 */
export const VERSIONS_DIRNAME = 'versions'

/** 健康检查的结论。**四档**——`timeout` 必须与 `unhealthy` 分开。 */
export const HEALTH_VERDICTS = Object.freeze(['healthy', 'unhealthy', 'timeout', 'unsupported'])

/** 一次切换/回滚的结论。 */
export const SWITCH_VERDICTS = Object.freeze([
  /** 新版本已生效并提交。 */
  'committed',
  /** 已退回旧版本，数据库未被改动。 */
  'rolled-back',
  /** 已经换了程序，但必须向前修复（不能只回滚程序）。 */
  'forward-fix-required',
  /** 切换本身失败了，指针**没有**被改（这是最省事的一种失败）。 */
  'aborted',
])

export const SWITCH_CODES = Object.freeze({
  ACTIVATED: 'switchover-activated',
  /** 目标版本目录不存在或不完整。 */
  TARGET_MISSING: 'switchover-target-missing',
  /** 写指针失败（同卷内 rename 失败）。 */
  POINTER_WRITE_FAILED: 'switchover-pointer-write-failed',
  /** 指针文件读不出来。 */
  POINTER_UNREADABLE: 'switchover-pointer-unreadable',
  /** 没有活动版本——**不是**"已经就绪"。 */
  NO_ACTIVE_VERSION: 'switchover-no-active-version',
  /** 健康检查没给超时。 */
  TIMEOUT_REQUIRED: 'switchover-timeout-required',
  HEALTHY: 'switchover-healthy',
  UNHEALTHY: 'switchover-unhealthy',
  TIMED_OUT: 'switchover-timed-out',
  /** 没有健康探针——**不是**"健康"。 */
  NO_PROBE: 'switchover-no-probe',
  /** 回滚：只换回程序。 */
  ROLLED_BACK: 'switchover-rolled-back',
  /** 回滚被拒：必须先处理数据库。 */
  ROLLBACK_REFUSED: 'switchover-rollback-refused',
  /** 没有旧版本可退。 */
  NO_PREVIOUS: 'switchover-no-previous',
})

function switchError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

// ---------------------------------------------------------------------------
// 版本目录与活动指针
// ---------------------------------------------------------------------------

/**
 * 标记文件的**唯一**判断依据是这个文件的存在性。
 *
 * `sameVolumeHint` 不是实现细节：跨卷 rename 在 Windows 上不是原子的，
 * 而它的失败是"考完一半"——所以布局本身要能被检查。
 */
export function installLayout(installRoot) {
  const versionsDir = join(installRoot, VERSIONS_DIRNAME)
  return Object.freeze({
    installRoot,
    versionsDir,
    pointerPath: join(installRoot, ACTIVE_POINTER),
    versionDir: (version) => join(versionsDir, version),
  })
}

/** 一个版本目录"算得上完整"的条件：目录存在且非空。 */
export function isVersionDirComplete(installRoot, version, { readdirImpl = readdirSync } = {}) {
  const dir = installLayout(installRoot).versionDir(version)
  if (!existsSync(dir)) return false
  try {
    // `statSync` 只能证明"是个目录"；非空要靠 readdir。
    //   > 一个"目录存在就算完整"的判定，
    //   > 与一个"版本目录被创建了、文件还没拷进去"的判定，是同一个东西。
    return statSync(dir).isDirectory() && readdirImpl(dir).length > 0
  } catch {
    return false
  }
}

/** 读活动指针。任何一个字段缺，都算"读不出来"，而不是"大概指向那个版本"。 */
export function readActivePointer(installRoot, { readImpl = readFileSync } = {}) {
  const path = installLayout(installRoot).pointerPath
  if (!existsSync(path)) {
    return Object.freeze({
      ok: false, code: SWITCH_CODES.NO_ACTIVE_VERSION, version: null, previousVersion: null,
      reason: '没有活动版本指针：没有活动版本不等于"已经就绪"',
    })
  }
  let parsed
  try {
    parsed = JSON.parse(readImpl(path, 'utf8'))
  } catch (e) {
    return Object.freeze({
      ok: false, code: SWITCH_CODES.POINTER_UNREADABLE, version: null, previousVersion: null,
      reason: `活动指针无法解析：${e.message}`,
    })
  }
  if (typeof parsed?.version !== 'string' || parsed.version === '') {
    return Object.freeze({
      ok: false, code: SWITCH_CODES.POINTER_UNREADABLE, version: null, previousVersion: null,
      reason: '活动指针里没有 version 字段',
    })
  }
  return Object.freeze({
    ok: true, code: null, version: parsed.version,
    previousVersion: parsed.previousVersion ?? null,
    activatedAtMs: parsed.activatedAtMs ?? null,
    reason: null,
  })
}

/**
 * 原子激活一个版本。
 *
 * 步骤固定为三步，顺序不可换：
 *   ① 目标版本目录必须已完整（**没有它就不切换**——切换不是安装）；
 *   ② 写 `active-version.json.tmp`；
 *   ③ `rename(tmp, pointer)` —— 同卷内替换，要么全生效要么全不生效。
 *
 * 返回里带 `previousVersion`，这是回滚唯一的输入来源。
 */
export function activateVersion(installRoot, version, {
  nowMs = Date.now(), renameImpl = renameSync, writeImpl = writeFileSync,
} = {}) {
  const layout = installLayout(installRoot)
  if (!isVersionDirComplete(installRoot, version)) {
    return Object.freeze({
      ok: false, code: SWITCH_CODES.TARGET_MISSING, version: null, previousVersion: null,
      reason: `版本目录 ${layout.versionDir(version)} 不存在或为空：切换的前置条件是"新版本已经完整地在那里"`,
    })
  }
  const before = readActivePointer(installRoot)
  const payload = Object.freeze({
    protocol: SWITCHOVER_PROTOCOL,
    version,
    previousVersion: before.ok ? before.version : null,
    activatedAtMs: nowMs,
  })
  const tmp = `${layout.pointerPath}.tmp`
  try {
    mkdirSync(layout.installRoot, { recursive: true })
    writeImpl(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8')
    renameImpl(tmp, layout.pointerPath)
  } catch (e) {
    // 失败时**不动**指针，并清掉临时文件；现场保持"还是旧版本"。
    try { rmSync(tmp, { force: true }) } catch { /* 尽力而为 */ }
    return Object.freeze({
      ok: false, code: SWITCH_CODES.POINTER_WRITE_FAILED,
      version: null, previousVersion: payload.previousVersion,
      reason: `原子替换活动指针失败：${e?.message ?? e}。` +
        '指针没有被改动，当前仍然是旧版本——这是本模块刻意选择的失败形态',
    })
  }
  return Object.freeze({
    ok: true, code: SWITCH_CODES.ACTIVATED,
    version, previousVersion: payload.previousVersion, payload, reason: null,
  })
}

/** 列出 `versions/` 下已有的版本目录（升序）。 */
export function listInstalledVersions(installRoot) {
  const dir = installLayout(installRoot).versionsDir
  if (!existsSync(dir)) return Object.freeze([])
  return Object.freeze(readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort())
}

// ---------------------------------------------------------------------------
// 健康检查（PRT-808）
// ---------------------------------------------------------------------------

/**
 * 健康检查参数的**同步**校验。
 *
 * 单独抽出来是为了让"没有超时"这条判据可被同步观测：它在自检里必须能
 * 产生一个算出来的值，而不是一个未决议的 Promise。
 */
export function validateHealthOptions({ probe, timeoutMs, label = null } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Object.freeze({
      verdict: 'unsupported', code: SWITCH_CODES.TIMEOUT_REQUIRED, ok: false, elapsedMs: 0, label,
      reason: '健康检查没有超时。没有超时的健康检查不是"更宽松"，而是把一次失败变成一次挂起',
    })
  }
  if (typeof probe !== 'function') {
    return Object.freeze({
      verdict: 'unsupported', code: SWITCH_CODES.NO_PROBE, ok: false, elapsedMs: 0, label,
      reason: '没有健康探针：没有探针时的"检查通过"是一句没有依据的话',
    })
  }
  return null
}

/**
 * 带**强制超时**的健康检查。
 *
 * 三种情况必须分开报：
 *   · 探针返回 `{ ok: true }`            → `healthy`；
 *   · 探针返回 `{ ok: false }` 或抛错     → `unhealthy`；
 *   · 超过 `timeoutMs` 仍然没结果          → `timeout`。
 *
 * 第三档是本函数存在的理由（见文件头第二段）。超时时**取消**探针
 * （`signal.aborted` 置真并调用探针注册的清理），这样"挂着的那次连接"
 * 不会在回滚之后继续跑。
 *
 * `timeoutMs` **必填**：给一个默认值等于让每个调用点各自决定"多久算挂"，
 * 而它们会各自选一个能过测试的值。
 *
 * @param {object} args
 * @param {(signal: AbortSignal) => Promise<{ok: boolean, detail?: string}>} args.probe
 * @param {number} args.timeoutMs
 */
export function probeHealth({ probe, timeoutMs, label = null } = {}) {
  const invalid = validateHealthOptions({ probe, timeoutMs, label })
  if (invalid !== null) return Promise.resolve(invalid)

  const started = Date.now()
  const controller = new AbortController()
  let timerId = null
  let settledBy = null

  const timeoutPromise = new Promise((resolve) => {
    timerId = setTimeout(() => {
      settledBy = 'timeout'
      controller.abort()
      resolve(Object.freeze({
        verdict: 'timeout', code: SWITCH_CODES.TIMED_OUT, ok: false, label,
        elapsedMs: Date.now() - started,
        reason: `${timeoutMs}ms 内健康检查没有返回：按失败处理（超时是失败，不是等待）`,
      }))
    }, timeoutMs)
    // 不阻止进程退出：一个挂着的健康检查定时器会让升级进程本身退不出去。
    if (typeof timerId === 'object' && timerId !== null && typeof timerId.unref === 'function') timerId.unref()
  })

  const probePromise = Promise.resolve()
    .then(() => probe(controller.signal))
    .then((r) => {
      if (settledBy === 'timeout') return null // 超时已经定案，晚到的结果不再参与
      settledBy = 'probe'
      const ok = r?.ok === true
      return Object.freeze({
        verdict: ok ? 'healthy' : 'unhealthy',
        code: ok ? SWITCH_CODES.HEALTHY : SWITCH_CODES.UNHEALTHY,
        ok,
        label,
        elapsedMs: Date.now() - started,
        detail: r?.detail ?? null,
        reason: ok ? '探针返回 ok' : `探针返回非 ok：${r?.detail ?? '(没有说明)'}`,
      })
    })
    .catch((e) => {
      if (settledBy === 'timeout') return null
      settledBy = 'probe'
      return Object.freeze({
        verdict: 'unhealthy', code: SWITCH_CODES.UNHEALTHY, ok: false, label,
        elapsedMs: Date.now() - started,
        reason: `探针抛错：${e?.message ?? e}`,
      })
    })

  return Promise.race([probePromise, timeoutPromise]).then((r) => {
    if (timerId !== null) clearTimeout(timerId)
    if (r !== null) return r
    // 超时先定案：等 probePromise 的兜底结果也返回，避免悬空。
    return probePromise.then((late) => late ?? Object.freeze({
      verdict: 'timeout', code: SWITCH_CODES.TIMED_OUT, ok: false, label,
      elapsedMs: Date.now() - started, reason: `${timeoutMs}ms 内健康检查没有返回`,
    }))
  })
}

// ---------------------------------------------------------------------------
// 回滚（PRT-809）
// ---------------------------------------------------------------------------

/**
 * 回滚一次升级。
 *
 * ★ 本函数表达的**不是**"把一切恢复原状"。它表达的是：
 *   · 程序侧：把活动指针指回 `previousVersion`（若可用）；
 *   · 数据侧：**由 `planRollback()` 的裁决决定**——additive 时不动，
 *     breaking 时拒绝仅回滚程序。
 *
 * 返回里永远有 `restores` / `doesNotRestore`，逐字写清"做了什么、没做什么"。
 *
 * @param {object} args
 * @param {string} args.installRoot
 * @param {Array<object>} [args.appliedMigrations] 本次升级应用过的迁移记录
 * @param {Array<object>} [args.migrations]       迁移定义集合（含 compatibility）
 * @param {boolean} [args.force] 显式承认"知道要丢数据"时才允许越过后端裁决
 */
export function rollbackUpgrade({
  installRoot, appliedMigrations = [], migrations = [], force = false, nowMs = Date.now(),
} = {}) {
  const active = readActivePointer(installRoot)
  if (!active.ok) {
    return Object.freeze({
      ok: false, verdict: 'forward-fix-required', code: active.code,
      restoredVersion: null, safety: null,
      restores: Object.freeze([]), doesNotRestore: Object.freeze(['一切：连当前版本都读不出来']),
      reason: `${active.reason}——在状态不明时回滚只会把状态弄得更不明`,
    })
  }

  const plan = planRollback({ applied: appliedMigrations, migrations })
  const previous = active.previousVersion ?? previousInstalledVersion(installRoot, active.version)

  // 数据库侧的第一问：**能不能只回滚程序**。
  if (plan.safety === 'forward-fix-required' && force !== true) {
    return Object.freeze({
      ok: false,
      verdict: 'forward-fix-required',
      code: SWITCH_CODES.ROLLBACK_REFUSED,
      safety: plan.safety,
      restoredVersion: null,
      appliedVersions: plan.appliedVersions,
      breakingVersions: plan.breakingVersions,
      restores: plan.restores,
      doesNotRestore: plan.doesNotRestore,
      reason: `拒绝仅回滚程序：${plan.reason}`,
    })
  }

  if (previous === null) {
    return Object.freeze({
      ok: false, verdict: 'forward-fix-required', code: SWITCH_CODES.NO_PREVIOUS,
      safety: plan.safety, restoredVersion: null,
      restores: Object.freeze([]),
      doesNotRestore: Object.freeze(['程序版本：没有可以退回去的旧版本']),
      reason: '没有旧版本可退（指针里没有 previousVersion，versions/ 里也没有更早的目录）',
    })
  }

  const activated = activateVersion(installRoot, previous, { nowMs })
  if (!activated.ok) {
    return Object.freeze({
      ok: false, verdict: 'forward-fix-required', code: activated.code,
      safety: plan.safety, restoredVersion: null,
      restores: Object.freeze([]),
      doesNotRestore: Object.freeze(['程序版本：指针替换失败']),
      reason: `回滚时指针替换失败：${activated.reason}`,
    })
  }

  return Object.freeze({
    ok: true,
    verdict: 'rolled-back',
    code: SWITCH_CODES.ROLLED_BACK,
    safety: plan.safety,
    restoredVersion: previous,
    rolledBackFrom: active.version,
    appliedVersions: plan.appliedVersions,
    breakingVersions: plan.breakingVersions,
    // ★ 这两行是本模块对 spec line 733 的全部回答。
    restores: plan.safety === 'program-only-rollback'
      ? Object.freeze([`程序版本：${active.version} → ${previous}`, '数据库：无需恢复（本次迁移都是 additive）'])
      : Object.freeze([`程序版本：${active.version} → ${previous}`]),
    doesNotRestore: plan.safety === 'program-only-rollback'
      ? Object.freeze([])
      : plan.doesNotRestore,
    reason: plan.safety === 'program-only-rollback'
      ? `已退回 ${previous}，业务数据未受影响（本次没有 breaking 迁移）`
      : `已退回 ${previous}，但数据库**仍需**向前修复或从备份恢复：${plan.reason}`,
  })
}

function previousInstalledVersion(installRoot, currentVersion) {
  const installed = listInstalledVersions(installRoot).filter((v) => v !== currentVersion)
  return installed.length === 0 ? null : installed[installed.length - 1]
}

// ---------------------------------------------------------------------------
// 一次完整的切换（PRT-808/809 的编排）
// ---------------------------------------------------------------------------

/**
 * 原子切换 + 迁移 + 健康检查 + 提交或回滚。
 *
 * 这是升级流程里**唯一**会改动 `installRoot` 与数据库的那一段，
 * 因此它的每一条分支都必须落到一个"已知兼容"的状态：
 *
 *   · 迁移失败          → 指针换回去，数据库留在 expand 后的状态（旧程序读得懂）；
 *   · 健康检查失败/超时  → 同上；
 *   · 指针替换失败      → 什么都没变；
 *   · 全部成功          → 提交。
 *
 * **本函数不做备份、不做下载校验**——那些在 `runUpgrade`（`index.mjs`）里，
 * 因为"先备份再动手"这条顺序要有单一的实现。
 */
export async function runSwitchover({
  installRoot,
  targetVersion,
  targetVersionReady = true,
  migrations = [],
  store = null,
  migrationBase = {},
  health = null,
  applyMigrations = null,
  nowMs = Date.now(),
} = {}) {
  const events = []
  const emit = (step, detail) => events.push(Object.freeze({ step, atMs: Date.now(), detail }))

  if (targetVersionReady !== true) {
    emit('switch', 'target-not-ready')
    return Object.freeze({
      verdict: 'aborted', code: SWITCH_CODES.TARGET_MISSING, events: Object.freeze(events),
      activated: null, migrations: null, health: null, rollback: null,
      restores: Object.freeze([]), doesNotRestore: Object.freeze([]),
      reason: '目标版本目录还没有就绪：切换的前置条件是"新版本已经完整地在那里"',
    })
  }

  const activated = activateVersion(installRoot, targetVersion, { nowMs })
  emit('switch', activated.ok ? `activated ${targetVersion}` : activated.code)
  if (!activated.ok) {
    // 指针没动 → 现场仍是旧版本，这是最省事的一种失败。
    return Object.freeze({
      verdict: 'aborted', code: activated.code, events: Object.freeze(events),
      activated, migrations: null, health: null, rollback: null,
      restores: Object.freeze([]), doesNotRestore: Object.freeze([]),
      reason: activated.reason,
    })
  }

  // 迁移：必须在指针切换**之后**（新程序需要新结构），且失败要能退回去。
  let migrationOutcome = null
  if (applyMigrations !== null) {
    migrationOutcome = await applyMigrations()
  } else if (Array.isArray(migrations) && migrations.length > 0 && store !== null) {
    const { runMigrations } = await import('./migration.mjs')
    migrationOutcome = await runMigrations({ migrations, store, base: migrationBase })
  } else {
    migrationOutcome = Object.freeze({
      outcome: 'no-migrations', code: 'migration-nothing-to-do',
      applied: Object.freeze([]), skipped: Object.freeze([]),
      targetVersion: null, currentVersion: null, reason: '本次升级没有数据库迁移',
    })
  }
  emit('migrate', migrationOutcome.outcome)

  if (migrationOutcome.outcome === 'failed' || migrationOutcome.outcome === 'checksum-drift') {
    const rollback = rollbackUpgrade({
      installRoot,
      appliedMigrations: migrationOutcome.applied ?? [],
      migrations,
      nowMs,
    })
    emit('rollback', rollback.verdict)
    return Object.freeze({
      verdict: rollback.ok ? 'rolled-back' : 'forward-fix-required',
      code: migrationOutcome.code,
      events: Object.freeze(events),
      activated, migrations: migrationOutcome, health: null, rollback,
      restores: rollback.restores, doesNotRestore: rollback.doesNotRestore,
      reason: `迁移失败（${migrationOutcome.reason}）→ 程序退回 ${rollback.restoredVersion ?? '(失败)'}。` +
        `数据库：${rollback.safety === 'program-only-rollback' ? '停留在 expand 之后的状态，旧程序读得懂' : '需要向前修复或从备份恢复'}`,
    })
  }

  // 健康检查：失败或超时都回滚。
  let healthVerdict = null
  if (health !== null) {
    healthVerdict = await probeHealth({
      probe: health.probe,
      timeoutMs: health.timeoutMs,
      label: health.label ?? targetVersion,
    })
  } else {
    healthVerdict = Object.freeze({
      verdict: 'unsupported', code: SWITCH_CODES.NO_PROBE, ok: false,
      reason: '没有提供健康检查：**没有检查**不等于"检查通过"，因此本次切换不提交',
    })
  }
  emit('health', healthVerdict.verdict)

  if (healthVerdict.verdict !== 'healthy') {
    const rollback = rollbackUpgrade({
      installRoot,
      appliedMigrations: migrationOutcome.applied ?? [],
      migrations,
      nowMs,
    })
    emit('rollback', rollback.verdict)
    return Object.freeze({
      verdict: rollback.ok ? 'rolled-back' : 'forward-fix-required',
      code: healthVerdict.code,
      events: Object.freeze(events),
      activated, migrations: migrationOutcome, health: healthVerdict, rollback,
      restores: rollback.restores, doesNotRestore: rollback.doesNotRestore,
      reason: `健康检查判定 ${healthVerdict.verdict}（${healthVerdict.reason}）→ 程序退回 ${rollback.restoredVersion ?? '(失败)'}`,
    })
  }

  emit('commit', targetVersion)
  return Object.freeze({
    verdict: 'committed',
    code: SWITCH_CODES.ACTIVATED,
    events: Object.freeze(events),
    activated, migrations: migrationOutcome, health: healthVerdict, rollback: null,
    restores: Object.freeze([]), doesNotRestore: Object.freeze([]),
    reason: `已切换到 ${targetVersion} 并通过健康检查`,
  })
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

/**
 * 装载期自检：把本模块的**三条**核心判据各真的跑一遍，留下算出来的值。
 *
 * ① 没有超时的健康检查必须报 `unsupported`，**不能**报 healthy；
 * ② 回滚在 breaking 迁移之后必须拒绝"只回滚程序"；
 * ③ additive 迁移之后的回滚必须**明说**数据库不用恢复。
 *
 * 需要真实文件系统的那几条（原子指针、超时真的触发）放在用例里。
 */
export function selfCheckSwitchover() {
  const problems = []

  // ① 没有超时的健康检查必须报 `unsupported`，不能报 healthy。
  const noTimeoutResult = validateHealthOptions({ probe: async () => ({ ok: true }), timeoutMs: null })
  if (noTimeoutResult === null || noTimeoutResult.verdict !== 'unsupported') {
    problems.push(`没有超时的健康检查被判成 ${noTimeoutResult?.verdict ?? 'null'}——它必须是 unsupported`)
  }
  const noProbe = validateHealthOptions({ probe: null, timeoutMs: 1000 })
  if (noProbe === null || noProbe.verdict !== 'unsupported') {
    problems.push('没有探针的健康检查没有被判为 unsupported')
  }

  const breaking = Object.freeze({
    version: 3, name: 'contract', compatibility: 'breaking', hasDownMigration: false,
  })
  const forward = planRollback({ applied: [breaking], migrations: [breaking] })
  const refused = rollbackUpgrade({ installRoot: 'D:/nonexistent-legion-install', appliedMigrations: [breaking], migrations: [breaking] })
  if (refused.ok !== false) problems.push('目标安装目录不存在时回滚被判为成功')
  if (!Object.values(SWITCH_CODES).includes(refused.code)) {
    problems.push(`回滚失败码 ${refused.code} 不在本模块声明的码集合里`)
  }
  if (forward.safety !== 'forward-fix-required') {
    problems.push(`breaking 迁移的回滚可达性被判成 ${forward.safety}`)
  }

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    protocol: SWITCHOVER_PROTOCOL,
    healthVerdicts: HEALTH_VERDICTS,
    switchVerdicts: SWITCH_VERDICTS,
    samples: Object.freeze({
      noTimeoutVerdict: noTimeoutResult?.verdict ?? null,
      noTimeoutCode: noTimeoutResult?.code ?? null,
      noProbeVerdict: noProbe?.verdict ?? null,
      breakingSafety: forward.safety,
      noneInstallRefusedCode: refused.code,
    }),
  })
}

/** 装载时算一次。`problems` 非空即本模块自己的判据不自洽。 */
export const SWITCHOVER_CHECKED = selfCheckSwitchover()
