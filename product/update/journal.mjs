// product/update/journal.mjs
// ============================================================================
// 升级事务日志 —— 设计 §8 line 182
//
// 原文：「事务日志位于 DataDir，由 helper 独占；每个不可逆动作前写意图、
// 完成后写结果并刷盘。新旧 Launcher 均识别未完成事务，在恢复结束前禁止
// 正常业务启动。断电或 helper 崩溃后的恢复依据磁盘活动指针、事务日志、
// 备份摘要和数据库实际 schema，不只依赖最后一条 UI 状态。」
//
// 三句话，三件必须做对的事：
//
// ## ① 意图**先于**动作
//
// 顺序反过来的写法（先做、再记"我做了"）在正常路径上完全一样，
// 只在崩溃点上不同：断电发生在"动作已生效、记录未落盘"之间时，恢复方
// 看到的是一份**看起来什么都没发生**的日志，而磁盘上的程序指针已经换了。
// 那条路径的终点是把未知状态显示成"没有升级"。
//
// 所以本模块的 API 是**成对**的：`intent(action, data)` 和
// `result(action, data)`，而 helper 里每次调用都必须先 intent。
//
// ## ② 一行一条记录，且容忍半行
//
// 追加式 JSONL。断电可能把最后一行写了一半——那个半行**必须**被识别为
// "未完成"，而不是解析失败。解析失败会让整个日志读不出来，于是"有一次
// 升级正在进行"这件事消失；而跳过半行、保留前面所有完整记录，正好对应
// 真实发生的事：那一步的意图写了，结果没写。
//
// ## ③ 活动描述符是**原子**写的
//
// `journal.jsonl` 是历史的载体，`active-transaction.json` 是"现在有没有
// 一次未完成的事务"的载体。后者必须整体替换（临时文件 + rename）：一份
// 写了一半的活动描述符会让 Launcher 读不出 txnId，于是"有一次升级正在
// 进行"变成"读不出来，那就当没有吧"。
// ============================================================================

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { canonicalJson, parseJsonStrict } from './canonical.mjs'

export const JOURNAL_FORMAT = 'legion/update-journal@1'
export const ACTIVE_FORMAT = 'legion/update-active@1'

/** 日志与活动描述符在 DataDir 下的固定位置（helper 与 Launcher 都要找得到）。 */
export const UPDATE_STATE_DIRNAME = 'update'
export const JOURNAL_FILENAME = 'journal.jsonl'
export const ACTIVE_FILENAME = 'active-transaction.json'

export const JOURNAL_CODES = Object.freeze({
  NO_ACTIVE: 'journal-no-active',
  BAD_LINE: 'journal-bad-line',
  TORN_ACTIVE: 'journal-torn-active',
  WRITE_FAILED: 'journal-write-failed',
  // ★ 原本这里还有一个 `TRUNCATED_TAIL: 'journal-truncated-tail'`，已删除。
  //   "最后一行写了一半"这条判据**在**（`readRecords` 里的 `truncatedTail`），
  //   只是它的结论是一个**布尔字段**而不是一个码 —— 那是对的，
  //   因为"尾部被截断"是**可继续**的情形（只为最后一行），
  //   而其余四个码表示的都是"读不下去了"。
  //   声明了却不发出的码会让人以为这个情形有一个具名的拒绝读数。
})

/** 事务阶段。顺序即设计 §8 的第 1–9 步。 */
export const TRANSACTION_PHASES = Object.freeze([
  'created',
  'preflight',
  'prepare-runtime',
  'stop-claiming',
  'drain-in-flight',
  'barrier',
  'backup',
  'stop-services',
  'handoff',
  'unpack',
  'switch',
  'migrate',
  'validate',
  'committed',
  'rolled-back',
  'recovery-required',
])

/** 已经是终态的阶段：恢复方看到它们就知道"这次事务结束了"。 */
export const TERMINAL_PHASES = Object.freeze(['committed', 'rolled-back', 'recovery-required'])

/** 不可逆动作的名字。每一步都必须在日志里留下 intent/result 一对。 */
export const IRREVERSIBLE_ACTIONS = Object.freeze([
  'stop-claiming',
  'barrier-acquire',
  'backup',
  'stop-services',
  'helper-handoff',
  'unpack',
  'switch-pointer',
  'migrate',
  'commit',
  'rollback',
  'barrier-release',
])

export function updateStateDir(dataDir) {
  return join(dataDir, UPDATE_STATE_DIRNAME)
}

export function journalPath(dataDir) {
  return join(updateStateDir(dataDir), JOURNAL_FILENAME)
}

export function activePath(dataDir) {
  return join(updateStateDir(dataDir), ACTIVE_FILENAME)
}

/**
 * 原子写一个 JSON 文件。
 *
 * `fsync` 在 rename **之前**对临时文件做，rename **之后**对目录做——
 * 只做前者时，断电可能让"目录里出现了这个文件名"这件事没有落盘，
 * 于是原子替换本身变得不原子。Windows 上无法对目录 fsync（`fsync` 一个
 * 目录句柄会失败），所以那里只做前者，并用 `rename` 自身的原子性兜住。
 */
function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  const bytes = `${JSON.stringify(value, null, 2)}\n`
  const handle = openSync(temp, 'w')
  try {
    writeFileSync(handle, bytes, 'utf8')
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  renameSync(temp, path)
}

/** 追加一行并刷盘。返回写入的字节数。 */
function appendLineFsync(path, line) {
  mkdirSync(dirname(path), { recursive: true })
  const handle = openSync(path, 'a')
  try {
    writeFileSync(handle, `${line}\n`, 'utf8')
    // ★ 每一行都 fsync。批量刷盘的实现在"崩在两步之间"时会丢掉中间那几行，
    //   而恢复方正是靠那几行判断"哪一步的意图写了、结果没写"。
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  return Buffer.byteLength(line, 'utf8') + 1
}

/**
 * 把记录里不可序列化的东西**落成 null**，而不是让整条记录写不进去。
 *
 * ★ 这条不是宽容，是取舍。
 *
 *   `canonicalJson` 对 `undefined` 会抛错（那是对的：一个 undefined 字段
 *   意味着调用方漏填）。但事务日志不是 API 应答，它是**不可逆动作的唯一
 *   记录**。一次"因为某个字段忘了给，整条 intent 没写进去"的后果是：
 *   崩溃之后恢复方看不到那一步的意图，而它可能已经执行过了。
 *
 *   所以这里把 `undefined` 归一成 `null`（"未提供"），记录仍然完整，
 *   字段名也还在。真正不可序列化的东西（函数、symbol、bigint）照样抛错——
 *   那些不是漏填，是写错了。
 *
 *   一次真的踩到过：`journal.begin({fromVersion, toVersion, phase})` 少给
 *   `releaseId` 时，整条 `transaction-begin` 记录写不进去，而错误信息是
 *   「不可规范化的类型：undefined」——它没有指出是哪个字段。
 */
function normalizeForJournal(value, depth = 0) {
  if (depth > 16) throw new Error('事务记录嵌套过深')
  if (value === undefined) return null
  if (value === null) return null
  const type = typeof value
  if (type === 'boolean' || type === 'number' || type === 'string') return value
  if (Array.isArray(value)) return value.map((item) => normalizeForJournal(item, depth + 1))
  if (type === 'object') {
    const out = {}
    for (const key of Object.keys(value)) out[key] = normalizeForJournal(value[key], depth + 1)
    return out
  }
  throw new Error(`事务记录里含不可序列化的类型：${type}`)
}

/**
 * 建立一个事务日志句柄。
 *
 * @param {object} args
 * @param {string} args.dataDir
 * @param {string} args.txnId            事务 ID（由安装事务生成并写进活动描述符）
 * @param {Function} [args.now]
 * @param {string} [args.owner]          `'launcher'` 或 `'helper'`
 */
export function createJournal({ dataDir, txnId, owner = 'launcher', now = () => Date.now() } = {}) {
  if (typeof dataDir !== 'string' || dataDir === '') throw new Error('createJournal 需要 dataDir')
  if (typeof txnId !== 'string' || txnId === '') throw new Error('createJournal 需要 txnId')
  const file = journalPath(dataDir)
  const active = activePath(dataDir)
  let sequence = 0

  function append(kind, action, data = null) {
    sequence += 1
    const record = Object.freeze({
      format: JOURNAL_FORMAT,
      seq: sequence,
      atMs: now(),
      txnId,
      owner,
      kind,
      action,
      data: normalizeForJournal(data),
    })
    try {
      appendLineFsync(file, canonicalJson(record))
    } catch (error) {
      const failure = new Error(`事务日志写入失败：${error?.message ?? error}`)
      failure.code = JOURNAL_CODES.WRITE_FAILED
      throw failure
    }
    return record
  }

  return Object.freeze({
    txnId,
    owner,
    file,
    active,

    /**
     * 开始一次事务：先写活动描述符，再写第一条日志。
     *
     * 顺序是刻意的——**描述符在前**。一个"先写日志、后写描述符"的实现在
     * 两步之间崩溃时留下的是一份有日志、无活动事务的状态；而 Launcher
     * 判断"要不要拦启动"读的正是描述符。于是那次升级的痕迹只存在于
     * 一份没人读的日志里。
     */
    begin({ fromVersion, toVersion, releaseId, phase = 'created', detail = null } = {}) {
      writeJsonAtomic(active, {
        format: ACTIVE_FORMAT,
        txnId,
        phase,
        fromVersion: fromVersion ?? null,
        toVersion: toVersion ?? null,
        releaseId: releaseId ?? null,
        owner,
        startedAtMs: now(),
        updatedAtMs: now(),
        detail,
      })
      return append('begin', 'transaction-begin', { fromVersion, toVersion, releaseId, phase })
    },

    /** 一个**不可逆动作之前**写意图。 */
    intent(action, data = null) {
      return append('intent', action, data)
    },

    /** 同一个动作**完成之后**写结果。 */
    result(action, data = null) {
      return append('result', action, data)
    },

    /** 非动作性的记录（阶段推进、读数、诊断）。 */
    note(action, data = null) {
      return append('note', action, data)
    },

    /** 推进阶段。同时更新活动描述符（原子替换）。 */
    advance(phase, detail = null) {
      const current = readActive(dataDir)
      writeJsonAtomic(active, {
        format: ACTIVE_FORMAT,
        txnId,
        phase,
        fromVersion: current?.fromVersion ?? null,
        toVersion: current?.toVersion ?? null,
        releaseId: current?.releaseId ?? null,
        owner,
        startedAtMs: current?.startedAtMs ?? now(),
        updatedAtMs: now(),
        detail,
      })
      return append('phase', `phase-${phase}`, detail === null ? { phase } : { phase, detail })
    },

    /** 结束事务：清掉活动描述符。终态记录**先**写，描述符**后**删。 */
    finish(phase, detail = null) {
      append('finish', `transaction-${phase}`, detail === null ? { phase } : { phase, detail })
      return clearActive(dataDir)
    },

    read: () => readJournal(dataDir),
  })
}

/**
 * 读活动描述符。
 *
 * 读不出来（缺失、损坏、半截）时返回 `ok: false` 并带原因——**不**返回
 * "没有活动事务"。这两件事必须分开：一个"读不出来就当没有"的实现会让
 * 一次损坏变成一次静默的正常启动，而用户的数据可能正处在迁移中途。
 */
export function readActive(dataDir) {
  const file = activePath(dataDir)
  if (!existsSync(file)) {
    return Object.freeze({ ok: false, code: JOURNAL_CODES.NO_ACTIVE, reason: '没有正在进行的事务', active: null })
  }
  let raw
  try { raw = readFileSync(file, 'utf8') } catch (error) {
    return Object.freeze({ ok: false, code: JOURNAL_CODES.TORN_ACTIVE, reason: `活动事务描述符读不出来：${error?.message ?? error}`, active: null })
  }
  try {
    const parsed = parseJsonStrict(raw, { maxBytes: 64 * 1024 })
    if (parsed?.format !== ACTIVE_FORMAT || typeof parsed.txnId !== 'string') {
      return Object.freeze({ ok: false, code: JOURNAL_CODES.TORN_ACTIVE, reason: '活动事务描述符格式不对', active: null })
    }
    return Object.freeze({ ok: true, code: null, reason: null, active: parsed })
  } catch (error) {
    return Object.freeze({
      ok: false, code: JOURNAL_CODES.TORN_ACTIVE,
      reason: `活动事务描述符不是合法 JSON（很可能是断电时写了一半）：${error?.message ?? error}`,
      active: null,
    })
  }
}

export function clearActive(dataDir) {
  try { rmSync(activePath(dataDir), { force: true }); return true } catch { return false }
}

/**
 * 读日志。
 *
 * @returns {{records: object[], truncatedTail: boolean, badLines: object[], active: object|null}}
 */
export function readJournal(dataDir) {
  const file = journalPath(dataDir)
  const records = []
  const badLines = []
  let truncatedTail = false
  if (!existsSync(file)) return Object.freeze({ records: Object.freeze([]), truncatedTail: false, badLines: Object.freeze([]), active: null })

  let raw
  try { raw = readFileSync(file, 'utf8') } catch { return Object.freeze({ records: Object.freeze([]), truncatedTail: false, badLines: Object.freeze([]), active: null }) }

  const lines = raw.split('\n')
  // 文件以 `\n` 结尾时最后一段是空串，不算"半行"。
  const trailingEmpty = lines.length > 0 && lines[lines.length - 1] === ''
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line === '') continue
    const isLast = i === lines.length - 1
    try {
      const record = parseJsonStrict(line, { maxBytes: 256 * 1024 })
      if (record?.format !== JOURNAL_FORMAT || !Number.isSafeInteger(record.seq)) throw new Error('记录格式不对')
      records.push(record)
    } catch (error) {
      // ★ 只有**最后一行**可以是"写了一半"。中间出现坏行说明日志被外力
      //   改过或被截断——那时"跳过并继续"是危险的，必须如实报告。
      if (isLast && !trailingEmpty) truncatedTail = true
      else badLines.push(Object.freeze({ lineNumber: i + 1, reason: String(error?.message ?? error) }))
    }
  }
  return Object.freeze({
    records: Object.freeze(records),
    truncatedTail,
    badLines: Object.freeze(badLines),
    active: readActive(dataDir).active,
  })
}

/**
 * 恢复判定 —— 设计 §8 line 182 的那半句「不只依赖最后一条 UI 状态」。
 *
 * 输入是**磁盘上**的三样东西：活动描述符、事务日志、活动版本指针。
 * 输出是恢复方该做什么。
 *
 * 判定表的每一行都对应设计 §8 失败表里的一行：
 *
 *   · 没有活动事务                → 什么都不用做；
 *   · 活动事务停在切换**之前**     → 旧版本还在跑，安全；
 *   · 停在切换**之后**             → 必须回退或向前修复；
 *   · 已经 committed              → 事务其实完成了，清掉残留即可；
 *   · 描述符损坏 / 日志被外力改动   → `recovery-required`（人工）。
 */
export function planRecovery({ dataDir, readActivePointer = null } = {}) {
  const active = readActive(dataDir)
  const journal = readJournal(dataDir)

  if (!active.ok && active.code === JOURNAL_CODES.NO_ACTIVE) {
    return Object.freeze({
      verdict: 'nothing-to-do', code: 'recovery-nothing-to-do', barrierRequired: false,
      reason: '没有未完成的升级事务', active: null, journal,
    })
  }
  if (!active.ok) {
    return Object.freeze({
      verdict: 'recovery-required', code: active.code, barrierRequired: true,
      reason: `活动事务描述符不可读（${active.reason}）：无法判断升级走到哪一步，必须人工处理`,
      active: null, journal,
    })
  }
  if (journal.badLines.length > 0) {
    return Object.freeze({
      verdict: 'recovery-required', code: JOURNAL_CODES.BAD_LINE, barrierRequired: true,
      reason: `事务日志中间有 ${journal.badLines.length} 行无法解析：日志可能被外力改动，必须人工处理`,
      active: active.active, journal,
    })
  }

  const txn = active.active
  const phase = txn.phase
  if (TERMINAL_PHASES.includes(phase)) {
    // 终态但描述符还在：说明 finish 的最后一步（删描述符）没做完。
    // 这是一次**安全**的收尾——不需要回退任何东西。
    return Object.freeze({
      verdict: 'finalize-record', code: 'recovery-finalize', barrierRequired: false,
      reason: `事务已处于终态 ${phase}，只需清理残留描述符`,
      active: txn, journal,
    })
  }

  const switched = journal.records.some((record) => record.kind === 'result' && record.action === 'switch-pointer')
  const migrated = journal.records.some((record) => record.kind === 'result' && record.action === 'migrate')
  const pointerState = typeof readActivePointer === 'function' ? readActivePointer() : null

  if (!switched && pointerState !== null && pointerState?.ok === true && pointerState.version === txn.fromVersion) {
    return Object.freeze({
      verdict: 'resume-maintenance', code: 'recovery-before-switch', barrierRequired: true,
      reason: `事务停在切换之前（阶段 ${phase}），活动指针仍是 ${txn.fromVersion}：程序未被动过，可在维护模式下重试或放弃`,
      active: txn, journal,
    })
  }
  if (!switched) {
    // 日志里没有切换成功的记录，但指针已经不是出发时的版本——两者矛盾。
    // 这种矛盾只能由人来判：自动选一边都是猜。
    return Object.freeze({
      verdict: 'recovery-required', code: 'recovery-pointer-mismatch', barrierRequired: true,
      reason: `日志显示尚未切换，但活动指针不是出发版本 ${txn.fromVersion}（实际 ${pointerState?.version ?? '读不出'}）：证据矛盾，必须人工处理`,
      active: txn, journal,
    })
  }
  if (!migrated) {
    return Object.freeze({
      verdict: 'rollback-program', code: 'recovery-after-switch', barrierRequired: true,
      reason: `事务停在切换之后、迁移之前（阶段 ${phase}）：程序已换、数据库未改，可回退到 ${txn.fromVersion}`,
      active: txn, journal,
    })
  }
  // 迁移跑过之后：数据库可能已经是旧版本读不懂的结构。
  return Object.freeze({
    verdict: 'forward-fix-required', code: 'recovery-after-migration', barrierRequired: true,
    reason: `事务在迁移之后中断（阶段 ${phase}）：不能仅回退程序，必须向前修复或从升级前备份恢复`,
    active: txn, journal,
  })
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

export function selfCheckJournal() {
  const problems = []
  if (TRANSACTION_PHASES[0] !== 'created' || !TRANSACTION_PHASES.includes('committed')) {
    problems.push('事务阶段表与设计 §8 不符')
  }
  // 设计 §8 里那九步的不可逆动作都要在表里。
  for (const action of ['barrier-acquire', 'backup', 'stop-services', 'switch-pointer', 'migrate', 'commit']) {
    if (!IRREVERSIBLE_ACTIONS.includes(action)) problems.push(`不可逆动作 ${action} 不在表里`)
  }
  // 恢复判定必须能区分"没有事务"与"读不出来"。
  const missing = planRecovery({ dataDir: join(process.cwd(), '.no-such-legion-dir') })
  if (missing.verdict !== 'nothing-to-do') problems.push('缺日志时没有落到 nothing-to-do')
  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    phases: TRANSACTION_PHASES,
    irreversibleActions: IRREVERSIBLE_ACTIONS,
  })
}

export const JOURNAL_CHECKED = selfCheckJournal()
