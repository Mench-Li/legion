// product/node/ledger.mjs
// ============================================================================
// 本地运行账本（远程 Agent 通道 S-E 之二）
//
// ## 它是什么、不是什么
//
// **是**：一份极小的本地记录，回答"这台电脑上，有哪些 Attempt 我接过、
// 做到哪一步、有没有收尾"。断线重连之后，Hub 靠它做对账。
//
// **不是**：第二份任务状态。设计文档 §10 明确「PC 仅缓存恢复所需的最小本地运行
// 账本」，§6.3 要求「不得在本地另建一套可与 Hub 冲突的任务状态」。
//
// 这条边界怎么落实成代码：本模块**没有** `status` 这类会让人联想到任务状态的字段。
// 它记的是 `phase`（`accepted` / `running` / `finished`），而 `phase` 只在
// **本进程视角**里有意义——"我接过"、"我正在跑"、"我这里已经结束了"。
// 它不能回答"这个任务是不是完成了"，那个问题只有 Hub 能回答。
//
// ## 为什么落盘而不是放内存
//
// 内存版在崩溃/重启后什么都不剩，于是重连时 Hub 看到的是一个"什么都不知道"的
// 节点，而 Hub 那条 Running 的租约还会继续存在直到过期。落盘之后，节点能说出
// "我接过 A，它当时在跑，然后我崩了"——这正是 `UnknownOutcome` 对账需要的输入。
//
// 与 `run-store` 的 `idempotencyKey` 一样，**同一任务的所有尝试共用一个键**；
// 账本上按 attempt 记，于是"重试过几次"在本地也看得出来。
// ============================================================================
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

/** 本进程视角的阶段。**不是**任务状态（见文件头那段）。 */
export const LEDGER_PHASES = Object.freeze(['accepted', 'running', 'finished'])

/** 默认保留上限：条数与年龄都设界——一个只增不减的本地文件会在几个月后变成故障。 */
export const LEDGER_MAX_ENTRIES = 500
export const LEDGER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 造账本。
 *
 * @param {object} deps
 * @param {string} deps.file 落盘路径；`null` 表示纯内存（测试用）
 * @param {() => number} [deps.clock]
 * @param {object} [deps.fs] 文件操作（测试可注入）
 */
export function createRunLedger({ file = null, clock = Date.now, fs = null } = {}) {
  const io = fs ?? { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync }
  let entries = []

  if (file !== null && io.existsSync(file)) {
    try {
      const parsed = JSON.parse(io.readFileSync(file, 'utf8'))
      // 坏账本按"空"处理而不是崩：一份读不出来的账本不该让节点起不来，
      // 那会把"对账信息缺失"升级成"机器不能用"。
      entries = Array.isArray(parsed?.entries) ? parsed.entries.filter(isValidEntry) : []
    } catch { entries = [] }
  }

  function isValidEntry(e) {
    return e !== null && typeof e === 'object'
      && typeof e.attemptId === 'string' && typeof e.taskId === 'string'
      && Number.isSafeInteger(e.leaseEpoch) && LEDGER_PHASES.includes(e.phase)
  }

  /**
   * 原子落盘：写临时文件 → fsync → rename。
   *
   * 直接 `writeFileSync` 到目标路径的失效方式是"写到一半断电"——
   * 留下一个**语法合法但内容被截断**的 JSON，而它在下次启动时会被当成
   * "一份只有前几条的账本"静默接受。rename 在同一文件系统上是原子的。
   */
  function persist() {
    if (file === null) return
    const dir = dirname(file)
    if (!io.existsSync(dir)) io.mkdirSync(dir, { recursive: true })
    const tmp = `${file}.tmp`
    io.writeFileSync(tmp, JSON.stringify({ version: 1, entries }, null, 2), 'utf8')
    const fd = io.openSync(tmp, 'r+')
    try { io.fsyncSync(fd) } finally { io.closeSync(fd) }
    io.renameSync(tmp, file)
  }

  function prune() {
    const cutoff = clock() - LEDGER_MAX_AGE_MS
    // 先按年龄删，再按条数删。终态条目更容易先被删：它们的对账价值随时间下降，
    // 而未收尾的条目（`accepted` / `running`）恰恰是最需要被对账的。
    const alive = entries.filter((e) => Number(e.updatedAtMs ?? 0) >= cutoff)
    alive.sort((a, b) => Number(b.updatedAtMs ?? 0) - Number(a.updatedAtMs ?? 0))
    const kept = alive.slice(0, LEDGER_MAX_ENTRIES)
    const removed = entries.length - kept.length
    entries = kept
    return { removed }
  }

  /**
   * 记一条（或更新一条）尝试。
   *
   * 幂等：同一个 `(attemptId, leaseEpoch)` 重复记只更新时间戳。**不**因为
   * epoch 变化而覆盖旧行：旧 epoch 的那次运行确实发生过（可能还有副作用），
   * 抹掉它等于抹掉对账需要的证据。
   */
  function record({ taskId, attemptId, leaseEpoch, phase, atMs = null, outcome = null }) {
    if (typeof taskId !== 'string' || typeof attemptId !== 'string') throw new TypeError('账本条目需要 taskId 与 attemptId')
    if (!Number.isSafeInteger(leaseEpoch) || leaseEpoch < 1) throw new TypeError('账本条目需要正整数 leaseEpoch')
    if (!LEDGER_PHASES.includes(phase)) throw new TypeError(`未登记的 phase：${phase}（合法的：${LEDGER_PHASES.join(', ')}）`)
    const at = atMs ?? clock()
    const existing = entries.find((e) => e.attemptId === attemptId && e.leaseEpoch === leaseEpoch)
    if (existing !== undefined) {
      existing.phase = phase
      existing.updatedAtMs = at
      if (outcome !== null) existing.outcome = outcome
      persist()
      return { ...existing, created: false }
    }
    const entry = { taskId, attemptId, leaseEpoch, phase, outcome, lastSeq: 0, startedAtMs: at, updatedAtMs: at }
    entries.push(entry)
    prune()
    persist()
    return { ...entry, created: true }
  }

  /**
   * 取下一条事件序号。
   *
   * **为什么序号要落盘**：Hub 用 `(attempt_id, event_seq)` 做幂等。如果重连后
   * 序号从 1 重新开始，那么本机发出的**新的**进展会被 Hub 当成重放而跳过——
   * 于是手机上看不到断线之后发生的任何事，而两端都不报错。
   * 序号必须跨连接、跨进程重启保持单调，所以它和账本住在同一个文件里。
   */
  function nextSeq({ attemptId, leaseEpoch }) {
    const existing = entries.find((e) => e.attemptId === attemptId && e.leaseEpoch === leaseEpoch)
    if (existing === undefined) throw new Error(`账本里没有这条尝试：${attemptId}@${leaseEpoch}（先 record 再取序号）`)
    existing.lastSeq = Number(existing.lastSeq ?? 0) + 1
    existing.updatedAtMs = clock()
    persist()
    return existing.lastSeq
  }

  /** 查一条。 */
  function get(attemptId, leaseEpoch = null) {
    return entries.find((e) => e.attemptId === attemptId && (leaseEpoch === null || e.leaseEpoch === leaseEpoch)) ?? null
  }

  /** 全部条目（快照副本）。 */
  function list() { return entries.map((e) => ({ ...e })) }

  /**
   * 未收尾的条目 —— 也就是"重启后我需要对账的东西"。
   *
   * 这是本模块最要紧的一条读法：断线时 `phase` 停在 `accepted`/`running` 的那些，
   * 说明本机**可能**已经产生了副作用而 Hub 不知道。它们不会被自动重跑
   * （设计文档 §6.3），而是作为对账输入交给 Hub。
   */
  function unsettled() {
    return entries.filter((e) => e.phase !== 'finished').map((e) => ({ ...e }))
  }

  /** 清掉已收尾且已同步过的条目（Hub 确认对账之后调用）。 */
  function forget(attemptIds) {
    const remove = new Set(attemptIds)
    const before = entries.length
    entries = entries.filter((e) => !remove.has(e.attemptId))
    persist()
    return { removed: before - entries.length }
  }

  /** 诊断读数。 */
  function stats() {
    const byPhase = {}
    for (const p of LEDGER_PHASES) byPhase[p] = 0
    for (const e of entries) byPhase[e.phase] = (byPhase[e.phase] ?? 0) + 1
    return Object.freeze({ total: entries.length, byPhase: Object.freeze(byPhase), unsettled: unsettled().length, file })
  }

  return { record, get, list, unsettled, forget, prune, nextSeq, stats }
}
