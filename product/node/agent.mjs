// product/node/agent.mjs
// ============================================================================
// 电脑侧 Node 客户端（远程 Agent 通道 S-E 之四）
//
// 出站连到 Hub，接任务、报进展、报终态、重连对账。
//
// ## 一条贯穿全文件的纪律：本机不产生任务状态
//
// 本模块回答的问题只有"我这条连接现在在干什么"。它**不**回答"这个任务完成了吗"
// ——那只有 Hub 能回答。所以你会看到：
//
//   · 收到 `error`/`heartbeat.ack.rejected` 说这条租约已过期时，本机**停手**并
//     把 attempt 从内存里摘掉，而不是把它标成"失败"；
//   · 执行器报 `outcome_unknown` 时，照原样上报，不"顺手"改成 `failed`——
//     这两者在 Hub 侧的处置完全不同（前者要人对账，后者按重试策略走）；
//   · 断线时不做任何收尾动作。正在跑的子进程继续跑，结果留着，等重连后报。
//     这是设计文档 §6.3 要求的：断开只证明观察通道失效。
//
// ## 重连退避
//
// 指数退避 + 抖动。抖动不是装饰：多台电脑同时断线（Hub 重启）时，
// 没有抖动会让它们在同一毫秒回来，把一次重启变成一个自制的惊群。
// ============================================================================
import { randomUUID } from 'node:crypto'

import {
  FRAME_TYPES,
  PROTOCOL_VERSION,
  buildFrame,
  requestIdFor,
} from '../../packages/shared/src/node-protocol.mjs'
import { WS_CLOSE } from '../../packages/shared/src/ws-frames.mjs'
import { connectWebSocket } from '../../packages/shared/src/ws-client.mjs'
import { describeNotices, projectFailure, projectLedger, projectProgress, projectTerminal } from './egress.mjs'

export const AGENT_CODES = Object.freeze({
  NO_WORKSPACE: 'NODE_WORKSPACE_NOT_AUTHORIZED',
  ALREADY_RUNNING: 'NODE_ATTEMPT_ALREADY_RUNNING',
  EXECUTOR_MISSING: 'NODE_EXECUTOR_MISSING',
  VERSION_REJECTED: 'NODE_VERSION_REJECTED',
})

/** 默认退避参数。上限 60s：更长的等待会让"Hub 回来了但节点半小时没连上"。 */
export const DEFAULT_BACKOFF = Object.freeze({ baseMs: 1000, maxMs: 60_000, factor: 2, jitter: 0.25 })
export const DEFAULT_HEARTBEAT_MS = 25_000

/**
 * 造 Node 客户端。
 *
 * @param {object} config
 * @param {string} config.hubUrl            `wss://host/node`
 * @param {string} config.deviceToken
 * @param {string} config.nodeId
 * @param {Record<string, {path: string, label?: string}>} config.workspaces 允许的空间 → 工作区
 * @param {Function} config.executor        `({task, attempt, workspace, onProgress, signal}) => Promise<result>`
 * @param {object} config.ledger            `createRunLedger(...)` 的产物
 * @param {Function} [config.connect]       接缝（测试注入）
 * @param {() => number} [config.clock]
 * @param {object} [config.logger]
 * @param {object} [config.backoff]
 * @param {number} [config.heartbeatIntervalMs]
 * @param {boolean} [config.autoStartTimers] 设为 false 时不起飞重连/心跳定时器（测试用）
 */
export function createNodeAgent({
  hubUrl,
  deviceToken,
  nodeId,
  workspaces = {},
  executor = null,
  ledger,
  connect = connectWebSocket,
  clock = Date.now,
  logger = console,
  backoff = DEFAULT_BACKOFF,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_MS,
  autoStartTimers = true,
} = {}) {
  for (const [name, value] of Object.entries({ hubUrl, deviceToken, nodeId })) {
    if (typeof value !== 'string' || value.length === 0) throw new TypeError(`createNodeAgent 需要 ${name}`)
  }
  if (ledger === null || ledger === undefined) throw new TypeError('createNodeAgent 需要 ledger')

  const backoffPolicy = { ...DEFAULT_BACKOFF, ...backoff }
  /** 正在执行的 attempt：attemptId → { controller, frame, startedAtMs } */
  const running = new Map()
  const stats = { connects: 0, dispatches: 0, declined: 0, progressSent: 0, terminalsSent: 0, reconnects: 0, aborted: 0 }

  let ws = null
  let stopped = true
  let heartbeatTimer = null
  let reconnectTimer = null
  let attempt = 0
  /** 未确认关闭的终态上报：断线时先攒着，重连后**先**补报再对账。 */
  const pendingTerminals = []
  /** 未确认送达的失败上报。与终态分开队列：两者走的是不同帧类型，合并会让"补报"发错帧。 */
  const pendingFailures = []

  const log = (level, message, detail) => {
    const fn = typeof logger?.[level] === 'function' ? logger[level] : null
    if (fn !== null) fn.call(logger, `[node] ${message}`, detail ?? '')
  }

  // ── 连接 ──────────────────────────────────────────────────────────────────

  function scheduleReconnect() {
    if (stopped || autoStartTimers !== true) return
    attempt += 1
    stats.reconnects += 1
    const raw = Math.min(backoffPolicy.maxMs, backoffPolicy.baseMs * (backoffPolicy.factor ** (attempt - 1)))
    // 抖动：多台电脑同时断线时，没有抖动会让它们在同一个时刻一起回来。
    const jitter = raw * backoffPolicy.jitter * (Math.random() * 2 - 1)
    const delay = Math.max(0, Math.round(raw + jitter))
    log('warn', `${delay}ms 后重连（第 ${attempt} 次）`)
    reconnectTimer = setTimeout(() => { reconnectTimer = null; open() }, delay)
    if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref()
  }

  function open() {
    if (stopped) return
    stats.connects += 1
    const sock = connect({
      url: hubUrl,
      headers: { Authorization: `Bearer ${deviceToken}` },
      timeoutMs: 20_000,
      pingIntervalMs: 0,
    })
    ws = sock
    sock.on('error', (e) => log('warn', '连接错误', e?.message))
    sock.on('handshakeRejected', (r) => {
      // 401/403 是**配置**问题（令牌错、设备被撤销），重连再快也没用；
      // 但仍然退避重试——因为"设备刚被重新配对"是一个合法场景。
      log('error', `握手被拒：HTTP ${r.status} ${String(r.body ?? '').slice(0, 120)}`)
    })
    sock.on('open', () => { log('info', '连接已建立'); sendHello() })
    sock.on('message', (text) => { try { onFrame(JSON.parse(text)) } catch (e) { log('warn', '无法解析的帧', e?.message) } })
    sock.on('close', (info) => {
      heartbeatTimer !== null && clearInterval(heartbeatTimer)
      heartbeatTimer = null
      log('warn', `连接关闭：${info.reason}${info.code ? ` (${info.code})` : ''}`)
      // ★ 断线**不做任何收尾**：正在跑的子进程继续跑，结果留着等重连后报。
      //   把在途 attempt 标成失败会造出一个本机无权做出的判断。
      scheduleReconnect()
    })
  }

  function send(type, fields = {}) {
    if (ws === null || ws.isOpen !== true) return false
    const requestId = fields.requestId ?? requestIdFor(type === FRAME_TYPES.HELLO ? 'hello' : 'req')
    return ws.send(JSON.stringify(buildFrame(type, { ...fields, requestId, nodeId }, { now: clock })))
  }

  function sendHello() {
    send(FRAME_TYPES.HELLO, { protocolVersion: PROTOCOL_VERSION })
  }

  // ── 收帧 ──────────────────────────────────────────────────────────────────

  function onFrame(frame) {
    switch (frame.type) {
      case FRAME_TYPES.HELLO_ACK: return onHelloAck(frame)
      case FRAME_TYPES.DISPATCH: return onDispatch(frame)
      case FRAME_TYPES.CANCEL: return onCancel(frame)
      case FRAME_TYPES.HEARTBEAT_ACK: return onHeartbeatAck(frame)
      case FRAME_TYPES.RECONCILE: return onReconcileReply(frame)
      case FRAME_TYPES.ACK: return onAck(frame)
      case FRAME_TYPES.ERROR: return onError(frame)
      default: log('warn', `未处理的帧类型：${frame.type}`)
    }
  }

  function onHelloAck(frame) {
    attempt = 0
    log('info', `已注册：协议 v${frame.protocolVersion}，可派发=${frame.canDispatch}`)
    if (heartbeatTimer === null && autoStartTimers === true) {
      heartbeatTimer = setInterval(() => sendHeartbeat(), heartbeatIntervalMs)
      if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref()
    }
    // 重连之后**先补报终态、再对账**：一条已经跑完但没报上去的结果，
    // 如果先对账，会对出一个"Hub 以为在跑、本机已经结束"的假不一致。
    for (const pending of pendingTerminals.splice(0)) {
      send(FRAME_TYPES.TRANSITION, pending)
    }
    for (const pending of pendingFailures.splice(0)) {
      send(FRAME_TYPES.FAILURE, pending)
    }
    if (ledger.unsettled().length > 0) sendReconcile()
  }

  function sendReconcile() {
    // ★ 出去时把 `phase` 映成协议字段 `state`。**这个 `state` 是节点自己的词汇**
    //   （accepted / running / finished），**不是** Hub 的 Attempt 状态名——
    //   节点无权使用那套名字（见 ledger.mjs 文件头）。Hub 侧的比对正是拿
    //   这两套词汇的**期望关系**来判断的（"本机说结束了、Hub 还认为是活跃"）。
    //
    //   用 `phase` 原样当字段名会让帧过不了协议校验（缺 `state`），
    //   而失败表现是"对账一直没发生"——一个不报错的静默失效。
    const projected = projectLedger(ledger.unsettled().map((e) => ({ ...e, state: e.phase })))
    if (projected.value.length === 0) return
    send(FRAME_TYPES.RECONCILE, { ledger: projected.value })
    if (projected.notices.length > 0) log('info', `对账出境收敛：${describeNotices(projected.notices)}`)
  }

  function sendHeartbeat() {
    const leases = [...running.values()].map((r) => ({ attemptId: r.frame.attemptId, leaseEpoch: r.frame.leaseEpoch }))
    send(FRAME_TYPES.HEARTBEAT, { leases })
  }

  function onHeartbeatAck(frame) {
    // ★ 被拒的租约要**立即停手**。Hub 说这条租约已经不归你了，继续跑下去
    //   产生的副作用无法归属，而结果会被 Hub 按 epoch 栅栏拒掉——
    //   也就是说"多做的那些事"既没人认账，也已经发生了。
    for (const rejected of frame.rejected ?? []) {
      const entry = running.get(rejected.attemptId)
      if (entry === undefined) continue
      log('warn', `租约已失效，停止执行 ${rejected.attemptId}：${rejected.code}`)
      stats.aborted += 1
      entry.controller.abort()
      running.delete(rejected.attemptId)
      ledger.record({ taskId: entry.frame.taskId, attemptId: rejected.attemptId, leaseEpoch: entry.frame.leaseEpoch, phase: 'finished', outcome: 'outcome_unknown' })
    }
    // 续期**没生效**的租约：不 abort，但要说话。
    //
    // 与上面那条 `rejected` 的区别是"Hub 有没有拒绝"：这里是 Hub 收到了、
    // 也答了 200，只是**没有任何东西被续上**。最常见的一种是这条尝试已经
    // 走到终态之后又飞了一个心跳——那无害。但另一种不是：租约一旦真的没人续，
    // 它到点后会被 Hub 判成"结果待确认"，而节点这边**看不出任何异常**。
    // 静默的代价是把"我的结果可能会被丢掉"变成事后才知道的事。
    for (const r of frame.renewed ?? []) {
      if (r.renewed === true) continue
      log('warn', `租约未能续期 ${r.attemptId}：这条尝试已不在持有租约的状态（到期时间仍为 ${r.leaseExpiresAtMs ?? '无'}）`)
    }
    // 写入预约的续期结论：只记录，不停手。
    //
    // 预约被冻结（`RECONCILING`）时它**仍然占着单写者位**，所以"继续跑还是停下"
    // 由对账的人判，不由此处代劳。但这条读数必须留下——否则排障时两端日志都
    // 只有"一切正常"，而问题在第三处。
    for (const r of frame.renewed ?? []) {
      const w = r.writeReservation
      if (w === null || w === undefined || w.ok === true) continue
      log('warn', `写入预约未续期 ${r.attemptId}：${w.code}${w.reason ? `（${w.reason}）` : ''}——写入保护可能已不由本次执行持有`)
    }
  }

  function onError(frame) {
    log('error', `Hub 拒绝：${frame.code} ${frame.message ?? ''}`)
    // 与租约相关的拒绝：立即停手（租约已经不归你了，继续跑产生的副作用无法归属）。
    if (['LEASE_EPOCH_STALE', 'LEASE_EXPIRED', 'LEASE_NOT_HELD'].includes(frame.code)) {
      for (const [attemptId, entry] of [...running]) {
        if (frame.attemptId !== undefined && frame.attemptId !== attemptId) continue
        stats.aborted += 1
        entry.controller.abort()
        running.delete(attemptId)
      }
      return
    }
    // ★ 阶段被拒（`TRANSITION_REJECTED` / `EVIDENCE_MISSING`）也要停手。
    //
    // 状态机为每条边定义了证据要求：`BuildingContext → Running` 要求先有一份
    // 上下文快照落库。那份快照不存在时 Hub 会拒绝阶段上报——如果本机继续把
    // 执行器跑完，结果**永远上报不出去**（`BuildingContext → Validating` 根本没有边），
    // 于是任务卡在 `BuildingContext`，执行器白跑一趟，而副作用已经发生了。
    //
    // 停手之后走 abort 路径：执行器被杀 → 报 `cancelled`，而
    // `BuildingContext → Cancelled` 是合法边，任务能干净收尾。
    if (frame.code === 'TRANSITION_REJECTED' || frame.code === 'EVIDENCE_MISSING') {
      for (const [attemptId, entry] of [...running]) {
        stats.aborted += 1
        log('warn', `阶段被拒，停止执行 ${attemptId}：${frame.code}`)
        entry.controller.abort()
      }
    }
  }

  function onAck(frame) {
    if (frame.duplicate === true) log('info', `进展被判为重复（序号 ${frame.seq}），未重复记账`)
  }

  function onReconcileReply(frame) {
    const agreed = (frame.comparison ?? []).filter((c) => c.verdict === 'agree').length
    const mismatched = (frame.comparison ?? []).filter((c) => c.verdict !== 'agree')
    log('info', `对账完成：一致 ${agreed} 条，不一致 ${mismatched.length} 条`)
    for (const c of mismatched) {
      // **只记不解**：本机无权改 Hub 的状态。这些条目留在账本里，等人工或租约规则处置。
      log('warn', `对账不一致 ${c.attemptId}：${c.verdict}（Hub=${c.hubState ?? '未知'}，本机=${c.nodeState ?? '未知'}）`)
    }
    // 只忘掉"Hub 也认为已结束"的那些：其余留着，它们正是下次对账要用的输入。
    const settled = (frame.comparison ?? [])
      .filter((c) => c.verdict === 'agree' && ['Validating', 'Completed', 'Cancelled', 'DeadLetter', 'RetryableFailure', 'UnknownOutcome'].includes(c.hubState))
      .map((c) => c.attemptId)
    if (settled.length > 0) ledger.forget(settled)
  }

  // ── 派发 ──────────────────────────────────────────────────────────────────

  function onDispatch(frame) {
    stats.dispatches += 1
    const workspace = workspaces[frame.scope]
    if (workspace === undefined || typeof workspace.path !== 'string') {
      // ★ 具名拒收，并**把租约还回去**（由 Hub 侧的 ack 处理完成）。
      //   静默不接会让这条任务一直挂在租约上直到过期——期间它既不在队列里，
      //   也不在运行中。
      stats.declined += 1
      log('warn', `拒收 ${frame.taskId}：空间 ${frame.scope} 未配置工作区`)
      send(FRAME_TYPES.ACK, { taskId: frame.taskId, attemptId: frame.attemptId, leaseEpoch: frame.leaseEpoch, accepted: false, reason: AGENT_CODES.NO_WORKSPACE })
      return
    }
    if (executor === null || typeof executor !== 'function') {
      stats.declined += 1
      send(FRAME_TYPES.ACK, { taskId: frame.taskId, attemptId: frame.attemptId, leaseEpoch: frame.leaseEpoch, accepted: false, reason: AGENT_CODES.EXECUTOR_MISSING })
      return
    }
    if (running.has(frame.attemptId)) {
      stats.declined += 1
      send(FRAME_TYPES.ACK, { taskId: frame.taskId, attemptId: frame.attemptId, leaseEpoch: frame.leaseEpoch, accepted: false, reason: AGENT_CODES.ALREADY_RUNNING })
      return
    }

    send(FRAME_TYPES.ACK, { taskId: frame.taskId, attemptId: frame.attemptId, leaseEpoch: frame.leaseEpoch, accepted: true })
    ledger.record({ taskId: frame.taskId, attemptId: frame.attemptId, leaseEpoch: frame.leaseEpoch, phase: 'accepted' })
    const controller = new AbortController()
    running.set(frame.attemptId, { frame, controller, startedAtMs: clock() })
    // 不 await：派发处理必须立刻返回，否则一条长任务会阻塞这个连接上的收帧。
    void runAttempt(frame, workspace, controller).catch((e) => {
      log('error', `执行 ${frame.attemptId} 抛出未捕获异常`, e?.message)
      reportFailure(frame, { failureCode: 'node-executor-crashed', detail: e?.message })
    })
  }

  async function runAttempt(frame, workspace, controller) {
    // ★ 这三个阶段上报是**必需**的，不是装饰。
    //
    // Hub 的状态机把执行建模成一条唯一的合法路径：
    // `Leased → PreparingWorkspace → BuildingContext → Running → Validating`。
    // 跳过中间态直接报终态会被 `TRANSITION_REJECTED` 拒掉——而症状很隐蔽：
    // 进展照常写入，任务却永远停在 `Leased`，界面上"有进展但不结束"。
    //
    // 阶段上报：把"本机真的在做哪一步"告诉 Hub。上报失败（断线）不阻断执行——
    // 阶段是给 Hub 看的投影，而 Hub 若**拒绝**某个阶段会回一条 error 帧，
    // 那时由 `onError` 停手（见那里的注释：不能干那种结果无法上报的活）。
    const advance = (state) => send(FRAME_TYPES.PHASE, { taskId: frame.taskId, attemptId: frame.attemptId, leaseEpoch: frame.leaseEpoch, state })

    advance('PreparingWorkspace')
    ledger.record({ taskId: frame.taskId, attemptId: frame.attemptId, leaseEpoch: frame.leaseEpoch, phase: 'running' })
    let result
    try {
      advance('BuildingContext')
      advance('Running')
      result = await executor({
        task: frame.task ?? null,
        attempt: { attemptId: frame.attemptId, attemptNo: frame.attemptNo, leaseEpoch: frame.leaseEpoch },
        workspace,
        signal: controller.signal,
        onProgress: (p) => reportProgress(frame, p),
      })
    } catch (e) {
      result = { outcome: 'failed', summary: `执行器异常：${e?.message ?? String(e)}`, artifacts: [] }
    }
    if (result === null || typeof result !== 'object' || typeof result.outcome !== 'string') {
      result = { outcome: 'outcome_unknown', summary: '执行器没有返回可用的结果', artifacts: [] }
    }
    // 收尾前再看一眼：如果租约已经被 Hub 判为失效，这次结果**不禁用**上报路径，
    // 但也不该把 attempt 从 running 里摘掉两次。
    running.delete(frame.attemptId)
    ledger.record({ taskId: frame.taskId, attemptId: frame.attemptId, leaseEpoch: frame.leaseEpoch, phase: 'finished', outcome: result.outcome })
    reportTerminal(frame, result)
  }

  function baseFields(frame) {
    return { taskId: frame.taskId, attemptId: frame.attemptId, leaseEpoch: frame.leaseEpoch, eventId: randomUUID(), seq: ledger.nextSeq({ attemptId: frame.attemptId, leaseEpoch: frame.leaseEpoch }) }
  }

  function reportProgress(frame, progress) {
    const projected = projectProgress(progress)
    if (projected.notices.length > 0) log('info', `进展出境收敛：${describeNotices(projected.notices)}`)
    const ok = send(FRAME_TYPES.PROGRESS, { ...baseFields(frame), ...projected.value })
    if (ok) stats.progressSent += 1
  }

  function reportTerminal(frame, result) {
    // ★ `failed` 必须走 **failure 帧**，不能用 `transition{outcome:'failed'}`。
    //
    // 两者在 Hub 侧落到**不同**的入口：`transition` 只做状态迁移（到
    // `RetryableFailure`），而 `failAndRetry` 才负责重试排队与退避。用前者，
    // 任务会停在 `RetryableFailure`——既没有可领的队列，也不在等人工列表里，
    // 从任何界面看都只是"失败了"，而没有人会去处理它。
    if (result.outcome === 'failed') {
      const projectedFailure = projectFailure({
        failureCode: typeof result.code === 'string' && result.code.length > 0 ? result.code : 'node-executor-failed',
        detail: result.summary,
      })
      const payload = { ...baseFields(frame), ...projectedFailure.value }
      if (!send(FRAME_TYPES.FAILURE, payload)) {
        // 与终态同样的处置：**不丢**。丢掉会让 Hub 以为任务还在跑，直到租约过期，
        // 而租约过期会把一个**已知的失败**降级成 `UnknownOutcome`。
        pendingFailures.push(payload)
        log('warn', `失败未发出，已攒下待重连补报：${frame.attemptId}`)
      } else {
        stats.terminalsSent += 1
      }
      return
    }
    const projected = projectTerminal({ outcome: result.outcome, summary: result.summary, artifacts: result.artifacts })
    if (projected.notices.length > 0) log('info', `终态出境收敛：${describeNotices(projected.notices)}`)
    const payload = { ...baseFields(frame), ...projected.value }
    // 上报**失败**时（断线）把它攒下来：这条结果已经发生，丢掉它等于让 Hub
    // 以为任务还在跑，直到租约过期——而租约过期会把结果落成 `UnknownOutcome`，
    // 也就是把一个**已知**的结果降级成"未知"。
    if (!send(FRAME_TYPES.TRANSITION, payload)) {
      pendingTerminals.push(payload)
      log('warn', `终态未发出，已攒下待重连补报：${frame.attemptId}`)
    } else {
      stats.terminalsSent += 1
    }
  }

  function reportFailure(frame, { failureCode, detail }) {
    const projected = projectFailure({ failureCode, detail })
    const payload = { ...baseFields(frame), ...projected.value }
    if (!send(FRAME_TYPES.FAILURE, payload)) pendingFailures.push(payload)
  }

  function onCancel(frame) {
    const entry = running.get(frame.attemptId)
    if (entry === undefined) {
      // 没在跑：回一条 ack 说明"这里没有可停的东西"，而不是假装停了。
      send(FRAME_TYPES.ACK, { taskId: frame.taskId, attemptId: frame.attemptId, leaseEpoch: frame.leaseEpoch, accepted: false, reason: 'not-running-locally' })
      return
    }
    log('info', `收到取消请求：${frame.attemptId}`)
    entry.controller.abort()
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────────

  function start() {
    if (stopped === false) return { started: false, reason: 'already-started' }
    stopped = false
    attempt = 0
    open()
    return { started: true }
  }

  function stop({ reason = 'stopped' } = {}) {
    stopped = true
    if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null }
    if (heartbeatTimer !== null) { clearInterval(heartbeatTimer); heartbeatTimer = null }
    for (const entry of running.values()) { stats.aborted += 1; entry.controller.abort() }
    running.clear()
    try { ws?.close(WS_CLOSE.NORMAL, reason) } catch { /* 已断 */ }
    ws = null
    return { stopped: true, abortedRuns: stats.aborted }
  }

  return {
    start, stop,
    get state() {
      return Object.freeze({
        connected: ws !== null && ws.isOpen === true,
        running: [...running.keys()],
        pendingTerminals: pendingTerminals.length + pendingFailures.length,
        stats: Object.freeze({ ...stats }),
        ledger: ledger.stats(),
      })
    },
  }
}
