// packages/shared/src/node-protocol.mjs
// ============================================================================
// Legion Node 通道协议契约（远程 Agent 通道 S-C）
//
// 设计依据：`docs/superpowers/specs/2026-10-02-legion-server-pc-mobile-agent-architecture.md` §7.2。
//
// 这一层只回答「这个帧合法吗、版本谈得拢吗、这条事件该不该收」，**不碰 socket、
// 不碰数据库**。分开的理由不是"分层好看"，而是这三件事各自都能在没有网络、没有
// Hub 的情况下把全部拒绝路径跑一遍——而它们恰恰是最难在真实环境里复现的部分
// （版本不兼容、迟到回报、重复事件）。真实链路上它们反而是"偶尔出现一次"。
//
// ## 本模块与既有状态机的关系
//
// 终态名义（`completed` / `failed` / `outcome_unknown` / `cancelled`）**逐字取自**
// `team-hub/run-store.mjs` 的 `mapOutcomeToState`。远程层不引入第二套任务状态：
// `dispatch` 里的 `attemptState`、`progress` 里的展示投影都必须能回溯到
// `orchestrator/state-machine/states.mjs` 的 13 个 Attempt 状态。这里刻意**不**提供
// `dispatched/accepted/succeeded` 之类的新状态名，那些正是设计文档 §7.1 禁止的。
//
// ## 三个「不」是刻意的
//
// 1. 版本不兼容 → **拒绝连接 + 给出双方范围**，不静默降级。静默降级的表现是
//    "连上了，但某些回报永远不被采纳"，那种故障没有任何错误信息。
// 2. 未知帧类型 → **具名拒绝**，不忽略。忽略会让"Hub 还不认识这个回报"变成
//    "Node 报了但 Hub 什么也没记"，而两端都认为自己在正常工作。
// 3. 重复 `eventId` → **当成正常重复**（幂等），不是错误；但「不同事件占用同一个旧序号」
//    是错误。两者混为一谈会让"重试了一次上报"与"两个事件撞了号"无法区分。
// ============================================================================
import { randomBytes as nodeRandomBytes } from 'node:crypto'

/** 协议主版本。Hub 与 Node 必须精确相同，不做小版本宽松匹配。 */
export const PROTOCOL_VERSION = 1
export const PROTOCOL_MIN_VERSION = 1
export const PROTOCOL_MAX_VERSION = 1

/** WebSocket 子协议名（握手时协商，便于中间设备与日志辨认）。 */
export const PROTOCOL_NAME = 'legion-node-v1'

/** 通道路径。 */
export const NODE_PATH = '/node'

/** 单帧字节上限。与 `ws-frames.mjs` 的帧层上限是两回事：这个是**消息语义**上限。 */
export const MAX_FRAME_BYTES = 256 * 1024

/** 字段级上限。 */
export const LIMITS = Object.freeze({
  nodeId: 128,
  requestId: 128,
  eventId: 128,
  taskId: 200,
  attemptId: 200,
  summary: 4000,
  failureCode: 64,
  detail: 2000,
  reason: 500,
  artifacts: 50,
  ledgerEntries: 500,
  capabilities: 64,
})

/**
 * 帧类型。`hello`/`hello.ack` 一定最先，`error` 可在任何时刻发出。
 *
 * 命名的方向是有意的：`*.ack` 只由 Hub 发，其余只由 Node 发或双向。把方向编进
 * 类型名，是为了让"Node 收到了一条它不该收到的帧"在契约层就能被判出来。
 */
export const FRAME_TYPES = Object.freeze({
  HELLO: 'hello',
  HELLO_ACK: 'hello.ack',
  HEARTBEAT: 'heartbeat',
  HEARTBEAT_ACK: 'heartbeat.ack',
  DISPATCH: 'dispatch',
  ACK: 'ack',
  PHASE: 'phase',
  PROGRESS: 'progress',
  TRANSITION: 'transition',
  FAILURE: 'failure',
  RECONCILE: 'reconcile',
  CANCEL: 'cancel',
  ERROR: 'error',
})

/**
 * Node 可以上报的**执行阶段**。
 *
 * ★ 这些名字**逐字取自** `orchestrator/state-machine/states.mjs` 的 Attempt 状态，
 *   不是另一套词汇。理由：状态机为每条边定义了合法迁移与所需证据
 *   （`Leased → PreparingWorkspace → BuildingContext → Running → Validating`），
 *   而远端如果自创一套 `preparing/running`，gateway 就得维护一张翻译表——
 *   那张表迟早会与状态机漂移，而漂移的表现是"某些任务的回报永远不被采纳"。
 *
 * 为什么必须由 Node 上报而不是 gateway 自己推进：**这三个阶段是 Node 真的在做的事**
 * （准备本地工作目录、组装上下文、调用执行器）。gateway 替它推进等于把
 * "准备完了"这句话写成了一句无依据的断言。
 *
 * 不含 `Queued`/`Leased`（那是 `claim` 的产物）、也不含终态（走 `transition` 帧）。
 */
export const NODE_PHASES = Object.freeze(['PreparingWorkspace', 'BuildingContext', 'Running'])

/** 每个类型允许的方向：`node`（Node→Hub）、`hub`（Hub→Node）、`both`。 */
const FRAME_DIRECTION = Object.freeze({
  [FRAME_TYPES.HELLO]: 'node',
  [FRAME_TYPES.HELLO_ACK]: 'hub',
  [FRAME_TYPES.HEARTBEAT]: 'node',
  [FRAME_TYPES.HEARTBEAT_ACK]: 'hub',
  [FRAME_TYPES.DISPATCH]: 'hub',
  [FRAME_TYPES.ACK]: 'node',
  [FRAME_TYPES.PHASE]: 'node',
  [FRAME_TYPES.PROGRESS]: 'node',
  [FRAME_TYPES.TRANSITION]: 'node',
  [FRAME_TYPES.FAILURE]: 'node',
  [FRAME_TYPES.RECONCILE]: 'both',
  [FRAME_TYPES.CANCEL]: 'hub',
  [FRAME_TYPES.ERROR]: 'both',
})

/** 「本端是这个角色时，对面是谁」——入站帧的方向必须是对面。 */
const SENDER_OF_ROLE = Object.freeze({ hub: 'node', node: 'hub' })

export function isFrameType(type) {
  return Object.prototype.hasOwnProperty.call(FRAME_DIRECTION, String(type))
}

export function directionOf(type) {
  return FRAME_DIRECTION[String(type)] ?? null
}

/**
 * 终态名义。**逐字**对齐 `run-store.mjs` 的 `mapOutcomeToState` 入参：
 * `completed` / `failed` / `outcome_unknown` / `cancelled`。
 *
 * `outcome_unknown`（而不是 `unknown`）是刻意的：`UnknownOutcome` 在 Legion 里
 * 是一个**要人工处置**的具名状态，不是"暂时不知道"。名字对齐能避免适配器里
 * 出现一次翻译，而翻译表是丢字段的常见位置。
 */
export const TERMINAL_OUTCOMES = Object.freeze(['completed', 'failed', 'outcome_unknown', 'cancelled'])

/** 进展类别。展示用，不参与状态判定——工作状态由 Attempt 状态与事件共同决定。 */
export const PROGRESS_KINDS = Object.freeze([
  'started', 'step', 'tool', 'note', 'blocked', 'question', 'artifact',
])

/** 具名错误码。两头共用，便于断言与排障。 */
export const PROTOCOL_CODES = Object.freeze({
  VERSION_UNSUPPORTED: 'PROTOCOL_VERSION_UNSUPPORTED',
  FRAME_NOT_OBJECT: 'PROTOCOL_FRAME_NOT_OBJECT',
  FRAME_TOO_LARGE: 'PROTOCOL_FRAME_TOO_LARGE',
  UNKNOWN_TYPE: 'PROTOCOL_UNKNOWN_TYPE',
  WRONG_DIRECTION: 'PROTOCOL_WRONG_DIRECTION',
  MISSING_FIELD: 'PROTOCOL_MISSING_FIELD',
  INVALID_FIELD: 'PROTOCOL_INVALID_FIELD',
  FIELD_TOO_LONG: 'PROTOCOL_FIELD_TOO_LONG',
  TOO_MANY_ITEMS: 'PROTOCOL_TOO_MANY_ITEMS',
  UNKNOWN_OUTCOME: 'PROTOCOL_UNKNOWN_OUTCOME',
  UNKNOWN_PROGRESS_KIND: 'PROTOCOL_UNKNOWN_PROGRESS_KIND',
  UNKNOWN_PHASE: 'PROTOCOL_UNKNOWN_PHASE',
  SEQ_INVALID: 'PROTOCOL_SEQ_INVALID',
  SEQ_OUT_OF_ORDER: 'PROTOCOL_SEQ_OUT_OF_ORDER',
  LEASE_EPOCH_MISSING: 'PROTOCOL_LEASE_EPOCH_MISSING',
  NOT_HELLO: 'PROTOCOL_NOT_HELLO',
})

const fail = (code, message, extra = {}) => Object.freeze({ ok: false, code, message, ...extra })
const ok = (value = {}) => Object.freeze({ ok: true, ...value })

// ── 版本协商 ────────────────────────────────────────────────────────────────

/**
 * 协商协议主版本。
 *
 * 规则（设计文档 §7.2）：**精确主版本匹配**。Hub 公布自己接受的 `[min, max]`，
 * Node 报它要用的版本；落在范围内即可，否则拒绝并把双方范围一起回给对方——
 * 只说"不支持"会让对面无从判断该怎么升/降。
 *
 * ★ 不做"取交集后降级"：首版只有一个版本，任何"折中"都只能是**猜**。
 *   真出现多版本时，正确做法是让 Hub 显式列出可接受集合，而不是在客户端算交集。
 */
export function negotiateVersion({
  offered,
  min = PROTOCOL_MIN_VERSION,
  max = PROTOCOL_MAX_VERSION,
} = {}) {
  if (!Number.isInteger(offered)) {
    return fail(PROTOCOL_CODES.VERSION_UNSUPPORTED, `protocol_version 必须是整数，收到 ${JSON.stringify(offered)}`, { hubMin: min, hubMax: max })
  }
  if (offered < min || offered > max) {
    return fail(PROTOCOL_CODES.VERSION_UNSUPPORTED,
      `不兼容的 protocol_version=${offered}；本 Hub 接受 [${min}, ${max}]`,
      { hubMin: min, hubMax: max, offered })
  }
  return ok({ version: offered })
}

// ── 字段校验小工具 ──────────────────────────────────────────────────────────

function checkString(frame, field, { required = true, max = 200 } = {}) {
  const v = frame[field]
  if (v === undefined || v === null) {
    if (!required) return null
    return fail(PROTOCOL_CODES.MISSING_FIELD, `缺少必填字段 ${field}`)
  }
  if (typeof v !== 'string' || v.length === 0) {
    return fail(PROTOCOL_CODES.INVALID_FIELD, `${field} 必须是非空字符串`)
  }
  if (v.length > max) {
    return fail(PROTOCOL_CODES.FIELD_TOO_LONG, `${field} 长度 ${v.length} 超过上限 ${max}`)
  }
  return null
}

function checkLeaseEpoch(frame, { required = true } = {}) {
  const v = frame.leaseEpoch
  if (v === undefined || v === null) {
    // leaseEpoch 是防「迟到的旧回报覆盖新 Attempt」的栅栏。缺了它，一次重连后的
    // 旧回报会被当成有效回报——这正是设计文档 §13 明确禁止的。
    return required ? fail(PROTOCOL_CODES.LEASE_EPOCH_MISSING, '缺少 leaseEpoch：无法判断这条回报属于哪一次租约') : null
  }
  if (!Number.isSafeInteger(v) || v < 1) {
    return fail(PROTOCOL_CODES.INVALID_FIELD, `leaseEpoch 必须是正整数，收到 ${JSON.stringify(v)}`)
  }
  return null
}

function checkRequestId(frame) {
  return checkString(frame, 'requestId', { max: LIMITS.requestId })
}

// ── 各类型的字段要求 ────────────────────────────────────────────────────────

/**
 * 每个类型的必需/可选字段都写在这里，`validateFrame` 只做派发。
 *
 * 用表驱动而不是一串 `if`，是为了让"某个类型的字段要求"能**被枚举**——
 * 于是可以写"每个类型都有一条缺字段用例"这种覆盖性断言，而不是逐个补用例。
 */
const FIELD_RULES = Object.freeze({
  [FRAME_TYPES.HELLO]: (f) => {
    if (!Number.isInteger(f.protocolVersion)) return fail(PROTOCOL_CODES.MISSING_FIELD, 'hello 必须带整数 protocolVersion')
    return checkString(f, 'nodeId', { max: LIMITS.nodeId })
  },
  [FRAME_TYPES.HELLO_ACK]: (f) => {
    if (!Number.isInteger(f.protocolVersion)) return fail(PROTOCOL_CODES.MISSING_FIELD, 'hello.ack 必须带整数 protocolVersion')
    return null
  },
  [FRAME_TYPES.HEARTBEAT]: (f) => {
    const e = checkString(f, 'nodeId', { max: LIMITS.nodeId })
    if (e) return e
    if (f.leases !== undefined) {
      if (!Array.isArray(f.leases)) return fail(PROTOCOL_CODES.INVALID_FIELD, 'leases 必须是数组')
      if (f.leases.length > LIMITS.ledgerEntries) return fail(PROTOCOL_CODES.TOO_MANY_ITEMS, `leases 条数超过 ${LIMITS.ledgerEntries}`)
      for (const item of f.leases) {
        if (item === null || typeof item !== 'object') return fail(PROTOCOL_CODES.INVALID_FIELD, 'leases 元素必须是对象')
        const ee = checkLeaseEpoch(item)
        if (ee) return ee
        const ae = checkString(item, 'attemptId', { max: LIMITS.attemptId })
        if (ae) return ae
      }
    }
    return null
  },
  [FRAME_TYPES.HEARTBEAT_ACK]: () => null,
  [FRAME_TYPES.DISPATCH]: (f) => {
    const e = checkString(f, 'taskId', { max: LIMITS.taskId }) ?? checkString(f, 'attemptId', { max: LIMITS.attemptId })
    if (e) return e
    return checkLeaseEpoch(f)
  },
  [FRAME_TYPES.ACK]: (f) => {
    const e = checkString(f, 'taskId', { max: LIMITS.taskId }) ?? checkString(f, 'attemptId', { max: LIMITS.attemptId })
    if (e) return e
    const le = checkLeaseEpoch(f)
    if (le) return le
    if (typeof f.accepted !== 'boolean') return fail(PROTOCOL_CODES.INVALID_FIELD, 'ack 必须带布尔 accepted')
    // 拒收必须给理由：一个没有理由的"我不接这个活"在 Hub 侧无法处置。
    if (f.accepted === false) return checkString(f, 'reason', { max: LIMITS.reason })
    return null
  },
  [FRAME_TYPES.PHASE]: (f) => {
    const e = checkString(f, 'taskId', { max: LIMITS.taskId }) ?? checkString(f, 'attemptId', { max: LIMITS.attemptId })
    if (e) return e
    const le = checkLeaseEpoch(f)
    if (le) return le
    if (!NODE_PHASES.includes(f.state)) {
      // 具名拒绝：自创阶段名会让状态机收到一条它没有边可走的迁移，
      // 而那个拒绝发生在 gateway 里、离原因很远。
      return fail(PROTOCOL_CODES.UNKNOWN_PHASE, `未登记的执行阶段 ${JSON.stringify(f.state)}；合法取值：${NODE_PHASES.join(', ')}`)
    }
    return null
  },
  [FRAME_TYPES.PROGRESS]: (f) => {
    const e = checkString(f, 'eventId', { max: LIMITS.eventId })
      ?? checkString(f, 'taskId', { max: LIMITS.taskId })
      ?? checkString(f, 'attemptId', { max: LIMITS.attemptId })
    if (e) return e
    const le = checkLeaseEpoch(f)
    if (le) return le
    if (!Number.isSafeInteger(f.seq) || f.seq < 1) return fail(PROTOCOL_CODES.SEQ_INVALID, 'progress.seq 必须是 >=1 的整数')
    if (!PROGRESS_KINDS.includes(f.kind)) {
      return fail(PROTOCOL_CODES.UNKNOWN_PROGRESS_KIND, `未登记的进展类别 ${JSON.stringify(f.kind)}；合法取值：${PROGRESS_KINDS.join(', ')}`)
    }
    return checkString(f, 'summary', { max: LIMITS.summary })
  },
  [FRAME_TYPES.TRANSITION]: (f) => {
    const e = checkString(f, 'eventId', { max: LIMITS.eventId })
      ?? checkString(f, 'taskId', { max: LIMITS.taskId })
      ?? checkString(f, 'attemptId', { max: LIMITS.attemptId })
    if (e) return e
    const le = checkLeaseEpoch(f)
    if (le) return le
    if (!Number.isSafeInteger(f.seq) || f.seq < 1) return fail(PROTOCOL_CODES.SEQ_INVALID, 'transition.seq 必须是 >=1 的整数')
    if (!TERMINAL_OUTCOMES.includes(f.outcome)) {
      return fail(PROTOCOL_CODES.UNKNOWN_OUTCOME, `未登记的终态名义 ${JSON.stringify(f.outcome)}；合法取值：${TERMINAL_OUTCOMES.join(', ')}`)
    }
    if (f.artifacts !== undefined) {
      if (!Array.isArray(f.artifacts)) return fail(PROTOCOL_CODES.INVALID_FIELD, 'artifacts 必须是数组')
      if (f.artifacts.length > LIMITS.artifacts) return fail(PROTOCOL_CODES.TOO_MANY_ITEMS, `artifacts 条数超过 ${LIMITS.artifacts}`)
      for (const a of f.artifacts) {
        if (a === null || typeof a !== 'object') return fail(PROTOCOL_CODES.INVALID_FIELD, 'artifacts 元素必须是对象')
        const pe = checkString(a, 'path', { max: 500 })
        if (pe) return pe
      }
    }
    return null
  },
  [FRAME_TYPES.FAILURE]: (f) => {
    const e = checkString(f, 'eventId', { max: LIMITS.eventId })
      ?? checkString(f, 'taskId', { max: LIMITS.taskId })
      ?? checkString(f, 'attemptId', { max: LIMITS.attemptId })
    if (e) return e
    const le = checkLeaseEpoch(f)
    if (le) return le
    if (!Number.isSafeInteger(f.seq) || f.seq < 1) return fail(PROTOCOL_CODES.SEQ_INVALID, 'failure.seq 必须是 >=1 的整数')
    return checkString(f, 'failureCode', { max: LIMITS.failureCode })
  },
  [FRAME_TYPES.RECONCILE]: (f) => {
    if (!Array.isArray(f.ledger)) return fail(PROTOCOL_CODES.MISSING_FIELD, 'reconcile 必须带 ledger 数组')
    if (f.ledger.length > LIMITS.ledgerEntries) return fail(PROTOCOL_CODES.TOO_MANY_ITEMS, `ledger 条数超过 ${LIMITS.ledgerEntries}`)
    for (const entry of f.ledger) {
      if (entry === null || typeof entry !== 'object') return fail(PROTOCOL_CODES.INVALID_FIELD, 'ledger 元素必须是对象')
      const te = checkString(entry, 'taskId', { max: LIMITS.taskId })
        ?? checkString(entry, 'attemptId', { max: LIMITS.attemptId })
        ?? checkString(entry, 'state', { max: 64 })
      if (te) return te
      const le = checkLeaseEpoch(entry)
      if (le) return le
    }
    return null
  },
  [FRAME_TYPES.CANCEL]: (f) => {
    const e = checkString(f, 'taskId', { max: LIMITS.taskId }) ?? checkString(f, 'attemptId', { max: LIMITS.attemptId })
    if (e) return e
    return checkLeaseEpoch(f)
  },
  [FRAME_TYPES.ERROR]: (f) => checkString(f, 'code', { max: 64 }),
})

/** 需要 `nodeId` 的类型（除 hello 自己在规则里单独校验外）。 */
const REQUIRES_NODE_ID = new Set([
  FRAME_TYPES.PROGRESS, FRAME_TYPES.TRANSITION, FRAME_TYPES.FAILURE,
  FRAME_TYPES.ACK, FRAME_TYPES.RECONCILE, FRAME_TYPES.HEARTBEAT,
])

/**
 * 校验一个**收到**的帧（已解析的 JSON 对象，或原始 JSON 文本）。
 *
 * `role` 是**本端**的角色（`'hub'` 或 `'node'`）。因为本函数校验的是**入站**帧，
 * 所以方向必须指向本端：方向标为 `node`（Node 才会发）的帧，只有 Hub 端应该收到；
 * 一个 `role: 'hub'` 的调用方收到 `dispatch`（方向 `hub`）说明对面在发只该由 Hub 发的
 * 东西 —— 通常是两端接反了，或有人在中继时把帧回环了。
 *
 * 把方向检查放在契约层，是为了让这类错接线在联调前就报出来，而不是表现为静默忽略。
 */
export function validateFrame(input, { role = null, version = null } = {}) {
  let frame = input
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > MAX_FRAME_BYTES) {
      return fail(PROTOCOL_CODES.FRAME_TOO_LARGE, `帧 ${Buffer.byteLength(input, 'utf8')} 字节超过上限 ${MAX_FRAME_BYTES}`)
    }
    try { frame = JSON.parse(input) } catch (e) {
      return fail(PROTOCOL_CODES.FRAME_NOT_OBJECT, `帧不是合法 JSON：${e.message}`)
    }
  }
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
    return fail(PROTOCOL_CODES.FRAME_NOT_OBJECT, '帧必须是 JSON 对象')
  }
  if (version !== null && frame.v !== version) {
    return fail(PROTOCOL_CODES.VERSION_UNSUPPORTED, `帧版本 ${JSON.stringify(frame.v)} 与已协商的 ${version} 不符`)
  }
  if (!isFrameType(frame.type)) {
    return fail(PROTOCOL_CODES.UNKNOWN_TYPE, `未登记的帧类型 ${JSON.stringify(frame.type)}`)
  }
  const direction = directionOf(frame.type)
  if (role !== null) {
    const inbound = direction === 'both' || direction === SENDER_OF_ROLE[role]
    if (!inbound) {
      return fail(PROTOCOL_CODES.WRONG_DIRECTION,
        `帧类型 ${frame.type} 方向为 ${direction}（只由 ${direction} 端发送），${role} 端不应收到`)
    }
  }
  const ruleError = FIELD_RULES[frame.type](frame)
  if (ruleError) return ruleError
  if (REQUIRES_NODE_ID.has(frame.type)) {
    const e = checkString(frame, 'nodeId', { max: LIMITS.nodeId })
    if (e) return e
  }
  // 除 hello 外都必须带 requestId：关联请求与响应靠它，缺了就只剩"猜是哪一条"。
  if (frame.type !== FRAME_TYPES.HELLO) {
    const e = checkRequestId(frame)
    if (e) return e
  }
  return ok({ frame })
}

// ── 序号与幂等 ──────────────────────────────────────────────────────────────

export const SEQ_OUTCOMES = Object.freeze({
  ACCEPTED: 'accepted',
  DUPLICATE: 'duplicate',
})

/** 记忆窗口。见下面 `createSequenceTracker` 的注释：窗口**不影响**顺序判定的正确性。 */
export const DEFAULT_SEEN_WINDOW = 1024

/**
 * 事件序号与幂等闸门。
 *
 * 两类"重复"必须区分开：
 *
 * - **同一个 `eventId` 再来一次** —— 正常的重试/重放，结果是 `duplicate`：
 *   忽略即可，**不是错误**。把它当错误会让一次正常的网络重试被记成故障。
 * - **一个没见过的事件带着 `seq <= lastSeq`** —— 要么是乱序到达，要么是两端
 *   对"这是第几条"理解不一致。这是**错误**：放过它会让事件流里出现一个
 *   永远无法排序的洞。
 *
 * ★ 为什么 `seen` 可以是有界窗口：重复投递的判定只需覆盖"重试窗口"，而
 *   `seq` 的单调性独立于 `seen` —— 窗口淘汰掉的老 `eventId` 即使再来，它的
 *   `seq` 依然 `<= lastSeq`，于是被 `SEQ_OUT_OF_ORDER` 拒掉。换句话说，
 *   窗口只影响"报错还是静默忽略"，**不影响**顺序正确性。无界集合会随运行时间
 *   无限增长，那是一个更坏的失败方式（内存缓慢泄漏，且没有任何读数）。
 */
export function createSequenceTracker({ lastSeq = 0, window = DEFAULT_SEEN_WINDOW } = {}) {
  if (!Number.isSafeInteger(lastSeq) || lastSeq < 0) throw new TypeError('lastSeq 必须是 >=0 的整数')
  if (!Number.isSafeInteger(window) || window < 1) throw new TypeError('window 必须是 >=1 的整数')
  let highest = lastSeq
  const seen = new Map()   // eventId -> seq，插入序即淘汰序

  return {
    get lastSeq() { return highest },
    get size() { return seen.size },
    /**
     * 观察一条事件。
     *
     * 返回 `{ ok:true, outcome:'accepted'|'duplicate', seq }` 或
     * `{ ok:false, code, message }`。
     */
    observe({ eventId, seq } = {}) {
      if (typeof eventId !== 'string' || eventId.length === 0) {
        return fail(PROTOCOL_CODES.INVALID_FIELD, 'eventId 必填且为非空字符串')
      }
      if (eventId.length > LIMITS.eventId) {
        return fail(PROTOCOL_CODES.FIELD_TOO_LONG, `eventId 长度超过 ${LIMITS.eventId}`)
      }
      if (!Number.isSafeInteger(seq) || seq < 1) {
        return fail(PROTOCOL_CODES.SEQ_INVALID, `seq 必须是 >=1 的整数，收到 ${JSON.stringify(seq)}`)
      }
      if (seen.has(eventId)) return ok({ outcome: SEQ_OUTCOMES.DUPLICATE, seq: seen.get(eventId) })
      if (seq <= highest) {
        return fail(PROTOCOL_CODES.SEQ_OUT_OF_ORDER,
          `事件 ${eventId} 的 seq=${seq} 未超过已接收的最大序号 ${highest}；` +
          '放过它会让事件流出现无法排序的洞',
          { lastSeq: highest, seq })
      }
      seen.set(eventId, seq)
      highest = seq
      while (seen.size > window) seen.delete(seen.keys().next().value)
      return ok({ outcome: SEQ_OUTCOMES.ACCEPTED, seq })
    },
  }
}

// ── 构造帧 ──────────────────────────────────────────────────────────────────

/**
 * 构造一个帧（补上 `v`、`requestId`、`sentAtMs`）。
 *
 * `requestId` 由调用方给：它要在**发出之前**就被记下来，否则超时后无从判断
 * "对面回的这条是哪个请求的"。
 */
export function buildFrame(type, fields = {}, { now = Date.now } = {}) {
  if (!isFrameType(type)) throw new TypeError(`未登记的帧类型 ${type}`)
  const { requestId, ...rest } = fields
  if (typeof requestId !== 'string' || requestId.length === 0) throw new TypeError('buildFrame 需要 requestId')
  return { v: PROTOCOL_VERSION, type, requestId, sentAtMs: now(), ...rest }
}

/** 生成一个请求 ID（调用方注入 random 便于受测）。 */
export function requestIdFor(prefix = 'req', random = defaultRequestRandom) {
  return `${prefix}-${Buffer.from(random(12)).toString('hex')}`
}

let requestRandom = (n) => nodeRandomBytes(n)
function defaultRequestRandom(n) { return requestRandom(n) }

/** 替换请求 ID 的随机源（测试用）。传 `null` 恢复默认。 */
export function setRequestRandomSource(fn) {
  if (fn !== null && typeof fn !== 'function') throw new TypeError('setRequestRandomSource 需要函数或 null')
  requestRandom = fn === null ? (n) => nodeRandomBytes(n) : fn
}
