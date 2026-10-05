// product/update/barrier.mjs
// ============================================================================
// 维护屏障 —— 设计 §8 第 4 步与失败表里那句"恢复维护状态"
//
// 原文（§8 第 4 步）：「建立覆盖所有写入入口的维护屏障并刷新数据；使用
// SQLite backup API 或关闭数据库后的完整一致快照，禁止复制孤立的 WAL 主文件。」
//
// ## 屏障为什么是一个**文件**，而不是一个内存标志
//
// 因为需要被它挡住的东西**不在这个进程里**：team-hub 在另一个进程、
// whiteboard 在第三个、DSH 执行引擎在第四个。一次升级要停的是它们，
// 而它们判断"能不能写"只能靠一个共同的、落盘的位置。
//
// ## 屏障与"停止服务"的区别
//
// 停止服务（第 6 步）是**结果**，屏障（第 4 步）是**前提**：
// 屏障先立起来，之后才去停服务。顺序反过来的话，在"服务已停、屏障未立"
// 的那一小段里，任何重新拉起服务的路径（比如托盘菜单里的"重新启动服务"）
// 都会开出一个写入入口，而备份就在它之后进行。
//
// ## 读不出来时**必须**按"被挡住"处理
//
// 这是本模块最重要的一条判据。屏障文件损坏、半截、或权限读不到时：
//
//   · 按"没有屏障"处理的后果 —— 业务写入在数据库快照建立期间发生，
//     备份与真实数据不一致，而回滚会回到一个"缺了一部分写入"的库；
//   · 按"有屏障"处理的后果 —— 用户看到"正在维护，请稍候"，多等一会儿。
//
// 两者的代价不对称，所以默认是挡。
// ============================================================================

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { canonicalJson, parseJsonStrict } from './canonical.mjs'

export const BARRIER_FORMAT = 'legion/update-barrier@1'
export const BARRIER_FILENAME = 'maintenance.json'

export const BARRIER_CODES = Object.freeze({
  NONE: 'barrier-none',
  HELD: 'barrier-held',
  UNREADABLE: 'barrier-unreadable',
  FOREIGN: 'barrier-foreign-txn',
  // 解除时没说明是哪个事务。它与 FOREIGN（说的是"你不是持有者"）分开，
  // 因为处置不同：FOREIGN 要去问持有者，NO_TXN_ID 是自己把参数补上。
  NO_TXN_ID: 'barrier-no-txn-id',
})

/** 维护屏障的固定位置（与事务日志同目录，helper 与各服务都要找得到）。 */
export function barrierPath(dataDir) {
  return join(dataDir, 'update', BARRIER_FILENAME)
}

/**
 * 立起屏障。写入是原子的（临时文件 + rename）。
 *
 * @param {object} args
 * @param {string} args.dataDir
 * @param {string} args.txnId
 * @param {string} [args.reason]
 * @param {Function} [args.now]
 */
export function acquireBarrier({ dataDir, txnId, reason = '升级进行中', now = () => Date.now() } = {}) {
  if (typeof dataDir !== 'string' || dataDir === '') {
    return Object.freeze({ ok: false, code: BARRIER_CODES.UNREADABLE, reason: 'acquireBarrier 需要 dataDir', barrier: null })
  }
  if (typeof txnId !== 'string' || txnId === '') {
    return Object.freeze({ ok: false, code: BARRIER_CODES.UNREADABLE, reason: 'acquireBarrier 需要 txnId', barrier: null })
  }
  const file = barrierPath(dataDir)
  const existing = readBarrier(dataDir)
  // ★ 屏障已被**另一次**事务持有：拒绝抢占。
  //   抢占的后果是两次升级同时"维护"，而它们各自的备份与切换会交错。
  if (existing.held && existing.barrier.txnId !== txnId) {
    return Object.freeze({
      ok: false, code: BARRIER_CODES.FOREIGN,
      reason: `维护屏障已被事务 ${existing.barrier.txnId} 持有（${existing.barrier.reason}）`,
      barrier: existing.barrier,
    })
  }
  const barrier = Object.freeze({
    format: BARRIER_FORMAT,
    txnId,
    reason,
    sinceMs: existing.held ? existing.barrier.sinceMs : now(),
    updatedAtMs: now(),
  })
  try {
    mkdirSync(dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, `${canonicalJson(barrier)}\n`, 'utf8')
    renameSync(temp, file)
  } catch (error) {
    return Object.freeze({ ok: false, code: BARRIER_CODES.UNREADABLE, reason: `维护屏障写入失败：${error?.message ?? error}`, barrier: null })
  }
  return Object.freeze({ ok: true, code: BARRIER_CODES.HELD, reason: barrier.reason, barrier })
}

/**
 * 读屏障。
 *
 * @returns {{held: boolean, blocked: boolean, code: string, reason: string, barrier: object|null}}
 *   `held`    —— 屏障确实存在且可读；
 *   `blocked` —— **是否应当阻止业务写入/启动**。读不出来时这里是 `true`。
 */
export function readBarrier(dataDir) {
  const file = barrierPath(dataDir)
  if (!existsSync(file)) {
    return Object.freeze({ held: false, blocked: false, code: BARRIER_CODES.NONE, reason: '没有维护屏障', barrier: null })
  }
  let raw
  try { raw = readFileSync(file, 'utf8') } catch (error) {
    return Object.freeze({
      held: false, blocked: true, code: BARRIER_CODES.UNREADABLE,
      reason: `维护屏障读不出来（${error?.message ?? error}）：按"维护中"处理`, barrier: null,
    })
  }
  try {
    const parsed = parseJsonStrict(raw, { maxBytes: 16 * 1024 })
    if (parsed?.format !== BARRIER_FORMAT || typeof parsed.txnId !== 'string') {
      return Object.freeze({
        held: false, blocked: true, code: BARRIER_CODES.UNREADABLE,
        reason: '维护屏障格式不对：按"维护中"处理', barrier: null,
      })
    }
    return Object.freeze({
      held: true, blocked: true, code: BARRIER_CODES.HELD,
      reason: parsed.reason ?? '升级进行中', barrier: parsed,
    })
  } catch (error) {
    return Object.freeze({
      held: false, blocked: true, code: BARRIER_CODES.UNREADABLE,
      reason: `维护屏障不是合法 JSON（很可能是断电时写了一半）：按"维护中"处理（${error?.message ?? error}）`,
      barrier: null,
    })
  }
}

/**
 * 解除屏障。**只有持有者能解**。
 *
 * 参数里传 `txnId` 而不是"随便解"，是因为解除屏障必须与"事务已提交"
 * 绑定：一个"谁都能解"的屏障在一次崩溃之后会被下一次启动顺手解掉，
 * 而那次崩溃可能正停在"数据库已迁移、程序未验证"的位置。
 *
 * ★★ `txnId` 缺失时**必须拒绝**，而不是"没有持有者声明就直接删"。
 *
 *   原先的持有者判据写的是
 *   `if (state.barrier !== null && typeof txnId === 'string' && txnId !== '' && …)`
 *   ——三个条件**串在**一起。于是 `releaseBarrier(dataDir)`（不传 txnId）
 *   会让中间那两个条件为假、整个 `if` 短路、代码直接走到 `rmSync`：
 *   **一次不声明身份的调用把正在进行的升级屏障删掉了**，而函数自己的注释
 *   写的是"只有持有者能解"。
 *
 *   今天没有生产调用方犯这个错（install.mjs 与 helper.mjs 全都传了 txnId），
 *   所以它是一个**潜伏的 fail-open**：判据在，但它的成立条件可以被"少传一个
 *   参数"绕过。这类洞的危险不在于今天有人踩，而在于**下一个人写
 *   `releaseBarrier(dataDir)` 时看起来完全合理**——"我只是想清掉它"。
 *
 *   代价不对称：拒绝一次多余的解除（调用方补上 txnId 即可）对比
 *   在备份/切换中途把屏障解掉（写入重新涌入，而备份已经建立）。所以默认是拒。
 *
 *   > 一个"少传一个参数就失效"的守卫，与没有守卫的区别只在于
 *   > **它让人以为有守卫**。
 */
export function releaseBarrier(dataDir, txnId) {
  const state = readBarrier(dataDir)
  // 本来就没有屏障：这是**幂等**的成功，什么都不会被删。
  if (!state.blocked && state.code === BARRIER_CODES.NONE) {
    return Object.freeze({ ok: true, code: BARRIER_CODES.NONE, reason: '本来就没有屏障' })
  }
  // ★ 有屏障（含"读不出来"）时必须声明身份。读不出来也拒，理由同上：
  //   一个损坏的屏障恰恰是最不该被顺手删掉的那一种。
  if (typeof txnId !== 'string' || txnId === '') {
    return Object.freeze({
      ok: false, code: BARRIER_CODES.NO_TXN_ID,
      reason: '解除维护屏障必须说明是哪个事务（缺少 txnId）：'
        + `当前屏障属于 ${state.barrier?.txnId ?? '（读不出来）'}，`
        + '不声明身份的解除会被拒绝——屏障存在的意义就是不让别人顺手解掉它',
      barrier: state.barrier,
    })
  }
  if (state.barrier !== null && state.barrier.txnId !== txnId) {
    return Object.freeze({
      ok: false, code: BARRIER_CODES.FOREIGN,
      reason: `维护屏障属于事务 ${state.barrier.txnId}，${txnId} 不能解除它`,
    })
  }
  try { rmSync(barrierPath(dataDir), { force: true }) } catch (error) {
    return Object.freeze({ ok: false, code: BARRIER_CODES.UNREADABLE, reason: `维护屏障删除失败：${error?.message ?? error}` })
  }
  return Object.freeze({ ok: true, code: null, reason: null })
}

/**
 * 给**其它服务**用的最小判据。
 *
 * 它们要回答的问题只有一个："我现在能不能接受写入？"
 */
export function canAcceptWrites(dataDir) {
  const state = readBarrier(dataDir)
  if (!state.blocked) return Object.freeze({ ok: true, code: null, reason: null })
  return Object.freeze({ ok: false, code: state.code, reason: state.reason })
}

/**
 * 启动闸门 —— 「新旧 Launcher 均识别未完成事务，在恢复结束前禁止正常业务启动」
 * （设计 §8 line 182）。
 *
 * 输入是磁盘状态；输出是"能不能正常启动业务"，以及不能时的原因与建议动作。
 * Launcher 在拿到单实例锁之后、跑 preflight 之前调用它。
 */
export function startupGate({ dataDir, planRecovery }) {
  const barrier = readBarrier(dataDir)
  const recovery = typeof planRecovery === 'function' ? planRecovery({ dataDir }) : null
  const unfinished = recovery !== null && recovery.verdict !== 'nothing-to-do' && recovery.verdict !== 'finalize-record'
  if (!barrier.blocked && !unfinished) {
    return Object.freeze({
      allowed: true, code: null, reason: null,
      recoveryVerdict: recovery?.verdict ?? null, barrierCode: barrier.code,
      advice: null,
    })
  }
  return Object.freeze({
    allowed: false,
    code: unfinished ? 'UPDATE_TRANSACTION_UNFINISHED' : 'UPDATE_MAINTENANCE',
    reason: unfinished
      ? (recovery.reason ?? barrier.reason)
      : `Legion 正在维护中：${barrier.reason}`,
    recoveryVerdict: recovery?.verdict ?? null,
    barrierCode: barrier.code,
    advice: adviceFor(recovery?.verdict ?? null),
  })
}

function adviceFor(verdict) {
  switch (verdict) {
    case 'resume-maintenance':
      return '上次升级在替换程序之前中断，未做任何改动。可以在维护模式下重试升级。'
    case 'rollback-program':
      return '上次升级替换了程序但未改数据库。重新打开 Legion 会自动退回旧版本。'
    case 'forward-fix-required':
      return '上次升级已经改过数据库，不能仅退回程序。请联系管理员按升级前备份恢复或向前修复。'
    case 'recovery-required':
      return '升级证据不完整，无法自动判断。请联系管理员，不要删除数据目录。'
    default:
      return '请稍候重试；若长时间停留在维护状态，请联系管理员。'
  }
}

/** 等待任务收敛时的建议超时（设计 §7 line 150：超时回到可选择界面，不默认强杀）。 */
export const DEFAULT_DRAIN_TIMEOUT_MS = 5 * 60 * 1000

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

export function selfCheckBarrier() {
  const problems = []
  // 缺 dataDir：明确失败，不是"没有屏障"。
  const missing = acquireBarrier({})
  if (missing.ok) problems.push('缺 dataDir 时立起了屏障')
  // 启动闸门：没有任何状态时允许启动。
  const gate = startupGate({ dataDir: join(process.cwd(), '.no-such-legion-dir') })
  if (gate.allowed !== true) problems.push('没有事务与屏障时启动被拦住了')
  // ★ 读不出来时 `blocked` 必须是 true。
  const state = readBarrier(join(process.cwd(), '.no-such-legion-dir'))
  if (state.blocked !== false) problems.push('不存在的屏障被判为 blocked')
  /**
   * ★★ 解除屏障的两条判据，这里各问一句。
   *
   * 1. "没有屏障"时**不带 txnId 也必须成功**（幂等：什么都没删）。
   * 2. 而"有屏障"时**不带 txnId 必须失败**——这一条需要盘上真的有一个屏障，
   *    所以它由 `install.test.mjs` 的用例守着（`barrier-no-txn-id`）。
   *    装载期自检**故意不建临时目录**：自检跑在每次 import 上，而"为了自检
   *    往磁盘写东西"会让产品在只读安装目录里起不来——用一个更严重的故障
   *    去防一个更轻的故障，不划算。
   *
   *    但错误码必须真的在表里：少了它，上面那条用例会以一个
   *    `undefined === 'barrier-no-txn-id'` 的形式失败，而症状看起来像
   *    别的地方坏了。
   */
  const noTxnOnEmpty = releaseBarrier(join(process.cwd(), '.no-such-legion-dir'))
  if (noTxnOnEmpty.ok !== true || noTxnOnEmpty.code !== BARRIER_CODES.NONE) {
    problems.push('没有屏障时，不带 txnId 的解除应当是幂等成功（什么都没删）')
  }
  if (typeof BARRIER_CODES.NO_TXN_ID !== 'string' || BARRIER_CODES.NO_TXN_ID === '') {
    problems.push('缺少"解除时未声明事务身份"的错误码')
  }
  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    filename: BARRIER_FILENAME,
    drainTimeoutMs: DEFAULT_DRAIN_TIMEOUT_MS,
  })
}

export const BARRIER_CHECKED = selfCheckBarrier()
