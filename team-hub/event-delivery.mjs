// team-hub/event-delivery.mjs
// ============================================================================
// F-05 投递状态机（PRT 编号：无——本模块是 F-05 的「投递状态机待补」那一半）
//
// MULTI-AGENT-FEATURE-OPTIMIZATION.md §4.1 F-05：
//
//   > 延续 F-01 的 scope、seq、Last-Event-ID、持久游标和去重。运行明细作为
//   > 可持久化 RunEvent 写入控制面，不新增第二条公开 SSE。投递状态区分
//   > `pending/delivering/delivered/suppressed/failed/unknown`。
//
// 「事件流已落地」那一半是真的：`team-hub/server.mjs:7575-7610` 是唯一的公开 SSE，
// `Last-Event-ID` 增量回放、`audit.seq` 事务内单调、客户端 localStorage 游标与去重
// 都在。缺的是**投递本身有没有人记账**。
//
// ── 为什么"能收到"不等于"投递过" ──
//
// 改动前的广播是这样（`server.mjs:4220-4224`）：
//
//     function broadcastAudit(entry) {
//       for (const client of eventClients) {
//         if (client.scope === undefined || client.scope === entry.scope) writeEventFrame(client.res, entry)
//       }
//     }
//
// 两个静默出口：
//
//   ① **scope 不匹配** —— 一个 `continue`。对订阅者是对的，但**没有任何记录**：
//      "这条事件因为不属于这个订阅者而被跳过"与"这条事件从来没有产生过"
//      在事后读起来是同一个东西。
//   ② **`res.write` 失败** —— 返回值被丢掉，异常被事件循环吞掉。浏览器已经走了、
//      连接被 RST、背压把缓冲区撑爆……**一律表现为"发过了"**。
//
//   > 一个"发不出去也不说"的投递，与一个"从没打算发"的投递，
//   > 在"用户有没有看到"上是同一个东西——只不过前者的日志里写着已投递。
//
// 所以本模块的唯一目的：把每一次投递**变成一行能查的状态**，并让两种静默
// （跳过 / 写失败）各自有一个具名出口。
//
// ── 六态与它们的合法迁移 ──
//
//   pending    已落库、尚未开始投。plan() 落这一档。
//   delivering 已被某个投递者取走（带租约）。takeUp() 落这一档。
//   delivered  写成功并（可选）收到确认。**只能从 delivering 来**。
//   suppressed 按规则不投给这个订阅者，且**必须带原因**。终态。
//   failed     写失败。**不推进游标**，因此它是可重试的那一档。
//   unknown    取走之后进程死了/租约过期，**无法判断字节有没有到**。终态。
//
// 三条不变量，每一条都对应一种"看起来正常"的坏法：
//
//   ① **`delivered` 只能从 `delivering` 迁移**（CAS）。
//      允许 `pending → delivered` 等于允许"没发就记成发了"。这条用
//      `markDelivered` 的 `WHERE state='delivering'` 实现，而不是在应用层 `if`——
//      应用层的 `if` 在并发下两个调用方都会读到 `pending` 然后都认为该拒绝对方。
//
//   ② **`suppressed` 必须有原因**。没原因的抑制行与"这条不存在"无法区分，
//      于是"为什么我的订阅者收不到"永远查不出来。原因取自一份**封闭清单**：
//      新增一种抑制理由必须显式加进来，否则抛错——自由文本会让它退化成一句备注。
//
//   ③ **崩溃 → `unknown`，不是 `delivered`，也不是 `pending`**。
//      租约过期只证明"取走它的那个人没再说话"，**不证明字节没到**。
//      记成 `delivered` 会谎报可见性；退回 `pending` 会重复投递一条可能已经到达的
//      事件——对"通知"这类幂等消费方无害，对"触发一次外部写"有害。所以两者都不选，
//      如实记 `unknown` 并交给人工/对账，这与 PRT-311 `UnknownOutcome` 是同一条纪律。
//
// ── 与既有租约纪律的关系 ──
//
// `delivering` 带**租约**（`lease_expires_at_ms`）而不是"进程启动时清一遍"：
// 本仓库的部署形态是**两个进程同时打开同一个库**（8787 独立进程 + 3080 宿主外壳），
// "启动时把所有 delivering 清掉"会让后启动的那个进程把**另一个进程正在投递**的行
// 判成崩溃——一次正常的并发启动变成一次误报。带租约的回收与 PRT-302/313 的
// 任务租约是同一个原语，理由也同一个：**谁在干活必须能被时间证明，不能靠进程自述。**
// ============================================================================

import { ensureColumn } from './schema-util.mjs'

/** spec/F-05 的六个投递状态。**顺序即文档顺序。** */
export const DELIVERY_STATES = Object.freeze([
  'pending', 'delivering', 'delivered', 'suppressed', 'failed', 'unknown',
])

/**
 * 终态：不会再迁移。`unknown` 也在其中——它**不是**可重试的，
 * 因为重试它需要先回答"上一次到底到了没有"，那是对账，不是调度。
 */
export const TERMINAL_DELIVERY_STATES = Object.freeze(['delivered', 'suppressed', 'unknown'])

/** 可以自动重试的状态。`unknown` **刻意不在**这里（见文件头 ③）。 */
export const RETRYABLE_DELIVERY_STATES = Object.freeze(['pending', 'failed'])

/** 抑制原因：**封闭清单**。 */
export const SUPPRESS_REASONS = Object.freeze([
  /** 订阅者带 scope 过滤，这条事件不属于它。原来这里是一个静默 `continue`。 */
  'scope-mismatch',
  /** 同一个 (subscriber, seq) 已经投过，重复帧不再投。 */
  'duplicate',
  /** 保留策略：这一条已经滚出保留窗口，不再回放。 */
  'retention',
  /** 策略性抑制（例如运维显式关掉某类事件）。 */
  'policy',
])

/** 投递租约默认值。取 60s：比一次 SSE 写长得多，比"人注意到卡住"短得多。 */
export const DEFAULT_DELIVERY_LEASE_MS = 60000

const STATE_SET = new Set(DELIVERY_STATES)
const TERMINAL_SET = new Set(TERMINAL_DELIVERY_STATES)
const RETRYABLE_SET = new Set(RETRYABLE_DELIVERY_STATES)
const REASON_SET = new Set(SUPPRESS_REASONS)

/** 这个字符串是不是一个已知投递状态。**字面量比较**，不做归一化。 */
export function isDeliveryState(value) {
  return STATE_SET.has(value)
}

export function isTerminalDeliveryState(value) {
  return TERMINAL_SET.has(value)
}

export function isRetryableDeliveryState(value) {
  return RETRYABLE_SET.has(value)
}

/**
 * 认不出的状态**抛错**，并且**绝不**回落到任何一档。
 *
 * 回落成 `delivered` 会谎报可见性；回落成 `failed` 会把一条已经到达的事件重投一次。
 * 两种回落都比抛错坏，因为抛错是可见的。
 */
export function normalizeDeliveryState(raw) {
  if (typeof raw !== 'string' || !STATE_SET.has(raw)) {
    throw new Error(
      `未知的投递状态：${JSON.stringify(raw)}。已知状态：${DELIVERY_STATES.join(' / ')}。`
      + '本函数**不会**把它归到任何一档——把"认不出"读成"已投递"或"可重试"都会掩盖一次真实的数据损坏。',
    )
  }
  return raw
}

/** 游标只在终态推进。`failed` 不推进，这正是它可重试的原因。 */
export function cursorAdvances(state) {
  return isTerminalDeliveryState(normalizeDeliveryState(state))
}

/**
 * 自检：六个状态一个不漏，且抑制原因清单非空、无重复。
 *
 * `states` / `reasons` 可注入：**为了让这道守卫可被观测**。默认参数下它检查的
 * 就是真表，而真表当前是完备的——把检查语句改弱，结果依然是"没有问题"。
 * 只有能喂它一份故意做坏的输入，才能证明它真的会发现问题。
 *
 *   > 一个只能对「当前恰好正确的那份输入」作答的校验，
 *   > 与一个恒真的校验，在「它能不能发现错误」上同形。
 */
export function assertDeliveryStateTotal(states = DELIVERY_STATES, reasons = SUPPRESS_REASONS) {
  const problems = []
  if (!Array.isArray(states) || states.length === 0) problems.push('状态清单为空')
  const seen = new Set()
  for (const s of states) {
    if (typeof s !== 'string' || s.trim() === '') { problems.push(`状态不是非空字符串：${JSON.stringify(s)}`); continue }
    if (seen.has(s)) problems.push(`状态重复：${s}`)
    seen.add(s)
  }
  for (const s of TERMINAL_DELIVERY_STATES) {
    if (!seen.has(s)) problems.push(`终态 ${s} 不在状态清单里`)
  }
  for (const s of RETRYABLE_DELIVERY_STATES) {
    if (!seen.has(s)) problems.push(`可重试态 ${s} 不在状态清单里`)
  }
  // 终态与可重试态**不许重叠**：重叠意味着"一个状态既不用再投、又要重投"。
  for (const s of RETRYABLE_DELIVERY_STATES) {
    if (TERMINAL_SET.has(s)) problems.push(`${s} 同时是终态与可重试态`)
  }
  if (!Array.isArray(reasons) || reasons.length === 0) problems.push('抑制原因清单为空')
  reasons.forEach((r, i) => {
    if (typeof r !== 'string' || r.trim() === '') problems.push(`抑制原因不是非空字符串：${JSON.stringify(r)}`)
    if (reasons.indexOf(r) !== i) problems.push(`抑制原因重复：${r}`)
  })
  return Object.freeze({ ok: problems.length === 0, problems: Object.freeze(problems) })
}

// ---------------------------------------------------------------- 建表

/**
 * 建投递表。幂等（`IF NOT EXISTS` + `ensureColumn`），老库自动补齐。
 *
 * 主键是 `(subscriber_id, seq)`：**一条事件对一个订阅者只有一行**。
 * 不用自增主键 + 唯一索引：那样每个订阅者都要自己维护"我投到哪了"，
 * 而这种"每个订阅者各记一份"正是**持久游标**要消灭的东西。
 */
export function ensureEventDeliverySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_subscribers (
      subscriber_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      scope TEXT,
      cursor_seq INTEGER NOT NULL DEFAULT 0,
      registered_at_ms INTEGER NOT NULL,
      last_seen_at_ms INTEGER
    )
  `)
  // `scope` 可空：`NULL` = 订阅全部（与既有 SSE 的 `client.scope === undefined` 同义）。
  // 刻意**不**用空字符串表示"全部"——空串与"scope 就叫空"分不开，
  // 而那种字符串在 JSON 里完全合法。
  ensureColumn(db, 'event_subscribers', 'received_count', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'event_subscribers', 'note', 'TEXT')

  db.exec(`
    CREATE TABLE IF NOT EXISTS event_deliveries (
      subscriber_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      scope TEXT,
      state TEXT NOT NULL,
      reason TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      delivered_at_ms INTEGER,
      lease_expires_at_ms INTEGER,
      PRIMARY KEY (subscriber_id, seq)
    )
  `)
  // ── `fanout`：这一个投递记录**实际往几个 socket 写过** ──
  //
  // 一个订阅者 id 上同时挂着多个活连接是**正常形态**（Workbench 多个标签页
  // 共享同一份 localStorage 游标，所以它们天然是同一个订阅者）。
  // 此时 CAS 只会让一个连接"拥有"这一行，其余连接照样要收到帧——
  // 不写就会掉事件，写又会让"一行 = 一次投递"变成假话。
  //
  // 所以：**行仍是一行，但带上真实的写次数**。`state='delivered' && fanout=3`
  // 说的是"这条事件投给了这个订阅者，过程中往三个 socket 写过"——
  // 这是一个能读的读数，而"三次投递各记一行"会说成三件不同的事。
  ensureColumn(db, 'event_deliveries', 'fanout', 'INTEGER NOT NULL DEFAULT 1')
  // 回收扫描走这个索引：按状态 + 租约到期找"取走了但没下文"的行。
  db.exec('CREATE INDEX IF NOT EXISTS idx_event_deliveries_lease ON event_deliveries(state, lease_expires_at_ms)')
  // 游标计算与重投都按 (subscriber, state) 扫。
  db.exec('CREATE INDEX IF NOT EXISTS idx_event_deliveries_sub_state ON event_deliveries(subscriber_id, state, seq)')
}

// ---------------------------------------------------------------- 仓储

const SCHEMA_CHECK = assertDeliveryStateTotal()
if (SCHEMA_CHECK.ok !== true) {
  throw new Error(`投递状态机自检失败：${SCHEMA_CHECK.problems.join('；')}`)
}

/**
 * 投递状态机。
 *
 * @param {object} opts
 * @param {object} opts.db             node:sqlite DatabaseSync（不自持连接）
 * @param {() => number} [opts.clock]  权威时间。**只在服务端**——与 PRT-313 同一条纪律：
 *                                     调用方给的 `nowMs` 一律忽略，否则"租约到期"变成一句客户端声明。
 * @param {number} [opts.deliveryLeaseMs]
 */
export function createEventDeliveryStore({
  db,
  clock = () => Date.now(),
  deliveryLeaseMs = DEFAULT_DELIVERY_LEASE_MS,
} = {}) {
  if (db === undefined || db === null) throw new TypeError('createEventDeliveryStore 需要 db')
  if (typeof clock !== 'function') throw new TypeError('createEventDeliveryStore 的 clock 必须是函数')
  if (!Number.isFinite(deliveryLeaseMs) || deliveryLeaseMs <= 0) {
    throw new TypeError('deliveryLeaseMs 必须是正的有限数')
  }
  ensureEventDeliverySchema(db)

  const now = () => {
    const t = clock()
    if (!Number.isFinite(t)) throw new Error('clock 返回了非有限数')
    return t
  }

  function requireSubscriber(subscriberId) {
    if (typeof subscriberId !== 'string' || subscriberId.trim() === '') {
      throw new TypeError('subscriberId 必须是非空字符串')
    }
    return subscriberId
  }

  function requireSeq(seq) {
    if (!Number.isSafeInteger(seq) || seq < 0) {
      throw new TypeError(`seq 必须是非负安全整数：${JSON.stringify(seq)}`)
    }
    return seq
  }

  function requireReason(reason) {
    if (typeof reason !== 'string' || !REASON_SET.has(reason)) {
      throw new Error(
        `抑制原因必须是清单里的一种：${SUPPRESS_REASONS.join(' / ')}（收到 ${JSON.stringify(reason)}）。`
        + '自由文本会让"为什么被抑制"退化成一句备注，下一次没人能按原因去查。',
      )
    }
    return reason
  }

  const rowOf = db.prepare(
    'SELECT * FROM event_deliveries WHERE subscriber_id = ? AND seq = ?',
  )

  function readRow(subscriberId, seq) {
    const r = rowOf.get(subscriberId, seq)
    if (r === undefined) return null
    return {
      subscriberId: r.subscriber_id,
      seq: r.seq,
      scope: r.scope ?? null,
      state: r.state,
      reason: r.reason ?? null,
      attempts: r.attempts,
      lastError: r.last_error ?? null,
      createdAtMs: r.created_at_ms,
      updatedAtMs: r.updated_at_ms,
      deliveredAtMs: r.delivered_at_ms ?? null,
      leaseExpiresAtMs: r.lease_expires_at_ms ?? null,
      fanout: r.fanout ?? 1,
    }
  }

  /** 登记（或更新）一个订阅者。重复登记**不重置游标**——重置等于把已投的再投一遍。 */
  function registerSubscriber({ subscriberId, kind, scope = null, note = null }) {
    requireSubscriber(subscriberId)
    if (typeof kind !== 'string' || kind.trim() === '') throw new TypeError('kind 必须是非空字符串')
    if (scope !== null && (typeof scope !== 'string' || scope.trim() === '')) {
      throw new TypeError('scope 必须是 null（全部）或非空字符串')
    }
    const t = now()
    const existing = db.prepare('SELECT subscriber_id FROM event_subscribers WHERE subscriber_id = ?').get(subscriberId)
    if (existing === undefined) {
      db.prepare(
        'INSERT INTO event_subscribers (subscriber_id, kind, scope, cursor_seq, registered_at_ms, last_seen_at_ms, note)'
        + ' VALUES (?, ?, ?, 0, ?, ?, ?)',
      ).run(subscriberId, kind, scope, t, t, note)
    } else {
      db.prepare('UPDATE event_subscribers SET kind = ?, scope = ?, last_seen_at_ms = ? WHERE subscriber_id = ?')
        .run(kind, scope, t, subscriberId)
    }
    return subscriberOf(subscriberId)
  }

  function subscriberOf(subscriberId) {
    const r = db.prepare('SELECT * FROM event_subscribers WHERE subscriber_id = ?').get(subscriberId)
    if (r === undefined) return null
    return {
      subscriberId: r.subscriber_id,
      kind: r.kind,
      scope: r.scope ?? null,
      cursorSeq: r.cursor_seq,
      registeredAtMs: r.registered_at_ms,
      lastSeenAtMs: r.last_seen_at_ms ?? null,
      receivedCount: r.received_count ?? 0,
      note: r.note ?? null,
    }
  }

  /**
   * 为一批事件**落投递意图**。
   *
   * 这是把"静默 `continue`"变成一条记录的那一步：
   *   · scope 不匹配 → 直接落 `suppressed` + 原因 `'scope-mismatch'`（终态，游标可越过）；
   *   · 其余 → 落 `pending`。
   *
   * 幂等：已存在的行**原样不动**（`INSERT OR IGNORE` 的语义用 `ON CONFLICT DO NOTHING` 表达）。
   * 这一点很要紧——把一行已经 `delivered` 的投递重新 plan 成 `pending`，
   * 会让每一次服务重启都把整段历史重投一遍，而"重启导致重复通知"是最难查的那类缺陷。
   *
   * @returns {{created:number, existing:number, suppressed:Array<{seq:number,reason:string}>}}
   */
  function plan({ subscriberId, events }) {
    requireSubscriber(subscriberId)
    if (!Array.isArray(events)) throw new TypeError('events 必须是数组')
    const sub = subscriberOf(subscriberId)
    if (sub === null) throw new Error(`订阅者未登记：${subscriberId}`)
    const t = now()
    const insert = db.prepare(
      'INSERT INTO event_deliveries (subscriber_id, seq, scope, state, reason, attempts, created_at_ms, updated_at_ms)'
      + ' VALUES (?, ?, ?, ?, ?, 0, ?, ?) ON CONFLICT (subscriber_id, seq) DO NOTHING',
    )
    let created = 0
    let existing = 0
    const suppressed = []
    for (const ev of events) {
      if (ev === null || typeof ev !== 'object') throw new TypeError('events 的每一项必须是对象')
      const seq = requireSeq(ev.seq)
      const evScope = ev.scope ?? null
      // 订阅者的 scope 为 null = 订阅全部（与 SSE 的 client.scope === undefined 同义）。
      const mismatch = sub.scope !== null && evScope !== null && evScope !== sub.scope
      const state = mismatch ? 'suppressed' : 'pending'
      const reason = mismatch ? 'scope-mismatch' : null
      const r = insert.run(subscriberId, seq, evScope, state, reason, t, t)
      if (r.changes === 1) {
        created += 1
        if (state === 'suppressed') suppressed.push({ seq, reason })
      } else {
        existing += 1
      }
    }
    return Object.freeze({ created, existing, suppressed: Object.freeze(suppressed) })
  }

  /**
   * 取走一批待投递的行（`pending`/`failed` → `delivering`），带上租约。
   *
   * CAS 而不是"先查后改"：并发下两个投递者都会读到 `pending`，
   * 然后都认为自己该发——一次事件投两遍，而两边都觉得自己是对的。
   *
   * @returns {{claimed:number[], refused:Array<{seq:number,state:string}>}}
   */
  function takeUp({ subscriberId, seqs, leaseMs = deliveryLeaseMs }) {
    requireSubscriber(subscriberId)
    if (!Array.isArray(seqs)) throw new TypeError('seqs 必须是数组')
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new TypeError('leaseMs 必须是正的有限数')
    const t = now()
    const update = db.prepare(
      "UPDATE event_deliveries SET state = 'delivering', attempts = attempts + 1,"
      + ' updated_at_ms = ?, lease_expires_at_ms = ?'
      + " WHERE subscriber_id = ? AND seq = ? AND state IN ('pending','failed')",
    )
    const claimed = []
    const refused = []
    for (const raw of seqs) {
      const seq = requireSeq(raw)
      const r = update.run(t, t + leaseMs, subscriberId, seq)
      if (r.changes === 1) claimed.push(seq)
      else {
        const row = readRow(subscriberId, seq)
        // 行不存在也是"拒绝"，而且是最该被看见的那种：调用方在投一条
        // 从未被 plan 过的事件。把它的 state 报成 `'missing'` 而不是编一个状态——
        // "没有这一行"与"这一行处于某个状态"是两个不同的事实。
        refused.push({ seq, state: row === null ? 'missing' : row.state })
      }
    }
    return Object.freeze({ claimed: Object.freeze(claimed), refused: Object.freeze(refused) })
  }

  /**
   * 标记投递成功。**只能从 `delivering` 迁移**（见文件头 ①）。
   *
   * 返回值里带 `refused`：调用方**不能**只看"我调用了 markDelivered"就认为投出去了。
   * 一个不报告拒绝的 ack 端口，会让"没发就记成发了"重新变得可能。
   *
   * `fanout` 是这一次投递**实际写过的 socket 数**（见 `ensureEventDeliverySchema`
   * 里那段注释：同一订阅者的多个活连接是正常形态，它们共享一行）。
   * 传小于 1 的值会被拒——一个"投递成功但一个 socket 都没写"的记录是自相矛盾的。
   */
  function markDelivered({ subscriberId, seqs, fanout = 1 }) {
    requireSubscriber(subscriberId)
    if (!Array.isArray(seqs)) throw new TypeError('seqs 必须是数组')
    if (!Number.isSafeInteger(fanout) || fanout < 1) {
      throw new TypeError(
        `fanout 必须是 >= 1 的安全整数（收到 ${JSON.stringify(fanout)}）：`
        + '一条"投递成功但一个 socket 都没写"的记录是自相矛盾的',
      )
    }
    const t = now()
    const update = db.prepare(
      "UPDATE event_deliveries SET state = 'delivered', delivered_at_ms = ?, updated_at_ms = ?,"
      + ' lease_expires_at_ms = NULL, last_error = NULL, fanout = ?'
      + " WHERE subscriber_id = ? AND seq = ? AND state = 'delivering'",
    )
    const delivered = []
    const refused = []
    for (const raw of seqs) {
      const seq = requireSeq(raw)
      const r = update.run(t, t, fanout, subscriberId, seq)
      if (r.changes === 1) delivered.push(seq)
      else {
        const row = readRow(subscriberId, seq)
        refused.push({ seq, state: row === null ? 'missing' : row.state })
      }
    }
    if (delivered.length > 0) advanceCursor({ subscriberId })
    return Object.freeze({ delivered: Object.freeze(delivered), refused: Object.freeze(refused) })
  }

  /** 标记投递失败。**不推进游标**——这正是 `failed` 可重试的原因。 */
  function markFailed({ subscriberId, seqs, error }) {
    requireSubscriber(subscriberId)
    if (!Array.isArray(seqs)) throw new TypeError('seqs 必须是数组')
    if (typeof error !== 'string' || error.trim() === '') {
      // 没有错误的失败行与"什么都没发生"分不开，于是没人会去修它。
      throw new TypeError('error 必须是非空字符串：一条不说原因的失败与一条不存在的失败，在事后读起来是同一个东西')
    }
    const t = now()
    const update = db.prepare(
      "UPDATE event_deliveries SET state = 'failed', last_error = ?, updated_at_ms = ?,"
      + ' lease_expires_at_ms = NULL'
      + " WHERE subscriber_id = ? AND seq = ? AND state = 'delivering'",
    )
    const failed = []
    const refused = []
    for (const raw of seqs) {
      const seq = requireSeq(raw)
      const r = update.run(error.slice(0, 500), t, subscriberId, seq)
      if (r.changes === 1) failed.push(seq)
      else {
        const row = readRow(subscriberId, seq)
        refused.push({ seq, state: row === null ? 'missing' : row.state })
      }
    }
    return Object.freeze({ failed: Object.freeze(failed), refused: Object.freeze(refused) })
  }

  /** 显式抑制一条。原因必填且必须来自清单（见文件头 ②）。 */
  function suppress({ subscriberId, seq, reason }) {
    requireSubscriber(subscriberId)
    const s = requireSeq(seq)
    const why = requireReason(reason)
    const t = now()
    const r = db.prepare(
      "UPDATE event_deliveries SET state = 'suppressed', reason = ?, updated_at_ms = ?,"
      + ' lease_expires_at_ms = NULL'
      + " WHERE subscriber_id = ? AND seq = ? AND state IN ('pending','failed')",
    ).run(why, t, subscriberId, s)
    if (r.changes !== 1) {
      const row = readRow(subscriberId, s)
      return Object.freeze({
        ok: false,
        code: row === null ? 'DELIVERY_ROW_MISSING' : 'DELIVERY_NOT_SUPPRESSIBLE',
        state: row === null ? 'missing' : row.state,
      })
    }
    advanceCursor({ subscriberId })
    return Object.freeze({ ok: true, code: 'none', state: 'suppressed', reason: why })
  }

  /**
   * 回收租约过期的 `delivering` → `unknown`。
   *
   * 三个"不"：
   *   · **不**记成 `delivered`（字节到没到我们不知道）；
   *   · **不**退回 `pending`（重投一条可能已到达的事件）；
   *   · **不**在同一时刻把另一个进程正在投的行收掉（判据是**租约**，不是进程自述）。
   *
   * 返回被回收的 (subscriber, seq)，让"有一次投递下落不明"这件事可被读出来。
   */
  function recoverExpired({ atMs = null } = {}) {
    const t = atMs === null ? now() : atMs
    if (!Number.isFinite(t)) throw new TypeError('atMs 必须是有限数')
    const rows = db.prepare(
      "SELECT subscriber_id, seq FROM event_deliveries"
      + " WHERE state = 'delivering' AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms <= ?"
      + ' ORDER BY subscriber_id, seq',
    ).all(t)
    if (rows.length === 0) return Object.freeze({ recovered: Object.freeze([]) })
    const upd = db.prepare(
      "UPDATE event_deliveries SET state = 'unknown', updated_at_ms = ?, lease_expires_at_ms = NULL,"
      + " last_error = COALESCE(last_error, '投递租约到期：取走这一行的人没有再说话，字节是否到达无法判断')"
      + " WHERE subscriber_id = ? AND seq = ? AND state = 'delivering'",
    )
    const recovered = []
    for (const r of rows) {
      const u = upd.run(t, r.subscriber_id, r.seq)
      if (u.changes === 1) recovered.push({ subscriberId: r.subscriber_id, seq: r.seq })
    }
    return Object.freeze({ recovered: Object.freeze(recovered) })
  }

  /**
   * 计算并**单调推进**持久游标。
   *
   * 游标 = 从该订阅者**第一条**被 plan 过的 seq 起，连续终态（`delivered`/`suppressed`）
   * 的最大 seq。`failed`/`unknown`/`pending`/`delivering` 都**截断**连续段——
   * 一个洞没补上，游标就不能越过它，否则那个洞**永远不会再被投**。
   *
   *   > 一个"跳过失败继续推进"的游标，与一个"丢事件"的游标，
   *   > 在"客户端最终看到的东西"上是同一个东西——只不过前者有一份看起来正常的记录。
   *
   * 单调：只增不减（`MAX(cursor, computed)`）。游标回退会让已经投过的事件重投一遍。
   */
  function advanceCursor({ subscriberId }) {
    requireSubscriber(subscriberId)
    const rows = db.prepare(
      'SELECT seq, state FROM event_deliveries WHERE subscriber_id = ? ORDER BY seq ASC',
    ).all(subscriberId)
    if (rows.length === 0) return subscriberOf(subscriberId)
    const first = rows[0].seq
    let cursor = first - 1
    for (const r of rows) {
      if (r.seq !== cursor + 1) break
      if (!TERMINAL_SET.has(r.state)) break
      cursor = r.seq
    }
    const sub = subscriberOf(subscriberId)
    const next = Math.max(sub?.cursorSeq ?? 0, cursor)
    db.prepare('UPDATE event_subscribers SET cursor_seq = ? WHERE subscriber_id = ?').run(next, subscriberId)
    return subscriberOf(subscriberId)
  }

  /** 该订阅者的持久游标（不重算，只读）。 */
  function cursorOf(subscriberId) {
    const sub = subscriberOf(requireSubscriber(subscriberId))
    return sub === null ? null : sub.cursorSeq
  }

  /** 按状态列行，供界面/诊断直接查"卡在哪一档"。 */
  function rowsOf(subscriberId, { state = null, limit = 200 } = {}) {
    requireSubscriber(subscriberId)
    if (state !== null) normalizeDeliveryState(state)
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('limit 必须是正安全整数')
    const sql = state === null
      ? 'SELECT seq FROM event_deliveries WHERE subscriber_id = ? ORDER BY seq ASC LIMIT ?'
      : 'SELECT seq FROM event_deliveries WHERE subscriber_id = ? AND state = ? ORDER BY seq ASC LIMIT ?'
    const rows = state === null
      ? db.prepare(sql).all(subscriberId, limit)
      : db.prepare(sql).all(subscriberId, state, limit)
    return Object.freeze(rows.map((r) => readRow(subscriberId, r.seq)))
  }

  /** 一个订阅者的完整读数：六态计数 + 游标 + 最老的卡住行。 */
  function stateOf(subscriberId) {
    requireSubscriber(subscriberId)
    const counts = Object.fromEntries(DELIVERY_STATES.map((s) => [s, 0]))
    const rows = db.prepare(
      'SELECT state, COUNT(*) AS n FROM event_deliveries WHERE subscriber_id = ? GROUP BY state',
    ).all(subscriberId)
    for (const r of rows) {
      // 库里出现一个不认识的 state 时**如实记进 `unrecognized`**，
      // 而不是丢进某个已知档：那是一次真实的数据损坏，读的人必须看得见。
      if (Object.hasOwn(counts, r.state)) counts[r.state] = r.n
      else counts[`unrecognized:${r.state}`] = r.n
    }
    const sub = subscriberOf(subscriberId)
    const oldest = db.prepare(
      "SELECT seq FROM event_deliveries WHERE subscriber_id = ? AND state IN ('pending','failed','delivering','unknown')"
      + ' ORDER BY seq ASC LIMIT 1',
    ).get(subscriberId)
    // 「投递完了」只有一个判据：**没有任何没走完的行**。
    // 两个反例都是真实存在的坏法：
    //   ① 用"最近一次投递成功"代替它 —— 一个早就断掉的订阅者会一直显示正常；
    //   ② 只数四个已知的非终态 —— 库里出现一个**不认识**的 state 时它一条都不计入，
    //      于是"数据损坏"被读成"投递完毕"。认不出的行必须算作**没走完**。
    const unrecognized = Object.keys(counts).filter((k) => k.startsWith('unrecognized:'))
    const settled = (counts.pending + counts.delivering + counts.failed + counts.unknown) === 0
      && unrecognized.length === 0
    return Object.freeze({
      subscriberId,
      exists: sub !== null,
      registered: sub,
      cursorSeq: sub?.cursorSeq ?? null,
      counts: Object.freeze(counts),
      oldestOutstandingSeq: oldest === undefined ? null : oldest.seq,
      unrecognizedStates: Object.freeze(unrecognized.map((k) => k.slice('unrecognized:'.length))),
      settled,
    })
  }

  /** 全局读数：所有订阅者 + 六态总计。给诊断页用。 */
  function summary() {
    const subs = db.prepare('SELECT subscriber_id FROM event_subscribers ORDER BY subscriber_id').all()
    const counts = Object.fromEntries(DELIVERY_STATES.map((s) => [s, 0]))
    const rows = db.prepare('SELECT state, COUNT(*) AS n FROM event_deliveries GROUP BY state').all()
    for (const r of rows) {
      if (Object.hasOwn(counts, r.state)) counts[r.state] = r.n
      else counts[`unrecognized:${r.state}`] = r.n
    }
    const t = now()
    const stuck = db.prepare(
      "SELECT COUNT(*) AS n FROM event_deliveries WHERE state = 'delivering'"
      + ' AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms <= ?',
    ).get(t).n
    return Object.freeze({
      subscribers: Object.freeze(subs.map((s) => stateOf(s.subscriber_id))),
      counts: Object.freeze(counts),
      expiredLeases: stuck,
      serverTimeMs: t,
    })
  }

  return Object.freeze({
    registerSubscriber,
    subscriberOf,
    plan,
    takeUp,
    markDelivered,
    markFailed,
    suppress,
    recoverExpired,
    advanceCursor,
    cursorOf,
    rowsOf,
    stateOf,
    summary,
    readRow,
  })
}
