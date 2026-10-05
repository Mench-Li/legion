// team-hub/node-gateway.mjs
// ============================================================================
// Hub 侧 Node 网关（远程 Agent 通道 S-D）
//
// 电脑上的 Node 出站连到这里；本模块把协议帧翻译成 `run-store` 的调用。
//
// ## 一条不能破的边界：网关不拥有任务状态
//
// 网关**只**调用 `run-store` 的既有入口（`claim` / `heartbeat` / `transition` /
// `failAndRetry` / `recordRunEvents` / `release`）。它自己**不写** `tasks` 与
// `run_attempts`，也不缓存一份"当前状态"。理由在设计文档 §7.1 里：
//
//   > 远程层不得再建立一套与其竞争的任务权威状态机。
//
// 所以本文件里没有 `state` 变量、没有 `attempts` 表、没有"我记得它在跑"。
// 每个动作都去 `run-store` 问一次——那是唯一知道答案的地方。
//
// ## 幂等由谁负责
//
// 由 `run_events` 的 `(attempt_id, event_seq)` 唯一约束负责，**不在这里再加一层**。
// 多加一层的失败方式是：两层对"这是不是重复"判断不一致——网关说新的、库里说旧的，
// 于是重复的进展既写不进去也不报错，而两端都以为自己是对的。
// 所以这里的判据是 run-store 返回的 `written` / `skipped` 计数：`written === 0 &&
// skipped > 0` 就是"这一批全是重复的"，按正常重放处理，不当错误。
//
// ## 断线不等于任务结束
//
// 连接断开只做两件事：清 presence、停派发。**不**改任务状态。
// 设计文档 §6.3：「Relay/Node 断开只证明观察通道失效，不足以断言正在电脑上运行的
// DSH turn 已停止」。租约到期后是否重试由既有 `recoverExpired` 规则决定。
// ============================================================================
import {
  WS_CLOSE,
  WS_OPCODE,
  buildHandshakeFailure,
  buildHandshakeResponse,
  createFrameDecoder,
  encodeClose,
  encodeFrame,
  encodeText,
  validateUpgradeRequest,
} from '../packages/shared/src/ws-frames.mjs'

import {
  FRAME_TYPES,
  NODE_PATH,
  PROTOCOL_MAX_VERSION,
  PROTOCOL_MIN_VERSION,
  PROTOCOL_NAME,
  PROTOCOL_CODES,
  PROTOCOL_VERSION,
  buildFrame,
  negotiateVersion,
  validateFrame,
} from '../packages/shared/src/node-protocol.mjs'
// 对账要判断"Hub 这边算不算活跃"，而"哪些状态是活跃的"只能有一个定义。
// 复制一份到网关里会让它随状态机演进悄悄漂移，而漂移的表现是"对账永远说 agree"。
import { isActiveAttemptState } from '../orchestrator/state-machine/states.mjs'

/** workerId 前缀。看板上一个 worker 是不是远程节点，靠它一眼分辨。 */
export const NODE_WORKER_PREFIX = 'node:'

/** 网关侧错误码（与协议码分开：这些是**本端**的处置，不是对面发错了）。 */
export const GATEWAY_CODES = Object.freeze({
  HELLO_REQUIRED: 'NODE_HELLO_REQUIRED',
  NODE_ID_MISMATCH: 'NODE_ID_MISMATCH',
  HELLO_TIMEOUT: 'NODE_HELLO_TIMEOUT',
  VERSION_REJECTED: 'NODE_VERSION_REJECTED',
  LEASE_NOT_OWNED: 'NODE_LEASE_NOT_OWNED',
  STORE_REJECTED: 'NODE_STORE_REJECTED',
  CAPABILITY_MISSING: 'NODE_CAPABILITY_MISSING',
  FRAME_BUILD_FAILED: 'NODE_FRAME_BUILD_FAILED',
  DISPATCH_ACK_TIMEOUT: 'NODE_DISPATCH_ACK_TIMEOUT',
  CLAIM_BLOCKED: 'NODE_CLAIM_BLOCKED',
  CLAIM_UNBLOCKED: 'NODE_CLAIM_UNBLOCKED',
})

const HEX = (b) => createHash('sha256').update(String(b)).digest('hex')

/**
 * 从升级请求里取设备令牌：优先 `Authorization`，回落到 `?token=`。
 *
 * 回落查询串在这里是可接受的：设备令牌是**机器凭据**，它要经过的一次连接
 * 由我们自己的 Node 进程发起，不是浏览器（查询串会进浏览器历史与 Referer
 * 的那套顾虑不适用于 `product/node/`）。
 */
export function extractDeviceToken(req, url) {
  const bearer = /^Bearer\s+(.+)$/i.exec(String(req?.headers?.authorization ?? ''))?.[1]?.trim() ?? ''
  if (bearer) return { token: bearer, source: 'header' }
  const query = url?.searchParams?.get?.('token') ?? ''
  if (query) return { token: query.trim(), source: 'query' }
  return { token: '', source: 'none' }
}

/**
 * 造网关。
 *
 * @param {object} deps
 * @param {object} deps.deviceStore
 * @param {object} deps.runStore
 * @param {() => number} [deps.clock]
 * @param {Function} [deps.audit] `(actor, scope, action, taskId, detail)`；进展靠它广播到 SSE
 * @param {(taskId: string, scope: string) => object|null} [deps.describeTask] 任务摘要（**由 server.mjs 注入**，网关不认识 tasks 表的列）
 * @param {(code: string, detail: object) => void} [deps.onWarn]
 */
export function createNodeGateway({
  deviceStore,
  runStore,
  clock = Date.now,
  audit = null,
  describeTask = null,
  onWarn = null,
  path = NODE_PATH,
  helloTimeoutMs = 10_000,
  claimScope = null,
  leaseTtlMs = null,
  maxConcurrentPerNode = 1,
  dispatchPollMs = 3000,
  /**
   * 派发到收到 ack 的等待窗口。超时后放掉槽位（**不**判任务失败——
   * 租约由服务端的到期规则回收）。见 `armAckTimer`。
   */
  dispatchAckTimeoutMs = 60_000,
  protocolVersion = PROTOCOL_VERSION,
  minVersion = PROTOCOL_MIN_VERSION,
  maxVersion = PROTOCOL_MAX_VERSION,
  maxMessageBytes = 1024 * 1024,
} = {}) {
  for (const [name, dep] of Object.entries({ deviceStore, runStore })) {
    if (dep === null || dep === undefined) throw new TypeError(`createNodeGateway 缺注入项：${name}`)
  }
  if (typeof runStore.claim !== 'function' || typeof runStore.transition !== 'function') {
    throw new TypeError('createNodeGateway 需要一个真的 run-store（缺 claim/transition）')
  }

  /** 活连接：nodeId → connection。同一节点只保留最新一条，旧的那条会被关掉。 */
  const connections = new Map()
  let dispatchTimer = null
  let closed = false
  const counters = { upgraded: 0, rejected: 0, dispatches: 0, progressFrames: 0, duplicateEvents: 0, unknownOutcomeFrames: 0, blockedClaims: 0 }

  const warn = (code, detail) => { if (typeof onWarn === 'function') { try { onWarn(code, detail) } catch { /* 诊断失败不影响主流程 */ } } }
  const record = (actor, scope, action, taskId, detail) => {
    if (typeof audit !== 'function') return
    try { audit(actor, scope, action, taskId, detail ?? null) } catch { /* 审计失败不阻断派发 */ }
  }
  const workerIdOf = (nodeId) => `${NODE_WORKER_PREFIX}${nodeId}`

  // ── 连接 ──────────────────────────────────────────────────────────────────

  /**
   * 处理一次 `/node` 升级请求。
   *
   * 与 `whiteboard` 的服务端实现同一形状（挂在 `http.Server` 的 `upgrade` 上），
   * 但鉴权这里**必须在握手之前**：一个先握手再鉴权的实现，会让未授权的客户端
   * 先拿到一条合法 WebSocket，然后再被关掉——中间那段时间它已经能发帧了。
   */
  function handleUpgrade(req, socket) {
    let url
    try { url = new URL(req.url ?? '/', 'http://x') } catch { socket.destroy(); return }
    if (url.pathname !== path) { socket.destroy(); return }

    const invalid = validateUpgradeRequest(req)
    if (invalid !== null) {
      counters.rejected += 1
      try { socket.write(buildHandshakeFailure(invalid.status, invalid.reason)) } catch { /* 对端已断 */ }
      socket.destroy()
      return
    }

    const { token } = extractDeviceToken(req, url)
    const auth = deviceStore.authenticate({ token })
    if (auth.ok !== true) {
      counters.rejected += 1
      // 401 而不是 403：客户端该做的是换一个令牌，不是放弃。
      try { socket.write(buildHandshakeFailure(401, auth.code ?? 'DEVICE_TOKEN_INVALID')) } catch { /* 对端已断 */ }
      socket.destroy()
      return
    }

    const key = String(req.headers['sec-websocket-key'] ?? '')
    try { socket.write(buildHandshakeResponse(key, { protocol: PROTOCOL_NAME })) } catch { socket.destroy(); return }
    counters.upgraded += 1
    attachConnection(socket, auth)
  }

  function attachConnection(socket, auth) {
    const connectionId = `conn-${clock().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    const state = {
      connectionId,
      nodeId: auth.nodeId,
      userId: auth.userId,
      capabilities: new Set(auth.capabilities ?? []),
      phase: 'awaiting-hello',
      protocolVersion: null,
      inFlight: new Set(),        // attemptId（含**已派发但未 ack**的，见 pump）
      scopes: new Map(),          // attemptId → scope（审计要按空间过滤）
      ackTimers: new Map(),       // attemptId → 派发确认的超时定时器
      closed: false,
      lastHeartbeatMs: clock(),
      /** 上一次认领阻塞的签名。同一种阻塞**只说一次**——每 3 秒重印同一条警告，
       *  与把警告关掉是同一个东西。 */
      lastContentionSignature: null,
    }

    const decoder = createFrameDecoder({ maxBytes: maxMessageBytes, expectMasked: true })

    // Hub 主动发起的帧（hello.ack / heartbeat.ack / dispatch / …）没有可回应的请求，
    // 但协议要求每帧都带 `requestId` —— 于是由本端发一个。**不**把它做成"可选"：
    // 可选的关联 ID 在排障时等价于没有，而这里生成的成本是一次计数。
    let outboundSeq = 0
    const send = (type, fields = {}) => {
      if (state.closed) return false
      const requestId = fields.requestId ?? `srv-${state.connectionId}-${outboundSeq += 1}`
      try {
        socket.write(encodeText(JSON.stringify(buildFrame(type, { ...fields, requestId }, { now: clock })), { mask: false }))
        return true
      } catch (e) {
        // ★ 这里**不能**静默 `return false`：帧构造失败（少字段、类型没登记）与
        //   "对端断了写不出去"是两件完全不同的事，而它们的表现都是"对面没收到"。
        //   默默吞掉的后果实证过：`buildFrame` 因为缺 requestId 抛错，于是
        //   `hello.ack` 从来没发出去，而连接显示"在线"——两端都以为一切正常。
        warn(GATEWAY_CODES.FRAME_BUILD_FAILED, { type, nodeId: state.nodeId, message: e instanceof Error ? e.message : String(e) })
        return false
      }
    }
    const sendRaw = (buf) => { if (state.closed) return false; try { socket.write(buf); return true } catch { return false } }
    const closeWith = (code, reason, errorCode = null, message = null) => {
      if (errorCode !== null) send(FRAME_TYPES.ERROR, { code: errorCode, message: message ?? errorCode })
      sendRaw(encodeClose(code, String(reason ?? '').slice(0, 100)))
      // ★ 收尾必须**先冲字节再断**。直接 `destroy()` 会丢掉还在写缓冲里的
      //   close 帧，于是对端看到的是"连接莫名其妙断了"（code 1000）而不是
      //   "你违反了协议"（1008）——而这两者对排障的人意味着完全不同的排查方向。
      finish({ graceful: true })
    }
    const finish = ({ graceful = false } = {}) => {
      if (state.closed) return
      state.closed = true
      clearTimeout(state.helloTimer)
      for (const t of state.ackTimers.values()) clearTimeout(t)
      state.ackTimers.clear()
      // presence 用 connectionId 栅栏清：迟到的 close 不会把新连接标成离线。
      try { deviceStore.markOffline({ nodeId: state.nodeId, connectionId: state.connectionId }) } catch { /* 清理失败下次 sweep 兜底 */ }
      if (connections.get(state.nodeId)?.state.connectionId === state.connectionId) connections.delete(state.nodeId)
      try {
        if (graceful && socket.writable === true) socket.end()
        else socket.destroy()
      } catch { /* 已断 */ }
    }

    // 握手超时挂在 `state` 上而不是闭包变量上：`onHello` 定义在**工厂作用域**
    // （与 `attachConnection` 平级），拿不到 attachConnection 里的局部变量。
    // 放到 state 上，两边都看得见。
    state.helloTimer = setTimeout(() => {
      closeWith(WS_CLOSE.POLICY_VIOLATION, 'hello timeout', GATEWAY_CODES.HELLO_TIMEOUT, '连接后未在时限内发送 hello')
    }, helloTimeoutMs)
    if (typeof state.helloTimer.unref === 'function') state.helloTimer.unref()

    // 同一节点重连：关掉旧连接。两台机器共用一个 nodeId 是配置错误，
    // 保留两条会让"这条尝试归谁跑"变得不确定。
    const previous = connections.get(state.nodeId)
    if (previous !== undefined) previous.close(WS_CLOSE.NORMAL, 'replaced')

    connections.set(state.nodeId, { state, send, close: closeWith, socket })

    socket.on('data', (chunk) => {
      const { messages, error } = decoder.push(chunk)
      if (error) {
        closeWith(error.closeCode ?? WS_CLOSE.PROTOCOL_ERROR, error.code)
        return
      }
      for (const m of messages) {
        if (m.opcode === WS_OPCODE.PING) { sendRaw(encodeFrame(WS_OPCODE.PONG, m.payload, { mask: false })); continue }
        if (m.opcode === WS_OPCODE.PONG) continue
        if (m.opcode === WS_OPCODE.CLOSE) {
          sendRaw(encodeClose(null, ''))
          finish()
          return
        }
        if (m.opcode !== WS_OPCODE.TEXT) continue
        if (m.error) { closeWith(WS_CLOSE.INVALID_PAYLOAD, m.error.code); return }
        handleText(m.text, state, { send, close: closeWith })
      }
    })
    socket.on('error', () => finish())
    socket.on('close', () => finish())
  }

  // ── 帧处理 ────────────────────────────────────────────────────────────────

  function handleText(text, state, io) {
    const validated = validateFrame(text, { role: 'hub', version: state.protocolVersion })
    if (validated.ok !== true) {
      // ★ 未过协商就收到的帧一律拒（`version: null` 时 validateFrame 不校验版本，
      //   所以这里额外挡一道 phase）。
      if (state.phase === 'awaiting-hello') {
        io.close(WS_CLOSE.POLICY_VIOLATION, 'hello required', GATEWAY_CODES.HELLO_REQUIRED,
          `第一帧必须是 ${FRAME_TYPES.HELLO}，收到 ${validated.code === PROTOCOL_CODES.UNKNOWN_TYPE ? '未知帧' : validated.code}`)
        return
      }
      io.send(FRAME_TYPES.ERROR, { code: validated.code, message: validated.message })
      return
    }
    const frame = validated.frame
    // ★ 「hello 必须最先」是**独立于**校验结果的一道闸门。
    //
    // 曾经它只写在"校验失败"那个分支里，于是**一条完全合法的 heartbeat** 在
    // hello 之前到达时会走正常处理路径：连接从未完成版本协商，却已经开始收发
    // 业务帧。它不报任何错——对一个还没协商版本的连接，这些帧的解读是未定义的。
    if (state.phase !== 'ready' && frame.type !== FRAME_TYPES.HELLO) {
      io.close(WS_CLOSE.POLICY_VIOLATION, 'hello required', GATEWAY_CODES.HELLO_REQUIRED,
        `第一帧必须是 ${FRAME_TYPES.HELLO}，收到 ${frame.type}`)
      return
    }
    // 鉴权过的 nodeId 是**唯一**可信的节点身份。帧里自报的那个只能用来核对。
    if (frame.type !== FRAME_TYPES.HELLO && frame.nodeId !== undefined && frame.nodeId !== state.nodeId) {
      io.close(WS_CLOSE.POLICY_VIOLATION, 'nodeId mismatch', GATEWAY_CODES.NODE_ID_MISMATCH,
        `帧自报 nodeId=${frame.nodeId}，但这条连接是 ${state.nodeId} 的`)
      return
    }
    try {
      switch (frame.type) {
        case FRAME_TYPES.HELLO: return onHello(frame, state, io)
        case FRAME_TYPES.HEARTBEAT: return onHeartbeat(frame, state, io)
        case FRAME_TYPES.ACK: return onAck(frame, state, io)
        case FRAME_TYPES.PHASE: return onPhase(frame, state, io)
        case FRAME_TYPES.PROGRESS: return onProgress(frame, state, io)
        case FRAME_TYPES.TRANSITION: return onTransition(frame, state, io)
        case FRAME_TYPES.FAILURE: return onFailure(frame, state, io)
        case FRAME_TYPES.RECONCILE: return onReconcile(frame, state, io)
        default:
          io.send(FRAME_TYPES.ERROR, { requestId: frame.requestId, code: PROTOCOL_CODES.UNKNOWN_TYPE, message: `Hub 不处理 ${frame.type}` })
      }
    } catch (e) {
      // 仓储抛出的具名拒绝（epoch 过期、状态机不许、缺证据）在这里转成一条
      // 可诊断的错误帧，**并让 Node 停手**——不是静默吞掉继续等下一个帧。
      //
      // 同时记一条审计：这些拒绝在 Hub 侧原来是**看不见的**（只回给了 Node），
      // 于是"远端一直在报错、Hub 只在节点日志里能看出"变成了唯一线索。
      record(state.nodeId, state.scopes.get(frame.attemptId) ?? null, 'node:frame-rejected', frame.taskId ?? null, {
        type: frame.type, code: e?.code ?? GATEWAY_CODES.STORE_REJECTED,
        stateMachineCode: e?.stateMachineCode ?? null,
        missing: e?.missing ?? null,
        message: e instanceof Error ? e.message.slice(0, 300) : String(e),
      })
      io.send(FRAME_TYPES.ERROR, {
        requestId: frame.requestId,
        attemptId: frame.attemptId ?? null,
        code: e?.code ?? GATEWAY_CODES.STORE_REJECTED,
        message: e instanceof Error ? e.message : String(e),
      })
      if (e?.code === 'LEASE_EPOCH_STALE' || e?.code === 'LEASE_EXPIRED' || e?.code === 'LEASE_NOT_HELD') {
        state.inFlight.delete(frame.attemptId)
      }
    }
  }

  function onHello(frame, state, io) {
    if (state.phase !== 'awaiting-hello') {
      io.send(FRAME_TYPES.ERROR, { requestId: frame.requestId, code: GATEWAY_CODES.HELLO_REQUIRED, message: '重复的 hello' })
      return
    }
    const negotiated = negotiateVersion({ offered: frame.protocolVersion, min: minVersion, max: maxVersion })
    if (negotiated.ok !== true) {
      // ★ 版本不兼容是**拒绝连接**，不是降级：降级的表现是"连上了但某些回报
      //   永远不被采纳"，而那种故障没有任何错误信息。
      io.close(WS_CLOSE.POLICY_VIOLATION, 'version unsupported', negotiated.code, negotiated.message)
      return
    }
    if (frame.nodeId !== state.nodeId) {
      io.close(WS_CLOSE.POLICY_VIOLATION, 'nodeId mismatch', GATEWAY_CODES.NODE_ID_MISMATCH,
        `hello 自报 nodeId=${frame.nodeId}，令牌属于 ${state.nodeId}`)
      return
    }
    state.phase = 'ready'
    state.protocolVersion = negotiated.version
    // ★ **必须**在这里取消握手超时。
    //
    // 这个定时器是"连上之后多久还不 hello 就断开"的保护。它原本只在连接收尾
    // （`finish`）时被清掉，于是 hello **成功**之后它仍然会在到点时开火，
    // 把一条完全正常的连接关掉——10 秒后。症状是"每隔十秒掉线重连一次"，
    // 而两端日志都显示注册成功。
    //
    // 只有真实的长连接能发现它：短用例跑不到超时那一刻。实测就是这么发现的
    // （电脑侧日志：`已注册` 紧接着 `Hub 拒绝：NODE_HELLO_TIMEOUT`）。
    clearTimeout(state.helloTimer)
    try { deviceStore.touchDevice({ nodeId: state.nodeId, protocolVersion: negotiated.version }) } catch { /* 记账失败不阻断 */ }
    try { deviceStore.markOnline({ nodeId: state.nodeId, connectionId: state.connectionId }) } catch { /* 同上 */ }
    record(state.nodeId, 'global', 'node:online', null, { connectionId: state.connectionId, protocolVersion: negotiated.version })
    io.send(FRAME_TYPES.HELLO_ACK, {
      nodeId: state.nodeId,
      protocolVersion: negotiated.version,
      serverTimeMs: clock(),
      heartbeatIntervalMs: 30_000,
      capabilities: [...state.capabilities],
      canDispatch: state.capabilities.has('task.run'),
      maxConcurrent: maxConcurrentPerNode,
    })
    // hello 之后立刻试一次派发，不必等下一个 tick。
    pump()
  }

  function onHeartbeat(frame, state, io) {
    state.lastHeartbeatMs = clock()
    try { deviceStore.heartbeat({ nodeId: state.nodeId, connectionId: state.connectionId, lastEventSeq: null }) } catch { /* 同上 */ }
    // 续租：只续**这条连接确实持有**的那些租约。续一条不属于自己的租约会被
    // run-store 以 LEASE_NOT_HELD / LEASE_EPOCH_STALE 拒掉，那是想要的。
    const renewed = []
    const rejected = []
    for (const entry of frame.leases ?? []) {
      if (!state.inFlight.has(entry.attemptId)) {
        rejected.push({ attemptId: entry.attemptId, code: GATEWAY_CODES.LEASE_NOT_OWNED })
        continue
      }
      try {
        const r = runStore.heartbeat({ attemptId: entry.attemptId, leaseEpoch: entry.leaseEpoch, workerId: workerIdOf(state.nodeId), leaseTtlMs })
        renewed.push({ attemptId: entry.attemptId, leaseExpiresAtMs: r.leaseExpiresAtMs })
      } catch (e) {
        rejected.push({ attemptId: entry.attemptId, code: e?.code ?? GATEWAY_CODES.STORE_REJECTED, message: e?.message })
        state.inFlight.delete(entry.attemptId)
      }
    }
    io.send(FRAME_TYPES.HEARTBEAT_ACK, { nodeId: state.nodeId, serverTimeMs: clock(), renewed, rejected })
    pump()
  }

  function onAck(frame, state, io) {
    // 派发确认到了：不管接受还是拒绝，那条超时定时器都该取消。
    clearAckTimer(state, frame.attemptId)
    if (frame.accepted === true) {
      // 派发时已经**悲观**记入 inFlight（见 pump），这里只是确认。
      state.inFlight.add(frame.attemptId)
      record(state.nodeId, 'global', 'node:dispatch-ack', frame.taskId, { attemptId: frame.attemptId, leaseEpoch: frame.leaseEpoch })
      return
    }
    // 拒收：把租约**还回去**，而不是留在自己身上。留在身上会等到租约自然过期，
    // 期间这条任务既不在队列里也不在运行中——"卡住"的最难查的一种。
    state.inFlight.delete(frame.attemptId)
    state.scopes.delete(frame.attemptId)
    try {
      runStore.release({ attemptId: frame.attemptId, leaseEpoch: frame.leaseEpoch, workerId: workerIdOf(state.nodeId), reason: `node-declined: ${frame.reason}` })
    } catch (e) {
      warn(GATEWAY_CODES.STORE_REJECTED, { attemptId: frame.attemptId, code: e?.code, message: e?.message })
    }
    record(state.nodeId, 'global', 'node:dispatch-declined', frame.taskId, { attemptId: frame.attemptId, reason: frame.reason })
    pump()
  }

  /**
   * 派发确认的超时。
   *
   * ★ 为什么必须有：`inFlight` 是**悲观**记账（派发即计入，见 pump），
   *   好处是并发上限在"已派发未 ack"期间也成立。代价是——如果那条 ack 永远
   *   不来（节点半死不活、帧丢了），这个槽位就永远占着，这台电脑再也领不到任务。
   *   所以给一个窗口：到点就放掉。放掉**不等于**任务失败——租约仍在，由服务端
   *   的租约到期规则回收，这是一条既有的、有据可依的路径。
   */
  function armAckTimer(state, attemptId) {
    const t = setTimeout(() => {
      if (state.closed) return
      state.ackTimers.delete(attemptId)
      if (!state.inFlight.has(attemptId)) return
      state.inFlight.delete(attemptId)
      state.scopes.delete(attemptId)
      warn(GATEWAY_CODES.DISPATCH_ACK_TIMEOUT, { nodeId: state.nodeId, attemptId })
      pump()
    }, dispatchAckTimeoutMs)
    if (typeof t.unref === 'function') t.unref()
    state.ackTimers.set(attemptId, t)
  }

  function clearAckTimer(state, attemptId) {
    const t = state.ackTimers.get(attemptId)
    if (t === undefined) return
    clearTimeout(t)
    state.ackTimers.delete(attemptId)
  }

  /**
   * 执行阶段上报。
   *
   * ★ 为什么远端必须报这三个状态，而不能由 gateway 替它推进：
   *
   * 状态机为每条边定义了**唯一的合法路径** `Leased → PreparingWorkspace →
   * BuildingContext → Running → Validating`。远端如果跳过中间态直接报终态
   * （`transition{outcome:'completed'}` 从 `Leased`），状态机会以
   * `TRANSITION_REJECTED` 拒绝——实测就是这样：任务停在 `Leased`，
   * 而进展帧照常写入，从界面看"有进展但永远不结束"。
   *
   * 而"准备完了 / 上下文组装好了 / 开跑了"这三件事**只有 Node 知道**：
   * 是它自己在准备本地工作目录、组装要喂给执行器的上下文、启动执行器。
   * gateway 替它推进等于把一句没有依据的断言写成事实。
   *
   * 因此这里只做**转发**：把 Node 报的阶段交给 `run-store`，由状态机判定
   * 这条边能不能走。走不了就是 Node 报错了阶段，具名回给它——不替它兜底。
   */
  function onPhase(frame, state, io) {
    const r = runStore.transition({
      attemptId: frame.attemptId,
      leaseEpoch: frame.leaseEpoch,
      workerId: workerIdOf(state.nodeId),
      to: frame.state,
      reason: 'node-phase',
    })
    recordInScope(frame, state, 'node:phase', { state: frame.state, attemptId: frame.attemptId, idempotent: r.idempotent === true })
    io.send(FRAME_TYPES.ACK, {
      requestId: frame.requestId, nodeId: state.nodeId, taskId: frame.taskId, attemptId: frame.attemptId,
      leaseEpoch: frame.leaseEpoch, accepted: true,
      // `idempotent` 如实回给 Node：重连后重报同一个阶段是正常路径，
      // 而"它被当成重复处理了"与"它被当成了错误"要能分开。
      duplicate: r.idempotent === true,
      attemptState: r.attempt?.state ?? frame.state, serverTimeMs: clock(),
    })
  }

  /** 进展：写运行事件明细（权威）+ 记一条审计（经 SSE 广播到手机）。 */
  function onProgress(frame, state, io) {
    const result = runStore.recordRunEvents({
      attemptId: frame.attemptId,
      leaseEpoch: frame.leaseEpoch,
      events: [{
        seq: frame.seq,
        type: 'node.progress',
        event: { eventId: frame.eventId, kind: frame.kind, summary: frame.summary, nodeId: state.nodeId, sentAtMs: frame.sentAtMs, ...(frame.detail === undefined ? {} : { detail: frame.detail }) },
      }],
    })
    counters.progressFrames += 1
    // ★ 幂等判据来自 run-store 的计数，不是这里的另一层去重。
    const duplicate = Number(result.written) === 0 && Number(result.skipped) > 0
    if (duplicate) counters.duplicateEvents += 1
    else recordInScope(frame, state, 'node:progress', { seq: frame.seq, kind: frame.kind, summary: frame.summary, eventId: frame.eventId })
    io.send(FRAME_TYPES.ACK, {
      requestId: frame.requestId, nodeId: state.nodeId, taskId: frame.taskId, attemptId: frame.attemptId,
      leaseEpoch: frame.leaseEpoch, accepted: true, duplicate, seq: frame.seq, serverTimeMs: clock(),
    })
  }

  /** 终态：先写明细（用**这次**的 epoch），再迁移。顺序是实质的，见 runtime-lease.mjs 的注释。 */
  function onTransition(frame, state, io) {
    const events = []
    if (Number.isSafeInteger(frame.seq) && frame.seq >= 1) {
      events.push({
        seq: frame.seq,
        type: frame.outcome === 'completed' ? 'run.completed' : frame.outcome === 'cancelled' ? 'run.cancelled' : frame.outcome === 'outcome_unknown' ? 'run.outcome_unknown' : 'run.failed',
        event: { eventId: frame.eventId, outcome: frame.outcome, summary: frame.summary ?? null, artifacts: frame.artifacts ?? [], nodeId: state.nodeId, sentAtMs: frame.sentAtMs },
      })
    }
    const evOutcome = events.length > 0
      ? runStore.recordRunEvents({ attemptId: frame.attemptId, leaseEpoch: frame.leaseEpoch, events })
      : { written: 0, skipped: 0, total: 0 }
    // `outcome` 直通 `mapOutcomeToState`：`completed → Validating`，**不是** `Completed`。
    // 执行完成不等于交付被接受——这条边界由状态机守着，网关不绕过它。
    const r = runStore.transition({
      attemptId: frame.attemptId,
      leaseEpoch: frame.leaseEpoch,
      workerId: workerIdOf(state.nodeId),
      outcome: frame.outcome,
      context: frame.summary === undefined ? {} : { summary: frame.summary },
      reason: 'node-report',
    })
    state.inFlight.delete(frame.attemptId)
    if (frame.outcome === 'outcome_unknown') counters.unknownOutcomeFrames += 1
    recordInScope(frame, state, 'node:transition', { outcome: frame.outcome, attemptId: frame.attemptId, runEvents: evOutcome })
    io.send(FRAME_TYPES.ACK, {
      requestId: frame.requestId, nodeId: state.nodeId, taskId: frame.taskId, attemptId: frame.attemptId,
      leaseEpoch: frame.leaseEpoch, accepted: true, duplicate: false,
      attemptState: r.attempt?.state ?? null, createsNewAttempt: r.createsNewAttempt === true, serverTimeMs: clock(),
    })
    pump()
  }

  function onFailure(frame, state, io) {
    const events = [{
      seq: frame.seq,
      type: 'run.failed',
      event: { eventId: frame.eventId, failureCode: frame.failureCode, detail: frame.detail ?? null, nodeId: state.nodeId, sentAtMs: frame.sentAtMs },
    }]
    const evOutcome = runStore.recordRunEvents({ attemptId: frame.attemptId, leaseEpoch: frame.leaseEpoch, events })
    // 走 `failAndRetry` 而**不是** `transition({to:'RetryableFailure'})`：后者会漏掉
    // 重试排队那一步，任务会停在 RetryableFailure——既没有可领的队列，也不在等人工
    // 列表里，从任何界面看都只是"失败了"，而没有人会去处理它。
    const r = runStore.failAndRetry({
      attemptId: frame.attemptId,
      leaseEpoch: frame.leaseEpoch,
      actor: workerIdOf(state.nodeId),
      failureCode: frame.failureCode,
      detail: frame.detail ?? null,
      reason: 'node-failure-report',
      runResult: frame.runResult ?? null,
    })
    state.inFlight.delete(frame.attemptId)
    recordInScope(frame, state, 'node:failure', { failureCode: frame.failureCode, attemptId: frame.attemptId, runEvents: evOutcome })
    io.send(FRAME_TYPES.ACK, {
      requestId: frame.requestId, nodeId: state.nodeId, taskId: frame.taskId, attemptId: frame.attemptId,
      leaseEpoch: frame.leaseEpoch, accepted: true, duplicate: false, attemptState: r.attempt?.state ?? null, serverTimeMs: clock(),
    })
    pump()
  }

  /**
   * 重连对账。
   *
   * 本函数**只比较、不迁移**。这一点是刻意的：Node 的账本是一面之词（它可能刚被
   * 重启、可能记错了、可能是另一份被拷过来的数据），拿它去驱动状态迁移，就等于
   * 让一个不可验证的自述改写权威状态。设计文档 §6.3 要求"结果无法验证则进入
   * `UnknownOutcome`"——那条路径由**租约到期**触发（`recoverExpired` 配合
   * `externalEffectPossibleStates`），由服务端的租约规则判定，而不是由 Node 报告。
   *
   * 所以这里回一份逐条比对，把不一致**显式报出来**（`state-mismatch`），
   * 让界面和运维能看到它；处置权留在既有的人工/租约路径上。
   *
   * ★ `entry.state` 是**节点自己的词汇**（accepted / running / finished），
   *   不是 Attempt 状态名。比对的是两套词汇之间的**期望关系**：
   *   "本机说结束了，Hub 却还认为是活跃的" —— 这正是需要对账的那一类。
   *   拿它去做字符串相等比较会恒不相等，于是一次真的不一致与一次正常对账
   *   在输出上长得一样。
   */
  function onReconcile(frame, state, io) {
    const comparison = []
    for (const entry of frame.ledger) {
      let attempt = null
      try { attempt = runStore.getAttempt(entry.attemptId) } catch { attempt = null }
      if (attempt === null || attempt === undefined) {
        comparison.push({ ...entry, hubKnown: false, verdict: 'orphan' })
        continue
      }
      const epochMatches = Number(attempt.leaseEpoch) === Number(entry.leaseEpoch)
      const workerMatches = String(attempt.workerId ?? '') === workerIdOf(state.nodeId)
      const hubActive = isActiveAttemptState(attempt.state)
      const nodeFinished = entry.state === 'finished'
      // 四种结论各有各的处置，合成一个 `ok:false` 会让运维不知道该干什么：
      //   · epoch-superseded —— 这条尝试已经被别人接管，本机该停手；
      //   · not-owner        —— 本机不是持有者（配置或数据被改过）；
      //   · state-mismatch   —— 本机认为的状态与 Hub 的活跃性不符，**要人看**；
      //   · agree            —— 两边一致。
      const verdict = !epochMatches ? 'epoch-superseded'
        : !workerMatches ? 'not-owner'
          : (nodeFinished === !hubActive ? 'agree' : 'state-mismatch')
      comparison.push({
        taskId: entry.taskId, attemptId: entry.attemptId, leaseEpoch: entry.leaseEpoch,
        hubKnown: true, hubState: attempt.state ?? null, hubActive,
        nodeState: entry.state,
        epochMatches, workerMatches,
        verdict,
      })
      if (!epochMatches) state.inFlight.delete(entry.attemptId)
    }
    state.inFlight.clear()
    for (const c of comparison) if (c.hubKnown && c.verdict === 'agree' && c.hubActive) state.inFlight.add(c.attemptId)
    io.send(FRAME_TYPES.RECONCILE, {
      nodeId: state.nodeId, requestId: frame.requestId, serverTimeMs: clock(), comparison,
    })
    record(state.nodeId, 'global', 'node:reconcile', null, { entries: comparison.length, mismatches: comparison.filter((c) => c.verdict !== 'agree').length })
    pump()
  }

/** 记一条审计。scope 从**派发时记下的**那条尝试上取——审计要能按空间过滤。 */
function recordInScope(frame, state, action, detail) {
  const scope = state.scopes.get(frame.attemptId) ?? null
  record(state.nodeId, scope, action, frame.taskId, detail)
}

  // ── 派发 ──────────────────────────────────────────────────────────────────

  /**
   * 给空闲节点派发一条任务。
   *
   * 由定时器与"上一次派发完成后"共同触发。`claim` 在**Hub 自己的事务里**执行，
   * 所以并发派发不会把同一条任务发给两个节点——这一点不需要网关做任何事。
   */
  function pump() {
    if (closed) return
    for (const { state, send, close } of connections.values()) {
      if (state.closed || state.phase !== 'ready') continue
      if (!state.capabilities.has('task.run')) continue
      if (state.inFlight.size >= maxConcurrentPerNode) continue
      let claim
      try {
        claim = runStore.claim({ workerId: workerIdOf(state.nodeId), scope: claimScope, leaseTtlMs })
      } catch (e) {
        // 派发失败只记诊断：它不该影响这条连接的健康（下一个 tick 还会试）。
        warn(GATEWAY_CODES.STORE_REJECTED, { nodeId: state.nodeId, phase: 'claim', code: e?.code, message: e?.message })
        continue
      }
      if (claim?.claimed === null || claim?.claimed === undefined) {
        // ★ 被拒的认领**必须**被看见。
        //
        // `claim` 在"有别的任务占着单写者位"时返回 `claimed: null` + `reason:
        // 'file-contention'`，而它是**正常返回**、不是异常。原实现直接 `continue`，
        // 于是"节点就绪、任务待办、但什么都不派发"这件事在日志、审计、读数里
        // 全都没有痕迹——实测就是这样查了半小时。
        //
        // 处理方式与 `server.mjs` 里工具账收账那处同一个形状：**同一种坏法
        // 只说一次**。每 3 秒重印同一条警告，与把警告关掉是同一个东西。
        if (typeof claim?.reason === 'string' && claim.reason !== 'queue-empty') {
          counters.blockedClaims += 1
          const sig = `${claim.reason}:${claim.contention?.holderTaskId ?? '-'}`
          if (state.lastContentionSignature !== sig) {
            state.lastContentionSignature = sig
            warn(GATEWAY_CODES.CLAIM_BLOCKED, {
              nodeId: state.nodeId, reason: claim.reason,
              holderTaskId: claim.contention?.holderTaskId ?? null,
              code: claim.contention?.code ?? null,
              detail: claim.contention?.reason ?? null,
              note: '任务在排队但领不到；这不是节点故障',
            })
          }
        } else if (state.lastContentionSignature !== null) {
          state.lastContentionSignature = null
          warn(GATEWAY_CODES.CLAIM_UNBLOCKED, { nodeId: state.nodeId, note: '认领已恢复' })
        }
        continue
      }
      const c = claim.claimed
      const task = typeof describeTask === 'function' ? describeTask(c.taskId, c.scope) : null
      const ok = send(FRAME_TYPES.DISPATCH, {
        nodeId: state.nodeId,
        taskId: c.taskId,
        attemptId: c.attemptId,
        leaseEpoch: c.leaseEpoch,
        leaseExpiresAtMs: c.leaseExpiresAtMs,
        scope: c.scope,
        attemptNo: c.attemptNo,
        serverTimeMs: c.serverTimeMs,
        task: task ?? null,
        ...(c.allowedTools === undefined ? {} : { allowedTools: c.allowedTools, deniedTools: c.deniedTools ?? [], approvalPolicy: c.approvalPolicy ?? null }),
      })
      if (!ok) {
        // 帧没发出去：把租约还回去，而不是让它烂在手上。
        try { runStore.release({ attemptId: c.attemptId, leaseEpoch: c.leaseEpoch, workerId: workerIdOf(state.nodeId), reason: 'dispatch-write-failed' }) } catch { /* 由租约到期兜底 */ }
        close(WS_CLOSE.NORMAL, 'write failed')
        return
      }
      counters.dispatches += 1
      // ★ **悲观**计入在途：派发那一刻就占住槽位，而不是等 ack。
      //
      // 等 ack 的写法有一个静默的窗口：从派发到 ack 之间 `inFlight` 是空的，
      // 于是下一个 tick 会再派一条——并发上限形同虚设，而两台任务会同时写
      // 同一个工作区。窗口很短（一次往返），所以这个 bug 在本地几乎看不出来，
      // 只在网络慢或节点忙的时候出现。
      state.inFlight.add(c.attemptId)
      state.scopes.set(c.attemptId, c.scope)
      armAckTimer(state, c.attemptId)
      record(state.nodeId, c.scope, 'node:dispatch', c.taskId, { attemptId: c.attemptId, leaseEpoch: c.leaseEpoch })
    }
  }

  function attach(server) {
    if (server === null || typeof server?.on !== 'function') throw new TypeError('attach 需要 http.Server')
    server.on('upgrade', (req, socket) => handleUpgrade(req, socket))
    if (dispatchTimer === null && dispatchPollMs > 0) {
      dispatchTimer = setInterval(() => pump(), dispatchPollMs)
      // unref：一个会阻止进程退出的定时器与一个关不掉的后台任务是同一个东西
      // （测试进程会因此永远不结束）。
      if (typeof dispatchTimer.unref === 'function') dispatchTimer.unref()
    }
    return api
  }

  function close() {
    closed = true
    if (dispatchTimer !== null) { clearInterval(dispatchTimer); dispatchTimer = null }
    for (const { close: closeConn } of [...connections.values()]) closeConn(WS_CLOSE.NORMAL, 'hub shutting down')
    connections.clear()
  }

  /** 主动下发一条取消（Hub → Node）。v1 只提供通道，接线由调用方负责。 */
  function sendCancel(nodeId, { taskId, attemptId, leaseEpoch, reason = '' }) {
    const conn = connections.get(nodeId)
    if (conn === undefined) return { sent: false, reason: 'node-offline' }
    const ok = conn.send(FRAME_TYPES.CANCEL, {
      requestId: `cancel-${attemptId}`, nodeId, taskId, attemptId, leaseEpoch, reason,
    })
    return ok ? { sent: true } : { sent: false, reason: 'write-failed' }
  }

  const api = {
    attach, handleUpgrade, pump, close, sendCancel,
    connections,
    /**
     * 每条连接的**只读投影**（诊断用）。
     *
     * 为什么不直接暴露 `connections`：它是个 Map，值里握着 socket 与闭包。
     * 让调用方自己 `[...map.values()].map(...)` 会诱使下一处诊断代码去读更深的
     * 内部字段（`socket`、`ackTimers`），于是"内部结构"事实上变成了公开面，
     * 而改内部时没有任何东西会红。这里只吐**排查真正需要的那几个**。
     */
    connectionViews() {
      return [...connections.values()].map(({ state }) => Object.freeze({
        nodeId: state.nodeId,
        connectionId: state.connectionId,
        phase: state.phase,
        protocolVersion: state.protocolVersion,
        capabilities: Object.freeze([...state.capabilities]),
        inFlight: Object.freeze([...state.inFlight]),
        pendingAcks: Object.freeze([...state.ackTimers.keys()]),
        closed: state.closed,
        lastHeartbeatAtMs: state.lastHeartbeatMs,
      }))
    },
    get stats() {
      return Object.freeze({
        ...counters,
        connected: connections.size,
        online: [...connections.values()].filter((c) => c.state.phase === 'ready').length,
        inFlight: [...connections.values()].reduce((n, c) => n + c.state.inFlight.size, 0),
      })
    },
    get path() { return path },
    get helloTimeoutMs() { return helloTimeoutMs },
    get claimScope() { return claimScope },
    get dispatchPollMs() { return dispatchPollMs },
    /** 派发定时器是否真的在跑。诊断"连上了但不派发"时第一个要看的东西。 */
    get dispatching() { return dispatchTimer !== null },
  }
  return api
}
